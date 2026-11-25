import { DuckDBInstance } from "@duckdb/node-api";

export interface EngineComparisonRow {
  organization_id: string;
  invoice_id: string;
  line_number: string;
  customer_id: string;
  department: string;
  currency: string;
  amount: number;
}

export interface CustomerMasterRow {
  customer_id: string;
  customer_name: string;
  region: string;
}

export interface EngineParityResult {
  engine: "duckdb" | "polars";
  engineVersion: string;
  deduplicatedRowCount: number;
  duplicateCustomerKeys: string[];
  unmatchedCustomerIds: string[];
  currencyTotals: Record<string, number>;
  decimalDivisionSample: string;
  externalAccessBlocked: boolean;
}

export interface EngineStressResult {
  engine: "duckdb" | "polars";
  rowCount: number;
  p50Ms: number;
  p95Ms: number;
  rssDeltaMb: number;
}

export async function runDuckDbComparison(
  salesRows: EngineComparisonRow[],
  customerRows: CustomerMasterRow[],
): Promise<EngineParityResult> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  try {
    // Hardened worker boundaries (§5.6 / §7)
    await conn.run("SET memory_limit = '512MB'");
    await conn.run("SET threads = 4");
    await conn.run("SET allow_unsigned_extensions = false");

    await conn.run(`
      CREATE TABLE sales_raw (
        organization_id VARCHAR,
        invoice_id VARCHAR,
        line_number VARCHAR,
        customer_id VARCHAR,
        department VARCHAR,
        currency VARCHAR,
        amount DECIMAL(18, 2)
      );
      CREATE TABLE customers (
        customer_id VARCHAR,
        customer_name VARCHAR,
        region VARCHAR
      );
    `);

    const salesStmt = await conn.prepare(
      "INSERT INTO sales_raw VALUES ($1, $2, $3, $4, $5, $6, $7)",
    );
    for (const r of salesRows) {
      salesStmt.bindVarchar(1, r.organization_id);
      salesStmt.bindVarchar(2, r.invoice_id);
      salesStmt.bindVarchar(3, r.line_number);
      salesStmt.bindVarchar(4, r.customer_id);
      salesStmt.bindVarchar(5, r.department);
      salesStmt.bindVarchar(6, r.currency);
      salesStmt.bindDouble(7, r.amount);
      await salesStmt.run();
    }
    salesStmt.destroySync();

    const custStmt = await conn.prepare("INSERT INTO customers VALUES ($1, $2, $3)");
    for (const c of customerRows) {
      custStmt.bindVarchar(1, c.customer_id);
      custStmt.bindVarchar(2, c.customer_name);
      custStmt.bindVarchar(3, c.region);
      await custStmt.run();
    }
    custStmt.destroySync();

    // Lock down external filesystem/network access inside DuckDB after staged load
    await conn.run("SET enable_external_access = false");

    let externalAccessBlocked = false;
    try {
      await conn.runAndReadAll("SELECT * FROM read_csv_auto('package.json')");
    } catch {
      externalAccessBlocked = true;
    }

    // Check duplicate right keys
    const dupReader = await conn.runAndReadAll(`
      SELECT customer_id FROM customers GROUP BY customer_id HAVING COUNT(*) > 1
    `);
    const duplicateCustomerKeys = dupReader
      .getRowObjects()
      .map((row) => String(row.customer_id));

    // Composite key deduplication preserving first occurrence
    await conn.run(`
      CREATE TABLE sales_dedup AS
      SELECT DISTINCT ON (organization_id, invoice_id, line_number)
        organization_id, invoice_id, line_number, customer_id, department, currency, amount
      FROM sales_raw
      ORDER BY organization_id, invoice_id, line_number;
    `);

    const cntReader = await conn.runAndReadAll("SELECT COUNT(*)::INTEGER AS cnt FROM sales_dedup");
    const deduplicatedRowCount = Number(cntReader.getRowObjects()[0]?.cnt ?? 0);

    const unmatchedReader = await conn.runAndReadAll(`
      SELECT DISTINCT s.customer_id
      FROM sales_dedup s
      LEFT JOIN (SELECT DISTINCT customer_id FROM customers) c
        ON s.customer_id = c.customer_id
      WHERE c.customer_id IS NULL
      ORDER BY s.customer_id
    `);
    const unmatchedCustomerIds = unmatchedReader
      .getRowObjects()
      .map((r) => String(r.customer_id));

    const totalsReader = await conn.runAndReadAll(`
      SELECT currency, SUM(amount)::DOUBLE AS total_amt
      FROM sales_dedup
      GROUP BY currency
      ORDER BY currency
    `);
    const currencyTotals: Record<string, number> = {};
    for (const row of totalsReader.getRowObjects()) {
      currencyTotals[String(row.currency)] = Math.round(Number(row.total_amt) * 100) / 100;
    }

    // Document DuckDB DECIMAL division behavior (§5.6 caveat check)
    const divReader = await conn.runAndReadAll(
      "SELECT CAST(1000.00 AS DECIMAL(18,2)) / CAST(3.00 AS DECIMAL(18,2)) AS ratio",
    );
    const decimalDivisionSample = String(divReader.getRowObjects()[0]?.ratio ?? "");

    const verReader = await conn.runAndReadAll("SELECT version() AS ver");
    const engineVersion = String(verReader.getRowObjects()[0]?.ver ?? "unknown");

    return {
      engine: "duckdb",
      engineVersion,
      deduplicatedRowCount,
      duplicateCustomerKeys,
      unmatchedCustomerIds,
      currencyTotals,
      decimalDivisionSample,
      externalAccessBlocked,
    };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

export async function benchmarkDuckDbStress(rowCount: number): Promise<EngineStressResult> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run("SET memory_limit = '512MB'");
    await conn.run("SET threads = 4");
    await conn.run(`
      CREATE TABLE stress_sales AS
      SELECT
        'org_1' AS organization_id,
        'INV-' || (i % 50000)::VARCHAR AS invoice_id,
        ((i % 3) + 1)::VARCHAR AS line_number,
        'C' || LPAD(((i % 500) + 1)::VARCHAR, 3, '0') AS customer_id,
        CASE WHEN i % 2 = 0 THEN 'USD' ELSE 'KHR' END AS currency,
        CAST(((i % 100) + 10) AS DECIMAL(18,2)) AS amount
      FROM range(0, ${Math.trunc(rowCount)}) t(i);

      CREATE TABLE stress_customers AS
      SELECT
        'C' || LPAD(i::VARCHAR, 3, '0') AS customer_id,
        'Customer ' || i::VARCHAR AS customer_name
      FROM range(1, 501) t(i);
    `);

    const query = `
      WITH dedup AS (
        SELECT DISTINCT ON (organization_id, invoice_id, line_number)
          organization_id, invoice_id, line_number, customer_id, currency, amount
        FROM stress_sales
      )
      SELECT d.currency, COUNT(*)::INTEGER AS rows_cnt, SUM(d.amount)::DOUBLE AS total_amt
      FROM dedup d
      LEFT JOIN stress_customers c ON d.customer_id = c.customer_id
      GROUP BY d.currency
    `;

    // Warm-up + 3 measured runs
    await conn.runAndReadAll(query);
    const rssBefore = process.memoryUsage().rss;
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await conn.runAndReadAll(query);
      samples.push(performance.now() - t0);
    }
    const rssAfter = process.memoryUsage().rss;
    samples.sort((a, b) => a - b);
    return {
      engine: "duckdb",
      rowCount,
      p50Ms: Math.round(samples[1]! * 100) / 100,
      p95Ms: Math.round(samples[2]! * 100) / 100,
      rssDeltaMb: Math.round(((rssAfter - rssBefore) / (1024 * 1024)) * 100) / 100,
    };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
