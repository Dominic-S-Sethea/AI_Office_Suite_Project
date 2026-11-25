# Spreadsheet Studio Feasibility Report (FR-03 / Phase SS-00)

**Date:** 26 November 2026  
**Scope:** Isolated Stage 3 FR-03 (`SS-00`) engine comparison, licensing audit, calculation spike, XLSX/CSV safety, and bilingual EN/KM Formula Intelligence verification. **Full Spreadsheet Studio production buildout is NOT started.**

---

## 1. Engine & Licensing Comparison (Univer vs. ONLYOFFICE vs. Handsontable + HyperFormula)

| Criterion | Option A: Univer (`@univerjs/*`) | Option B: ONLYOFFICE Docs | Option C: Handsontable + HyperFormula | Option D (Evaluated Baseline): Custom / `exceljs` Spike |
| :--- | :--- | :--- | :--- | :--- |
| **Core License** | **Apache-2.0** (`@univerjs/core@1.6.2`) | **AGPL v3** (Community) / Commercial **Developer Edition** | **GPL-3.0-only** (`hyperformula@3.5.0`) / Commercial Proprietary (`Handsontable` + `HyperFormula`) | **MIT** (`exceljs@4.4.0`) + internal engine |
| **Commercial SaaS Risk** | Mixed: Core grid/formulas are Apache-2.0, while official server XLSX exchange, charts, and pivots are **commercial Univer Pro** modules. | Community Edition **prohibited** for closed-source commercial SaaS (AGPL network copyleft); requires paid Developer Edition. | `GPL-3.0-only` is incompatible with closed-source redistribution; requires commercial Handsontable + HyperFormula licenses. | Zero copyleft risk, but very high engineering cost to build full Excel UI/charting from scratch. |
| **Formula Engine & Dynamic Arrays** | Built-in formula engine in core SDK. | Mature Excel formula compatibility inside Document Server. | `HyperFormula` supports ~350–400 functions, **but lacks dynamic arrays (`FILTER`/`UNIQUE`/`SORT` spill)** and structured table refs. | Prototype spike only (19 core functions verified for SS-00). |
| **Fine-Grained AI Control** | Strong: command/mutation bus supports structured programmatic range operations. | Mediated by ONLYOFFICE `DocsAPI` / plugin bridge. | Strong programmatic grid + formula APIs. | Full control, high build cost. |
| **Khmer Locale & Typography** | DOM/Canvas grid; requires custom Khmer i18n dictionary & testing for cell text clipping. | Canvas rendering has documented Khmer cluster shaping & cursor caveats. | HTML/DOM grid leverages browser HarfBuzz/ICU for Khmer, requires explicit column-width/wrap testing. | Verified Khmer Unicode NFC, `"001245"` text IDs, USD/KHR tags in `exceljs`. |
| **Multi-Studio Synergy** | Covers Sheets, Docs, Slides — **but** Document Studio D1 recommends Tiptap MIT over Univer Docs for rich-text/DOCX workflows. | Covers Docs, Sheets, Slides — **but** failed Document Studio D1.01 license + Khmer shaping criteria. | Spreadsheet-focused only (separate from Document Studio's Tiptap engine). | — |

### SS-00 Architectural Recommendation
1. **Do NOT adopt ONLYOFFICE Community Edition** (AGPL v3 blocker) or un-licensed **HyperFormula** (`GPL-3.0-only` blocker).
2. **Primary Candidate for SS-01 Commercial Evaluation:** **Univer (Apache-2.0 core + quote for Pro XLSX/charts)** vs. **Handsontable + HyperFormula (Commercial License)**. Recommend obtaining vendor commercial quotes & running a browser-level Khmer cell-editing/virtualization POC on Univer Sheets (`@univerjs/sheets`) before committing to SS-01.
3. **Keep Calculation Authoritative on Server/Worker Side for Governed Datasets:** Even if a client grid (Univer or Handsontable) evaluates interactive cells in-browser, **FR-03 §13** requires keeping large governed datasets (`200k+` rows) and certified reporting metrics in a separate server-side analytical/calculation layer (`engines/calculation` / DuckDB in FR-04/05).

---

## 2. Empirical SS-00 Feasibility Spike Results (`engines/calculation` + `tests/d1-spreadsheet-feasibility.test.ts`)

Using a completely permissive-licensed (`MIT`) spike (`exceljs@4.4.0` + deterministic dependency evaluator), we verified the following FR-03 acceptance behaviors:

- **`SHT-T01 / T02 / T03 / T05 / T13` (Real XLSX Round-Trip & Recalculation):**
  - Exported and re-imported `tests/artifacts/bilingual-finance-workbook.xlsx` across two sheets (`Finance` and `Executive`).
  - Preserved Khmer worksheet labels (`Sales / ផ្នែកលក់`), leading-zero ID `"001245"` (`numFmt: "@"`), stored percentage `0.15` distinct from `0.00%` display format, USD vs KHR currency separation, cross-sheet reference `=Finance!E5`, and absolute reference `=Finance!E2*Finance!$G$1`.
  - Updating input `C2` (`10000 -> 14000`) automatically recalculated `E2` (`3000 -> 7000`), `E5` (`13000 -> 17000`), and `Executive!B1` (`17000`).
- **`SHT-T04 / T14` + Macro Security:**
  - Circular references (`A1 <-> B1`) detected and reported as `#CYCLE!`.
  - Division by zero reported as `#DIV/0!`.
  - Unsupported Excel functions (e.g., `XLOOKUP` in SS-00 spike) flagged as `#NAME?` with explicit `unsupportedWarning` — never silently returned as `0`.
  - Macro-bearing ZIP (`xl/vbaProject.bin`) rejected with `MACRO_WORKBOOK_BLOCKED`.
- **`SHT-T06 / T07 / T09 / T10 / T17 / T18` (Bilingual Formula Intelligence & Security):**
  - Both English (`"Calculate profit by subtracting costs from revenue"`) and Khmer (`"គណនាប្រាក់ចំណេញ ដោយយកចំណូលដកចំណាយ"`) produced editable relative formulas (`=B2-C2` filled across `D2:D4`) rather than hardcoded numbers; mutating inputs recalculated outputs accurately (**SpreadsheetBench multi-input invariance**).
  - Ambiguous `"Convert these amounts to USD"` was **blocked (`EXCHANGE_RATE_REQUIRED`)**, whereas format-only `"Format numbers as USD"` preserves underlying values.
  - Protected formula cell overwrite rejected (`403 PROTECTED_CELL`).
  - Prompt-injection text inside a worksheet cell blocked AI planning.
  - Intact-row table sorting kept `"001246"` paired with its `15000` revenue row.
  - **OWASP CSV Injection Defense:** Untrusted cell text starting with `=CMD("calc")` and `+1+1` was neutralized with leading `'` on CSV export.
## 3. Exact 19 Supported Functions in SS-00 Spike & Weighted Scorecard (`TD-SHT-01`)

**Exact 19 implemented functions in `engines/calculation/src/formulaEngine.ts`:**  
`SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `AND`, `OR`, `NOT`, `IFERROR`, `SUMIF`, `COUNTIF`, `VLOOKUP`, `ROUND`, `ABS`, `LEN`, `TRIM`, `CONCAT` (plus `+ - * / ^`, comparisons, `$A$1` absolute refs, and `Sheet!A1` cross-sheet refs).  
*Diagnostic Note:* `#CYCLE!` is a prototype cycle diagnostic string, not Excel's literal error token.

### Weighted Preliminary Scorecard (`0–5` on available evidence; `—` = vendor quote/POC still required)

| Criterion (Weight) | Univer (Core + Pro) | Handsontable + HyperFormula | ONLYOFFICE Dev | SS-00 Custom Spike |
| :--- | :---: | :---: | :---: | :---: |
| Formula / Recalculation Semantics (25%) | *Needs POC* | 3.5 *(no dynamic arrays)* | *Needs POC* | 1.5 *(19-fn spike only)* |
| XLSX Round-Trip (20%) | *Needs Pro trial* | 2.0 *(needs separate I/O)* | *Needs POC* | 3.0 *(`exceljs` tested)* |
| AI APIs / Selection / Revision Safety (15%) | 4.0 | 4.0 | 2.5 | 4.5 |
| Licensing & Commercial Clarity (15%) | 2.5 *(Pro quote open)* | 2.5 *(GPLv3/Commercial quote open)* | 2.0 *(Dev quote open; CE blocked)* | 4.5 *(MIT; `exceljs` moderate uuid)* |
| Grid Performance & Memory (10%) | *Needs browser POC* | *Needs browser POC* | *Needs POC* | 2.5 *(server spike only)* |
| Khmer / Locale / Accessibility (10%) | *Needs browser POC* | *Needs browser POC* | 1.5 *(known shaping issues)* | 3.5 *(NFC + IDs tested)* |
| Maintenance & Self-Hosting (5%) | 3.5 | 3.5 | 2.5 | 2.0 *(high custom cost)* |

### Mandatory Commercial Vendor Questions Before SS-01
1. Exact SaaS customer/end-user, developer seat, and self-hosted OEM pricing tiers.
2. Offline license verification / air-gapped self-hosting rules (no phone-home requirement).
3. Rights to run server-side headless formula evaluation & XLSX conversion in `apps/workers`.

---

## 4. Controlled Multi-Run Benchmark Results (`tests/d1-spreadsheet-feasibility.test.ts`)

Measured on Windows 11 Pro `10.0.26300`, AMD Ryzen 7 5800H (8 cores / 16 logical), `31.36 GB` RAM, Node `v24.22.3` x64 (1 warm-up + 5 measured runs):

- **Workload A (`dense_1k_x_20` — `1,000 × 20` = `20,000` stored cells, 25% formulas):** `buildMs = 63.68 ms`, `p50 = 248.67 ms`, `p95 = 316.29 ms`, `rssDelta = +43.35 MB`
- **Workload B (`sparse_10k_x_20` — `10,000 × 20` sparse = `47,000` stored cells):** `buildMs = 163.14 ms`, `p50 = 671.71 ms`, `p95 = 724.25 ms`, `rssDelta = +91.32 MB`
- **Workload C (`dense_10k_x_20` — `10,000 × 20` dense = `200,000` stored cells):** `buildMs = 604.76 ms`, `p50 = 2479.59 ms`, `p95 = 2609.55 ms`, `rssDelta = +68.98 MB`
- *Caveat:* Browser DOM/Canvas grid virtualization memory and scroll FPS remain untested until SS-01/SS-02 candidate UI POC.
