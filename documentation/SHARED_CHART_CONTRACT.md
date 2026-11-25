# Shared Chart Contract Specification (`ChartSpec` & `ChartDataBinding`, `FR-03/06/07/08`)

**Contracts:** `packages/shared-contracts/src/index.ts`  
**Security Validator:** `validateChartSpecSafety()` (`packages/validation/src/index.ts`)  
**Adapters:** `engines/intelligence/src/chartAdapters.ts` (Apache ECharts SSR SVG + Vega-Lite JSON comparison) & `engines/presentation/src/pptxExporter.ts` (Native OOXML charts)

---

## 1. Contract Fields

- **`ChartSpec`:** `chartId`, `kind` (`kpi | bar | column | grouped_bar | stacked_bar | line | pie | table`), localized `titleEn` / `titleKm` and `altSummaryEn` / `altSummaryKm`, explicit `unit` / `currency`, `yAxisStartsAtZero`, `categories[]`, `series[]`, `binding`, `themeVersion`, `linkedMetricRefs[]`.
- **`ChartSeriesData`:** Separates semantic `classification` (`actual | budget | variance | forecast | scenario`) and per-point `state` (`available | undefined | missing | suppressed | error`).
- **`ChartDataBinding`:** Binds `datasetId`, `datasetVersion`, `metricRefs`, `reportingPeriod`, normalized `filterContext`, `policyScope`, `provenanceId`, `freshnessTimestamp`, and `sourceAsOfTimestamp`.

## 2. Security & Adapter Guarantees

1. **No Raw Code / Unsafe HTML / External Fetch:** `validateChartSpecSafety()` rejects `<script`, inline `on*=`, `javascript:`, `https://`/`file://`, and executable JS callbacks (`function(`, `eval(`) with `400 UNSAFE_CHART_SPEC`.
2. **Chart Type Changes Preserve Math (`PPT-T08`, `BI-T15`, `X-VIS-05`):** Changing `kind` between `column`, `bar`, and `line` re-renders via the target adapter while leaving `series[]`, units, `yAxisStartsAtZero`, and `binding` untouched.
3. **Accessible Data Equivalents (`BI-T31`):** `renderChartSpecToSvg()` pairs Apache ECharts `aria.enabled = true` SVG output with an HTML `<table>` alternative (`accessibleTableHtml`).
4. **Cross-Module Fidelity:** ECharts (interactive SVG), Vega-Lite (declarative JSON selection spec), and PptxGenJS (`ppt/charts/chart*.xml`) all consume `ChartSpec` from `FR-05` `AnalyticalResult` rather than recalculating totals independently.
