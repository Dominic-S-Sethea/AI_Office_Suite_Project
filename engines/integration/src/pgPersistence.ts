import { randomUUID } from "node:crypto";
import type { PgDatabaseAdapter } from "@ai-office-suite/database";
import { withTenantTransaction } from "@ai-office-suite/database";
import type {
  ArtifactReference,
  ArtifactRevisionReference,
  DependencyEdge,
  PublicationApproval,
  ReportingPackageManifest,
  WorkflowRun,
} from "@ai-office-suite/shared-contracts";

export const XI_SCHEMA_VERSION = "2026.11.v2-xi";
const XI_SCHEMA_LOCK_KEY = 84102002;

export const XI00_INTEGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS xi_artifacts (
  tenant_id           UUID NOT NULL REFERENCES organizations(tenant_id),
  workspace_id        UUID NOT NULL,
  artifact_id         TEXT NOT NULL,
  kind                TEXT NOT NULL,
  title               TEXT NOT NULL,
  current_revision    INTEGER NOT NULL CHECK (current_revision >= 1),
  published_revision  INTEGER NULL,
  owner_id            UUID NOT NULL,
  classification      TEXT NOT NULL,
  lifecycle_status    TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS xi_artifact_revisions (
  tenant_id               UUID NOT NULL,
  artifact_id             TEXT NOT NULL,
  revision                INTEGER NOT NULL CHECK (revision >= 1),
  kind                    TEXT NOT NULL,
  content_sha256          CHAR(64) NOT NULL,
  restored_from_revision  INTEGER NULL,
  created_by              UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, artifact_id, revision),
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES xi_artifacts(tenant_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS xi_dependency_edges (
  tenant_id     UUID NOT NULL,
  edge_id       TEXT NOT NULL,
  workspace_id  UUID NOT NULL,
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  edge_json     JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, edge_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS xi_workflow_runs (
  tenant_id        UUID NOT NULL,
  run_id           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  workspace_id     UUID NOT NULL,
  actor_id         UUID NOT NULL,
  state            TEXT NOT NULL,
  run_json         JSONB NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS xi_reporting_packages (
  tenant_id               UUID NOT NULL,
  package_id              TEXT NOT NULL,
  package_version         INTEGER NOT NULL CHECK (package_version >= 1),
  workspace_id            UUID NOT NULL,
  lifecycle_status        TEXT NOT NULL,
  manifest_digest_sha256  CHAR(64) NOT NULL,
  manifest_json           JSONB NOT NULL,
  published_at            TIMESTAMPTZ NULL,
  PRIMARY KEY (tenant_id, package_id, package_version),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS xi_package_approvals (
  tenant_id               UUID NOT NULL,
  approval_id             TEXT NOT NULL,
  package_id              TEXT NOT NULL,
  package_version         INTEGER NOT NULL,
  manifest_digest_sha256  CHAR(64) NOT NULL,
  approver_id             UUID NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('approved', 'invalidated')),
  approved_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, approval_id),
  FOREIGN KEY (tenant_id, package_id, package_version)
    REFERENCES xi_reporting_packages(tenant_id, package_id, package_version)
);

CREATE TABLE IF NOT EXISTS xi_outbox_events (
  tenant_id        UUID NOT NULL REFERENCES organizations(tenant_id),
  event_id         UUID NOT NULL,
  event_type       TEXT NOT NULL,
  aggregate_type   TEXT NOT NULL,
  aggregate_id     TEXT NOT NULL,
  payload_json     JSONB NOT NULL,
  idempotency_key  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'dispatched')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, idempotency_key)
);

-- Secondary indexes for XI tables (H6)
CREATE INDEX IF NOT EXISTS xi_artifacts_tenant_ws_updated_idx ON xi_artifacts (tenant_id, workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS xi_edges_src_idx ON xi_dependency_edges (tenant_id, source_id);
CREATE INDEX IF NOT EXISTS xi_edges_tgt_idx ON xi_dependency_edges (tenant_id, target_id);
CREATE INDEX IF NOT EXISTS xi_approvals_pkg_idx ON xi_package_approvals (tenant_id, package_id, package_version, approved_at DESC);
CREATE INDEX IF NOT EXISTS xi_outbox_pending_idx ON xi_outbox_events (tenant_id, created_at ASC) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON
  xi_artifacts,
  xi_dependency_edges,
  xi_workflow_runs,
  xi_reporting_packages,
  xi_package_approvals,
  xi_outbox_events
  TO app_runtime;

GRANT SELECT, INSERT ON
  xi_artifact_revisions
  TO app_runtime;

REVOKE UPDATE, DELETE ON
  xi_artifact_revisions
  FROM app_runtime;

REVOKE DELETE ON
  xi_package_approvals,
  xi_outbox_events
  FROM app_runtime;

ALTER TABLE xi_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE xi_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_xi_artifacts ON xi_artifacts;
CREATE POLICY tenant_isolation_xi_artifacts ON xi_artifacts
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

ALTER TABLE xi_artifact_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE xi_artifact_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_xi_artifact_revisions ON xi_artifact_revisions;
CREATE POLICY tenant_isolation_xi_artifact_revisions ON xi_artifact_revisions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE xi_dependency_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE xi_dependency_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_xi_dependency_edges ON xi_dependency_edges;
CREATE POLICY tenant_isolation_xi_dependency_edges ON xi_dependency_edges
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

ALTER TABLE xi_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE xi_workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_xi_workflow_runs ON xi_workflow_runs;
CREATE POLICY tenant_isolation_xi_workflow_runs ON xi_workflow_runs
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

ALTER TABLE xi_reporting_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE xi_reporting_packages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_xi_reporting_packages ON xi_reporting_packages;
CREATE POLICY tenant_isolation_xi_reporting_packages ON xi_reporting_packages
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

ALTER TABLE xi_package_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE xi_package_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_xi_package_approvals ON xi_package_approvals;
CREATE POLICY tenant_isolation_xi_package_approvals ON xi_package_approvals
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE xi_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE xi_outbox_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_xi_outbox_events ON xi_outbox_events;
CREATE POLICY tenant_isolation_xi_outbox_events ON xi_outbox_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
`;

export async function initializeIntegrationSchema(
  db: PgDatabaseAdapter,
  options: { force?: boolean } = {},
): Promise<{ applied: boolean; version: string }> {
  return db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [XI_SCHEMA_LOCK_KEY]);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    if (!options.force) {
      const existing = await tx.query<{ version: string; xi_present: boolean }>(
        "SELECT version, (to_regclass('public.xi_artifacts') IS NOT NULL) AS xi_present FROM schema_migrations WHERE version = $1",
        [XI_SCHEMA_VERSION],
      );
      if (existing.rows.length > 0 && existing.rows[0]?.xi_present) {
        return { applied: false, version: XI_SCHEMA_VERSION };
      }
    }
    await tx.exec(XI00_INTEGRATION_SCHEMA_SQL);
    await tx.query(
      "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
      [XI_SCHEMA_VERSION],
    );
    return { applied: true, version: XI_SCHEMA_VERSION };
  });
}

export async function persistArtifactRow(
  db: PgDatabaseAdapter,
  artifact: ArtifactReference,
): Promise<void> {
  await withTenantTransaction(
    db,
    artifact.tenantId,
    async (tx) => {
      await tx.query(
        `INSERT INTO xi_artifacts
          (tenant_id, workspace_id, artifact_id, kind, title, current_revision, published_revision, owner_id, classification, lifecycle_status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9, $10, $11::timestamptz)
         ON CONFLICT (tenant_id, artifact_id) DO UPDATE SET
           title = EXCLUDED.title,
           current_revision = EXCLUDED.current_revision,
           published_revision = EXCLUDED.published_revision,
           classification = EXCLUDED.classification,
           lifecycle_status = EXCLUDED.lifecycle_status,
           updated_at = EXCLUDED.updated_at`,
        [
          artifact.tenantId,
          artifact.workspaceId,
          artifact.artifactId,
          artifact.kind,
          artifact.title,
          artifact.currentRevision,
          artifact.publishedRevision ?? null,
          artifact.ownerId,
          artifact.classification,
          artifact.lifecycleStatus,
          artifact.updatedAt,
        ],
      );
    },
    artifact.workspaceId,
  );
}

export async function persistRevisionRow(
  db: PgDatabaseAdapter,
  tenantId: string,
  rev: ArtifactRevisionReference,
): Promise<void> {
  await withTenantTransaction(db, tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO xi_artifact_revisions
        (tenant_id, artifact_id, revision, kind, content_sha256, restored_from_revision, created_by, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::timestamptz)
       ON CONFLICT (tenant_id, artifact_id, revision) DO NOTHING`,
      [
        tenantId,
        rev.artifactId,
        rev.revision,
        rev.kind,
        rev.contentSha256,
        rev.restoredFromRevision ?? null,
        rev.createdBy,
        rev.createdAt,
      ],
    );
  });
}

export async function persistDependencyEdgeRow(
  db: PgDatabaseAdapter,
  edge: DependencyEdge,
): Promise<void> {
  await withTenantTransaction(
    db,
    edge.tenantId,
    async (tx) => {
      await tx.query(
        `INSERT INTO xi_dependency_edges
          (tenant_id, edge_id, workspace_id, source_kind, source_id, target_id, edge_json)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, edge_id) DO UPDATE SET
           edge_json = EXCLUDED.edge_json`,
        [
          edge.tenantId,
          edge.edgeId,
          edge.workspaceId,
          edge.sourceKind,
          edge.sourceId,
          edge.targetId,
          JSON.stringify(edge),
        ],
      );
    },
    edge.workspaceId,
  );
}

export async function persistWorkflowRunRow(
  db: PgDatabaseAdapter,
  run: WorkflowRun,
): Promise<void> {
  await withTenantTransaction(
    db,
    run.tenantId,
    async (tx) => {
      await tx.query(
        `INSERT INTO xi_workflow_runs
          (tenant_id, run_id, idempotency_key, workspace_id, actor_id, state, run_json, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT (tenant_id, run_id) DO UPDATE SET
           state = EXCLUDED.state,
           run_json = EXCLUDED.run_json,
           updated_at = EXCLUDED.updated_at`,
        [
          run.tenantId,
          run.runId,
          run.idempotencyKey,
          run.workspaceId,
          run.actorId,
          run.state,
          JSON.stringify(run),
          run.updatedAt,
        ],
      );
    },
    run.workspaceId,
  );
}

export async function loadWorkflowRunRow(
  db: PgDatabaseAdapter,
  tenantId: string,
  runId: string,
  workspaceId?: string,
): Promise<WorkflowRun | null> {
  return withTenantTransaction(
    db,
    tenantId,
    async (tx) => {
      const res = workspaceId
        ? await tx.query<{ run_json: WorkflowRun | string }>(
            `SELECT run_json FROM xi_workflow_runs WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND run_id = $3`,
            [tenantId, workspaceId, runId],
          )
        : await tx.query<{ run_json: WorkflowRun | string }>(
            `SELECT run_json FROM xi_workflow_runs WHERE tenant_id = $1::uuid AND run_id = $2`,
            [tenantId, runId],
          );
      const raw = res.rows[0]?.run_json;
      if (!raw) return null;
      return typeof raw === "string" ? (JSON.parse(raw) as WorkflowRun) : raw;
    },
    workspaceId,
  );
}

export async function persistReportingPackageRow(
  db: PgDatabaseAdapter,
  manifest: ReportingPackageManifest,
): Promise<void> {
  await withTenantTransaction(
    db,
    manifest.tenantId,
    async (tx) => {
      await tx.query(
        `INSERT INTO xi_reporting_packages
          (tenant_id, package_id, package_version, workspace_id, lifecycle_status, manifest_digest_sha256, manifest_json, published_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT (tenant_id, package_id, package_version) DO UPDATE SET
           lifecycle_status = EXCLUDED.lifecycle_status,
           manifest_digest_sha256 = EXCLUDED.manifest_digest_sha256,
           manifest_json = EXCLUDED.manifest_json,
           published_at = EXCLUDED.published_at`,
        [
          manifest.tenantId,
          manifest.packageId,
          manifest.packageVersion,
          manifest.workspaceId,
          manifest.lifecycleStatus,
          manifest.manifestDigestSha256,
          JSON.stringify(manifest),
          manifest.publishedAt ?? null,
        ],
      );
    },
    manifest.workspaceId,
  );
}

export async function persistApprovalRow(
  db: PgDatabaseAdapter,
  tenantId: string,
  approval: PublicationApproval,
): Promise<void> {
  await withTenantTransaction(db, tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO xi_package_approvals
        (tenant_id, approval_id, package_id, package_version, manifest_digest_sha256, approver_id, status, approved_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8::timestamptz)
       ON CONFLICT (tenant_id, approval_id) DO UPDATE SET
         status = EXCLUDED.status`,
      [
        tenantId,
        approval.approvalId,
        approval.packageId,
        approval.packageVersion,
        approval.manifestDigestSha256,
        approval.approverId,
        approval.status,
        approval.approvedAt,
      ],
    );
  });
}

export async function commitPackagePublicationTx(
  db: PgDatabaseAdapter,
  params: {
    tenantId: string;
    workspaceId: string;
    actorId: string;
    actorRole: string;
    manifest: ReportingPackageManifest;
    idempotencyKey: string;
    simulateFailureBeforeCommit?: boolean;
  },
): Promise<{ outboxEventId: string }> {
  let outboxEventId: string = randomUUID();
  await withTenantTransaction(
    db,
    params.tenantId,
    async (tx) => {
      // 1. Lock the reporting package row first (FOR UPDATE) so concurrent publishers serialize cleanly (H10)
      const pkgRes = await tx.query<{
        workspace_id: string;
        manifest_digest_sha256: string;
        lifecycle_status: string;
      }>(
        `SELECT workspace_id::text, manifest_digest_sha256, lifecycle_status
         FROM xi_reporting_packages
         WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND package_id = $3 AND package_version = $4
         FOR UPDATE`,
        [params.tenantId, params.workspaceId, params.manifest.packageId, params.manifest.packageVersion],
      );
      const pkgRow = pkgRes.rows[0];
      if (!pkgRow) {
        throw new Error(`Reporting package '${params.manifest.packageId}' v${params.manifest.packageVersion} not staged.`);
      }

      // Check idempotent replay AFTER locking the package row
      const existingOutbox = await tx.query<{ event_id: string }>(
        `SELECT event_id::text
         FROM xi_outbox_events
         WHERE tenant_id = $1::uuid AND idempotency_key = $2`,
        [params.tenantId, params.idempotencyKey],
      );
      if (existingOutbox.rows[0]?.event_id) {
        outboxEventId = existingOutbox.rows[0].event_id;
        return;
      }

      if (pkgRow.lifecycle_status === "published") {
        throw new Error(`Reporting package '${params.manifest.packageId}' v${params.manifest.packageVersion} is already published.`);
      }

      const appRes = await tx.query<{ status: string; manifest_digest_sha256: string }>(
        `SELECT status, manifest_digest_sha256
         FROM xi_package_approvals
         WHERE tenant_id = $1::uuid AND package_id = $2 AND package_version = $3
         ORDER BY approved_at DESC
         LIMIT 1`,
        [params.tenantId, params.manifest.packageId, params.manifest.packageVersion],
      );
      const appRow = appRes.rows[0];
      if (!appRow || appRow.status !== "approved" || appRow.manifest_digest_sha256 !== params.manifest.manifestDigestSha256) {
        throw new Error("Package approval missing, invalidated, or digest mismatch.");
      }

      // 2. Deterministically sort & batch-lock all referenced xi_artifacts in one query to prevent deadlocks & N+1 (H10)
      const sortedRefs = [...params.manifest.artifactRevisions].sort((a, b) =>
        a.artifactId.localeCompare(b.artifactId),
      );
      const artifactIds = Array.from(new Set(sortedRefs.map((r) => r.artifactId)));
      if (artifactIds.length > 0) {
        const artRes = await tx.query<{ artifact_id: string; current_revision: number }>(
          `SELECT artifact_id, current_revision
           FROM xi_artifacts
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND artifact_id = ANY($3::text[])
           ORDER BY artifact_id ASC
           FOR UPDATE`,
          [params.tenantId, params.workspaceId, artifactIds],
        );
        const revByArtifactId = new Map(artRes.rows.map((r) => [r.artifact_id, r.current_revision]));

        for (const ref of sortedRefs) {
          const curRev = revByArtifactId.get(ref.artifactId);
          if (curRev === undefined || curRev < ref.revision) {
            throw new Error(`Expected revision ${ref.revision} for artifact '${ref.artifactId}' missing in DB.`);
          }
          const artUpd = await tx.query(
            `UPDATE xi_artifacts
             SET published_revision = $1, lifecycle_status = 'published', updated_at = $2::timestamptz
             WHERE tenant_id = $3::uuid AND workspace_id = $4::uuid AND artifact_id = $5`,
            [ref.revision, params.manifest.publishedAt, params.tenantId, params.workspaceId, ref.artifactId],
          );
          if (artUpd.rowCount !== 1) {
            throw new Error(`Failed to update artifact '${ref.artifactId}' during package publication.`);
          }
        }
      }

      const pkgUpd = await tx.query(
        `UPDATE xi_reporting_packages
         SET lifecycle_status = 'published', manifest_json = $1::jsonb, published_at = $2::timestamptz
         WHERE tenant_id = $3::uuid AND workspace_id = $4::uuid AND package_id = $5 AND package_version = $6 AND lifecycle_status <> 'published'`,
        [
          JSON.stringify(params.manifest),
          params.manifest.publishedAt,
          params.tenantId,
          params.workspaceId,
          params.manifest.packageId,
          params.manifest.packageVersion,
        ],
      );
      if (pkgUpd.rowCount !== 1) {
        throw new Error(`Concurrent publication conflict for package '${params.manifest.packageId}' v${params.manifest.packageVersion}.`);
      }

      if (params.simulateFailureBeforeCommit) {
        throw new Error("SIMULATED_PUBLICATION_COMMIT_FAILURE");
      }

      await tx.query(
        `INSERT INTO audit_logs
          (audit_id, tenant_id, workspace_id, actor_id, actor_role, source, action, outcome, target_type, target_id, revision_after, summary)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'system', 'reporting_package.published', 'success', 'reporting_package', $6, $7, $8)`,
        [
          randomUUID(),
          params.tenantId,
          params.workspaceId,
          params.actorId,
          params.actorRole,
          params.manifest.packageId,
          params.manifest.packageVersion,
          `Atomically published reporting package '${params.manifest.title}' v${params.manifest.packageVersion}.`,
        ],
      );

      await tx.query(
        `INSERT INTO xi_outbox_events
          (tenant_id, event_id, event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, status)
         VALUES ($1::uuid, $2::uuid, 'reporting_package.published', 'reporting_package', $3, $4::jsonb, $5, 'pending')
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [
          params.tenantId,
          outboxEventId,
          params.manifest.packageId,
          JSON.stringify({
            packageId: params.manifest.packageId,
            packageVersion: params.manifest.packageVersion,
            manifestDigestSha256: params.manifest.manifestDigestSha256,
          }),
          params.idempotencyKey,
        ],
      );
    },
    params.workspaceId,
  );

  return { outboxEventId };
}

export async function getPackageLifecycleRow(
  db: PgDatabaseAdapter,
  tenantId: string,
  packageId: string,
  packageVersion: number,
  workspaceId?: string,
): Promise<{ lifecycle_status: string; published_at: string | null } | null> {
  return withTenantTransaction(
    db,
    tenantId,
    async (tx) => {
      const res = workspaceId
        ? await tx.query<{ lifecycle_status: string; published_at: string | null }>(
            `SELECT lifecycle_status, published_at::text
             FROM xi_reporting_packages
             WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND package_id = $3 AND package_version = $4`,
            [tenantId, workspaceId, packageId, packageVersion],
          )
        : await tx.query<{ lifecycle_status: string; published_at: string | null }>(
            `SELECT lifecycle_status, published_at::text
             FROM xi_reporting_packages
             WHERE tenant_id = $1::uuid AND package_id = $2 AND package_version = $3`,
            [tenantId, packageId, packageVersion],
          );
      return res.rows[0] ?? null;
    },
    workspaceId,
  );
}

export async function listOutboxEventsForTenant(
  db: PgDatabaseAdapter,
  tenantId: string,
): Promise<Array<{ event_id: string; event_type: string; aggregate_id: string; status: string }>> {
  return withTenantTransaction(db, tenantId, async (tx) => {
    const res = await tx.query<{ event_id: string; event_type: string; aggregate_id: string; status: string }>(
      `SELECT event_id::text, event_type, aggregate_id, status
       FROM xi_outbox_events
       WHERE tenant_id = $1::uuid
       ORDER BY created_at ASC`,
      [tenantId],
    );
    return res.rows;
  });
}
