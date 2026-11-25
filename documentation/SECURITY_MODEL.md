# Security Model — AI Office Suite

**Phase:** D0/D1 Baseline (OWASP Top 10 for LLM/GenAI & OWASP WSTG Aligned)

## 1. Security Boundaries Implemented in Phase D1

1. **Server-Side RBAC & Tenant Isolation (`platform/authorization`)**
   - Every API endpoint checks `assertCanPerform(actor, resource, action)` and `assertTenantWorkspaceAccess(actor, doc.tenantId, doc.workspaceId)`.
   - `viewer` and `reviewer` roles are blocked (`403 FORBIDDEN_ROLE`) on document edits, AI apply, DOCX import, and version restore regardless of UI button state.
   - Cross-tenant reads fail closed (`403 TENANT_ISOLATION_DENIED`).
   - *D1 Caveat:* Actor identity in D1 uses local prototype headers (`x-workspace-role`, `x-tenant-id`); Phase D2 **must** replace this with signed HttpOnly cookie/JWT auth and `token_version` revocation extracted from the preserved parent repository.

2. **Prompt Injection & Untrusted Content Isolation (`packages/validation`)**
   - Both typed/spoken user commands AND the target document block or spreadsheet cells are scanned via `scanForPromptInjection()` before planning.
   - Attempts to override system instructions, execute shell/OS commands, exfiltrate secrets/env vars, or bypass RBAC/audit are rejected (`400 PROMPT_INJECTION_BLOCKED`) and logged to the append-only audit trail.

3. **File Upload & Macro Safety (`engines/file-conversion`, `engines/calculation`)**
   - Rejects `.docm`, `.dotm`, `.xlsm`, `.xlsb` extensions and verifies `PK\x03\x04` ZIP magic bytes, rejects encrypted/legacy OLE2 containers (`D0 CF 11 E0 A1 B1 1A E1`), enforces entry-count/decompressed-size bounds, blocks ZIP path-traversal entries (`..`, leading `/`), and detects external `*.rels` (`TargetMode="External"`) without fetching.
   - Scans unpacked archive entries for `vbaProject.bin`, `vbaData.xml`, and `.xlm` macro parts — immediately rejecting with `MACRO_CONTENT_BLOCKED` / `MACRO_WORKBOOK_BLOCKED`.
   - Never executes macros or resolves external workbook links.

4. **OWASP CSV Formula-Injection Defense (`engines/calculation/src/xlsxCsv.ts`)**
   - Text cells beginning with optional whitespace/control characters followed by `=`, `+`, `-`, `@`, or leading `\t`/`\r` are escaped with a leading single quote (`'`) on CSV export.

5. **Loopback-Only Provisional Auth Guard (`apps/api/src/server.ts`)**
   - Server refuses to start if `NODE_ENV === "production"` or `HOST` is non-loopback (`PROVISIONAL_AUTH_LOOPBACK_ONLY`), and emits `X-Auth-Mode: provisional-local-prototype`.

6. **Sandboxed Data Processing (`engines/data-processing/src/duckdbRunner.ts`)**
   - Allowlisted semantic operations only (no arbitrary AI-generated SQL). DuckDB enforces `memory_limit='512MB'`, `allow_unsigned_extensions=false`, and `enable_external_access=false` after staged load.

5. **Voice Is Not Authentication (`engines/speech`, `modules/ai`)**
   - Voice transcripts enter the exact same backend authorization, revision-conflict, selection-hash, and approval-confirmation pipeline as typed text commands.

6. **Append-Only Redacted Audit Log (`platform/audit`)**
   - Audit records redact sensitive keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`) and token patterns (`sk-*`, JWTs, `Bearer *`, private keys) before writing to JSONL, and PostgreSQL `audit_logs` revokes `UPDATE` and `DELETE` from `app_runtime`.

7. **Phase D2 PostgreSQL RLS & Identity (`platform/database`, `platform/identity`):**
   - `ENABLE` + `FORCE ROW LEVEL SECURITY` with fail-closed `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` enforced under non-superuser `app_runtime`.
   - Signed `HS256` JWTs paired with `HttpOnly; SameSite=Lax` cookies (`aios_session`), `Sec-Fetch-Site`/`Origin` CSRF checks on cookie mutations, and live database `users.status` + `token_version` epoch checks.

8. **FR-06 Presentation & FR-07 Intelligence Studio Controls (`PS-00` & `BI-00`):**
   - **PPTX Import Safety:** `validatePptxUploadBytes()` + `fflate` bounds block `.pptm`/macros/`vbaProject.bin`, OLE2 encrypted containers, ZIP traversal, and external `.rels` without network fetch.
   - **Export Disclosure:** `ExportDisclosurePolicy` strips hidden slides & speaker notes when prohibited by policy, and BI detail export is blocked (`403 UNDERLYING_EXPORT_DENIED`) when `canExportUnderlyingDetail = false`.
   - **DataScopePolicy, Cache Keying & Chart Sanitization:** Every BI query intersects requested filters with server `DataScopePolicy` (`allowedDepartments`, `allowedColumns`), includes `policyId:policyVersion` + scope in cache keys (`BI-T18`), revokes historical snapshot access immediately (`BI-T19`), and rejects unsafe `<script`/URI/callback payloads via `validateChartSpecSafety()`.

9. **FR-08 Cross-Module Integration Controls (`XI-00`):**
   - **BOLA & Linked-Object Authorization (`INT-T10`, `INT-T11`):** Creating or refreshing linked objects checks both source-read (dataset/columns/departments) and destination-write permissions; workflows re-evaluate actor revocation & RBAC before every step.
   - **Confidentiality Redaction in Dependency Graphs (`INT-T20`):** `inspectDependencies()` filters edges against classification, department, and column scope, omitting restricted artifact IDs and titles completely.
   - **Policy-Keyed Cache Invalidation (`INT-T24`):** Policy narrowing immediately evicts stale cached results so prior broader scopes never leak across policy versions.
   - **Digest-Bound Approval & Complete-File Export Disclosure (`INT-T17`, `INT-T19`, `INT-T21`, `INT-T22`):** Post-approval manifest edits invalidate approvals (`409 APPROVAL_INVALIDATED`); atomic PostgreSQL publication commits `xi_reporting_packages`, `xi_artifacts`, `audit_logs`, and `xi_outbox_events` together under `app_runtime` RLS; external PPTX exports verify scoped chart series only (`$80k`, zero unauthorized departments/invoice IDs/speaker notes).

## 2. Known Remaining Risks (Honest Disclosure)

- Prototype `.local-data/` header auth (`provisional-local`) remains loopback-only when used for legacy D1 tests; production paths must run exclusively under `authMode: "jwt-pg"`.
- `mammoth`, `exceljs`, and `fflate` parse untrusted OOXML/ZIP inputs in Node; keep dependencies patched and isolate file parsers inside worker containers (`apps/workers`) in production.
- Hosted cloud PostgreSQL `16/17`, KMS secret rotation, inference suppression thresholds, and Playwright UI E2E audits remain gated for D3/Stage 6.
