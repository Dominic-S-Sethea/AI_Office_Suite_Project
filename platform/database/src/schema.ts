import type { PgDatabaseAdapter, PgQueryExecutor } from "./adapter.ts";

export const D2_POSTGRESQL_SCHEMA_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS organizations (
  tenant_id   UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  user_id        UUID PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  token_version  INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deleted')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id   UUID NOT NULL REFERENCES organizations(tenant_id),
  workspace_id UUID NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(user_id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'editor', 'reviewer', 'viewer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  tenant_id     UUID NOT NULL REFERENCES organizations(tenant_id),
  workspace_id  UUID NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS documents (
  tenant_id             UUID NOT NULL,
  workspace_id          UUID NOT NULL,
  document_id           UUID NOT NULL,
  title                 TEXT NOT NULL,
  language              TEXT NOT NULL CHECK (language IN ('en', 'km', 'bilingual')),
  current_revision      INTEGER NOT NULL CHECK (current_revision >= 1),
  published_revision    INTEGER NULL,
  status                TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'approved')),
  created_by            UUID NOT NULL REFERENCES users(user_id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  tenant_id               UUID NOT NULL,
  document_id             UUID NOT NULL,
  revision                INTEGER NOT NULL CHECK (revision >= 1),
  storage_object_key      TEXT NOT NULL,
  content_sha256          CHAR(64) NOT NULL,
  source_import_sha256    CHAR(64) NULL,
  restored_from_revision  INTEGER NULL,
  snapshot_json           JSONB NOT NULL,
  created_by              UUID NOT NULL REFERENCES users(user_id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, revision),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, document_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id          UUID NOT NULL,
  idempotency_key    TEXT NOT NULL,
  operation_scope    TEXT NOT NULL,
  request_hash       CHAR(64) NOT NULL,
  response_json      JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, operation_scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id         UUID PRIMARY KEY,
  tenant_id        UUID NOT NULL,
  workspace_id     UUID NULL,
  actor_id         UUID NOT NULL,
  actor_role       TEXT NOT NULL,
  source           TEXT NOT NULL,
  action           TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
  target_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  revision_before  INTEGER NULL,
  revision_after   INTEGER NULL,
  summary          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_applied_operations (
  tenant_id        UUID NOT NULL,
  workspace_id     UUID NOT NULL,
  document_id      UUID NOT NULL,
  operation_id     TEXT NOT NULL,
  result_revision  INTEGER NOT NULL CHECK (result_revision >= 1),
  actor_id         UUID NOT NULL REFERENCES users(user_id),
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, document_id, operation_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, document_id)
);

CREATE TABLE IF NOT EXISTS migration_batches (
  batch_id           UUID PRIMARY KEY,
  target_tenant_id   UUID NOT NULL REFERENCES organizations(tenant_id),
  target_workspace_id UUID NOT NULL,
  source_dir         TEXT NOT NULL,
  manifest_json      JSONB NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolled_back_at     TIMESTAMPTZ NULL
);

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON organizations, users, memberships, workspaces, documents, idempotency_keys TO app_runtime;
GRANT SELECT, INSERT ON document_versions, audit_logs, ai_applied_operations TO app_runtime;
REVOKE UPDATE, DELETE ON audit_logs FROM app_runtime;
REVOKE UPDATE, DELETE ON document_versions FROM app_runtime;
REVOKE UPDATE, DELETE ON ai_applied_operations FROM app_runtime;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_workspaces ON workspaces;
CREATE POLICY tenant_isolation_workspaces ON workspaces
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_documents ON documents;
CREATE POLICY tenant_isolation_documents ON documents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_document_versions ON document_versions;
CREATE POLICY tenant_isolation_document_versions ON document_versions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_idempotency_keys ON idempotency_keys;
CREATE POLICY tenant_isolation_idempotency_keys ON idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_audit_logs ON audit_logs;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE ai_applied_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_applied_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_applied_operations ON ai_applied_operations;
CREATE POLICY tenant_isolation_ai_applied_operations ON ai_applied_operations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
`;

export async function initializePostgreSqlSchema(db: PgDatabaseAdapter): Promise<void> {
  await db.exec(D2_POSTGRESQL_SCHEMA_SQL);
}

const SAFE_PG_ROLE_IDENT = /^[a-z_][a-z0-9_]{1,62}$/;

/**
 * Provisions or updates a dedicated non-superuser, NOBYPASSRLS login role granted `app_runtime`.
 * Intended to be run by the out-of-band migration/admin principal so runtime API containers
 * never connect to PostgreSQL as a superuser or table owner.
 */
export async function provisionAppRuntimeLoginRole(
  db: PgDatabaseAdapter,
  params: { roleName: string; password: string },
): Promise<void> {
  const roleName = params.roleName.trim();
  if (!SAFE_PG_ROLE_IDENT.test(roleName) || roleName === "postgres" || roleName === "app_runtime") {
    throw new Error(`Invalid least-privilege login role name '${roleName}'.`);
  }
  if (!params.password || params.password.length < 12) {
    throw new Error("App runtime login role password must be at least 12 characters.");
  }

  await db.withTransaction(async (tx) => {
    await tx.query("SELECT set_config('app.provision_role', $1, true)", [roleName]);
    await tx.query("SELECT set_config('app.provision_pw', $1, true)", [params.password]);
    await tx.exec(`
      DO $$
      DECLARE
        r_name TEXT := current_setting('app.provision_role');
        r_pw   TEXT := current_setting('app.provision_pw');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r_name) THEN
          EXECUTE format(
            'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
            r_name,
            r_pw
          );
        ELSE
          EXECUTE format(
            'ALTER ROLE %I LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
            r_name,
            r_pw
          );
        END IF;
        EXECUTE format('GRANT app_runtime TO %I', r_name);
      END
      $$;
    `);
  });
}

export interface DatabaseReadinessReport {
  ready: boolean;
  engine: "pglite" | "node-pg";
  checks: {
    connectivity: boolean;
    appRuntimeLeastPrivilege: boolean;
    currentConnectionLeastPrivilege: boolean;
    coreForceRlsEnabled: boolean;
    missingForceRlsTables: string[];
  };
}

const CORE_RLS_TABLES = [
  "workspaces",
  "documents",
  "document_versions",
  "idempotency_keys",
  "audit_logs",
  "ai_applied_operations",
] as const;

export async function verifyDatabaseRlsReadiness(
  db: PgDatabaseAdapter,
  options: { requireNonSuperuserConnection?: boolean } = {},
): Promise<DatabaseReadinessReport> {
  let connectivity = false;
  let appRuntimeLeastPrivilege = false;
  let currentConnectionLeastPrivilege = false;
  let coreForceRlsEnabled = false;
  let missingForceRlsTables: string[] = [...CORE_RLS_TABLES];

  try {
    const ping = await db.query<{ ok: number }>("SELECT 1 AS ok");
    connectivity = ping.rows[0]?.ok === 1;

    const roleRes = await db.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; is_current: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls, (rolname = current_user) AS is_current
       FROM pg_roles
       WHERE rolname = 'app_runtime' OR rolname = current_user`,
    );
    const appRoleRow = roleRes.rows.find((r) => r.rolname === "app_runtime");
    const curRoleRow = roleRes.rows.find((r) => r.is_current);
    appRuntimeLeastPrivilege = Boolean(appRoleRow && appRoleRow.rolsuper === false && appRoleRow.rolbypassrls === false);
    currentConnectionLeastPrivilege = Boolean(
      curRoleRow && curRoleRow.rolsuper === false && curRoleRow.rolbypassrls === false,
    );

    const rlsRes = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [Array.from(CORE_RLS_TABLES)],
    );
    const okSet = new Set(
      rlsRes.rows
        .filter((r) => r.relrowsecurity === true && r.relforcerowsecurity === true)
        .map((r) => r.relname),
    );
    missingForceRlsTables = CORE_RLS_TABLES.filter((t) => !okSet.has(t));
    coreForceRlsEnabled = missingForceRlsTables.length === 0;
  } catch {
    connectivity = false;
  }

  const connectionPrivilegeOk = options.requireNonSuperuserConnection ? currentConnectionLeastPrivilege : true;

  return {
    ready: connectivity && appRuntimeLeastPrivilege && connectionPrivilegeOk && coreForceRlsEnabled,
    engine: db.engine,
    checks: {
      connectivity,
      appRuntimeLeastPrivilege,
      currentConnectionLeastPrivilege,
      coreForceRlsEnabled,
      missingForceRlsTables,
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executes queries inside an explicit transaction using the least-privilege non-superuser
 * role `app_runtime` and setting `app.current_tenant_id` locally for fail-closed RLS.
 */
export async function withTenantTransaction<T>(
  db: PgDatabaseAdapter,
  tenantId: string | null,
  fn: (tx: PgQueryExecutor) => Promise<T>,
): Promise<T> {
  if (tenantId !== null && !UUID_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenant UUID '${tenantId}' for PostgreSQL RLS context.`);
  }
  return db.withTransaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_runtime");
    if (tenantId !== null) {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    } else {
      await tx.query("SELECT set_config('app.current_tenant_id', '', true)");
    }
    return fn(tx);
  });
}
