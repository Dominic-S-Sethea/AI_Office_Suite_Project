import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * - Document versions are append-only JSON files; restoring a prior revision creates a new revision.
 */
export class LocalFilesystemStorageAdapter implements DocumentStorageAdapter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    mkdirSync(path.join(this.baseDir, "originals"), { recursive: true });
    mkdirSync(path.join(this.baseDir, "documents"), { recursive: true });
  }

  async saveOriginalBinary(bytes: Uint8Array, extension: string): Promise<{ sha256: string; path: string }> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const safeExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const filePath = path.join(this.baseDir, "originals", `${sha256}.${safeExt}`);
    // Write-once: never overwrite an existing original binary with the same SHA-256.
    if (!existsSync(filePath)) {
      writeFileSync(filePath, bytes, { flag: "wx" });
    }
    return { sha256, path: filePath };
  }

  private versionsDir(documentId: string): string {
    const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = path.join(this.baseDir, "documents", safeId, "versions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async saveDocumentVersion(version: DocumentVersion): Promise<void> {
    const dir = this.versionsDir(version.documentId);
    const filename = `rev-${String(version.revision).padStart(6, "0")}.json`;
    const filePath = path.join(dir, filename);
    if (existsSync(filePath)) {
      throw new Error(`Immutable version conflict: revision ${version.revision} already exists for ${version.documentId}.`);
    }
    writeFileSync(filePath, JSON.stringify(version, null, 2), "utf8");
  }

  async listVersions(documentId: string): Promise<DocumentVersion[]> {
    const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = path.join(this.baseDir, "documents", safeId, "versions");
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    return files.map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as DocumentVersion);
  }

  async getVersion(documentId: string, revision: number): Promise<DocumentVersion | null> {
    const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `rev-${String(revision).padStart(6, "0")}.json`;
    const filePath = path.join(this.baseDir, "documents", safeId, "versions", filename);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as DocumentVersion;
  }

  async getDocument(documentId: string): Promise<StudioDocument | null> {
    const versions = await this.listVersions(documentId);
    if (versions.length === 0) return null;
    return versions[versions.length - 1]?.snapshot ?? null;
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
