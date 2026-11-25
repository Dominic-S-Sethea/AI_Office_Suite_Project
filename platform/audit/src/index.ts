import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AuditEvent } from "@ai-office-suite/shared-contracts";

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi,
  /\baios_session=[^;\s]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;

export function redactAuditValue(value: unknown, key = ""): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    let sanitized = value;
    for (const pattern of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactAuditValue(v, k);
    }
    return out;
  }
  return value;
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
    return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listForDocument(tenantId: string, workspaceId: string, documentId: string): AuditEvent[] {
    return this.listAll(tenantId, workspaceId).filter((e) => e.documentId === documentId);
  }
}

export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];

  append(event: AuditEvent): void {
    this.events.push(redactAuditValue(event) as AuditEvent);
  }

  listAll(tenantId: string, workspaceId: string): AuditEvent[] {
    return this.events
      .filter((e) => e.tenantId === tenantId && e.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listForDocument(tenantId: string, workspaceId: string, documentId: string): AuditEvent[] {
    return this.listAll(tenantId, workspaceId).filter((e) => e.documentId === documentId);
  }
}
