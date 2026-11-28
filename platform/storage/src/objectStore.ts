import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { FileQuarantineState } from "@ai-office-suite/shared-contracts";

export interface PrivateObjectPutParams {
  tenantId: string;
  workspaceId: string;
  objectId: string;
  version: number;
  bytes: Uint8Array;
}

export interface PrivateObjectPutResult {
  storageKey: string;
  sha256: string;
  byteSize: number;
}

export interface SignedObjectTokenPayload {
  tenantId: string;
  workspaceId: string;
  objectId: string;
  version: number;
  storageKey: string;
  exp: number;
  nonce: string;
}

export interface ObjectStoreSnapshotEntry {
  storageKey: string;
  sha256: string;
  byteSize: number;
  contentBase64: string;
}

export interface ObjectStoreSnapshot {
  exportedAt: string;
  entries: ObjectStoreSnapshotEntry[];
}

export class PrivateObjectStorageError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "PrivateObjectStorageError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const DEFAULT_ORPHAN_SWEEP_MIN_AGE_MS = 15 * 60 * 1000;

export interface PrivateObjectStoreAdapter {
  putObject(params: PrivateObjectPutParams): Promise<PrivateObjectPutResult>;
  getObjectBytes(params: {
    tenantId: string;
    workspaceId: string;
    storageKey: string;
    quarantineState?: FileQuarantineState;
    allowQuarantinedAdmin?: boolean;
  }): Promise<{ bytes: Uint8Array; sha256: string }>;
  getAuthorizedObjectBytes(params: {
    token: string;
    expectedTenantId: string;
    expectedWorkspaceId: string;
    expectedObjectId?: string;
    quarantineState: FileQuarantineState;
    deletedAt?: string | null;
    membershipActive?: boolean;
    allowQuarantinedAdmin?: boolean;
    consumeOnce?: boolean;
    nowMs?: number;
  }): Promise<{ bytes: Uint8Array; sha256: string; payload: SignedObjectTokenPayload }>;
  deleteBlob(storageKey: string): Promise<boolean>;
  issueSignedDownloadToken(params: {
    tenantId: string;
    workspaceId: string;
    objectId: string;
    version: number;
    storageKey: string;
    ttlSeconds?: number;
    nowMs?: number;
  }): string;
  verifySignedDownloadToken(params: {
    token: string;
    expectedTenantId: string;
    expectedWorkspaceId: string;
    expectedObjectId?: string;
    consumeOnce?: boolean;
    nowMs?: number;
  }): SignedObjectTokenPayload;
  sweepOrphanedBlobs(
    referencedStorageKeys: ReadonlySet<string>,
    options?: { minAgeMs?: number; nowMs?: number },
  ): Promise<{ removedKeys: string[]; retainedCount: number; skippedRecentKeys: string[] }>;
  exportSnapshot(): Promise<ObjectStoreSnapshot>;
  restoreSnapshot(snapshot: ObjectStoreSnapshot): Promise<{ restoredCount: number; verifiedSha256Count: number }>;
}

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]{1,128}$/;

function assertSafeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new PrivateObjectStorageError(
      400,
      "INVALID_STORAGE_SEGMENT",
      `Invalid ${label} segment '${value}' for private object key.`,
    );
  }
  return value;
}

/**
 * Private versioned local object-store adapter for PA-00 feasibility (PLT-03).
 * - Zero public URLs; all objects stored under `tenants/<tenantId>/workspaces/<workspaceId>/objects/<objectId>/v<version>-<sha256>.bin`.
 * - Enforces path traversal containment, SHA-256 verification on read, short-lived HMAC signed tokens,
 *   quarantine download blocking, orphan cleanup, and isolated snapshot export/restore.
 */
export class LocalPrivateObjectStore implements PrivateObjectStoreAdapter {
  private readonly rootDir: string;
  private readonly signingSecret: string;
  private readonly consumedNonces = new Map<string, number>();

  constructor(rootDir: string, signingSecret?: string) {
    this.rootDir = path.resolve(rootDir);
    this.signingSecret = signingSecret?.trim() || randomBytes(32).toString("hex");
    mkdirSync(this.rootDir, { recursive: true });
  }

  private assertContained(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    if (resolved !== this.rootDir && !resolved.startsWith(this.rootDir + path.sep)) {
      throw new PrivateObjectStorageError(
        403,
        "PATH_TRAVERSAL_BLOCKED",
        `Storage key escapes private object store root: '${targetPath}'.`,
      );
    }
    return resolved;
  }

  private assertTenantKeyPrefix(storageKey: string, tenantId: string, workspaceId: string): void {
    const safeTenant = assertSafeSegment(tenantId, "tenantId");
    const safeWorkspace = assertSafeSegment(workspaceId, "workspaceId");
    const expectedPrefix = `tenants/${safeTenant}/workspaces/${safeWorkspace}/objects/`;
    if (!storageKey.startsWith(expectedPrefix) || storageKey.includes("..") || storageKey.includes("\\")) {
      throw new PrivateObjectStorageError(
        403,
        "TENANT_OBJECT_KEY_MISMATCH",
        "Private storage key does not belong to the authorized tenant/workspace boundary.",
      );
    }
  }

  async putObject(params: PrivateObjectPutParams): Promise<PrivateObjectPutResult> {
    const tenantId = assertSafeSegment(params.tenantId, "tenantId");
    const workspaceId = assertSafeSegment(params.workspaceId, "workspaceId");
    const objectId = assertSafeSegment(params.objectId, "objectId");
    if (!Number.isInteger(params.version) || params.version < 1) {
      throw new PrivateObjectStorageError(400, "INVALID_OBJECT_VERSION", "Object version must be a positive integer.");
    }

    const sha256 = createHash("sha256").update(params.bytes).digest("hex");
    const storageKey = `tenants/${tenantId}/workspaces/${workspaceId}/objects/${objectId}/v${params.version}-${sha256}.bin`;
    const filePath = this.assertContained(path.join(this.rootDir, storageKey));
    mkdirSync(path.dirname(filePath), { recursive: true });

    try {
      writeFileSync(filePath, params.bytes, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    return {
      storageKey,
      sha256,
      byteSize: params.bytes.byteLength,
    };
  }

  async writeUnreferencedStagingBlob(relativeKey: string, bytes: Uint8Array): Promise<string> {
    if (relativeKey.includes("..") || relativeKey.startsWith("/") || relativeKey.includes("\\")) {
      throw new PrivateObjectStorageError(403, "PATH_TRAVERSAL_BLOCKED", "Unsafe staging blob key.");
    }
    const filePath = this.assertContained(path.join(this.rootDir, relativeKey));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);
    return relativeKey;
  }

  async getObjectBytes(params: {
    tenantId: string;
    workspaceId: string;
    storageKey: string;
    quarantineState?: FileQuarantineState;
    allowQuarantinedAdmin?: boolean;
  }): Promise<{ bytes: Uint8Array; sha256: string }> {
    this.assertTenantKeyPrefix(params.storageKey, params.tenantId, params.workspaceId);

    if (
      params.quarantineState &&
      params.quarantineState !== "clean" &&
      !params.allowQuarantinedAdmin
    ) {
      throw new PrivateObjectStorageError(
        423,
        "FILE_QUARANTINED_OR_UNSCANNED",
        `File download blocked because quarantineState is '${params.quarantineState}'.`,
      );
    }

    const filePath = this.assertContained(path.join(this.rootDir, params.storageKey));
    if (!existsSync(filePath)) {
      throw new PrivateObjectStorageError(404, "OBJECT_NOT_FOUND", "Private storage object not found.");
    }

    const buf = readFileSync(filePath);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // Verify filename digest integrity when encoded in key
    const keyMatch = params.storageKey.match(/-([0-9a-f]{64})\.bin$/);
    if (keyMatch && keyMatch[1] !== sha256) {
      throw new PrivateObjectStorageError(
        500,
        "OBJECT_INTEGRITY_MISMATCH",
        "Stored blob SHA-256 failed integrity verification.",
      );
    }

    return { bytes, sha256 };
  }

  async deleteBlob(storageKey: string): Promise<boolean> {
    if (storageKey.includes("..") || storageKey.startsWith("/") || storageKey.includes("\\")) {
      throw new PrivateObjectStorageError(403, "PATH_TRAVERSAL_BLOCKED", "Unsafe storage key for deletion.");
    }
    const filePath = this.assertContained(path.join(this.rootDir, storageKey));
    if (!existsSync(filePath)) return false;
    rmSync(filePath, { force: true });
    return true;
  }

  issueSignedDownloadToken(params: {
    tenantId: string;
    workspaceId: string;
    objectId: string;
    version: number;
    storageKey: string;
    ttlSeconds?: number;
    nowMs?: number;
  }): string {
    this.assertTenantKeyPrefix(params.storageKey, params.tenantId, params.workspaceId);
    const ttl = Math.max(10, Math.min(900, params.ttlSeconds ?? 120));
    const now = params.nowMs ?? Date.now();
    const payload: SignedObjectTokenPayload = {
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      objectId: params.objectId,
      version: params.version,
      storageKey: params.storageKey,
      exp: now + ttl * 1000,
      nonce: randomBytes(12).toString("hex"),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", this.signingSecret).update(encoded).digest("base64url");
    return `${encoded}.${sig}`;
  }

  verifySignedDownloadToken(params: {
    token: string;
    expectedTenantId: string;
    expectedWorkspaceId: string;
    expectedObjectId?: string;
    consumeOnce?: boolean;
    nowMs?: number;
  }): SignedObjectTokenPayload {
    const parts = params.token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new PrivateObjectStorageError(401, "INVALID_SIGNED_TOKEN", "Malformed signed object token.");
    }
    const [encoded, providedSig] = parts;
    const expectedSig = createHmac("sha256", this.signingSecret).update(encoded).digest("base64url");
    const a = Buffer.from(providedSig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PrivateObjectStorageError(401, "INVALID_SIGNED_TOKEN", "Signed object token signature mismatch.");
    }

    let payload: SignedObjectTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedObjectTokenPayload;
    } catch {
      throw new PrivateObjectStorageError(401, "INVALID_SIGNED_TOKEN", "Corrupted signed object token payload.");
    }

    const now = params.nowMs ?? Date.now();
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || now > payload.exp) {
      throw new PrivateObjectStorageError(401, "SIGNED_TOKEN_EXPIRED", "Signed object download token has expired.");
    }
    if (
      payload.tenantId !== params.expectedTenantId ||
      payload.workspaceId !== params.expectedWorkspaceId ||
      (params.expectedObjectId && payload.objectId !== params.expectedObjectId)
    ) {
      throw new PrivateObjectStorageError(
        403,
        "SIGNED_TOKEN_SCOPE_MISMATCH",
        "Signed object download token is not valid for this tenant/workspace/object.",
      );
    }

    this.assertTenantKeyPrefix(payload.storageKey, payload.tenantId, payload.workspaceId);

    if (params.consumeOnce) {
      for (const [nonce, exp] of this.consumedNonces.entries()) {
        if (exp <= now) this.consumedNonces.delete(nonce);
      }
      if (!payload.nonce || this.consumedNonces.has(payload.nonce)) {
        throw new PrivateObjectStorageError(
          401,
          "SIGNED_TOKEN_REPLAYED",
          "Signed object download token has already been used.",
        );
      }
      this.consumedNonces.set(payload.nonce, payload.exp);
    }

    return payload;
  }

  /**
   * Authorizes a signed download request against live membership, deletion tombstone,
   * and quarantine state so revocations and quarantines take effect immediately even mid-TTL (F-21).
   */
  async getAuthorizedObjectBytes(params: {
    token: string;
    expectedTenantId: string;
    expectedWorkspaceId: string;
    expectedObjectId?: string;
    quarantineState: FileQuarantineState;
    deletedAt?: string | null;
    membershipActive?: boolean;
    allowQuarantinedAdmin?: boolean;
    consumeOnce?: boolean;
    nowMs?: number;
  }): Promise<{ bytes: Uint8Array; sha256: string; payload: SignedObjectTokenPayload }> {
    const payload = this.verifySignedDownloadToken({
      token: params.token,
      expectedTenantId: params.expectedTenantId,
      expectedWorkspaceId: params.expectedWorkspaceId,
      ...(params.expectedObjectId !== undefined ? { expectedObjectId: params.expectedObjectId } : {}),
      ...(params.consumeOnce !== undefined ? { consumeOnce: params.consumeOnce } : {}),
      ...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
    });
    if (params.membershipActive === false) {
      throw new PrivateObjectStorageError(
        403,
        "MEMBERSHIP_REVOKED",
        "Download denied because caller membership is no longer active.",
      );
    }
    if (params.deletedAt) {
      throw new PrivateObjectStorageError(
        404,
        "OBJECT_DELETED",
        "Download denied because the target file version has been deleted.",
      );
    }
    const data = await this.getObjectBytes({
      tenantId: payload.tenantId,
      workspaceId: payload.workspaceId,
      storageKey: payload.storageKey,
      quarantineState: params.quarantineState,
      ...(params.allowQuarantinedAdmin !== undefined
        ? { allowQuarantinedAdmin: params.allowQuarantinedAdmin }
        : {}),
    });
    return { ...data, payload };
  }

  private walkFiles(dir: string, relBase = ""): string[] {
    if (!existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = relBase ? `${relBase}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...this.walkFiles(full, rel));
      } else if (st.isFile()) {
        results.push(rel);
      }
    }
    return results.sort();
  }

  async sweepOrphanedBlobs(
    referencedStorageKeys: ReadonlySet<string>,
    options: { minAgeMs?: number; nowMs?: number } = {},
  ): Promise<{ removedKeys: string[]; retainedCount: number; skippedRecentKeys: string[] }> {
    const minAgeMs = Math.max(0, options.minAgeMs ?? DEFAULT_ORPHAN_SWEEP_MIN_AGE_MS);
    const nowMs = options.nowMs ?? Date.now();
    const allKeys = this.walkFiles(this.rootDir);
    const removedKeys: string[] = [];
    const skippedRecentKeys: string[] = [];
    let retainedCount = 0;
    for (const key of allKeys) {
      if (!referencedStorageKeys.has(key)) {
        const full = this.assertContained(path.join(this.rootDir, key));
        const ageMs = nowMs - statSync(full).mtimeMs;
        if (ageMs < minAgeMs) {
          skippedRecentKeys.push(key);
          retainedCount += 1;
          continue;
        }
        await this.deleteBlob(key);
        removedKeys.push(key);
      } else {
        retainedCount += 1;
      }
    }
    return { removedKeys, retainedCount, skippedRecentKeys };
  }

  async exportSnapshot(): Promise<ObjectStoreSnapshot> {
    const allKeys = this.walkFiles(this.rootDir);
    const entries: ObjectStoreSnapshotEntry[] = allKeys.map((storageKey) => {
      const full = this.assertContained(path.join(this.rootDir, storageKey));
      const buf = readFileSync(full);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      return {
        storageKey,
        sha256,
        byteSize: buf.byteLength,
        contentBase64: buf.toString("base64"),
      };
    });
    return {
      exportedAt: new Date().toISOString(),
      entries,
    };
  }

  async restoreSnapshot(
    snapshot: ObjectStoreSnapshot,
  ): Promise<{ restoredCount: number; verifiedSha256Count: number }> {
    let restoredCount = 0;
    let verifiedSha256Count = 0;
    for (const entry of snapshot.entries) {
      if (entry.storageKey.includes("..") || entry.storageKey.startsWith("/") || entry.storageKey.includes("\\")) {
        throw new PrivateObjectStorageError(403, "PATH_TRAVERSAL_BLOCKED", "Unsafe storage key in snapshot.");
      }
      const bytes = Buffer.from(entry.contentBase64, "base64");
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      if (actualSha !== entry.sha256) {
        throw new PrivateObjectStorageError(
          500,
          "SNAPSHOT_INTEGRITY_MISMATCH",
          `Restored blob '${entry.storageKey}' SHA-256 mismatch.`,
        );
      }
      const full = this.assertContained(path.join(this.rootDir, entry.storageKey));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, bytes);
      restoredCount += 1;
      verifiedSha256Count += 1;
    }
    return { restoredCount, verifiedSha256Count };
  }
}
