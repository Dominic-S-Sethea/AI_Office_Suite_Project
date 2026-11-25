# Engineering Risk Register — AI Office Suite

**Phase:** D0/D1 Baseline

| ID | Risk | Severity | Likelihood | Mitigation / Status |
| :--- | :--- | :--- | :--- | :--- |
| **R-01** | **ONLYOFFICE Community Edition AGPL v3 copyleft** forces open-sourcing commercial SaaS | Critical | High if adopted | Excluded Community Edition via `check-licenses.mjs`; ONLYOFFICE evaluated only under commercial Developer Edition terms. |
| **R-02** | **HyperFormula `GPL-3.0-only` copyleft** conflicts with proprietary commercial distribution | Critical | High if adopted | Excluded HyperFormula from D1 runtime; flagged for commercial license review if Handsontable+HyperFormula is chosen in SS-01. |
| **R-03** | **Tiptap Pro commercial dependency** (`@tiptap-pro/extension-pages`, export-docx/pdf) adds recurring vendor cost & redistribution constraints | High | Medium | Proved in D1 that Tiptap **MIT core** + CSS `@page` + `docx` (MIT) + headless Chromium HarfBuzz PDF works without Tiptap Pro; interactive multi-page visual page-breaking in-editor remains a D3 trade-off. |
| **R-04** | **Univer mixed open/commercial boundary** (Core Apache-2.0 vs commercial Pro XLSX exchange, charts, pivots) | High | Medium | Documented in `SPREADSHEET_FEASIBILITY_REPORT.md`; requires vendor quote before SS-01 commitment. |
| **R-05** | **Khmer Unicode cluster splitting & line breaking** corrupts `U+17D2` coeng subscripts during programmatic AI edits | High | High without guard | Mitigated in `engines/document/src/khmer.ts` via `Intl.Segmenter('km', { granularity: 'grapheme' })` range snapping and HarfBuzz PDF rendering. |
| **R-06** | **Khmer ASR Word Error Rate & EN/KM code-switching** degrades voice command reliability below 95% target | High | High | Mitigated by push-to-talk editable transcript review (`VOC-01`), deterministic planner validation, and gating live STT behind D1.02/D5 benchmark. |
| **R-07** | **Git CLI absent on development workstation** (`git` not installed, no `.git` repo initialized) | Medium | Observed | Documented in D0.01; recommend installing Git and initializing repository before Phase D2 multi-branch work. |
| **R-08** | **OneDrive workspace synchronization** can cause SQLite/file handle contention under heavy concurrent writes | Medium | Medium | Kept D1 prototype local data in gitignored `.local-data/`; D2 should store DB/storage outside OneDrive-synced folders. |
| **R-09** | **Prompt injection inside imported DOCX or XLSX cells** attempts unauthorized AI actions | High | Medium | Mitigated via `scanForPromptInjection()` across both command and document/cell content, plus strict RBAC and explicit approval. |
| **R-10** | **CSV formula injection, encrypted/traversal OOXML & external rels** | High | Medium | Mitigated via ZIP traversal/OLE2/macro checks, `TargetMode="External"` warnings, and whitespace-aware OWASP CSV escaping. |
| **R-11** | **`exceljs@4.4.0` moderate `uuid <11.1.1` advisory (`GHSA-w5hq-g745-h8pq`)** | Medium | Observed | Documented via `npm audit --omit=dev`; `exceljs` used strictly inside isolated feasibility conversion layers. |
| **R-12** | **DuckDB fixed-decimal division (`DECIMAL/DECIMAL -> floating approx`)** | High | Observed in DP-00 | Observed `1000.00 / 3.00 = 333.3333333333333`; FR-05 must enforce explicit financial rounding/minor-unit policies. |
