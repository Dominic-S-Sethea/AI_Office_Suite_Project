# Presentation Quality Rubric (`FR-06` / `PS-00`)

**Invariant:** Weighted quality scoring never overrides mandatory numerical accuracy (`FR-05`), tenant/export security, or critical compatibility failures.

| Dimension | Proposed Weight | 0–4 Scale Anchor (0 = Fail/Unusable, 4 = Publication Grade) | Automated Checks Implemented in `PS-00` |
| :--- | :---: | :--- | :--- |
| **Factual & Numerical Accuracy** | `30%` | All figures match verified `AnalyticalResult` & active scope label; zero invented metrics | Chart/card metrics bound to `LinkedMetricReference`; translation preserves exact numbers (`PPT-T11`) |
| **Visual Readability & Design** | `20%` | Consistent 16:9 alignment, zero clipped overflow, high contrast | `validatePresentationLayoutAndA11y` estimates line budget & proposes reflow (`PPT-T13`); visual PNG review |
| **Narrative Coherence** | `15%` | Logical 6-slide management arc; speaker notes avoid unsupported causal claims | 6-slide golden structure (`createGoldenManagementDeck`) |
| **Editability & Interoperability** | `15%` | Native OOXML text/tables/charts, not flattened screenshots | Native `<p:sp>`, `<a:tbl>`, `<c:chart>` verified (`pptxExporter.ts`) |
| **Corporate Branding** | `10%` | Versioned fonts, palette, logo badge (`CORPORATE_THEME_V1/V2`) | Theme token binding & historical snapshot isolation (`PPT-T15`) |
| **Accessibility** | `10%` | Unique descriptive slide titles, image/chart `altText`, table headers, explicit reading order | Automated title uniqueness, `altText`, and table-header assertions; manual screen-reader review pending D3+ |
