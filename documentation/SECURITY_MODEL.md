# Security Model — AI Office Suite

**Phase:** Stage 1–3 Consolidated Security Model (`D0`–`D2`, `G1`, 64-Finding Audit Remediation, V1.3 `PA-00`/`AIC-00`/`VI-00`, and V1.4 `RC-00`/`QE-00`/`TF-01` — OWASP ASVS, OWASP Top 10 for LLM/GenAI & OWASP WSTG Aligned)

## 1. Security Boundaries Implemented Across Stage 1–3

1. **Server-Side RBAC & Tenant Isolation (`platform/authorization`)**
   - Every API endpoint checks `assertCanPerform(actor, resource, action)` and `assertTenantWorkspaceAccess(actor, doc.tenantId, doc.workspaceId)`.
   - `viewer` and `reviewer` roles are blocked (`403 FORBIDDEN_ROLE`) on document edits, AI apply, DOCX import, and version restore regardless of UI button state.
   - Cross-tenant reads fail closed (`403 TENANT_ISOLATION_DENIED`).
   - *D1 -> D2 Progression:* Prototype loopback headers (`x-workspace-role`, `x-tenant-id`) remain restricted to loopback D1 fixtures only; `AUTH_MODE=jwt-pg` enforces signed HttpOnly cookie/JWT auth and `token_version` revocation.

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
   - Allowlisted semantic operations only (no arbitrary AI-generated SQL). DuckDB enforces bounded `memory_limit`, isolated `temp_directory` spill, `allow_unsigned_extensions=false`, and `enable_external_access=false` after staged load.

7. **Voice Is Not Authentication (`engines/speech`, `modules/ai`)**
   - Voice transcripts enter the exact same backend authorization, revision-conflict, selection-hash, and approval-confirmation pipeline as typed text commands.

8. **Append-Only Redacted Audit Log (`platform/audit`)**
   - Audit records redact sensitive keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`) and token patterns (`sk-*`, JWTs, `Bearer *`, private keys) before writing to JSONL, and PostgreSQL `audit_logs` revokes `UPDATE` and `DELETE` from `app_runtime`.

9. **Phase D2 PostgreSQL RLS & Identity (`platform/database`, `platform/identity`):**
   - `ENABLE` + `FORCE ROW LEVEL SECURITY` with fail-closed `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` enforced under non-superuser `app_runtime` / `aios_app` / `aios_pa00_app` roles.
   - Signed `HS256` JWTs paired with `HttpOnly; SameSite=Lax` cookies (`aios_session`), `Sec-Fetch-Site`/`Origin` CSRF checks on cookie mutations, and live database `users.status` + `token_version` epoch checks.

10. **FR-06 Presentation & FR-07 Intelligence Studio Controls (`PS-00` & `BI-00`):**
    - **PPTX Import Safety:** `validatePptxUploadBytes()` + `fflate` bounds block `.pptm`/macros/`vbaProject.bin`, OLE2 encrypted containers, ZIP traversal, and external `.rels` without network fetch.
    - **Export Disclosure:** `ExportDisclosurePolicy` strips hidden slides & speaker notes when prohibited by policy, and BI detail export is blocked (`403 UNDERLYING_EXPORT_DENIED`) when `canExportUnderlyingDetail = false`.
    - **DataScopePolicy, Cache Keying & Chart Sanitization:** Every BI query intersects requested filters with server `DataScopePolicy` (`allowedDepartments`, `allowedColumns`), includes `policyId:policyVersion` + scope in cache keys (`BI-T18`), revokes historical snapshot access immediately (`BI-T19`), and rejects unsafe `<script`/URI/callback payloads via `validateChartSpecSafety()`.

11. **FR-08 Cross-Module Integration Controls (`XI-00`):**
    - **BOLA & Linked-Object Authorization (`INT-T10`, `INT-T11`):** Creating or refreshing linked objects checks both source-read (dataset/columns/departments) and destination-write permissions; workflows re-evaluate actor revocation & RBAC before every step.
    - **Confidentiality Redaction in Dependency Graphs (`INT-T20`):** `inspectDependencies()` filters edges against classification, department, and column scope, omitting restricted artifact IDs and titles completely.
    - **Policy-Keyed Cache Invalidation (`INT-T24`):** Policy narrowing immediately evicts stale cached results so prior broader scopes never leak across policy versions.
    - **Digest-Bound Approval & Complete-File Export Disclosure (`INT-T17`, `INT-T19`, `INT-T21`, `INT-T22`):** Post-approval manifest edits invalidate approvals (`409 APPROVAL_INVALIDATED`); atomic PostgreSQL publication commits `xi_reporting_packages`, `xi_artifacts`, `audit_logs`, and `xi_outbox_events` together under `app_runtime` RLS; external PPTX exports verify scoped chart series only (`$80k`, zero unauthorized departments/invoice IDs/speaker notes).

12. **Sprint & Audit Hardening Controls (`documentation/SECURITY_AUDIT_REPORT.md`):**
    - **Headless Chromium CSS/SSRF Lockdown:** Strict allowlist sanitizers for CSS colors/fonts and raster-only base64 image URIs (`pdfExporter.ts`, `slidePdfRenderer.ts`), offline `<meta Content-Security-Policy: default-src 'none'>`, and Chromium offline flags block CSS injection and metadata SSRF.
    - **Auth Timing, Rate Limiting & HTTP Headers:** Constant-time dummy bcrypt check on unknown emails eliminates user-enumeration timing side-channels; memory-bounded sliding-window rate limits (`429 RATE_LIMITED`) protect `/api/auth/login` (IP+email bucket) and write/export endpoints; strict Helmet CSP (`default-src 'none'; frame-ancestors 'none'`) and `Cache-Control: no-store` protect API responses.
    - **Bilingual & Obfuscation-Resistant Prompt Safety:** `scanForPromptInjection()` strips zero-width/bidi characters, NFKC-folds text, and detects Khmer injection/exfiltration directives, LLM role-framing tokens, and Markdown/HTML exfil links.
    - **Durable Tenant-RLS AI Ledger & Concurrency Safety:** `ai_applied_operations` enforces `FORCE ROW LEVEL SECURITY` and revokes `UPDATE`/`DELETE` from `app_runtime`; `documents` row locks run without `JOIN` to avoid PostgreSQL `READ COMMITTED` EvalPlanQual phantom 404s.
    - **Data Pipeline Isolation & BigInt Reconciliation:** `DataPreparationPipeline` scopes idempotency/history caches by `tenantId::workspaceId`, enforces RFC 4180 multi-line CSV bounds + header uniqueness, and reconciles currency totals via exact BigInt minor units (`FIN-POL-V1`).

13. **V1.3 Integrated Governance Controls (`PA-00` / `AIC-00` / `VI-00`):**
    - **Centralized Policy & Restricted Workspace Isolation (`platform/authorization`):** `PolicyDecisionEngine` enforces identical tenant/workspace boundaries, MFA step-up assurance, 8-role RBAC (`billing_admin` and `auditor` excluded from confidential content), restricted-workspace `workspaceContentGrant` checks (blocking ungranted org admins from Payroll), and commercial entitlements across `manual`, `typed_ai`, `voice_command`, and `workflow` sources.
    - **Hashed Invitations, Sole-Owner Guard & Atomic Quotas (`platform/database`):** `pa_invitations` stores only SHA-256 token hashes and redacts raw tokens from audit metadata; `pa_tenant_subscriptions` row locks (`FOR UPDATE`) serialize seat-limit and quota reservations; `pa_usage_ledger` revokes `UPDATE`/`DELETE` from `app_runtime`; `pa_jobs` enforces monotonic `fencing_generation` + `lease_token` checks against split-brain commits; all 9 `pa_*` tenant tables enforce `FORCE ROW LEVEL SECURITY`.
    - **Private Versioned Object Storage (`platform/storage`):** `LocalPrivateObjectStore` enforces strict tenant/workspace key prefixes, path-containment guards, SHA-256 verification on read, short-lived HMAC-signed download tokens bound to tenant/workspace/object, quarantine blocking (`423`), and legal-hold purge protection.
    - **Fail-Closed AI Routing & Two-Stage RAG ACL (`modules/ai`):** `ModelRoutingPolicyEngine` fails closed on missing policies, keeps external LLMs locked (`423`), and blocks privacy-unsafe failover (`PRIVACY_UNSAFE_FAILOVER_BLOCKED`). `CorporateKnowledgeIndex` applies ACL pre-filtering before context assembly, sanitizes indirect prompt-injection lines, and re-verifies live revocation tombstones during `recheckCitations()`.
    - **Voice State Machine, Dictation Isolation & Ephemeral Audio (`engines/speech`):** `VoiceSessionManager` enforces legal transitions, deduplication, late-partial drops, inactivity expiry, actor sign-out/UI-close termination, hardware/network interruption recovery, and zero-retention audio wiping; dictation mode never executes spoken imperatives; `validateVoiceCriticalFields()` enforces currency/FX-rate/period/target disambiguation; cloud STT and P1 `VOC-03` features stay fail-closed (`423`).

14. **V1.4 Consolidation & Supply-Chain Security Controls (`RC-00` / `QE-00` / `TF-11`):**
    - **Backup/Restore Privilege-Preservation Fix (`PLT-T35`, `GOV-T08`, `RC-T06`):** `restorePaExtendedLogicalBackup` (`platform/database/src/governanceRepository.ts`) explicitly restores PA-00 additive core columns (`organizations.mfa_required_for_privileged`, `workspaces.visibility`, `memberships.status`, `memberships.content_access`) inside the restore transaction so revoked memberships and restricted Payroll workspaces can never revert to default active/standard state on recovery.
    - **Pre-Activation AI Model Upgrade Regression Gate (`AI-T24`, `NFR-T38`):** `evaluateModelUpgradeRegression()` (`modules/ai/src/providers.ts`) blocks model upgrades before activation whenever accuracy, structured-output, bilingual parity, or safety checks regress.
    - **CycloneDX 1.5 SBOM & Supply-Chain Hygiene (`NFR-T37`):** Zero-dependency `scripts/generate-sbom.mjs` (`npm run sbom`) emits CycloneDX 1.5 JSON (`620` components, `358` runtime required, `purl`, SPDX licenses, SHA-512 SRI hashes) alongside `scripts/check-licenses.mjs`, `scripts/check-hygiene.mjs`, and `npm audit --omit=dev --audit-level=high` (`0` high/critical production advisories).

## 2. Known Remaining Risks (Honest Disclosure)

- Prototype `.local-data/` header auth (`provisional-local`) remains loopback-only when used for legacy D1 tests; production deployments run exclusively under `AUTH_MODE=jwt-pg` (enforced fail-closed in `apps/api/src/server.ts`).
- `mammoth`, `exceljs`, and `fflate` parse untrusted OOXML/ZIP inputs in Node; pre-decompression `fflate` filters block zip bombs/macros/traversal, and parsers should move into isolated worker containers (`apps/workers`) prior to pilot (`D8`/`D9`).
- Multi-replica distributed rate limiting (Redis/WAF), hosted cloud PostgreSQL `16/17` KMS secret rotation, inference suppression thresholds, and Playwright UI E2E audits remain gated for `D3`/`D8`.

