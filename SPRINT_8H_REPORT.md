# 8-Hour Engineering Sprint Report — Security, Data Pipeline, Workspace Features, DevOps, Stress-Testing & Full Audit

**Date:** 2026-11-25  
**Branch:** `sprint/8h-security-pipeline-devops-audit` (branched from `overnight/linux-ci-pg-hardening` @ `380d74a`)  
**Scope:** End-to-end execution of the approved 8-Phase Engineering Plan covering deep adversarial security hardening, governed bilingual data pipeline development, Document Workspace & API feature delivery, production `jwt-pg` runtime & observability, containerization & CI/CD DevOps, multi-tenant PostgreSQL 16 stress/soak testing & performance budgets, and a full OWASP/architecture audit.

---

## 1. Executive Summary & Readiness Verdict

**Verdict: PASS — All 8 phases completed, verified locally and against real PostgreSQL 16 Docker + non-root containers, with zero new third-party dependencies, zero license violations, zero high/critical production advisories, and all founder-gated boundaries preserved intact.**

### Headline Outcomes
- **10 real security, concurrency, and runtime defects (`AUD-01`–`AUD-10`) discovered and remediated**, including:
  - **Critical/High Chromium CSS-injection & SSRF** across PDF/Slide/Chart renderers (`AUD-01`).
  - **High Cross-Tenant BOLA leak** on data-pipeline idempotency/history caches (`AUD-02`).
  - **High PostgreSQL 16 `READ COMMITTED` EvalPlanQual (`EPQ`) concurrency bug** caught under 10-way concurrent `PUT` stress on real PG16, which caused phantom `404` responses instead of `409 REVISION_CONFLICT` (`AUD-03`).
  - **High non-durable AI idempotency** migrated from an unbounded in-memory `Map` to an append-only, tenant-RLS `ai_applied_operations` PostgreSQL table (`AUD-04`).
  - **Medium non-root Docker crash (`EACCES`)** fixed so API runs strictly as UID `1000` behind unprivileged Nginx UID `101` (`AUD-09`).
- **Governed Bilingual Data Pipeline (`engines/data-processing`) upgraded** with full RFC 4180 multi-line CSV/TSV parsing, exact `FIN-POL-V1` BigInt minor-unit financial reconciliation (`KHR` scale `0`, `USD` scale `2`, zero-drift accounting), 3 new governed operators (`normalize_khmer_numerals`, `validate_schema_contract`, `mask_pii_columns`), OWASP-safe CSV export preserving negative numbers, and 4-probe DuckDB sandbox verification + Polars minor-unit parity.
- **Document Studio & API expanded** with RLS-isolated search & pagination (SQL wildcard escaping), block-level revision diff API + drawer UI, governed `/api/data-prep/stage-and-profile` endpoint, New Document modal, DOCX upload/import UI, inline document metadata settings, and `Ctrl/Cmd+S` + unsaved-change protection.
- **Production Runtime & DevOps Stack delivered:** `jwt-pg` server startup with fail-closed validation and graceful `SIGTERM`/`SIGINT` shutdown, `/api/ready` live RLS readiness probe, `owner`/`administrator`-restricted `/api/metrics`, `X-Request-Id` + secret-redacted structured logging, non-root `Dockerfile.api` & `Dockerfile.web`, `docker-compose.yml`, `scripts/db-cli.mjs`, `scripts/check-hygiene.mjs`, `scripts/bench-check.mjs`, and a PostgreSQL 16 RLS CI job in `.github/workflows/ci.yml`.
- **Test & Verification Growth:** Expanded from `13` to **`19` Vitest test suites** (**`18 passed | 1 skipped`** locally, **`53 passed | 4 skipped`** tests; **`100%` passing** when `TEST_POSTGRES_URL` is set against live PG16, including all `4/4` live PG16 RLS tests and `4/4` deep `RUN_STRESS=1` PG16 stress workloads).

---

## 2. Commit-by-Commit Log

| Phase | Commit | Summary | Diff Stat |
| :---: | :--- | :--- | :--- |
| **Phase 1** | `71e1433` | `security(phase1): block Chromium CSS/SSRF, fix pipeline BOLA, harden prompt safety, auth timing & rate limit` | 13 files, +800 / -76 |
| **Phase 2** | `f02ca13` | `feat(data-pipeline): add RFC 4180 CSV parser, BigInt FIN-POL-V1 reconciliation, Khmer/PII/contract ops & DuckDB/Polars parity` | 5 files, +815 / -73 |
| **Phase 3** | `e4f495f` | `feat(workspace,api): add RLS search/pagination, revision diff, data-prep sandbox API, DOCX import & document settings UI` | 11 files, +1199 / -56 |
| **Phase 4** | `eef569e` | `feat(runtime,db): add jwt-pg production server, graceful shutdown, /api/ready, /api/metrics & durable PG AI idempotency` | 8 files, +803 / -54 |
| **Phase 5** | `8aa1d2e` | `feat(devops): add non-root API/Web Dockerfiles, docker-compose, db-cli, hygiene gate & CI PG16 RLS job` | 11 files, +572 / -12 |
| **Phase 6** | `9da7cca` | `perf(stress,db): fix PG16 EPQ concurrency bug, add multi-tenant stress suite & performance budget harness` | 6 files, +696 / -17 |
| **Phase 7** | `e659859` | `docs(audit): complete OWASP/architecture audit, DevOps runbook & harden analytics DuckDB benchmark` | 5 files, +173 / -13 |
| **Phase 8** | *(this commit)* | `docs(report): add SPRINT_8H_REPORT.md after final full verification` | `SPRINT_8H_REPORT.md` |

*(Zero third-party dependencies added: `package-lock.json` changed by +1 line strictly for local workspace link `@ai-office-suite/data-processing` in `apps/api/package.json`.)*

---

## 3. Security, Concurrency & Runtime Defects Fixed (`AUD-01`–`AUD-10`)

Full route-by-route OWASP ASVS/API/LLM security mapping is documented in [`documentation/SECURITY_AUDIT_REPORT.md`](./documentation/SECURITY_AUDIT_REPORT.md).

| ID | Severity | Component | Root Cause & Fix | Covering Test |
| :--- | :---: | :--- | :--- | :--- |
| **AUD-01** | **Critical/High** | `engines/file-conversion/src/pdfExporter.ts`, `engines/presentation/src/slidePdfRenderer.ts`, `engines/intelligence/src/chartAdapters.ts` | Unsanitized CSS (`fontFamily`, `color`, `highlight`, theme/shape colors) and unvalidated slide `<img src>` URIs allowed CSS injection & SSRF inside headless Chromium. Added strict CSS allowlists (`sanitizeCssColor`, `sanitizeCssFontFamily`), raster-only base64 image validation (`sanitizeSafeImageDataUri`), offline `<meta Content-Security-Policy>` (`PDF_RENDER_CSP_META`), and hardened offline Chromium launch flags (`HARDENED_CHROMIUM_BASE_ARGS`). | `tests/security-adversarial-suite.test.ts` |
| **AUD-02** | **High** | `engines/data-processing/src/pipeline.ts` | `committedByIdempotencyKey` and `certifiedHistory` lacked tenant/workspace scoping, causing cross-tenant BOLA leaks on key reuse/history lookup. Scoped both by `${tenantId}::${workspaceId}::...` with bounded LRU eviction. | `tests/security-adversarial-suite.test.ts` |
| **AUD-03** | **High** | `platform/database/src/documentRepository.ts` | Under 10-way concurrent `PUT` traffic on real PostgreSQL 16, `JOIN document_versions ... FOR UPDATE OF d` triggered PostgreSQL `READ COMMITTED` EvalPlanQual (`EPQ`) row drops when `current_revision` advanced, yielding phantom `404` instead of `409 REVISION_CONFLICT`. Fixed `updateDocument` and `applyAiOperationIdempotent` to lock `documents` alone (`FOR UPDATE`) before checking `expectedRevision` and querying `document_versions`. | `tests/stress-load-benchmarks.test.ts` (Workload A on PG16) |
| **AUD-04** | **High** | `apps/api/src/app.ts`, `platform/database/src/schema.ts`, `documentRepository.ts` | Replaced unbounded in-memory `pgAppliedAiOps` map with append-only, tenant-RLS `ai_applied_operations` table (`ENABLE`/`FORCE ROW LEVEL SECURITY`, `REVOKE UPDATE, DELETE` from `app_runtime`), guaranteeing crash-safe and multi-replica AI idempotency. | `tests/production-runtime-durability.test.ts`, `tests/stress-load-benchmarks.test.ts` |
| **AUD-05** | **Medium** | `platform/identity/src/authService.ts` | Unknown email logins returned before bcrypt verification (timing oracle). Added constant-time cost-10 `DUMMY_BCRYPT_HASH` verification on missing users. | `tests/security-adversarial-suite.test.ts` |
| **AUD-06** | **Medium** | `apps/api/src/rateLimit.ts`, `apps/api/src/app.ts` | Added zero-dependency memory-bounded sliding-window rate limiter (`429 RATE_LIMITED` + `Retry-After`) for `/api/auth/login` (IP+email bucket) and write/export endpoints without starving distinct accounts; added strict Helmet CSP, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. | `tests/security-adversarial-suite.test.ts`, `tests/stress-load-benchmarks.test.ts` (Workload D) |
| **AUD-07** | **Medium** | `packages/validation/src/index.ts` | Hardened `scanForPromptInjection()` with zero-width/bidi stripping, Unicode NFKC folding, Khmer injection/exfiltration/bypass patterns, LLM role-framing markers, and Markdown/HTML exfiltration rules. | `tests/security-adversarial-suite.test.ts` |
| **AUD-08** | **Medium** | `engines/data-processing/src/pipeline.ts` | Fixed multi-line quoted CSV corruption (upgraded to full RFC 4180 parser with BOM stripping, auto delimiter detection, duplicate/empty header fail-closed rejection, DoS row/cell caps), eliminated float drift in currency control totals via `FIN-POL-V1` exact BigInt minor units, and preserved negative numbers in OWASP CSV export. | `tests/data-pipeline-hardening.test.ts` |
| **AUD-09** | **Medium** | `apps/api/src/app.ts`, `docker/Dockerfile.api` | Non-root container startup (`node` UID `1000`) failed with `EACCES` attempting `mkdir /app/.local-data` even in `jwt-pg` mode. Switched `jwt-pg` local fallback to in-memory when `storageDir` is unset; verified live 3-container Docker smoke test (PG16 + UID `1000` API + UID `101` Nginx). | Live Docker smoke test + `tests/production-runtime-durability.test.ts` |
| **AUD-10** | **Low** | `platform/storage/src/index.ts`, `engines/integration`, `engines/intelligence`, `modules/ai`, `engines/analytics`, `engines/data-processing` | Added `assertContainedPath` + atomic write-temp-and-rename commits in local storage, workspace scoping on `runByIdempotency`, local tenant check in `rehydrateWorkflowFromDb`, bounded LRU caps (AI `1000`, BI `500`), and strict integer bounds + `allow_unsigned_extensions=false` / `enable_external_access=false` in DuckDB benchmarks. | `tests/security-adversarial-suite.test.ts`, `tests/g1-an00-analytics-feasibility.test.ts` |

---

## 4. Feature, Runtime & DevOps Deliverables

### Data Pipeline (`engines/data-processing`, `packages/shared-contracts`)
- Full RFC 4180 stateful CSV/TSV parser (`delimiter: auto|","|";"|\t`, BOM strip, duplicate/empty header fail-closed rejection, configurable DoS row/cell caps).
- Enhanced `stageXlsxSource` (`sheetName` selection, cached formula result extraction, `Date` -> ISO `YYYY-MM-DD`).
- Exact `FIN-POL-V1` BigInt minor-unit financial reconciliation across `KHR` (scale `0`) and `USD` (scale `2`) with zero-drift quarantined/excluded accounting across every exclusion path.
- Three governed bilingual operators: `normalize_khmer_numerals` (Khmer `០-៩` -> ASCII `0-9` while preserving leading-zero IDs), `validate_schema_contract`, and `mask_pii_columns` (`redact` / deterministic HMAC/hash token), plus EN/KM `planDataPrepCommand` intent planning.
- `exportCertifiedDatasetToSafeCsv` with OWASP CSV formula neutralization while preserving negative finite numbers (`-0.05`).
- 4-probe DuckDB sandbox verification (`read_csv_auto`, `read_parquet`, `glob`, `copy_to_file`) and DuckDB vs Polars BigInt minor-unit parity.

### Workspace & API (`apps/api`, `apps/web`, `engines/document`, `platform/database`, `modules/documents`)
- `GET /api/documents` with parameterized RLS-safe `q` search (escaping `%`, `_`, `\`), `language` filter, and `limit`/`offset` pagination (`listDocumentsFiltered`).
- `GET /api/documents/:id/versions/:fromRev/diff/:toRev` backed by `computeDocumentRevisionDiff` (block-level added/removed/modified diff).
- `POST /api/data-prep/stage-and-profile` (JWT + `document:write` RBAC + Zod 5MB/50k caps + audit log).
- Upgraded Web Document Studio (`apps/web/src/App.tsx`, `VersionAuditDrawer.tsx`, `styles.css`): New Document modal, DOCX upload/import with diagnostics, inline document metadata editor (title, language, page size, orientation), sidebar search + language filter, `Ctrl/Cmd+S` save shortcut, unsaved-change switch guard, and inline revision diff viewer.

### Production Runtime, Observability & DevOps (`apps/api`, `docker/`, `scripts/`, `.github/workflows/ci.yml`)
- `apps/api/src/server.ts`: production `jwt-pg` startup with fail-closed `DATABASE_URL`/`JWT_SECRET` checks, pool & SSL config, optional `AUTO_MIGRATE_ON_START`, `SIGTERM`/`SIGINT` graceful shutdown; `provisional-local` remains strictly loopback-only.
- `apps/api/src/observability.ts`: `X-Request-Id` correlation, `redactAuditValue`-routed structured JSON logging, rolling p50/p95 HTTP latency, `/api/ready` (live PG + `app_runtime` + `13`-table `FORCE RLS` check), and `owner`/`administrator`-only `/api/metrics`.
- Non-root containers: `docker/Dockerfile.api` (Node 22 `bookworm-slim` UID `1000`, glibc native DuckDB/Polars compatible), `docker/Dockerfile.web` (Nginx `1.27-alpine` UID `101` + `docker/nginx.conf`), `docker-compose.yml`, `.dockerignore`, updated `.env.example`.
- Operational tooling: `scripts/db-cli.mjs` (`migrate`, `verify-rls`, `backup`, `restore`, `seed-dev` refusing `NODE_ENV=production`), `scripts/check-hygiene.mjs`, `scripts/bench-check.mjs`, `benchmarks/baseline.json`, and `documentation/DEVOPS_RUNBOOK.md`.
- Upgraded `.github/workflows/ci.yml` with concurrency cancellation, `lint:hygiene` gate, and a dedicated `postgres16-rls` service-container job.

---

## 5. Final Verification Matrix (Run After Last Code Edit `e659859`)

| Check | Command | Result | Exact Observed Output / Telemetry |
| :--- | :--- | :---: | :--- |
| **Hygiene Gate** | `npm run lint:hygiene` | **PASS** | `186` tracked files scanned; `0` forbidden files, `0` secrets, `0` legacy naming matches, gate boundaries intact |
| **License Policy** | `npm run lint:licenses` | **PASS** | `467` package versions (`47` direct); `0` disallowed licenses (`jszip@3.10.2` permissive MIT branch noted) |
| **Security Audit** | `npm audit --omit=dev --audit-level=high` | **PASS** | Exit `0`; `0` high/critical production advisories (`2` pre-existing moderate transitive `uuid` via `exceljs@4.4.0`) |
| **TypeScript Check** | `npm run typecheck` | **PASS** | `0` errors across all 20 workspaces (`tsc -p tsconfig.typecheck.json --noEmit`) |
| **Full Linux Build** | `npm run build` | **PASS** | `build:api` (`tsc`) + `build:web` (`tsc` + `vite build`, 107 modules in `4.73s`) clean |
| **Perf Budget Gate** | `npm run bench:check` | **PASS** | DuckDB 50k `34.15ms` (<=250ms), Polars 50k `27.29ms` (<=250ms), Pipeline 10k BigInt `251.23ms` (<=1500ms), Spreadsheet 5k `99.29ms` (<=1000ms) |
| **Default Test Suite** | `npm test` | **PASS** | **18 passed \| 1 skipped (19)** files; **53 passed \| 4 skipped (57)** tests in `116.41s` |
| **PG16 Migrate & RLS** | `DATABASE_URL=... npm run db:migrate && npm run db:verify-rls` | **PASS** | Schemas `core-d2` + `integration-xi00` applied; **`13/13` tables verified with `FORCE RLS`**, `0` failures |
| **PG16 Live RLS Suite** | `TEST_POSTGRES_URL=... npx vitest run tests/d2-live-postgres16-rls.test.ts` | **PASS** | **4/4 tests passed** (`4.75s`): `app_runtime` RLS isolation, `REVOKE UPDATE/DELETE`, `xi_*` crash/rehydrate & atomic outbox, cross-DB backup/restore |
| **PG16 Deep Stress** | `RUN_STRESS=1 TEST_POSTGRES_URL=... npx vitest run tests/stress-load-benchmarks.test.ts` | **PASS** | **4/4 workloads passed** (`13.05s`) on real `node-pg` PG16 (telemetry below) |
| **Docker Smoke Test** | Phase 5 live 3-container stack (`PG16` + UID `1000` API + UID `101` Nginx) | **PASS** | `/api/ready` `200`, `jwt-pg` login + bilingual document create via Nginx; `0` BuildKit warnings; `0` leftover containers |

### Deep Stress Telemetry (Final Run on Live PostgreSQL 16 Docker)
- **Workload A (Multi-Tenant PG16 HTTP Storm + Lock/Dedup/Revocation Races):** `engine=node-pg`, `100` concurrent reads: `p50=431.53ms`, `p95=576.39ms`, `p99=591.83ms`, `rssDelta=+1.58MB`, `0` cross-tenant leaks, exact `1` winner + `9` `409 REVISION_CONFLICT` on 10-way lock race, `1` mutation + `7` replayed hits on 8-way AI dedup race, immediate mid-storm session revocation.
- **Workload B (50k Bilingual USD/KHR Pipeline Soak + 100k DuckDB/Polars):** `50,000` rows staged in `226.22ms`, executed with exact `0`-drift BigInt reconciliation in `795.53ms` (`rssDelta=+64.21MB`); `100k` DuckDB `p50=43.16ms / p95=46.69ms`; `100k` Polars `p50=31.35ms / p95=35.77ms`.
- **Workload C (60-Burst Malicious OOXML Storm + BI Cache Thrash):** `60` malicious zip-bomb/traversal/macro payloads blocked cleanly in `78.36ms`; BI cache-eviction thrash under rapid role revocation completed in `580.97ms` with zero post-revocation leakage.
- **Workload D (Login Brute-Force Rate-Limit Isolation):** Repeated invalid logins throttled with `429 RATE_LIMITED` + `Retry-After` without starving distinct legitimate user accounts.

*(Full stress methodology and workload charts are documented in [`documentation/STRESS_AND_PERFORMANCE_REPORT.md`](./documentation/STRESS_AND_PERFORMANCE_REPORT.md).)*

---

## 6. Preserved Founder-Gated Decisions & Governance Compliance

All founder-gated boundaries remain untouched and honestly disclosed:
- **External Cloud STT/LLM Adapters:** Fail-closed (`423`) with zero unapproved live network calls; mock adapters explicitly marked `isMock: true`; zero fabricated cloud Khmer WER benchmarks.
- **Founder-Gated Production Phases Preserved:** `D3` (multi-replica Redis/edge rate limiting & cloud deployment), `SS-01`, `DP-01`, `AN-01`, `PS-01`, `ENG-BI-01`, `XI-01`, `PPT-T06`, and P1 BI/XI production features remain gated pending founder sign-off.
- **Architecture & Hygiene:** `20` workspaces form a strict DAG (`0` circular dependencies); `0` legacy naming matches; `0` tracked `.env`, `.local-data/`, secrets, or audio binaries.

---

## 7. Review & Merge Instructions

This branch (`sprint/8h-security-pipeline-devops-audit`) stacks cleanly on top of `overnight/linux-ci-pg-hardening` (Draft PR #1).

```bash
# 1. Review the stacked sprint diff against overnight/linux-ci-pg-hardening
git fetch origin
git log --oneline origin/overnight/linux-ci-pg-hardening..origin/sprint/8h-security-pipeline-devops-audit
git diff --stat origin/overnight/linux-ci-pg-hardening..origin/sprint/8h-security-pipeline-devops-audit

# 2. Optional: run full Docker Compose stack locally
cp .env.example .env
# (set a strong >=32-byte JWT_SECRET in .env)
docker compose up --build

# 3. Recommended merge order on GitHub:
#    a) Review & merge Draft PR #1 (overnight/linux-ci-pg-hardening -> main)
#    b) Re-target or review & merge Draft PR #2 (sprint/8h-security-pipeline-devops-audit -> main)
```
