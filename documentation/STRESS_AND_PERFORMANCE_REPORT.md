# Stress Testing, Concurrency & Performance Benchmark Report

**Date:** 2026-11-25  
**Environment:** Ubuntu 24.04 Linux (`x86_64`), Node `v22.23.5`, PostgreSQL `16.16` (Docker `postgres:16-alpine`), DuckDB `v1.4.5`, Polars `0.26.2`  
**Test Harnesses:** `tests/stress-load-benchmarks.test.ts` (`RUN_STRESS=1` + `TEST_POSTGRES_URL`) & `scripts/bench-check.mjs` (`benchmarks/baseline.json`)

---

## 1. Critical Concurrency Defect Uncovered & Fixed Under Real PG16 Stress

Running Workload A (10-way simultaneous `PUT /api/documents/:id` with `expectedRevision: 1` against a 5-connection real PostgreSQL 16 `pg` pool) surfaced a genuine **`READ COMMITTED` EvalPlanQual (`EPQ`) concurrency defect** that single-threaded tests and embedded PGlite never triggered:
- **Root Cause:** `PostgreSqlDocumentRepository.updateDocument()` and `applyAiOperationIdempotent()` originally executed `SELECT ... FROM documents d JOIN document_versions v ON v.revision = d.current_revision WHERE d.document_id = $1 FOR UPDATE OF d`. When Transaction 1 committed `current_revision = 2`, waiting transactions woke up and PostgreSQL EPQ re-evaluated the join against the waiting transaction's snapshot of `document_versions` (`1 = 2` -> false), dropping the row and causing `404 DOCUMENT_NOT_FOUND` instead of `409 REVISION_CONFLICT` (4 of 9 contending writers received `404`!).
- **Fix (`platform/database/src/documentRepository.ts`):** Split the lock into two steps: (1) lock **only** `documents` (`SELECT workspace_id::text, current_revision FROM documents WHERE document_id = $1::uuid FOR UPDATE`), (2) immediately check `row.current_revision !== expectedRevision` -> `409 REVISION_CONFLICT`, and (3) fetch `document_versions` only when the revision matches.
- **Verification:** Re-running Workload A against real PostgreSQL 16.16 yielded **exact `1 × 200` + `9 × 409`** on the 10-way `PUT` race and **exact `1 × applied` + `7 × deduplicated`** (final revision `2`) on the 8-way concurrent identical AI `operationId` race.

---

## 2. Deep Soak Telemetry (`RUN_STRESS=1`, Live PostgreSQL 16.16)

| Workload | Scope & Parameters | Observed Latency / Timing | Memory (RSS Delta) | Correctness / Safety Verdict |
| :--- | :--- | :--- | :---: | :--- |
| **Workload A — Multi-Tenant PG16 HTTP Storm** | 5 isolated tenants, `node-pg` pool `max: 5`, 100 concurrent search reads + 10-way `PUT` race + 8-way durable AI dedup race + mid-storm `token_version` revocation | `p50: 434.84 ms`, `p95: 587.60 ms`, `p99: 596.17 ms` | `+9.88 MB` | **PASS** — `0` cross-tenant leaks, exact `1×200 / 9×409`, exact `1×apply / 7×dedup`, immediate `401` post-revocation |
| **Workload B — Bilingual BigInt Data Pipeline Soak** | 50,000 rows (USD/KHR + leading-zero IDs + 10% duplicates + PII masking + BigInt reconciliation + `AbortSignal` rollback check) | `stage: 229.06 ms`, `execute: 696.73 ms` | `+59.72 MB` | **PASS** — `5,000` dupes quarantined, `unexplainedMinorUnits === "0"` for USD & KHR, clean abort rollback |
| **Workload B — DuckDB 100k Stress** | 100,000 rows composite dedup + LEFT JOIN + grouped currency sums (`enable_external_access=false`) | `p50: 44.29 ms`, `p95: 55.16 ms` | `+21.13 MB` | **PASS** — exact parity with Polars |
| **Workload B — Polars 100k Stress** | 100,000 rows composite dedup + LEFT JOIN + grouped currency sums | `p50: 28.32 ms`, `p95: 42.55 ms` | `+37.00 MB` | **PASS** — exact parity with DuckDB |
| **Workload C — Malicious OOXML Storm** | 60 concurrent adversarial buffers (ZIP traversal, embedded VBA macros, OLE2 encrypted, truncated ZIP) across DOCX, PPTX, XLSX, and DataPrep | `58.63 ms` total (`< 1 ms/file`) | Bounded | **PASS** — `60/60` rejected cleanly, `0` unhandled rejections |
| **Workload C — BI Multi-Role Cache Thrash & Revocation** | 80 evaluations across `owner` & `viewer` scopes + immediate `revokePrincipalAccess()` eviction | `622.86 ms` total | Bounded (500 LRU cap) | **PASS** — `0` scope leaks, immediate `403` post-revocation |
| **Workload D — Login Rate-Limit Isolation** | 6-request brute-force flood against `target@rl.kh` (`max: 3`) + concurrent valid login by `good@rl.kh` | `6.99 s` (includes constant-time bcrypt cost 10) | Bounded (5k bucket cap) | **PASS** — exact `3×401 / 3×429` on target; legitimate user unaffected (`200`) |

---

## 3. Repeatable CI Performance Budget Check (`npm run bench:check`)

| Metric | Measured | Budget | Status |
| :--- | :---: | :---: | :---: |
| `duckdb_50k_p95_ms` | `41.02 ms` | `<= 250 ms` | **PASS** |
| `polars_50k_p95_ms` | `33.98 ms` | `<= 250 ms` | **PASS** |
| `pipeline_10k_bigint_ms` | `235.43 ms` | `<= 1500 ms` | **PASS** |
| `spreadsheet_5k_recalc_ms` | `92.36 ms` | `<= 1000 ms` | **PASS** |

---

## 4. Reproducing Benchmarks

```bash
# Fast performance budget check
npm run bench:check

# Deep soak against real PostgreSQL 16 Docker
docker run -d --rm --name aios-pg16-stress \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=aios_stress_pg16 -e POSTGRES_DB=aios_stress \
  -p 127.0.0.1:55434:5432 postgres:16-alpine
RUN_STRESS=1 TEST_POSTGRES_URL="postgres://postgres:aios_stress_pg16@127.0.0.1:55434/aios_stress" \
  npx vitest run tests/stress-load-benchmarks.test.ts
docker rm -f aios-pg16-stress
```
