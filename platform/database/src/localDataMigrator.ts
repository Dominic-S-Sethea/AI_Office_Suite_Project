import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import type { PgDatabaseAdapter, PgQueryExecutor } from "./adapter.ts";

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

/**
 * Scans `.local-data/documents/<docId>/versions/rev-*.json` (the canonical layout produced by
 * `LocalFilesystemStorageAdapter`) with fallback to flat `<docDir>/rev-*.json` fixtures.
 */
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

  for (const entry of readdirSync(docsDir).sort()) {
    const docDir = path.join(docsDir, entry);
    if (!statSync(docDir).isDirectory()) continue;

    // Prefer canonical `versions/` subdirectory written by LocalFilesystemStorageAdapter; fall back to flat dir.
    const versionsSubdir = path.join(docDir, "versions");
    const scanDir =
      existsSync(versionsSubdir) && statSync(versionsSubdir).isDirectory() ? versionsSubdir : docDir;

    const revFiles = readdirSync(scanDir)
      .filter((f) => /^rev-\d+\.json$/.test(f))
      .sort((a, b) => {
        const na = Number.parseInt(a.replace(/\D+/g, ""), 10);
        const nb = Number.parseInt(b.replace(/\D+/g, ""), 10);
        return na - nb;
      });
    if (revFiles.length === 0) continue;

    const versions: Array<{ revision: number; snapshot: StudioDocument; sha256: string }> = [];
    for (const rf of revFiles) {
      const raw = readFileSync(path.join(scanDir, rf), "utf8");
      const sha256 = createHash("sha256").update(raw).digest("hex");
      const parsed = JSON.parse(raw) as { revision?: number; snapshot?: StudioDocument };
      const snap = parsed.snapshot ?? (parsed as unknown as StudioDocument);
      if (!snap || typeof snap.title !== "string" || typeof snap.language !== "string") {
        throw new Error(`Invalid local document snapshot in '${path.join(scanDir, rf)}'.`);
      }
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
            JSON.stringify({
              ...ver.snapshot,
              tenantId: params.targetTenantId,
              workspaceId: params.targetWorkspaceId,
              documentId: docUuid,
            }),
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

    await tx.query(
      `INSERT INTO audit_logs (
         audit_id, tenant_id, workspace_id, actor_id, actor_role, source, action, outcome,
         target_type, target_id, summary
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'administrator', 'system', 'migration.applied', 'success', 'migration_batch', $5, $6)`,
      [
        randomUUID(),
        params.targetTenantId,
        params.targetWorkspaceId,
        params.actorUserId,
        batchId,
        `Applied local-data migration batch '${batchId}' (${scanned.length} documents, ${versionsScanned} versions).`,
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
      target_workspace_id: string;
      manifest_json: MigrationManifestEntry[] | string;
      status: string;
    }>(
      "SELECT target_tenant_id, target_workspace_id, manifest_json, status FROM migration_batches WHERE batch_id = $1::uuid FOR UPDATE",
      [batchId],
    );
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
        "DELETE FROM ai_applied_operations WHERE tenant_id = $1::uuid AND document_id = $2::uuid",
        [row.target_tenant_id, entry.documentId],
      );
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

    const auditActorRes = await tx.query<{ user_id: string }>(
      "SELECT user_id::text FROM memberships WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid LIMIT 1",
      [row.target_tenant_id, row.target_workspace_id],
    );
    const systemActorId = auditActorRes.rows[0]?.user_id ?? "00000000-0000-4000-8000-000000000000";
    await tx.query(
      `INSERT INTO audit_logs (
         audit_id, tenant_id, workspace_id, actor_id, actor_role, source, action, outcome,
         target_type, target_id, summary, metadata
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'owner', 'system', 'migration.batch_rolled_back', 'success', 'migration_batch', $5, $6, $7::jsonb)`,
      [
        randomUUID(),
        row.target_tenant_id,
        row.target_workspace_id,
        systemActorId,
        batchId,
        `Rolled back migration batch ${batchId} (${manifest.length} document(s) removed).`,
        JSON.stringify({ batchId, removedDocuments: manifest.length }),
      ],
    );

    return { batchId, removedDocuments: manifest.length };
  });
}

export interface LogicalBackupSnapshot {
  snapshotVersion?: number;
  exportedAt?: string;
  integritySha256?: string;
  organizations: unknown[];
  users: unknown[];
  workspaces: unknown[];
  memberships: unknown[];
  documents: unknown[];
  documentVersions: unknown[];
  auditLogs: unknown[];
  aiAppliedOperations?: unknown[];
  idempotencyKeys?: unknown[];
  migrationBatches?: unknown[];
  xiArtifacts?: unknown[];
  xiArtifactRevisions?: unknown[];
  xiDependencyEdges?: unknown[];
  xiWorkflowRuns?: unknown[];
  xiReportingPackages?: unknown[];
  xiPackageApprovals?: unknown[];
  xiOutboxEvents?: unknown[];
}

function computeBackupPayloadSha256(tables: Omit<LogicalBackupSnapshot, "snapshotVersion" | "exportedAt" | "integritySha256">): string {
  return createHash("sha256").update(JSON.stringify(tables), "utf8").digest("hex");
}

async function queryOptionalTable(tx: PgQueryExecutor, tableName: string, orderBy: string): Promise<unknown[]> {
  const existsRes = await tx.query<{ reg: string | null }>("SELECT to_regclass($1)::text AS reg", [`public.${tableName}`]);
  if (!existsRes.rows[0]?.reg) return [];
  const res = await tx.query(`SELECT * FROM ${tableName} ORDER BY ${orderBy}`);
  return res.rows;
}

/**
 * Verifies the active PostgreSQL role can bypass RLS before exporting a full logical backup.
 */
export async function assertBackupRoleCanBypassRls(tx: PgQueryExecutor): Promise<void> {
  const privRes = await tx.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const priv = privRes.rows[0];
  if (priv && !priv.rolsuper && !priv.rolbypassrls) {
    throw new Error(
      "BACKUP_REQUIRES_BYPASSRLS_ROLE: Logical full-database backup cannot run as an RLS-restricted role (would silently drop tenant rows).",
    );
  }
}

/**
 * Exports all core and xi_* integration tables within an existing transaction.
 */
export async function exportCoreAndXiInTx(tx: PgQueryExecutor): Promise<LogicalBackupSnapshot> {
  const organizations = (await tx.query("SELECT * FROM organizations ORDER BY created_at, tenant_id")).rows;
  const users = (await tx.query("SELECT * FROM users ORDER BY created_at, user_id")).rows;
  const workspaces = (await tx.query("SELECT * FROM workspaces ORDER BY created_at, tenant_id, workspace_id")).rows;
  const memberships = (await tx.query("SELECT * FROM memberships ORDER BY created_at, tenant_id, workspace_id, user_id")).rows;
  const documents = (await tx.query("SELECT * FROM documents ORDER BY created_at, tenant_id, document_id")).rows;
  const documentVersions = (await tx.query("SELECT * FROM document_versions ORDER BY tenant_id, document_id, revision")).rows;
  const auditLogs = (await tx.query("SELECT * FROM audit_logs ORDER BY created_at, audit_id")).rows;
  const aiAppliedOperations = await queryOptionalTable(tx, "ai_applied_operations", "applied_at, tenant_id, document_id, operation_id");
  const idempotencyKeys = await queryOptionalTable(tx, "idempotency_keys", "created_at, tenant_id, operation_scope, idempotency_key");
  const migrationBatches = await queryOptionalTable(tx, "migration_batches", "created_at, batch_id");
  const xiArtifacts = await queryOptionalTable(tx, "xi_artifacts", "updated_at, tenant_id, artifact_id");
  const xiArtifactRevisions = await queryOptionalTable(tx, "xi_artifact_revisions", "tenant_id, artifact_id, revision");
  const xiDependencyEdges = await queryOptionalTable(tx, "xi_dependency_edges", "created_at, tenant_id, edge_id");
  const xiWorkflowRuns = await queryOptionalTable(tx, "xi_workflow_runs", "updated_at, tenant_id, run_id");
  const xiReportingPackages = await queryOptionalTable(tx, "xi_reporting_packages", "tenant_id, package_id, package_version");
  const xiPackageApprovals = await queryOptionalTable(tx, "xi_package_approvals", "approved_at, tenant_id, approval_id");
  const xiOutboxEvents = await queryOptionalTable(tx, "xi_outbox_events", "created_at, tenant_id, event_id");

  const tables = {
    organizations,
    users,
    workspaces,
    memberships,
    documents,
    documentVersions,
    auditLogs,
    aiAppliedOperations,
    idempotencyKeys,
    migrationBatches,
    xiArtifacts,
    xiArtifactRevisions,
    xiDependencyEdges,
    xiWorkflowRuns,
    xiReportingPackages,
    xiPackageApprovals,
    xiOutboxEvents,
  };

  return {
    snapshotVersion: 2,
    exportedAt: new Date().toISOString(),
    integritySha256: computeBackupPayloadSha256(tables),
    ...tables,
  };
}

/**
 * Exports a referentially consistent logical backup across all core + integration tables
 * inside a single `REPEATABLE READ READ ONLY` transaction.
 * Refuses to silently produce empty backups under RLS-restricted non-bypass roles.
 */
export async function exportLogicalBackupSnapshot(db: PgDatabaseAdapter): Promise<LogicalBackupSnapshot> {
  return db.withTransaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertBackupRoleCanBypassRls(tx);
    return exportCoreAndXiInTx(tx);
  });
}

async function insertBatched(
  tx: PgQueryExecutor,
  table: string,
  columns: readonly string[],
  casts: readonly string[],
  rows: unknown[][],
  onConflictDoNothing: boolean,
): Promise<void> {
  if (rows.length === 0) return;
  const BATCH_SIZE = 100;
  const colList = columns.join(", ");
  const conflictClause = onConflictDoNothing ? " ON CONFLICT DO NOTHING" : "";
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const chunk = rows.slice(start, start + BATCH_SIZE);
    const params: unknown[] = [];
    const valueTuples: string[] = [];
    for (const row of chunk) {
      const placeholders: string[] = [];
      for (let c = 0; c < columns.length; c++) {
        params.push(row[c]);
        placeholders.push(`$${params.length}${casts[c] ?? ""}`);
      }
      valueTuples.push(`(${placeholders.join(", ")})`);
    }
    await tx.query(`INSERT INTO ${table} (${colList}) VALUES ${valueTuples.join(", ")}${conflictClause}`, params);
  }
}

export function verifyLogicalBackupSnapshot(
  snapshot: LogicalBackupSnapshot,
  options: { allowLegacyUnsignedV1?: boolean } = {},
): void {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("INVALID_BACKUP_SNAPSHOT: Snapshot must be a JSON object.");
  }
  const requiredArrays: Array<keyof LogicalBackupSnapshot> = [
    "organizations",
    "users",
    "workspaces",
    "memberships",
    "documents",
    "documentVersions",
    "auditLogs",
  ];
  for (const key of requiredArrays) {
    if (!Array.isArray(snapshot[key])) {
      throw new Error(`INVALID_BACKUP_SNAPSHOT: Missing or invalid '${key}' array.`);
    }
  }

  const version = snapshot.snapshotVersion ?? 0;
  if (version < 2 && !options.allowLegacyUnsignedV1) {
    throw new Error(
      "BACKUP_INTEGRITY_MISMATCH: Unsigned or legacy v1 logical backup snapshots require explicit allowLegacyUnsignedV1=true.",
    );
  }

  if (version >= 2 && !snapshot.integritySha256) {
    throw new Error("BACKUP_INTEGRITY_MISMATCH: Logical backup snapshot SHA-256 digest is missing.");
  }

  if (snapshot.integritySha256 || !options.allowLegacyUnsignedV1) {
    const providedHex = typeof snapshot.integritySha256 === "string" ? snapshot.integritySha256.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(providedHex)) {
      throw new Error("BACKUP_INTEGRITY_MISMATCH: Logical backup snapshot SHA-256 digest is malformed.");
    }
    const tables = {
      organizations: snapshot.organizations,
      users: snapshot.users,
      workspaces: snapshot.workspaces,
      memberships: snapshot.memberships,
      documents: snapshot.documents,
      documentVersions: snapshot.documentVersions,
      auditLogs: snapshot.auditLogs,
      aiAppliedOperations: snapshot.aiAppliedOperations ?? [],
      idempotencyKeys: snapshot.idempotencyKeys ?? [],
      migrationBatches: snapshot.migrationBatches ?? [],
      xiArtifacts: snapshot.xiArtifacts ?? [],
      xiArtifactRevisions: snapshot.xiArtifactRevisions ?? [],
      xiDependencyEdges: snapshot.xiDependencyEdges ?? [],
      xiWorkflowRuns: snapshot.xiWorkflowRuns ?? [],
      xiReportingPackages: snapshot.xiReportingPackages ?? [],
      xiPackageApprovals: snapshot.xiPackageApprovals ?? [],
      xiOutboxEvents: snapshot.xiOutboxEvents ?? [],
    };
    const actualHash = computeBackupPayloadSha256(tables);
    const actualBuf = Buffer.from(actualHash, "hex");
    const providedBuf = Buffer.from(providedHex, "hex");
    if (actualBuf.length !== providedBuf.length || !timingSafeEqual(actualBuf, providedBuf)) {
      throw new Error("BACKUP_INTEGRITY_MISMATCH: Logical backup snapshot SHA-256 digest does not match payload.");
    }
  }
}

export async function restoreCoreAndXiInTx(
  tx: PgQueryExecutor,
  snapshot: LogicalBackupSnapshot,
  options: { idempotent?: boolean } = {},
): Promise<void> {
  const onConflict = Boolean(options.idempotent);
  const toJsonText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

  const colRes = await tx.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('organizations', 'workspaces', 'memberships')`,
  );
  const hasColumn = (table: string, col: string) =>
    colRes.rows.some((r) => r.table_name === table && r.column_name === col);

  const hasOrgMfa = hasColumn("organizations", "mfa_required_for_privileged");
  const hasWsVis = hasColumn("workspaces", "visibility");
  const hasMemStatus = hasColumn("memberships", "status");
  const hasMemContentAccess = hasColumn("memberships", "content_access");
  const hasMemEpoch = hasColumn("memberships", "revocation_epoch");

  await insertBatched(
    tx,
    "organizations",
    hasOrgMfa
      ? ["tenant_id", "name", "status", "mfa_required_for_privileged", "created_at"]
      : ["tenant_id", "name", "status", "created_at"],
    hasOrgMfa ? ["::uuid", "", "", "", "::timestamptz"] : ["::uuid", "", "", "::timestamptz"],
    (snapshot.organizations as Array<Record<string, unknown>>).map((o) =>
      hasOrgMfa
        ? [o.tenant_id, o.name, o.status, Boolean(o.mfa_required_for_privileged ?? false), o.created_at]
        : [o.tenant_id, o.name, o.status, o.created_at],
    ),
    onConflict,
  );

  await insertBatched(
    tx,
    "users",
    ["user_id", "email", "password_hash", "token_version", "status", "created_at"],
    ["::uuid", "", "", "", "", "::timestamptz"],
    (snapshot.users as Array<Record<string, unknown>>).map((u) => [
      u.user_id,
      u.email,
      u.password_hash,
      u.token_version,
      u.status,
      u.created_at,
    ]),
    onConflict,
  );

  await insertBatched(
    tx,
    "workspaces",
    hasWsVis
      ? ["tenant_id", "workspace_id", "name", "visibility", "created_at"]
      : ["tenant_id", "workspace_id", "name", "created_at"],
    hasWsVis ? ["::uuid", "::uuid", "", "", "::timestamptz"] : ["::uuid", "::uuid", "", "::timestamptz"],
    (snapshot.workspaces as Array<Record<string, unknown>>).map((w) =>
      hasWsVis
        ? [w.tenant_id, w.workspace_id, w.name, String(w.visibility ?? "standard"), w.created_at]
        : [w.tenant_id, w.workspace_id, w.name, w.created_at],
    ),
    onConflict,
  );

  const memCols = ["tenant_id", "workspace_id", "user_id", "role"];
  const memCasts = ["::uuid", "::uuid", "::uuid", ""];
  if (hasMemStatus) {
    memCols.push("status");
    memCasts.push("");
  }
  if (hasMemContentAccess) {
    memCols.push("content_access");
    memCasts.push("");
  }
  if (hasMemEpoch) {
    memCols.push("revocation_epoch");
    memCasts.push("");
  }
  memCols.push("created_at");
  memCasts.push("::timestamptz");

  await insertBatched(
    tx,
    "memberships",
    memCols,
    memCasts,
    (snapshot.memberships as Array<Record<string, unknown>>).map((m) => {
      const vals: unknown[] = [m.tenant_id, m.workspace_id, m.user_id, m.role];
      if (hasMemStatus) {
        vals.push(typeof m.status === "string" ? m.status : "active");
      }
      if (hasMemContentAccess) {
        vals.push(
          m.content_access !== undefined
            ? Boolean(m.content_access)
            : m.role !== "billing_admin" && m.role !== "auditor",
        );
      }
      if (hasMemEpoch) {
        vals.push(typeof m.revocation_epoch === "number" ? m.revocation_epoch : Number(m.revocation_epoch ?? 1));
      }
      vals.push(m.created_at);
      return vals;
    }),
    onConflict,
  );

  await insertBatched(
    tx,
    "documents",
    [
      "tenant_id",
      "workspace_id",
      "document_id",
      "title",
      "language",
      "current_revision",
      "published_revision",
      "status",
      "created_by",
      "created_at",
      "updated_at",
    ],
    ["::uuid", "::uuid", "::uuid", "", "", "", "", "", "::uuid", "::timestamptz", "::timestamptz"],
    (snapshot.documents as Array<Record<string, unknown>>).map((d) => [
      d.tenant_id,
      d.workspace_id,
      d.document_id,
      d.title,
      d.language,
      d.current_revision,
      d.published_revision ?? null,
      d.status,
      d.created_by,
      d.created_at,
      d.updated_at,
    ]),
    onConflict,
  );

  await insertBatched(
    tx,
    "document_versions",
    [
      "tenant_id",
      "document_id",
      "revision",
      "storage_object_key",
      "content_sha256",
      "source_import_sha256",
      "restored_from_revision",
      "source",
      "summary",
      "snapshot_json",
      "created_by",
      "created_at",
    ],
    ["::uuid", "::uuid", "", "", "", "", "", "", "", "::jsonb", "::uuid", "::timestamptz"],
    (snapshot.documentVersions as Array<Record<string, unknown>>).map((v) => [
      v.tenant_id,
      v.document_id,
      v.revision,
      v.storage_object_key,
      v.content_sha256,
      v.source_import_sha256 ?? null,
      v.restored_from_revision ?? null,
      typeof v.source === "string" ? v.source : "manual",
      typeof v.summary === "string" ? v.summary : "",
      toJsonText(v.snapshot_json),
      v.created_by,
      v.created_at,
    ]),
    onConflict,
  );

  await insertBatched(
    tx,
    "audit_logs",
    [
      "audit_id",
      "tenant_id",
      "workspace_id",
      "actor_id",
      "actor_role",
      "source",
      "action",
      "outcome",
      "target_type",
      "target_id",
      "revision_before",
      "revision_after",
      "summary",
      "metadata",
      "created_at",
    ],
    ["::uuid", "::uuid", "::uuid", "::uuid", "", "", "", "", "", "", "", "", "", "::jsonb", "::timestamptz"],
    (snapshot.auditLogs as Array<Record<string, unknown>>).map((a) => [
      a.audit_id,
      a.tenant_id,
      a.workspace_id ?? null,
      a.actor_id,
      a.actor_role,
      a.source,
      a.action,
      a.outcome,
      a.target_type,
      a.target_id,
      a.revision_before ?? null,
      a.revision_after ?? null,
      a.summary,
      a.metadata !== undefined && a.metadata !== null ? toJsonText(a.metadata) : null,
      a.created_at,
    ]),
    onConflict,
  );

  if (Array.isArray(snapshot.aiAppliedOperations) && snapshot.aiAppliedOperations.length > 0) {
    await insertBatched(
      tx,
      "ai_applied_operations",
      ["tenant_id", "workspace_id", "document_id", "operation_id", "result_revision", "actor_id", "applied_at"],
      ["::uuid", "::uuid", "::uuid", "", "", "::uuid", "::timestamptz"],
      (snapshot.aiAppliedOperations as Array<Record<string, unknown>>).map((op) => [
        op.tenant_id,
        op.workspace_id,
        op.document_id,
        op.operation_id,
        op.result_revision,
        op.actor_id,
        op.applied_at,
      ]),
      onConflict,
    );
  }

  if (Array.isArray(snapshot.idempotencyKeys) && snapshot.idempotencyKeys.length > 0) {
    await insertBatched(
      tx,
      "idempotency_keys",
      ["tenant_id", "idempotency_key", "operation_scope", "request_hash", "response_json", "created_at", "expires_at"],
      ["::uuid", "", "", "", "::jsonb", "::timestamptz", "::timestamptz"],
      (snapshot.idempotencyKeys as Array<Record<string, unknown>>).map((k) => [
        k.tenant_id,
        k.idempotency_key,
        k.operation_scope,
        k.request_hash,
        toJsonText(k.response_json),
        k.created_at,
        k.expires_at,
      ]),
      onConflict,
    );
  }

  if (Array.isArray(snapshot.migrationBatches) && snapshot.migrationBatches.length > 0) {
    await insertBatched(
      tx,
      "migration_batches",
      ["batch_id", "target_tenant_id", "target_workspace_id", "source_dir", "manifest_json", "status", "created_at", "rolled_back_at"],
      ["::uuid", "::uuid", "::uuid", "", "::jsonb", "", "::timestamptz", "::timestamptz"],
      (snapshot.migrationBatches as Array<Record<string, unknown>>).map((b) => [
        b.batch_id,
        b.target_tenant_id,
        b.target_workspace_id,
        b.source_dir,
        toJsonText(b.manifest_json),
        b.status,
        b.created_at,
        b.rolled_back_at ?? null,
      ]),
      onConflict,
    );
  }

  // Restore optional xi_* integration tables when present in both snapshot and target schema
  const hasXi = (await tx.query<{ reg: string | null }>("SELECT to_regclass('public.xi_artifacts')::text AS reg")).rows[0]?.reg;
  if (hasXi) {
    if (Array.isArray(snapshot.xiArtifacts) && snapshot.xiArtifacts.length > 0) {
      await insertBatched(
        tx,
        "xi_artifacts",
        [
          "tenant_id",
          "workspace_id",
          "artifact_id",
          "kind",
          "title",
          "current_revision",
          "published_revision",
          "owner_id",
          "classification",
          "lifecycle_status",
          "updated_at",
        ],
        ["::uuid", "::uuid", "", "", "", "", "", "::uuid", "", "", "::timestamptz"],
        (snapshot.xiArtifacts as Array<Record<string, unknown>>).map((x) => [
          x.tenant_id,
          x.workspace_id,
          x.artifact_id,
          x.kind,
          x.title,
          x.current_revision,
          x.published_revision ?? null,
          x.owner_id,
          x.classification,
          x.lifecycle_status,
          x.updated_at,
        ]),
        onConflict,
      );
    }

    if (Array.isArray(snapshot.xiArtifactRevisions) && snapshot.xiArtifactRevisions.length > 0) {
      await insertBatched(
        tx,
        "xi_artifact_revisions",
        ["tenant_id", "artifact_id", "revision", "kind", "content_sha256", "restored_from_revision", "created_by", "created_at"],
        ["::uuid", "", "", "", "", "", "::uuid", "::timestamptz"],
        (snapshot.xiArtifactRevisions as Array<Record<string, unknown>>).map((x) => [
          x.tenant_id,
          x.artifact_id,
          x.revision,
          x.kind,
          x.content_sha256,
          x.restored_from_revision ?? null,
          x.created_by,
          x.created_at,
        ]),
        onConflict,
      );
    }

    if (Array.isArray(snapshot.xiDependencyEdges) && snapshot.xiDependencyEdges.length > 0) {
      await insertBatched(
        tx,
        "xi_dependency_edges",
        ["tenant_id", "edge_id", "workspace_id", "source_kind", "source_id", "target_id", "edge_json", "created_at"],
        ["::uuid", "", "::uuid", "", "", "", "::jsonb", "::timestamptz"],
        (snapshot.xiDependencyEdges as Array<Record<string, unknown>>).map((x) => [
          x.tenant_id,
          x.edge_id,
          x.workspace_id,
          x.source_kind,
          x.source_id,
          x.target_id,
          toJsonText(x.edge_json),
          x.created_at,
        ]),
        onConflict,
      );
    }

    if (Array.isArray(snapshot.xiWorkflowRuns) && snapshot.xiWorkflowRuns.length > 0) {
      await insertBatched(
        tx,
        "xi_workflow_runs",
        ["tenant_id", "run_id", "idempotency_key", "workspace_id", "actor_id", "state", "run_json", "updated_at"],
        ["::uuid", "", "", "::uuid", "::uuid", "", "::jsonb", "::timestamptz"],
        (snapshot.xiWorkflowRuns as Array<Record<string, unknown>>).map((x) => [
          x.tenant_id,
          x.run_id,
          x.idempotency_key,
          x.workspace_id,
          x.actor_id,
          x.state,
          toJsonText(x.run_json),
          x.updated_at,
        ]),
        onConflict,
      );
    }

    if (Array.isArray(snapshot.xiReportingPackages) && snapshot.xiReportingPackages.length > 0) {
      await insertBatched(
        tx,
        "xi_reporting_packages",
        ["tenant_id", "package_id", "package_version", "workspace_id", "lifecycle_status", "manifest_digest_sha256", "manifest_json", "published_at"],
        ["::uuid", "", "", "::uuid", "", "", "::jsonb", "::timestamptz"],
        (snapshot.xiReportingPackages as Array<Record<string, unknown>>).map((x) => [
          x.tenant_id,
          x.package_id,
          x.package_version,
          x.workspace_id,
          x.lifecycle_status,
          x.manifest_digest_sha256,
          toJsonText(x.manifest_json),
          x.published_at ?? null,
        ]),
        onConflict,
      );
    }

    if (Array.isArray(snapshot.xiPackageApprovals) && snapshot.xiPackageApprovals.length > 0) {
      await insertBatched(
        tx,
        "xi_package_approvals",
        ["tenant_id", "approval_id", "package_id", "package_version", "manifest_digest_sha256", "approver_id", "status", "approved_at"],
        ["::uuid", "", "", "", "", "::uuid", "", "::timestamptz"],
        (snapshot.xiPackageApprovals as Array<Record<string, unknown>>).map((x) => [
          x.tenant_id,
          x.approval_id,
          x.package_id,
          x.package_version,
          x.manifest_digest_sha256,
          x.approver_id,
          x.status,
          x.approved_at,
        ]),
        onConflict,
      );
    }

    if (Array.isArray(snapshot.xiOutboxEvents) && snapshot.xiOutboxEvents.length > 0) {
      await insertBatched(
        tx,
        "xi_outbox_events",
        ["tenant_id", "event_id", "event_type", "aggregate_type", "aggregate_id", "payload_json", "idempotency_key", "status", "created_at"],
        ["::uuid", "::uuid", "", "", "", "::jsonb", "", "", "::timestamptz"],
        (snapshot.xiOutboxEvents as Array<Record<string, unknown>>).map((x) => [
          x.tenant_id,
          x.event_id,
          x.event_type,
          x.aggregate_type,
          x.aggregate_id,
          toJsonText(x.payload_json),
          x.idempotency_key,
          x.status,
          x.created_at,
        ]),
        onConflict,
      );
    }
  }
}

export async function restoreLogicalBackupSnapshot(
  targetDb: PgDatabaseAdapter,
  snapshot: LogicalBackupSnapshot,
  options: { idempotent?: boolean; allowLegacyUnsignedV1?: boolean } = {},
): Promise<void> {
  verifyLogicalBackupSnapshot(snapshot, {
    ...(options.allowLegacyUnsignedV1 ? { allowLegacyUnsignedV1: true } : {}),
  });
  await targetDb.withTransaction(async (tx) => {
    await assertBackupRoleCanBypassRls(tx);
    await restoreCoreAndXiInTx(tx, snapshot, options);
  });
}
