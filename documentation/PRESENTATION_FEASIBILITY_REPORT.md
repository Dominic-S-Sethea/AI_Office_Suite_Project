# Presentation Studio Feasibility Report (`FR-06` / `PS-00`)

**Phase:** `PS-00` Local Technical Feasibility (Handover V1.2 §14.2 & §16)  
**Primary Architecture Recommendation (`TD-PPT-01`):** Application-owned **`StudioPresentation` / `SlideElement` discriminated union** paired with **`pptxgenjs@4.0.1` (`MIT`, native OOXML export)**, **`fflate@0.8.2` (`MIT`, hardened `.pptx` import)**, and **headless Edge HarfBuzz PDF/PNG rendering**.

---

## 1. Candidate Comparison

| Candidate | Strengths | Risks & Constraints | License & Procurement Status |
| :--- | :--- | :--- | :--- |
| **Application-owned model + React DOM/SVG + PptxGenJS (`PS-00` evaluated)** | Stable object IDs, exact FR-05 `LinkedMetricReference` & `ChartSpec` binding, clean EN/KM DOM typography, native `<p:sp>`/`<a:tbl>`/`<c:chart>` PPTX output | Requires building custom slide editor canvas interactions & separate `.pptx` importer (`pptxgenjs` is export-only) | `MIT` (`pptxgenjs@4.0.1`); transitive `image-size@1.2.1` high DoS advisories remediated via root `"overrides": { "image-size": "^2.1.0" }` (`MIT`) |
| **Univer Slides (Docs benchmark only)** | Unified suite feel alongside Univer Sheets | Import/export/Server SDK falls under commercial Pro licensing; Khmer & API granularity unverified | Commercial quote requested (`VENDOR_OUTREACH_BRIEFS.md`) |
| **ONLYOFFICE Presentation** | Rich desktop-like OOXML parity | **Community Edition excluded (`AGPL v3`)**; heavy server runtime; custom AI/FR-05 hook integration effort | Optional Developer Edition RFP brief prepared; not benchmarked |

---

## 2. Empirical `PS-00` Measurements & Artifacts

- **Native OOXML Generation Latency (measured on dev host):**
  - `5` slides: `62.47 ms` (`52.48 ms` earlier run)
  - `20` slides: `107.26 ms` (`89.50 ms` earlier run)
  - `50` slides: `198.06 ms` (`195.15 ms` earlier run)
- **OOXML Inspection & Security:** Unpacked `management-review-deck.pptx` confirmed native `ppt/slides/slide1..6.xml`, native `ppt/charts/chart1..2.xml`, preserved Khmer UTF-8 NFC text, and stripped speaker note text + hidden slide (`PPT-T19`). (Empirical note: `pptxgenjs@4.0.1` emits empty default `ppt/notesSlides/` XML skeletons; disclosure guards verify empty note text.)
- **HarfBuzz Searchable PDF & Visual PNGs:** Rendered 6-page 16:9 `management-review-deck.pdf` (`countPdfPages = 6`) and visually inspected `management-review-slide1.png` (crisp Khmer `របាយការណ៍គ្រប់គ្រងប្រចាំខែ`, zero tofu) and `management-review-slide3-chart.png` (raised SVG `padT` from `36` to `56` after inspecting initial `$80,000` bar label clip).

---

## 3. Known Limitations & Pending Approvals (`PPT-T06`)

1. **Desktop PowerPoint / LibreOffice Impress Not Installed (`PPT-T06`):** Real-app desktop opening and manual chart editability inspection remain **PENDING reference PowerPoint/Impress test** on an Office-equipped test machine prior to `PS-01`.
2. **PPTX Round-Trip Scope:** `fflate` importer recovers native text boxes, notes, Khmer text, and flags SmartArt/animations/external `.rels` fail-closed; complex shapes/master inheritance remain deferred to `PS-05`.
3. **Mock Speech/AI:** `planPresentationOperation()` is an explicit deterministic mock (`isMockPlanner: true`).
