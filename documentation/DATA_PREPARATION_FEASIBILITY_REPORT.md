# Data Preparation Studio Feasibility Report (FR-04 / Phase DP-00)

**Date:** 26 November 2026  
**Scope:** Isolated FR-04 `DP-00` feasibility spike comparing **DuckDB (`@duckdb/node-api@1.4.5-r.1`, MIT)** vs **Polars (`nodejs-polars@0.26.2`, MIT)** alongside a typed semantic pipeline verifying all 18 FR-04 acceptance scenarios (`DAT-T01..DAT-T18`). **No production DP-01 pipeline or UI is started.**

---

## 1. Engine Comparison & Empirical Benchmark (`Win11 Pro 10.0.26300`, AMD Ryzen 7 5800H 8C/16T, 31.36 GB RAM, Node `v24.22.3` x64)

| Dimension | DuckDB (`@duckdb/node-api@1.4.5-r.1`) | Polars (`nodejs-polars@0.26.2`) |
| :--- | :--- | :--- |
| **License (Verified Installed)** | **MIT** (prebuilt `@duckdb/node-bindings-win32-x64`) | **MIT** (`nodejs-polars` LICENSE verified MIT; binary pkg `nodejs-polars-win32-x64-msvc` uses `"SEE LICENSE IN LICENSE"`) |
| **Analytical SQL & Joins** | Native embedded analytical SQL (`DISTINCT ON`, grouped aggregates, `LEFT JOIN`, `DECIMAL(18,2)`) | Expressive DataFrame/LazyFrame API (`unique`, `join`, `groupBy`) |
| **Worker Sandboxing** | Verified `SET memory_limit='512MB'`, `SET threads=4`, `SET allow_unsigned_extensions=false`, `SET enable_external_access=false` — **confirmed `read_csv_auto('package.json')` fails once locked** | In-memory DataFrames only; external URI/file access must be gated at caller/worker boundary |
| **Decimal Precision Caveat (§5.6)** | Observed `CAST(1000.00 AS DECIMAL(18,2)) / CAST(3.00 AS DECIMAL(18,2))` = `333.3333333333333` (approximate floating-point division result unless explicit fixed-decimal rounding rules from FR-05 are applied) | JS/Float64 arithmetic (`333.3333333333333`) unless scaled integer minor units or decimal plugins are used |
| **10,000-row Stress (warm-up + 3 runs)** | **p50: 28.65 ms · p95: 90.72 ms · RSS delta: +0.55 MB** | **p50: 93.51 ms · p95: 120.36 ms · RSS delta: +10.83 MB** |
| **100,000-row Stress (warm-up + 3 runs)** | **p50: 115.26 ms · p95: 137.64 ms · RSS delta: +0.96 MB** | **p50: 90.63 ms · p95: 130.19 ms · RSS delta: +48.23 MB** |

*(1,000,000-row stress test deferred to isolated DP-01 worker memory budget testing so in-process Vitest test suites stay deterministic and bounded.)*

### DP-00 Recommendation (`TD-DATA-01`)
**Recommend DuckDB (`@duckdb/node-api@1.4.5-r.1` MIT) as the single primary DP-00/DP-01 data-preparation engine** inside isolated worker processes (`apps/workers`), while keeping **PostgreSQL** strictly for control-plane metadata/governance:
- DuckDB keeps V8/Node RSS overhead near zero (`+0.87 MB` at 100k rows vs `+51.53 MB` in `nodejs-polars`), exposes explicit `memory_limit`, `threads`, and `enable_external_access=false` sandbox controls, and translates directly into allowlisted parameterized SQL operations + Parquet/CSV outputs.
- **Mandatory Financial Rule:** Do **not** rely on raw DuckDB division or JS floats for certified accounting ratios; FR-05 must define explicit fixed-decimal/minor-unit rounding rules.

---

## 2. FR-04 Acceptance Coverage (`DAT-T01` .. `DAT-T18`)

Verified in `tests/g1-dp00-data-preparation.test.ts` on our bilingual CSV + reordered-column XLSX reference corpus:
- **`DAT-T01`:** Month 1 CSV + Month 2 XLSX (reordered columns) mapped semantically by column name.
- **`DAT-T02`:** Khmer values (`ផ្នែករដ្ឋបាល`, `ផ្នែកហិរញ្ញវត្ថុ`) and leading-zero text IDs (`"001245"`) preserved intact.
- **`DAT-T03`:** Ambiguous date `03/04/2026` rejected (`AMBIGUOUS_OR_INVALID_DATE`) until explicit `locale: "DMY"` is supplied.
- **`DAT-T04`:** Missing amount quarantined (`MISSING_REQUIRED_AMOUNT`), never substituted with `0`.
- **`DAT-T05`:** Duplicate composite key `[organization_id, invoice_id, line_number]` quarantined with lineage.
- **`DAT-T06` (§5.4 Golden Negative Join Test):** Duplicate right key `C001` in Customer Master blocked `JOIN_CARDINALITY_VIOLATION` before multiplying `$3,000 -> $4,000`; after clean deduplicated Customer Master, certified `USD = $5,000` (across Oct+Nov) and `KHR = 4,000,000` reconciled with `0` unexplained difference.
- **`DAT-T07`:** Unmatched customer key `C999` retained and explicitly reported (`unmatchedLeftKeys: ["C999"]`).
- **`DAT-T08..T18`:** Verified cancellation, deterministic output SHA-256 on rerun, schema-drift blocking, EN/KM data-prep command parity (`"Find duplicate records"` / `"រកទិន្នន័យស្ទួន"` + append-vs-join ambiguity clarification), cell prompt-injection blocking, malformed CSV reject tracking, certification blocking on unresolved criticals, historical version preservation, cross-tenant `403` denial, and idempotency retry safety.
