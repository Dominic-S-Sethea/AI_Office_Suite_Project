# Presentation Acceptance Matrix (`PPT-T01` – `PPT-T20`, `FR-06` / `PS-00`)

**Test Suite:** `tests/g1-ps00-presentation-feasibility.test.ts`

| Test ID | Scenario | Expected Verification Behavior | PS-00 Verification Status |
| :--- | :--- | :--- | :--- |
| **PPT-T01** | Create multi-slide deck | 6-slide golden management deck created, ordered, saved & reopened | **PASS** |
| **PPT-T02** | Edit one text box | `replace_text` / manual update modifies target element ID without corrupting siblings | **PASS** |
| **PPT-T03** | Move / resize object | `move_resize_element` persists EMU/inch bounds safely | **PASS** |
| **PPT-T04** | Apply corporate theme | Applies `CORPORATE_THEME_SLATE_V2` versioned tokens cleanly | **PASS** |
| **PPT-T05** | Import supported PPTX | `fflate` importer recovers native `<p:sp>` text boxes, Khmer NFC Unicode, and SHA-256 | **PASS** |
| **PPT-T06** | Export & reopen in PowerPoint / reference viewer | Exported `.pptx` unpacked OOXML verified (`ppt/slides/*`, `ppt/charts/chart*.xml`); PDF/PNG rendered locally | **PARTIAL / PENDING reference desktop app** (PowerPoint & LibreOffice not installed on host) |
| **PPT-T07** | Native editable chart | Native chart series match verified FR-05 numbers (`$80k`, `$45k`, `$25k`) | **PASS** |
| **PPT-T08** | Change chart type (`column` -> `line`) | Visual chart kind changes while `series` and `binding` remain identical | **PASS** |
| **PPT-T09** | Khmer presentation slides | Mixed EN/KM typography & coeng shaping preserved in XML and visual PNG | **PASS** (visually inspected PNG) |
| **PPT-T10** | Searchable Khmer PDF export | Multi-page 6-slide `%PDF-` generated with embedded `@fontsource` Khmer WOFF2 fonts | **PASS** |
| **PPT-T11** | Translate financial narrative | Translates heading to Khmer while `$40,000.00` certified metric stays immutable | **PASS** |
| **PPT-T12** | Equivalent EN / KM command | `"Shorten selected title"` and `"កែចំណងជើងនេះឱ្យខ្លីជាងមុន"` produce identical `replace_text` plans (`isMockPlanner: true`) | **PASS (Mock planner)** |
| **PPT-T13** | Excess text overflow | `validatePresentationLayoutAndA11y` detects line overflow & generates reflow proposal | **PASS** |
| **PPT-T14** | Refresh linked draft | `refreshDraftBindings` updates draft revision cleanly to new metric values | **PASS** |
| **PPT-T15** | Reopen historical published deck | Published snapshot retains frozen `$40,000.00` `published_snapshot` binding | **PASS** |
| **PPT-T16** | Malicious imported instructions / PPTX | `.pptm`, `vbaProject.bin`, ZIP path traversal, and slide prompt injection rejected fail-closed | **PASS** |
| **PPT-T17** | Unauthorized export role / cross-tenant | `viewer` export and cross-tenant deck fetch throw `AuthorizationError` (`403`) | **PASS** |
| **PPT-T18** | Cancel unapproved operation | `approved: false` leaves presentation revision & elements untouched | **PASS** |
| **PPT-T19** | Confidential notes & hidden slide disclosure | `ExportDisclosurePolicy` strips hidden slide and all speaker notes from exported `.pptx` | **PASS** |
| **PPT-T20** | AI unavailable fallback | `manualUpdateElementText` works directly with zero AI dependency | **PASS** |
