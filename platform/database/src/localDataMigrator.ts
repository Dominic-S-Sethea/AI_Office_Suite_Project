import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import type { PgDatabaseAdapter } from "./adapter.ts";

export interface MigrationManifestEntry {
  documentId: string;
  title: string;
  revisionCount: number;
  latestRevision: number;
  sha256: string;
}

export interface LocalDataMigrationReport {
  mode: "dry-run" | "apply" | "rollback";
  batchId: string;
  documentsScanned: number;
  versionsScanned: number;
  entries: MigrationManifestEntry[];
  localOriginalsUntouched: boolean;
}

function scanLocalDocuments(localDataDir: string): Array<{
  meta: StudioDocument;
  versions: Array<{ revision: number; snapshot: StudioDocument; sha256: string }>;
}> {
  const docsDir = path.join(localDataDir, "documents");
  if (!existsSync(docsDir)) return [];

  const results: Array<{
    meta: StudioDocument;
    versions: Array<{ revision: number; snapshot: StudioDocument; sha256: string }>;
  }> = [];

  for (const entry of readdirSync(docsDir)) {
    const docDir = path.join(docsDir, entry);
    if (!statSync(docDir).isDirectory()) continue;
    const revFiles = readdirSync(docDir)
      .filter((f) => /^rev-\d+\.json$/.test(f))
      .sort((a, b) => {
        const na = Number.parseInt(a.replace(/\D+/g, ""), 10);
        const nb = Number.parseInt(b.replace(/\D+/g, ""), 10);
        return na - nb;
      });
    if (revFiles.length === 0) continue;

    const versions: Array<{ revision: number; snapshot: StudioDocument; sha256: string }> = [];
    for (const rf of revFiles) {
      const raw = readFileSync(path.join(docDir, rf), "utf8");
      const sha256 = createHash("sha256").update(raw).digest("hex");
      const parsed = JSON.parse(raw) as { revision?: number; snapshot?: StudioDocument };
      const snap = parsed.snapshot ?? (parsed as unknown as StudioDocument);
      const rev = parsed.revision ?? snap.revision ?? 1;
      versions.push({ revision: rev, snapshot: snap, sha256 });
    }
    const latest = versions[versions.length - 1]!.snapshot;
    results.push({ meta: latest, versions });
  }
  return results;
}

export async function runLocalDataMigration(params: {
  db: PgDatabaseAdapter;
  localDataDir: string;
  targetTenantId: string;
  targetWorkspaceId: string;
  actorUserId: string;
  mode: "dry-run" | "apply";
}): Promise<LocalDataMigrationReport> {
  const scanned = scanLocalDocuments(params.localDataDir);
  const batchId = randomUUID();
  const entries: MigrationManifestEntry[] = [];
  let versionsScanned = 0;

  for (const item of scanned) {
    versionsScanned += item.versions.length;
    const latest = item.versions[item.versions.length - 1]!;
    entries.push({
      documentId: randomUUID(),
      title: item.meta.title,
      revisionCount: item.versions.length,
      latestRevision: latest.revision,
      sha256: latest.sha256,
    });
  }

  if (params.mode === "dry-run") {
    return {
      mode: "dry-run",
      batchId,
      documentsScanned: scanned.length,
      versionsScanned,
      entries,
      localOriginalsUntouched: true,
    };
  }

  await params.db.withTransaction(async (tx) => {
    for (let i = 0; i < scanned.length; i++) {
      const item = scanned[i]!;
      const docUuid = entries[i]!.documentId;
      const latest = item.versions[item.versions.length - 1]!;

      await tx.query(
        `INSERT INTO documents (
           tenant_id, workspace_id, document_id, title, language, current_revision, status, created_by
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid)`,
        [
          params.targetTenantId,
          params.targetWorkspaceId,
          docUuid,
          item.meta.title,
          item.meta.language,
          latest.revision,
          item.meta.status,
          params.actorUserId,
        ],
      );

      for (const ver of item.versions) {
        await tx.query(
          `INSERT INTO document_versions (
             tenant_id, document_id, revision, storage_object_key, content_sha256, snapshot_json, created_by
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid)`,
          [
            params.targetTenantId,
            docUuid,
            ver.revision,
            `${params.targetTenantId}/${params.targetWorkspaceId}/migrated/${docUuid}/rev-${ver.revision}.json`,
            ver.sha256,
            JSON.stringify({ ...ver.snapshot, tenantId: params.targetTenantId, workspaceId: params.targetWorkspaceId, documentId: docUuid }),
            params.actorUserId,
          ],
        );
      }
    }

    await tx.query(
      `INSERT INTO migration_batches (
         batch_id, target_tenant_id, target_workspace_id, source_dir, manifest_json, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'applied')`,
      [
        batchId,
        params.targetTenantId,
        params.targetWorkspaceId,
        params.localDataDir,
        JSON.stringify(entries),
      ],
    );
  });

  return {
    mode: "apply",
    batchId,
    documentsScanned: scanned.length,
    versionsScanned,
    entries,
    localOriginalsUntouched: true,
  };
}

export async function rollbackMigrationBatch(
  db: PgDatabaseAdapter,
  batchId: string,
): Promise<{ batchId: string; removedDocuments: number }> {
  return db.withTransaction(async (tx) => {
    const batchRes = await tx.query<{
      target_tenant_id: string;
      manifest_json: MigrationManifestEntry[] | string;
      status: string;
    }>("SELECT target_tenant_id, manifest_json, status FROM migration_batches WHERE batch_id = $1::uuid", [batchId]);
    const row = batchRes.rows[0];
    if (!row || row.status !== "applied") {
      throw new Error(`Migration batch '${batchId}' is not active.`);
    }
    const manifest =
      typeof row.manifest_json === "string"
        ? (JSON.parse(row.manifest_json) as MigrationManifestEntry[])
        : row.manifest_json;

    for (const entry of manifest) {
      await tx.query(
        "DELETE FROM document_versions WHERE tenant_id = $1::uuid AND document_id = $2::uuid",
        [row.target_tenant_id, entry.documentId],
      );
      await tx.query(
        "DELETE FROM documents WHERE tenant_id = $1::uuid AND document_id = $2::uuid",
        [row.target_tenant_id, entry.documentId],
      );
    }

    await tx.query(
      "UPDATE migration_batches SET status = 'rolled_back', rolled_back_at = now() WHERE batch_id = $1::uuid",
      [batchId],
    );
    return { batchId, removedDocuments: manifest.length };
  });
}

export async function exportLogicalBackupSnapshot(db: PgDatabaseAdapter): Promise<{
  organizations: unknown[];
  users: unknown[];
  workspaces: unknown[];
  memberships: unknown[];
  documents: unknown[];
  documentVersions: unknown[];
  auditLogs: unknown[];
}> {
  const [organizations, users, workspaces, memberships, documents, documentVersions, auditLogs] = await Promise.all([
    db.query("SELECT * FROM organizations ORDER BY created_at"),
    db.query("SELECT * FROM users ORDER BY created_at"),
    db.query("SELECT * FROM workspaces ORDER BY created_at"),
    db.query("SELECT * FROM memberships ORDER BY created_at"),
    db.query("SELECT * FROM documents ORDER BY created_at"),
    db.query("SELECT * FROM document_versions ORDER BY document_id, revision"),
    db.query("SELECT * FROM audit_logs ORDER BY created_at"),
  ]);
  return {
    organizations: organizations.rows,
    users: users.rows,
    workspaces: workspaces.rows,
    memberships: memberships.rows,
    documents: documents.rows,
    documentVersions: documentVersions.rows,
    auditLogs: auditLogs.rows,
  };
}

export async function restoreLogicalBackupSnapshot(
  targetDb: PgDatabaseAdapter,
  snapshot: Awaited<ReturnType<typeof exportLogicalBackupSnapshot>>,
): Promise<void> {
  await targetDb.withTransaction(async (tx) => {
    for (const org of snapshot.organizations as Array<{ tenant_id: string; name: string; status: string; created_at: string }>) {
      await tx.query(
        "INSERT INTO organizations (tenant_id, name, status, created_at) VALUES ($1::uuid, $2, $3, $4::timestamptz)",
        [org.tenant_id, org.name, org.status, org.created_at],
      );
    }
    for (const usr of snapshot.users as Array<{ user_id: string; email: string; password_hash: string; token_version: number; status: string; created_at: string }>) {
      await tx.query(
        "INSERT INTO users (user_id, email, password_hash, token_version, status, created_at) VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz)",
        [usr.user_id, usr.email, usr.password_hash, usr.token_version, usr.status, usr.created_at],
      );
    }
    for (const ws of snapshot.workspaces as Array<{ tenant_id: string; workspace_id: string; name: string; created_at: string }>) {
      await tx.query(
        "INSERT INTO workspaces (tenant_id, workspace_id, name, created_at) VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz)",
        [ws.tenant_id, ws.workspace_id, ws.name, ws.created_at],
      );
    }
    for (const m of snapshot.memberships as Array<{ tenant_id: string; workspace_id: string; user_id: string; role: string; created_at: string }>) {
      await tx.query(
        "INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)",
        [m.tenant_id, m.workspace_id, m.user_id, m.role, m.created_at],
      );
    }
    for (const d of snapshot.documents as Array<{ tenant_id: string; workspace_id: string; document_id: string; title: string; language: string; current_revision: number; status: string; created_by: string; created_at: string; updated_at: string }>) {
      await tx.query(
        "INSERT INTO documents (tenant_id, workspace_id, document_id, title, language, current_revision, status, created_by, created_at, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::timestamptz, $10::timestamptz)",
        [d.tenant_id, d.workspace_id, d.document_id, d.title, d.language, d.current_revision, d.status, d.created_by, d.created_at, d.updated_at],
      );
    }
    for (const v of snapshot.documentVersions as Array<{ tenant_id: string; document_id: string; revision: number; storage_object_key: string; content_sha256: string; snapshot_json: unknown; created_by: string; created_at: string }>) {
      await tx.query(
        "INSERT INTO document_versions (tenant_id, document_id, revision, storage_object_key, content_sha256, snapshot_json, created_by, created_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, $8::timestamptz)",
        [
          v.tenant_id,
          v.document_id,
          v.revision,
          v.storage_object_key,
          v.content_sha256,
          typeof v.snapshot_json === "string" ? v.snapshot_json : JSON.stringify(v.snapshot_json),
          v.created_by,
          v.created_at,
        ],
      );
    }
  });
}
