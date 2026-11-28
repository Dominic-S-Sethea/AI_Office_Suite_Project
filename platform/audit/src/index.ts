import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AuditEvent } from "@ai-office-suite/shared-contracts";

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi,
  /\baios_session=[^;\s]+/gi,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^:\s/@]+:[^@\s]+@[^\s]+/gi,
  /\b(?:inv|lease)_[A-Za-z0-9_-]{12,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential|raw[_-]?invite|access[_-]?key|signing[_-]?key)/i;

const MAX_REDACT_DEPTH = 16;

function sanitizeSecretPatterns(value: string): string {
  let sanitized = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

function redactRecursive(
  value: unknown,
  key: string,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return sanitizeSecretPatterns(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: sanitizeSecretPatterns(value.message),
    };
    const errRecord = value as unknown as Record<string, unknown>;
    if (errRecord.code !== undefined) {
      out.code = redactRecursive(errRecord.code, "code", ancestors, depth + 1);
    }
    return out;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return "[MAX_DEPTH]";
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactRecursive(item, "", ancestors, depth + 1));
    }
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        const keyStr = String(k);
        out[keyStr] = redactRecursive(v, keyStr, ancestors, depth + 1);
      }
      return out;
    }
    if (value instanceof Set) {
      return Array.from(value, (item) => redactRecursive(item, "", ancestors, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactRecursive(v, k, ancestors, depth + 1);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function redactAuditValue(value: unknown, key = ""): unknown {
  return redactRecursive(value, key, new WeakSet<object>(), 0);
}

export function redactAuditString(value: string): string {
  return redactAuditValue(value) as string;
}

export function redactAuditEvent<T>(event: T): T {
  return redactAuditValue(event) as T;
}

export interface AuditStore {
  append(event: AuditEvent): void;
  listForDocument(tenantId: string, workspaceId: string, documentId: string): AuditEvent[];
  listAll(tenantId: string, workspaceId: string): AuditEvent[];
}

export class LocalJsonlAuditStore implements AuditStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    const auditDir = path.join(path.resolve(baseDir), "audit");
    mkdirSync(auditDir, { recursive: true });
    this.filePath = path.join(auditDir, "audit-events.jsonl");
  }

  append(event: AuditEvent): void {
    const sanitized = redactAuditValue(event) as AuditEvent;
    appendFileSync(this.filePath, `${JSON.stringify(sanitized)}\n`, "utf8");
  }

  listAll(tenantId: string, workspaceId: string): AuditEvent[] {
    if (!existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const events: AuditEvent[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as AuditEvent;
      if (parsed.tenantId === tenantId && parsed.workspaceId === workspaceId) {
        events.push(parsed);
      }
    }
    return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.auditId.localeCompare(a.auditId));
  }

  listForDocument(tenantId: string, workspaceId: string, documentId: string): AuditEvent[] {
    return this.listAll(tenantId, workspaceId).filter((e) => e.documentId === documentId);
  }
}

export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 5_000) {
    this.maxEvents = Math.max(100, Math.trunc(maxEvents));
  }

  append(event: AuditEvent): void {
    if (this.events.length >= this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents + 1);
    }
    this.events.push(redactAuditValue(event) as AuditEvent);
  }

  listAll(tenantId: string, workspaceId: string): AuditEvent[] {
    return this.events
      .filter((e) => e.tenantId === tenantId && e.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.auditId.localeCompare(a.auditId));
  }

  listForDocument(tenantId: string, workspaceId: string, documentId: string): AuditEvent[] {
    return this.listAll(tenantId, workspaceId).filter((e) => e.documentId === documentId);
  }
}
