# FR-06 `PS-00` & FR-07 `BI-00` Consolidated Engineering Evidence Packet

**Date:** 26 November 2026  
**Prepared For:** Founder & CTO Review (Handover V1.2 §14–§16 Exit Gate)

---

## (a) Exact Authorized Scope Executed

- **Executed (Bounded Local Feasibility):**
  1. **FR-06 `PS-00` Presentation Studio Feasibility (`engines/presentation`):**
     - Application-owned `StudioPresentation`, `PresentationSlide`, `SlideGeometry` (EMU + 16:9 96 DPI pixel conversion), `PresentationTheme` (`CORPORATE_THEME_V1/V2`), and `SlideElement` discriminated union in `packages/shared-contracts`.
     - Real native OOXML export (`src/pptxExporter.ts` via `pptxgenjs@4.0.1` MIT) emitting editable `<p:sp>`, `<a:tbl>`, `<c:chart>`, embedded images, speaker notes, and strict `ExportDisclosurePolicy` stripping hidden slides and speaker notes (`PPT-T19`).
     - Hardened `.pptx` import (`src/pptxImporter.ts` via `fflate@0.8.2` MIT + `validatePptxUploadBytes` in `packages/validation`) with ZIP slip, compression ratio, macro `.bin`/`.pptm`, OLE2 embed, external `.rels` URI guards, unsupported SmartArt/animation notices, and SHA-256 source preservation.
     - Headless Chromium/Edge HarfBuzz 16:9 PDF + PNG visual renderer (`src/slidePdfRenderer.ts`) and layout overflow / contrast / Khmer script validation (`src/presentationEngine.ts`), covering `PPT-T01..T20` plus 5/20/50-slide export benchmarks.
  2. **FR-07 `BI-00` Intelligence Studio Feasibility (`engines/intelligence`):**
     - Shared canonical `ChartSpec`, `ChartDataBinding`, `DataScopePolicy`, `FilterContext`, `StudioReport`, `RefreshJobRecord`, and `PublishedBiSnapshot` contracts in `packages/shared-contracts` plus `validateChartSpecSafety` in `packages/validation`.
     - Real headless SSR SVG + `aria.enabled` + HTML `<table>` fallback + Edge PNG rendering via `echarts@6.1.0` (`Apache-2.0`) paired with a constrained zero-bundle `compileChartSpecToVegaLiteJson()` parity comparator (`src/chartAdapters.ts`).
     - Governed Section 12 Golden Management Fixture evaluated directly through FR-05 `BusinessAnalysisEngine` (`FIN-POL-V1` `BigInt` minor units + hardened DuckDB), enforcing `DataScopePolicy` row/column intersection, policy-keyed cache isolation (`BI-T18`), immediate principal revocation (`BI-T19`), stale interaction sequence guard (`BI-T22`), drill-through column stripping (`BI-T07`), refresh failure/retry/cancel preservation (`BI-T20..T23`), publication validation gate (`BI-T24..T25`), summary CSV vs. underlying detail denial (`BI-T26..T27`), 6-slide dashboard-to-presentation handoff (`BI-T29`), cross-module `X-VIS-01..08` reconciliation (Sheet + Doc + BI + PPTX), and 10k/100k workload benchmarks.
  3. **Documentation Reconciliation (§15–§16):** Created **12** new `PS-00`/`BI-00`/evidence documents and updated **12** existing architecture, roadmap, security, contract, decision, test, risk, changelog, and status documents.
- **Not Executed (Remaining Gated):**
  - Production rollouts `PS-01..PS-12`, `ENG-BI-01..ENG-BI-11`, `D3`, `SS-01`, `DP-01`, and `AN-01`.
  - P1 features `BI-T33` (threshold alerts) and `BI-T34` (scheduled refreshes).
  - Commercial software purchases, paid cloud accounts, external data/audio uploads, public deployments, and Git remote pushes.

## (b) Completed, Incomplete & Blocked Tasks

- **Completed:**
  - `engines/presentation` (`PPT-T01..T20` domain logic, OOXML export/import, HarfBuzz PDF/PNG render, 5/20/50-slide benchmarks).
  - `engines/intelligence` (`BI-T01..T32`, `X-VIS-01..08`, DuckDB + ECharts SSR SVG/PNG, constrained Vega-Lite JSON parity check, 10k/100k workloads).
  - Shared `ChartSpec` contracts & upload/spec validators; full license/audit/typecheck/build/test green across all `11/11` suites (`29/29` tests).
  - Visual PNG inspection of rendered presentation slides and ECharts BI output via `read_file`.
- **Incomplete / Pending / Blocked Outside Sandbox:**
  1. **`PPT-T06` Reference Desktop Opening (`PENDING reference viewer`):** Neither Microsoft PowerPoint (`POWERPNT.EXE`) nor LibreOffice Impress (`soffice.exe`) is installed on this Windows host. Generated `.pptx` packages were verified structurally (`fflate` unzip of `ppt/slides/slide*.xml`, `ppt/charts/chart*.xml`, Unicode preservation, disclosure redaction) and via Chromium/Edge HarfBuzz PDF/PNG rendering, **not** by manual open in desktop PowerPoint or LibreOffice Impress.
  2. **`BI-T33` & `BI-T34` (`PENDING P1`):** Scheduled refresh jobs and alert rules are modeled at contract/policy level and intentionally deferred to P1 after P0 gate sign-off.
  3. **Commercial Vendor Quotes (`PENDING`):** Outreach briefs in `VENDOR_OUTREACH_BRIEFS.md` remain awaiting founder dispatch/replies prior to `D3`/`SS-01` commitments.
  4. **Native Khmer (`km-KH`) Live Speech Corpus (`PENDING`):** External cloud STT remains fail-closed (`423`) and real Khmer speaker WER/CER validation awaits a consented corpus.

## (c) Source Changes & Version-Control Status

- **Isolated Local Git Repository:** `c:\Users\Reinh\OneDrive\Desktop\AI Office Project\ai-office-suite\.git` (`PARENT_HAS_GIT=False` — parent legacy directory untouched).
- **Previous Tags:** `v0.2.0-g1-baseline` (`87f9508`), `v0.3.0-d2-an00` (`342125a`).
- **Current Checkpoint Tag:** `v0.4.0-ps00-bi00` (local commit only; zero remote push).

## (d) Observed Command Results (Run `task-875`)

| Command | Exit | Observed Output |
| :--- | :---: | :--- |
| `node scripts/check-licenses.mjs` | `0` | Scanned `468` installed third-party package versions (`47` direct dependencies); `0` disallowed licenses (`jszip@3.10.2` permissive `MIT` branch selected) |
| `npm.cmd audit --omit=dev --audit-level=high` | `0` | `0` high or critical production advisories; discloses `2` pre-existing moderate `uuid <11.1.1` advisories via `exceljs@4.4.0` |
| `npm.cmd run typecheck` | `0` | `tsc -p tsconfig.typecheck.json --noEmit` completed with `0` errors |
| `npm.cmd run build` | `0` | `build:api` (`tsc -p apps/api/tsconfig.build.json`) + `build:web` (`107` modules incl. Khmer `.woff2` bundles, `built in 5.80s`) |
| `npm.cmd test` | `0` | **11/11 test files, 29/29 tests passed** in `40.70s` |
| Legacy naming hygiene scan | `0` | `LEGACY_MATCH_COUNT=0` across `ai-office-suite/` |
| Parent Git check (`Test-Path '..\.git'`) | `0` | `PARENT_HAS_GIT=False` |

## (e) Measured Benchmarks, Artifacts & Visual Inspection

### Empirical Benchmarks (Observed in `task-875`)

- **`PS-00` Native PPTX Export (`tests/g1-ps00-presentation-feasibility.test.ts`):**
  - `5` slides: `30.17 ms`
  - `20` slides: `54.39 ms`
  - `50` slides: `96.85 ms`
- **`BI-00` DuckDB + ECharts SSR SVG Workload (`tests/g1-bi00-intelligence-feasibility.test.ts`):**
  - `10,000` rows + `4` rendered visuals: `p50 = 120.04 ms`, `p95 = 177.04 ms`, `rssDelta = +2.35 MB`
  - `100,000` rows + `8` rendered visuals: `p50 = 158.38 ms`, `p95 = 168.22 ms`, `rssDelta = +12.95 MB`
- **Preserved Prior Suite Benchmarks (Re-verified in `task-875`):**
  - `AN-00` DuckDB Analytical Stress: `10k` `p50 = 20.56 ms` (`p95 = 37.58 ms`, `+0.62 MB`); `50k` `p50 = 28.46 ms` (`p95 = 42.35 ms`, `+0.66 MB`).
  - `DP-00` DuckDB vs Polars (`100k`): DuckDB `p50 = 99.37 ms` (`p95 = 102.42 ms`, `+1.28 MB`) vs Polars `p50 = 103.79 ms` (`p95 = 231.73 ms`, `+51.84 MB`).
  - `SS-00` Formula Engine: `dense20k` `p50 = 314.5 ms` (`p95 = 381.46 ms`, `+44.86 MB`); `sparse10kRows` (`47,000` cells) `p50 = 767.65 ms` (`p95 = 1152.48 ms`, `+88.02 MB`); `dense200k` `p50 = 2144.86 ms` (`p95 = 3014.72 ms`, `+70.88 MB`).

### Generated Artifact Inventory & SHA-256 Checksums (`task-875`)

| Artifact Path | Size | SHA-256 |
| :--- | :---: | :--- |
| `package-lock.json` | `285,306 B` | `992FA2A38F544476B999A74AAA783AD17DEB0E7BD0E05B15011594DE86595233` |
| `tests/artifacts/management-review-deck.pptx` | `163,175 B` | `A12BA64B5C95CC22BA7687E77218198B3EB4F77D6A933F08F2910DFD043864C8` |
| `tests/artifacts/management-review-deck.pdf` | `135,304 B` | `1026450181321B0C20199405761CA0BEB6AA916246DBC4AA0307EF3638D47D80` |
| `tests/artifacts/management-review-slide1.png` | `31,531 B` | `90D92C3DD624BFCEFD9F6EDF17B138AF1F8BEB9CB36E10F37883F3A7D2E07BD3` |
| `tests/artifacts/management-review-slide3-chart.png` | `25,421 B` | `D0D678D038F32DCE66CC871B4018A76FE917E5AC3ED783FD9454154F846CF963` |
| `tests/artifacts/scoped-sales-services-deck.pptx` | `163,021 B` | `FFF7518C3148F139B80579CF30FD4B2F2702E92E11AB434ACB16DF74716F2B77` |
| `tests/artifacts/bi-dashboard-revenue-chart.png` | `14,556 B` | `F5DC03237FFCE22D7A2B8F84B62103B9602855D0BB984C2E660458F98B43A6A8` |

### Visual PNG Inspection Findings (Observed Directly via `read_file`)

- **`tests/artifacts/management-review-slide1.png`:** Crisp navy banner header with top-right embedded raster emblem, sharp bilingual title `Monthly Management Review · របាយការណ៍គ្រប់គ្រងប្រចាំខែ` rendered without tofu or subscript collision, and clean subtitle `Scope: All Departments (November 2026) · Verified FR-05 Manifest (v1)`.
- **`tests/artifacts/management-review-slide3-chart.png`:** Crisp `Revenue Comparison by Department` slide with card subtitle `November Revenue by Department (USD)` and vertical bars labeled `$80,000` (Sales), `$45,000` (Services), and `$25,000` (Retail); after raising `padT` to `56`, `$80,000` clears the card subtitle cleanly.
- **`tests/artifacts/bi-dashboard-revenue-chart.png`:** Crisp Apache ECharts grouped bar chart (`Revenue versus budget`) showing top-right legend (`Actual Net Sales`, `Approved Budget`), explicit `0` baseline (`0`–`80,000`), and exact values (`80000/75000`, `45000/40000`, `25000/25000`).

## (f) Mock vs. Live Distinctions

- **Live / Native Local Execution:**
  - `pptxgenjs@4.0.1` real OOXML `.pptx` generation & `fflate@0.8.2` `.pptx` zip/XML parser + security scanner.
  - `echarts@6.1.0` headless SSR `<svg>` + Edge PNG screenshot rendering (`animation: false`).
  - Headless Edge HarfBuzz 16:9 PDF + PNG slide export using embedded `Inter` and `Noto Sans Khmer` / `Kantumruy Pro` fonts.
  - FR-05 `BusinessAnalysisEngine` (`@duckdb/node-api@1.4.5-r.1` with `enable_external_access = false` + `BigInt` minor-unit arithmetic) & PGlite embedded PostgreSQL RLS (`tests/d2-platform-pg-auth.test.ts`).
- **Explicit Mocks / Constrained Comparators:**
  - `planPresentationOperation()` (`engines/presentation`) and `planBiDashboardCommand()` (`engines/intelligence`) are explicit deterministic EN/KM mock planners (`isMockPlanner: true`); live LLM planners require external model routing & approval.
  - `compileChartSpecToVegaLiteJson()` evaluates Vega-Lite grammar parity from the exact same `ChartSpec` JSON schema without bundling a second charting runtime.
  - Vitest speech suite uses `MockSpeechAdapter` (`isMock: true`) alongside fail-closed live adapter tests.

## (g) Dependency & License Audit

- Added runtime dependencies: `pptxgenjs@4.0.1` (`MIT`), `echarts@6.1.0` (`Apache-2.0`).
- Added root npm override: `"overrides": { "image-size": "^2.1.0" }` (`MIT`) to replace transitive `image-size@1.2.1` requested by `pptxgenjs@4.0.1`.
- Production vulnerability posture (`npm.cmd audit --omit=dev --audit-level=high`): Exit `0`, `0` high/critical advisories (`2` pre-existing moderate `uuid <11.1.1` advisories via `exceljs@4.4.0` disclosed).

## (h) Findings & Remediations Applied During Execution

1. **`pptxgenjs` Transitive `image-size@1.2.1` DoS Advisories (`GHSA-5p2g-fcmc-qvqq`, `GHSA-w3rx-r6r6-pgpr`):** Eliminated cleanly via root `"overrides": { "image-size": "^2.1.0" }` in `package.json`, restoring clean exit `0` on production high+ `npm audit`.
2. **Empty `ppt/notesSlides/notesSlide*.xml` Skeletons in `pptxgenjs@4.0.1`:** Discovered `pptxgenjs` emits empty notes XML skeletons even when notes are omitted; hardened `PPT-T19` verification and importer checks to assert absence of speaker-note text content across all `notesSlide*.xml` entries.
3. **Slide 3 Bar Chart Label Clearance:** Initial visual PNG inspection caught `$80,000` sitting close to the bar top/subtitle; increased SVG chart top padding `padT` from `36` to `56` in `engines/presentation/src/slidePdfRenderer.ts` and re-verified cleanly.
4. **DuckDB High-Volume BI Benchmarking:** Replaced sequential `4 × 100k` per-row N-API `stmt.run()` inserts (which previously timed out at `>30s`) with native DuckDB bulk SQL `range(0, rowCount)` staging (`100k` rows + `8` ECharts SVGs now `p50 = 158.38 ms`, `p95 = 168.22 ms`).
5. **Parallel Vitest `beforeAll` Contention:** Raised `testTimeout` and `hookTimeout` to `60000` in `vitest.config.ts` and guarded `afterAll` cleanup in `tests/d2-platform-pg-auth.test.ts` so all `11/11` concurrent suites (`29/29` tests) pass reliably.

## (i) Key Architectural Decisions Recorded (`TECHNICAL_DECISIONS.md`)

- **`TD-PPT-01`:** Application-owned `StudioPresentation` model + native `pptxgenjs` export + `fflate` hardened import + Edge HarfBuzz PDF/PNG render.
- **`TD-CHART-01`:** Single canonical `ChartSpec` contract backed by Apache ECharts (`echarts@6.1.0` `Apache-2.0`) for UI/BI/PDF and native `<c:chart>` for PPTX, compared against Vega-Lite JSON without bundling two chart runtimes.
- **`TD-BI-01`:** Application-owned React Intelligence Studio dashboard layer bound directly to FR-05 `BusinessAnalysisEngine` and shared `DataScopePolicy` / `audit_logs` rather than embedded Metabase/Superset.

## (j) Founder Decisions Required Prior to `PS-01` / `ENG-BI-01` Production Buildout

1. **Authorize `PPT-T06` Reference Machine Check:** Schedule desktop verification of `management-review-deck.pptx` and `scoped-sales-services-deck.pptx` in Microsoft PowerPoint and/or LibreOffice Impress on an Office-equipped workstation before starting `PS-01`.
2. **Approve `PS-00` & `BI-00` Architecture Directions (`TD-PPT-01`, `TD-CHART-01`, `TD-BI-01`):** Confirm go-ahead to build production `PS-01` and `ENG-BI-01` (alongside previously gated `D3`/`SS-01`/`DP-01`/`AN-01` scoping).
3. **Dispatch Commercial Vendor Briefs (`VENDOR_OUTREACH_BRIEFS.md`) & Speech Corpus Plan:** Provide written Tiptap Pages / Univer Pro / Handsontable quotes and consented Khmer (`km-KH`) + English corporate audio samples before committing `D3`/`SS-01` or voice production targets.
