# Linked Object Intelligence Specification (`FR-08` / `XI-00`)

**Scope:** Shared behavior across `LinkedMetricReference`, `LinkedObjectBinding`, `RefreshProposal`, and `CrossModuleIntegrationEngine`.

---

## 1. Supported Cross-Module Object Types

| Object Kind | Examples in `XI-00` | Source Engine | Supported Target Studios |
| :--- | :--- | :--- | :--- |
| `metric` | `FIN-NET-SALES`, `FIN-OPERATING-PROFIT`, `FIN-OPERATING-MARGIN`, `FIN-REVENUE-GROWTH` | FR-05 `BusinessAnalysisEngine` | Document placeholder, Presentation metric card, Spreadsheet KPI cell, Dashboard KPI |
| `table` | Departmental Net Sales, Costs & Profit summary table (with active filters & units) | FR-05 + FR-07 `IntelligenceStudioEngine` | Document `TableBlock`, Presentation `SlideTableElement`, Spreadsheet `Summary` sheet |
| `chart` | Revenue by Dept / Revenue vs Budget / Monthly Net Sales Trend (`ChartSpec`) | FR-07 `ChartSpec` + Apache ECharts | Presentation editable native `<c:chart>`, Dashboard SVG |
| `referenced_content` | Corporate theme tokens, period banners & scope labels | FR-06 `PresentationTheme` + `ReportingContext` | All 4 studios |

---

## 2. Three Binding Modes & One-Directional Synchronization

| Binding Mode | Target State | Source Update Behavior | Mutability Rule |
| :--- | :--- | :--- | :--- |
| `independent_copy` | `detached` | Never auto-refreshes; detached from source | Editable copy in target |
| `refreshable_link` | `current` -> `update_available` -> `current` | Authorized `proposeRefresh` + approved `applyRefreshProposal` advances draft revision | One-directional `source -> target` only (`ONE_WAY_SYNC_DETACH_REQUIRED` `409` on manual numeric overwrite unless `explicitDetach: true`) |
| `pinned_snapshot` | `pinned` | Frozen permanently on published package version (`INT-T07`) | Read-only historical snapshot; **never labeled `stale`** when newer datasets arrive |

---

## 3. Nine Linked-Resource States & Security Separation

`LinkedResourceState` distinguishes:
`current`, `update_available`, `refreshing`, `stale`, `incompatible`, `access_restricted`, `source_unavailable`, `detached`, `pinned`.

Crucially per FR-08 §3.2, every `LinkedObjectBinding` separates four independent properties:
1. Live vs. frozen (`mode: "refreshable_link" | "pinned_snapshot"`)
2. Editable in target (`editableInTarget`, subject to detach for numeric overrides)
3. Source-permission gated (`requiresSourcePermissionToView`)
4. Distribution approval (`approvedForDistribution`, set only through approved `ReportingPackageManifest`)
