import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DocumentVersion, StudioDocument } from "@ai-office-suite/shared-contracts";

export interface DocumentStorageAdapter {
  saveOriginalBinary(bytes: Uint8Array, extension: string): Promise<{ sha256: string; path: string }>;
  saveDocumentVersion(version: DocumentVersion): Promise<void>;
  getDocument(documentId: string): Promise<StudioDocument | null>;
  listDocuments(tenantId: string, workspaceId: string): Promise<StudioDocument[]>;
  listVersions(documentId: string): Promise<DocumentVersion[]>;
  getVersion(documentId: string, revision: number): Promise<DocumentVersion | null>;
}

/**
 * Local filesystem adapter for Phase D1 feasibility prototypes.
 * - Imported binaries are written once by SHA-256 hash (immutable original archive).
 * - Document versions are append-only JSON files published atomically via temp-file + hardlink (`linkSync` fails with EEXIST on race).
 */
export class LocalFilesystemStorageAdapter implements DocumentStorageAdapter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    mkdirSync(path.join(this.baseDir, "originals"), { recursive: true });
    mkdirSync(path.join(this.baseDir, "documents"), { recursive: true });
  }

  private assertContainedPath(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + path.sep)) {
      throw new Error(`Storage path containment violation blocked: '${targetPath}'.`);
    }
    return resolved;
  }

  private sanitizeDocumentId(documentId: string): string {
    const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "");
    if (!safeId || safeId.length > 160) {
      throw new Error("Invalid documentId for local storage.");
    }
    return safeId;
  }

  async saveOriginalBinary(bytes: Uint8Array, extension: string): Promise<{ sha256: string; path: string }> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const safeExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12) || "bin";
    const filePath = this.assertContainedPath(path.join(this.baseDir, "originals", `${sha256}.${safeExt}`));
    // Write-once: never overwrite an existing original binary with the same SHA-256.
    try {
      writeFileSync(filePath, bytes, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    return { sha256, path: filePath };
  }

  private versionsDir(documentId: string): string {
    const safeId = this.sanitizeDocumentId(documentId);
    const dir = this.assertContainedPath(path.join(this.baseDir, "documents", safeId, "versions"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async saveDocumentVersion(version: DocumentVersion): Promise<void> {
    if (!Number.isInteger(version.revision) || version.revision < 1) {
      throw new Error("Version revision must be a positive integer.");
    }
    const dir = this.versionsDir(version.documentId);
    const filename = `rev-${String(version.revision).padStart(6, "0")}.json`;
    const filePath = this.assertContainedPath(path.join(dir, filename));
    const tmpPath = this.assertContainedPath(path.join(dir, `.${filename}.${randomUUID()}.tmp`));
    try {
      writeFileSync(tmpPath, JSON.stringify(version, null, 2), { encoding: "utf8", flag: "wx" });
      // Atomic POSIX non-overwriting publish: linkSync fails atomically with EEXIST if another writer won the race (H12)
      try {
        linkSync(tmpPath, filePath);
      } catch (linkErr) {
        if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Immutable version conflict: revision ${version.revision} already exists for ${version.documentId}.`);
        }
        throw linkErr;
      }
      unlinkSync(tmpPath);
    } catch (err) {
      if (existsSync(tmpPath)) {
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          // best-effort temp cleanup
        }
      }
      throw err;
    }
  }

  async listVersions(documentId: string): Promise<DocumentVersion[]> {
    const safeId = this.sanitizeDocumentId(documentId);
    const dir = this.assertContainedPath(path.join(this.baseDir, "documents", safeId, "versions"));
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
    return files.map((file) => JSON.parse(readFileSync(this.assertContainedPath(path.join(dir, file)), "utf8")) as DocumentVersion);
  }

  async getVersion(documentId: string, revision: number): Promise<DocumentVersion | null> {
    if (!Number.isInteger(revision) || revision < 1) return null;
    const safeId = this.sanitizeDocumentId(documentId);
    const filename = `rev-${String(revision).padStart(6, "0")}.json`;
    const filePath = this.assertContainedPath(path.join(this.baseDir, "documents", safeId, "versions", filename));
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as DocumentVersion;
  }

  async getDocument(documentId: string): Promise<StudioDocument | null> {
    const safeId = this.sanitizeDocumentId(documentId);
    const dir = this.assertContainedPath(path.join(this.baseDir, "documents", safeId, "versions"));
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
    const latestFile = files[files.length - 1];
    if (!latestFile) return null;
    const version = JSON.parse(readFileSync(this.assertContainedPath(path.join(dir, latestFile)), "utf8")) as DocumentVersion;
    return version.snapshot ?? null;
  }

  async listDocuments(tenantId: string, workspaceId: string): Promise<StudioDocument[]> {
    const docsRoot = path.join(this.baseDir, "documents");
    if (!existsSync(docsRoot)) return [];
    const entries = readdirSync(docsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    const result: StudioDocument[] = [];
    for (const entry of entries) {
      const latest = await this.getDocument(entry.name);
      if (latest && latest.tenantId === tenantId && latest.workspaceId === workspaceId) {
        result.push(latest);
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export class InMemoryStorageAdapter implements DocumentStorageAdapter {
  private readonly originals = new Map<string, Uint8Array>();
  private readonly versions = new Map<string, DocumentVersion[]>();

  async saveOriginalBinary(bytes: Uint8Array, extension: string): Promise<{ sha256: string; path: string }> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!this.originals.has(sha256)) {
      this.originals.set(sha256, Uint8Array.from(bytes));
    }
    return { sha256, path: `memory://originals/${sha256}.${extension}` };
  }

  async saveDocumentVersion(version: DocumentVersion): Promise<void> {
    const list = this.versions.get(version.documentId) ?? [];
    if (list.some((v) => v.revision === version.revision)) {
      throw new Error(`Immutable version conflict: revision ${version.revision} already exists.`);
    }
    list.push(structuredClone(version));
    this.versions.set(version.documentId, list);
  }

  async listVersions(documentId: string): Promise<DocumentVersion[]> {
    return structuredClone(this.versions.get(documentId) ?? []);
  }

  async getVersion(documentId: string, revision: number): Promise<DocumentVersion | null> {
    const found = (this.versions.get(documentId) ?? []).find((v) => v.revision === revision);
    return found ? structuredClone(found) : null;
  }

  async getDocument(documentId: string): Promise<StudioDocument | null> {
    const list = this.versions.get(documentId) ?? [];
    const latest = list[list.length - 1];
    return latest ? structuredClone(latest.snapshot) : null;
  }

  async listDocuments(tenantId: string, workspaceId: string): Promise<StudioDocument[]> {
    const docs: StudioDocument[] = [];
    for (const list of this.versions.values()) {
      const latest = list[list.length - 1]?.snapshot;
      if (latest && latest.tenantId === tenantId && latest.workspaceId === workspaceId) {
        docs.push(structuredClone(latest));
      }
    }
    return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
