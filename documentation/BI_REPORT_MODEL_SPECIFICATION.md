# Intelligence Studio Report & Filter Semantics (`FR-07` / `BI-00`)

**Contracts:** `packages/shared-contracts/src/index.ts` (`StudioReport`, `ReportPage`, `VisualSpec`, `FilterContext`, `FilterPredicate`, `DataScopePolicy`)  
**Engine:** `engines/intelligence/src/intelligenceEngine.ts`

---

## 1. Object Separation

- **`Dataset` (FR-04):** Immutable certified input manifest version (`datasetVersion`, SHA-256).
- **`Semantic Model` (FR-05):** Approved `BusinessMetricRegistry` measures, dimensions, and granularity rules (never duplicated in UI code).
- **`StudioReport` / `ReportPage` / `VisualSpec`:** Interactive multi-visual layout anchored to an authoritative dataset manifest, displaying `sourceAsOfTimestamp`, `lastSuccessfulRefreshAt`, `lastComputedAt`, and active `DataScopePolicy` scope.
- **`PublishedBiSnapshot`:** Immutable frozen snapshot (`snapshotSha256`) pinned to exact `datasetVersion`, `metricVersions`, `filterContext`, and `policyScope`.

## 2. Filter Precedence & Interaction Semantics

```
EffectiveScope = DataScopePolicy (server-derived) ∩ ReportFilters ∩ PageFilters ∩ VisualFilters ∩ ActiveSelection
```

- **Fail-closed `"All"` semantics (`BI-T06`, `BI-T17`):** Selecting `"All"` removes user filter constraints **within** `policy.allowedDepartments` ONLY. A Sales-only user never sees `$150,000` enterprise totals.
- **Zero-intersection isolation (`BI-T11`):** Selecting a disallowed department produces an empty intersection and explicit `state: "empty"` — never widening back to global data or inventing `0`.
- **Out-of-order response guard (`BI-T22`):** Monotonically increasing `interactionSeq` rejects superseded responses (`409 STALE_INTERACTION_DISCARDED`).
- **Drill-through (`BI-T07`):** Opens paginated authorized detail rows with `policy.allowedColumns` projection (`cogs`/`opex` stripped when unpermitted) and preserves return `FilterContext`.
