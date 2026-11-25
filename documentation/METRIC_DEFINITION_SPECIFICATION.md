# Business Metric Definition Specification (`ANA-01.01` – `ANA-01.06`)

**Phase:** FR-05 (`AN-00` Feasibility Baseline)  
**Shared Contracts:** `packages/shared-contracts/src/index.ts` (`MetricDefinition`, `MetricVersion`, `MetricApproval`, `LinkedMetricReference`)  
**Registry Implementation:** `engines/analytics/src/metricRegistry.ts` (`BusinessMetricRegistry`)

---

## 1. Architectural Purpose

In unmanaged spreadsheet workflows, different departments compute conflicting totals for "Revenue" or "Profit" (gross vs. net of returns, gross profit vs. operating profit vs. net profit) and then average percentages incorrectly.  
The **Business Metric Registry** is a shared, versioned application component consumed uniformly by **Document Studio**, **Spreadsheet Studio**, **Presentation Studio**, and **Intelligence Studio** through `LinkedMetricReference`.

---

## 2. Official V1 Candidate Metric Catalog

| Metric ID | English Display Name | Khmer Display Name | Aggregation Type | Formula Expression | Variance Direction | Missing-Data Policy |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FIN-GROSS-SALES` | Gross sales | ចំណូលលក់សរុបមុនកាត់បន្ថយ | `additive` | `SUM(gross_sales_amount)` | `higher_is_favorable` | `block_certification` |
| `FIN-NET-SALES` | Net sales revenue | ចំណូលលក់សុទ្ធ | `additive` | `SUM(gross_sales_amount - return_discount_amount)` | `higher_is_favorable` | `block_certification` |
| `FIN-COGS` | Cost of goods sold | ថ្លៃដើមទំនិញលក់ | `additive` | `SUM(cogs_amount)` | `lower_is_favorable` | `block_certification` |
| `FIN-GROSS-PROFIT` | Gross profit | ប្រាក់ចំណេញដុល | `derived` | `FIN-NET-SALES - FIN-COGS` | `higher_is_favorable` | `block_certification` |
| `FIN-GROSS-MARGIN` | Gross profit margin | អត្រាប្រាក់ចំណេញដុល | `ratio` | `DIVIDE(FIN-GROSS-PROFIT, FIN-NET-SALES) * 100%` | `higher_is_favorable` | `block_certification` |
| `FIN-OPEX` | Operating expenses | ចំណាយប្រតិបត្តិការ | `additive` | `SUM(opex_amount)` | `lower_is_favorable` | `block_certification` |
| `FIN-TOTAL-COSTS` | Total operating & direct costs | ចំណាយសរុប | `additive` | `FIN-COGS + FIN-OPEX` | `lower_is_favorable` | `block_certification` |
| `FIN-OPERATING-PROFIT` | Operating profit | ប្រាក់ចំណេញប្រតិបត្តិការ | `derived` | `FIN-NET-SALES - FIN-COGS - FIN-OPEX` | `higher_is_favorable` | `block_certification` |
| `FIN-OPERATING-MARGIN` | Operating profit margin | អត្រាប្រាក់ចំណេញប្រតិបត្តិការ | `ratio` | `DIVIDE(FIN-OPERATING-PROFIT, FIN-NET-SALES) * 100%` | `higher_is_favorable` | `block_certification` |
| `FIN-REVENUE-GROWTH` | Revenue growth | កំណើនចំណូល | `derived` | `DIVIDE(Current_NetSales - Prior_NetSales, Prior_NetSales) * 100%` | `higher_is_favorable` | `block_certification` |
| `FIN-BUDGET-VARIANCE` | Budget variance | គម្លាតធៀបនឹងថវិកា | `derived` | `Actual_Aggregated - Budget_Monthly` | `neutral` (per-category) | `block_certification` |
| `FIN-DISTINCT-CUSTOMERS` | Distinct customer count | ចំនួនអតិថិជនផ្ទាល់ខ្លួន | `distinct_count` | `COUNT_DISTINCT(customer_id)` | `higher_is_favorable` | `block_certification` |

---

## 3. Versioning, Ownership & Historical Immutability Rules

1. **Non-destructive evolution (`ANA-01.01`, `ANA-T11`):** Updating a metric creates a new sequential integer `version` (`V2`, `V3`) and timestamps `deprecatedAt` on the superseded version. Prior versions remain permanently inspectable and executable.
2. **Published snapshot pinning (`ANA-T18`):** Publishing a report/dashboard freezes `frozenMetricVersion`, `datasetVersion`, `datasetSha256`, `precisionPolicyId`, and `mode: "published_snapshot"` inside `LinkedMetricReference`. Reopening a published November report after December V2 changes always preserves November V1 semantics and numbers.
3. **Combined-numerator/denominator aggregation (`ANA-02.01`, `ANA-T02`):** Ratio metrics (`FIN-GROSS-MARGIN`, `FIN-OPERATING-MARGIN`) never sum or average subgroup percentages; the engine aggregates numerator and denominator totals independently over the requested dimension/scope before dividing.
4. **Variance interpretation (`ANA-02.03`):** Each metric explicitly carries `varianceDirection` (`higher_is_favorable` vs. `lower_is_favorable`) so `+ $10,000` revenue variance renders as `favorable`, whereas `+ $10,000` cost variance renders as `unfavorable` rather than relying on AI guesswork.
