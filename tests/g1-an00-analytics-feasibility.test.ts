import { describe, expect, it } from "vitest";
import type { ActorContext, AnalyticalQuery } from "@ai-office-suite/shared-contracts";
import { AuthorizationError } from "@ai-office-suite/authorization";
import { recalculateWorkbook } from "@ai-office-suite/calculation-engine";
import {
  AnalyticsError,
  benchmarkAnalyticsDuckDb,
  buildCrossModuleReconciledOutputs,
  BusinessAnalysisEngine,
  DEFAULT_FINANCIAL_PRECISION_POLICY,
  divideExactScaled,
  evaluatePrecisionApproaches,
  parseDecimalToMinorUnits,
  planAnalyticalCommand,
  type AnalyticalBudgetRow,
  type AnalyticalFinanceRow,
} from "@ai-office-suite/analytics-engine";

const ACTOR_A: ActorContext = {
  tenantId: "tenant_alpha",
  workspaceId: "ws_hq",
  userId: "user_finance_mgr",
  role: "editor",
};

const ACTOR_B: ActorContext = {
  tenantId: "tenant_beta",
  workspaceId: "ws_branch",
  userId: "user_other_tenant",
  role: "owner",
};

/**
 * Independently specified Golden Reference Dataset (FR-05 §26):
 * November 2026:
 *   - Dept A (C001, C002): GrossSales = 104,000 - Returns 4,000 = NetSales 100,000;
 *     COGS = 58,000; OpEx = 12,000 -> GrossProfit 42,000, OperatingProfit 30,000 (30.00%).
 *   - Dept B (C002 shared customer!, C003): GrossSales = 52,000 - Returns 2,000 = NetSales 50,000;
 *     COGS = 32,000; OpEx = 8,000 -> GrossProfit 18,000, OperatingProfit 10,000 (20.00%).
 *   - Combined Nov Totals:
 *       Net Sales         = $150,000.00
 *       COGS              = $90,000.00
 *       Gross Profit      = $60,000.00
 *       OpEx              = $20,000.00
 *       Total Costs       = $110,000.00
 *       Operating Profit  = $40,000.00
 *       Gross Margin      = 40.00%
 *       Operating Margin  = 26.67%  (NOT 25.00% simple average of 30% and 20%!)
 *       Distinct Customers = 3 (C001, C002, C003 — C002 appears in both A & B!)
 * October 2026 (Prior Month):
 *   - Net Sales = $125,000.00 -> Nov YoM Growth = ($150k - $125k) / $125k = 20.00%
 * Fiscal YTD (FY starts April 2026):
 *   - Apr 2026 row ($25,000) + Oct 2026 ($125,000) + Nov 2026 ($150,000) = $300,000.00
 *   - Excluded Mar 2026 row ($10,000 belongs to prior FY) & Voided Nov row ($99,999).
 */
const GOLDEN_FINANCE_ROWS: AnalyticalFinanceRow[] = [
  // Prior fiscal year (March 2026 — must be excluded from FY starting April 2026)
  {
    rowId: "ROW-MAR-FY25",
    invoiceDate: "2026-03-20",
    reportingMonth: "2026-03",
    department: "Dept A",
    customerId: "C001",
    status: "posted",
    currency: "USD",
    grossSales: "10000.00",
    returnsDiscounts: "0.00",
    cogs: "6000.00",
    opex: "1000.00",
  },
  // Early FY26 (April 2026)
  {
    rowId: "ROW-APR-01",
    invoiceDate: "2026-04-15",
    reportingMonth: "2026-04",
    department: "Dept A",
    customerId: "C001",
    status: "posted",
    currency: "USD",
    grossSales: "25000.00",
    returnsDiscounts: "0.00",
    cogs: "15000.00",
    opex: "5000.00",
  },
  // October 2026 ($125,000 Net Sales)
  {
    rowId: "ROW-OCT-01",
    invoiceDate: "2026-10-12",
    reportingMonth: "2026-10",
    department: "Dept A",
    customerId: "C001",
    status: "posted",
    currency: "USD",
    grossSales: "80000.00",
    returnsDiscounts: "5000.00",
    cogs: "45000.00",
    opex: "10000.00",
  },
  {
    rowId: "ROW-OCT-02",
    invoiceDate: "2026-10-25",
    reportingMonth: "2026-10",
    department: "Dept B",
    customerId: "C003",
    status: "posted",
    currency: "USD",
    grossSales: "52000.00",
    returnsDiscounts: "2000.00",
    cogs: "30000.00",
    opex: "7000.00",
  },
  // November 2026 Dept A (two invoice lines totaling $100,000 Net Sales, $58,000 COGS, $12,000 OpEx)
  {
    rowId: "ROW-NOV-A1",
    invoiceDate: "2026-11-05",
    reportingMonth: "2026-11",
    department: "Dept A",
    customerId: "C001",
    status: "posted",
    currency: "USD",
    grossSales: "62000.00",
    returnsDiscounts: "2000.00",
    cogs: "35000.00",
    opex: "7000.00",
  },
  {
    rowId: "ROW-NOV-A2",
    invoiceDate: "2026-11-14",
    reportingMonth: "2026-11",
    department: "Dept A",
    customerId: "C002",
    status: "posted",
    currency: "USD",
    grossSales: "42000.00",
    returnsDiscounts: "2000.00",
    cogs: "23000.00",
    opex: "5000.00",
  },
  // November 2026 Dept B (two invoice lines totaling $50,000 Net Sales, $32,000 COGS, $8,000 OpEx; C002 shared!)
  {
    rowId: "ROW-NOV-B1",
    invoiceDate: "2026-11-18",
    reportingMonth: "2026-11",
    department: "Dept B",
    customerId: "C002",
    status: "posted",
    currency: "USD",
    grossSales: "31000.00",
    returnsDiscounts: "1000.00",
    cogs: "20000.00",
    opex: "5000.00",
  },
  {
    rowId: "ROW-NOV-B2",
    invoiceDate: "2026-11-24",
    reportingMonth: "2026-11",
    department: "Dept B",
    customerId: "C003",
    status: "posted",
    currency: "USD",
    grossSales: "21000.00",
    returnsDiscounts: "1000.00",
    cogs: "12000.00",
    opex: "3000.00",
  },
  // Voided transaction in Nov (MUST be excluded by inclusion rules)
  {
    rowId: "ROW-NOV-VOID",
    invoiceDate: "2026-11-28",
    reportingMonth: "2026-11",
    department: "Dept A",
    customerId: "C999",
    status: "voided",
    currency: "USD",
    grossSales: "99999.00",
    returnsDiscounts: "0.00",
    cogs: "0.00",
    opex: "0.00",
  },
];

// Budget at department_month_budget granularity (FR-05 §11: Rev $140k -> +$10k fav, Costs $100k -> +$10k unfav, Profit $40k -> $0)
const GOLDEN_BUDGET_ROWS: AnalyticalBudgetRow[] = [
  { reportingMonth: "2026-11", department: "Dept A", currency: "USD", budgetCategory: "revenue", budgetAmount: "90000.00" },
  { reportingMonth: "2026-11", department: "Dept B", currency: "USD", budgetCategory: "revenue", budgetAmount: "50000.00" },
  { reportingMonth: "2026-11", department: "Dept A", currency: "USD", budgetCategory: "costs", budgetAmount: "65000.00" },
  { reportingMonth: "2026-11", department: "Dept B", currency: "USD", budgetCategory: "costs", budgetAmount: "35000.00" },
  { reportingMonth: "2026-11", department: "Dept A", currency: "USD", budgetCategory: "operating_profit", budgetAmount: "25000.00" },
  { reportingMonth: "2026-11", department: "Dept B", currency: "USD", budgetCategory: "operating_profit", budgetAmount: "15000.00" },
];

function createSeededEngine(): BusinessAnalysisEngine {
  const engine = new BusinessAnalysisEngine();
  engine.registerDataset({
    datasetId: "ds_golden_finance",
    version: 1,
    tenantId: ACTOR_A.tenantId,
    workspaceId: ACTOR_A.workspaceId,
    granularity: "invoice_line",
    sha256: "",
    rows: GOLDEN_FINANCE_ROWS,
  });
  engine.registerDataset({
    datasetId: "ds_golden_budget",
    version: 1,
    tenantId: ACTOR_A.tenantId,
    workspaceId: ACTOR_A.workspaceId,
    granularity: "department_month_budget",
    sha256: "",
    rows: GOLDEN_BUDGET_ROWS,
  });
  return engine;
}

function makeNovQuery(metricId: string, overrides: Partial<AnalyticalQuery> = {}): AnalyticalQuery {
  return {
    queryId: `q_${metricId}_${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `idem_${metricId}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: ACTOR_A.tenantId,
    workspaceId: ACTOR_A.workspaceId,
    operation: "calculate_metric",
    dataset: { id: "ds_golden_finance", version: 1 },
    metrics: [{ id: metricId }],
    period: { start: "2026-11-01", endExclusive: "2026-12-01" },
    comparison: "none",
    currency: "USD",
    outputLanguage: "en",
    ...overrides,
  };
}

describe("FR-05 AN-00 — Business Analysis Engine Feasibility (ANA-T01 .. ANA-T18)", () => {
  it("verifies Golden Reference Dataset metrics + input-order invariance (ANA-T01, T02, T03, T04)", async () => {
    const engine = createSeededEngine();

    // Register shuffled copy of November/FY rows to verify permutation invariance
    engine.registerDataset({
      datasetId: "ds_golden_shuffled",
      version: 1,
      tenantId: ACTOR_A.tenantId,
      workspaceId: ACTOR_A.workspaceId,
      granularity: "invoice_line",
      sha256: "",
      rows: [...GOLDEN_FINANCE_ROWS].reverse(),
    });

    // ANA-T01: Reference financial figures ($150k Net Sales, $90k COGS, $60k Gross Profit, $20k OpEx, $40k Operating Profit, 40.00% GM, 20.00% Growth)
    const netSales = await engine.executeQuery(ACTOR_A, makeNovQuery("FIN-NET-SALES"));
    const cogs = await engine.executeQuery(ACTOR_A, makeNovQuery("FIN-COGS"));
    const grossProfit = await engine.executeQuery(ACTOR_A, makeNovQuery("FIN-GROSS-PROFIT"));
    const opex = await engine.executeQuery(ACTOR_A, makeNovQuery("FIN-OPEX"));
    const opProfit = await engine.executeQuery(ACTOR_A, makeNovQuery("FIN-OPERATING-PROFIT"));
    const grossMargin = await engine.executeQuery(ACTOR_A, makeNovQuery("FIN-GROSS-MARGIN"));
    const revGrowth = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-REVENUE-GROWTH", { comparison: "previous_month" }),
    );
    const shuffledOpProfit = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-OPERATING-PROFIT", { dataset: { id: "ds_golden_shuffled", version: 1 } }),
    );

    expect(netSales.value.displayValue).toBe("$150,000.00");
    expect(cogs.value.displayValue).toBe("$90,000.00");
    expect(grossProfit.value.displayValue).toBe("$60,000.00");
    expect(opex.value.displayValue).toBe("$20,000.00");
    expect(opProfit.value.displayValue).toBe("$40,000.00");
    expect(grossMargin.value.displayValue).toBe("40.00%");
    expect(revGrowth.value.displayValue).toBe("20.00%");
    expect(shuffledOpProfit.value.minorUnits).toBe(opProfit.value.minorUnits);

    // ANA-T02: Departmental profit margins aggregate via combined totals (26.67%, NOT naive average 25%)
    const opMarginByDept = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-OPERATING-MARGIN", {
        operation: "group_by_dimension",
        groupBy: ["department"],
      }),
    );
    expect(opMarginByDept.value.displayValue).toBe("26.67%");
    expect(opMarginByDept.breakdown?.map((b) => [b.dimensionValues.department, b.value.displayValue])).toEqual([
      ["Dept A", "30.00%"],
      ["Dept B", "20.00%"],
    ]);

    // ANA-T03: Zero denominator returns explicit unavailable result (never 0 or Infinity)
    const zeroDenom = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-OPERATING-MARGIN", {
        period: { start: "2027-01-01", endExclusive: "2027-02-01" },
      }),
    );
    expect(zeroDenom.value.status).toBe("unavailable");
    expect(zeroDenom.value.unavailableReason).toBe("ZERO_DENOMINATOR");

    // ANA-T04: Distinct customer count across departments avoids double counting (C002 shared across A & B => global 3, not 2+2=4)
    const distinctCustomers = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-DISTINCT-CUSTOMERS", {
        operation: "distinct_count",
        groupBy: ["department"],
      }),
    );
    expect(distinctCustomers.value.displayValue).toBe("3");
    expect(distinctCustomers.breakdown?.map((b) => [b.dimensionValues.department, b.value.displayValue])).toEqual([
      ["Dept A", "2"],
      ["Dept B", "2"],
    ]);
  });

  it("enforces granularity alignment, fiscal calendars, partial warnings, multi-currency, rounding, and missing amounts (ANA-T05 .. ANA-T10)", async () => {
    const engine = createSeededEngine();

    // ANA-T05: Budget vs Actual with multiple invoice lines per dept-month — zero budget multiplication
    const budgetVsActual = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-BUDGET-VARIANCE", {
        operation: "budget_vs_actual",
        budgetDataset: { id: "ds_golden_budget", version: 1 },
      }),
    );
    expect(budgetVsActual.value.displayValue).toBe("$0.00");
    expect(budgetVsActual.value.varianceAssessment).toBe("on_budget");
    const revRow = budgetVsActual.breakdown?.find((b) => b.dimensionValues.category === "revenue");
    const costRow = budgetVsActual.breakdown?.find((b) => b.dimensionValues.category === "total_costs");
    expect(revRow?.value.displayValue).toBe("$10,000.00");
    expect(revRow?.value.varianceAssessment).toBe("favorable");
    expect(costRow?.value.displayValue).toBe("$10,000.00");
    expect(costRow?.value.varianceAssessment).toBe("unfavorable");

    // ANA-T06: Fiscal Year-To-Date boundaries (FY starting month 4 excludes March 2026 row)
    const fyYtd = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-NET-SALES", {
        comparison: "ytd",
        period: { start: "2026-11-01", endExclusive: "2026-12-01", fiscalYearStartMonth: 4 },
      }),
    );
    expect(fyYtd.value.displayValue).toBe("$300,000.00");
    expect(fyYtd.provenance.reportingPeriod).toBe("2026-04-01..2026-12-01");

    // ANA-T07: Partial-month comparison emits explicit warning rather than silent full-month parity
    const partialMonth = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-REVENUE-GROWTH", {
        comparison: "previous_month",
        period: { start: "2026-11-01", endExclusive: "2026-11-16", isPartialPeriod: true, comparableDaysElapsed: 15, fullPeriodDays: 30 },
      }),
    );
    expect(partialMonth.validationStatus).toBe("warning");
    expect(partialMonth.provenance.warnings.some((w) => w.includes("PARTIAL_PERIOD_COMPARISON"))).toBe(true);

    // ANA-T08: Mixed currency dataset fails closed without explicit conversion specification
    engine.registerDataset({
      datasetId: "ds_multicurrency",
      version: 1,
      tenantId: ACTOR_A.tenantId,
      workspaceId: ACTOR_A.workspaceId,
      granularity: "invoice_line",
      sha256: "",
      rows: [
        {
          rowId: "MC-1",
          invoiceDate: "2026-11-05",
          reportingMonth: "2026-11",
          department: "Sales",
          customerId: "C10",
          status: "posted",
          currency: "KHR",
          grossSales: "41000000.00",
          returnsDiscounts: "0.00",
          cogs: "20500000.00",
          opex: "4100000.00",
        },
      ],
    });
    await expect(
      engine.executeQuery(ACTOR_A, makeNovQuery("FIN-NET-SALES", { dataset: { id: "ds_multicurrency", version: 1 } })),
    ).rejects.toMatchObject({ code: "CURRENCY_CONVERSION_UNDEFINED" });

    // With explicit 10-decimal inverse FX rate (41,000,000 KHR @ 1/4100 = $10,000.00), conversion succeeds
    const converted = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-NET-SALES", {
        dataset: { id: "ds_multicurrency", version: 1 },
        exchangeRate: {
          fromCurrency: "KHR",
          toCurrency: "USD",
          rateDecimalString: "0.0002439024",
          source: "NBC_MID_RATE",
          effectiveDate: "2026-11-05",
        },
      }),
    );
    expect(converted.value.currency).toBe("USD");
    expect(converted.value.displayValue).toBe("$10,000.00");

    // ANA-T09: Financial rounding (HALF_UP vs HALF_EVEN, negative amounts, overflow guard)
    const precisionBench = evaluatePrecisionApproaches();
    expect(precisionBench.ieee754AdditionExample).not.toBe(0.3);
    expect(precisionBench.exactMinorAdditionDisplay).toBe("0.30");
    expect(divideExactScaled(5n, 2000n, 2, "HALF_UP", 100n)).toMatchObject({ decimalString: "0.25" });
    expect(divideExactScaled(25n, 2n, 0, "HALF_UP")).toMatchObject({ decimalString: "13" });
    expect(divideExactScaled(25n, 2n, 0, "HALF_EVEN")).toMatchObject({ decimalString: "12" });
    expect(divideExactScaled(-25n, 2n, 0, "HALF_UP")).toMatchObject({ decimalString: "-13" });
    expect(() =>
      parseDecimalToMinorUnits("999999999999999999999.00", 2, BigInt(DEFAULT_FINANCIAL_PRECISION_POLICY.overflowSafeMaxMinorUnits)),
    ).toThrowError(AnalyticsError);

    // ANA-T10: Missing transaction amount blocks certification instead of silently treating null as 0
    engine.registerDataset({
      datasetId: "ds_missing_amt",
      version: 1,
      tenantId: ACTOR_A.tenantId,
      workspaceId: ACTOR_A.workspaceId,
      granularity: "invoice_line",
      sha256: "",
      rows: [
        {
          rowId: "ROW-BAD-1",
          invoiceDate: "2026-11-10",
          reportingMonth: "2026-11",
          department: "Ops",
          customerId: "C10",
          status: "posted",
          currency: "USD",
          grossSales: null,
          returnsDiscounts: "0.00",
          cogs: "100.00",
          opex: "50.00",
        },
      ],
    });
    const missingResult = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-NET-SALES", { dataset: { id: "ds_missing_amt", version: 1 } }),
    );
    expect(missingResult.validationStatus).toBe("blocked");
    expect(missingResult.validationErrors[0]).toContain("MISSING_REQUIRED_AMOUNT");
  });

  it("enforces metric versioning, EN/KM parity, security, reconciliation, idempotency, and snapshot immutability (ANA-T11 .. ANA-T18)", async () => {
    const engine = createSeededEngine();

    // Compute V1 & publish immutable snapshot first (sets up ANA-T11 & ANA-T18)
    const novNetSales = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-NET-SALES", { idempotencyKey: "pub_nov_2026_net_sales" }),
    );
    const novOpProfit = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-OPERATING-PROFIT", { idempotencyKey: "pub_nov_2026_op_profit" }),
    );
    const novOpMargin = await engine.executeQuery(
      ACTOR_A,
      makeNovQuery("FIN-OPERATING-MARGIN", { idempotencyKey: "pub_nov_2026_op_margin" }),
    );
    const snapshot = engine.publishSnapshot(ACTOR_A, novOpProfit.resultId, "pub_nov_2026_op_profit");

    // ANA-T11 & ANA-T18: Register V2 metric definition — V1 & published historical snapshot remain unchanged
    const v2 = engine.registry.registerMetricVersion("FIN-OPERATING-PROFIT", {
      ...engine.registry.getMetricVersion("FIN-OPERATING-PROFIT", 1).versionSpec,
      effectiveFrom: "2026-12-01",
      formulaExpression: "FIN-NET-SALES - FIN-COGS - FIN-OPEX - BONUS_POOL",
      changeSummary: "V2 adds executive bonus deduction starting Dec 2026",
    });
    expect(v2.version).toBe(2);
    const v1Historical = engine.registry.getMetricVersion("FIN-OPERATING-PROFIT", 1);
    expect(v1Historical.versionSpec.version).toBe(1);
    const reopened = engine.getPublishedSnapshot(ACTOR_A, snapshot.snapshotId);
    expect(reopened.frozenMetricVersion.version).toBe(1);
    expect(reopened.result.value.displayValue).toBe("$40,000.00");
    expect(reopened.result.linkedMetricReference.mode).toBe("published_snapshot");

    // ANA-T12: Equivalent English & Khmer commands resolve to the same approved metric and numerical result
    const enPlan = planAnalyticalCommand({
      tenantId: ACTOR_A.tenantId,
      workspaceId: ACTOR_A.workspaceId,
      datasetId: "ds_golden_finance",
      datasetVersion: 1,
      command: "Compare this month's revenue with previous month",
      inputLanguage: "en",
      periodStart: "2026-11-01",
      periodEndExclusive: "2026-12-01",
    });
    const kmPlan = planAnalyticalCommand({
      tenantId: ACTOR_A.tenantId,
      workspaceId: ACTOR_A.workspaceId,
      datasetId: "ds_golden_finance",
      datasetVersion: 1,
      command: "ប្រៀបធៀបចំណូលខែនេះជាមួយខែមុន",
      inputLanguage: "km",
      periodStart: "2026-11-01",
      periodEndExclusive: "2026-12-01",
    });
    expect(enPlan.clarificationRequired).toBe(false);
    expect(kmPlan.clarificationRequired).toBe(false);
    expect(enPlan.query?.metrics.map((m) => m.id)).toEqual(kmPlan.query?.metrics.map((m) => m.id));
    const enRes = await engine.executeQuery(ACTOR_A, enPlan.query!, { includeAiInterpretation: true });
    const kmRes = await engine.executeQuery(ACTOR_A, kmPlan.query!, { includeAiInterpretation: true });
    expect(enRes.value.minorUnits).toBe(kmRes.value.minorUnits);
    expect(enRes.aiInterpretation?.isObservedFact).toBe(false);

    // ANA-T13: Ambiguous profit instruction requests explicit clarification
    const ambiguous = planAnalyticalCommand({
      tenantId: ACTOR_A.tenantId,
      workspaceId: ACTOR_A.workspaceId,
      datasetId: "ds_golden_finance",
      datasetVersion: 1,
      command: "Calculate profit",
      inputLanguage: "en",
      periodStart: "2026-11-01",
      periodEndExclusive: "2026-12-01",
    });
    expect(ambiguous.clarificationRequired).toBe(true);
    expect(ambiguous.candidateMetricIds).toContain("FIN-OPERATING-PROFIT");

    // ANA-T14: Cross-tenant dataset, cached result, and snapshot access are strictly denied
    await expect(engine.executeQuery(ACTOR_B, makeNovQuery("FIN-NET-SALES"))).rejects.toThrowError(AuthorizationError);
    expect(() => engine.getCachedResult(ACTOR_B, novNetSales.resultId)).toThrowError(AuthorizationError);
    expect(() => engine.getPublishedSnapshot(ACTOR_B, snapshot.snapshotId)).toThrowError(AuthorizationError);

    // ANA-T15: Unsafe SQL / file / code injection blocked fail-closed
    expect(() =>
      planAnalyticalCommand({
        tenantId: ACTOR_A.tenantId,
        workspaceId: ACTOR_A.workspaceId,
        datasetId: "ds_golden_finance",
        datasetVersion: 1,
        command: "Calculate profit; SELECT * FROM read_csv_auto('file:///etc/passwd') --",
        inputLanguage: "en",
        periodStart: "2026-11-01",
        periodEndExclusive: "2026-12-01",
      }),
    ).toThrowError(AnalyticsError);

    // ANA-T16: Cross-module reconciliation (AnalyticalResult + StudioDocument + SpreadsheetWorkbook formula evaluation)
    const reconciled = buildCrossModuleReconciledOutputs(ACTOR_A, {
      netSales: novNetSales,
      operatingProfit: novOpProfit,
      operatingMargin: novOpMargin,
    });
    const recalcedWorkbook = recalculateWorkbook(reconciled.workbook);
    expect(reconciled.allMatchExactDecimals).toBe(true);
    expect(recalcedWorkbook.workbook.sheets[0]!.cells.B3!.evaluatedValue).toBe(26.67);

    // ANA-T17: Transient failure followed by retry using same idempotencyKey produces zero duplicate publications
    const retryQuery = makeNovQuery("FIN-GROSS-MARGIN", { idempotencyKey: "retry_idem_key_01" });
    await expect(
      engine.executeQuery(ACTOR_A, retryQuery, { simulateTransientFailureOnce: true }),
    ).rejects.toMatchObject({ code: "TRANSIENT_JOB_FAILURE" });
    const firstRetrySuccess = await engine.executeQuery(ACTOR_A, retryQuery, { simulateTransientFailureOnce: true });
    const secondRetryCall = await engine.executeQuery(ACTOR_A, retryQuery);
    expect(secondRetryCall.resultId).toBe(firstRetrySuccess.resultId);
    engine.publishSnapshot(ACTOR_A, firstRetrySuccess.resultId, retryQuery.idempotencyKey);
    engine.publishSnapshot(ACTOR_A, secondRetryCall.resultId, retryQuery.idempotencyKey);
    expect(engine.getPublicationCountForKey(ACTOR_A, retryQuery.idempotencyKey)).toBe(1);

    // DuckDB 10k & 50k analytical stress benchmark
    const stress10k = await benchmarkAnalyticsDuckDb(10_000);
    const stress50k = await benchmarkAnalyticsDuckDb(50_000);
    expect(stress10k.rowCount).toBe(10_000);
    expect(stress50k.rowCount).toBe(50_000);
    console.info("AN-00 DuckDB Analytical Stress Benchmark:", JSON.stringify({ stress10k, stress50k, precisionBench: evaluatePrecisionApproaches() }));
  });
});
