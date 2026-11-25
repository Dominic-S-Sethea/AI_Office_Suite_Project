# Phase D2 PostgreSQL Control-Plane Design (`TD-PLAT-01`)

**Status:** Design specification only (G2 planning deliverable). **No live PostgreSQL database, managed cloud DB, or migration of real user data is started or authorized yet.**

---

## 1. Architectural Role Split

| Layer | Engine | Responsibility |
| :--- | :--- | :--- |
| **Control Plane & Metadata** | **PostgreSQL 16 / 17** (`pg` / `postgres` pinned driver) | Organizations (tenants), users, memberships, roles, workspaces, document/workbook/dataset metadata, version pointers, approval state, idempotency keys, workflow runs, and append-only audit logs. |
| **Immutable File & Artifact Persistence** | **Object Storage Adapter** (`DocumentStorageAdapter` -> S3/R2/local) | Write-once original uploaded binaries (SHA-256 keyed), document/workbook revision snapshots, prepared Parquet/CSV artifacts, exported DOCX/PDF/XLSX files. |
| **Analytical & Cleaning Worker** | **DuckDB (`@duckdb/node-api`)** in isolated worker | Out-of-core / bounded-memory CSV/XLSX/Parquet preparation, joins, profiling, and control-total reconciliation. |
| **Browser UI** | **React + Tiptap** | Transient interactive editing state only — never trusted as a security or permission boundary. |

**Important Host Note:** Because the development checkout sits inside a OneDrive-synchronized folder, live PostgreSQL container volumes, WAL files, and mutable worker scratch directories must **never** be placed inside OneDrive-synced paths.

---

## 2. Candidate Core Schema & Composite Tenant Foreign Keys

Every tenant-owned table carries `tenant_id` and enforces composite foreign keys `(tenant_id, ...)` so cross-tenant references are structurally impossible even if application code errs.

```sql
-- Dedicated least-privilege runtime role (NO SUPERUSER, NO BYPASSRLS, NOT table owner)
-- App connections must execute: SET LOCAL app.current_tenant_id = '<uuid>'; inside each transaction.

CREATE TABLE organizations (
  tenant_id   UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id        UUID PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  token_version  INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deleted')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id   UUID NOT NULL REFERENCES organizations(tenant_id),
  user_id     UUID NOT NULL REFERENCES users(user_id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'editor', 'reviewer', 'viewer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE workspaces (
  tenant_id     UUID NOT NULL REFERENCES organizations(tenant_id),
  workspace_id  UUID NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id)
);

CREATE TABLE documents (
  tenant_id             UUID NOT NULL,
  workspace_id          UUID NOT NULL,
  document_id           UUID NOT NULL,
  title                 TEXT NOT NULL,
  language              TEXT NOT NULL CHECK (language IN ('en', 'km', 'bilingual')),
  current_revision      INTEGER NOT NULL CHECK (current_revision >= 1),
  published_revision    INTEGER NULL,
  status                TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'approved')),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
);

CREATE TABLE document_versions (
  tenant_id               UUID NOT NULL,
  document_id             UUID NOT NULL,
  revision                INTEGER NOT NULL CHECK (revision >= 1),
  storage_object_key      TEXT NOT NULL,
  content_sha256          CHAR(64) NOT NULL,
  source_import_sha256    CHAR(64) NULL,
  restored_from_revision  INTEGER NULL,
  created_by              UUID NOT NULL REFERENCES users(user_id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, revision),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, document_id)
);

CREATE TABLE idempotency_keys (
  tenant_id          UUID NOT NULL,
  idempotency_key    TEXT NOT NULL,
  operation_scope    TEXT NOT NULL,
  request_hash       CHAR(64) NOT NULL,
  response_json      JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, operation_scope, idempotency_key)
);

CREATE TABLE audit_logs (
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
REVOKE UPDATE, DELETE ON audit_logs FROM app_runtime;
```

---

## 3. Row-Level Security (RLS) & Pooled Connection Discipline

```sql
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_workspaces ON workspaces
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```
- Apply identical `ENABLE` + `FORCE ROW LEVEL SECURITY` policies to `documents`, `document_versions`, `idempotency_keys`, `datasets`, `recipes`, and `audit_logs`.
- **Fail-closed default:** When `app.current_tenant_id` is unset or empty across a pooled connection, `NULLIF(..., '')::uuid` evaluates to `NULL`, matching **zero** rows.
- **Worker & Object Storage Defense:** RLS alone does not protect object storage or worker files. Signed storage keys must remain prefixed `<tenant_id>/<workspace_id>/...` and verified by `platform/authorization` before issuing object reads/writes.

---

## 4. Atomic Publication & Reversible Prototype Migration Plan

1. **Optimistic Concurrency & Atomic Pointer Update:** Inside one `BEGIN ... COMMIT` transaction, persist the object to storage first, then `INSERT INTO document_versions ...`, then `UPDATE documents SET current_revision = current_revision + 1 WHERE tenant_id = $1 AND document_id = $2 AND current_revision = $expected` (`rowCount === 1` required, else `ROLLBACK` -> `409 REVISION_CONFLICT`). Failed/aborted writes leave the prior published pointer intact and orphan cleanup sweeps unreferenced staging objects.
2. **Reversible Migration from `.local-data/`:**
   - Phase D2 migration CLI will inventory `.local-data/documents/*` and `.local-data/originals/*`, compute SHA-256 manifests, run a `--dry-run` validation against disposable PostgreSQL containers, import into a test tenant with row-count and SHA-256 verification, and support full rollback without deleting `.local-data/` originals.
3. **Required G2 Verification Gates:** Migration dry-run + rollback test, two-tenant cross-access negative suite (API + storage + worker), concurrent revision-conflict test, and `pg_dump`/restore verification.
