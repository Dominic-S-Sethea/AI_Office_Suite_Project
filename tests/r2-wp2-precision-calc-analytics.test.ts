import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ActorContext, SpreadsheetWorkbook } from "@ai-office-suite/shared-contracts";
import {
  applySpreadsheetProposal,
  exportSheetToSafeCsv,
  importWorkbookFromXlsxBuffer,
  planSpreadsheetCommand,
  recalculateWorkbook,
  shiftFormulaReferences,
  sortWorksheetTableByColumn,
  WorkbookInteroperabilityError,
} from "@ai-office-suite/calculation-engine";
import {
  benchmarkPolarsStress,
  compileSafeContractPattern,
  DataPreparationPipeline,
  DataPrepError,
  runDuckDbComparison,
  runPolarsComparison,
  stageCsvSource,
  stageXlsxSource,
} from "@ai-office-suite/data-processing";
import {
  AnalyticsError,
  BusinessAnalysisEngine,
} from "@ai-office-suite/analytics-engine";

const TENANT = "tenant-r2-wp2";
const WS = "ws-r2-wp2";
const ACTOR: ActorContext = {
  tenantId: TENANT,
  workspaceId: WS,
  userId: "user-r2-wp2",
  role: "editor",
  workspaceContentGrant: true,
};

describe("R2-WP2 — Data Processing, DuckDB/Polars Parity, Spreadsheet & Analytics Remediation", () => {
  it("F-02: blocks ReDoS bypasses via ? quantifiers in compileSafeContractPattern while permitting safe lazy bounds", () => {
    expect(() => compileSafeContractPattern("(a?){20}a{20}")).toThrowError(DataPrepError);
    expect(() => compileSafeContractPattern("(a?)+$")).toThrowError(DataPrepError);
    expect(() => compileSafeContractPattern("(?:a?b?)+$")).toThrowError(DataPrepError);
    expect(() => compileSafeContractPattern("a??$")).toThrowError(DataPrepError);

    expect(compileSafeContractPattern("^a+?b$").test("aaab")).toBe(true);
    expect(compileSafeContractPattern("^[A-Z]{2,4}-\\d{1,4}$").test("INV-0042")).toBe(true);
  });

  it("F-03 & F-10 & F-12: caps sparse grid exports, preserves shared formulas, fixes SUM planning, criteria, errors & strings", async () => {
    // F-03: sparse grid DoS protection
    const sparseSheet = {
      sheetId: "s_sparse",
      name: "Sparse",
      cells: {
        A1: { value: 1 },
        A3000000: { value: 2 },
      },
    };
    expect(() => exportSheetToSafeCsv(sparseSheet)).toThrowError(WorkbookInteroperabilityError);
    try {
      exportSheetToSafeCsv(sparseSheet);
    } catch (err) {
      expect((err as WorkbookInteroperabilityError).statusCode).toBe(413);
      expect((err as WorkbookInteroperabilityError).code).toBe("EXPORT_GRID_TOO_LARGE");
    }
    expect(() => sortWorksheetTableByColumn(sparseSheet, "A", "Z", 1, 100_000, "A", true)).toThrowError(
      WorkbookInteroperabilityError,
    );

    // F-10 (part 1): ExcelJS sharedFormula round-trip on importWorkbookFromXlsxBuffer
    const exWb = new ExcelJS.Workbook();
    const exWs = exWb.addWorksheet("Ledger");
    exWs.getCell("A1").value = "Input";
    exWs.getCell("B1").value = "Doubled";
    exWs.getCell("A2").value = 10;
    exWs.getCell("A3").value = 25;
    exWs.fillFormula("B2:B3", "A2*2", [20, 50]);
    const xlsxBuf = new Uint8Array(await exWb.xlsx.writeBuffer());
    const imported = await importWorkbookFromXlsxBuffer(xlsxBuf, "shared-formulas.xlsx");
    expect(imported.sheets[0]!.cells.B2?.formula).toBe("=A2*2");
    expect(imported.sheets[0]!.cells.B3?.formula).toBe("=A3*2");
    expect(imported.sheets[0]!.cells.B3?.evaluatedValue).toBe(50);

    // F-10 (part 2): planSpreadsheetCommand SUM writes to destination cell below range without #CYCLE!
    const sumWb: SpreadsheetWorkbook = {
      workbookId: "wb_sum_fix",
      title: "Sum Fix",
      revision: 1,
      dateSystem: "1900",
      unsupportedFeatures: [],
      sheets: [
        {
          sheetId: "s1",
          name: "Sheet1",
          cells: {
            B2: { value: 10 },
            B3: { value: 20 },
            B4: { value: 30 },
            B5: { value: 40 },
          },
        },
      ],
    };
    const sumPropEn = planSpreadsheetCommand({
      workbook: sumWb,
      sheetName: "Sheet1",
      targetRange: "B2:B5",
      command: "Sum values in range",
      inputLanguage: "en",
      source: "typed_ai",
    });
    expect(sumPropEn.targetRange).toBe("B6");
    expect(sumPropEn.formula).toBe("=SUM(B2:B5)");
    const sumApplied = applySpreadsheetProposal(sumWb, sumPropEn, true);
    expect(sumApplied.sheets[0]!.cells.B2?.value).toBe(10);
    expect(sumApplied.sheets[0]!.cells.B6?.evaluatedValue).toBe(100);

    // F-12: shiftFormulaReferences ignores quoted strings, respects LOG10 boundary, shifts lowercase
    expect(shiftFormulaReferences('=IF(a1="B2", b2, LOG10(c3))', 1, 2)).toBe('=IF(B3="B2", C4, LOG10(D5))');

    // F-12: empty rhs comparison ">", SUMIF error propagation, "" quotes, and Infinity/#NUM!
    const calcWb: SpreadsheetWorkbook = {
      workbookId: "wb_calc_f12",
      title: "Calc F12",
      revision: 1,
      dateSystem: "1900",
      unsupportedFeatures: [],
      sheets: [
        {
          sheetId: "s1",
          name: "Main",
          cells: {
            A1: { value: -5 },
            A2: { value: 10 },
            B1: { value: null, formula: "=1/0" },
            B2: { value: 50 },
            C1: { value: null, formula: '=COUNTIF(A1:A2, ">")' },
            C2: { value: null, formula: '=SUMIF(A1:A2, "<0", B1:B2)' },
            C3: { value: null, formula: '="Say ""Hi"""' },
            C4: { value: null, formula: "=1e308*10" },
            C5: { value: null, formula: "=(-1)^0.5" },
          },
        },
      ],
    };
    const recalced = recalculateWorkbook(calcWb).workbook;
    expect(recalced.sheets[0]!.cells.C1?.evaluatedValue).toBe(0);
    expect(recalced.sheets[0]!.cells.C2?.evaluatedValue).toEqual({ error: "#DIV/0!" });
    expect(recalced.sheets[0]!.cells.C3?.evaluatedValue).toBe('Say "Hi"');
    expect(recalced.sheets[0]!.cells.C4?.evaluatedValue).toEqual({ error: "#NUM!" });
    expect(recalced.sheets[0]!.cells.C5?.evaluatedValue).toEqual({ error: "#NUM!" });
  });

  it("F-11 & F-13: hardens XLSX staging, bilingual dict prototype guard, boolean/precision amounts, dedup tuples, and DuckDB/Polars parity", async () => {
    // F-11: XLSX staging richText, formula Date result, blank row 1 skipping, and row limit
    const wb1 = new ExcelJS.Workbook();
    const ws1 = wb1.addWorksheet("Data");
    ws1.getCell("A2").value = "organization_id";
    ws1.getCell("B2").value = "invoice_id";
    ws1.getCell("C2").value = "line_number";
    ws1.getCell("D2").value = "department";
    ws1.getCell("E2").value = "invoice_date";
    ws1.getCell("F2").value = "currency";
    ws1.getCell("G2").value = "amount";
    ws1.getCell("A3").value = "001";
    ws1.getCell("B3").value = "INV-1";
    ws1.getCell("C3").value = "1";
    ws1.getCell("D3").value = { richText: [{ text: "Fin" }, { text: "ance" }] };
    ws1.getCell("E3").value = { formula: "DATE(2026,11,5)", result: new Date("2026-11-05T00:00:00.000Z") };
    ws1.getCell("F3").value = "USD";
    ws1.getCell("G3").value = "100.50";
    const stagedXlsx = await stageXlsxSource(new Uint8Array(await wb1.xlsx.writeBuffer()), "rich.xlsx");
    expect(stagedXlsx.rows).toHaveLength(1);
    expect(stagedXlsx.rows[0]!.department).toBe("Finance");
    expect(stagedXlsx.rows[0]!.invoice_date).toBe("2026-11-05");
    await expect(
      stageXlsxSource(new Uint8Array(await wb1.xlsx.writeBuffer()), "rich.xlsx", { maxRows: 0 }),
    ).resolves.toBeDefined(); // Math.max(1, 0) clamps to 1; test actual limit exceeded with maxRows: 1 on 2 rows
    ws1.getCell("A4").value = "001";
    ws1.getCell("B4").value = "INV-2";
    ws1.getCell("C4").value = "1";
    await expect(
      stageXlsxSource(new Uint8Array(await wb1.xlsx.writeBuffer()), "too-many.xlsx", { maxRows: 1 }),
    ).rejects.toMatchObject({ statusCode: 413, code: "XLSX_ROW_LIMIT_EXCEEDED" });

    // F-11: composite key pipe collision + constructor dict lookup + precision/boolean/overflow quarantine
    const csv = [
      "organization_id,invoice_id,line_number,department,currency,amount",
      "a|b,c,1,constructor,USD,9007199254740993.00",
      "a,b|c,1,Sales,USD,10.00",
      "org3,INV-3,1,Sales,USD,true",
      "org4,INV-4,1,Sales,USD,99999999999999999999.00",
    ].join("\n");
    const stagedCsv = stageCsvSource(csv, "edge-dp.csv");
    const pipeline = new DataPreparationPipeline();
    const res = pipeline.executeRecipe({
      actor: ACTOR,
      recipe: {
        recipeId: "rec_f11",
        version: 1,
        tenantId: TENANT,
        workspaceId: WS,
        pinnedInputSha256s: [stagedCsv.source.sha256],
        idempotencyKey: "idem_f11_v1",
        steps: [
          { stepId: "d1", op: "map_bilingual_dictionary", params: { column: "department" } },
          { stepId: "q1", op: "quarantine_missing_required", params: { column: "amount" } },
          { stepId: "k1", op: "deduplicate_composite_key", params: { keys: ["organization_id", "invoice_id"] } },
        ],
      },
      salesSources: [stagedCsv],
      expectedColumns: ["organization_id", "invoice_id", "line_number", "department", "currency", "amount"],
    });
    expect(res.rows).toHaveLength(2);
    expect(res.reconciliation.deduplicatedRows).toBe(0);
    expect(res.rows[0]!.department).toBe("constructor");
    const usdCtrl = res.reconciliation.currencyTotals.find((c) => c.currency === "USD");
    expect(usdCtrl?.preparedMinorUnits).toBe("900719925474100300");
    expect(usdCtrl?.unexplainedMinorUnits).toBe("0");
    expect(res.exceptions.filter((e) => e.code === "MISSING_REQUIRED_AMOUNT")).toHaveLength(2);

    // F-13: DuckDB & Polars exact parity on decimals, lowercase/space currency & duplicate first-row order
    const duckVsPolarsSales = [
      { organization_id: "o1", invoice_id: "i1", line_number: "1", customer_id: "C1", department: "Sales", currency: " usd ", amount: 0.1 },
      { organization_id: "o1", invoice_id: "i1", line_number: "1", customer_id: "C1", department: "Sales", currency: "USD", amount: 999 },
      { organization_id: "o1", invoice_id: "i2", line_number: "1", customer_id: "C1", department: "Sales", currency: "USD", amount: 0.2 },
    ];
    const duckRes = await runDuckDbComparison(duckVsPolarsSales, [{ customer_id: "C1", customer_name: "Alpha", region: "PP" }]);
    const polarsRes = runPolarsComparison(duckVsPolarsSales, [{ customer_id: "C1", customer_name: "Alpha", region: "PP" }]);
    expect(duckRes.deduplicatedRowCount).toBe(2);
    expect(polarsRes.deduplicatedRowCount).toBe(2);
    expect(duckRes.currencyMinorTotals).toEqual({ USD: "30" });
    expect(polarsRes.currencyMinorTotals).toEqual({ USD: "30" });
    expect(() => benchmarkPolarsStress(0)).toThrowError(RangeError);
    expect(() => benchmarkPolarsStress(5_000_001)).toThrowError(RangeError);
  });

  it("F-04 & F-05 & F-14: supports array filters, zero-actuals budgets, QTD/previous_year, month-end clamping & grouped growth", async () => {
    const engine = new BusinessAnalysisEngine();
    engine.registerDataset({
      datasetId: "ds_fin_r2",
      version: 1,
      tenantId: TENANT,
      workspaceId: WS,
      granularity: "invoice_line",
      sha256: "",
      rows: [
        // Prior year Q1 & March-end clamped test rows
        { rowId: "R-2025-11", invoiceDate: "2025-11-15", reportingMonth: "2025-11", department: "Sales", customerId: "C1", status: "posted", currency: "USD", grossSales: "100.00", returnsDiscounts: "0.00", cogs: "40.00", opex: "10.00" },
        { rowId: "R-2026-02", invoiceDate: "2026-02-20", reportingMonth: "2026-02", department: "Sales", customerId: "C2", status: "posted", currency: "USD", grossSales: "200.00", returnsDiscounts: "0.00", cogs: "80.00", opex: "20.00" },
        { rowId: "R-2026-03", invoiceDate: "2026-03-15", reportingMonth: "2026-03", department: "Sales", customerId: "  ", status: "posted", currency: "USD", grossSales: "300.00", returnsDiscounts: "0.00", cogs: "120.00", opex: "30.00" },
        // Q4 2026 (Oct = $200 Sales; Nov = $300 Sales, $100 Finance, $50Ops; Zero actuals in Dec 2026!)
        { rowId: "R-2026-10-S", invoiceDate: "2026-10-10", reportingMonth: "2026-10", department: "Sales", customerId: "C1", status: "posted", currency: "USD", grossSales: "200.00", returnsDiscounts: "0.00", cogs: null, opex: null },
        { rowId: "R-2026-11-S", invoiceDate: "2026-11-10", reportingMonth: "2026-11", department: "Sales", customerId: "C1", status: "posted", currency: "USD", grossSales: "300.00", returnsDiscounts: "0.00", cogs: "150.00", opex: "30.00" },
        { rowId: "R-2026-11-F", invoiceDate: "2026-11-12", reportingMonth: "2026-11", department: "Finance", customerId: "C2", status: "posted", currency: "USD", grossSales: "100.00", returnsDiscounts: "0.00", cogs: "40.00", opex: "10.00" },
        { rowId: "R-2026-11-O", invoiceDate: "2026-11-14", reportingMonth: "2026-11", department: "Ops", customerId: "", status: "posted", currency: "USD", grossSales: "50.00", returnsDiscounts: "0.00", cogs: "20.00", opex: "5.00" },
      ],
    });
    engine.registerDataset({
      datasetId: "ds_bud_r2",
      version: 1,
      tenantId: TENANT,
      workspaceId: WS,
      granularity: "department_month_budget",
      sha256: "",
      rows: [
        { reportingMonth: "2026-11", department: "Sales", currency: "USD", budgetCategory: "revenue", budgetAmount: "250.00" },
        { reportingMonth: "2026-12", department: "Sales", currency: "USD", budgetCategory: "revenue", budgetAmount: "500.00" }, // zero actuals in Dec 2026!
        { reportingMonth: "2026-11", department: "Finance", currency: "USD", budgetCategory: "revenue", budgetAmount: "100.00" },
      ],
    });

    // F-04: multi-value IN filter + prototype key guard + empty array filter
    const multiDept = await engine.executeQuery(ACTOR, {
      queryId: "q-f04-multi",
      idempotencyKey: "idem-f04-multi",
      tenantId: TENANT,
      workspaceId: WS,
      operation: "calculate_metric",
      dataset: { id: "ds_fin_r2", version: 1 },
      metrics: [{ id: "FIN-NET-SALES" }],
      period: { start: "2026-11-01", endExclusive: "2026-12-01" },
      filters: { department: ["Sales", "Finance"] },
      currency: "USD",
      outputLanguage: "en",
    });
    expect(multiDept.value.decimalString).toBe("400.00");

    const emptyFilter = await engine.executeQuery(ACTOR, {
      queryId: "q-f04-empty",
      idempotencyKey: "idem-f04-empty",
      tenantId: TENANT,
      workspaceId: WS,
      operation: "calculate_metric",
      dataset: { id: "ds_fin_r2", version: 1 },
      metrics: [{ id: "FIN-NET-SALES" }],
      period: { start: "2026-11-01", endExclusive: "2026-12-01" },
      filters: { department: [] },
      currency: "USD",
      outputLanguage: "en",
    });
    expect(emptyFilter.value.decimalString).toBe("0.00");

    await expect(
      engine.executeQuery(ACTOR, {
        queryId: "q-f04-proto",
        idempotencyKey: "idem-f04-proto",
        tenantId: TENANT,
        workspaceId: WS,
        operation: "calculate_metric",
        dataset: { id: "ds_fin_r2", version: 1 },
        metrics: [{ id: "FIN-NET-SALES" }],
        period: { start: "2026-11-01", endExclusive: "2026-12-01" },
        filters: { constructor: "Sales" },
        currency: "USD",
        outputLanguage: "en",
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILTER_DIMENSION" });

    // F-05: budget_vs_actual over 2026-11..2027-01 includes 2026-12 budget even with zero Dec actuals!
    const bva = await engine.executeQuery(ACTOR, {
      queryId: "q-f05-bva",
      idempotencyKey: "idem-f05-bva",
      tenantId: TENANT,
      workspaceId: WS,
      operation: "budget_vs_actual",
      dataset: { id: "ds_fin_r2", version: 1 },
      budgetDataset: { id: "ds_bud_r2", version: 1 },
      metrics: [{ id: "FIN-BUDGET-VARIANCE" }],
      period: { start: "2026-11-01", endExclusive: "2027-01-01" },
      filters: { department: ["Sales", "Finance"] },
      currency: "USD",
      outputLanguage: "en",
    });
    const bvaRev = bva.breakdown?.find((b) => b.dimensionValues.category === "revenue");
    expect(bvaRev?.dimensionValues.budget).toBe("850.00"); // 250 + 500 + 100
    expect(bvaRev?.dimensionValues.actual).toBe("400.00");

    // F-14: previous_year + grouped FIN-REVENUE-GROWTH + QTD + FIN-GROSS-SALES tolerance of null cogs + DISTINCT whitespace
    const yoyGrouped = await engine.executeQuery(ACTOR, {
      queryId: "q-f14-yoy",
      idempotencyKey: "idem-f14-yoy",
      tenantId: TENANT,
      workspaceId: WS,
      operation: "calculate_metric",
      dataset: { id: "ds_fin_r2", version: 1 },
      metrics: [{ id: "FIN-REVENUE-GROWTH" }],
      period: { start: "2026-11-01", endExclusive: "2026-12-01" },
      comparison: "previous_year",
      groupBy: ["department"],
      currency: "USD",
      outputLanguage: "en",
    });
    const salesYoY = yoyGrouped.breakdown?.find((b) => b.dimensionValues.department === "Sales");
    expect(salesYoY?.value.decimalString).toBe("200.00"); // (300 - 100) / 100 * 100%

    const qtdSales = await engine.executeQuery(ACTOR, {
      queryId: "q-f14-qtd",
      idempotencyKey: "idem-f14-qtd",
      tenantId: TENANT,
      workspaceId: WS,
      operation: "calculate_metric",
      dataset: { id: "ds_fin_r2", version: 1 },
      metrics: [{ id: "FIN-GROSS-SALES" }],
      period: { start: "2026-11-01", endExclusive: "2026-12-01" },
      comparison: "qtd",
      filters: { department: "Sales" },
      currency: "USD",
      outputLanguage: "en",
    });
    expect(qtdSales.validationStatus).toBe("certified"); // null cogs/opex in Oct skipped cleanly!
    expect(qtdSales.value.decimalString).toBe("500.00"); // Oct 200 + Nov 300

    // F-14: month-end clamping (2026-03-31 -> previous_month compares against 2026-02-28)
    const marchEndGrowth = await engine.executeQuery(ACTOR, {
      queryId: "q-f14-clamp",
      idempotencyKey: "idem-f14-clamp",
      tenantId: TENANT,
      workspaceId: WS,
      operation: "calculate_metric",
      dataset: { id: "ds_fin_r2", version: 1 },
      metrics: [{ id: "FIN-REVENUE-GROWTH" }],
      period: { start: "2026-03-01", endExclusive: "2026-03-31" },
      comparison: "previous_month",
      currency: "USD",
      outputLanguage: "en",
    });
    expect(marchEndGrowth.value.decimalString).toBe("50.00"); // 300 vs 200 -> 50%

    // F-14: distinct customer count trims whitespace and ignores empty IDs cleanly in parity with DuckDB
    const distinctCust = await engine.executeQuery(ACTOR, {
      queryId: "q-f14-dist",
      idempotencyKey: "idem-f14-dist",
      tenantId: TENANT,
      workspaceId: WS,
      operation: "calculate_metric",
      dataset: { id: "ds_fin_r2", version: 1 },
      metrics: [{ id: "FIN-DISTINCT-CUSTOMERS" }],
      period: { start: "2026-03-01", endExclusive: "2026-04-01" },
      currency: "USD",
      outputLanguage: "en",
    });
    expect(distinctCust.value.displayValue).toBe("0");
    expect(distinctCust.validationErrors).toEqual([]);

    // F-14: distinct publishSnapshot calls with different publicationIdempotencyKeys don't collide
    const pub1 = engine.publishSnapshot(ACTOR, qtdSales.resultId, "pub-k1");
    const pub2 = engine.publishSnapshot(ACTOR, qtdSales.resultId, "pub-k2");
    expect(pub1.snapshotId).not.toBe(pub2.snapshotId);

    // F-14: unsupported metric in calculate_metric throws 400 UNSUPPORTED_METRIC instead of defaulting to op profit
    await expect(
      engine.executeQuery(ACTOR, {
        queryId: "q-f14-unsupported",
        idempotencyKey: "idem-f14-unsupported",
        tenantId: TENANT,
        workspaceId: WS,
        operation: "calculate_metric",
        dataset: { id: "ds_fin_r2", version: 1 },
        metrics: [{ id: "FIN-BUDGET-VARIANCE" }],
        period: { start: "2026-11-01", endExclusive: "2026-12-01" },
        currency: "USD",
        outputLanguage: "en",
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof AnalyticsError && err.statusCode === 400 && err.code === "UNSUPPORTED_METRIC");
  });
});
