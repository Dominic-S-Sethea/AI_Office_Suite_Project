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
   - `POSTGRES_PASSWORD`: PostgreSQL superuser/migration password (`>=12` characters; required by `docker-compose.yml`)
   - `POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD`: least-privilege `aios_app` runtime role credentials (`>=12` characters password; required by `docker-compose.yml` and provisioned automatically during `npm run db:migrate` or via `node scripts/db-cli.mjs provision-app-role`)
   - `JWT_SECRET`: session HMAC secret (`>=32` random characters; e.g. `openssl rand -base64 32`; required by `docker-compose.yml`)
   - `PII_PSEUDONYMIZATION_KEY` & `AI_PROPOSAL_SIGNING_SECRET`: distinct cryptographic secrets (`>=32` random characters; required by `docker-compose.yml` and `loadApiServerConfig()` when `NODE_ENV=production`)
   - Optional Chromium container sandbox flag: `CHROMIUM_NO_SANDBOX=false` by default (set `"true"` only in rootless/no-new-privileges containers that cannot enable user namespaces)
   - Distributed rate limiting & isolated OOXML/PDF workers: `RATE_LIMIT_STORE=postgres`, `ISOLATED_PARSER_WORKERS=true`, and `PARSER_WORKER_URL=http://workers:4200` run automatically in Docker Compose and production `jwt-pg` mode (`workers` runs in a dedicated zero-secret, zero-DB container built from `docker/Dockerfile.workers`).
   - Explicit CORS & DB TLS in `NODE_ENV=production`: `CORS_ORIGIN` and `PG_SSL_MODE` (`disable` | `require` | `verify-full`) must be configured explicitly
3. Build and start PostgreSQL 16 + migration job + isolated `workers` (`UID 1000`) + non-root `api` (`UID 1000`) + unprivileged Nginx `web` (`UID 101`):
   ```bash
   docker compose up -d --build
   ```
4. Verify readiness and RLS integrity:
   ```bash
   curl -fsS http://127.0.0.1:8080/api/ready
   ```
   Expected non-production response (`HTTP 200`):
   ```json
   {"status":"ready","authMode":"jwt-pg","engine":"node-pg","checks":{"connectivity":true,"appRuntimeLeastPrivilege":true,"currentConnectionLeastPrivilege":true,"usersPasswordHashIsolated":true,"coreForceRlsEnabled":true,"paForceRlsEnabled":true,"missingForceRlsTables":[]}}
   ```
   *(In `NODE_ENV=production`, `/api/ready` returns a minimal redacted `{ "status": "ready", "requestId": "..." }` payload without internal diagnostic checks.)*

> **Fail-Closed Safety:** `docker-compose.yml` refuses to start if `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `JWT_SECRET`, `PII_PSEUDONYMIZATION_KEY`, or `AI_PROPOSAL_SIGNING_SECRET` are unset, and `apps/api/src/server.ts` refuses to start in `provisional-local` mode if `NODE_ENV=production` or `HOST` is non-loopback.

---

## 2. Database Operations CLI (`scripts/db-cli.mjs`)

All commands require `DATABASE_URL` pointing to PostgreSQL 16+:

| Task | Command | Behavior |
| :--- | :--- | :--- |
| **Apply Core + XI + PA-00 Schemas** | `npm run db:migrate` | Idempotently creates Core, XI, and PA-00 tables, least-privilege `app_runtime` role (and provisions `POSTGRES_APP_USER` when set), `FORCE ROW LEVEL SECURITY` policies across all `24` tenant-scoped tables (`8` Core + `7` XI + `9` PA-00), and append-only `REVOKE UPDATE, DELETE` grants. |
| **Provision Non-Superuser App Role** | `node scripts/db-cli.mjs provision-app-role` | Explicitly creates/rotates the `NOSUPERUSER NOBYPASSRLS` runtime login role (`POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD`). |
| **Verify RLS & Privileges** | `npm run db:verify-rls` | Audits `pg_roles`, all `24` tenant-scoped tables (`core` + `xi` + `pa_*`) in `pg_class`, `users.password_hash` isolation, and `information_schema.role_table_grants`; exits non-zero on any drift. |
| **Logical Backup** | `npm run db:backup -- ./backup.json` | Atomically writes Core, XI, and PA-00 logical JSON snapshots (`0600` temp + rename) + SHA-256 digest (store outside repo, encrypted at rest). |
| **Logical Restore** | `npm run db:restore -- ./backup.json` | Verifies v2 SHA-256 integrity, asserts backup role RLS-bypass capability, and restores Core, XI, and PA-00 snapshots into a clean target database inside an atomic transaction. |
| **Local Dev Seed** | `DEV_SEED_PASSWORD=... npm run db:seed-dev` | Requires explicit `DEV_SEED_PASSWORD` (`>=12` chars); seeds local demo tenant/workspace + `owner@dev.local`, `editor@dev.local`, `viewer@dev.local`. **Hard-refuses if `NODE_ENV=production` or password missing.** |

---

## 3. Observability, Health & Graceful Shutdown

- **Liveness Probe:** `GET /api/health` -> `200` (stateless service/auth-mode check).
- **Readiness Probe:** `GET /api/ready` -> `200` when PostgreSQL connectivity, `app_runtime` non-superuser/nobypassrls, `usersPasswordHashIsolated`, and `FORCE ROW LEVEL SECURITY` on all active tables pass; `503 degraded` otherwise.
- **Operational Metrics:** `GET /api/metrics` (also supports `GET /api/metrics?format=prometheus`; rate-limited; strictly restricted to `owner` or `administrator` via `metrics:read` across both `jwt-pg` and `provisional-local` modes) -> returns request status classes, rolling `p50`/`p95`/`max` latency, rate-limit rejection counters, RSS MB, and live `pg-pool` `totalCount`/`idleCount`/`waitingCount`.
- **Correlation & Redacted Logging:** Every response emits `X-Request-Id`. Structured JSON stdout logs pass through `redactAuditValue()` so JWTs, `aios_session` cookies, passwords, Postgres URIs, cloud keys, and secrets are never logged.
- **Graceful Shutdown:** `SIGTERM` / `SIGINT` drains active HTTP connections (`server.close`) and closes the PostgreSQL pool (`db.close`) cleanly within a 10-second timeout.

---

## 4. Incident Response: Emergency Session Revocation SOP

1. **Single-User Compromise:** User or admin invokes `POST /api/auth/revoke-sessions` (or DBA executes `UPDATE users SET token_version = token_version + 1 WHERE user_id = $1::uuid;`). Every existing JWT/cookie for that user fails immediately with `401 TOKEN_REVOKED` on the next request. `POST /api/auth/logout` also records the active token `jti` into `revoked_session_tokens`.
2. **Tenant Suspension:** Execute `UPDATE organizations SET status = 'suspended' WHERE tenant_id = $1::uuid;`. All active sessions for that tenant immediately fail with `403 ORGANIZATION_SUSPENDED`.
3. **JWT Signing Secret Rotation:** Rotate `JWT_SECRET` in secret manager and restart API replicas; all existing sessions are immediately invalidated across all tenants.

---

## 5. CI/CD Verification Pipeline (`.github/workflows/ci.yml`)

Every push to `main` or `feasibility/**` and every pull request executes three jobs on `ubuntu-latest`:
1. **`validate`:** `npm ci` -> `npm run lint:hygiene` -> `npm run lint:licenses` -> `npm run sbom` -> `npm run typecheck` -> `npm run build` -> `npm test` (`REQUIRE_CHROMIUM=true`, `CHROMIUM_NO_SANDBOX=true`) -> `npm run bench:check` -> `npm audit --omit=dev --audit-level=high`.
2. **`postgres16-rls`:** Boots an ephemeral `postgres:16-alpine` service container with `REQUIRE_LIVE_PG=true` and runs `npm run db:migrate`, `npm run db:verify-rls`, non-skippable `tests/d2-live-postgres16-rls.test.ts` (including multi-replica `aios_app` PG16 rate limiting) + `tests/v13-pa00-platform-admin.test.ts`, and `tests/stress-load-benchmarks.test.ts`.
3. **`docker-smoke`:** Validates `docker compose config --quiet` with all required secrets, builds `Dockerfile.api` (verifying production `loadApiServerConfig` defaults, `scripts/db-cli.mjs` loading, `/api/health`, and bundled `@fontsource` assets), builds `Dockerfile.workers` (verifying zero `pg` installation and subprocess secret stripping), and builds `Dockerfile.web` (`nginx -t`).
