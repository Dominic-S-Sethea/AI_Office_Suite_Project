# Intelligence Studio Feasibility Report (`FR-07` / `BI-00`)

**Phase:** `BI-00` Local Technical Feasibility (Handover V1.2 §14.3 & §16)  
**Primary Architecture Recommendation (`TD-BI-01` & `TD-CHART-01`):** Build an **application-owned React dashboard/report authoring surface** powered directly by **FR-05 `BusinessAnalysisEngine`** (DuckDB + `BigInt` minor units) and **Apache ECharts (`echarts@6.1.0`, `Apache-2.0`)**, sharing canonical `ChartSpec` & `FilterContext` contracts across modules.

---

## 1. Visualization & Architecture Comparison

| Approach | Strengths | Risks & Tradeoffs | License & Verification |
| :--- | :--- | :--- | :--- |
| **Owned React UI + Apache ECharts (`BI-00` built & measured)** | Native SSR `<svg>` (`renderToSVGString`), ARIA metadata + HTML `<table>` fallback, rich grouped/stacked/line/bar charts, zero auth/metric duplication | Must author dashboard grid, filter bar, and drill-through UI ourselves in React | `echarts@6.1.0` (`Apache-2.0`), `0` audit advisories, SVG length `2,922 B+` & PNG visually verified |
| **Constrained Vega-Lite JSON (`ChartSpec` adapter comparison)** | Clean grammar of graphics & declarative `point` selection `params` | Adding a second rendering runtime violates single-engine policy; limited native PPTX mapping parity | Compared cleanly via `compileChartSpecToVegaLiteJson()` on exact same `ChartSpec` without installing a second bundle |
| **Embedded BI (Metabase / Superset)** | Out-of-the-box SQL exploration UI | Metabase full-app embedding requires Pro/Enterprise; duplicates auth, `DataScopePolicy`, cache keys, and metric registry | Rejected for MVP (`TD-BI-01`) based on official licensing & duplication risk |

---

## 2. Measured `BI-00` Workloads & Golden §12 Verification

- **DuckDB + ECharts SSR SVG Combined Workload (`benchmarkBiWorkload`):**
  - `10,000` sales lines + `4` rendered visuals: `p50 = 88.36 ms`, `p95 = 91.14 ms`, `rssDelta = +5.89 MB`.
  - `100,000` sales lines + `8` rendered visuals: `p50 = 122.58 ms`, `p95 = 156.38 ms`, `rssDelta = +3.93 MB`.
- **Note on High-Volume Row Ingestion:** Earlier test calling sequential per-row `preparedStmt.run()` `4 × 100k` times timed out at `>30s` due to 400k synchronous JS->N-API calls; production `DP-01`/`ENG-BI-03` must stage via DuckDB bulk Parquet/CSV/`Appender` scans rather than row-by-row N-API loops.
- **Golden §12 & Security Controls Verified (`BI-T01..T32`, `X-VIS-01..08`):**
  - Enterprise `ALL`: `$150,000.00` Net Sales (`+20.00%` YoM), `$40,000.00` Op Profit, `26.67%` Margin, `3` distinct customers.
  - Filtered `Sales + Services`: `$125,000.00`, `$35,000.00`, `28.00%`, `+19.05%`, `+$3,000.00` profit variance — synchronized across BI, Sheet formula (`28`), Doc, and 6-slide PPTX (`scopeLabel`).
  - Sales-only policy (`pol_sales_scoped`): `$80,000.00`, `$20,000.00`, `25.00%`, hidden `cogs`/`opex`, viewer denied export (`403 FORBIDDEN_ROLE`), reviewer allowed summary CSV only (`403 UNDERLYING_EXPORT_DENIED` on detail), policy-keyed cache isolation, and immediate revocation denial (`BI-T19`).

---

## 3. Pending Items Before `ENG-BI-01` Production Buildout

1. Interactive React drag/drop dashboard builder UI & Playwright keyboard/WCAG 2.2 AA screen-reader verification.
2. Live PostgreSQL `RLS` + DuckDB worker pooling for `1M`-row `Department/Consolidated` workloads (`§11.1`).
3. P1 capabilities (`BI-T33` alerts & `BI-T34` scheduled refresh) remain out of immediate P0 scope.
