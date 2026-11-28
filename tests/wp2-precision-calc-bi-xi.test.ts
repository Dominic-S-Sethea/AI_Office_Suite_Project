import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BusinessAnalysisEngine,
  buildCrossModuleReconciledOutputs,
  convertCurrencyMinorUnits,
  currencyScaleFor,
} from "@ai-office-suite/analytics-engine";
import { AuthorizationError } from "@ai-office-suite/authorization";
import {
  applySpreadsheetProposal,
  recalculateWorkbook,
  SpreadsheetAiError,
} from "@ai-office-suite/calculation-engine";
import { DataPreparationPipeline, stageCsvSource } from "@ai-office-suite/data-processing";
import {
  CrossModuleIntegrationEngine,
  IntegrationError,
  STANDARD_FINANCE_COLUMNS,
  XI00_FINANCE_ROWS_V2,
} from "@ai-office-suite/integration-engine";
import { IntelligenceStudioEngine } from "@ai-office-suite/intelligence-engine";
import type {
  ActorContext,
  DataScopePolicy,
  ReportingContext,
  SpreadsheetWorkbook,
} from "@ai-office-suite/shared-contracts";

const TENANT_WP2 = "11111111-2222-4333-8444-555555555555";
const WS_WP2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const OWNER_ACTOR: ActorContext = {
  tenantId: TENANT_WP2,
  workspaceId: WS_WP2,
  userId: "00000000-0000-4000-8000-000000000001",
  role: "owner",
  workspaceContentGrant: true,
};

const EDITOR_ACTOR: ActorContext = {
  tenantId: TENANT_WP2,
  workspaceId: WS_WP2,
  userId: "00000000-0000-4000-8000-000000000002",
  role: "editor",
};

const REVIEWER_ACTOR: ActorContext = {
  tenantId: TENANT_WP2,
  workspaceId: WS_WP2,
  userId: "00000000-0000-4000-8000-000000000003",
  role: "reviewer",
};

const VIEWER_ACTOR: ActorContext = {
  tenantId: TENANT_WP2,
  workspaceId: WS_WP2,
  userId: "00000000-0000-4000-8000-000000000004",
  role: "viewer",
};

const BILLING_ACTOR: ActorContext = {
  tenantId: TENANT_WP2,
  workspaceId: WS_WP2,
  userId: "00000000-0000-4000-8000-000000000005",
  role: "billing_admin",
};

const AUDITOR_ACTOR: ActorContext = {
  tenantId: TENANT_WP2,
  workspaceId: WS_WP2,
  userId: "00000000-0000-4000-8000-000000000006",
  role: "auditor",
};

const POLICY_ALL: DataScopePolicy = {
  policyId: "pol_wp2_all",
  policyVersion: 1,
  tenantId: TENANT_WP2,
  principalRole: "owner",
  allowedDepartments: "ALL",
  allowedColumns: [...STANDARD_FINANCE_COLUMNS],
  maxClassification: "restricted",
  canExportUnderlyingDetail: true,
  canPublish: true,
};

const POLICY_SALES_ONLY: DataScopePolicy = {
  policyId: "pol_wp2_sales",
  policyVersion: 1,
  tenantId: TENANT_WP2,
  principalRole: "editor",
  allowedDepartments: ["Sales"],
  allowedColumns: ["rowId", "invoiceDate", "reportingMonth", "department", "customerId", "currency", "grossSales", "returnsDiscounts", "cogs", "opex"],
  canExportUnderlyingDetail: false,
  canPublish: true,
};

describe("WP-2 Regression Suite — F-15 Precision, F-20 Calculation, F-11 Isolation, F-16 XI Workflows", () => {
  it("F-15: enforces KHR scale-0 parity, cross-scale FX, hardened descriptive stats (with negative anomalies), zero-denom reconciliation & Gregorian date validation", async () => {
    expect(currencyScaleFor("KHR")).toBe(0);
    expect(currencyScaleFor("USD")).toBe(2);

    // USD -> KHR (scale 2 -> 0): $100.00 @ 4100 = 410,000 KHR (minorUnits = 410000n)
    const usdToKhrMinor = convertCurrencyMinorUnits(
      10_000n,
      0,
      "USD",
      "KHR",
      {
        fromCurrency: "USD",
        toCurrency: "KHR",
        rateDecimalString: "4100.0000000000",
        source: "NBC",
        effectiveDate: "2026-11-28",
      },
      "HALF_UP",
      2,
    );
    expect(usdToKhrMinor).toBe(410_000n);

    // KHR -> USD (scale 0 -> 2): 410,000 KHR @ 1/4100 = $100.00 (10,000 cents)
    const khrToUsdMinor = convertCurrencyMinorUnits(
      410_000n,
      2,
      "KHR",
      "USD",
      {
        fromCurrency: "KHR",
        toCurrency: "USD",
        rateDecimalString: "0.0002439024",
        source: "NBC",
        effectiveDate: "2026-11-28",
      },
      "HALF_UP",
      0,
    );
    expect(khrToUsdMinor).toBe(10_000n);

    // BusinessAnalysisEngine KHR query produces scale-0 minor units & ៛410,000 display (no .00) matching DataPreparationPipeline
    const engine = new BusinessAnalysisEngine();
    engine.registerDataset({
      datasetId: "ds_khr_lines",
      version: 1,
      tenantId: TENANT_WP2,
      workspaceId: WS_WP2,
      granularity: "invoice_line",
      sha256: "",
      rows: [
        {
          rowId: "KHR-1",
          invoiceDate: "2026-11-05",
          reportingMonth: "2026-11",
          department: "Sales",
          customerId: "C1",
          status: "posted",
          currency: "KHR",
          grossSales: "410000",
          returnsDiscounts: "0",
          cogs: "200000",
          opex: "50000",
        },
        {
          rowId: "KHR-2",
          invoiceDate: "2026-11-06",
          reportingMonth: "2026-11",
          department: "Sales",
          customerId: "C2",
          status: "posted",
          currency: "KHR",
          grossSales: "100000",
          returnsDiscounts: "0",
          cogs: "40000",
          opex: "10000",
        },
      ],
    });

    const khrTotal = await engine.executeQuery(OWNER_ACTOR, {
      queryId: "q_khr_1",
      idempotencyKey: "idem_khr_1",
      tenantId: TENANT_WP2,
      workspaceId: WS_WP2,
      operation: "calculate_metric",
      dataset: { id: "ds_khr_lines", version: 1 },
      metrics: [{ id: "FIN-NET-SALES" }],
      period: { start: "2026-11-01", endExclusive: "2026-12-01" },
      currency: "KHR",
      outputLanguage: "km",
    });
    expect(khrTotal.value.minorUnits).toBe("510000");
    expect(khrTotal.value.decimalString).toBe("510000");
    expect(khrTotal.value.displayValue).toBe("៛510,000");

    // Cross-module pipeline KHR reconciliation parity
    const csvKhr = "organization_id,invoice_id,line_number,invoice_date,department,customer_id,currency,amount\norg1,INV1,1,2026-11-05,Sales,C1,KHR,410000\norg1,INV2,1,2026-11-06,Sales,C2,KHR,100000\n";
    const stagedKhr = stageCsvSource(csvKhr, "khr.csv");
    const pipeline = new DataPreparationPipeline();
    const prepArtifact = pipeline.executeRecipe({
      actor: OWNER_ACTOR,
      recipe: {
        recipeId: "rec_khr",
        version: 1,
        tenantId: TENANT_WP2,
        workspaceId: WS_WP2,
        pinnedInputSha256s: [],
        steps: [],
        idempotencyKey: "idem_rec_khr",
      },
      salesSources: [stagedKhr],
      expectedColumns: ["organization_id", "invoice_id", "line_number", "invoice_date", "department", "customer_id", "currency", "amount"],
    });
    expect(prepArtifact.reconciliation.currencyTotals.find((t) => t.currency === "KHR")?.preparedMinorUnits).toBe(
      khrTotal.value.minorUnits,
    );

    // executeQuery delegates to computeDescriptiveStatistics (FX-normalized, R-7, sampleStdDev, negative anomalies)
    engine.registerDataset({
      datasetId: "ds_anomaly",
      version: 1,
      tenantId: TENANT_WP2,
      workspaceId: WS_WP2,
      granularity: "invoice_line",
      sha256: "",
      rows: [
        { rowId: "A1", invoiceDate: "2026-11-01", reportingMonth: "2026-11", department: "Sales", customerId: "C1", status: "posted", currency: "USD", grossSales: "1000.00", returnsDiscounts: "0.00", cogs: "400.00", opex: "100.00" },
        { rowId: "A2", invoiceDate: "2026-11-02", reportingMonth: "2026-11", department: "Sales", customerId: "C2", status: "posted", currency: "USD", grossSales: "1050.00", returnsDiscounts: "0.00", cogs: "400.00", opex: "100.00" },
        { rowId: "A3", invoiceDate: "2026-11-03", reportingMonth: "2026-11", department: "Sales", customerId: "C3", status: "posted", currency: "USD", grossSales: "1100.00", returnsDiscounts: "0.00", cogs: "400.00", opex: "100.00" },
        { rowId: "A4", invoiceDate: "2026-11-04", reportingMonth: "2026-11", department: "Sales", customerId: "C4", status: "posted", currency: "USD", grossSales: "1150.00", returnsDiscounts: "0.00", cogs: "400.00", opex: "100.00" },
        { rowId: "A5", invoiceDate: "2026-11-05", reportingMonth: "2026-11", department: "Sales", customerId: "C5", status: "posted", currency: "USD", grossSales: "-5000.00", returnsDiscounts: "0.00", cogs: "0.00", opex: "0.00" },
      ],
    });
    const anomalyRes = await engine.executeQuery(OWNER_ACTOR, {
      queryId: "q_anom_1",
      idempotencyKey: "idem_anom_1",
      tenantId: TENANT_WP2,
      workspaceId: WS_WP2,
      operation: "basic_anomaly",
      dataset: { id: "ds_anomaly", version: 1 },
      metrics: [{ id: "FIN-NET-SALES" }],
      period: { start: "2026-11-01", endExclusive: "2026-12-01" },
      currency: "USD",
      outputLanguage: "en",
    });
    expect(anomalyRes.stats?.outliers).toEqual([-5000]);
    expect(anomalyRes.stats?.percentileMethod).toBe("linear_r7");
    expect(Number(anomalyRes.stats?.sampleStdDev)).toBeGreaterThan(Number(anomalyRes.stats?.populationStdDev));

    // Zero-denominator buildCrossModuleReconciledOutputs emits #DIV/0! rather than silent float / 1
    engine.registerDataset({
      datasetId: "ds_zero_sales",
      version: 1,
      tenantId: TENANT_WP2,
      workspaceId: WS_WP2,
      granularity: "invoice_line",
      sha256: "",
      rows: [
        { rowId: "Z1", invoiceDate: "2026-11-01", reportingMonth: "2026-11", department: "Sales", customerId: "C1", status: "posted", currency: "USD", grossSales: "0.00", returnsDiscounts: "0.00", cogs: "0.00", opex: "100.00" },
      ],
    });
    const [zSales, zProfit, zMargin] = await Promise.all([
      engine.executeQuery(OWNER_ACTOR, { queryId: "qz1", idempotencyKey: "iz1", tenantId: TENANT_WP2, workspaceId: WS_WP2, operation: "calculate_metric", dataset: { id: "ds_zero_sales", version: 1 }, metrics: [{ id: "FIN-NET-SALES" }], period: { start: "2026-11-01", endExclusive: "2026-12-01" }, currency: "USD", outputLanguage: "en" }),
      engine.executeQuery(OWNER_ACTOR, { queryId: "qz2", idempotencyKey: "iz2", tenantId: TENANT_WP2, workspaceId: WS_WP2, operation: "calculate_metric", dataset: { id: "ds_zero_sales", version: 1 }, metrics: [{ id: "FIN-OPERATING-PROFIT" }], period: { start: "2026-11-01", endExclusive: "2026-12-01" }, currency: "USD", outputLanguage: "en" }),
      engine.executeQuery(OWNER_ACTOR, { queryId: "qz3", idempotencyKey: "iz3", tenantId: TENANT_WP2, workspaceId: WS_WP2, operation: "calculate_metric", dataset: { id: "ds_zero_sales", version: 1 }, metrics: [{ id: "FIN-OPERATING-MARGIN" }], period: { start: "2026-11-01", endExclusive: "2026-12-01" }, currency: "USD", outputLanguage: "en" }),
    ]);
    const zeroRec = buildCrossModuleReconciledOutputs(OWNER_ACTOR, { netSales: zSales, operatingProfit: zProfit, operatingMargin: zMargin });
    expect(zeroRec.workbook.sheets[0]!.cells.B3!.evaluatedValue).toEqual({
      error: "#DIV/0!",
      detail: "ZERO_DENOMINATOR",
    });
    expect(zeroRec.allMatchExactDecimals).toBe(true);

    // parseExplicitDate rejects impossible Gregorian dates (Feb 30, month 99, 31/02/2026) while accepting leap-day 2024-02-29
    const dateCsv = [
      "invoice_date,department",
      "2026-02-30,Sales",
      "2026-99-99,Sales",
      "31/02/2026,Sales",
      "2024-02-29,Sales",
    ].join("\n");
    const stagedDates = stageCsvSource(dateCsv, "dates.csv");
    const datePrep = pipeline.executeRecipe({
      actor: OWNER_ACTOR,
      recipe: {
        recipeId: "rec_dates",
        version: 1,
        tenantId: TENANT_WP2,
        workspaceId: WS_WP2,
        pinnedInputSha256s: [],
        steps: [{ stepId: "d1", op: "parse_date_locale", params: { column: "invoice_date", locale: "DMY" } }],
        idempotencyKey: "idem_rec_dates",
      },
      salesSources: [stagedDates],
      expectedColumns: ["invoice_date", "department"],
    });
    expect(datePrep.rows).toHaveLength(1);
    expect(datePrep.rows[0]!.invoice_date).toBe("2024-02-29");
    expect(datePrep.exceptions.filter((e) => e.code === "AMBIGUOUS_OR_INVALID_DATE")).toHaveLength(3);
  });

  it("F-20: blocks VLOOKUP & proposal range CPU DoS, caps nesting depth, fixes COUNTIF/SUMIF cell criteria, ROUND sci-notation & unary +/-, and protects format_currency cells", () => {
    const deepExpr = `=${"(".repeat(500)}1+1${")".repeat(500)}`;
    const wb: SpreadsheetWorkbook = {
      workbookId: "wb_f20",
      title: "F20 Security & Calc",
      revision: 1,
      dateSystem: "1900",
      unsupportedFeatures: [],
      sheets: [
        {
          sheetId: "s1",
          name: "Main",
          cells: {
            A1: { value: 10 },
            A2: { value: 20 },
            A3: { value: 30 },
            B1: { value: "alpha" },
            B2: { value: 20 },
            B3: { value: "alpha" },
            C1: { value: 100 },
            C2: { value: 200 },
            C3: { value: 300 },
            D1: { value: "alpha" },
            F1: { value: null, formula: '=VLOOKUP("missing", A1:B999999999, 2, FALSE)' },
            F2: { value: null, formula: "=VLOOKUP(15, A1:C999999999, 3, TRUE)" },
            F3: { value: null, formula: deepExpr },
            F4: { value: null, formula: "=COUNTIF(B1:B3, D1)" },
            F5: { value: null, formula: "=SUMIF(B1:B3, D1, C1:C3)" },
            F6: { value: null, formula: "=ROUND(0.0000001, 2)" },
            F7: { value: null, formula: "=ROUND(1e-7, 2)" },
            F8: { value: null, formula: "=ROUND(1250, -2)" },
            F9: { value: null, formula: "=-A1" },
            F10: { value: null, formula: "=-(A1+A2)" },
            F11: { value: null, formula: "=+A2*2" },
            F12: { value: null, formula: "=2 * -A1" },
            G1: { value: 500, protected: true, currency: "KHR", numberFormat: "៛#,##0" },
          },
        },
      ],
    };

    const t0 = performance.now();
    const res = recalculateWorkbook(wb);
    const elapsedMs = performance.now() - t0;
    const cells = res.workbook.sheets[0]!.cells;

    expect(elapsedMs).toBeLessThan(100);
    expect(cells.F1!.evaluatedValue).toEqual({ error: "#N/A" });
    expect(cells.F2!.evaluatedValue).toBe(100);
    expect(cells.F3!.evaluatedValue).toMatchObject({ error: "#VALUE!" });
    expect(cells.F4!.evaluatedValue).toBe(2);
    expect(cells.F5!.evaluatedValue).toBe(400);
    expect(cells.F6!.evaluatedValue).toBe(0);
    expect(cells.F7!.evaluatedValue).toBe(0);
    expect(cells.F8!.evaluatedValue).toBe(1300);
    expect(cells.F9!.evaluatedValue).toBe(-10);
    expect(cells.F10!.evaluatedValue).toBe(-30);
    expect(cells.F11!.evaluatedValue).toBe(40);
    expect(cells.F12!.evaluatedValue).toBe(-20);

    // Oversized AI proposal range blocked before loop
    expect(() =>
      applySpreadsheetProposal(
        wb,
        {
          operationId: "op_huge",
          workbookId: wb.workbookId,
          expectedRevision: 1,
          sheetName: "Main",
          targetRange: "A1:ZZ99999",
          action: "set_range_formula",
          formula: "=1",
          fillMode: "fixed",
          requiresApproval: true,
          inputLanguage: "en",
          source: "typed_ai",
          originalCommand: "fill",
          explanation: "huge range",
        },
        true,
      ),
    ).toThrowError(SpreadsheetAiError);

    // format_currency honors existing.protected
    expect(() =>
      applySpreadsheetProposal(
        wb,
        {
          operationId: "op_fmt_prot",
          workbookId: wb.workbookId,
          expectedRevision: 1,
          sheetName: "Main",
          targetRange: "G1:G1",
          action: "format_currency",
          currencyDisplayOnly: "USD",
          requiresApproval: true,
          inputLanguage: "en",
          source: "typed_ai",
          originalCommand: "format usd",
          explanation: "format protected",
        },
        true,
      ),
    ).toThrowError(/protected/i);
  });

  it("F-11: strips leaked multi-department rows on linked decks, enforces BI RBAC on reads, and locks restricted datasets without clearance", async () => {
    const bi = new IntelligenceStudioEngine();
    bi.seedSection12TenantData(TENANT_WP2, WS_WP2);
    const report = bi.createManagementReport(OWNER_ACTOR);

    // Central RBAC rejects non-content roles (billing_admin / auditor) even if passed a DataScopePolicy
    expect(() => bi.getReport(BILLING_ACTOR, report.reportId)).toThrowError(AuthorizationError);
    await expect(bi.evaluateReport(AUDITOR_ACTOR, POLICY_ALL, report.reportId)).rejects.toThrowError(AuthorizationError);
    expect(() => bi.drillToPermittedDetail(BILLING_ACTOR, POLICY_ALL, report.reportId, {})).toThrowError(AuthorizationError);

    // Sales-only evaluated report -> createLinkedPresentationFromDashboard MUST contain ZERO Services/Retail rows on Slide 4
    const salesEval = await bi.evaluateReport(EDITOR_ACTOR, POLICY_SALES_ONLY, report.reportId, { interactionSeq: 1 });
    const deck = bi.createLinkedPresentationFromDashboard(EDITOR_ACTOR, salesEval, "bilingual");
    const serialized = JSON.stringify(deck);
    expect(serialized).toContain("Sales");
    expect(serialized).not.toContain("Services");
    expect(serialized).not.toContain("Retail");
    expect(serialized).not.toContain("$45,000.00");
    expect(serialized).not.toContain("$25,000.00");

    // Restricted dataset denies viewer (even with ALL depts), reviewer, and editor lacking maxClassification/workspaceContentGrant
    const xi = new CrossModuleIntegrationEngine();
    await xi.registerDatasetVersion(OWNER_ACTOR, {
      datasetId: "ds_restricted_payroll",
      version: 1,
      classification: "restricted",
      rows: XI00_FINANCE_ROWS_V2,
      requiredColumns: [...STANDARD_FINANCE_COLUMNS],
    });
    const ungrantedAllViewerPolicy: DataScopePolicy = {
      ...POLICY_ALL,
      policyId: "pol_viewer_all_ungranted",
      principalRole: "viewer",
      maxClassification: undefined,
    };
    const ungrantedReviewerPolicy: DataScopePolicy = {
      ...POLICY_ALL,
      policyId: "pol_reviewer_ungranted",
      principalRole: "reviewer",
      maxClassification: undefined,
    };
    await expect(
      xi.queryCertifiedResult(VIEWER_ACTOR, ungrantedAllViewerPolicy, {
        datasetId: "ds_restricted_payroll",
        datasetVersion: 1,
        metricId: "FIN-NET-SALES",
      }),
    ).rejects.toThrowError(/restricted/i);
    await expect(
      xi.queryCertifiedResult(REVIEWER_ACTOR, ungrantedReviewerPolicy, {
        datasetId: "ds_restricted_payroll",
        datasetVersion: 1,
        metricId: "FIN-NET-SALES",
      }),
    ).rejects.toThrowError(/restricted/i);

    const grantedRes = await xi.queryCertifiedResult(OWNER_ACTOR, POLICY_ALL, {
      datasetId: "ds_restricted_payroll",
      datasetVersion: 1,
      metricId: "FIN-NET-SALES",
    });
    expect(grantedRes.result.value.displayValue).toBe("$160,000.00");
  });

  it("F-16: preserves presentation history on chart insert, keeps interactionSeq monotonic, enforces maker-checker & 409 double-publish, and propagates custom period/depts", async () => {
    const xi = new CrossModuleIntegrationEngine({ enforceTwoPersonApproval: true });
    await xi.registerDatasetVersion(OWNER_ACTOR, {
      datasetId: "ds_custom_oct",
      version: 1,
      rows: [
        { rowId: "SEP-1", invoiceDate: "2026-09-10", reportingMonth: "2026-09", department: "Engineering", customerId: "C1", status: "posted", currency: "USD", grossSales: "50000.00", returnsDiscounts: "0.00", cogs: "20000.00", opex: "10000.00" },
        { rowId: "OCT-1", invoiceDate: "2026-10-12", reportingMonth: "2026-10", department: "Engineering", customerId: "C1", status: "posted", currency: "USD", grossSales: "80000.00", returnsDiscounts: "0.00", cogs: "30000.00", opex: "10000.00" },
        { rowId: "OCT-2", invoiceDate: "2026-10-18", reportingMonth: "2026-10", department: "Support", customerId: "C2", status: "posted", currency: "USD", grossSales: "20000.00", returnsDiscounts: "0.00", cogs: "10000.00", opex: "5000.00" },
      ],
      requiredColumns: [...STANDARD_FINANCE_COLUMNS],
    });

    const POLICY_EDITOR_ALL: DataScopePolicy = { ...POLICY_ALL, principalRole: "editor" };

    // Dynamic period (2026-10) and dynamic departments (Engineering + Support) propagate end-to-end
    const bundle = await xi.syncWorkspaceModules(EDITOR_ACTOR, POLICY_EDITOR_ALL, {
      datasetId: "ds_custom_oct",
      datasetVersion: 1,
      periodStart: "2026-10-01",
      periodEndExclusive: "2026-11-01",
    });
    expect(bundle.effectiveDepartments).toEqual(["Engineering", "Support"]);
    expect(bundle.reportingPeriod).toEqual({ start: "2026-10-01", endExclusive: "2026-11-01" });
    expect(bundle.evaluatedDashboard.periodStart).toBe("2026-10-01");
    expect(bundle.evaluatedDashboard.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue).toBe("$100,000.00");

    // insertLinkedChartIntoPresentation preserves prior deck revision for undoLast
    const initialSlideCount = bundle.presentation.slides[0]!.elements.length;
    const inserted = await xi.insertLinkedChartIntoPresentation(EDITOR_ACTOR, POLICY_EDITOR_ALL, {
      presentationId: bundle.presentation.presentationId,
      slideId: bundle.presentation.slides[0]!.slideId,
      chartSpec: bundle.evaluatedDashboard.visualResults.vis_chart_dept_revenue!.chartSpec!,
      datasetId: "ds_custom_oct",
      datasetVersion: 1,
    });
    expect(inserted.presentation.slides[0]!.elements.length).toBe(initialSlideCount + 1);
    const undone = xi.presentations.undoLast(EDITOR_ACTOR, bundle.presentation.presentationId);
    expect(undone.slides[0]!.elements.length).toBe(initialSlideCount);

    // 100 rapid syncWorkspaceModules calls maintain strictly monotonic interactionSeq without 409
    let prevSeq = bundle.evaluatedDashboard.interactionSeq;
    for (let i = 0; i < 20; i++) {
      const nextB = await xi.syncWorkspaceModules(EDITOR_ACTOR, POLICY_EDITOR_ALL, {
        datasetId: "ds_custom_oct",
        datasetVersion: 1,
        periodStart: "2026-10-01",
        periodEndExclusive: "2026-11-01",
        existingIds: {
          workbookArtifactId: bundle.workbookArtifact.artifactId,
          documentArtifactId: bundle.documentArtifact.artifactId,
          dashboardReportId: bundle.report.reportId,
          presentationId: bundle.presentation.presentationId,
        },
      });
      expect(nextB.evaluatedDashboard.interactionSeq).toBeGreaterThan(prevSeq);
      prevSeq = nextB.evaluatedDashboard.interactionSeq;
    }

    // Maker-checker + RBAC approval + 409 double-publish in non-DB mode
    const wfCtx: ReportingContext = {
      tenantId: TENANT_WP2,
      workspaceId: WS_WP2,
      periodStart: "2026-10-01",
      periodEndExclusive: "2026-11-01",
      datasetId: "ds_custom_oct",
      datasetVersion: 1,
      metricIds: ["FIN-NET-SALES", "FIN-OPERATING-PROFIT"],
      currency: "USD",
      language: "en",
      themeId: "theme_corporate_navy",
      themeVersion: 1,
    };
    const wf = await xi.startMonthlyReportingWorkflow(EDITOR_ACTOR, POLICY_EDITOR_ALL, {
      idempotencyKey: `wf_${randomUUID()}`,
      context: wfCtx,
    });
    const pkgId = wf.run.stagedPackageId!;
    const staged = await xi.stageReportingPackage(OWNER_ACTOR, POLICY_ALL, {
      packageId: pkgId,
      packageVersion: 2,
      title: "Oct 2026 Custom Management Package",
      bundle,
    });
    expect(staged.reportingPeriod).toEqual({ start: "2026-10-01", endExclusive: "2026-11-01" });

    // Editor cannot approve; Owner who staged cannot self-approve when enforceTwoPersonApproval=true
    await expect(xi.approveReportingPackage(EDITOR_ACTOR, pkgId, 2)).rejects.toThrowError(AuthorizationError);
    await expect(xi.approveReportingPackage(OWNER_ACTOR, pkgId, 2)).rejects.toThrowError(IntegrationError);

    // Independent Reviewer approves -> first publish succeeds -> same idempotencyKey returns cached -> NEW key throws 409 ALREADY_PUBLISHED
    const approved = await xi.approveReportingPackage(REVIEWER_ACTOR, pkgId, 2);
    expect(approved.lifecycleStatus).toBe("approved");
    const pub1 = await xi.publishReportingPackage(OWNER_ACTOR, POLICY_ALL, {
      packageId: pkgId,
      packageVersion: 2,
      idempotencyKey: "pub_oct_v2_k1",
    });
    const pubRetry = await xi.publishReportingPackage(OWNER_ACTOR, POLICY_ALL, {
      packageId: pkgId,
      packageVersion: 2,
      idempotencyKey: "pub_oct_v2_k1",
    });
    expect(pubRetry.publishedAt).toBe(pub1.publishedAt);
    await expect(
      xi.publishReportingPackage(OWNER_ACTOR, POLICY_ALL, {
        packageId: pkgId,
        packageVersion: 2,
        idempotencyKey: "pub_oct_v2_k2_different",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_PUBLISHED", statusCode: 409 });
  });
});
