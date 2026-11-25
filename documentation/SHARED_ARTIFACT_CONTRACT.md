# Shared Artifact & Provenance Contract Specification (`FR-08` / `XI-00`)

**Source Package:** `packages/shared-contracts/src/index.ts`  
**Relational Schema:** `engines/integration/src/pgPersistence.ts` (`xi_artifacts`, `xi_artifact_revisions`, `xi_dependency_edges`)

---

## 1. Platform-Wide Artifact Registry Model

Every managed business resource registers a stable permanent identity decoupled from display names or local file paths so renaming never breaks downstream links (`INT-T04`):

| Contract / Field | Purpose | Invariant |
| :--- | :--- | :--- |
| `ArtifactReference` | Shared catalog entry (`document`, `spreadsheet`, `presentation`, `dashboard`, `dataset`, `reporting_package`) | `artifactId` + `tenantId` + `workspaceId` immutable after creation; tracks `currentRevision`, `publishedRevision`, `classification`, `lifecycleStatus` |
| `ArtifactRevisionReference` | Immutable content revision pointer (`revision`, `contentSha256`, `restoredFromRevision`) | Append-only (`REVOKE DELETE ON xi_artifact_revisions FROM app_runtime`); restores create revision `N + 1` |
| `DatasetVersionReference` | Identifies prepared/certified dataset inputs (`datasetId`, `version`, `datasetSha256`, `requiredColumns`, `status`) | Schema drops block incompatible downstream refreshes (`INT-T09`) |
| `MetricReference` | Identifies metric version & formula digest (`FIN-*`, `version`) | Version bumps never mutate published historical packages |
| `AnalyticalResultReference` | Material calculation context identity (`resultId`, `provenanceId`, `reportingPeriod`, `filters`, `precisionPolicyId`, `currency`, `minorUnits`, `effectivePolicyScope`, `policyVersion`, `bindingMode`) | Two values are equivalent iff calculation contexts & policy scopes match (`§9`) |
| `ReportingContext` | Cross-module handoff envelope (`periodStart`, `periodEndExclusive`, `datasetId`, `datasetVersion`, `requestedDepartments`, `currency`, `language`, `themeId`, `themeVersion`) | User & AI permissions re-evaluated at every server operation (`§6`) |

---

## 2. Extended `LinkedMetricReference` Continuity

Preserved `LinkedMetricReference` cleanly in place across Document Studio, Spreadsheet Studio, Presentation Studio, and Intelligence Studio by adding optional FR-08 fields:
- `bindingMode`: `"independent_copy" | "refreshable_link" | "pinned_snapshot"`
- `linkState`: `LinkedResourceState` (`current`, `update_available`, `refreshing`, `stale`, `incompatible`, `access_restricted`, `source_unavailable`, `detached`, `pinned`)
- `sourceArtifactId`, `resultReferenceId`, `effectivePolicyScope`, `policyVersion`

---

## 3. Dependency Graph & Confidentiality Redaction (`INT-T08`, `INT-T20`)

- `DependencyEdge` models `(sourceKind, sourceId, sourceVersionOrRevision) -> (targetKind, targetId, targetRevision)` with explicit `relationship`, `requiredClassification`, `allowedDepartments`, and `requiredColumns`.
- `CrossModuleIntegrationEngine.inspectDependencies()` intersects every edge against the caller's `DataScopePolicy` classification ceiling, permitted departments, and permitted columns — redacting hidden confidential/restricted targets completely and returning `{ visibleEdges, redactedCount }` without disclosing restricted artifact IDs or titles.
