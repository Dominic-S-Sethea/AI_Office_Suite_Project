# DevOps, Containerization & Operations Runbook — AI Office Suite

**Last Updated:** 2026-11-28  
**Supported Runtime:** Node.js `>=22.18.0` (native TypeScript execution), PostgreSQL `16+`, Docker Engine `24+` / Docker Compose v2+

---

## 1. Quick-Start Full-Stack Deployment (Docker Compose, `jwt-pg` Mode)

1. Copy `.env.example` to `.env` (never commit `.env`):
   ```bash
   cp .env.example .env
   ```
2. Configure strong required secrets in `.env` (see `.env.example` for all supported variables):
   - `POSTGRES_PASSWORD`: PostgreSQL superuser/migration password (`>=12` characters)
   - `POSTGRES_APP_PASSWORD`: least-privilege `aios_app` runtime role password (`>=12` characters; required by `docker-compose.yml`)
   - `JWT_SECRET`: session HMAC secret (`>=32` random characters; e.g. `openssl rand -base64 32`)
   - Production signing/privacy secrets (required when `NODE_ENV=production` in API config): `AI_PROPOSAL_SIGNING_SECRET` and `PII_PSEUDONYMIZATION_KEY` (`>=32` random characters)
   - Optional Chromium container sandbox flag: `CHROMIUM_NO_SANDBOX=false` by default (set `"true"` only in rootless/no-new-privileges containers that cannot enable user namespaces)
3. Build and start PostgreSQL 16 + migration job + non-root API (`UID 1000`) + unprivileged Nginx Web (`UID 101`):
   ```bash
   docker compose up -d --build
   ```
4. Verify readiness and RLS integrity:
   ```bash
   curl -fsS http://127.0.0.1:8080/api/ready
   ```
   Expected response (`HTTP 200`):
   ```json
   {"status":"ready","authMode":"jwt-pg","engine":"node-pg","checks":{"connectivity":true,"appRuntimeLeastPrivilege":true,"coreForceRlsEnabled":true,"missingForceRlsTables":[]}}
   ```

> **Fail-Closed Safety:** `docker-compose.yml` refuses to start if `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, or `JWT_SECRET` are unset, and `apps/api/src/server.ts` refuses to start in `provisional-local` mode if `NODE_ENV=production` or `HOST` is non-loopback.

---

## 2. Database Operations CLI (`scripts/db-cli.mjs`)

All commands require `DATABASE_URL` pointing to PostgreSQL 16+:

| Task | Command | Behavior |
| :--- | :--- | :--- |
| **Apply Core + XI + PA-00 Schemas** | `npm run db:migrate` | Idempotently creates Core, XI, and PA-00 tables, least-privilege `app_runtime` / `aios_app` role, `FORCE ROW LEVEL SECURITY` policies across all `22` tenant-scoped tables, and append-only `REVOKE UPDATE, DELETE` grants. |
| **Verify RLS & Privileges** | `npm run db:verify-rls` | Audits `pg_roles`, all `22` tenant tables (`core` + `xi` + `pa_*`) in `pg_class`, and `information_schema.role_table_grants`; exits non-zero on any drift. |
| **Logical Backup** | `npm run db:backup -- ./backup.json` | Exports Core, XI, and PA-00 logical JSON snapshots + SHA-256 digest (store outside repo, encrypted at rest). |
| **Logical Restore** | `npm run db:restore -- ./backup.json` | Restores Core, XI, and PA-00 snapshots into a migrated target database inside an atomic transaction. |
| **Local Dev Seed** | `npm run db:seed-dev` | Seeds local demo tenant/workspace + `owner@dev.local`, `editor@dev.local`, `viewer@dev.local`. **Hard-refuses if `NODE_ENV=production`.** |

---

## 3. Observability, Health & Graceful Shutdown

- **Liveness Probe:** `GET /api/health` -> `200` (stateless service/auth-mode check).
- **Readiness Probe:** `GET /api/ready` -> `200` when PostgreSQL connectivity, `app_runtime` non-superuser/nobypassrls, and `FORCE ROW LEVEL SECURITY` on all core tables pass; `503 degraded` otherwise.
- **Operational Metrics:** `GET /api/metrics` (rate-limited; strictly restricted to `owner` or `administrator` via `metrics:read` in `jwt-pg` mode) -> returns request status classes, rolling `p50`/`p95`/`max` latency, rate-limit rejection counters, RSS MB, and live `pg-pool` `totalCount`/`idleCount`/`waitingCount`.
- **Correlation & Redacted Logging:** Every response emits `X-Request-Id`. Structured JSON stdout logs pass through `redactAuditValue()` so JWTs, `aios_session` cookies, passwords, cloud keys, and secrets are never logged.
- **Graceful Shutdown:** `SIGTERM` / `SIGINT` drains active HTTP connections (`server.close`) and closes the PostgreSQL pool (`db.close`) cleanly within a 10-second timeout.

---

## 4. Incident Response: Emergency Session Revocation SOP

1. **Single-User Compromise:** User or admin invokes `POST /api/auth/revoke-sessions` (or DBA executes `UPDATE users SET token_version = token_version + 1 WHERE user_id = $1::uuid;`). Every existing JWT/cookie for that user fails immediately with `401 TOKEN_REVOKED` on the next request.
2. **Tenant Suspension:** Execute `UPDATE organizations SET status = 'suspended' WHERE tenant_id = $1::uuid;`. All active sessions for that tenant immediately fail with `403 ORGANIZATION_SUSPENDED`.
3. **JWT Signing Secret Rotation:** Rotate `JWT_SECRET` in secret manager and restart API replicas; all existing sessions are immediately invalidated across all tenants.

---

## 5. CI/CD Verification Pipeline (`.github/workflows/ci.yml`)

Every push to `main` and every pull request executes three jobs on `ubuntu-latest`:
1. **`validate`:** `npm ci` -> `npm run lint:hygiene` -> `npm run lint:licenses` -> `npm run sbom` -> `npm run typecheck` -> `npm run build` -> `npm test` -> `npm run bench:check` -> `npm audit --omit=dev --audit-level=high`.
2. **`postgres16-rls`:** Boots an ephemeral `postgres:16-alpine` service container and runs `npm run db:migrate`, `npm run db:verify-rls`, non-skippable `tests/d2-live-postgres16-rls.test.ts` + `tests/v13-pa00-platform-admin.test.ts`, and `tests/stress-load-benchmarks.test.ts`.
3. **`docker-smoke`:** Validates `docker compose config --quiet`, builds `Dockerfile.api` and verifies runtime `/api/health` + bundled `@fontsource` assets inside the slim container, and builds `Dockerfile.web` and validates `nginx -t`.
