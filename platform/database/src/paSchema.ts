import type { PgDatabaseAdapter } from "./adapter.ts";

export const PA_SCHEMA_VERSION = "2026.11.v3-pa00";
const PA_SCHEMA_LOCK_KEY = 84102003;

export const PA_RLS_TABLES = [
  "pa_invitations",
  "pa_tenant_subscriptions",
  "pa_usage_reservations",
  "pa_usage_ledger",
  "pa_billing_webhooks",
  "pa_file_objects",
  "pa_jobs",
  "pa_ai_policies",
  "pa_voice_policies",
] as const;

export const PA00_GOVERNANCE_SCHEMA_SQL = `
-- Additive PA-00 columns on existing core tables (backward-compatible)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS mfa_required_for_privileged BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'standard';

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

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS content_access BOOLEAN NOT NULL DEFAULT true;

DO $$
DECLARE
  c_name TEXT;
BEGIN
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memberships_status_check'
  ) THEN
    ALTER TABLE memberships
      ADD CONSTRAINT memberships_status_check CHECK (status IN ('active', 'suspended', 'revoked'));
  END IF;
END
$$;

-- 1. Hashed, single-use, expiring invitations (PLT-01)
CREATE TABLE IF NOT EXISTS pa_invitations (
  tenant_id           UUID NOT NULL REFERENCES organizations(tenant_id),
  invitation_id       UUID NOT NULL,
  workspace_id        UUID NOT NULL,
  email               TEXT NOT NULL,
  invited_role        TEXT NOT NULL CHECK (invited_role IN (
    'owner', 'administrator', 'workspace_manager', 'billing_admin', 'auditor', 'editor', 'reviewer', 'viewer'
  )),
  invited_by          UUID NOT NULL REFERENCES users(user_id),
  token_sha256        CHAR(64) NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ NULL,
  revoked_at          TIMESTAMPTZ NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, invitation_id),
  UNIQUE (tenant_id, token_sha256),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

-- 2. Global versioned commercial plan catalog (PLT-06)
CREATE TABLE IF NOT EXISTS pa_plan_versions (
  plan_id             TEXT NOT NULL,
  version             INTEGER NOT NULL CHECK (version >= 1),
  display_name        TEXT NOT NULL,
  entitlements_json   JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, version)
);

-- 3. Tenant subscription & seat/entitlement assignments (PLT-06)
CREATE TABLE IF NOT EXISTS pa_tenant_subscriptions (
  tenant_id           UUID PRIMARY KEY REFERENCES organizations(tenant_id),
  plan_id             TEXT NOT NULL,
  plan_version        INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('active', 'grace', 'past_due', 'suspended', 'canceled')),
  seat_limit          INTEGER NOT NULL CHECK (seat_limit >= 1),
  entitlements_json   JSONB NOT NULL,
  policy_version      INTEGER NOT NULL DEFAULT 1,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, plan_version) REFERENCES pa_plan_versions(plan_id, version)
);

-- 4. Atomic quota reservations (estimate -> reserve -> settle/release)
CREATE TABLE IF NOT EXISTS pa_usage_reservations (
  tenant_id           UUID NOT NULL REFERENCES organizations(tenant_id),
  reservation_id      UUID NOT NULL,
  workspace_id        UUID NOT NULL,
  actor_id            UUID NOT NULL REFERENCES users(user_id),
  dimension           TEXT NOT NULL CHECK (dimension IN (
    'ai_tokens', 'ai_requests', 'voice_seconds', 'storage_bytes', 'concurrent_jobs', 'seats'
  )),
  period_key          TEXT NOT NULL,
  reserved_units      BIGINT NOT NULL CHECK (reserved_units >= 0),
  settled_units       BIGINT NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  status              TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  idempotency_key     TEXT NOT NULL,
  correlation_id      TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reservation_id),
  UNIQUE (tenant_id, idempotency_key)
);

-- 5. Append-only metered usage ledger (REVOKE UPDATE, DELETE from app_runtime)
CREATE TABLE IF NOT EXISTS pa_usage_ledger (
  tenant_id                UUID NOT NULL REFERENCES organizations(tenant_id),
  ledger_id                UUID NOT NULL,
  workspace_id             UUID NOT NULL,
  actor_id                 UUID NOT NULL REFERENCES users(user_id),
  source                   TEXT NOT NULL,
  dimension                TEXT NOT NULL CHECK (dimension IN (
    'ai_tokens', 'ai_requests', 'voice_seconds', 'storage_bytes', 'concurrent_jobs', 'seats'
  )),
  units                    BIGINT NOT NULL CHECK (units >= 0),
  estimated_cost_microusd  BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_microusd >= 0),
  provider_id              TEXT NULL,
  model_id                 TEXT NULL,
  correlation_id           TEXT NOT NULL,
  reservation_id           UUID NULL,
  is_mock                  BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ledger_id)
);

-- 6. Idempotent signed billing webhook ledger (mock fixtures only in PA-00)
CREATE TABLE IF NOT EXISTS pa_billing_webhooks (
  tenant_id           UUID NOT NULL REFERENCES organizations(tenant_id),
  provider_event_id   TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  signature_verified  BOOLEAN NOT NULL,
  payload_sha256      CHAR(64) NOT NULL,
  processed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_event_id)
);

-- 7. Private versioned file metadata, quarantine, retention & legal hold (PLT-03)
CREATE TABLE IF NOT EXISTS pa_file_objects (
  tenant_id           UUID NOT NULL REFERENCES organizations(tenant_id),
  workspace_id        UUID NOT NULL,
  object_id           TEXT NOT NULL,
  version             INTEGER NOT NULL CHECK (version >= 1),
  storage_key         TEXT NOT NULL,
  filename            TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  byte_size           BIGINT NOT NULL CHECK (byte_size >= 0),
  sha256              CHAR(64) NOT NULL,
  classification      TEXT NOT NULL CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  quarantine_state    TEXT NOT NULL CHECK (quarantine_state IN ('pending_scan', 'clean', 'quarantined')),
  legal_hold          BOOLEAN NOT NULL DEFAULT false,
  retention_until     TIMESTAMPTZ NULL,
  deleted_at          TIMESTAMPTZ NULL,
  created_by          UUID NOT NULL REFERENCES users(user_id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id, version),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

-- 8. Durable fenced-lease background job queue (PLT-05)
CREATE TABLE IF NOT EXISTS pa_jobs (
  tenant_id            UUID NOT NULL REFERENCES organizations(tenant_id),
  job_id               UUID NOT NULL,
  workspace_id         UUID NOT NULL,
  actor_id             UUID NOT NULL REFERENCES users(user_id),
  job_type             TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'canceled', 'dead_letter')),
  payload_json         JSONB NOT NULL,
  result_json          JSONB NULL,
  error_json           JSONB NULL,
  lease_token          TEXT NULL,
  fencing_generation   INTEGER NOT NULL DEFAULT 0,
  worker_id            TEXT NULL,
  lease_expires_at     TIMESTAMPTZ NULL,
  heartbeat_at         TIMESTAMPTZ NULL,
  cancel_requested_at  TIMESTAMPTZ NULL,
  attempt              INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  reservation_id       UUID NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

-- 9. Tenant AI & Voice governance policies (PLT-04)
CREATE TABLE IF NOT EXISTS pa_ai_policies (
  tenant_id       UUID PRIMARY KEY REFERENCES organizations(tenant_id),
  policy_version  INTEGER NOT NULL DEFAULT 1,
  policy_json     JSONB NOT NULL,
  updated_by      UUID NOT NULL REFERENCES users(user_id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pa_voice_policies (
  tenant_id       UUID PRIMARY KEY REFERENCES organizations(tenant_id),
  policy_version  INTEGER NOT NULL DEFAULT 1,
  policy_json     JSONB NOT NULL,
  updated_by      UUID NOT NULL REFERENCES users(user_id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Secondary indexes
CREATE INDEX IF NOT EXISTS pa_invitations_email_idx ON pa_invitations (tenant_id, lower(email), status);
CREATE INDEX IF NOT EXISTS pa_usage_res_period_idx ON pa_usage_reservations (tenant_id, dimension, period_key, status);
CREATE INDEX IF NOT EXISTS pa_usage_ledger_created_idx ON pa_usage_ledger (tenant_id, dimension, created_at DESC);
CREATE INDEX IF NOT EXISTS pa_file_objects_ws_idx ON pa_file_objects (tenant_id, workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS pa_jobs_state_lease_idx ON pa_jobs (tenant_id, state, lease_expires_at);

-- Least-privilege grants to app_runtime
GRANT SELECT ON pa_plan_versions TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON
  pa_invitations,
  pa_tenant_subscriptions,
  pa_usage_reservations,
  pa_billing_webhooks,
  pa_file_objects,
  pa_jobs,
  pa_ai_policies,
  pa_voice_policies
  TO app_runtime;
GRANT DELETE ON pa_file_objects TO app_runtime;
GRANT SELECT, INSERT ON pa_usage_ledger TO app_runtime;
REVOKE UPDATE, DELETE ON pa_usage_ledger FROM app_runtime;

-- Strict FORCE ROW LEVEL SECURITY on all PA-00 tenant tables
ALTER TABLE pa_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_invitations ON pa_invitations;
CREATE POLICY tenant_isolation_pa_invitations ON pa_invitations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE pa_tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_tenant_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_tenant_subscriptions ON pa_tenant_subscriptions;
CREATE POLICY tenant_isolation_pa_tenant_subscriptions ON pa_tenant_subscriptions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE pa_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_usage_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_usage_reservations ON pa_usage_reservations;
CREATE POLICY tenant_isolation_pa_usage_reservations ON pa_usage_reservations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE pa_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_usage_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_usage_ledger ON pa_usage_ledger;
CREATE POLICY tenant_isolation_pa_usage_ledger ON pa_usage_ledger
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE pa_billing_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_billing_webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_billing_webhooks ON pa_billing_webhooks;
CREATE POLICY tenant_isolation_pa_billing_webhooks ON pa_billing_webhooks
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE pa_file_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_file_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_file_objects ON pa_file_objects;
CREATE POLICY tenant_isolation_pa_file_objects ON pa_file_objects
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

ALTER TABLE pa_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_jobs ON pa_jobs;
CREATE POLICY tenant_isolation_pa_jobs ON pa_jobs
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

ALTER TABLE pa_ai_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_ai_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_ai_policies ON pa_ai_policies;
CREATE POLICY tenant_isolation_pa_ai_policies ON pa_ai_policies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE pa_voice_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pa_voice_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pa_voice_policies ON pa_voice_policies;
CREATE POLICY tenant_isolation_pa_voice_policies ON pa_voice_policies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
`;

export async function initializePaGovernanceSchema(
  db: PgDatabaseAdapter,
  options: { force?: boolean } = {},
): Promise<{ applied: boolean; version: string }> {
  return db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [PA_SCHEMA_LOCK_KEY]);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    if (!options.force) {
      const existing = await tx.query<{ version: string; pa_present: boolean }>(
        "SELECT version, (to_regclass('public.pa_jobs') IS NOT NULL) AS pa_present FROM schema_migrations WHERE version = $1",
        [PA_SCHEMA_VERSION],
      );
      if (existing.rows.length > 0 && existing.rows[0]?.pa_present) {
        return { applied: false, version: PA_SCHEMA_VERSION };
      }
    }
    await tx.exec(PA00_GOVERNANCE_SCHEMA_SQL);
    await tx.query(
      "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
      [PA_SCHEMA_VERSION],
    );
    return { applied: true, version: PA_SCHEMA_VERSION };
  });
}

export async function verifyPaRlsReadiness(db: PgDatabaseAdapter): Promise<{
  paForceRlsEnabled: boolean;
  missingTables: string[];
}> {
  const res = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [Array.from(PA_RLS_TABLES)],
  );
  const ok = new Set(
    res.rows.filter((r) => r.relrowsecurity && r.relforcerowsecurity).map((r) => r.relname),
  );
  const missingTables = PA_RLS_TABLES.filter((t) => !ok.has(t));
  return {
    paForceRlsEnabled: missingTables.length === 0,
    missingTables,
  };
}
