# Overnight Hardening Report — Linux/CI Portability, PostgreSQL 16 RLS Verification & Security Hardening

**Date:** 2026-11-25  
**Branch:** `overnight/linux-ci-pg-hardening` (cut from `main` @ `909a72a`)  
**Environment:** Ubuntu 24.04 Linux (`x86_64`), Node `v22.23.5`, npm `12.2.2`, Docker `29.10.0` (`postgres:16-alpine` -> `PostgreSQL 16.16`), Google Chrome (`/usr/bin/google-chrome`, HarfBuzz PDF/PNG rendering enabled)

---

## 1. Executive Summary & CI/Linux Readiness Verdict

**Verdict: READY FOR LINUX CI (`ubuntu-latest`) & REVIEW.**

Before this overnight run, `.github/workflows/ci.yml` (which runs on `ubuntu-latest`) failed at four separate gates on Linux:
1. `npm ci --no-audit --no-fund` failed with `EUSAGE` because `@ai-office-suite/integration-engine@0.1.0-xi00` was missing from `package-lock.json`.
2. `npm run lint:licenses` failed on Linux because `nodejs-polars-linux-x64-gnu@0.26.2` declares `"SEE LICENSE IN LICENSE"` (verified MIT in `node_modules/nodejs-polars/LICENSE`).
3. `npm run build` exited `127` (`npm.cmd: not found`) because `package.json` hardcoded Windows `npm.cmd`.
4. Headless Chromium PDF/PNG rendering constructed invalid 4-slash `file:////tmp/...` URLs on POSIX and searched only Windows `msedge.exe`/`chrome.exe` paths.

All four Linux/CI blockers are fixed, real **PostgreSQL 16.16** RLS/privilege/concurrency/backup-restore behavior was verified against a live Docker instance (catching and fixing two real PGlite-vs-PG16/privilege gaps and one logical backup-restore defect), **22 security, financial-precision, OOXML/ZIP-bomb, BI cache-isolation, and cross-engine hardening fixes** were landed with targeted regression tests, and `apps/web` was audited and aligned with the real `apps/api` (`jwt-pg` HttpOnly cookie + CSRF + `409` conflict + RBAC) contract.

**Final combined test score:** **14/14 test files, 42/42 tests passing** (`13 passed | 1 skipped` in default self-contained `npm test` + `1 passed (4/4)` in `TEST_POSTGRES_URL`-gated live PostgreSQL 16.16 Docker verification).  
**License & security posture:** `0` disallowed licenses (`467` packages scanned, `47` direct), `0` high/critical production advisories (`npm audit --omit=dev --audit-level=high` exits `0`), `0` TypeScript errors, `0` legacy naming matches, `0` tracked secrets/`.env`/`.local-data`/audio files.

> **Environment note:** `.github/workflows/ci.yml` pins `node-version: "24.22.3"`, whereas this cloud VM ran Node `v22.23.5` / npm `12.2.2`. All 6 CI commands match `.github/workflows/ci.yml` verbatim and passed on Ubuntu 24.04.

---

## 2. Commit-by-Commit Log & Modified Files

| Phase | Commit | Summary | Key Modified / Added Files |
| :--- | :--- | :--- | :--- |
| **Phase 0** | `95eb14e` | `fix(ci): make scripts, lockfile, license audit, and headless browser paths Linux/cross-platform portable` | `package.json`, `package-lock.json`, `scripts/dev.mjs`, `scripts/check-licenses.mjs`, `engines/file-conversion/src/pdfExporter.ts`, `engines/presentation/src/slidePdfRenderer.ts`, `engines/intelligence/src/chartAdapters.ts`, `engines/speech/src/fasterWhisper.ts`, `tests/d1-docx-pdf-roundtrip.test.ts`, `tests/d1-vertical-slice-api.test.ts`, `tests/g1-bi00-intelligence-feasibility.test.ts`, `tests/g1-ps00-presentation-feasibility.test.ts` |
| **Phase 1** | `f8a03b2` | `feat(db): verify real PostgreSQL 16 RLS, harden immutable revision privileges, and fix backup/restore` | `platform/database/src/adapter.ts`, `platform/database/src/schema.ts`, `platform/database/src/documentRepository.ts`, `platform/database/src/localDataMigrator.ts`, `engines/integration/src/pgPersistence.ts`, `tests/d2-live-postgres16-rls.test.ts` *(new)*, `tests/d2-platform-pg-auth.test.ts` |
| **Phase 2** | `cfd9df5` | `security(engines,api): harden auth/RBAC, AI tenant isolation, OOXML zip-bombs, BigInt precision & BI cache isolation` | `platform/identity/src/authService.ts`, `platform/audit/src/index.ts`, `modules/documents/src/index.ts`, `modules/ai/src/executor.ts`, `apps/api/src/app.ts`, `engines/analytics/src/precision.ts`, `engines/calculation/src/formulaEngine.ts`, `engines/calculation/src/xlsxCsv.ts`, `engines/data-processing/src/pipeline.ts`, `engines/file-conversion/src/docxImporter.ts`, `engines/presentation/src/pptxImporter.ts`, `engines/document/src/documentEngine.ts`, `engines/intelligence/src/intelligenceEngine.ts`, `engines/integration/src/integrationEngine.ts`, `tests/security-precision-edge-hardening.test.ts` *(new)* |
| **Phase 3** | `0f44e16` | `fix(web): align workspace UI with jwt-pg cookies, 409 conflict UX, Khmer editing, and RBAC` | `apps/web/src/App.tsx`, `apps/web/src/components/AiVoicePanel.tsx`, `apps/web/src/components/DocumentEditor.tsx`, `apps/web/src/components/VersionAuditDrawer.tsx`, `apps/web/src/styles.css` |
| **Phase 4** | *(this commit)* | `docs(report): add OVERNIGHT_REPORT.md with final verification matrix` | `OVERNIGHT_REPORT.md` *(new)* |

---

## 3. Linux/CI Portability & Real PostgreSQL 16.16 Verification Evidence

### 3.1 Linux/CI Portability Fixes (Phase 0)
- **Lockfile sync (`package-lock.json`):** Added only the missing local workspace entry for `@ai-office-suite/integration-engine@0.1.0-xi00` (`+22` lines, zero third-party dependency version drift). New SHA-256: `fb526655001e8a2e316c6d70037af1c525599094f64c2ef072c5edcbefa740f0`.
- **Cross-platform npm scripts:** Replaced Windows-only `npm.cmd` in `package.json` (`build`, `build:web`, `dev:web`) with `npm`; updated `scripts/dev.mjs` to choose `npm.cmd` on `win32` and `npm` on POSIX.
- **License policy portability (`scripts/check-licenses.mjs`):** Verified `node_modules/nodejs-polars/LICENSE` is pure MIT and allowlisted all 8 optional native platform targets of `nodejs-polars@0.26.2` (`linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`, `win32-arm64-msvc`) under `VERIFIED_LEGACY_TRANSITIVE`.
- **POSIX `file://` URLs & browser/tool detection:** Switched manual `` `file:///${htmlPath}` `` concatenation (which produced invalid `file:////tmp/...` URLs on Linux/macOS) to Node's `pathToFileURL(htmlPath).href` in `pdfExporter.ts`, `slidePdfRenderer.ts`, and `chartAdapters.ts`. Expanded `detectChromiumBinary()` to check `CHROMIUM_PATH` / `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH`, standard Linux/macOS/Windows paths, and `PATH`; added `detectLibreOfficeBinary()`; fixed `resolveLocalSpeechPython()` in `fasterWhisper.ts` to support POSIX `.venv-speech/bin/python3|python` and guard undefined `LOCALAPPDATA`.
- **Graceful browser-absent disclosure:** Tests requiring Chromium/Edge HarfBuzz PDF/PNG rendering run in full whenever Chromium/Chrome/Edge is detected (executed in full on this VM via `/usr/bin/google-chrome`) and gracefully skip with explicit disclosure if no headless browser binary exists on a minimal runner.

### 3.2 Real PostgreSQL 16.16 Docker Verification Evidence (Phase 1 & Phase 4)
Executed `tests/d2-live-postgres16-rls.test.ts` (gated behind `TEST_POSTGRES_URL` so default `npm test` remains fast and Docker-free) against a clean disposable `postgres:16-alpine` container (`PostgreSQL 16.16 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit`):
- **Catalog & role verification:** Confirmed `app_runtime` has `rolsuper = false` and `rolbypassrls = false`, and all 12 tenant-scoped tables (`workspaces`, `memberships`, `documents`, `document_versions`, `audit_logs`, `xi_registry_entries`, `xi_linked_objects`, `xi_workflow_runs`, `xi_artifact_revisions`, `xi_package_approvals`, `xi_sync_events`, `xi_outbox_events`) have `relrowsecurity = true` AND `relforcerowsecurity = true`.
- **Fail-closed RLS across reads, JOINs, INSERTs, UPDATEs:** Verified `app_runtime` returns `0` rows when `app.current_tenant_id` is unset; cannot see Tenant B documents via direct `SELECT` or `JOIN` across `documents` + `document_versions` + `audit_logs`; cannot `INSERT` into Tenant B (`42501` RLS violation) or `UPDATE` Tenant B rows (`0` rows affected).
- **Append-only immutability enforcement:** Verified PostgreSQL 16 rejects (`42501 permission denied`) `UPDATE` and `DELETE` by `app_runtime` on `audit_logs`, `document_versions`, and `xi_artifact_revisions`, as well as `DELETE` on `xi_outbox_events` and `xi_package_approvals`.
- **Pooled connection isolation (`max: 2`):** Ran 20 concurrent interleaved Tenant A & Tenant B `withTenantTransaction` operations — including deliberate mid-transaction rollbacks — on a 2-connection `pg` pool (`NodePgDatabaseAdapter`); verified zero tenant context bleed across connection reuse.
- **Atomic `409` concurrency, JWT + CSRF + `token_version` revocation:** Executed a 5-way concurrent `PUT /api/documents/:id` race (`expectedRevision: 1`) against `apps/api` (`authMode: "jwt-pg"`); exactly 1 succeeded (`200`, `revision: 2`) and 4 received `409 REVISION_CONFLICT`. Verified `aios_session` HttpOnly cookie auth, CSRF rejection on untrusted `Origin`, and immediate rejection (`401`) after `POST /api/auth/revoke-sessions`.
- **Cross-module integration (`engines/integration`) on real PG16:** Verified `xi_*` RLS isolation, durable workflow crash/rehydrate recovery, rolled-back failed publication transactions leaving zero partial rows/outbox events, and atomic `commitPackagePublicationTx` with `xi_outbox_events` emission.
- **Reversible `.local-data/` migration & cross-DB logical backup/restore:** Verified `dry-run` -> `apply` -> `rollback` -> `re-apply` and full JSON logical backup/restore into a second clean PostgreSQL 16 database (`aios_restore_target`), asserting exact row-for-row parity including `audit_logs`, `published_revision`, `source_import_sha256`, and `restored_from_revision`.
- **Container hygiene:** Disposable container removed immediately via trap; verified `0` remaining `aios-pg16` containers.

---

## 4. Security, Precision, Edge-Case & Web UI Bugs Fixed

| # | Severity | Area | Root Cause | Fix Implemented | Covering Test / Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **High** | `platform/database`, `engines/integration` | `app_runtime` held `UPDATE` privilege on immutable `document_versions` and `xi_artifact_revisions` tables (caught during real PG16 verification). | Explicitly `REVOKE UPDATE, DELETE` on `document_versions` (`schema.ts`) and `xi_artifact_revisions` (`pgPersistence.ts`) from `app_runtime`. | `tests/d2-live-postgres16-rls.test.ts`, `tests/d2-platform-pg-auth.test.ts` |
| 2 | **High** | `modules/ai/src/executor.ts` | Idempotency map `appliedOperations` was keyed only by `operationId`, allowing a cross-tenant caller knowing/guessing an `operationId` to retrieve another tenant's `StudioDocument` (BOLA); also trusted client-controlled `proposal.requiresApproval` flag. | Scoped key to `${tenantId}::${workspaceId}::${documentId}::${operationId}` and unconditionally enforced `if (!approved)` server-side. | `tests/security-precision-edge-hardening.test.ts` (§2.1) |
| 3 | **High** | `apps/api/src/app.ts` | In `jwt-pg` mode: (a) `/api/speech` lacked `jwtMiddleware`; (b) `POST /api/auth/logout` lacked cookie CSRF validation; (c) 9 document sub-routes (`seed-bilingual-fixture`, `versions`, `restore`, `ai/plan`, `ai/apply`, `import/docx`, `export/docx`, `export/pdf`, `audit`) fell back to local filesystem storage instead of `pgRepo` (PostgreSQL RLS). | Mounted `jwtMiddleware` on `/api/speech`; enforced `verifyCookieCsrf` on cookie-authenticated `/api/auth/logout`; routed all document endpoints through `PostgreSqlDocumentRepository` (adding `listVersions`, `getVersion`, `restoreVersion`, `recordAudit`, `listAuditEvents` under `app_runtime` RLS); sanitized `Content-Disposition` filenames. | `tests/security-precision-edge-hardening.test.ts` (§2.1), `tests/d2-live-postgres16-rls.test.ts` |
| 4 | **High** | `modules/documents/src/index.ts` | `exportDocx` and `exportPdf` checked `export:read` instead of `export:export`, allowing `viewer` role to export documents despite RBAC policy denying exports to viewers. | Changed permission checks to `assertCanPerform(actor, "export", "export")` across both `DocumentService` and `apps/api` `jwt-pg` handlers. | `tests/security-precision-edge-hardening.test.ts` (§2.1) |
| 5 | **High** | `engines/file-conversion`, `engines/presentation`, `engines/calculation`, `engines/data-processing` | `docxImporter`, `pptxImporter`, `xlsxCsv`, and `stageXlsxSource` either validated ZIP entries *after* full decompression (exposing memory to zip bombs) or passed raw XLSX buffers straight to `ExcelJS` without checking traversal, macros, OLE2/encrypted packages, or entry bounds. | Added fail-fast `fflate` `filter` pre-decompression guards across all 4 OOXML importers rejecting zip bombs (>25MB entry / >64MB total / >100x ratio on >1MB), excessive entry counts, path traversal (`..`, drive letters, NUL bytes), `EncryptedPackage`/OLE2, and VBA/XLM macro parts before inflation or parser invocation. | `tests/security-precision-edge-hardening.test.ts` (§2.2, §2.3) |
| 6 | **High** | `engines/intelligence/src/intelligenceEngine.ts` | `policyResultCache` omitted `principalRole` and `allowedColumns` from the cache key and was not evicted on `revokePrincipalAccess`; several methods (`drillToPermittedDetail`, `publishSnapshot`, `exportFilteredSummaryCsv`, `createLinkedPresentationFromDashboard`) did not verify `policy.tenantId` / workspace isolation. | Included `principalRole` + sorted `allowedColumns` in cache key; added tenant cache eviction in `revokePrincipalAccess`; enforced `policy.tenantId` + `assertTenantWorkspaceAccess` across all BI query/export/handoff methods; checked `getReport` existence before mutating `latestSeqByReportActor`. | `tests/security-precision-edge-hardening.test.ts` (§2.4) |
| 7 | **Medium** | `platform/identity/src/authService.ts` | Malformed non-UUID claims inside a signed JWT caused PostgreSQL `22P02` cast errors (HTTP 500) instead of `401`; `createJwtAuthMiddleware` did not check `organizations.status = 'active'`, allowing suspended-org tokens to keep working until expiry. | Validated UUID format on `sub`, `tenant_id`, and `workspace_id` in `verifySessionToken` (returns `null` -> `401`); joined `organizations` in `createJwtAuthMiddleware` to reject suspended organizations (`403 ORGANIZATION_SUSPENDED`). | `tests/security-precision-edge-hardening.test.ts` (§2.1) |
| 8 | **Medium** | `platform/audit/src/index.ts` | `redactForAudit` missed `cookie`/`set-cookie`/`session`/`jwt`/`credentials` keys, bare 3-part JWT strings, and `aios_session=` values inside prose. | Broadened `SENSITIVE_KEY_PATTERN` and added regex redaction for 3-part JWTs and `aios_session=` tokens. | `tests/security-precision-edge-hardening.test.ts` (§2.1) |
| 9 | **Medium** | `platform/database/src/localDataMigrator.ts` | `restoreLogicalBackupSnapshot` did not restore `audit_logs` or preserve `documents.published_revision`, `document_versions.source_import_sha256`, and `restored_from_revision` (caught on real PG16 restore drill). | Updated restore routine to preserve all columns and restore `audit_logs` rows inside the superuser maintenance transaction. | `tests/d2-live-postgres16-rls.test.ts`, `tests/d2-platform-pg-auth.test.ts` |
| 10 | **Medium** | `platform/database/src/adapter.ts` & `documentRepository.ts` | Failed `ROLLBACK` on a broken pooled client could return a poisoned client back to the `pg` pool; invalid non-UUID document IDs in `pgRepo` caused PG `22P02` 500 errors. | Passed rollback error to `client.release(rbErr)` so `pg-pool` destroys compromised connections; validated UUID format in `PostgreSqlDocumentRepository` (returns `404 DOCUMENT_NOT_FOUND`). | `tests/d2-live-postgres16-rls.test.ts`, `tests/security-precision-edge-hardening.test.ts` |
| 11 | **Medium** | `engines/analytics/src/precision.ts` | Huge scientific-notation exponents (e.g., `1e9999999`) could trigger massive `BigInt` allocations (DoS); `parseDecimalToMinorUnits` lacked configurable `HALF_UP`/`HALF_EVEN` rounding; `divideExactScaled` did not validate `outScale`; `convertCurrencyMinorUnits` skipped `MAX_ABS_MINOR` overflow guard. | Bounded exponents (`|expShift| <= 100`, `targetShift <= 36` -> `NUMERIC_OVERFLOW`), added `roundingMode` support, validated `outScale` (`0..18`), and enforced `MAX_ABS_MINOR` on FX results. | `tests/security-precision-edge-hardening.test.ts` (§2.2) |
| 12 | **Medium** | `engines/calculation/src/formulaEngine.ts` | Unbounded `expandRange` (`A1:ZZ10000`) risked OOM DoS; `ROUND(-1.5, 0)` / `ROUND(1.005, 2)` suffered JS float rounding drift; `VLOOKUP`/`ROUND` swallowed upstream `#DIV/0!`/`#REF!` errors; unknown cross-sheet refs did not emit `#REF!`; outer-paren stripping wasn't quote-aware. | Capped `expandRange` at 250k cells (`#REF!`), implemented exact decimal away-from-zero `ROUND`, propagated formula errors in `VLOOKUP`/`ROUND`, verified target sheet existence, and made outer-paren stripping quote-aware. | `tests/security-precision-edge-hardening.test.ts` (§2.2) |
| 13 | **Medium** | `engines/calculation/src/xlsxCsv.ts`, `engines/data-processing/src/pipeline.ts`, `engines/intelligence/src/intelligenceEngine.ts` | CSV export missed RFC 4180 quoting for `\r`; BI CSV formula-injection check missed leading `\t`/`\r`; CSV ingestion kept UTF-8 BOM on the first header and `\r` line endings. | Quoted `\r` in RFC 4180 CSV export; neutralized leading `\t`/`\r`/`=`/`+`/`-`/`@` in BI CSV; stripped UTF-8 BOM and `\r` in `stageCsvSource`. | `tests/security-precision-edge-hardening.test.ts` (§2.2, §2.4) |
| 14 | **Medium** | `engines/document/src/documentEngine.ts` | `undo_last` accepted `priorRevisionDoc` without verifying matching `documentId`, `tenantId`, and `workspaceId`. | Added strict ownership/identity verification (`409 UNDO_SNAPSHOT_MISMATCH`). | `tests/security-precision-edge-hardening.test.ts` (§2.3) |
| 15 | **Medium** | `engines/integration/src/integrationEngine.ts` & `pgPersistence.ts` | `modifyStagedPackageAfterApproval` lacked `document:write` RBAC check; repeated `publishReportingPackage` with the same `idempotencyKey` was not strictly idempotent; `loadWorkflowRunRow` assumed JSONB column was always parsed object. | Enforced `document:write` RBAC; added strict idempotent replay returning prior publication/outbox metadata; normalized string/object JSONB parsing. | `tests/security-precision-edge-hardening.test.ts` (§2.4), `tests/d2-live-postgres16-rls.test.ts` |
| 16 | **Medium** | `apps/web/src/App.tsx` & `AiVoicePanel.tsx` | Web UI was hardcoded to prototype headers without `credentials: "include"`, lacked `jwt-pg` login/session restore/revoke flows, re-fetched `/api/documents` in a redundant loop on selection change, did not handle `409 REVISION_CONFLICT` recovery or `401` expiry, allowed `viewer` to click disabled-server-side Export buttons, and retained stale AI proposals across revisions. | Auto-detects `authMode` via `/api/health`, uses HttpOnly `aios_session` cookie (`credentials: "include"`) without sending prototype headers in `jwt-pg` mode, adds Sign-In / Sign-Out / Revoke All UI, fixes fetch loop via `activeDocIdRef`, adds `409` recovery banner (`Reload Latest Revision`), disables Export for `viewer`, auto-clears stale AI proposals on revision change, stops microphone streams on unmount, and renders explicit `isMock: true` & HTTP `423` disclosure. | `npm run typecheck`, `npm run build:web` |
| 17 | **Low** | `apps/web/src/components/DocumentEditor.tsx`, `VersionAuditDrawer.tsx`, `styles.css` | Editor reset Tiptap content on every keystroke (clobbering Khmer cursor/IME composition), used stale closure refs, lacked Khmer grapheme counting & NFC normalization, and drawer lacked modal accessibility (`Escape`/backdrop close, loading/empty states). | Syncs Tiptap only on `documentId:revision` change (`lastSyncedKeyRef`), normalizes NFC + counts Khmer graphemes via `Intl.Segmenter("km", { granularity: "grapheme" })`, enforces HarfBuzz-safe CSS (`letter-spacing: 0; word-break: normal; font-kerning: normal`), adds H3/numbered/justify & landscape styling, and adds accessible modal dialog + loading/empty/busy states. | `npm run typecheck`, `npm run build:web` |

---

## 5. Full Final Verification Matrix

All checks below were executed after the final code commit (`0f44e16`):

| Check | Exact Command | Exit Code | Observed Result |
| :--- | :--- | :---: | :--- |
| **License Policy Audit** | `npm run lint:licenses` | `0` | **PASS** — `467` third-party packages (`47` direct), **`0` disallowed** (`jszip@3.10.2` permissive MIT branch selected). |
| **Production Vulnerability Audit** | `npm audit --omit=dev --audit-level=high` | `0` | **PASS (high+)** — **`0` high/critical** advisories (`2` pre-existing moderate `uuid <11.1.1` transitive via `exceljs@4.4.0`, documented in `DEVELOPMENT_STATUS.md`). |
| **Workspace Typecheck** | `npm run typecheck` | `0` | **PASS** — `tsc -p tsconfig.typecheck.json --noEmit` (`0` errors). |
| **Linux Production Build** | `npm run build` | `0` | **PASS** — `build:api` (`tsc -p apps/api/tsconfig.build.json`) + `build:web` (`107` Vite modules incl. Khmer `.woff2` bundles, `4.61s`). |
| **Default Test Suite** | `npm test` | `0` | **PASS** — **`13 passed \| 1 skipped (14)` files, `38 passed \| 4 skipped (42)` tests** in `76.44s` (1 skipped file is the `TEST_POSTGRES_URL`-gated live Docker PG16 suite). |
| **Live PostgreSQL 16.16 Docker Suite** | `TEST_POSTGRES_URL="postgres://postgres:aios_test_pg16@127.0.0.1:55432/aios_test" npx vitest run tests/d2-live-postgres16-rls.test.ts` | `0` | **PASS** — **`1 passed (1)` file, `4 passed (4)` tests** in `7.93s` against `PostgreSQL 16.16 on x86_64-pc-linux-musl`; container removed cleanly (`0` remaining). |
| **Legacy Naming Scan** | Hygiene check across repository | `0` | **PASS** — **`0` legacy project naming matches**. |
| **Secrets & Forbidden Files Scan** | `git ls-files` + diff pattern scan + `git status` | `0` | **PASS** — **`0` tracked `.env` (only `.env.example`), `0` `.local-data/`, `0` audio files, `0` real secrets/private keys**, clean working tree (regenerated `tests/artifacts/*` restored via `git checkout -- tests/artifacts/`). |

---

## 6. Governance, License & Open Founder-Gated Decisions (Preserved Intact)

All existing governance and phase boundaries from `documentation/DEVELOPMENT_STATUS.md`, `documentation/DEVELOPMENT_ROADMAP.md`, and `security/DEPENDENCY_LICENSE_POLICY.md` were strictly respected:
- **Zero new third-party dependencies added**; zero GPL-only / AGPL / commercial-restricted licenses introduced.
- **Honest speech/LLM boundaries intact:** External cloud speech adapters (`google-cloud-stt-v2`, `azure-speech`) remain fail-closed (`423`), local `MockSpeechAdapter` remains explicitly marked (`isMock: true`) in both API responses and Web UI notices, and zero live Khmer speech benchmarks were fabricated.
- **Open Founder-Gated Decisions (unchanged, awaiting Founder/CTO sign-off):**
  1. **Production Phase Gates:** `D3`, `SS-01`, `DP-01`, `AN-01`, `PS-01`, `ENG-BI-01`, and `XI-01..XI-10` remain gated pending review of `documentation/PS00_BI00_EVIDENCE_PACKET.md`, `documentation/XI00_INTEGRATION_EVIDENCE_PACKET.md`, and upcoming FR-09/FR-10 specifications.
  2. **Desktop PowerPoint / LibreOffice Impress Verification (`PPT-T06`):** Real desktop viewer opening and manual chart editability inspection remain pending an Office-equipped test machine prior to `PS-01`.
  3. **P1 Features (`BI-T33`, `BI-T34`, `INT-04.01..03`):** Governed BI alerts, scheduled refreshes, visual workflow builder, and external connectors remain pending P1 authorization.
  4. **Commercial Vendor Quotes:** Tiptap Pages, Univer Pro, Handsontable + HyperFormula, and optional ONLYOFFICE Developer quotes remain pending prior to `D3`/`SS-01` commitment.
  5. **Consented Native Khmer (`km-KH`) Live Speech Corpus:** Required before live Khmer WER/CER evaluation or cloud STT activation.

---

## 7. Review & Merge Commands

To review the Draft PR locally, re-run the full verification suite (including optional live PostgreSQL 16 Docker verification), and merge into `main` once approved:

```bash
# 1. Fetch and inspect the overnight branch
git fetch origin
git checkout overnight/linux-ci-pg-hardening
git log --oneline main..HEAD
git diff --stat main..HEAD

# 2. Re-run standard CI verification
npm ci --no-audit --no-fund
npm run lint:licenses
npm run typecheck
npm run build
npm test
npm audit --omit=dev --audit-level=high

# 3. (Optional) Re-run live PostgreSQL 16 Docker verification
docker run -d --rm --name aios-pg16-review \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=aios_test_pg16 -e POSTGRES_DB=aios_test \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_POSTGRES_URL="postgres://postgres:aios_test_pg16@127.0.0.1:55432/aios_test" \
  npx vitest run tests/d2-live-postgres16-rls.test.ts
docker rm -f aios-pg16-review

# 4. When satisfied, mark Draft PR ready and merge via GitHub UI or gh CLI
gh pr ready
gh pr merge --merge
```
