# Analytical Acceptance Matrix (`ANA-T01` – `ANA-T18`)

**Phase:** FR-05 `AN-00` Feasibility Verification  
**Test Suite:** `tests/g1-an00-analytics-feasibility.test.ts`

| Test ID | Scenario | Expected Verification Behavior | Automated Coverage (`tests/g1-an00-analytics-feasibility.test.ts`) |
| :--- | :--- | :--- | :--- |
| **ANA-T01** | Revenue & operating profit on Golden Dataset | Match `$150k` Net Sales, `$90k` COGS, `$60k` GP, `$20k` OpEx, `$40k` Operating Profit, `40.00%` GM, `20.00%` growth + row-order invariance | Covered & verified (`expect(...).toBe(...)`) |
| **ANA-T02** | Aggregate departmental profit margins | Combined `$40k / $150k = 26.67%` (NOT simple average `25%` of `30%` and `20%`) | Covered & verified |
| **ANA-T03** | Ratio with zero denominator | Returns explicit `{ status: "unavailable", unavailableReason: "ZERO_DENOMINATOR" }` | Covered & verified |
| **ANA-T04** | Aggregate distinct customer counts | Shared customer `C002` across Dept A & B counts once globally (`3`, not `2+2=4`) | Covered & verified via DuckDB `COUNT(DISTINCT)` + BigInt |
| **ANA-T05** | Actuals vs monthly departmental budget | Pre-aggregates `invoice_line` to `(reporting_month, department)` -> zero budget multiplication; revenue `+$10k favorable`, costs `+$10k unfavorable`, op profit `$0 on_budget` | Covered & verified |
| **ANA-T06** | Fiscal-year-to-date calculation | `fiscalYearStartMonth: 4` includes Apr–Nov (`$300,000.00`) and excludes Mar (`$10,000.00`) | Covered & verified |
| **ANA-T07** | Partial-month vs completed-month comparison | Emits `validationStatus: "warning"` and `PARTIAL_PERIOD_COMPARISON` warning | Covered & verified |
| **ANA-T08** | Multi-currency processing | Rejects undefined conversion (`422 CURRENCY_CONVERSION_UNDEFINED`); converts exact 10-decimal rate when rate/source/date provided | Covered & verified |
| **ANA-T09** | Monetary rounding & edge cases | Exact `HALF_UP` & `HALF_EVEN` BigInt rounding, negative numbers, IEEE-754 drift avoidance (`0.1+0.2=0.30`), overflow rejection | Covered & verified |
| **ANA-T10** | Missing transaction amounts | Blocks certification (`validationStatus: "blocked"`, `MISSING_REQUIRED_AMOUNT`) instead of coercing null -> `0` | Covered & verified |
| **ANA-T11** | Modify approved metric definition | Registers `V2` while preserving `V1` inspectable & executable | Covered & verified |
| **ANA-T12** | Equivalent English & Khmer commands | Maps EN & KM period comparisons to identical `FIN-NET-SALES` / `FIN-REVENUE-GROWTH` results; marks `aiInterpretation.isObservedFact: false` | Covered & verified (`planAnalyticalCommand` deterministic mock) |
| **ANA-T13** | Ambiguous profit instruction | `"Calculate profit"` sets `clarificationRequired: true` offering `FIN-GROSS-PROFIT` vs `FIN-OPERATING-PROFIT` | Covered & verified |
| **ANA-T14** | Cross-tenant analytical access | Blocks cross-tenant query, `getCachedResult`, and `getPublishedSnapshot` with `AuthorizationError` (`403`) | Covered & verified |
| **ANA-T15** | Unsafe analytical operation injection | Rejects `SELECT * FROM read_csv_auto(...)` fail closed (`400 UNSAFE_ANALYTICAL_OPERATION`) | Covered & verified |
| **ANA-T16** | Cross-module figure reconciliation | Reconciles `AnalyticalResult` + Document Studio `LinkedMetricReference` + Spreadsheet Studio `=ROUND((B2/B1)*100, 2)` (`26.67%`) | Covered & verified |
| **ANA-T17** | Retry after simulated transient failure | Retrying with same `idempotencyKey` yields 1 result & 1 published snapshot (no duplicates) | Covered & verified |
| **ANA-T18** | Reopen published historical report | After `V2` metric registration, November snapshot retains `frozenMetricVersion: 1` (`$40,000.00`, `published_snapshot`) | Covered & verified |
| **P1 Deferred** | Forecasting (`ANA-04.03`), backtesting, stats modeling | Excluded from `AN-00` feasibility scope per Engineering Addendum §10 | Explicitly deferred to `AN-08` |
