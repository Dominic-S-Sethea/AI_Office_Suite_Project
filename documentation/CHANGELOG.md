# Changelog — AI Office Suite

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
