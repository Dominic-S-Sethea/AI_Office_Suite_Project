# Requirements Traceability Matrix (RTM) — AI Office Suite (V1.4 Consolidated)

- **Baseline Authority:** Main Research & Engineering Report V1.4 (`FR-12` + `FR-13` + Stage 4 Entry), archived verbatim at `documentation/AI_Office_Suite_FR12_FR13_Main_Research_Report_V1.4.md`
- **Change Record:** `CR-008` (Approved via `APPROVAL-01` & `APPROVAL-02`: progressive delivery order **`S1 -> S2 -> S3`** while preserving **100% of all 51 original parent requirements (`46 P0`, `5 P1`)** and **all 313 defined acceptance test IDs**)
- **Governance Rule:** Requirement scope (`P0`/`P1`, delivery slice) is recorded strictly separately from actual implementation and verification evidence (`VERIFIED_LOCAL`, `VERIFIED_MOCK_CONTRACT`, `VERIFIED_FAIL_CLOSED`, `PARTIAL_FEASIBILITY`, `BLOCKED_EXTERNAL`, `PLANNED_P1`). Mocks (`isMock: true`) are NEVER reported as live LLM, live acoustic ASR, or live billing evidence.

---

## 1. Master Parent Requirements Register (51 Preserved Parents: 46 P0, 5 P1)

| Parent ID | Priority | Workstream | Progressive Slice | Consolidated Requirement Summary | Planned / Linked Acceptance Test IDs | Actual Implementation & Evidence Status (Separate from Scope) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| DOC-01 | P0 | FR-02 Document Studio | S1 | Professional bilingual EN/KM document editing, layout, formatting & revision history | DOC-T02, DOC-T08, DOC-T09, DOC-T11 | VERIFIED_LOCAL (`tests/d1-khmer-typography.test.ts`, `tests/d1-vertical-slice-api.test.ts`, `tests/frontend-workspace.test.tsx`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| DOC-02 | P0 | FR-02 Document Studio | S1 | Contextual AI & voice document drafting, rewrite, translation & preview approval | DOC-T01, DOC-T03, DOC-T04, DOC-T07, DOC-T10 | VERIFIED_MOCK_CONTRACT (`tests/d1-ai-operations.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`; live LLM/ASR pending `TF-08`/`TF-09`) |
| DOC-03 | P0 | FR-02 Document Studio | S1 | Supported DOCX import/export round-trip & searchable bilingual PDF export | DOC-T05, DOC-T06, NFR-T33, NFR-T36 | PARTIAL_FEASIBILITY (`tests/d1-docx-pdf-roundtrip.test.ts`; Word desktop open `NFR-T33` blocked external `TF-02`) |
| DOC-04 | P0 | FR-02 Document Studio | S2 | Linked certified financial figures & reconciliation with Business Analysis Engine | DOC-T12, INT-T01, X-VIS-01 | VERIFIED_LOCAL (`tests/g1-xi00-cross-module-integration.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| DOC-05 | P1 | FR-02 Document Studio | P1 | Tracked changes, comments interchange, merge fields & content-control profile | RC-P1-01 | PLANNED_P1 (Contract & fail-closed gate verified in `tests/v14-rc00-consolidation-and-tf01.test.ts`; production P1 gated) |
| SHT-01 | P0 | FR-03 Spreadsheet Studio | S2 | Multi-sheet workbook editing, dependency recalculation, copy semantics & cycle detection | SHT-T01, SHT-T02, SHT-T03, SHT-T04, SHT-T08 | PARTIAL_FEASIBILITY (19-function prototype spike in `tests/d1-spreadsheet-feasibility.test.ts`; commercial grid decision pending `TF-03`) |
| SHT-02 | P0 | FR-03 Spreadsheet Studio | S2 | Bilingual Khmer text, long ID preservation & supported XLSX import/export | SHT-T05, SHT-T13, SHT-T14, SHT-T17, NFR-T34 | PARTIAL_FEASIBILITY (`tests/d1-spreadsheet-feasibility.test.ts`; desktop Excel reopen `NFR-T34` blocked external `TF-03`) |
| SHT-03 | P0 | FR-03 Spreadsheet Studio | S2 | EN/KM AI & voice formula generation, validation & counterexample testing | SHT-T06, SHT-T07, SHT-T12, SHT-T18 | VERIFIED_MOCK_CONTRACT (`tests/d1-spreadsheet-feasibility.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| SHT-04 | P0 | FR-03 Spreadsheet Studio | S2 | Formula protection, prompt-injection defense, bulk cancel & AI-outage continuity | SHT-T09, SHT-T10, SHT-T11, SHT-T16 | VERIFIED_LOCAL (`tests/d1-spreadsheet-feasibility.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| SHT-05 | P0 | FR-03 Spreadsheet Studio | S2 | Certified metric publishing & cross-studio reconciliation with Document Studio | SHT-T15, INT-T01, X-VIS-01 | VERIFIED_LOCAL (`tests/g1-xi00-cross-module-integration.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| SHT-06 | P1 | FR-03 Spreadsheet Studio | P1 | Pivots, what-if modeling & extended enterprise formula catalog | RC-P1-02 | PLANNED_P1 (Contract & gate verified in `tests/v14-rc00-consolidation-and-tf01.test.ts`; pending `TF-03`) |
| DAT-01 | P0 | FR-04 Data Preparation | S2 | Multi-file CSV/XLSX staging, schema mapping, Khmer/ID preservation & malformed rejects | DAT-T01, DAT-T02, DAT-T13 | VERIFIED_LOCAL (`tests/g1-dp00-data-preparation.test.ts`, `tests/data-pipeline-hardening.test.ts`) |
| DAT-02 | P0 | FR-04 Data Preparation | S2 | Deterministic dataset profiling (null/blank/invalid/duplicates/outliers/sample label) | RC-T01, DAT-T04 | VERIFIED_LOCAL (`tests/v14-rc00-consolidation-and-tf01.test.ts`, `tests/g1-dp00-data-preparation.test.ts`) |
| DAT-03 | P0 | FR-04 Data Preparation | S2 | Explicit date/currency parsing, missing-amount exceptions & composite deduplication | DAT-T03, DAT-T04, DAT-T05 | VERIFIED_LOCAL (`tests/g1-dp00-data-preparation.test.ts`, `tests/data-pipeline-hardening.test.ts`) |
| DAT-04 | P0 | FR-04 Data Preparation | S2 | Join safety (duplicate right-key block, unmatched retention) & pinned reproducible recipes | DAT-T06, DAT-T07, DAT-T08, DAT-T09, DAT-T10 | VERIFIED_LOCAL (`tests/g1-dp00-data-preparation.test.ts`) |
| DAT-05 | P0 | FR-04 Data Preparation | S2 | Bilingual EN/KM transform commands & malicious cell instruction neutralization | DAT-T11, DAT-T12 | VERIFIED_MOCK_CONTRACT (`tests/g1-dp00-data-preparation.test.ts`) |
| DAT-06 | P0 | FR-04 Data Preparation | S2 | Certification gating, historical versioning, tenant isolation & 1M-row bounded DuckDB spill | DAT-T14, DAT-T15, DAT-T16, DAT-T17, DAT-T18 | VERIFIED_LOCAL (`tests/g1-dp00-data-preparation.test.ts`, `tests/tf04-duckdb-1m-and-stats.test.ts`) |
| ANA-01 | P0 | FR-05 Business Analysis | S2 | Certified FIN-POL-V1 exact BigInt minor-unit financial metrics & ratio-of-totals | ANA-T01, ANA-T02, ANA-T03, ANA-T04, ANA-T08, ANA-T09 | VERIFIED_LOCAL (`tests/g1-an00-analytics-feasibility.test.ts`) |
| ANA-02 | P0 | FR-05 Business Analysis | S2 | Granularity-safe budget vs actual, FYTD calendar, partial periods & descriptive statistics | ANA-T05, ANA-T06, ANA-T07, ANA-T10, RC-T02 | VERIFIED_LOCAL (`tests/g1-an00-analytics-feasibility.test.ts`, `tests/tf04-duckdb-1m-and-stats.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| ANA-03 | P0 | FR-05 Business Analysis | S2 | Versioned metrics, bilingual analytical commands, tenant isolation & cross-studio parity | ANA-T11, ANA-T12, ANA-T13, ANA-T14, ANA-T15, ANA-T16, ANA-T17, ANA-T18 | VERIFIED_LOCAL (`tests/g1-an00-analytics-feasibility.test.ts`) |
| ANA-04 | P1 | FR-05 Business Analysis | P1 | Advanced relationship modeling, external connectors, scenario isolation & held-out forecasting | RC-P1-03 | PLANNED_P1 (Contract & gate verified in `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| PPT-01 | P0 | FR-06 Presentation Studio | S3 | Multi-slide structured deck model, geometry, native charts, Khmer layout & PPTX/PDF export | PPT-T01, PPT-T02, PPT-T03, PPT-T05, PPT-T06, PPT-T07, PPT-T08, PPT-T09, PPT-T10, PPT-T13, NFR-T35 | PARTIAL_FEASIBILITY (`tests/g1-ps00-presentation-feasibility.test.ts`; PowerPoint desktop open `PPT-T06`/`NFR-T35` blocked external `TF-05`) |
| PPT-02 | P0 | FR-06 Presentation Studio | S3 | Corporate themes, speaker notes disclosure controls, bilingual translation & linked refresh | PPT-T04, PPT-T11, PPT-T12, PPT-T14, PPT-T15, PPT-T16, PPT-T17, PPT-T18, PPT-T19, PPT-T20, RC-T03 | VERIFIED_LOCAL (`tests/g1-ps00-presentation-feasibility.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| PPT-03 | P0 | FR-06 Presentation Studio | S3 | Accessible full-screen slide delivery order & keyboard navigation controls | RC-T04 | VERIFIED_LOCAL (`tests/v14-rc00-consolidation-and-tf01.test.ts`; browser visual QA pending `S3`) |
| BI-01 | P0 | FR-07 Intelligence Studio | S3 | Editable dashboards, certified KPIs/charts, scoped filters, cross-filtering & drill-through | BI-T01, BI-T02, BI-T03, BI-T04, BI-T05, BI-T06, BI-T07, BI-T08, BI-T09, BI-T10, BI-T11, BI-T12 | VERIFIED_LOCAL (`tests/g1-bi00-intelligence-feasibility.test.ts`) |
| BI-02 | P0 | FR-07 Intelligence Studio | S3 | Bilingual Khmer dashboards, role/cache/snapshot security, race guard & sanitized exports | BI-T13, BI-T14, BI-T15, BI-T16, BI-T17, BI-T18, BI-T19, BI-T20, BI-T21, BI-T22, BI-T23, BI-T24, BI-T25, BI-T26, BI-T27, BI-T28 | VERIFIED_LOCAL (`tests/g1-bi00-intelligence-feasibility.test.ts`) |
| BI-03 | P0 | FR-07 Intelligence Studio | S3 | Dashboard-to-presentation parity, AI-outage continuity, keyboard/a11y & bounded queries (+ P1 hooks) | BI-T29, BI-T30, BI-T31, BI-T32, BI-T33, BI-T34, X-VIS-01, X-VIS-02, X-VIS-03, X-VIS-04, X-VIS-05, X-VIS-06, X-VIS-07, X-VIS-08 | VERIFIED_LOCAL (`tests/g1-bi00-intelligence-feasibility.test.ts`; P1 alerts/schedules `BI-T33`/`BI-T34` gated) |
| INT-01 | P0 | FR-08 Cross-Module Integration | S3 | Shared metric/table/chart linking with stable resource IDs & identical cross-studio values | INT-T01, INT-T02, INT-T03, INT-T04, INT-T05, INT-T06, INT-T07 | VERIFIED_LOCAL (`tests/g1-xi00-cross-module-integration.test.ts`) |
| INT-02 | P0 | FR-08 Cross-Module Integration | S3 | Impact dependency graph, incompatible refresh blocking & tenant/permission redaction | INT-T08, INT-T09, INT-T10, INT-T11, INT-T19, INT-T20, INT-T21, INT-T24 | VERIFIED_LOCAL (`tests/g1-xi00-cross-module-integration.test.ts`) |
| INT-03 | P0 | FR-08 Cross-Module Integration | S3 | Atomic reporting-package staging, approval, publication, outbox, revision conflict & recovery | INT-T12, INT-T13, INT-T14, INT-T15, INT-T16, INT-T17, INT-T18, INT-T22, INT-T23, E2E-01, E2E-02, E2E-03, E2E-04, E2E-05, E2E-06 | VERIFIED_LOCAL (`tests/g1-xi00-cross-module-integration.test.ts`, `tests/v13-integrated-golden-governance.test.ts`; `E2E-06` live external blocked `TF-10`) |
| INT-04 | P1 | FR-08 Cross-Module Integration | P1 | Scheduled recurring refresh without auto-publication, deduplicated triggers & revocation | RC-P1-04 | PLANNED_P1 (Contract & gate verified in `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| AI-01 | P0 | FR-09 AI Intelligence Core | S1 | Scoped document/spreadsheet editing, stale-selection protection & bilingual EN/KM parity | AI-T01, AI-T02, AI-T03, AI-T04 | VERIFIED_MOCK_CONTRACT (`tests/v13-aic00-ai-intelligence-core.test.ts`; live LLM evaluation pending `TF-08`) |
| AI-02 | P0 | FR-09 AI Intelligence Core | S1 | Explicit diff inspection, proposal rejection, approval re-validation & undo/restore safety | AI-T13, RC-T05 | VERIFIED_MOCK_CONTRACT (`tests/v13-aic00-ai-intelligence-core.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| AI-03 | P0 | FR-09 AI Intelligence Core | S2 | Grounded corporate RAG with ACL pre-filter, conflict/unavailable honesty & live citation recheck | AI-T05, AI-T06, AI-T07, AI-T08, AI-T09, AI-T25 | VERIFIED_MOCK_CONTRACT (`tests/v13-aic00-ai-intelligence-core.test.ts`) |
| AI-04 | P0 | FR-09 AI Intelligence Core | S1 | Direct & indirect prompt-injection defense, typed tool validation & central RBAC enforcement | AI-T10, AI-T11, AI-T12, AI-T14 | VERIFIED_LOCAL (`tests/v13-aic00-ai-intelligence-core.test.ts`) |
| AI-05 | P0 | FR-09 AI Intelligence Core | S2 | Analytical engine delegation, certified reconciliation & linked reporting workflow provenance | AI-T15, AI-T27 | VERIFIED_LOCAL (`tests/v13-aic00-ai-intelligence-core.test.ts`) |
| AI-06 | P0 | FR-09 AI Intelligence Core | S1 | Classification-aware ZDR model routing, privacy-safe failover, regression gate & offline continuity | AI-T16, AI-T17, AI-T24, AI-T26, AI-T28 | VERIFIED_LOCAL (`tests/v13-aic00-ai-intelligence-core.test.ts`; live external LLMs fail-closed `423` `TF-08`) |
| AI-07 | P0 | FR-09 AI Intelligence Core | S2 | Idempotent multi-step orchestration, cancel/restart durability, atomic budgets & redacted audit | AI-T18, AI-T19, AI-T20, AI-T21, AI-T22, AI-T23 | VERIFIED_LOCAL (`tests/v13-aic00-ai-intelligence-core.test.ts`) |
| VOC-01 | P0 | FR-10 Voice Intelligence | S1 | Deterministic VoiceSession PTT lifecycle, permission denial, cancel, silence/hardware/network recovery & keyboard a11y | VOC-T01, VOC-T02, VOC-T03, VOC-T04, VOC-T12, VOC-T13, VOC-T16, VOC-T17, VOC-T18, VOC-T21, VOC-T27, VOC-T28, VOC-T30 | VERIFIED_MOCK_CONTRACT (`tests/v13-vi00-voice-intelligence.test.ts`, `tests/frontend-workspace.test.tsx`; live `km-KH` ASR corpus pending `TF-09`) |
| VOC-02 | P0 | FR-10 Voice Intelligence | S1 | Bilingual EN/KM voice commands, dictation isolation, critical financial fields, terminology, RBAC, quota & zero-retention privacy | VOC-T05, VOC-T06, VOC-T07, VOC-T08, VOC-T09, VOC-T10, VOC-T11, VOC-T14, VOC-T15, VOC-T19, VOC-T20, VOC-T22, VOC-T23, VOC-T24, VOC-T25, VOC-T26, VOC-T29 | VERIFIED_MOCK_CONTRACT (`tests/v13-vi00-voice-intelligence.test.ts`; cloud STT fail-closed `423` `TF-09`) |
| VOC-03 | P1 | FR-10 Voice Intelligence | P1 | Real-time streaming, EN/KM TTS, VAD barge-in, mid-utterance code-switching & live Khmer corpus eval | RC-P1-05 | VERIFIED_FAIL_CLOSED (All 7 `VOC-03` P1 features gated `423` in `tests/v14-rc00-consolidation-and-tf01.test.ts`) |
| PLT-01 | P0 | FR-11 Platform Admin | S1 | Multi-tenant PostgreSQL FORCE RLS, org/workspace/RBAC isolation, invites, sole-owner guard, MFA & logout voice stop | PLT-T01, PLT-T02, PLT-T03, PLT-T04, PLT-T05, PLT-T06, PLT-T07, PLT-T08, PLT-T09, PLT-T10, PLT-T11, PLT-T12, PLT-T13, PLT-T14 | VERIFIED_LOCAL (PGlite + live PostgreSQL 16 Docker `aios_pa00_app` in `tests/v13-pa00-platform-admin.test.ts`) |
| PLT-02 | P0 | FR-11 Platform Admin | S1 | Optimistic revision locking, post-approval invalidation, non-destructive restore & package publication gating | PLT-T15, PLT-T16, PLT-T17, PLT-T18 | VERIFIED_LOCAL (`tests/v13-pa00-platform-admin.test.ts`) |
| PLT-03 | P0 | FR-11 Platform Admin | S1 | Private versioned object storage, signed ephemeral URLs, retention/legal hold, append-only audit & isolated backup/restore | PLT-T19, PLT-T20, PLT-T21, PLT-T34, PLT-T35, RC-T06 | VERIFIED_LOCAL (`tests/v13-pa00-platform-admin.test.ts`, `tests/v14-rc00-consolidation-and-tf01.test.ts`; backup restore revoked-member security bug caught & fixed) |
| PLT-04 | P0 | FR-11 Platform Admin | S1 | Upload MIME/magic validation, ZIP-bomb defense, macro/OOXML blocking, traversal/XSS sanitization & orphan sweep | PLT-T22, PLT-T23, PLT-T24, PLT-T25, PLT-T26 | VERIFIED_LOCAL (`tests/v13-pa00-platform-admin.test.ts`, `tests/security-precision-edge-hardening.test.ts`) |
| PLT-05 | P0 | FR-11 Platform Admin | S2 | Durable fenced-lease background jobs, cancellation, noisy-neighbor isolation & truthful degradation health | PLT-T27, PLT-T28, PLT-T29, PLT-T36, GOV-T01, GOV-T02, GOV-T03, GOV-T04, GOV-T05, GOV-T06, GOV-T07, GOV-T08 | VERIFIED_LOCAL (`tests/v13-pa00-platform-admin.test.ts`, `tests/v13-integrated-golden-governance.test.ts`) |
| PLT-06 | P0 | FR-11 Platform Admin | S2 | Commercial entitlements, atomic seat/token/voice reservations, deduplicated usage ledger & mock webhook reconciliation | PLT-T30, PLT-T31, PLT-T32, PLT-T33 | VERIFIED_LOCAL (`tests/v13-pa00-platform-admin.test.ts`; live Stripe/billing gateway gated) |
| NFR-01 | P0 | FR-12 Quality Engineering | S1 | Performance, bounded memory, concurrency, responsiveness & load engineering | NFR-T01, NFR-T02, NFR-T03, NFR-T04, NFR-T05, NFR-T06, NFR-T07, NFR-T08, NFR-T09, NFR-T10 | PARTIAL_FEASIBILITY (`tests/stress-load-benchmarks.test.ts`, `tests/tf04-duckdb-1m-and-stats.test.ts`; production multi-user load `NFR-T01`/`NFR-T02` blocked external `TF-11`) |
| NFR-02 | P0 | FR-12 Quality Engineering | S1 | Reliability, crash/lease durability, failover, backup/restore RPO/RTO & incident observability | NFR-T11, NFR-T12, NFR-T13, NFR-T14, NFR-T15, NFR-T16, NFR-T17, NFR-T18, NFR-T19, NFR-T20 | PARTIAL_FEASIBILITY (`tests/v13-pa00-platform-admin.test.ts`, `tests/v13-integrated-golden-governance.test.ts`; cloud HA/failover drills blocked external `TF-11`) |
| NFR-03 | P0 | FR-12 Quality Engineering | S1 | Security, tenant/RLS isolation, prompt/file safety, privacy retention, WCAG a11y & bilingual Khmer quality | NFR-T21, NFR-T22, NFR-T23, NFR-T24, NFR-T25, NFR-T26, NFR-T27, NFR-T28, NFR-T29, NFR-T30, NFR-T31 | PARTIAL_FEASIBILITY (`tests/security-precision-edge-hardening.test.ts`, `tests/frontend-workspace.test.tsx`; external pentest `TF-11`, live LLM `TF-08` & Khmer corpus `TF-09` blocked) |
| NFR-04 | P0 | FR-12 Quality Engineering | S1 | Commercial metering accuracy, OOXML/PDF compatibility, reproducible builds, SBOM, regression gates & release evidence | NFR-T32, NFR-T33, NFR-T34, NFR-T35, NFR-T36, NFR-T37, NFR-T38, NFR-T39, NFR-T40, RC-T07, RC-T08 | PARTIAL_FEASIBILITY (`scripts/generate-sbom.mjs`, `scripts/check-licenses.mjs`, `tests/v14-rc00-consolidation-and-tf01.test.ts`; desktop Office opens blocked external `TF-02`/`TF-03`/`TF-05`) |

---

## 2. Canonical 313-Test Acceptance Inventory

Every one of the **313 canonical test IDs** defined in V1.4 (Parts A/B + Appendices A & B) is indexed below with its exact parent linkage, suite location, and honest evidence status.

### 2.1 Document Studio (`DOC-T01..DOC-T12` — 12 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| DOC-T01 | DOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| DOC-T02 | DOC-01 | VERIFIED_LOCAL | `tests/d1-khmer-typography.test.ts`, `tests/d1-vertical-slice-api.test.ts` |
| DOC-T03 | DOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| DOC-T04 | DOC-02 | VERIFIED_MOCK_CONTRACT | `tests/d1-ai-operations.test.ts` |
| DOC-T05 | DOC-03 | PARTIAL_FEASIBILITY | `tests/d1-docx-pdf-roundtrip.test.ts` |
| DOC-T06 | DOC-03 | VERIFIED_LOCAL | `tests/d1-docx-pdf-roundtrip.test.ts` |
| DOC-T07 | DOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| DOC-T08 | DOC-01 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| DOC-T09 | DOC-01 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| DOC-T10 | DOC-02 | VERIFIED_LOCAL | `tests/d1-ai-operations.test.ts`, `tests/v13-aic00-ai-intelligence-core.test.ts` |
| DOC-T11 | DOC-01 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts`, `tests/v13-vi00-voice-intelligence.test.ts` |
| DOC-T12 | DOC-04 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |

### 2.2 Spreadsheet Studio (`SHT-T01..SHT-T18` — 18 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| SHT-T01 | SHT-01 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T02 | SHT-01 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T03 | SHT-01 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T04 | SHT-01 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T05 | SHT-02 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T06 | SHT-03 | VERIFIED_MOCK_CONTRACT | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T07 | SHT-03 | VERIFIED_MOCK_CONTRACT | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T08 | SHT-01 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T09 | SHT-04 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T10 | SHT-04 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T11 | SHT-04 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| SHT-T12 | SHT-03 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| SHT-T13 | SHT-02 | PARTIAL_FEASIBILITY | `tests/d1-spreadsheet-feasibility.test.ts` (desktop Excel pending `TF-03`) |
| SHT-T14 | SHT-02 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |
| SHT-T15 | SHT-05 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| SHT-T16 | SHT-04 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| SHT-T17 | SHT-02 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts`, `tests/security-precision-edge-hardening.test.ts` |
| SHT-T18 | SHT-03 | VERIFIED_LOCAL | `tests/d1-spreadsheet-feasibility.test.ts` |

### 2.3 Data Preparation Engine (`DAT-T01..DAT-T18` — 18 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| DAT-T01 | DAT-01 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T02 | DAT-01 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T03 | DAT-03 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T04 | DAT-03 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T05 | DAT-03 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T06 | DAT-04 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T07 | DAT-04 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T08 | DAT-04 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T09 | DAT-04 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T10 | DAT-04 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T11 | DAT-05 | VERIFIED_MOCK_CONTRACT | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T12 | DAT-05 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T13 | DAT-01 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T14 | DAT-06 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T15 | DAT-06 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T16 | DAT-06 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T17 | DAT-06 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |
| DAT-T18 | DAT-06 | VERIFIED_LOCAL | `tests/g1-dp00-data-preparation.test.ts` |

### 2.4 Business Analysis Engine (`ANA-T01..ANA-T18` — 18 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| ANA-T01 | ANA-01 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T02 | ANA-01 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T03 | ANA-01 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T04 | ANA-01 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T05 | ANA-02 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T06 | ANA-02 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T07 | ANA-02 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T08 | ANA-01 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T09 | ANA-01 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T10 | ANA-02 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T11 | ANA-03 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T12 | ANA-03 | VERIFIED_MOCK_CONTRACT | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T13 | ANA-03 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T14 | ANA-03 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T15 | ANA-03 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T16 | ANA-03 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T17 | ANA-03 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |
| ANA-T18 | ANA-03 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts` |

### 2.5 Presentation Studio (`PPT-T01..PPT-T20` — 20 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| PPT-T01 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T02 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T03 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T04 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T05 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T06 | PPT-01 | BLOCKED_EXTERNAL | PowerPoint desktop reference open required (`TF-05`) |
| PPT-T07 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T08 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T09 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T10 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T11 | PPT-02 | VERIFIED_MOCK_CONTRACT | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T12 | PPT-02 | VERIFIED_MOCK_CONTRACT | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T13 | PPT-01 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T14 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T15 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T16 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T17 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T18 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T19 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |
| PPT-T20 | PPT-02 | VERIFIED_LOCAL | `tests/g1-ps00-presentation-feasibility.test.ts` |

### 2.6 Intelligence Studio & Cross-Studio Visuals (`BI-T01..BI-T34` & `X-VIS-01..X-VIS-08` — 42 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| BI-T01 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T02 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T03 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T04 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T05 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T06 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T07 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T08 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T09 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T10 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T11 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T12 | BI-01 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T13 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T14 | BI-02 | VERIFIED_MOCK_CONTRACT | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T15 | BI-02 | VERIFIED_MOCK_CONTRACT | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T16 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T17 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T18 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T19 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T20 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T21 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T22 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T23 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T24 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T25 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T26 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T27 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T28 | BI-02 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T29 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T30 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T31 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T32 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| BI-T33 | BI-03 | PLANNED_P1 | `tests/g1-bi00-intelligence-feasibility.test.ts` (P1 threshold alert contract) |
| BI-T34 | BI-03 | PLANNED_P1 | `tests/g1-bi00-intelligence-feasibility.test.ts` (P1 scheduled refresh contract) |
| X-VIS-01 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| X-VIS-02 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| X-VIS-03 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| X-VIS-04 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| X-VIS-05 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| X-VIS-06 | BI-03 | VERIFIED_MOCK_CONTRACT | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| X-VIS-07 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |
| X-VIS-08 | BI-03 | VERIFIED_LOCAL | `tests/g1-bi00-intelligence-feasibility.test.ts` |

### 2.7 Cross-Module Integration (`INT-T01..INT-T24` — 24 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| INT-T01 | INT-01 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T02 | INT-01 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T03 | INT-01 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T04 | INT-01 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T05 | INT-01 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T06 | INT-01 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T07 | INT-01 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T08 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T09 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T10 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T11 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T12 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T13 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T14 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T15 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T16 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T17 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T18 | INT-03 | VERIFIED_MOCK_CONTRACT | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T19 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T20 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T21 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T22 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T23 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |
| INT-T24 | INT-02 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts` |

### 2.8 AI Intelligence Core (`AI-T01..AI-T28` — 28 tests, 1:1 V1.4 Aligned)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| AI-T01 | AI-01 | VERIFIED_MOCK_CONTRACT | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T02 | AI-01 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T03 | AI-01 | VERIFIED_MOCK_CONTRACT | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T04 | AI-01 | VERIFIED_MOCK_CONTRACT | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T05 | AI-03 | VERIFIED_MOCK_CONTRACT | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T06 | AI-03 | VERIFIED_MOCK_CONTRACT | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T07 | AI-03 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T08 | AI-03 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T09 | AI-03 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T10 | AI-04 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T11 | AI-04 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T12 | AI-04 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T13 | AI-02 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T14 | AI-04 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T15 | AI-05 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T16 | AI-06 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T17 | AI-06 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T18 | AI-07 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T19 | AI-07 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T20 | AI-07 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T21 | AI-07 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T22 | AI-07 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T23 | AI-07 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T24 | AI-06 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T25 | AI-03 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T26 | AI-06 | VERIFIED_MOCK_CONTRACT | `tests/v13-aic00-ai-intelligence-core.test.ts` (live LLM repeatability pending `TF-08`) |
| AI-T27 | AI-05 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |
| AI-T28 | AI-06 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` |

### 2.9 Advanced Voice Intelligence (`VOC-T01..VOC-T30` — 30 tests, 1:1 V1.4 Aligned)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| VOC-T01 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts`, `tests/frontend-workspace.test.tsx` |
| VOC-T02 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T03 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T04 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T05 | VOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T06 | VOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T07 | VOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T08 | VOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T09 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T10 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T11 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T12 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T13 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T14 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T15 | VOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T16 | VOC-01 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T17 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T18 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T19 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T20 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T21 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T22 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T23 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T24 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T25 | VOC-02 | VERIFIED_MOCK_CONTRACT | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T26 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T27 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts`, `tests/frontend-workspace.test.tsx` |
| VOC-T28 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts`, `tests/frontend-workspace.test.tsx` |
| VOC-T29 | VOC-02 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |
| VOC-T30 | VOC-01 | VERIFIED_LOCAL | `tests/v13-vi00-voice-intelligence.test.ts` |

### 2.10 Shared Platform Administration (`PLT-T01..PLT-T36` — 36 tests, 1:1 V1.4 Aligned)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| PLT-T01 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T02 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T03 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T04 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T05 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T06 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T07 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T08 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (live PostgreSQL 16 `aios_pa00_app` verified) |
| PLT-T09 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T10 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T11 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T12 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T13 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T14 | PLT-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T15 | PLT-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T16 | PLT-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T17 | PLT-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T18 | PLT-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T19 | PLT-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T20 | PLT-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T21 | PLT-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T22 | PLT-04 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T23 | PLT-04 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T24 | PLT-04 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T25 | PLT-04 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T26 | PLT-04 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T27 | PLT-05 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T28 | PLT-05 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T29 | PLT-05 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T30 | PLT-06 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T31 | PLT-06 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T32 | PLT-06 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T33 | PLT-06 | VERIFIED_MOCK_CONTRACT | `tests/v13-pa00-platform-admin.test.ts` (mock webhook; live billing gated) |
| PLT-T34 | PLT-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T35 | PLT-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |
| PLT-T36 | PLT-05 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` |

### 2.11 Integrated Governance (`GOV-T01..GOV-T08` — 8 tests, 1:1 V1.4 Aligned)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| GOV-T01 | PLT-05 | VERIFIED_MOCK_CONTRACT | `tests/v13-integrated-golden-governance.test.ts` |
| GOV-T02 | PLT-05 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` |
| GOV-T03 | PLT-05 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` |
| GOV-T04 | PLT-05 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` |
| GOV-T05 | PLT-05 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` |
| GOV-T06 | PLT-05 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` |
| GOV-T07 | PLT-05 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` |
| GOV-T08 | PLT-05 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` |

### 2.12 Non-Functional & Quality Engineering (`NFR-T01..NFR-T40` — 40 tests)
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| NFR-T01 | NFR-01 | BLOCKED_EXTERNAL | Staging load environment required (`TF-11`) |
| NFR-T02 | NFR-01 | BLOCKED_EXTERNAL | Staging load environment required (`TF-11`) |
| NFR-T03 | NFR-01 | VERIFIED_LOCAL | `tests/stress-load-benchmarks.test.ts` |
| NFR-T04 | NFR-01 | VERIFIED_LOCAL | `tests/tf04-duckdb-1m-and-stats.test.ts` (`1,000,000` rows in `580.8 ms`, `memory_limit='256MB'`) |
| NFR-T05 | NFR-01 | VERIFIED_LOCAL | `tests/g1-an00-analytics-feasibility.test.ts`, `tests/g1-bi00-intelligence-feasibility.test.ts` |
| NFR-T06 | NFR-01 | VERIFIED_LOCAL | `tests/d1-docx-pdf-roundtrip.test.ts`, `tests/g1-ps00-presentation-feasibility.test.ts` |
| NFR-T07 | NFR-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T29`) |
| NFR-T08 | NFR-01 | VERIFIED_LOCAL | `tests/stress-load-benchmarks.test.ts`, `tests/g1-bi00-intelligence-feasibility.test.ts` |
| NFR-T09 | NFR-01 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T23`) |
| NFR-T10 | NFR-01 | VERIFIED_LOCAL | `tests/stress-load-benchmarks.test.ts` (`scripts/bench-check.mjs`) |
| NFR-T11 | NFR-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T27`), `tests/v13-integrated-golden-governance.test.ts` (`GOV-T08`) |
| NFR-T12 | NFR-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T28`), `tests/v13-aic00-ai-intelligence-core.test.ts` (`AI-T19`) |
| NFR-T13 | NFR-02 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` (`AI-T18`), `tests/v13-vi00-voice-intelligence.test.ts` (`VOC-T21`) |
| NFR-T14 | NFR-02 | BLOCKED_EXTERNAL | Multi-node cloud HA / failover cluster required (`TF-11`) |
| NFR-T15 | NFR-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T35`), `tests/v13-integrated-golden-governance.test.ts` (`GOV-T08`) |
| NFR-T16 | NFR-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T15`, `PLT-T17`) |
| NFR-T17 | NFR-02 | BLOCKED_EXTERNAL | Cloud multi-AZ failover drill required (`TF-11`) |
| NFR-T18 | NFR-02 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` (`AI-T28`), `tests/v13-vi00-voice-intelligence.test.ts` (`VOC-T30`) |
| NFR-T19 | NFR-02 | BLOCKED_EXTERNAL | Staging telemetry/alerting stack required (`TF-11`) |
| NFR-T20 | NFR-02 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T36`) |
| NFR-T21 | NFR-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T07`, `PLT-T08`, `PLT-T09`, live PG16) |
| NFR-T22 | NFR-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T10`, `PLT-T11`, `PLT-T14`) |
| NFR-T23 | NFR-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T06`, `PLT-T12`, `PLT-T13`) |
| NFR-T24 | NFR-03 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` (`AI-T10`), `tests/v13-vi00-voice-intelligence.test.ts` (`VOC-T22`) |
| NFR-T25 | NFR-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T22`, `PLT-T23`, `PLT-T24`, `PLT-T25`) |
| NFR-T26 | NFR-03 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` (`AI-T17`), `tests/v13-vi00-voice-intelligence.test.ts` (`VOC-T20`, `VOC-T26`) |
| NFR-T27 | NFR-03 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T34`), `tests/v13-aic00-ai-intelligence-core.test.ts` (`AI-T23`) |
| NFR-T28 | NFR-03 | VERIFIED_LOCAL | `tests/frontend-workspace.test.tsx`, `tests/v14-rc00-consolidation-and-tf01.test.ts` (`RC-T04`) |
| NFR-T29 | NFR-03 | BLOCKED_EXTERNAL | Independent external penetration test & threat review required (`TF-11`) |
| NFR-T30 | NFR-03 | BLOCKED_EXTERNAL | Live bilingual LLM benchmark with external provider authorization (`TF-08`) |
| NFR-T31 | NFR-03 | BLOCKED_EXTERNAL | Consented native Khmer/English human speech audio corpus required (`TF-09`) |
| NFR-T32 | NFR-04 | VERIFIED_LOCAL | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T30`, `PLT-T32`) |
| NFR-T33 | NFR-04 | BLOCKED_EXTERNAL | Microsoft Word desktop reference round-trip required (`TF-02`) |
| NFR-T34 | NFR-04 | BLOCKED_EXTERNAL | Microsoft Excel desktop reference round-trip required (`TF-03`) |
| NFR-T35 | NFR-04 | BLOCKED_EXTERNAL | Microsoft PowerPoint desktop reference round-trip required (`TF-05`) |
| NFR-T36 | NFR-04 | VERIFIED_LOCAL | `tests/d1-docx-pdf-roundtrip.test.ts`, `tests/g1-ps00-presentation-feasibility.test.ts` |
| NFR-T37 | NFR-04 | VERIFIED_LOCAL | `scripts/generate-sbom.mjs`, `scripts/check-licenses.mjs`, `scripts/check-hygiene.mjs` (`TF-11`) |
| NFR-T38 | NFR-04 | VERIFIED_LOCAL | `tests/v13-aic00-ai-intelligence-core.test.ts` (`AI-T24`), `npm audit --omit=dev --audit-level=high` |
| NFR-T39 | NFR-04 | PARTIAL_FEASIBILITY | `tests/v13-pa00-platform-admin.test.ts` (`PLT-T35`, `PLT-T36`); live paging/postmortem drill pending staging (`TF-11`) |
| NFR-T40 | NFR-04 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` (`GOV-T02`, `GOV-T08`) |

### 2.13 System-Level E2E, Consolidation (`RC-T01..08`) & P1 Expansion Plans (`RC-P1-01..05`) — 19 tests
| Test ID | Parent ID | Status | Primary Evidence Suite |
| :--- | :--- | :--- | :--- |
| E2E-01 | INT-03 | VERIFIED_LOCAL | `tests/g1-xi00-cross-module-integration.test.ts`, `tests/v13-integrated-golden-governance.test.ts` |
| E2E-02 | INT-03 | VERIFIED_MOCK_CONTRACT | `tests/v13-integrated-golden-governance.test.ts` (`GOV-T01`, `GOV-T02`) |
| E2E-03 | INT-03 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` (`GOV-T03`, `GOV-T04`) |
| E2E-04 | INT-03 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` (`GOV-T05`, `GOV-T06`) |
| E2E-05 | INT-03 | VERIFIED_LOCAL | `tests/v13-integrated-golden-governance.test.ts` (`GOV-T07`, `GOV-T08`) |
| E2E-06 | INT-03 | BLOCKED_EXTERNAL | Full production-like live LLM + live EN/KM ASR + desktop Office E2E release drill (`TF-10`) |
| RC-T01 | DAT-02 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| RC-T02 | ANA-02 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts`, `tests/tf04-duckdb-1m-and-stats.test.ts` |
| RC-T03 | PPT-02 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| RC-T04 | PPT-03 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| RC-T05 | AI-02 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| RC-T06 | PLT-03 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| RC-T07 | NFR-04 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` (live automated RTM parser!) |
| RC-T08 | NFR-04 | VERIFIED_LOCAL | `tests/v14-rc00-consolidation-and-tf01.test.ts` |
| RC-P1-01 | DOC-05 | PLANNED_P1 | `tests/v14-rc00-consolidation-and-tf01.test.ts` (fail-closed P1 gate) |
| RC-P1-02 | SHT-06 | PLANNED_P1 | `tests/v14-rc00-consolidation-and-tf01.test.ts` (fail-closed P1 gate) |
| RC-P1-03 | ANA-04 | PLANNED_P1 | `tests/v14-rc00-consolidation-and-tf01.test.ts` (fail-closed P1 gate) |
| RC-P1-04 | INT-04 | PLANNED_P1 | `tests/v14-rc00-consolidation-and-tf01.test.ts` (fail-closed P1 gate) |
| RC-P1-05 | VOC-03 | VERIFIED_FAIL_CLOSED | `tests/v14-rc00-consolidation-and-tf01.test.ts` (all 7 `VOC-03` features gated `423`) |
