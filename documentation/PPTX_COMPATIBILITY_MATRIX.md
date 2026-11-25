# PPTX Compatibility & Security Matrix (`FR-06` / `PS-00`)

**Exporters / Importers:** `engines/presentation/src/pptxExporter.ts` (`pptxgenjs@4.0.1` MIT) · `engines/presentation/src/pptxImporter.ts` (`fflate@0.8.2` MIT) · `engines/presentation/src/slidePdfRenderer.ts` (Edge HarfBuzz)

| Feature / Artifact | P0 Policy | Local PS-00 Observed Result | Reference App Verification (`PowerPoint` / `Impress`) |
| :--- | :--- | :--- | :--- |
| Slide dimensions (16:9), order & titles | Preserve exact geometry & slide sequence | Native `<p:sld>` sequence verified via `fflate` re-import | **Pending desktop PowerPoint / LibreOffice Impress** (not installed on host) |
| Mixed EN / Khmer text boxes & tables | Preserve UTF-8 NFC Unicode + `Noto Sans Khmer` / `Kantumruy Pro` | Unpacked `ppt/slides/slide1.xml` retains exact Khmer text & `<a:tbl>`; PDF + PNG visually inspected | Pending desktop PowerPoint inspection |
| Native editable charts | Native `<c:chart>` series bound to verified aggregate numbers | Verified `ppt/charts/chart1.xml` & `chart2.xml` emitted cleanly | Pending desktop PowerPoint inspection |
| Speaker notes & hidden slides disclosure | Strip notes & hidden slides unless authorized by `ExportDisclosurePolicy` | Verified `ppt/notesSlides/` & hidden slide omitted when disabled (`PPT-T19`) | Verified via unpacked ZIP audit |
| Searchable PDF & PNG visual render | Multi-page 16:9 searchable PDF, zero Khmer coeng clipping | 6-page `%PDF-` + `1280x720` PNG screenshots inspected | Visually verified via headless Edge HarfBuzz |
| Macro `.pptm` / `vbaProject.bin`, OLE2 encrypted, ZIP traversal, external `.rels` | Fail-closed rejection or non-fetch warning; retain `originalSha256` | Verified fail-closed blocks across all 4 negative vectors | Verified in `tests/g1-ps00-presentation-feasibility.test.ts` |
| SmartArt (`ppt/diagrams/*`) & slide animations (`<p:timing>`) | Detect cleanly & report in `unsupportedFeatures` | Flagged in diagnostics without crash | Pending reference viewer comparison |
