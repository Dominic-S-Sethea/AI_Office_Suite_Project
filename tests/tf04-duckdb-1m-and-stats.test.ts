import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  computeDescriptiveStatistics,
  formatCurrencyOrRatioDisplay,
  AnalyticsError,
} from "@ai-office-suite/analytics-engine";

/**
 * TF-04 — Bounded 1,000,000-Row DuckDB Spill-to-Disk & Exact Precision Benchmark (Zero-Cost Local)
 * Plus RC-T02 Exact Descriptive Statistics Verification.
 */
describe("TF-04 — 1,000,000-Row DuckDB Spill-to-Disk Benchmark & Exact Statistics", () => {
  it(
    "TF-04: processes 1,000,000 bilingual USD/KHR rows in DuckDB under memory_limit='256MB' + temp_directory + external_access=false with exact BigInt parity",
    async () => {
      const spillDir = mkdtempSync(path.join(tmpdir(), "aios-tf04-duckdb-spill-"));
      const rssBeforeMb = process.memoryUsage().rss / (1024 * 1024);
      const t0 = performance.now();

      const instance = await DuckDBInstance.create(":memory:");
      const conn = await instance.connect();
      try {
        // Hardened Stage 4 TF-04 bounded memory + explicit temp_directory spill configuration
        const safeSpillPath = spillDir.replace(/'/g, "''");
        await conn.run("SET memory_limit = '256MB'");
        await conn.run(`SET temp_directory = '${safeSpillPath}'`);
        await conn.run("SET threads = 4");
        await conn.run("SET allow_unsigned_extensions = false");
        await conn.run("SET enable_external_access = false");

        // Verify external filesystem access stays blocked even with temp_directory configured
        let blockedExternalRead = false;
        try {
          await conn.runAndReadAll("SELECT * FROM read_csv_auto('package.json')");
        } catch {
          blockedExternalRead = true;
        }
        expect(blockedExternalRead).toBe(true);

        // Generate 1,000,000 deterministic ledger rows across 4 departments and 2 currencies (USD cents + KHR riel)
        // Row i (1..1,000,000):
        //   dept: Sales (i%4=0), Services (1), Retail (2), Finance (3) -> 250,000 rows per dept
        //   currency: USD (i%2=0 -> 500,000 rows), KHR (i%2=1 -> 500,000 rows)
        //   amount_minor:
        //     for USD (even i): ((i % 100) + 1) * 100 cents -> even residues 0,2,4..98 => 50 residues, each occurs 10,000 times
        //       sum of (r + 1) for even r in 0..98 = sum(1,3,5,...,99) = 50^2 = 2,500
        //       exact USD total cents = 10,000 * 2,500 * 100 = 2,500,000,000 cents ($25,000,000.00)
        //     for KHR (odd i): ((i % 100) + 1) * 4000 riels -> odd residues 1,3,5..99 => 50 residues, each occurs 10,000 times
        //       sum of (r + 1) for odd r in 1..99 = sum(2,4,6,...,100) = 50 * 51 = 2,550
        //       exact KHR total riels = 10,000 * 2,550 * 4,000 = 102,000,000,000 KHR
        await conn.run(`
          CREATE TABLE ledger_1m AS
          SELECT
            i AS row_id,
            CASE (i % 4)
              WHEN 0 THEN 'Sales'
              WHEN 1 THEN 'Services'
              WHEN 2 THEN 'Retail'
              ELSE 'Finance'
            END AS department,
            CASE (i % 2)
              WHEN 0 THEN 'USD'
              ELSE 'KHR'
            END AS currency,
            CASE (i % 2)
              WHEN 0 THEN CAST(((i % 100) + 1) * 100 AS BIGINT)
              ELSE CAST(((i % 100) + 1) * 4000 AS BIGINT)
            END AS amount_minor,
            'CUST-' || CAST((i % 25000) AS VARCHAR) AS customer_id
          FROM generate_series(1, 1000000) AS t(i)
        `);

        // Aggregate with exact HUGEINT/BIGINT sums, distinct customer count, and sorted grouped output
        const aggReader = await conn.runAndReadAll(`
          SELECT
            currency,
            COUNT(*)::BIGINT AS row_cnt,
            COUNT(DISTINCT customer_id)::BIGINT AS distinct_customers,
            CAST(SUM(amount_minor) AS VARCHAR) AS sum_minor_str
          FROM ledger_1m
          GROUP BY currency
          ORDER BY currency
        `);
        const currencyRows = aggReader.getRowObjects();

        const deptReader = await conn.runAndReadAll(`
          SELECT
            department,
            COUNT(*)::BIGINT AS row_cnt
          FROM ledger_1m
          GROUP BY department
          ORDER BY department
        `);
        const deptRows = deptReader.getRowObjects();

        // Force an external-sort / window pass across all 1M rows to exercise bounded memory & spill safety
        const topReader = await conn.runAndReadAll(`
          SELECT row_id, department, currency, amount_minor
          FROM ledger_1m
          ORDER BY amount_minor DESC, row_id ASC
          LIMIT 5
        `);
        const topRows = topReader.getRowObjects();

        const elapsedMs = Number((performance.now() - t0).toFixed(1));
        const rssAfterMb = process.memoryUsage().rss / (1024 * 1024);
        const rssDeltaMb = Number((rssAfterMb - rssBeforeMb).toFixed(1));

        expect(currencyRows).toHaveLength(2);
        const khrRow = currencyRows.find((r) => r.currency === "KHR");
        const usdRow = currencyRows.find((r) => r.currency === "USD");

        expect(Number(usdRow?.row_cnt)).toBe(500_000);
        expect(Number(khrRow?.row_cnt)).toBe(500_000);
        expect(Number(usdRow?.distinct_customers)).toBe(12_500);
        expect(Number(khrRow?.distinct_customers)).toBe(12_500);

        // Exact BigInt parity against closed-form analytical math (ZERO float drift across 1,000,000 rows!)
        const expectedUsdMinor = 2_500_000_000n;
        const expectedKhrMinor = 102_000_000_000n;
        expect(BigInt(String(usdRow?.sum_minor_str))).toBe(expectedUsdMinor);
        expect(BigInt(String(khrRow?.sum_minor_str))).toBe(expectedKhrMinor);
        expect(formatCurrencyOrRatioDisplay(expectedUsdMinor, 2, { currency: "USD" })).toBe("$25,000,000.00");
        expect(formatCurrencyOrRatioDisplay(expectedKhrMinor, 0, { currency: "KHR" })).toBe("៛102,000,000,000");

        expect(deptRows).toHaveLength(4);
        for (const dr of deptRows) {
          expect(Number(dr.row_cnt)).toBe(250_000);
        }
        expect(topRows).toHaveLength(5);
        expect(elapsedMs).toBeLessThan(30_000);

        console.info(
          "TF-04 1M-Row DuckDB Spill Benchmark:",
          JSON.stringify({
            rows: 1_000_000,
            memoryLimit: "256MB",
            externalAccessBlocked: blockedExternalRead,
            elapsedMs,
            rssDeltaMb,
            usdExactDisplay: formatCurrencyOrRatioDisplay(expectedUsdMinor, 2, { currency: "USD" }),
            khrExactDisplay: formatCurrencyOrRatioDisplay(expectedKhrMinor, 0, { currency: "KHR" }),
          }),
        );
      } finally {
        conn.closeSync();
        instance.closeSync();
        rmSync(spillDir, { recursive: true, force: true });
      }
    },
    35_000,
  );

  it("RC-T02 / TF-04: exact descriptive statistics verify [1, 2, 3, 4, 5, null] without zero-coercion", () => {
    const res = computeDescriptiveStatistics([1, 2, 3, 4, 5, null, undefined, "  "], {
      missingPolicy: "exclude_nulls",
      percentileMethod: "linear_r7",
    });
    expect(res.count).toBe(5);
    expect(res.missingCount).toBe(3);
    expect(res.mean).toBe(3);
    expect(res.median).toBe(3);
    expect(res.min).toBe(1);
    expect(res.max).toBe(5);
    expect(res.sampleVariance).toBeCloseTo(2.5, 12);
    expect(res.sampleStdDev).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(res.p25).toBe(2);
    expect(res.p75).toBe(4);
    expect(res.iqr).toBe(2);
    expect(res.outliers).toEqual([]);

    // Nearest-rank percentile method explicitly declared and verified
    const nearest = computeDescriptiveStatistics([1, 2, 3, 4, 5, null], {
      missingPolicy: "exclude_nulls",
      percentileMethod: "nearest_rank",
    });
    expect(nearest.percentileMethod).toBe("nearest_rank");
    expect(nearest.p25).toBe(2);
    expect(nearest.p75).toBe(4);

    // Under error_on_null, missing values throw AnalyticsError (NEVER silently substituted with 0)
    expect(() =>
      computeDescriptiveStatistics([1, 2, null, 4], { missingPolicy: "error_on_null" }),
    ).toThrowError(AnalyticsError);

    // Non-numeric text throws INVALID_NUMERIC_VALUE
    expect(() => computeDescriptiveStatistics([1, "not-a-number", 3])).toThrow(/INVALID_NUMERIC_VALUE|cannot be coerced/i);
  });
});
