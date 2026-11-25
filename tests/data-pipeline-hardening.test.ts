import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { ActorContext, DataPreparationRecipe } from "@ai-office-suite/shared-contracts";
import {
  benchmarkDuckDbStress,
  DataPreparationPipeline,
  DataPrepError,
  exportCertifiedDatasetToSafeCsv,
  normalizeKhmerDigitsText,
  parseAmountToMinorUnitsBigInt,
  runDuckDbComparison,
  runPolarsComparison,
  stageCsvSource,
  stageXlsxSource,
} from "@ai-office-suite/data-processing";

describe("Phase 2 — Data Pipeline Hardening (RFC 4180, BigInt FIN-POL-V1, Khmer Numerals, Schema Contract, PII Masking & DuckDB/Polars Parity)", () => {
  const actor: ActorContext = {
    tenantId: "tenant_dp_hardening",
    workspaceId: "ws_finance_dp",
    userId: "user_data_eng",
    role: "editor",
  };

  it("parses RFC 4180 multi-line Khmer/English quoted CSV fields, auto-detects delimiters, and enforces header & DoS guards", () => {
    const multilineCsv = [
      "organization_id,invoice_id,line_number,currency,amount,note",
      '00042,INV-1,1,USD,10.50,"Phnom Penh\nផ្លូវ ២៧១, ""Headquarters"""',
      "00042,INV-2,1,KHR,4000000,Single line",
    ].join("\n");

    const staged = stageCsvSource(multilineCsv, "multiline.csv");
    expect(staged.source.rejectedRows).toBe(0);
    expect(staged.source.acceptedRows).toBe(2);
    expect(staged.rows[0]?.organization_id).toBe("00042");
    expect(staged.rows[0]?.note).toBe('Phnom Penh\nផ្លូវ ២៧១, "Headquarters"');
    expect(staged.rows[0]?.__sourceRowNumber).toBe(2);
    expect(staged.rows[1]?.__sourceRowNumber).toBe(4);

    // Semicolon and Tab (TSV) auto-detection
    const semiStaged = stageCsvSource("id;name;amount\n001;Alpha;100\n", "semi.csv");
    expect(semiStaged.source.columnNames).toEqual(["id", "name", "amount"]);
    expect(semiStaged.rows[0]?.id).toBe("001");

    const tsvStaged = stageCsvSource("id\tname\tamount\n002\tBeta\t250\n", "data.tsv");
    expect(tsvStaged.source.columnNames).toEqual(["id", "name", "amount"]);
    expect(tsvStaged.rows[0]?.name).toBe("Beta");

    // Duplicate & empty header fail closed
    expect(() => stageCsvSource("id,amount,amount\n1,10,20\n", "dup.csv")).toThrow(DataPrepError);
    expect(() => stageCsvSource("id,,amount\n1,x,20\n", "empty.csv")).toThrow(DataPrepError);

    // Row & cell length DoS guards
    expect(() =>
      stageCsvSource("a,b\n1,2\n3,4\n5,6\n", "too_many.csv", { maxRows: 2 }),
    ).toThrow(/maximum supported row limit/i);
    expect(() =>
      stageCsvSource(`a,b\n1,${"x".repeat(300)}\n`, "wide_cell.csv", { maxCellLength: 128 }),
    ).toThrow(/exceeds safety bound/i);
  });

  it("normalizes Khmer numerals on financial columns while preserving leading-zero IDs and exact BigInt reconciliation", () => {
    expect(normalizeKhmerDigitsText("១២,៥០០.៥០ $", true)).toBe("12500.50");
    expect(normalizeKhmerDigitsText("៤,១០០,០០០ ៛", true)).toBe("4100000");
    expect(parseAmountToMinorUnitsBigInt("0.10", 2)).toBe(10n);
    expect(parseAmountToMinorUnitsBigInt("125000000000", 0)).toBe(125000000000n);

    const csv = [
      "organization_id,invoice_id,line_number,invoice_date,currency,amount,customer_email,customer_phone,note",
      '00042,INV-10,1,2026-11-01,USD,"០.១០",sopheak@company.kh,+855 12 345 678,Normal item',
      '00042,INV-11,1,2026-11-02,USD,"០.២០ $",dara@company.kh,012-987-654,=CMD|\' /C calc\'!A0',
      '00042,INV-12,1,2026-11-03,USD,"-0.05",dara@company.kh,012-987-654,Credit note refund',
      '00042,INV-13,1,2026-11-04,KHR,"១២៥,០០០,០០០,០០០ ៛",nita@company.kh,+855 89 111 222,Large KHR settlement',
      '00042,INV-14,1,2026-11-05,KHR,"៤,០០០,០០០ រៀល",nita@company.kh,+855 89 111 222,Second KHR',
    ].join("\n");

    const staged = stageCsvSource(csv, "khmer-finance.csv");
    const pipeline = new DataPreparationPipeline();

    // Bilingual command planning intents
    expect(pipeline.planDataPrepCommand({ actor, command: "បម្លែងលេខខ្មែរ" }).intent).toBe("normalize_khmer_numerals");
    expect(pipeline.planDataPrepCommand({ actor, command: "mask pii columns before export" }).intent).toBe("mask_pii_columns");

    const recipe: DataPreparationRecipe = {
      recipeId: "rec_khmer_bigint",
      version: 1,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      pinnedInputSha256s: [staged.source.sha256],
      idempotencyKey: "idem_khmer_bigint_v1",
      steps: [
        { stepId: "s1", op: "trim_normalize", params: {} },
        { stepId: "s2", op: "normalize_khmer_numerals", params: { columns: ["amount"], stripCurrencySymbols: true } },
        { stepId: "s3", op: "quarantine_missing_required", params: { column: "amount" } },
        {
          stepId: "s4",
          op: "validate_schema_contract",
          params: {
            rules: [
              { column: "organization_id", required: true, pattern: "^\\d{5}$" },
              { column: "currency", required: true, type: "enum", allowedValues: ["USD", "KHR"] },
              { column: "invoice_date", required: true, type: "date" },
            ],
          },
        },
        { stepId: "s5", op: "mask_pii_columns", params: { columns: ["customer_email", "customer_phone"], mode: "redact" } },
      ],
    };

    const artifact = pipeline.executeRecipe({
      actor,
      recipe,
      salesSources: [staged],
      expectedColumns: [
        "organization_id",
        "invoice_id",
        "line_number",
        "invoice_date",
        "currency",
        "amount",
        "customer_email",
        "customer_phone",
        "note",
      ],
    });

    expect(artifact.status).toBe("certified");
    expect(artifact.reconciliation.passed).toBe(true);
    expect(artifact.rows).toHaveLength(5);

    // Leading-zero organization_id preserved untouched
    expect(artifact.rows[0]?.organization_id).toBe("00042");

    // Exact BigInt reconciliation: USD 0.10 + 0.20 - 0.05 = 0.25 (25 minor cents, zero IEEE-754 drift!)
    const usdTotal = artifact.reconciliation.currencyTotals.find((c) => c.currency === "USD");
    expect(usdTotal?.preparedMinorUnits).toBe("25");
    expect(usdTotal?.unexplainedMinorUnits).toBe("0");
    expect(usdTotal?.preparedTotal).toBe(0.25);

    // Exact BigInt KHR (scale 0): 125,000,000,000 + 4,000,000 = 125,004,000,000 KHR
    const khrTotal = artifact.reconciliation.currencyTotals.find((c) => c.currency === "KHR");
    expect(khrTotal?.scale).toBe(0);
    expect(khrTotal?.preparedMinorUnits).toBe("125004000000");
    expect(khrTotal?.unexplainedMinorUnits).toBe("0");

    // PII masking verified (raw email & phone gone)
    const inv10 = artifact.rows.find((r) => r.invoice_id === "INV-10");
    expect(inv10?.customer_email).toBe("s***@company.kh");
    expect(inv10?.customer_phone).toBe("***-***-5678");

    // OWASP safe CSV export neutralizes `=CMD|...` formula injection while preserving numeric `-0.05`
    const exported = exportCertifiedDatasetToSafeCsv(artifact);
    expect(exported.rowCount).toBe(5);
    expect(exported.csv).toContain(",'=CMD|");
    expect(exported.csv).toContain("\r\n-0.05,USD,");
    expect(exported.csvSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("quarantines schema contract violations & missing dates with exact zero-drift excluded BigInt accounting", () => {
    const csv = [
      "organization_id,invoice_id,line_number,invoice_date,currency,amount,customer_email",
      "00042,INV-1,1,2026-11-01,USD,100.00,valid@org.kh",
      "00042,INV-2,1,,USD,50.25,nodate@org.kh",
      "00042,INV-3,1,2026-11-02,EUR,75.00,badcurr@org.kh",
    ].join("\n");

    const staged = stageCsvSource(csv, "violations.csv");
    const pipeline = new DataPreparationPipeline();
    const artifact = pipeline.executeRecipe({
      actor,
      recipe: {
        recipeId: "rec_contract_quarantine",
        version: 1,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        pinnedInputSha256s: [staged.source.sha256],
        idempotencyKey: "idem_contract_v1",
        steps: [
          { stepId: "s1", op: "parse_date_locale", params: { column: "invoice_date", locale: "ISO" } },
          {
            stepId: "s2",
            op: "validate_schema_contract",
            params: {
              rules: [{ column: "currency", required: true, type: "enum", allowedValues: ["USD", "KHR"] }],
            },
          },
          { stepId: "s3", op: "mask_pii_columns", params: { columns: ["customer_email"], mode: "hash_token", salt: "s1" } },
        ],
      },
      salesSources: [staged],
      expectedColumns: ["organization_id", "invoice_id", "line_number", "invoice_date", "currency", "amount", "customer_email"],
    });

    expect(artifact.status).toBe("blocked");
    expect(artifact.rows).toHaveLength(1);
    expect(String(artifact.rows[0]?.customer_email)).toMatch(/^pii_[0-9a-f]{16}$/);

    // Both USD (missing date $50.25) and EUR (disallowed currency $75.00) must reconcile with 0 unexplained minor units
    const usd = artifact.reconciliation.currencyTotals.find((c) => c.currency === "USD");
    const eur = artifact.reconciliation.currencyTotals.find((c) => c.currency === "EUR");
    expect(usd?.sourceMinorUnits).toBe("15025");
    expect(usd?.preparedMinorUnits).toBe("10000");
    expect(usd?.excludedMinorUnits).toBe("5025");
    expect(usd?.unexplainedMinorUnits).toBe("0");
    expect(eur?.sourceMinorUnits).toBe("7500");
    expect(eur?.preparedMinorUnits).toBe("0");
    expect(eur?.excludedMinorUnits).toBe("7500");
    expect(eur?.unexplainedMinorUnits).toBe("0");
  });

  it("stages named XLSX worksheets, extracts cached formula results & dates, and verifies DuckDB sandbox + DuckDB/Polars BigInt parity", async () => {
    const wb = new ExcelJS.Workbook();
    const s1 = wb.addWorksheet("Cover");
    s1.addRow(["Title"]);
    s1.addRow(["Ignore Cover"]);

    const s2 = wb.addWorksheet("Ledger");
    s2.addRow(["organization_id", "invoice_id", "invoice_date", "currency", "amount"]);
    s2.addRow(["00099", "INV-X1", new Date("2026-11-15T00:00:00.000Z"), "USD", { formula: "100+25.5", result: 125.5 }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const staged = await stageXlsxSource(buf, "ledger.xlsx", { sheetName: "Ledger" });
    expect(staged.rows).toHaveLength(1);
    expect(staged.rows[0]?.organization_id).toBe("00099");
    expect(staged.rows[0]?.invoice_date).toBe("2026-11-15");
    expect(staged.rows[0]?.amount).toBe(125.5);

    const sales = [
      { organization_id: "00099", invoice_id: "INV-1", line_number: "1", customer_id: "C001", department: "Sales", currency: "USD", amount: 100.1 },
      { organization_id: "00099", invoice_id: "INV-1", line_number: "1", customer_id: "C001", department: "Sales", currency: "USD", amount: 100.1 },
      { organization_id: "00099", invoice_id: "INV-2", line_number: "1", customer_id: "C002", department: "Finance", currency: "USD", amount: 200.2 },
      { organization_id: "00099", invoice_id: "INV-3", line_number: "1", customer_id: "C999", department: "Finance", currency: "KHR", amount: 4100000 },
    ];
    const customers = [
      { customer_id: "C001", customer_name: "Alpha", region: "Phnom Penh" },
      { customer_id: "C002", customer_name: "Beta", region: "Siem Reap" },
    ];

    const duck = await runDuckDbComparison(sales, customers);
    const polars = runPolarsComparison(sales, customers);

    expect(duck.externalAccessBlocked).toBe(true);
    expect(duck.blockedSandboxProbes).toEqual(["read_csv_auto", "read_parquet", "glob", "copy_to_file"]);
    expect(duck.deduplicatedRowCount).toBe(polars.deduplicatedRowCount);
    expect(duck.unmatchedCustomerIds).toEqual(polars.unmatchedCustomerIds);
    expect(duck.currencyMinorTotals).toEqual(polars.currencyMinorTotals);
    expect(duck.currencyMinorTotals?.USD).toBe("30030");
    expect(duck.currencyMinorTotals?.KHR).toBe("4100000");

    await expect(benchmarkDuckDbStress(0)).rejects.toThrow(RangeError);
    await expect(benchmarkDuckDbStress(99_999_999)).rejects.toThrow(RangeError);
  });
});
