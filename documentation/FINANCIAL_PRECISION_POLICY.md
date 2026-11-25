# Financial Numerical Precision & Rounding Policy (`FIN-POL-V1`)

**Phase:** FR-05 (`AN-00` Feasibility Baseline — `ANA-01.05`)  
**Implementation:** `engines/analytics/src/precision.ts`  
**Contract:** `FinancialPrecisionPolicy` (`packages/shared-contracts/src/index.ts`)

---

## 1. Core Distinction: Workbook Formulas vs. Governed Financial Metrics

| Calculation Context | Engine & Semantics | Rationale |
| :--- | :--- | :--- |
| **Spreadsheet Grid Formulas (`FR-03`)** | `@ai-office-suite/calculation-engine` / JS IEEE-754 + Excel `ROUND` | Must reproduce familiar Microsoft Excel formula and compatibility semantics inside interactive worksheets. |
| **Governed Financial Metrics (`FR-05`)** | `BigInt` scaled minor units (`engines/analytics/src/precision.ts`) + DuckDB SQL grouping (`@duckdb/node-api`) | Eliminates binary floating-point representation drift (`0.1 + 0.2 !== 0.3`) and prevents DuckDB's approximate `DECIMAL(18,2) / DECIMAL(18,2)` float conversion (`333.3333333333333`). |

---

## 2. Exact Minor-Unit Arithmetic Rules (`FIN-POL-V1`)

1. **Input Parsing:** Monetary strings (e.g., `"150000.00"`) are parsed lexicographically into integer minor units (`bigint` at scale `2` = cents) without intermediate IEEE-754 multiplication.
2. **Overflow Guard:** `DEFAULT_FINANCIAL_PRECISION_POLICY.overflowSafeMaxMinorUnits = "999999999999999999"` (`±9,999,999,999,999,999.99`). Values exceeding this threshold fail closed with `422 NUMERIC_OVERFLOW` (`ANA-T09`).
3. **Rounding Modes (`RoundingMode`):**
   - `HALF_UP` (default corporate reporting policy): midpoint ties (`2.5`, `-2.5`) round **away from zero** (`13`, `-13`).
   - `HALF_EVEN` (Banker's rounding): midpoint ties round toward the **nearest even integer** (`12` vs `13`).
4. **Zero-Denominator Protection (`ZeroDenominatorPolicy`, `ANA-T03`):**
   - Mirrors Microsoft DAX `DIVIDE()` safety: when `denominator === 0n`, `divideExactScaled` returns `{ status: "unavailable", reason: "ZERO_DENOMINATOR" }` and `displayValue: "Unavailable (zero denominator)"` — **never** `0`, `NaN`, or `Infinity`.
5. **Negative Amounts:** Negative revenues (credit memos/returns), negative variances, and negative growth percentages retain exact sign symmetry in `roundQuotientExact` and `formatCurrencyOrRatioDisplay` (`-$10,000.00`).
6. **Multi-Currency Validation (`ANA-T08`):**
   - Mixed-currency datasets without an approved `ExchangeRateSpecification` (`fromCurrency`, `toCurrency`, strictly positive `rateDecimalString`, `source`, `effectiveDate`) fail closed with `422 CURRENCY_CONVERSION_UNDEFINED`.
   - When an approved rate is present, each transaction minor-unit value is multiplied by scaled `rateDecimalString` (6 decimal places) and rounded exactly to target scale (`2`).
7. **Display Formatting vs. Stored Value:** Grouping commas, `$` / `៛` prefixes, and `%` suffixes are derived strictly for `displayValue`; `minorUnits` and `decimalString` retain canonical unformatted exactness.
8. **Missing Data (`ANA-T10`):** Missing (`null` or blank) required amounts in eligible `posted` rows trigger `validationStatus: "blocked"` (`MISSING_REQUIRED_AMOUNT`) — never silently coerced to `0`.
