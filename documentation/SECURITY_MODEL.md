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
   - Audit records redact sensitive keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`) and token patterns (`sk-*`, JWTs, `Bearer *`, private keys) before writing to JSONL.

## 2. Known Remaining Risks (Honest Disclosure)

- Local prototype header identity (`x-workspace-role`) is **not** production authentication — **must not** be exposed outside `127.0.0.1` prior to D2 auth integration.
- `mammoth` and `exceljs` parse untrusted XML/ZIP inputs in Node; keep dependencies patched and run parsers inside isolated worker containers (`apps/workers`) in D2+.
- Real multi-tenant database RLS and encrypted-at-rest object storage belong to D2/Stage 6.
