# Intelligence Studio Access Control & Data Scope Matrix (`FR-07` / `BI-00`)

**Implementation:** `platform/authorization` (`WorkspaceRole`) + `engines/intelligence/src/intelligenceEngine.ts` (`DataScopePolicy`)

| Control | Full Enterprise Editor (`pol_enterprise_all`) | Department-Scoped Viewer (`pol_sales_scoped`) | Other Tenant / Revoked Principal |
| :--- | :--- | :--- | :--- |
| **Tenant / Workspace Boundary** | Allowed within matching `(tenantId, workspaceId)` | Allowed within matching `(tenantId, workspaceId)` | **Denied** (`403 TENANT_ISOLATION_DENIED` / `ACCESS_REVOKED`) |
| **Default `"All"` Department Scope** | `["Sales", "Services", "Retail"]` (`$150,000.00`) | Restricted strictly to `["Sales"]` (`$80,000.00`) | **0 rows / Denied** |
| **Out-of-Scope Filter Request** (e.g. `["Retail"]`) | Allowed (`$25,000.00`) | Intersection empty -> explicit `state: "empty"` (`BI-T11`) | **Denied** |
| **Drill-Through Columns** | Full permitted finance columns (`cogs`, `opex`, etc.) | Projected `allowedColumns` only (`cogs`/`opex` omitted) | **Denied** |
| **Result Cache Keying (`BI-T18`)** | Keyed by `pol_enterprise_all:v1` + dept scope | Separate cache key `pol_sales_scoped:v1` (zero leakage) | Never hits another policy's cache |
| **Summary CSV Export (`BI-T26`)** | Permitted (scoped aggregates + provenance ID) | Permitted within Sales scope only (`$80,000.00` only) | **Denied** |
| **Underlying Detail Export (`BI-T27`)** | Permitted when `canExportUnderlyingDetail = true` | **Denied** (`403 UNDERLYING_EXPORT_DENIED`) | **Denied** |
| **Snapshot Publication & Revocation (`BI-T19`)** | `canPublish = true` | **Denied** (`403 PUBLISH_FORBIDDEN`); revocation blocks even old snapshots | **Denied** (`403 ACCESS_REVOKED`) |
