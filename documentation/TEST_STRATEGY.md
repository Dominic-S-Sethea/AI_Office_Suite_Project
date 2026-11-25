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

## 2. Pending Test Suites (Future Phases)

- Desktop Microsoft PowerPoint / LibreOffice Impress visual compatibility audit (`PPT-T06` reference viewer open).
- Live native Khmer (`km-KH`) & English (`en-US`) consented multi-speaker WER/CER evaluation (`D5`).
- Playwright browser UI E2E & WCAG 2.2 AA accessibility audit (`D3` / `D8`).
- Managed PostgreSQL failover, P1 BI alerts/scheduling (`BI-T33..T34`), and P1 forecasting backtest coverage (`AN-08` / `ENG-BI-11` / `D8`).
