# Business Analysis Engine Feasibility Report (`FR-05` / `AN-00`)

**Phase:** `AN-00` Analytical Feasibility Investigation (Extension to Handover V1.1)  
**Primary Recommendation (`TD-ANA-01`):** Reuse **DuckDB (`@duckdb/node-api@1.4.5-r.1`, MIT)** for parameterized, sandboxed tabular grouping & filtering paired with an **application-owned `BigInt` scaled minor-unit precision engine** (`engines/analytics/src/precision.ts`) and shared **`BusinessMetricRegistry`** (`engines/analytics/src/metricRegistry.ts`). Zero competing runtimes added.

---

## 1. Architectural Boundary Separation

| Layer | Responsibility | Implementation |
| :--- | :--- | :--- |
| **FR-03 Spreadsheet Studio** | Cell formulas, relative refs, Excel compatibility | `@ai-office-suite/calculation-engine` (`SS-00`) |
| **FR-04 Data Preparation Engine** | Ingestion, cleaning, dedupe, cardinality-guarded joins, reconciliation | `@ai-office-suite/data-processing` (`DP-00`) |
| **FR-05 Business Analysis Engine** | Versioned metrics, exact monetary math, combined ratios, granularity-aligned budget variance, EN/KM intent resolution | `@ai-office-suite/analytics-engine` (`AN-00`) |
| **FR-07 / FR-08 Consumption** | Consumes certified `AnalyticalResult` & `LinkedMetricReference` across Document, Spreadsheet, Slide & BI views | Shared contracts (`packages/shared-contracts`) |

---

## 2. Numerical Engine Evaluation & Empirical Observations

### 2.1 Why Native DuckDB `DECIMAL` Division & JS `Number` Are Insufficient Alone
- **JavaScript IEEE-754 `Number`:** Empirically measured `0.1 + 0.2 = 0.30000000000000004`. Unsuitable as authoritative monetary accumulator.
- **DuckDB `DECIMAL(18,2) / DECIMAL(18,2)`:** Verified in `DP-00` to coerce division into IEEE-754 double (`1000.00 / 3.00 = 333.3333333333333`).
- **Selected Hybrid Strategy (`AN-00`):** DuckDB executes sandboxed SQL period filtering, voided-row exclusion (`status = 'posted'`), and `COUNT(DISTINCT customer_id)` under `SET enable_external_access = false`, `memory_limit = '256MB'`, and `threads = 2`; all monetary sums, differences, multi-currency FX scaling (10 decimal FX scale), margins, growth rates, and `HALF_UP`/`HALF_EVEN` rounding execute in pure `BigInt` minor units (`FIN-POL-V1`).

### 2.2 Measured DuckDB Analytical Performance (Host: Ryzen 7 5800H, 31.36 GB RAM, Node v24.22.3)
| Workload | `p50` Latency | `p95` Latency | Node RSS Delta |
| :--- | ---: | ---: | ---: |
| `10,000` sales lines (group by dept + distinct customer count + profit) | `22.95 ms` | `24.10 ms` | `+0.60 MB` |
| `50,000` sales lines (group by dept + distinct customer count + profit) | `22.15 ms` | `23.21 ms` | `+0.68 MB` |

---

## 3. Golden Reference Financial Dataset Verification

All 9 independently calculated reference figures from FR-05 §26 matched deterministically across row-order permutations:
- **Net sales revenue:** `$150,000.00` (Gross `$156,000.00` − Returns `$6,000.00`)
- **COGS:** `$90,000.00` · **Gross profit:** `$60,000.00` (`40.00%` Gross margin)
- **Operating expenses:** `$20,000.00` · **Operating profit:** `$40,000.00`
- **Combined Operating margin across Dept A (`30.00%`) & Dept B (`20.00%`):** **`26.67%`** (`$40,000 / $150,000`, explicitly preventing the wrong simple average `25%`)
- **Prior-month revenue (Oct):** `$125,000.00` · **Revenue growth:** **`20.00%`**
- **Budget vs Actual (aligned at `reporting_month + department`):** Revenue `+$10,000.00` (`favorable`), Total costs `+$10,000.00` (`unfavorable`), Operating profit `$0.00` (`on_budget`)

---

## 4. Security Findings & Out-of-Scope Boundaries

- **Prompt & SQL Injection:** `scanForUnsafeAnalyticalInput()` + allowlisted grouping/filter columns (`department`, `reportingMonth`, `customerId`) reject raw SQL (`read_csv_auto`, `; SELECT`, `file://`, `eval()`) fail closed with `400 UNSAFE_ANALYTICAL_OPERATION`.
- **Tenant & Cache Isolation:** Dataset registry, in-memory `resultCache`, `idempotencyResults`, and `publishedSnapshots` are all gated by `assertTenantWorkspaceAccess`.
- **Mock AI & Speech Boundaries:** `planAnalyticalCommand()` is explicitly flagged `isMockPlanner: true` with `aiInterpretation.isObservedFact: false` — never equated with live LLM accuracy.
- **Out of Scope (`Gated`):** Forecasting & backtesting (`ANA-04.03`), advanced statistics (`ANA-04.04`), unrestricted analytics agents, and `AN-01` production persistence remain gated pending founder review.
