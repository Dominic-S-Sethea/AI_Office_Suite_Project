import type { PgDatabaseAdapter, PgQueryExecutor } from "./adapter.ts";

export const CORE_SCHEMA_VERSION = "2026.11.v2.2-core";
const CORE_SCHEMA_LOCK_KEY = 84102001;

export const D2_POSTGRESQL_SCHEMA_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS workspaces (
  tenant_id     UUID NOT NULL REFERENCES organizations(tenant_id),
  workspace_id  UUID NOT NULL,
  name          TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'standard' CHECK (visibility IN ('standard', 'restricted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id)
);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'standard';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_visibility_check'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_visibility_check CHECK (visibility IN ('standard', 'restricted'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id        UUID NOT NULL REFERENCES organizations(tenant_id),
  workspace_id     UUID NOT NULL,
  user_id          UUID NOT NULL REFERENCES users(user_id),
  role             TEXT NOT NULL CHECK (role IN (
    'owner',
    'administrator',
    'workspace_manager',
    'billing_admin',
    'auditor',
    'editor',
    'reviewer',
    'viewer'
  )),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  content_access   BOOLEAN NOT NULL DEFAULT true,
  revocation_epoch INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, user_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS content_access BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS revocation_epoch INTEGER NOT NULL DEFAULT 1;
DO $$
DECLARE
  c_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memberships_status_check'
  ) THEN
    ALTER TABLE memberships
      ADD CONSTRAINT memberships_status_check CHECK (status IN ('active', 'suspended', 'revoked'));
  END IF;

  FOR c_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'memberships'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT IF EXISTS %I', c_name);
  END LOOP;

  ALTER TABLE memberships
    ADD CONSTRAINT memberships_role_check
    CHECK (role IN (
      'owner',
      'administrator',
      'workspace_manager',
      'billing_admin',
      'auditor',
      'editor',
      'reviewer',
      'viewer'
    ));
END
$$;

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
  source                  TEXT NOT NULL DEFAULT 'manual',
  summary                 TEXT NOT NULL DEFAULT '',
  snapshot_json           JSONB NOT NULL,
  created_by              UUID NOT NULL REFERENCES users(user_id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, revision),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, document_id)
);

ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';

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
  metadata         JSONB NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB NULL;

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
  batch_id            UUID PRIMARY KEY,
  target_tenant_id    UUID NOT NULL REFERENCES organizations(tenant_id),
  target_workspace_id UUID NOT NULL,
  source_dir          TEXT NOT NULL,
  manifest_json       JSONB NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolled_back_at      TIMESTAMPTZ NULL,
  FOREIGN KEY (target_tenant_id, target_workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

-- Secondary & case-insensitive unique indexes (H6)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id, tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS documents_tenant_ws_updated_idx ON documents (tenant_id, workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS documents_tenant_ws_lang_idx ON documents (tenant_id, workspace_id, language);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_ws_target_created_idx ON audit_logs (tenant_id, workspace_id, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_applied_ops_doc_idx ON ai_applied_operations (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx ON idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS revoked_session_tokens (
  jti         TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(user_id),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revoked_session_tokens_expires_idx ON revoked_session_tokens (expires_at);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket_key    TEXT PRIMARY KEY,
  window_start  TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS api_rate_limits_expires_idx ON api_rate_limits (expires_at);

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON organizations, memberships, workspaces, documents, idempotency_keys TO app_runtime;
REVOKE ALL ON TABLE users FROM app_runtime;
REVOKE ALL ON TABLE revoked_session_tokens FROM app_runtime;
REVOKE ALL ON TABLE api_rate_limits FROM app_runtime;
GRANT SELECT (user_id, email, token_version, status, created_at) ON users TO app_runtime;
GRANT DELETE ON idempotency_keys TO app_runtime;
GRANT SELECT, INSERT ON document_versions, audit_logs, ai_applied_operations TO app_runtime;
REVOKE UPDATE, DELETE ON audit_logs FROM app_runtime;
REVOKE UPDATE, DELETE ON document_versions FROM app_runtime;
REVOKE UPDATE, DELETE ON ai_applied_operations FROM app_runtime;

-- Narrow SECURITY DEFINER identity routines so app_runtime never reads users.password_hash directly (F-04)
CREATE OR REPLACE FUNCTION auth_lookup_user_for_login(p_email TEXT)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  password_hash TEXT,
  token_version INTEGER,
  status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.user_id, u.email, u.password_hash, u.token_version, u.status
  FROM public.users u
  WHERE lower(u.email) = lower(trim(p_email))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION auth_lookup_user_for_login(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user_for_login(TEXT) TO app_runtime;

CREATE OR REPLACE FUNCTION auth_bump_user_token_version(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.users
  SET token_version = token_version + 1
  WHERE user_id = p_user_id
  RETURNING token_version;
$$;

REVOKE ALL ON FUNCTION auth_bump_user_token_version(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_bump_user_token_version(UUID) TO app_runtime;

CREATE OR REPLACE FUNCTION auth_count_other_active_tenant_memberships(
  p_user_id UUID,
  p_excluded_tenant_id UUID
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.memberships m
  WHERE m.user_id = p_user_id
    AND m.tenant_id <> p_excluded_tenant_id
    AND m.status = 'active';
$$;

REVOKE ALL ON FUNCTION auth_count_other_active_tenant_memberships(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_count_other_active_tenant_memberships(UUID, UUID) TO app_runtime;

CREATE OR REPLACE FUNCTION auth_revoke_session_jti(
  p_jti TEXT,
  p_user_id UUID,
  p_expires_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH pruned AS (
    DELETE FROM public.revoked_session_tokens WHERE expires_at <= now()
  )
  INSERT INTO public.revoked_session_tokens (jti, user_id, expires_at)
  VALUES (p_jti, p_user_id, COALESCE(p_expires_at, now() + interval '12 hours'))
  ON CONFLICT (jti) DO NOTHING
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION auth_revoke_session_jti(TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_revoke_session_jti(TEXT, UUID, TIMESTAMPTZ) TO app_runtime;

CREATE OR REPLACE FUNCTION auth_is_session_jti_revoked(p_jti TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.revoked_session_tokens r
    WHERE r.jti = p_jti
      AND r.expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION auth_is_session_jti_revoked(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_is_session_jti_revoked(TEXT) TO app_runtime;

CREATE OR REPLACE FUNCTION rate_limit_check_and_increment(
  p_key TEXT,
  p_window_ms INTEGER,
  p_max_requests INTEGER
)
RETURNS TABLE (
  allowed BOOLEAN,
  current_count INTEGER,
  retry_after_ms INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH params AS (
    SELECT
      left(COALESCE(NULLIF(p_key, ''), 'unknown'), 256) AS k,
      GREATEST(1000, COALESCE(p_window_ms, 60000)) AS win_ms,
      GREATEST(1, COALESCE(p_max_requests, 1)) AS max_req,
      clock_timestamp() AS ts
  ),
  upserted AS (
    INSERT INTO public.api_rate_limits (bucket_key, window_start, request_count, expires_at)
    SELECT
      p.k,
      p.ts,
      1,
      p.ts + (p.win_ms * interval '1 millisecond')
    FROM params p
    ON CONFLICT (bucket_key) DO UPDATE
    SET
      window_start = CASE
        WHEN public.api_rate_limits.expires_at <= EXCLUDED.window_start
          THEN EXCLUDED.window_start
        ELSE public.api_rate_limits.window_start
      END,
      expires_at = CASE
        WHEN public.api_rate_limits.expires_at <= EXCLUDED.window_start
          THEN EXCLUDED.expires_at
        ELSE public.api_rate_limits.expires_at
      END,
      request_count = CASE
        WHEN public.api_rate_limits.expires_at <= EXCLUDED.window_start
          THEN 1
        WHEN public.api_rate_limits.request_count > GREATEST(1, COALESCE(p_max_requests, 1))
          THEN public.api_rate_limits.request_count
        ELSE public.api_rate_limits.request_count + 1
      END
    RETURNING request_count, expires_at
  )
  SELECT
    (u.request_count <= p.max_req) AS allowed,
    LEAST(u.request_count, p.max_req)::INTEGER AS current_count,
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (u.expires_at - p.ts)) * 1000))::INTEGER AS retry_after_ms
  FROM upserted u
  CROSS JOIN params p;
$$;

REVOKE ALL ON FUNCTION rate_limit_check_and_increment(TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_check_and_increment(TEXT, INTEGER, INTEGER) TO app_runtime;

CREATE OR REPLACE FUNCTION rate_limit_prune_expired(p_limit INTEGER DEFAULT 500)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH victim AS (
    SELECT bucket_key
    FROM public.api_rate_limits
    WHERE expires_at <= clock_timestamp()
    ORDER BY expires_at ASC
    LIMIT GREATEST(1, LEAST(5000, COALESCE(p_limit, 500)))
  ),
  deleted AS (
    DELETE FROM public.api_rate_limits t
    USING victim v
    WHERE t.bucket_key = v.bucket_key
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM deleted;
$$;

REVOKE ALL ON FUNCTION rate_limit_prune_expired(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_prune_expired(INTEGER) TO app_runtime;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_organizations ON organizations;
CREATE POLICY tenant_isolation_organizations ON organizations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_memberships ON memberships;
CREATE POLICY tenant_isolation_memberships ON memberships
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

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_workspaces ON workspaces;
CREATE POLICY tenant_isolation_workspaces ON workspaces
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

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_documents ON documents;
CREATE POLICY tenant_isolation_documents ON documents
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

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_document_versions ON document_versions;
CREATE POLICY tenant_isolation_document_versions ON document_versions
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM documents d
        WHERE d.tenant_id = document_versions.tenant_id
          AND d.document_id = document_versions.document_id
          AND d.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
      )
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM documents d
        WHERE d.tenant_id = document_versions.tenant_id
          AND d.document_id = document_versions.document_id
          AND d.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
      )
    )
  );

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

ALTER TABLE ai_applied_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_applied_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_applied_operations ON ai_applied_operations;
CREATE POLICY tenant_isolation_ai_applied_operations ON ai_applied_operations
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
`;

export async function initializePostgreSqlSchema(
  db: PgDatabaseAdapter,
  options: { force?: boolean } = {},
): Promise<{ applied: boolean; version: string }> {
  return db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [CORE_SCHEMA_LOCK_KEY]);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    if (!options.force) {
      const existing = await tx.query<{
        version: string;
        core_present: boolean;
        membership_cols_present: boolean;
        auth_fn_present: boolean;
      }>(
        `SELECT version,
                (
                  to_regclass('public.organizations') IS NOT NULL
                  AND to_regclass('public.revoked_session_tokens') IS NOT NULL
                  AND to_regclass('public.api_rate_limits') IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'visibility'
                  )
                ) AS core_present,
                (
                  EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'status'
                  )
                  AND EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'content_access'
                  )
                  AND EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'revocation_epoch'
                  )
                ) AS membership_cols_present,
                (
                  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_lookup_user_for_login')
                  AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_is_session_jti_revoked')
                  AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_count_other_active_tenant_memberships')
                  AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rate_limit_check_and_increment')
                ) AS auth_fn_present
         FROM schema_migrations
         WHERE version = $1`,
        [CORE_SCHEMA_VERSION],
      );
      if (
        existing.rows.length > 0 &&
        existing.rows[0]?.core_present &&
        existing.rows[0]?.membership_cols_present &&
        existing.rows[0]?.auth_fn_present
      ) {
        return { applied: false, version: CORE_SCHEMA_VERSION };
      }
    }
    await tx.exec(D2_POSTGRESQL_SCHEMA_SQL);
    await tx.query(
      "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
      [CORE_SCHEMA_VERSION],
    );
    return { applied: true, version: CORE_SCHEMA_VERSION };
  });
}

/**
 * Removes expired rows from `idempotency_keys` (M7).
 * Requires either an explicit `tenantId` (enforced under RLS) or a role with `rolsuper` / `rolbypassrls`
 * so cross-tenant cleanup never silently deletes 0 rows under restricted `app_runtime`.
 */
export async function purgeExpiredIdempotencyKeys(
  db: PgDatabaseAdapter,
  options?: { tenantId?: string },
): Promise<number> {
  if (options?.tenantId) {
    return withTenantTransaction(db, options.tenantId, async (tx) => {
      const res = await tx.query("DELETE FROM idempotency_keys WHERE expires_at < now()");
      return res.rowCount;
    });
  }
  const privRes = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const priv = privRes.rows[0];
  if (priv && !priv.rolsuper && !priv.rolbypassrls) {
    throw new Error(
      "PURGE_REQUIRES_TENANT_OR_BYPASSRLS: purgeExpiredIdempotencyKeys without tenantId requires BYPASSRLS/superuser role.",
    );
  }
  const res = await db.query("DELETE FROM idempotency_keys WHERE expires_at < now()");
  return res.rowCount;
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
        PERFORM set_config('app.provision_role', '', true);
        PERFORM set_config('app.provision_pw', '', true);
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
    usersPasswordHashIsolated: boolean;
    coreForceRlsEnabled: boolean;
    missingForceRlsTables: string[];
  };
}

const CORE_RLS_TABLES = [
  "organizations",
  "memberships",
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
  let usersPasswordHashIsolated = false;
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

    const privRes = await db.query<{
      can_read_pw_hash: boolean;
      can_update_users: boolean;
      can_access_revoked_jti: boolean;
      can_access_rate_limits: boolean;
    }>(
      `SELECT
         has_column_privilege('app_runtime', 'public.users', 'password_hash', 'SELECT') AS can_read_pw_hash,
         has_table_privilege('app_runtime', 'public.users', 'UPDATE') AS can_update_users,
         CASE WHEN to_regclass('public.revoked_session_tokens') IS NOT NULL
           THEN has_table_privilege('app_runtime', 'public.revoked_session_tokens', 'SELECT,INSERT,UPDATE,DELETE')
           ELSE false
         END AS can_access_revoked_jti,
         CASE WHEN to_regclass('public.api_rate_limits') IS NOT NULL
           THEN has_table_privilege('app_runtime', 'public.api_rate_limits', 'SELECT,INSERT,UPDATE,DELETE')
           ELSE false
         END AS can_access_rate_limits`,
    );
    const privRow = privRes.rows[0];
    usersPasswordHashIsolated = Boolean(
      privRow &&
        !privRow.can_read_pw_hash &&
        !privRow.can_update_users &&
        !privRow.can_access_revoked_jti &&
        !privRow.can_access_rate_limits,
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
    ready:
      connectivity &&
      appRuntimeLeastPrivilege &&
      connectionPrivilegeOk &&
      usersPasswordHashIsolated &&
      coreForceRlsEnabled,
    engine: db.engine,
    checks: {
      connectivity,
      appRuntimeLeastPrivilege,
      currentConnectionLeastPrivilege,
      usersPasswordHashIsolated,
      coreForceRlsEnabled,
      missingForceRlsTables,
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executes queries inside an explicit transaction using the least-privilege non-superuser
 * role `app_runtime` and setting `app.current_tenant_id` (and optionally `app.current_workspace_id`)
 * locally for fail-closed tenant + workspace RLS.
 */
export async function withTenantTransaction<T>(
  db: PgDatabaseAdapter,
  tenantId: string | null,
  fn: (tx: PgQueryExecutor) => Promise<T>,
  workspaceId?: string | null,
): Promise<T> {
  if (tenantId !== null && !UUID_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenant UUID '${tenantId}' for PostgreSQL RLS context.`);
  }
  if (workspaceId !== undefined && workspaceId !== null && !UUID_PATTERN.test(workspaceId)) {
    throw new Error(`Invalid workspace UUID '${workspaceId}' for PostgreSQL RLS context.`);
  }
  return db.withTransaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_runtime");
    if (tenantId !== null) {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    } else {
      await tx.query("SELECT set_config('app.current_tenant_id', '', true)");
    }
    if (workspaceId) {
      await tx.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    } else {
      await tx.query("SELECT set_config('app.current_workspace_id', '', true)");
    }
    return fn(tx);
  });
}

export interface PgRateLimitDecision {
  allowed: boolean;
  currentCount: number;
  retryAfterMs: number;
}

/**
 * Atomically checks and increments a sliding-window rate-limit counter in PostgreSQL
 * via the least-privilege SECURITY DEFINER routine `rate_limit_check_and_increment`.
 */
export async function checkAndIncrementPgRateLimit(
  db: PgDatabaseAdapter,
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<PgRateLimitDecision> {
  const safeWindowMs = Math.max(1_000, Math.min(86_400_000, Math.trunc(windowMs)));
  const safeMax = Math.max(1, Math.min(1_000_000, Math.trunc(maxRequests)));
  const res = await db.query<{
    allowed: boolean;
    current_count: number;
    retry_after_ms: number;
  }>(
    "SELECT allowed, current_count, retry_after_ms FROM rate_limit_check_and_increment($1, $2, $3)",
    [key.slice(0, 256), safeWindowMs, safeMax],
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error("PG_RATE_LIMIT_EMPTY_RESULT: rate_limit_check_and_increment returned no rows.");
  }
  return {
    allowed: Boolean(row.allowed),
    currentCount: Number(row.current_count),
    retryAfterMs: Math.max(1, Number(row.retry_after_ms)),
  };
}

/**
 * Best-effort bounded cleanup of expired rate-limit buckets via SECURITY DEFINER.
 */
export async function pruneExpiredPgRateLimits(
  db: PgDatabaseAdapter,
  maxRows = 500,
): Promise<number> {
  const clamped = Math.max(1, Math.min(5_000, Math.trunc(maxRows)));
  const res = await db.query<{ deleted_count: number }>(
    "SELECT rate_limit_prune_expired($1) AS deleted_count",
    [clamped],
  );
  return Number(res.rows[0]?.deleted_count ?? 0);
}
