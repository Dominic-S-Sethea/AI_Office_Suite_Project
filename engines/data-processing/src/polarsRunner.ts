import pl from "nodejs-polars";
import { currencyScaleFor, parseExactDecimalToMinorUnits } from "@ai-office-suite/validation";
import type {
  CustomerMasterRow,
  EngineComparisonRow,
  EngineParityResult,
  EngineStressResult,
} from "./duckdbRunner.ts";

export function runPolarsComparison(
  salesRows: EngineComparisonRow[],
  customerRows: CustomerMasterRow[],
): EngineParityResult {
  const normalizedSalesRows = salesRows.map((r) => ({
    ...r,
    currency: String(r.currency ?? "USD").trim().toUpperCase(),
  }));
  const salesDf = pl.DataFrame(normalizedSalesRows);
  const custDf = pl.DataFrame(customerRows);

  // Detect duplicate customer keys
  const dupDf = custDf
    .groupBy("customer_id")
    .agg(pl.col("customer_id").count().alias("cnt"))
    .filter(pl.col("cnt").gt(1));
  const duplicateCustomerKeys = dupDf
    .toRecords()
    .map((r) => String((r as Record<string, unknown>).customer_id));

  // Composite key deduplication
  const dedupDf = salesDf.unique({
    subset: ["organization_id", "invoice_id", "line_number"],
    keep: "first",
    maintainOrder: true,
  });

  // Unmatched keys via anti-like left join
  const distinctCustDf = custDf.unique({ subset: ["customer_id"], keep: "first" });
  const joinedDf = dedupDf.join(distinctCustDf, { on: "customer_id", how: "left" });
  const unmatchedIds = new Set<string>();
  for (const row of joinedDf.toRecords() as Array<Record<string, unknown>>) {
    if (row.customer_name === null || row.customer_name === undefined) {
      unmatchedIds.add(String(row.customer_id));
    }
  }

  const groupedDf = dedupDf
    .groupBy("currency")
    .agg(pl.col("amount").sum().alias("total_amt"));
  const currencyTotals: Record<string, number> = {};
  for (const row of groupedDf.toRecords() as Array<Record<string, unknown>>) {
    const code = String(row.currency ?? "USD").trim().toUpperCase();
    currencyTotals[code] = Math.round(Number(row.total_amt) * 100) / 100;
  }

  const minorTotalsMap = new Map<string, bigint>();
  for (const row of dedupDf.toRecords() as Array<Record<string, unknown>>) {
    const code = String(row.currency ?? "USD").trim().toUpperCase();
    const scale = currencyScaleFor(code);
    const rawAmt = row.amount;
    const minor =
      rawAmt === null || rawAmt === undefined
        ? 0n
        : parseExactDecimalToMinorUnits(typeof rawAmt === "number" || typeof rawAmt === "string" ? rawAmt : String(rawAmt), scale);
    minorTotalsMap.set(code, (minorTotalsMap.get(code) ?? 0n) + minor);
  }
  const currencyMinorTotals: Record<string, string> = {};
  for (const [k, v] of Array.from(minorTotalsMap.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    currencyMinorTotals[k] = v.toString();
  }

  return {
    engine: "polars",
    engineVersion: String(pl.version ?? "0.26.2"),
    deduplicatedRowCount: dedupDf.height,
    duplicateCustomerKeys,
    unmatchedCustomerIds: Array.from(unmatchedIds).sort(),
    currencyTotals,
    currencyMinorTotals,
    decimalDivisionSample: String(1000 / 3),
    externalAccessBlocked: true, // In-memory DataFrames only; no external URI loader invoked
  };
}

export function benchmarkPolarsStress(rowCount: number): EngineStressResult {
  const safeRowCount = Math.trunc(rowCount);
  if (!Number.isSafeInteger(safeRowCount) || safeRowCount < 1 || safeRowCount > 5_000_000) {
    throw new RangeError(`benchmarkPolarsStress rowCount must be an integer in [1, 5000000], got ${rowCount}`);
  }
  const orgs: string[] = [];
  const invs: string[] = [];
  const lines: string[] = [];
  const custIds: string[] = [];
  const currencies: string[] = [];
  const amounts: number[] = [];

  for (let i = 0; i < safeRowCount; i++) {
    orgs.push("org_1");
    invs.push(`INV-${i % 50000}`);
    lines.push(String((i % 3) + 1));
    custIds.push(`C${String((i % 500) + 1).padStart(3, "0")}`);
    currencies.push(i % 2 === 0 ? "USD" : "KHR");
    amounts.push((i % 100) + 10);
  }

  const salesDf = pl.DataFrame({
    organization_id: orgs,
    invoice_id: invs,
    line_number: lines,
    customer_id: custIds,
    currency: currencies,
    amount: amounts,
  });

  const cIds: string[] = [];
  const cNames: string[] = [];
  for (let i = 1; i <= 500; i++) {
    cIds.push(`C${String(i).padStart(3, "0")}`);
    cNames.push(`Customer ${i}`);
  }
  const custDf = pl.DataFrame({ customer_id: cIds, customer_name: cNames });

  const runOnce = () => {
    const dedup = salesDf.unique({
      subset: ["organization_id", "invoice_id", "line_number"],
      keep: "first",
    });
    const joined = dedup.join(custDf, { on: "customer_id", how: "left" });
    return joined.groupBy("currency").agg(pl.col("amount").sum().alias("total_amt")).toRecords();
  };

  // Warm-up + 3 measured runs
  runOnce();
  const rssBefore = process.memoryUsage().rss;
  const samples: number[] = [];
  let summaryRows: Array<{ currency: string; totalAmt: number }> = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const recs = runOnce() as Array<{ currency: string; total_amt: number }>;
    if (i === 2) {
      summaryRows = recs
        .map((r) => ({ currency: String(r.currency), totalAmt: Number(r.total_amt) }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
    }
    samples.push(performance.now() - t0);
  }
  const rssAfter = process.memoryUsage().rss;
  samples.sort((a, b) => a - b);

  return {
    engine: "polars",
    rowCount,
    p50Ms: Math.round(samples[1]! * 100) / 100,
    p95Ms: Math.round(samples[2]! * 100) / 100,
    rssDeltaMb: Math.round(((rssAfter - rssBefore) / (1024 * 1024)) * 100) / 100,
    summaryRows,
  };
}
