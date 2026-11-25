# Gates G0 & G1 Consolidated Engineering Evidence Packet

**Date:** 26 November 2026  
**Prepared For:** Founder & CTO Review (Handover V1.1 §10 Required Format `(a)`–`(j)`)

---

## (a) Exact Authorized Gate
- **Executed:** Gate **G0** (Reproducible Engineering Baseline + Bounded Security/Correctness Fixes) and Gate **G1** (D1-R Pagination & Khmer Render Verification, Bilingual Speech Scoring Harness, SS-00 Controlled Benchmarks, FR-04 `DP-00` DuckDB vs. Polars Feasibility Spike, and D2 PostgreSQL Architecture Design).
- **Not Executed (Gated):** Production `D2`, `D3`, `SS-01`, `DP-01`, live external cloud audio/LLM APIs, commercial software purchases, machine-wide Git/Python installs, and public deployment.

## (b) Completed, Incomplete & Blocked Tasks
- **Completed:**
  - G0 environment & security audit (`PROVISIONAL_AUTH_LOOPBACK_ONLY`, canonical `tiptapCodec.ts`, ZIP traversal/OLE2/external-rels guards, whitespace-aware CSV injection escaping, `package-lock.json` + artifact SHA-256 hashes, `npm audit` disclosure).
  - G1.1 Document pagination & visual Khmer render verification (1-page formal letter, `>=2`-page report, landscape brief, headless Edge PNG screenshots inspected directly).
  - G1.2 Bilingual speech scoring harness (`computeEnglishWer`, `computeKhmerCer`, `computeKhmerSegmentedWer`, `summarizeVoiceBenchmark`).
  - G1.3 Controlled multi-run SS-00 spreadsheet benchmarks (`20k` dense, `47k` sparse, `200k` dense) + weighted scorecard.
  - G1.4 FR-04 `DP-00` spike (`engines/data-processing`) verifying `DAT-T01..DAT-T18`, hardened DuckDB `enable_external_access=false`, and DuckDB `v1.4.5` vs. Polars `0.26.2` parity & 10k/100k benchmarks.
  - G2 design deliverable (`documentation/D2_POSTGRESQL_DESIGN.md`).
- **Blocked / Pending Founder Approval:**
  - Local Git repository initialization (`git` CLI absent on host; install requires founder approval).
  - Live `km-KH` / `en-US` audio WER benchmarking (requires approval for local Faster-Whisper / Python setup or cloud STT accounts/spend).
  - Commercial quotes/trials for Tiptap Pages, Univer Pro, Handsontable + HyperFormula, or ONLYOFFICE Developer Edition.
  - 1,000,000-row DP-01 worker stress test (deferred to isolated worker phase).

## (c) Source Changes & Version-Control Status
- **Git Status:** `git` CLI is not installed and no `.git` folder exists at `ai-office-suite/` or parent root (`git` status check verified). All work lives cleanly inside `c:\Users\Reinh\OneDrive\Desktop\AI Office Project\ai-office-suite\`; zero files outside `ai-office-suite/` were touched.
- **Key Files Added/Modified in G0/G1:**
  - `engines/document/src/tiptapCodec.ts`, `apps/web/{vite.config.ts,tsconfig.json,src/App.tsx}`
  - `apps/api/src/{app.ts,server.ts}`, `packages/validation/src/index.ts`, `packages/shared-contracts/src/index.ts`
  - `engines/file-conversion/src/{docxImporter.ts,pdfExporter.ts}`
  - `engines/calculation/src/xlsxCsv.ts`
  - `engines/speech/src/{benchmark.ts,index.ts}`
  - `engines/data-processing/{package.json,src/{pipeline.ts,duckdbRunner.ts,polarsRunner.ts,index.ts}}`
  - `tests/fixtures/g1-pagination-fixtures.ts`, `tests/{d1-docx-pdf-roundtrip,d1-speech-adapter,d1-spreadsheet-feasibility,g1-dp00-data-preparation}.test.ts`
  - `documentation/{D2_POSTGRESQL_DESIGN,DATA_PREPARATION_FEASIBILITY_REPORT,G0_G1_EVIDENCE_PACKET,TECHNICAL_DECISIONS,REQUIREMENTS_REGISTER,DEVELOPMENT_ROADMAP,SECURITY_MODEL,RISK_REGISTER,TEST_STRATEGY,SPREADSHEET_FEASIBILITY_REPORT,D1_FEASIBILITY_REPORT,DEVELOPMENT_STATUS,CHANGELOG}.md`

## (d) Actual Commands, Exits & Results (Host: Windows 11 Pro `10.0.26300`, Ryzen 7 5800H 8C/16T, 31.36 GB RAM, Node `v24.22.3` x64)

| Command | Exit | Observed Output |
| :--- | :---: | :--- |
| `node scripts/check-licenses.mjs` | `0` | Scanned `430` installed third-party package versions (`39` direct dependencies); `0` disallowed licenses. |
| `npm.cmd audit --omit=dev --audit-level=high` | `0` | `0` high/critical; **2 moderate** advisories (`uuid <11.1.1` via `exceljs@4.4.0`, `GHSA-w5hq-g745-h8pq`). |
| `npm.cmd run typecheck` | `0` | `0` TypeScript errors across all workspaces, API, Web, and test files. |
| `npm.cmd run build` | `0` | API compiled via `tsc`; Web built `107` modules including Khmer `.woff2` bundles. |
| `npm.cmd test` | `0` | **7/7 test files, 19/19 tests passed** in `28.74s` (earlier failed intermediate test runs logged honestly in session history). |
| Legacy naming hygiene scan | `0` | `0` legacy project name matches across `ai-office-suite/`. |

## (e) Test Cases, Benchmarks & Exact SHA-256 Artifact Checksums

### Generated Artifacts (`ai-office-suite/`)
| File | Size | SHA-256 |
| :--- | ---: | :--- |
| `package-lock.json` | 267,900 B | `8FFF689F223388B3F88EBF37E0C67FAFD6F61BD90B2BCB6CD0C6AEEDFB061422` |
| `tests/artifacts/bilingual-finance-workbook.xlsx` | 7,591 B | `12F67BB6A807B67F5488B9A8F0ADD9B4134A391E31A6D0C483E3079CFB8D90FD` |
| `tests/artifacts/bilingual-management-report.docx` | 12,804 B | `36E2ED98928CAA45C6343ED2D351A99A5CF3A8713F07A86AEBBEFCCC40796167` |
| `tests/artifacts/bilingual-management-report.pdf` | 95,306 B | `1CE43AFA311A0F23B10444B054C5B786A36B4F445D0EEA695DF5D8C75FD0A8B4` |
| `tests/artifacts/formal-bilingual-letter.pdf` | 36,577 B | `32DC87F55E06540AFE4665DCCA2CC918117284335356993AE644108CD68D9389` |
| `tests/artifacts/bilingual-management-report-render.png` | 94,703 B | `8A5B308CDBCBBF0E8F172F1ADD31AC229BB3AD79E4C52F19845931026339AAB1` |
| `tests/artifacts/formal-letter-render.png` | 56,223 B | `58B77069EAECDD28C8764776899989D6E6ADFB91A9A4E6413B9BBDA65EDAB004` |

### Measured Benchmarks
- **SS-00 Controlled Spreadsheet Recalculation (1 warm-up + 5 runs):**
  - `dense_1k_x_20` (20,000 cells): `p50 = 248.67 ms`, `p95 = 316.29 ms`, `rssDelta = +43.35 MB`
  - `sparse_10k_x_20` (47,000 cells): `p50 = 671.71 ms`, `p95 = 724.25 ms`, `rssDelta = +91.32 MB`
  - `dense_10k_x_20` (200,000 cells): `p50 = 2479.59 ms`, `p95 = 2609.55 ms`, `rssDelta = +68.98 MB`
- **DP-00 DuckDB (`v1.4.5`) vs. Polars (`0.26.2`) Stress (warm-up + 3 runs):**
  - `10,000` rows: DuckDB `p50 = 28.65 ms / +0.55 MB RSS` vs. Polars `p50 = 93.51 ms / +10.83 MB RSS`
  - `100,000` rows: DuckDB `p50 = 115.26 ms / +0.96 MB RSS` vs. Polars `p50 = 90.63 ms / +48.23 MB RSS`

## (f) Mock vs. Live Distinctions
- **Speech Recognition:** `MockSpeechAdapter` (`isMock: true`) used for all speech pipeline tests; live providers (`google-cloud-stt-v2`, `azure-speech`, `faster-whisper`) fail closed with `423`. Zero live acoustic audio tested.
- **AI Planning:** Rule-based deterministic EN/KM planners in `modules/ai`, `engines/calculation`, and `engines/data-processing`; no live LLM API calls made.
- **PDF, DOCX, XLSX, DuckDB & Polars:** Executed against real engines (`docx`, `mammoth`, `exceljs`, headless Microsoft Edge `158.0.4370.33`, `@duckdb/node-api v1.4.5`, `nodejs-polars 0.26.2`).

## (g) Dependency, License & Vendor Quote Status
- All 39 direct dependencies use permissive licenses (`MIT`, `BSD-2-Clause`, `Apache-2.0`, `OFL-1.1`). Two non-SPDX transitive packages (`buffers@0.1.1` pre-SPDX MIT/X11; `nodejs-polars-win32-x64-msvc@0.26.2` MIT per parent `LICENSE`) are explicitly documented; `jszip@3.10.2` uses permissive `MIT` branch.
- **Vendor Quotes Unavailable / Pending:** Tiptap Pages, Univer Pro, Handsontable + HyperFormula commercial, and ONLYOFFICE Developer Edition require formal vendor outreach and legal review.

## (h) Measured Limitations & Security Findings
- `npm audit --omit=dev` flags 2 moderate `uuid <11.1.1` advisories via `exceljs@4.4.0`.
- DuckDB `DECIMAL(18,2) / DECIMAL(18,2)` returned `333.3333333333333` — FR-05 must enforce explicit financial rounding rules.
- Dense `200,000`-cell JS-object evaluation took `~2.48s` (`p50`) — confirms why production Spreadsheet Studio must not rely on a naive JS evaluator for large workbooks.
- Provisional D1 header auth is restricted strictly to `127.0.0.1`/`localhost` and cannot run in `production`.

## (i) Proposed Decisions with Alternatives
- **Document Editor (`TD-DOC-01`):** Tiptap MIT core + canonical `StudioDocument`; evaluate Tiptap Pages vs. bounded custom pagination in D3.
- **Data Prep (`TD-DATA-01`):** DuckDB (`@duckdb/node-api`, MIT) over Polars (`nodejs-polars`) for lower Node RSS overhead and built-in SQL external-access sandboxing.
- **Control Plane (`TD-PLAT-01`):** PostgreSQL 16/17 with RLS (`D2_POSTGRESQL_DESIGN.md`) + object storage.

## (j) Next Actions Requiring Founder Approval
1. Approve installing **Git for Windows** to initialize a clean local baseline commit/tag before D2.
2. Approve **Phase D2** local PostgreSQL + auth/RBAC extraction (disposable local DB, synthetic tenants).
3. Approve vendor outreach for **Tiptap Pages** and **Univer Pro vs. Handsontable + HyperFormula** commercial terms.
4. Approve local **Faster-Whisper** evaluation setup (Python/model download) and/or cloud STT pilot budget/region/consent before live speech benchmarking.
