# Technical Decisions Register — AI Office Suite

**Phase:** Gates **G0** & **G1** Baseline (Reconciled with Main Engineering Handover V1.1)  
**Authorization Rule:** All entries below reflect feasibility recommendations and local prototype baselines — **no commercial purchase, cloud audio upload, or D2+ production deployment is authorized without separate founder sign-off.**

## 1. Formal Decision Records (`TD-*`)

| ID | Topic | CTO / Engineering Recommendation | Status | Evidence & Open Gate |
| :--- | :--- | :--- | :--- | :--- |
| **TD-DOC-01** | Document Editor & Pagination | Retain **Tiptap / ProseMirror (MIT core)** + canonical `StudioDocument` + shared `tiptapCodec.ts` (eliminates UI/backend drift). Evaluate **Tiptap Pages** commercial terms vs. bounded custom pagination before D3. Exclude ONLYOFFICE Community Edition (AGPL v3). | Proposed for D1/G1; **D3 pagination open** | `tests/d1-docx-pdf-roundtrip.test.ts` + visual PNG renders (`formal-letter-render.png`, `bilingual-management-report-render.png`) |
| **TD-VOICE-01** | Bilingual EN/KM Speech | Retain provider-independent `SpeechRecognitionAdapter` + `MockSpeechAdapter` (`isMock: true`). Evaluate **local Faster-Whisper** first, then **Google Cloud STT V2 (`km-KH`)** and **Azure Speech (`km-KH`)** on a consented corpus. | Local WER/CER harness built; **live benchmark BLOCKED pending approval** | `engines/speech/src/benchmark.ts` + `tests/d1-speech-adapter.test.ts` |
| **TD-SHT-01** | Spreadsheet Engine | Retain 19-function prototype evaluator strictly as reference/spike (`#CYCLE!` prototype diagnostic noted). Compare **Univer (Apache-2.0 + Pro quote)** vs **Handsontable + HyperFormula (Commercial quote)** vs optional ONLYOFFICE Developer quote before SS-01. | Spike verified; **commercial vendor quotes needed** | `SPREADSHEET_FEASIBILITY_REPORT.md` + weighted 0–5 scorecard |
| **TD-PLAT-01** | Application DB & Storage | **PostgreSQL 16/17** (control plane, RLS, composite tenant FKs, atomic version pointers) + **Object Storage Adapter** (immutable binaries/versions). Keep `.local-data/` prototype store until D2 migration dry-run passes. | **Design documented; D2 implementation gated** | `documentation/D2_POSTGRESQL_DESIGN.md` |
| **TD-GIT-01** | Local Version Control | Install official **Git for Windows** with founder permission and initialize clean local baseline commit/tag before substantial D2 work. | **Pending founder install permission** | Verified `git` CLI absent and no `.git` directory in host check |
| **TD-DATA-01** | FR-04 Data Preparation Engine | **DuckDB (`@duckdb/node-api@1.4.5-r.1`, MIT)** recommended as primary DP-00/DP-01 worker engine over `nodejs-polars@0.26.2` (`+0.87 MB` RSS vs `+51.53 MB` at 100k rows; hardened `enable_external_access=false`). | **DP-00 spike verified; DP-01 gated** | `DATA_PREPARATION_FEASIBILITY_REPORT.md` + `tests/g1-dp00-data-preparation.test.ts` |

## 2. Supply Chain & `npm audit` Disclosure

- `node scripts/check-licenses.mjs`: **0** AGPL or GPL-only direct dependencies; `jszip@3.10.2` uses permissive `MIT` branch of `(MIT OR GPL-3.0-or-later)`; `buffers@0.1.1` (pre-SPDX MIT/X11) and `nodejs-polars-win32-x64-msvc@0.26.2` (MIT per parent `LICENSE`) are explicitly recorded. License script is a preliminary gate, **not legal clearance**.
- `npm audit --omit=dev`: **0 high/critical**, **2 moderate** advisories (`uuid <11.1.1` via `exceljs@4.4.0`, `GHSA-w5hq-g745-h8pq`). Tracked in `RISK_REGISTER.md`.
