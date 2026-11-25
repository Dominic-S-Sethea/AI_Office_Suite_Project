# Document & Workbook Compatibility Matrix — AI Office Suite

**Phase:** D1 / SS-00 Empirical Baseline  
**Policy:** Maintain explicit supported/partial/unsupported honesty. Never claim full Microsoft Word or Excel parity.

## 1. Document Studio (`DOCX` & `PDF`)

| Feature | Native Studio (`StudioDocument` / Tiptap) | DOCX Export (`docx` MIT) | DOCX Import (`mammoth` + `fflate`) | Searchable PDF (Chromium HarfBuzz) | Notes / Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Paragraphs & Headings (H1–H3) | Supported | Supported | Supported | Supported | Preserved across round-trip |
| Bold, Italic, Underline | Supported | Supported | Supported | Supported | Preserved cleanly |
| Alignment (Left, Center, Right, Justify) | Supported | Supported | Partial (defaults left) | Supported | Mammoth normalizes most alignment to HTML `<p>` |
| Bullet & Ordered Lists | Supported | Supported | Supported | Supported | Exported & re-imported as structured lists |
| Tables (rows, columns, header row) | Supported | Supported | Supported | Supported | Table text & header structure preserved |
| Khmer Unicode (coeng subscripts, vowels, numerals) | Supported | Supported (`w:cs` Noto Sans Khmer) | Supported (NFC normalized) | Supported (HarfBuzz shaping) | Verified zero dangling coengs |
| A4 / Letter Page Size & Margins | Supported | Supported | Partial | Supported (`@page`) | Layout persisted in `StudioDocument.layout` |
| Page Breaks | Supported | Supported | Partial | Supported (`break-after: page`) | — |
| Headers, Footers & Page Numbers | Supported | Supported | Unsupported | Partial (body header/footer) | Running page numbers in DOCX; static preview footer in D1 HTML->PDF |
| Linked Metric Placeholders (D7) | Supported | Snapshot text fallback | Unsupported | Styled pill snapshot | Clearly marked synthetic until D7 |
| SmartArt (`word/diagrams/*`), Footnotes, Comments, `<w:sdt>`, Floating Shapes | Unsupported | — | Detected & Warned | — | Original binary preserved immutably; listed in `ImportDiagnostics` |
| VBA Macros (`.docm`, `vbaProject.bin`) | **Blocked** | Never emitted | **Rejected (`MACRO_CONTENT_BLOCKED`)** | — | Security invariant (`PLT-04`) |

## 2. Spreadsheet Studio Feasibility (`XLSX` & `CSV`, FR-03 SS-00)

| Feature | SS-00 Calculation Spike | XLSX Export / Import (`exceljs` MIT) | CSV Export (`exportSheetToSafeCsv`) | Notes / Behavior |
| :--- | :--- | :--- | :--- | :--- |
| Multiple Worksheets | Supported | Supported | Single active sheet | Preserves sheet names & cross-sheet refs (`Finance!E5`) |
| Stored Value vs Display Format (`0.15` vs `15%`) | Supported | Supported | Exported evaluated value | Stored raw values never overwritten by display format |
| Leading-Zero Identifiers (`"001245"`) | Supported (`string`) | Supported (`numFmt: "@"`) | Supported | Prevents silent numeric truncation |
| Currency Tagging (`USD` vs `KHR`) | Supported | Supported (`$` / `៛` detection) | Text representation | Prevents silent mixed-currency addition |
| Core Formulas (19 MVP functions, `+ - * / ^`, `$A$1`, cross-sheet) | Supported | Supported (formula + cached result) | Neutralized if untrusted text | See `SPREADSHEET_FEASIBILITY_REPORT.md` |
| Circular References | Detected (`#CYCLE!`) | Preserved as formula | `#CYCLE!` | Cycle path reported explicitly |
| Unsupported Excel Functions (e.g., `XLOOKUP`) | Flagged (`#NAME?` + warning) | Preserved formula string + warning | `#NAME?` | Never silently returns `0` |
| PivotTables & External Links | Unsupported | Detected & Flagged | — | Listed in `workbook.unsupportedFeatures` |
| VBA Macros (`.xlsm`, `vbaProject.bin`) | **Blocked** | **Rejected (`MACRO_WORKBOOK_BLOCKED`)** | — | Never executed |
| Formula Injection in Untrusted CSV Text | — | — | **Neutralized (`'` prefix)** | OWASP CSV injection defense (`SHT-T17`) |
