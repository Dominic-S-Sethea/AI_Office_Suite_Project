# Full Security, Architecture, Financial Precision & Compliance Audit Report

**Audit Date:** 2026-11-29  
**Branch:** `feasibility/v1.4-rc00-qe00-tf01-tf04-tf11`  
**Standards Mapped:** OWASP ASVS L2, OWASP API Security Top 10 (2023), OWASP Top 10 for LLM Applications, `FIN-POL-V1` Financial Precision Policy, `security/DEPENDENCY_LICENSE_POLICY.md`

---

## 1. Executive Audit Verdict

- **Workspace Architecture:** **PASS** — `21` workspaces form a strict Directed Acyclic Graph (`0` circular dependencies).
- **Dynamic Code / Injection Sinks:** **PASS** — `0` occurrences of `eval()`, `new Function()`, `innerHTML`, `dangerouslySetInnerHTML`, or `shell: true` subprocess invocations across `apps/`, `engines/`, `modules/`, `packages/`, `platform/`, and `scripts/`. Every `execFile`/`spawn` passes fixed argv arrays.
- **SQL Injection & Multi-Tenant RLS:** **PASS** — 100% parameterized PostgreSQL queries (`$1..$N`, with `ESCAPE '\\'` on prefix `LIKE` queries) across all repositories and identity services; all `24` tenant-scoped tables across Core (`8`), XI (`7`), and PA-00 (`9`) schemas enforce `ENABLE` + `FORCE ROW LEVEL SECURITY` under least-privilege `app_runtime` (`NOSUPERUSER NOBYPASSRLS NOLOGIN`); immutable ledgers (`audit_logs`, `document_versions`, `ai_applied_operations`, `xi_artifact_revisions`, `pa_usage_ledger`) revoke `UPDATE` and `DELETE` from `app_runtime`; `FOR UPDATE` locks operate cleanly on `documents` alone (eliminating `READ COMMITTED` EvalPlanQual phantom 404s); `api_rate_limits` and `revoked_session_tokens` revoke direct table access and expose narrow `SECURITY DEFINER` routines to `app_runtime`.
- **Financial Precision (`FIN-POL-V1`):** **PASS** — BigInt integer minor units enforced across `engines/analytics`, `engines/data-processing` (`KHR` scale `0`, `USD` scale `2`, verified `0` minor-unit reconciliation drift up to `125B+ KHR` and fractional `0.10 + 0.20 - 0.05 USD`), and DuckDB/Polars minor-unit parity checks.
- **License & Supply-Chain Policy:** **PASS** — `533` installed third-party package versions scanned across `22` workspace directories (`45` direct dependencies; cross-OS lockfile entries audited; `0` disallowed licenses); CycloneDX 1.5 SBOM emits `620` total components (`339` runtime required).

---

## 2. Route-by-Route API Security Matrix (`apps/api/src/app.ts`)

| Method & Route | Auth (`jwt-pg`) | CSRF (Cookie) | Rate Limit | RBAC Requirement | Input Validation | RLS / Persistence |
| :--- | :---: | :---: | :---: | :--- | :--- | :--- |
| `GET /api/health` | Public | N/A | `preParseIpLimiter` | Public liveness | None | Stateless |
| `GET /api/ready` | Public | N/A | `preParseIpLimiter` + `readyLimiter` | Public readiness | None | Live PG `SELECT 1` + `app_runtime` + `FORCE RLS` check |
| `GET /api/metrics` | `jwtMiddleware` | N/A (GET) | `preParseIpLimiter` + `apiLimiter` | `owner` / `administrator` (`metrics:read`) | `format` query (`json` \| `prometheus`) | Process + `pg-pool` telemetry |
| `POST /api/auth/login` | Public | N/A (issues cookie) | Strict (`preParseIpLimiter` + `loginIpLimiter` + `loginLimiter` IP+email) | Active user + active org + membership | `loginRequestSchema` | Constant-time bcrypt + `users`/`memberships`/`organizations` |
| `POST /api/auth/token` | Public (non-browser CLI/service only) | N/A (blocks `Origin`/`Sec-Fetch-Site` `403`) | Strict (`preParseIpLimiter` + `loginIpLimiter`) | Active user + active org + membership | `loginRequestSchema` | Constant-time bcrypt + `users`/`memberships`/`organizations` (`2h` Bearer JWT) |
| `POST /api/auth/logout` | Cookie / Bearer (optional) | `verifyCookieCsrf` (cookie without Bearer) | `preParseIpLimiter` + `apiLimiter` | Revokes active JTI if supplied | None | Records `revoked_session_tokens` JTI + clears `HttpOnly` cookie |
| `GET /api/auth/me` | `jwtMiddleware` | N/A (GET) | `preParseIpLimiter` + `apiLimiter` | Valid session + live `token_version` + JTI check | None | Live DB check |
| `POST /api/auth/revoke-sessions` | `jwtMiddleware` | `verifyCookieCsrf` | `preParseIpLimiter` + `apiLimiter` | Authenticated principal | None | Increments `users.token_version` |
| `GET /api/documents` | `jwtMiddleware` | N/A (GET) | `apiLimiter` | `document:read` | `listDocumentsQuerySchema` | `app_runtime` RLS + escaped `ILIKE` |
| `POST /api/documents` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `document:create` | `createDocumentSchema` | `app_runtime` RLS + audit |
| `POST /api/documents/seed-bilingual-fixture` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `document:create` | None | `app_runtime` RLS + audit |
| `GET /api/documents/:id` | `jwtMiddleware` | N/A (GET) | `apiLimiter` | `document:read` | UUID format check | `app_runtime` RLS |
| `PUT /api/documents/:id` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `document:write` | `updateDocumentSchema` | `FOR UPDATE` + `409` lock + RLS |
| `GET /api/documents/:id/versions` | `jwtMiddleware` | N/A (GET) | `apiLimiter` | `document:read` | `paginationQuerySchema` (`limit`/`offset`/`order`) + UUID | `app_runtime` RLS |
| `GET /api/documents/:id/versions/:fromRev/diff/:toRev` | `jwtMiddleware` | N/A (GET) | `apiLimiter` | `document:read` | Positive integer revs + UUID | `app_runtime` RLS |
| `POST /api/documents/:id/versions/:revision/restore` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `document:restore` | `restoreVersionRequestSchema` (`expectedRevision` `409`) + UUID | `FOR UPDATE` + new revision + RLS |
| `POST /api/documents/:id/ai/plan` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `document:write` (`document:write` upfront + `ai_assistant:read`) | `aiPlanRequestSchema` + prompt injection scan (cmd + block + `selectedText`) | `app_runtime` RLS |
| `POST /api/documents/:id/ai/apply` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `ai_assistant:apply_ai` + `document:write` + explicit `approved: true` | `aiApplyRequestSchema` | Atomic PG `ai_applied_operations` ledger + `409` + RLS |
| `POST /api/documents/import/docx` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `document:create` | `importDocxRequestSchema` + fail-fast `fflate` pre-storage validation | `app_runtime` RLS + audit |
| `POST /api/documents/:id/export/docx` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `export:export` (`viewer` denied `403`) | UUID check + safe `Content-Disposition` | `app_runtime` RLS + audit |
| `POST /api/documents/:id/export/pdf` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `export:export` (`viewer` denied `403`) | UUID check + CSS/CSP SSRF lockdown + opt-in sandbox | `app_runtime` RLS + audit |
| `GET /api/documents/:id/audit` | `jwtMiddleware` | N/A (GET) | `apiLimiter` | `audit:read` | `paginationQuerySchema` (`limit`/`offset`) + UUID | `app_runtime` RLS |
| `POST /api/speech/transcribe` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `speech:transcribe` | `speechTranscribeRequestSchema` | `no-store`; cloud adapters fail closed `423`; mock `isMock: true` |
| `POST /api/data-prep/stage-and-profile` | `jwtMiddleware` | `verifyCookieCsrf` | `apiLimiter` | `document:write` | `dataPrepStageProfileSchema` (5MB, 50k rows cap) | Audited dry-run BigInt pipeline |

All responses carry Helmet CSP (`default-src 'none'; frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `X-Request-Id`, no `X-Powered-By`, and `Cache-Control: no-store` on `/api/auth`, `/api/documents`, `/api/speech`, `/api/data-prep`, and `/api/metrics`.

---

## 3. Summary of Vulnerabilities & Defects Fixed in This 8-Hour Sprint

| ID | Severity | Component | Finding & Remediation |
| :--- | :---: | :--- | :--- |
| **AUD-01** | **Critical/High** | `pdfExporter.ts`, `slidePdfRenderer.ts`, `chartAdapters.ts` | CSS injection (`fontFamily`, `color`, `highlight`, slide theme/shape colors) & unsanitized slide `<img src>` URIs enabled SSRF inside headless Chromium. Added strict CSS allowlists, raster-only base64 image URI validation, offline `<meta Content-Security-Policy>`, and Chromium offline flags (`tests/security-adversarial-suite.test.ts`). |
| **AUD-02** | **High** | `engines/data-processing/src/pipeline.ts` | `committedByIdempotencyKey` and `certifiedHistory` omitted `tenantId`/`workspaceId` scoping (cross-tenant BOLA leak). Scoped both by `${tenantId}::${workspaceId}::...` with bounded LRU eviction (`tests/security-adversarial-suite.test.ts`). |
| **AUD-03** | **High** | `platform/database/src/documentRepository.ts` | PostgreSQL 16 `READ COMMITTED` EvalPlanQual (`EPQ`) dropped rows under concurrent `JOIN ... FOR UPDATE OF d`, returning phantom `404` instead of `409 REVISION_CONFLICT`. Fixed by locking `documents` alone before loading `document_versions` (`tests/stress-load-benchmarks.test.ts`). |
| **AUD-04** | **High** | `apps/api/src/app.ts` & `platform/database` | Replaced unbounded in-memory `pgAppliedAiOps` map with append-only, tenant-RLS `ai_applied_operations` table (`REVOKE UPDATE, DELETE` from `app_runtime`), guaranteeing crash-safe and multi-replica AI idempotency (`tests/production-runtime-durability.test.ts`). |
| **AUD-05** | **Medium** | `platform/identity/src/authService.ts` | Unknown email logins skipped bcrypt verification (email-enumeration timing oracle). Added constant-time dummy cost-10 bcrypt check (`tests/security-adversarial-suite.test.ts`). |
| **AUD-06** | **Medium** | `apps/api/src/rateLimit.ts` & `app.ts` | Added memory-bounded sliding-window rate limiting (`429 RATE_LIMITED` + `Retry-After`) protecting `/api/auth/login` (IP+email bucket) and write/export APIs without cross-user starvation (`tests/stress-load-benchmarks.test.ts`). |
| **AUD-07** | **Medium** | `packages/validation/src/index.ts` | Hardened `scanForPromptInjection()` with zero-width/bidi stripping, NFKC folding, Khmer injection/exfiltration rules, LLM role-framing markers, and Markdown/HTML exfil rules (`tests/security-adversarial-suite.test.ts`). |
| **AUD-08** | **Medium** | `engines/data-processing/src/pipeline.ts` | Fixed RFC 4180 multi-line quoted CSV corruption, duplicate/empty header acceptance, float drift in currency control totals (migrated to exact BigInt minor units per `FIN-POL-V1`), and negative number CSV escaping (`tests/data-pipeline-hardening.test.ts`). |
| **AUD-09** | **Medium** | `apps/api/src/app.ts` & `docker/Dockerfile.api` | Non-root container startup crashed (`EACCES` on `mkdir .local-data`) because local filesystem fallback initialized unconditionally even in `jwt-pg` PostgreSQL mode. Fixed to use in-memory local fallback when `jwt-pg` owns persistence; verified non-root UID `1000` (API) & `101` (Nginx). |
| **AUD-10** | **Low** | `platform/storage`, `engines/integration`, `engines/analytics`, `engines/data-processing` | Added path-containment + atomic temp-file-rename commits in `LocalFilesystemStorageAdapter`, workspace scoping in `runByIdempotency`, tenant check in local `rehydrateWorkflowFromDb`, LRU cache caps, and strict `rowCount` integer bounds + `enable_external_access=false` in DuckDB benchmarks. |

---

## 4. Residual Risks & Honesty Disclosures

1. **Pre-existing Moderate Advisory (`uuid <11.1.1` via `exceljs@4.4.0`):** `npm audit --omit=dev --audit-level=high` exits `0` (`0` high/critical). The 2 moderate `uuid` advisories are transitive inside `exceljs@4.4.0` (fix requires breaking downgrade to `exceljs@3.4.0`); track upstream `exceljs` updates before `SS-01`.
2. **Multi-Replica Distributed Rate Limiting Implemented (`RATE_LIMIT_STORE=postgres`):** `apps/api/src/rateLimit.ts` now supports atomic cross-replica rate limiting via `rate_limit_check_and_increment` (`SECURITY DEFINER` over `api_rate_limits` with direct table access revoked from `app_runtime`), defaulting to `"postgres"` in `NODE_ENV=production` + `jwt-pg` with bounded memory fallback on DB interruption. Edge WAF/CDN rate limiting remains recommended for volumetric L7 floods (`D3+`).
3. **Isolated Parser & Chromium Worker Container Implemented (`apps/workers`):** `@ai-office-suite/workers` (`apps/workers`, `docker/Dockerfile.workers`) isolates untrusted DOCX/XLSX/PPTX parsing and headless Chromium PDF rendering into memory-/timeout-bounded subprocesses (or a dedicated zero-secret, zero-DB worker service in `docker-compose.yml`), defaulting `ISOLATED_PARSER_WORKERS=true` in `NODE_ENV=production`.
4. **Founder-Gated Production Sign-Offs Preserved:** `D3`, `SS-01`, `DP-01`, `AN-01`, `PS-01`, `ENG-BI-01`, `XI-01`, `PPT-T06`, P1 BI/XI features, external cloud STT (`423`), and consented Khmer audio corpus remain gated pending founder review.
