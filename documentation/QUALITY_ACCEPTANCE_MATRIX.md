# Quality Acceptance Matrix (`FR-12` / `QE-00`) — AI Office Suite

- **Scope:** Consolidated Non-Functional Requirements (`NFR-01`..`NFR-04`, 40 subrequirements `NFR-01.01..NFR-04.12`) and Acceptance Scenarios (`NFR-T01..NFR-T40`) from Main Research & Engineering Report V1.4.
- **Assessment Baseline:** Local bounded `QE-00` + Zero-Cost Stage 4 (`TF-04`, `TF-11`) on branch `feasibility/v1.4-rc00-qe00-tf01-tf04-tf11`.

---

## 1. Live Measured `QE-00`, `TF-04` & `TF-11` Quality Baseline

| Quality Dimension | Command / Harness | Measured Local Result | Release / Production Gate Status |
| :--- | :--- | :--- | :--- |
| **Static Hygiene & Secret Guard** | `npm run lint:hygiene` | PASS (`0` forbidden tracked artifacts, active `isMock=true` & `423` guards intact) | Local gate verified |
| **Supply-Chain License Gate** | `npm run lint:licenses` | PASS (`0` AGPL/GPL-only/commercial-restricted dependencies) | Preliminary gate (not legal clearance) |
| **CycloneDX 1.5 SBOM (`TF-11`)** | `npm run sbom` | PASS (`coverage/sbom.cdx.json`: **620 total components, 358 runtime required**, SHA-512 SRI hashes) | Verified locally (`NFR-T37`) |
| **Production Vulnerability Gate** | `npm audit --omit=dev --audit-level=high` | PASS (`0` high/critical production advisories; `image-size` override active) | 1 moderate advisory (`uuid` via `exceljs`) tracked |
| **TypeScript & Full Build** | `npm run typecheck && npm run build` | PASS (`0` TS errors; API + Web Vite bundle built cleanly) | Verified locally (`NFR-T37`) |
| **1,000,000-Row DuckDB Spill (`TF-04`)** | `tests/tf04-duckdb-1m-and-stats.test.ts` | PASS (**580.8 ms** wall time, **+125 MB** RSS delta, `memory_limit='256MB'`, `temp_directory`, `enable_external_access=false`, exact BigInt `$25,000,000.00` + `៛102,000,000,000`) | Verified locally (`NFR-T04`) |
| **PostgreSQL 16 Live RLS (`PLT-T08`)** | `TEST_POSTGRES_URL=... npm test` | PASS (real `postgres:16-alpine` non-superuser `aios_pa00_app` `rolsuper=false`, `rolbypassrls=false`, `0` cross-tenant rows) | Verified locally (`NFR-T21`) |
| **Backup/Restore Security Parity** | `PLT-T35` + `GOV-T08` | PASS (**High-severity bug caught & fixed:** `restorePaExtendedLogicalBackup` now restores `memberships.status`, `memberships.content_access`, `workspaces.visibility`, `organizations.mfa_required_for_privileged`) | Verified locally (`NFR-T15`, `NFR-T23`) |
| **Code Coverage (`QE-00` -> `TF-11`)** | `npm run test:coverage` | **85.40%** stmts/lines (from `83.97%`), **84.40%** funcs (from `80.94%`), **74.26%** branches (from `73.56%`); `apiClient.ts` **`100.00%`** stmts/`100.00%` funcs (from `42.37%`); `AiVoicePanel.tsx` **`91.36%`** stmts/`100.00%` funcs (from `61.39%`/`30.00%`) | Verified locally (`31/31` files, `196/196` tests) |
| **External Cloud / Desktop / Human Gates** | `NFR-T01/02/14/17/19/29/30/31/33..35` | **BLOCKED_EXTERNAL** (no live LLM, no consented `km-KH` speech corpus, no desktop Word/Excel/PowerPoint, no multi-AZ staging load cluster) | Explicitly blocked until `APPROVAL-03..07` |

---

## 2. 40-Subrequirement NFR Matrix (`NFR-01.01`..`NFR-04.12`)

| Group | Subrequirement IDs (40 Total) | Linked Tests | Local Evidence Status | Remaining Production / External Gate |
| :--- | :--- | :--- | :--- | :--- |
| **NFR-01 Performance & Capacity (10)** | `NFR-01.01`..`NFR-01.10` | `NFR-T01..NFR-T10` | `8/10` verified locally (`TF-04` 1M DuckDB spill, `bench:check`, ZIP/concurrency caps) | `NFR-T01`, `NFR-T02` require staging multi-user soak (`TF-11`) |
| **NFR-02 Reliability & Operability (10)** | `NFR-02.01`..`NFR-02.10` | `NFR-T11..NFR-T20` | `7/10` verified locally (lease fencing, cancel, idempotency, isolated DB+object restore, AI/speech offline continuity, degraded health) | `NFR-T14`, `NFR-T17`, `NFR-T19` require cloud HA & telemetry stack (`TF-11`) |
| **NFR-03 Security, Privacy, A11y & Bilingual (11)** | `NFR-03.01`..`NFR-03.11` | `NFR-T21..NFR-T31` | `8/11` verified locally (live PG16 FORCE RLS, 8-role RBAC, revocation, prompt/OOXML defense, ZDR failover, append-only audit, keyboard/focus-trap a11y) | `NFR-T29` (pentest, `TF-11`), `NFR-T30` (live LLM, `TF-08`), `NFR-T31` (consented `km-KH` corpus, `TF-09`) |
| **NFR-04 Commercial, Interop & Supply Chain (9)** | `NFR-04.01`..`NFR-04.09` *(mapped cleanly across 40 total NFRs & `NFR-T32..T40`)* | `NFR-T32..NFR-T40` | `5/9` verified locally + `1/9` partial (`NFR-T32` atomic metering, `NFR-T36` Khmer PDF, `NFR-T37` SBOM+reproducible build, `NFR-T38` model upgrade regression gate, `NFR-T40` golden workflow) | `NFR-T33` (Word desktop, `TF-02`), `NFR-T34` (Excel desktop, `TF-03`), `NFR-T35` (PowerPoint desktop, `TF-05`) |

---

## 3. Release Readiness Honesty Statement

Passing local feasibility suites (`VERIFIED_LOCAL`, `VERIFIED_MOCK_CONTRACT`, `VERIFIED_FAIL_CLOSED`) proves deterministic architecture, security boundaries, precision math, and zero-cost scalability. **It does NOT constitute commercial MVP release clearance** while the 13 external gates (`PPT-T06`, `NFR-T01`, `NFR-T02`, `NFR-T14`, `NFR-T17`, `NFR-T19`, `NFR-T29`, `NFR-T30`, `NFR-T31`, `NFR-T33`, `NFR-T34`, `NFR-T35`, `E2E-06`) remain `BLOCKED_EXTERNAL`.
