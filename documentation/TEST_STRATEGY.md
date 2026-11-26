# Test Strategy — AI Office Suite

**Phase:** D1 & SS-00 Verification Framework  
**Runner:** Vitest (`vitest@3.2.4`) + TypeScript (`tsc --noEmit`) + Automated License Gate (`scripts/check-licenses.mjs`)

## 1. Test Layers

| Suite | File | Scope & Requirements Covered |
| :--- | :--- | :--- |
| **License Compliance** | `scripts/check-licenses.mjs` | Blocks AGPL, GPL-only, SSPL, BUSL, and unknown direct dependencies across root and `apps/web` |
| **Khmer Typography** | `tests/d1-khmer-typography.test.ts` | D1.03 coeng subscripts, dependent vowels, Khmer/Arabic numerals, `Intl.Segmenter` word segmentation, grapheme-safe edit snapping |
| **DOCX & PDF Round-Trip** | `tests/d1-docx-pdf-roundtrip.test.ts` | D1.01/D1.03 DOCX export (`w:cs` Khmer font), `mammoth` re-import Unicode retention, VBA macro blocking, unsupported feature warnings, real Chromium/Edge HarfBuzz `%PDF-` rendering |
| **Controlled AI Operations** | `tests/d1-ai-operations.test.ts` | D1.04 all 7 ops in English & Khmer (with Khmer numerals `៣x៣`), stale revision `409`, idempotency, unapproved rejection, viewer RBAC `403`, prompt-injection rejection |
| **Speech Adapter Contract** | `tests/d1-speech-adapter.test.ts` | D1.02 `MockSpeechAdapter` (`isMock: true` + disclaimer), fail-closed unconfigured live STT providers (`423`) |
| **Vertical Slice API** | `tests/d1-vertical-slice-api.test.ts` | §16 complete workflow: seed EN/KM doc -> typed AI plan/apply -> EN mock voice -> KM mock voice -> viewer `403` -> cross-tenant `403` -> DOCX/PDF export -> audit verification |
| **FR-03 Spreadsheet Spike** | `tests/d1-spreadsheet-feasibility.test.ts` | SS-00 / `SHT-T01..T18` subset: multi-sheet calc recalc, `$G$1` absolute refs, leading-zero `"001245"`, USD/KHR separation, `#CYCLE!` / `#DIV/0!` / `#NAME?`, macro block, EN/KM Formula Intelligence, multi-input invariance, protected cell `403`, cell prompt-injection block, intact-row sort, OWASP CSV escaping, 20k/200k cell benchmark |

| **FR-04 Data Preparation** | `tests/g1-dp00-data-preparation.test.ts` | DP-00 / `DAT-T01..T18`: reordered XLSX+CSV, Khmer/IDs, ambiguous date refusal, null≠0, composite dedupe, §5.4 golden duplicate-key join block & reconciliation, unmatched `C999`, cancel/rerun/drift/EN-KM/injection/cross-tenant/idempotency + DuckDB vs Polars parity & 10k/100k benchmarks |
| **FR-05 Business Analytics** | `tests/g1-an00-analytics-feasibility.test.ts` | AN-00 / `ANA-T01..T18`: golden financial dataset (`$150k/$90k/$60k/$20k/$40k`, `40.00%`/`26.67%`/`20.00%`), combined ratios, zero-denom unavailable, distinct customers, granularity-aligned budget vs actual, fiscal YTD, partial warnings, multi-currency FX, rounding (`HALF_UP`/`HALF_EVEN`), missing-amount block, V1/V2 versioning, EN/KM parity, ambiguous clarification, tenant/cache isolation, SQL injection rejection, cross-module sync, retry idempotency, snapshot immutability, 10k/50k DuckDB stress |
| **Phase D2 Platform (PG/Auth)** | `tests/d2-platform-pg-auth.test.ts` | Real `@electric-sql/pglite` PostgreSQL schema + non-superuser `app_runtime` RLS fail-closed negative tests, `REVOKE UPDATE/DELETE ON audit_logs`, HTTP `aios_session` HttpOnly cookie, CSRF `403`, RBAC `403`, concurrent `409 REVISION_CONFLICT`, `token_version` revocation `401`, `.local-data/` dry-run/apply/rollback, logical SQL dump/restore |
| **FR-06 Presentation (`PS-00`)** | `tests/g1-ps00-presentation-feasibility.test.ts` | `PPT-T01..T20` local verification + `.pptm`/traversal/macro/prompt-injection blocks + PptxGenJS 5/20/50-slide benchmarks + 6-page HarfBuzz PDF & visual slide PNGs (`PPT-T06` reference PowerPoint viewer open pending) |
| **FR-07 BI & `X-VIS` (`BI-00`)** | `tests/g1-bi00-intelligence-feasibility.test.ts` | `BI-T01..T32` + `X-VIS-01..08` against §12 Golden Fixture, ECharts SSR SVG + Edge PNG + Vega-Lite JSON parity, `DataScopePolicy` row/col/cache/export isolation, revocation, refresh/snapshot/race-guard, 10k/100k benchmarks (`BI-T33..T34` pending P1) |
| **FR-08 Integration (`XI-00`)** | `tests/g1-xi00-cross-module-integration.test.ts` | `INT-T01..T24` across all 4 studios + FR-05 + real PGlite PG RLS/outbox: V1/V2/V3 versioning, rename resilience, pinned snapshots vs draft refresh, metric impact, schema break block, BOLA, revocation, dependency redaction, workflow failure/cancel/DB-rehydrate recovery, `409` conflicts, approval invalidation, atomic TX rollback/commit, disclosure PPTX, policy cache invalidation, EN/KM parity |
| **FR-09/10/11 V1.4 Aligned (`AIC-00`, `VI-00`, `PA-00`, `GOV`)** | `tests/v13-{aic00,vi00,pa00,integrated}*.test.ts` | 1:1 V1.4 Appendix A aligned coverage of `AI-T01..28`, `VOC-T01..30`, `PLT-T01..36` (including live PostgreSQL 16 `aios_pa00_app` non-superuser RLS & backup/restore revoked-member security parity), and `GOV-T01..08` |
| **V1.4 Consolidation (`TF-01`)** | `tests/v14-rc00-consolidation-and-tf01.test.ts` | `RC-T01..08` (including live `RC-T07` automated RTM parser proving 51 parents / 46 P0 / 5 P1 / 313 unique test IDs), `RC-P1-01..05` fail-closed gates (all 7 `VOC-03` `423` checks), `DOC-T01/03/08/09`, `SHT-T11/12/15/16`, and `TF-11` CycloneDX 1.5 SBOM verification |
| **1M-Row DuckDB Spill (`TF-04`)** | `tests/tf04-duckdb-1m-and-stats.test.ts` | Bounded 1,000,000-row bilingual USD/KHR DuckDB spill-to-disk benchmark (`memory_limit='256MB'`, `temp_directory`, `enable_external_access=false`, exact BigInt parity) + `RC-T02` exact descriptive statistics |
| **Supply Chain & Frontend (`TF-11`)** | `scripts/generate-sbom.mjs`, `tests/frontend-workspace.test.tsx` | Zero-dependency CycloneDX 1.5 JSON SBOM (`npm run sbom`), `apiClient.ts` utilities/focus-trap coverage, and `AiVoicePanel.tsx` keyboard (`Ctrl+Enter`, `VOC-T28`) & unmount mic cleanup (`VOC-T27`) |

## 2. Pending External Verification Gates (Blocked Until `APPROVAL-04..07`)

- Desktop Microsoft Word / Excel / PowerPoint reference round-trip compatibility (`PPT-T06`, `NFR-T33`, `NFR-T34`, `NFR-T35` — `TF-05`/`TF-06`).
- Live bilingual LLM benchmark (`NFR-T30` — `TF-02`) and consented native Khmer (`km-KH`) & English human speech WER/CER corpus (`NFR-T31` — `TF-03`).
- Multi-user staging load, cloud multi-AZ HA failover, and live telemetry/alerting drills (`NFR-T01`, `NFR-T02`, `NFR-T14`, `NFR-T17`, `NFR-T19` — `TF-09`).
- Independent external penetration test (`NFR-T29` — `TF-12`) and full live production E2E drill (`E2E-06`).

