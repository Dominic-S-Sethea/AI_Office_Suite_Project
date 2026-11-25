# Changelog — AI Office Suite

## [0.4.0-ps00-bi00] — 2026-11-26 (FR-06 PS-00 Presentation & FR-07 BI-00 Intelligence Studio Feasibility)

### Added & Verified
- **FR-06 Presentation Studio (`engines/presentation`, `PS-00`):** Added canonical `StudioPresentation`/`SlideElement` contracts, EMU/px geometry conversion, layout overflow & a11y checks (`validatePresentationLayoutAndA11y`), `pptxgenjs@4.0.1` native editable PPTX exporter (with `"overrides": { "image-size": "^2.1.0" }` fixing high DoS advisories), `fflate` hardened `.pptx` importer, Edge HarfBuzz 6-page PDF & 16:9 PNG renderer, and bilingual mock operations (`tests/g1-ps00-presentation-feasibility.test.ts` covering `PPT-T01..T20`; `PPT-T06` reference PowerPoint viewer open noted as pending).
- **FR-07 Intelligence Studio (`engines/intelligence`, `BI-00`):** Added shared `ChartSpec`/`ChartDataBinding` contracts compiled into `echarts@6.1.0` (Apache-2.0) SSR SVG + HTML `<table>` fallback and constrained Vega-Lite comparison JSON; integrated Section 12 Golden Fixture directly over FR-05 `BusinessAnalysisEngine` (`DataScopePolicy` intersection, policy-keyed caching, principal revocation, race-guarded filtering, drill-through column projection, draft refresh/failure/retry, immutable snapshots, summary CSV export, dashboard-to-presentation generation, and `X-VIS-01..08` cross-module reconciliation).

## [0.3.0-d2-an00] — 2026-11-26 (Phase D2 Platform Foundation, FR-05 AN-00 & Founder Approvals #1–#4)

### Added
- **Local Git Baseline (`TD-GIT-01`):** Installed portable `Git.MinGit v2.56.1` and initialized local Git repository inside `ai-office-suite/` (`v0.2.0-g1-baseline`).
- **Phase D2 Platform Foundation (`platform/database`, `platform/identity`):** Implemented PostgreSQL RLS schema (`app_runtime` non-superuser role, fail-closed `tenant_isolation_*` policies, `REVOKE UPDATE/DELETE ON audit_logs`), `PgliteDatabaseAdapter` + `NodePgDatabaseAdapter`, atomic revision-pointer concurrency updates (`409`), reversible `.local-data/` migrator + logical SQL backup/restore, `aios_session` HttpOnly cookie + HS256 JWT + live `token_version` epoch revocation, CSRF origin validation, and `authMode: "jwt-pg"` in `apps/api`. Zero legacy naming carried over.
- **FR-05 `AN-00` Business Analysis Engine (`engines/analytics`):** Extended `LinkedMetricReference` in place; added `BusinessMetricRegistry`, exact `BigInt` minor-unit engine (`FIN-POL-V1` with `HALF_UP`/`HALF_EVEN`, zero-denominator unavailable, overflow guard, 10-decimal FX conversion), hardened DuckDB analytical execution (`enable_external_access=false`), granularity-safe budget vs. actual, combined departmental ratios, bilingual EN/KM deterministic planner, and `tests/g1-an00-analytics-feasibility.test.ts` covering `ANA-T01..T18` + 10k/50k stress benchmarks.
- **Vendor Briefs & Speech Runtime:** Added `VENDOR_OUTREACH_BRIEFS.md` and local `FasterWhisperLocalAdapter` + `scripts/faster_whisper_worker.py`.

## [0.2.0-g1] — 2026-11-26 (Gates G0, G1 & FR-04 DP-00)

### Added & Hardened
- **G0 Security & Canonical Sync:** Enforced loopback-only guard (`PROVISIONAL_AUTH_LOOPBACK_ONLY`) and `X-Auth-Mode: provisional-local-prototype` in `apps/api`; extracted browser-safe `engines/document/src/tiptapCodec.ts` so `apps/web` uses the single canonical `toTiptapJson`/`fromTiptapJson` codec; added ZIP path-traversal, OLE2 encrypted container, and external `*.rels` checks in DOCX/XLSX importers; upgraded OWASP CSV formula escaping to handle leading whitespace/control chars.
- **G1.1 & G1.2 Pagination & Speech Scoring:** Added 1-page formal letter, multi-page report, and landscape fixtures; added `countPdfPages` and `renderDocumentScreenshot` with visual PNG verification (`bilingual-management-report-render.png`, `formal-letter-render.png`); added `engines/speech/src/benchmark.ts` (English WER, Khmer grapheme CER, Khmer segmented WER).
- **G1.3 Controlled Spreadsheet Benchmarks:** Added 1 warm-up + 5-run `p50`/`p95` + RSS delta benchmarks across dense 20k, sparse 47k, and dense 200k cells.
- **G1.4 FR-04 DP-00 Data Preparation Spike:** Implemented `engines/data-processing` (`pipeline.ts`, `duckdbRunner.ts` using `@duckdb/node-api@1.4.5-r.1`, `polarsRunner.ts` using `nodejs-polars@0.26.2`) covering all 18 scenarios `DAT-T01..DAT-T18`, hardened `enable_external_access=false`, and 10k/100k stress benchmarks.
- **D2 Design & Evidence Packet:** Added `D2_POSTGRESQL_DESIGN.md`, `DATA_PREPARATION_FEASIBILITY_REPORT.md`, and `G0_G1_EVIDENCE_PACKET.md`.

## [0.1.0-d1] — 2026-11-26 (Phases D0, D1 & FR-03 SS-00)

### Added
- **D0 Governance & Workspace:** Isolated modular monorepo under `ai-office-suite/` (`packages/*`, `platform/*`, `engines/*`, `modules/*`, `apps/*`, `tests/*`, `documentation/*`), automated dependency license gate (`scripts/check-licenses.mjs`), CI workflow, and all 13 master engineering documents.
- **D1.01 & D1.03 Document & Conversion Engines:** Canonical `StudioDocument` AST, `Intl.Segmenter` Khmer grapheme/word safety (`engines/document`), OOXML `.docx` export (`docx` MIT), safe `.docx` import with macro blocking & unsupported-feature diagnostics (`mammoth` BSD-2-Clause + `fflate` MIT), and Chromium/Edge HarfBuzz searchable PDF renderer with local SIL OFL Khmer fonts (`@fontsource/noto-sans-khmer`, `@fontsource/kantumruy-pro`).
- **D1.02 Speech Adapter:** Provider-independent `SpeechRecognitionAdapter` with transparent `MockSpeechAdapter` (`en-US`, `km-KH`) and fail-closed stubs for Google Cloud STT v2, Azure Speech, and Faster-Whisper.
- **D1.04 Controlled AI & Vertical Slice:** Bilingual English + Khmer planner for all 7 D1.04 operations, prompt-injection scanner, selection-hash & optimistic revision checks, idempotency deduplication, append-only redacted audit log, local Express API (`apps/api`), and React 19 + Tiptap v3 Document Studio UI (`apps/web`).
- **FR-03 / SS-00 Spreadsheet Feasibility Spike:** Isolated `engines/calculation` prototype supporting sparse cell storage, 19 MVP functions, dependency recalculation, cycle detection (`#CYCLE!`), unsupported function warnings, `exceljs` (MIT) XLSX round-trip, OWASP CSV formula-injection neutralization, and bilingual EN/KM Formula Intelligence validation.
