import { createHash, randomUUID } from "node:crypto";
import type {
  ActorContext,
  AnalyticalResult,
  ChartSpec,
  DataScopePolicy,
  FilterContext,
  FilterPredicate,
  LinkedMetricReference,
  PublishedBiSnapshot,
  RefreshJobRecord,
  ReportPage,
  StudioPresentation,
  StudioReport,
  VisualSpec,
} from "@ai-office-suite/shared-contracts";
import { assertCanPerform, assertTenantWorkspaceAccess } from "@ai-office-suite/authorization";
import type { AuditStore } from "@ai-office-suite/audit";
import { scanForUnsafeAnalyticalInput } from "@ai-office-suite/validation";
import {
  BusinessAnalysisEngine,
  formatCurrencyOrRatioDisplay,
  parseDecimalToMinorUnits,
  type AnalyticalBudgetRow,
  type AnalyticalFinanceRow,
} from "@ai-office-suite/analytics-engine";
import {
  createGoldenManagementDeck,
  PresentationWorkspaceStore,
} from "@ai-office-suite/presentation-engine";
import { renderChartSpecToSvg } from "./chartAdapters.ts";

export class IntelligenceEngineError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "IntelligenceEngineError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * FR-06 + FR-07 §12 Integrated Golden Management-Reporting Fixture
 * Independently specified totals:
 * - Nov Net Sales: Sales $80,000, Services $45,000, Retail $25,000 => Combined $150,000.00
 * - Oct Net Sales: Sales $70,000, Services $35,000, Retail $20,000 => Combined $125,000.00 (+20.00% growth)
 * - Nov COGS: Sales $50,000, Services $25,000, Retail $15,000 => Combined $90,000.00
 * - Nov OpEx: Sales $10,000, Services $5,000, Retail $5,000 => Combined $20,000.00
 * - Total Costs = $110,000.00; Gross Profit = $60,000.00 (40.00%); Operating Profit = $40,000.00 (26.67%)
 * - Budget Nov Sales = $140,000 ($75k + $40k + $25k) -> +$10,000 favorable
 * - Budget Nov Total Costs = $100,000 ($55k + $28k + $17k) -> +$10,000 unfavorable
 * - Budget Nov Operating Profit = $40,000 ($20k + $12k + $8k) -> $0 on_budget
 */
export const SECTION_12_FINANCE_ROWS: AnalyticalFinanceRow[] = [
  // October 2026
  { rowId: "S12-OCT-SAL", invoiceDate: "2026-10-10", reportingMonth: "2026-10", department: "Sales", customerId: "C1", status: "posted", currency: "USD", grossSales: "70000.00", returnsDiscounts: "0.00", cogs: "42000.00", opex: "10000.00" },
  { rowId: "S12-OCT-SRV", invoiceDate: "2026-10-12", reportingMonth: "2026-10", department: "Services", customerId: "C2", status: "posted", currency: "USD", grossSales: "35000.00", returnsDiscounts: "0.00", cogs: "20000.00", opex: "5000.00" },
  { rowId: "S12-OCT-RET", invoiceDate: "2026-10-18", reportingMonth: "2026-10", department: "Retail", customerId: "C3", status: "posted", currency: "USD", grossSales: "20000.00", returnsDiscounts: "0.00", cogs: "12000.00", opex: "4000.00" },
  // November 2026 — Split Sales across 2 invoice lines to verify distinct count & budget grain!
  { rowId: "S12-NOV-SAL1", invoiceDate: "2026-11-04", reportingMonth: "2026-11", department: "Sales", customerId: "C1", status: "posted", currency: "USD", grossSales: "50000.00", returnsDiscounts: "0.00", cogs: "31000.00", opex: "6000.00" },
  { rowId: "S12-NOV-SAL2", invoiceDate: "2026-11-16", reportingMonth: "2026-11", department: "Sales", customerId: "C2", status: "posted", currency: "USD", grossSales: "30000.00", returnsDiscounts: "0.00", cogs: "19000.00", opex: "4000.00" },
  { rowId: "S12-NOV-SRV1", invoiceDate: "2026-11-08", reportingMonth: "2026-11", department: "Services", customerId: "C2", status: "posted", currency: "USD", grossSales: "25000.00", returnsDiscounts: "0.00", cogs: "14000.00", opex: "3000.00" },
  { rowId: "S12-NOV-SRV2", invoiceDate: "2026-11-21", reportingMonth: "2026-11", department: "Services", customerId: "C3", status: "posted", currency: "USD", grossSales: "20000.00", returnsDiscounts: "0.00", cogs: "11000.00", opex: "2000.00" },
  { rowId: "S12-NOV-RET1", invoiceDate: "2026-11-12", reportingMonth: "2026-11", department: "Retail", customerId: "C3", status: "posted", currency: "USD", grossSales: "25000.00", returnsDiscounts: "0.00", cogs: "15000.00", opex: "5000.00" },
];

export const SECTION_12_BUDGET_ROWS: AnalyticalBudgetRow[] = [
  { reportingMonth: "2026-11", department: "Sales", currency: "USD", budgetCategory: "revenue", budgetAmount: "75000.00" },
  { reportingMonth: "2026-11", department: "Sales", currency: "USD", budgetCategory: "costs", budgetAmount: "55000.00" },
  { reportingMonth: "2026-11", department: "Sales", currency: "USD", budgetCategory: "operating_profit", budgetAmount: "20000.00" },
  { reportingMonth: "2026-11", department: "Services", currency: "USD", budgetCategory: "revenue", budgetAmount: "40000.00" },
  { reportingMonth: "2026-11", department: "Services", currency: "USD", budgetCategory: "costs", budgetAmount: "28000.00" },
  { reportingMonth: "2026-11", department: "Services", currency: "USD", budgetCategory: "operating_profit", budgetAmount: "12000.00" },
  { reportingMonth: "2026-11", department: "Retail", currency: "USD", budgetCategory: "revenue", budgetAmount: "25000.00" },
  { reportingMonth: "2026-11", department: "Retail", currency: "USD", budgetCategory: "costs", budgetAmount: "17000.00" },
  { reportingMonth: "2026-11", department: "Retail", currency: "USD", budgetCategory: "operating_profit", budgetAmount: "8000.00" },
];

export interface EvaluatedVisualResult {
  visualId: string;
  state: VisualSpec["state"];
  metricResults: Record<string, AnalyticalResult>;
  chartSpec?: ChartSpec;
  svg?: string;
  accessibleTableHtml?: string;
  errorDetail?: string;
}

export interface EvaluatedReportResponse {
  report: StudioReport;
  interactionSeq: number;
  effectiveDepartments: string[];
  policyScope: string;
  cacheHit: boolean;
  visualResults: Record<string, EvaluatedVisualResult>;
}

export interface BiOperationPlan {
  planId: string;
  isMockPlanner: true;
  action: "set_department_filter" | "set_chart_type" | "query_metric" | "create_presentation_draft";
  departments?: string[];
  chartKind?: ChartSpec["kind"];
  metricId?: string;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km";
  originalCommand: string;
  explanationEn: string;
  explanationKm: string;
}

const ALL_SECTION_12_DEPARTMENTS = ["Sales", "Services", "Retail"] as const;

export class IntelligenceStudioEngine {
  readonly analytics: BusinessAnalysisEngine;
  readonly presentations: PresentationWorkspaceStore;
  private readonly reports = new Map<string, StudioReport>();
  private readonly snapshots = new Map<string, PublishedBiSnapshot>();
  private readonly revokedPrincipals = new Set<string>();
  private readonly policyResultCache = new Map<string, EvaluatedReportResponse>();
  private readonly refreshJobs = new Map<string, RefreshJobRecord>();
  private readonly latestSeqByReportActor = new Map<string, number>();
  private readonly datasetRowsByManifest = new Map<string, AnalyticalFinanceRow[]>();
  private readonly budgetRowsByManifest = new Map<string, AnalyticalBudgetRow[]>();
  private readonly audit?: AuditStore;

  constructor(analytics = new BusinessAnalysisEngine(), audit?: AuditStore) {
    this.analytics = analytics;
    this.presentations = new PresentationWorkspaceStore(audit);
    this.audit = audit;
  }

  seedSection12TenantData(tenantId: string, workspaceId: string): {
    datasetId: string;
    budgetDatasetId: string;
  } {
    const datasetId = `ds_s12_finance_${tenantId}`;
    const budgetDatasetId = `ds_s12_budget_${tenantId}`;
    this.analytics.registerDataset({
      datasetId,
      version: 1,
      tenantId,
      workspaceId,
      granularity: "invoice_line",
      sha256: createHash("sha256").update(JSON.stringify(SECTION_12_FINANCE_ROWS)).digest("hex"),
      rows: SECTION_12_FINANCE_ROWS,
    });
    this.analytics.registerDataset({
      datasetId: budgetDatasetId,
      version: 1,
      tenantId,
      workspaceId,
      granularity: "department_month_budget",
      sha256: createHash("sha256").update(JSON.stringify(SECTION_12_BUDGET_ROWS)).digest("hex"),
      rows: SECTION_12_BUDGET_ROWS,
    });
    this.datasetRowsByManifest.set(`${tenantId}::${datasetId}::1`, structuredClone(SECTION_12_FINANCE_ROWS));
    this.budgetRowsByManifest.set(`${tenantId}::${budgetDatasetId}::1`, structuredClone(SECTION_12_BUDGET_ROWS));
    return { datasetId, budgetDatasetId };
  }

  registerManifestVersion(
    tenantId: string,
    workspaceId: string,
    datasetId: string,
    version: number,
    rows: AnalyticalFinanceRow[],
  ): void {
    this.analytics.registerDataset({
      datasetId,
      version,
      tenantId,
      workspaceId,
      granularity: "invoice_line",
      sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      rows,
    });
    this.datasetRowsByManifest.set(`${tenantId}::${datasetId}::${version}`, structuredClone(rows));
  }

  createManagementReport(actor: ActorContext, opts?: { title?: string }): StudioReport {
    assertCanPerform(actor, "document", "create");
    const datasetId = `ds_s12_finance_${actor.tenantId}`;
    const pages: ReportPage[] = [
      {
        pageId: "page_overview",
        titleEn: "Executive Management Overview",
        titleKm: "ទិដ្ឋភាពទូទៅនៃការគ្រប់គ្រង",
        order: 1,
        pageFilters: [],
        visuals: [
          {
            visualId: "vis_kpi_net_sales",
            pageId: "page_overview",
            kind: "kpi",
            titleEn: "Net sales revenue",
            titleKm: "ចំណូលលក់សុទ្ធ",
            metricRefs: [{ id: "FIN-NET-SALES" }, { id: "FIN-REVENUE-GROWTH" }],
            gridPosition: { row: 0, col: 0, w: 4, h: 2 },
            visualFilters: [],
            crossFilterTargets: [],
            state: "ready",
          },
          {
            visualId: "vis_kpi_op_profit",
            pageId: "page_overview",
            kind: "kpi",
            titleEn: "Operating profit & margin",
            titleKm: "ប្រាក់ចំណេញប្រតិបត្តិការ និងអត្រា",
            metricRefs: [{ id: "FIN-OPERATING-PROFIT" }, { id: "FIN-OPERATING-MARGIN" }],
            gridPosition: { row: 0, col: 4, w: 4, h: 2 },
            visualFilters: [],
            crossFilterTargets: [],
            state: "ready",
          },
          {
            visualId: "vis_chart_dept_revenue",
            pageId: "page_overview",
            kind: "column",
            titleEn: "Revenue by department",
            titleKm: "ចំណូលតាមផ្នែក",
            metricRefs: [{ id: "FIN-NET-SALES" }],
            groupBy: ["department"],
            gridPosition: { row: 2, col: 0, w: 6, h: 4 },
            visualFilters: [],
            crossFilterTargets: ["vis_chart_budget_vs_actual", "vis_kpi_op_profit"],
            state: "ready",
          },
          {
            visualId: "vis_chart_budget_vs_actual",
            pageId: "page_overview",
            kind: "grouped_bar",
            titleEn: "Revenue versus budget",
            titleKm: "ចំណូលជាក់ស្តែងធៀបនឹងថវិកា",
            metricRefs: [{ id: "FIN-BUDGET-VARIANCE" }],
            groupBy: ["department"],
            gridPosition: { row: 2, col: 6, w: 6, h: 4 },
            visualFilters: [],
            crossFilterTargets: [],
            state: "ready",
          },
          {
            visualId: "vis_line_monthly_rev",
            pageId: "page_overview",
            kind: "line",
            titleEn: "Monthly net sales trend (Oct–Nov 2026)",
            titleKm: "និន្នាការចំណូលប្រចាំខែ (តុលា-វិច្ឆិកា ២០២៦)",
            metricRefs: [{ id: "FIN-NET-SALES" }],
            groupBy: ["reportingMonth"],
            gridPosition: { row: 6, col: 0, w: 6, h: 3 },
            visualFilters: [],
            crossFilterTargets: [],
            state: "ready",
          },
          {
            visualId: "vis_table_dept_summary",
            pageId: "page_overview",
            kind: "table",
            titleEn: "Departmental financial summary",
            titleKm: "តារាងសង្ខេបហិរញ្ញវត្ថុតាមផ្នែក",
            metricRefs: [{ id: "FIN-DISTINCT-CUSTOMERS" }],
            groupBy: ["department"],
            gridPosition: { row: 6, col: 6, w: 6, h: 3 },
            visualFilters: [],
            crossFilterTargets: [],
            state: "ready",
          },
        ],
      },
    ];

    const now = new Date().toISOString();
    const report: StudioReport = {
      reportId: `rep_${randomUUID().slice(0, 8)}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      title: opts?.title ?? "Monthly Management Intelligence Report",
      revision: 1,
      status: "draft",
      semanticModelId: "management-model",
      semanticModelVersion: 1,
      datasetManifestId: datasetId,
      datasetVersion: 1,
      sourceAsOfTimestamp: "2026-11-30T23:59:59.000Z",
      lastSuccessfulRefreshAt: now,
      lastComputedAt: now,
      pages,
    };
    this.reports.set(report.reportId, structuredClone(report));
    return report;
  }

  saveReport(actor: ActorContext, report: StudioReport): StudioReport {
    assertCanPerform(actor, "document", "write");
    assertTenantWorkspaceAccess(actor, report.tenantId, report.workspaceId);
    const next = structuredClone(report);
    next.revision += 1;
    this.reports.set(next.reportId, next);
    return structuredClone(next);
  }

  getReport(actor: ActorContext, reportId: string): StudioReport {
    this.assertNotRevoked(actor);
    const rep = this.reports.get(reportId);
    if (!rep) {
      throw new IntelligenceEngineError(404, "REPORT_NOT_FOUND", `Report '${reportId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, rep.tenantId, rep.workspaceId);
    return structuredClone(rep);
  }

  revokePrincipalAccess(tenantId: string, userId: string): void {
    this.revokedPrincipals.add(`${tenantId}::${userId}`);
  }

  private assertNotRevoked(actor: ActorContext): void {
    if (this.revokedPrincipals.has(`${actor.tenantId}::${actor.userId}`)) {
      throw new IntelligenceEngineError(403, "ACCESS_REVOKED", "User access has been revoked; historical and live retrieval denied.");
    }
  }

  private resolveEffectiveDepartments(
    policy: DataScopePolicy,
    requestedDepartments?: string[],
  ): string[] {
    const allowedSet =
      policy.allowedDepartments === "ALL"
        ? new Set<string>(ALL_SECTION_12_DEPARTMENTS)
        : new Set<string>(policy.allowedDepartments);

    if (!requestedDepartments || requestedDepartments.length === 0) {
      return Array.from(allowedSet);
    }
    const intersection = requestedDepartments.filter((d) => allowedSet.has(d));
    if (intersection.length === 0) {
      // Empty intersection means user requested outside policy scope -> NEVER widen to global "ALL"!
      return [];
    }
    return intersection;
  }

  async evaluateReport(
    actor: ActorContext,
    policy: DataScopePolicy,
    reportId: string,
    opts?: {
      requestedDepartments?: string[];
      periodStart?: string;
      periodEndExclusive?: string;
      chartKindOverride?: Record<string, ChartSpec["kind"]>;
      interactionSeq?: number;
      language?: "en" | "km";
      abortSignal?: AbortSignal;
      simulateInvalidMetric?: boolean;
    },
  ): Promise<EvaluatedReportResponse> {
    this.assertNotRevoked(actor);
    if (policy.tenantId !== actor.tenantId) {
      throw new IntelligenceEngineError(403, "POLICY_TENANT_MISMATCH", "DataScopePolicy tenant mismatch.");
    }
    if (opts?.abortSignal?.aborted) {
      throw new IntelligenceEngineError(499, "QUERY_CANCELLED", "Analytical dashboard query was cancelled.");
    }

    const seqKey = `${reportId}::${actor.userId}`;
    const seq = opts?.interactionSeq ?? 1;
    const prevSeq = this.latestSeqByReportActor.get(seqKey) ?? 0;
    if (seq < prevSeq) {
      throw new IntelligenceEngineError(409, "STALE_INTERACTION_DISCARDED", `Superseded interaction sequence ${seq} < ${prevSeq}.`);
    }
    this.latestSeqByReportActor.set(seqKey, seq);

    const report = this.getReport(actor, reportId);
    const effectiveDepartments = this.resolveEffectiveDepartments(policy, opts?.requestedDepartments);
    const periodStart = opts?.periodStart ?? "2026-11-01";
    const periodEndExclusive = opts?.periodEndExclusive ?? "2026-12-01";
    const lang = opts?.language ?? "en";

    // Policy-keyed cache preventing cross-role cache leaks (BI-T18)
    const cacheKey = [
      actor.tenantId,
      actor.workspaceId,
      policy.policyId,
      policy.policyVersion,
      effectiveDepartments.slice().sort().join(","),
      report.datasetManifestId,
      report.datasetVersion,
      periodStart,
      periodEndExclusive,
      JSON.stringify(opts?.chartKindOverride ?? {}),
      lang,
      Boolean(opts?.simulateInvalidMetric),
    ].join("|");

    const cached = this.policyResultCache.get(cacheKey);
    if (cached && !opts?.chartKindOverride) {
      return { ...structuredClone(cached), interactionSeq: seq, cacheHit: true };
    }

    const baseRows =
      this.datasetRowsByManifest.get(`${actor.tenantId}::${report.datasetManifestId}::${report.datasetVersion}`) ?? [];
    const budgetRows =
      this.budgetRowsByManifest.get(`${actor.tenantId}::ds_s12_budget_${actor.tenantId}::1`) ?? [];

    // Materialize a policy+filter scoped ephemeral view in BusinessAnalysisEngine so all FR-05 precision holds
    const scopedDatasetId = `scoped_${policy.policyId}_${report.reportId}_${seq}`;
    const deptSet = new Set(effectiveDepartments);
    const scopedRows = baseRows.filter((r) => deptSet.has(r.department));
    const scopedBudgetRows = budgetRows.filter((b) => deptSet.has(b.department));

    this.analytics.registerDataset({
      datasetId: scopedDatasetId,
      version: report.datasetVersion,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      granularity: "invoice_line",
      sha256: createHash("sha256").update(JSON.stringify(scopedRows)).digest("hex"),
      rows: scopedRows,
    });
    const scopedBudgetId = `${scopedDatasetId}_budget`;
    this.analytics.registerDataset({
      datasetId: scopedBudgetId,
      version: 1,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      granularity: "department_month_budget",
      sha256: createHash("sha256").update(JSON.stringify(scopedBudgetRows)).digest("hex"),
      rows: scopedBudgetRows,
    });

    const runMetric = async (
      metricId: string,
      extra?: {
        groupBy?: string[];
        comparison?: "none" | "previous_month";
        operation?: "calculate_metric" | "group_by_dimension" | "budget_vs_actual" | "distinct_count";
        pStart?: string;
        pEnd?: string;
      },
    ) =>
      this.analytics.executeQuery(actor, {
        queryId: `bi_q_${randomUUID().slice(0, 8)}`,
        idempotencyKey: `bi_idem_${randomUUID()}`,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        operation: extra?.operation ?? (extra?.groupBy ? "group_by_dimension" : "calculate_metric"),
        dataset: { id: scopedDatasetId, version: report.datasetVersion },
        budgetDataset: extra?.operation === "budget_vs_actual" ? { id: scopedBudgetId, version: 1 } : undefined,
        metrics: [{ id: metricId }],
        period: { start: extra?.pStart ?? periodStart, endExclusive: extra?.pEnd ?? periodEndExclusive },
        comparison: extra?.comparison ?? "none",
        groupBy: extra?.groupBy,
        currency: "USD",
        outputLanguage: lang,
      });

    if (effectiveDepartments.length === 0 || scopedRows.length === 0) {
      const emptyVisuals: Record<string, EvaluatedVisualResult> = {};
      for (const page of report.pages) {
        for (const v of page.visuals) {
          emptyVisuals[v.visualId] = { visualId: v.visualId, state: "empty", metricResults: {} };
        }
      }
      return {
        report,
        interactionSeq: seq,
        effectiveDepartments,
        policyScope: `${policy.policyId}:v${policy.policyVersion}`,
        cacheHit: false,
        visualResults: emptyVisuals,
      };
    }

    const [netSales, revGrowth, opProfit, opMargin, netSalesByDept, budgetVar, distinctCust, netSalesByMonth] =
      await Promise.all([
        runMetric("FIN-NET-SALES"),
        runMetric("FIN-REVENUE-GROWTH", { comparison: "previous_month" }),
        runMetric("FIN-OPERATING-PROFIT"),
        runMetric("FIN-OPERATING-MARGIN"),
        runMetric("FIN-NET-SALES", { groupBy: ["department"] }),
        runMetric("FIN-BUDGET-VARIANCE", { operation: "budget_vs_actual", groupBy: ["department"] }),
        runMetric("FIN-DISTINCT-CUSTOMERS", { operation: "distinct_count", groupBy: ["department"] }),
        runMetric("FIN-NET-SALES", { groupBy: ["reportingMonth"], pStart: "2026-10-01", pEnd: periodEndExclusive }),
      ]);

    const buildBinding = (metricId: string, provenanceId: string) => ({
      datasetId: report.datasetManifestId,
      datasetVersion: report.datasetVersion,
      metricRefs: [{ metricId, version: 1 }],
      reportingPeriod: `${periodStart}..${periodEndExclusive}`,
      filterContext: { departments: effectiveDepartments.join(",") },
      policyScope: `${policy.policyId}:v${policy.policyVersion}`,
      provenanceId,
      freshnessTimestamp: report.lastSuccessfulRefreshAt,
      sourceAsOfTimestamp: report.sourceAsOfTimestamp,
    });

    const deptNames = effectiveDepartments.slice();
    const deptRevenueMap = new Map<string, { val: number; fmt: string }>();
    for (const b of netSalesByDept.breakdown ?? []) {
      deptRevenueMap.set(b.dimensionValues.department!, {
        val: Number(b.value.decimalString ?? "0"),
        fmt: b.value.displayValue,
      });
    }

    const revChartSpec: ChartSpec = {
      chartId: "chart_dept_revenue",
      kind: opts?.chartKindOverride?.vis_chart_dept_revenue ?? "column",
      titleEn: "Revenue by department",
      titleKm: "ចំណូលតាមផ្នែក",
      altSummaryEn: `Net sales revenue across ${deptNames.join(", ")} totals ${netSales.value.displayValue}.`,
      altSummaryKm: `ចំណូលលក់សុទ្ធតាមផ្នែក (${deptNames.join(", ")}) សរុប ${netSales.value.displayValue}។`,
      unit: "currency",
      currency: "USD",
      yAxisStartsAtZero: true,
      categories: deptNames,
      series: [
        {
          seriesId: "actual_net_sales",
          labelEn: "Actual Net Sales",
          labelKm: "ចំណូលលក់សុទ្ធជាក់ស្តែង",
          classification: "actual",
          unit: "currency",
          currency: "USD",
          values: deptNames.map((d) => {
            const entry = deptRevenueMap.get(d);
            return {
              category: d,
              value: entry ? entry.val : null,
              formatted: entry ? entry.fmt : "N/A",
              state: entry ? "available" : "missing",
            };
          }),
        },
      ],
      binding: buildBinding("FIN-NET-SALES", netSalesByDept.provenance.provenanceId),
      themeVersion: 1,
      linkedMetricRefs: [netSalesByDept.linkedMetricReference],
    };

    const revBudgetByDept = new Map<string, { val: number; fmt: string }>();
    for (const b of scopedBudgetRows.filter((row) => row.budgetCategory === "revenue")) {
      const m = parseDecimalToMinorUnits(b.budgetAmount, 2);
      revBudgetByDept.set(b.department, {
        val: Number(m) / 100,
        fmt: formatCurrencyOrRatioDisplay(m, 2, { currency: "USD" }),
      });
    }

    const budgetChartSpec: ChartSpec = {
      chartId: "chart_rev_vs_budget",
      kind: opts?.chartKindOverride?.vis_chart_budget_vs_actual ?? "grouped_bar",
      titleEn: "Revenue versus budget",
      titleKm: "ចំណូលជាក់ស្តែងធៀបនឹងថវិកា",
      altSummaryEn: `Departmental actual revenue versus approved budget for ${deptNames.join(", ")}.`,
      altSummaryKm: `ការប្រៀបធៀបចំណូលជាក់ស្តែង និងថវិកា (${deptNames.join(", ")})។`,
      unit: "currency",
      currency: "USD",
      yAxisStartsAtZero: true,
      categories: deptNames,
      series: [
        revChartSpec.series[0]!,
        {
          seriesId: "budget_net_sales",
          labelEn: "Approved Budget",
          labelKm: "ថវិកាអនុម័ត",
          classification: "budget",
          unit: "currency",
          currency: "USD",
          values: deptNames.map((d) => {
            const entry = revBudgetByDept.get(d);
            return {
              category: d,
              value: entry ? entry.val : null,
              formatted: entry ? entry.fmt : "N/A",
              state: entry ? "available" : "missing",
            };
          }),
        },
      ],
      binding: buildBinding("FIN-BUDGET-VARIANCE", budgetVar.provenance.provenanceId),
      themeVersion: 1,
      linkedMetricRefs: [budgetVar.linkedMetricReference],
    };

    const months = ["2026-10", "2026-11"];
    const monthRevMap = new Map<string, { val: number; fmt: string }>();
    for (const b of netSalesByMonth.breakdown ?? []) {
      monthRevMap.set(b.dimensionValues.reportingMonth!, {
        val: Number(b.value.decimalString ?? "0"),
        fmt: b.value.displayValue,
      });
    }

    const trendChartSpec: ChartSpec = {
      chartId: "chart_monthly_trend",
      kind: "line",
      titleEn: "Monthly net sales trend",
      titleKm: "និន្នាការចំណូលប្រចាំខែ",
      altSummaryEn: `Monthly net sales grew ${revGrowth.value.displayValue} from Oct to Nov 2026.`,
      altSummaryKm: `ចំណូលប្រចាំខែបានកើនឡើង ${revGrowth.value.displayValue} ពីតុលាដល់វិច្ឆិកា ២០២៦។`,
      unit: "currency",
      currency: "USD",
      yAxisStartsAtZero: true,
      categories: months,
      series: [
        {
          seriesId: "monthly_net_sales",
          labelEn: "Net Sales Revenue",
          labelKm: "ចំណូលលក់សុទ្ធ",
          classification: "actual",
          unit: "currency",
          currency: "USD",
          values: months.map((m) => {
            const entry = monthRevMap.get(m);
            return {
              category: m,
              value: entry ? entry.val : null,
              formatted: entry ? entry.fmt : "N/A",
              state: entry ? "available" : "missing",
            };
          }),
        },
      ],
      binding: buildBinding("FIN-NET-SALES", netSalesByMonth.provenance.provenanceId),
      themeVersion: 1,
      linkedMetricRefs: [netSalesByMonth.linkedMetricReference],
    };

    const revChartRendered = renderChartSpecToSvg(revChartSpec, 640, 340, lang);
    const budgetChartRendered = renderChartSpecToSvg(budgetChartSpec, 640, 340, lang);
    const trendChartRendered = renderChartSpecToSvg(trendChartSpec, 640, 340, lang);

    const visualResults: Record<string, EvaluatedVisualResult> = {
      vis_kpi_net_sales: {
        visualId: "vis_kpi_net_sales",
        state: opts?.simulateInvalidMetric ? "error" : "ready",
        errorDetail: opts?.simulateInvalidMetric ? "Simulated invalid mandatory metric check." : undefined,
        metricResults: {
          "FIN-NET-SALES": netSales,
          "FIN-REVENUE-GROWTH": revGrowth,
        },
      },
      vis_kpi_op_profit: {
        visualId: "vis_kpi_op_profit",
        state: "ready",
        metricResults: {
          "FIN-OPERATING-PROFIT": opProfit,
          "FIN-OPERATING-MARGIN": opMargin,
        },
      },
      vis_chart_dept_revenue: {
        visualId: "vis_chart_dept_revenue",
        state: "ready",
        metricResults: { "FIN-NET-SALES": netSalesByDept },
        chartSpec: revChartSpec,
        svg: revChartRendered.svg,
        accessibleTableHtml: revChartRendered.accessibleTableHtml,
      },
      vis_chart_budget_vs_actual: {
        visualId: "vis_chart_budget_vs_actual",
        state: "ready",
        metricResults: { "FIN-BUDGET-VARIANCE": budgetVar },
        chartSpec: budgetChartSpec,
        svg: budgetChartRendered.svg,
        accessibleTableHtml: budgetChartRendered.accessibleTableHtml,
      },
      vis_line_monthly_rev: {
        visualId: "vis_line_monthly_rev",
        state: "ready",
        metricResults: { "FIN-NET-SALES": netSalesByMonth },
        chartSpec: trendChartSpec,
        svg: trendChartRendered.svg,
        accessibleTableHtml: trendChartRendered.accessibleTableHtml,
      },
      vis_table_dept_summary: {
        visualId: "vis_table_dept_summary",
        state: "ready",
        metricResults: { "FIN-DISTINCT-CUSTOMERS": distinctCust },
      },
    };

    const response: EvaluatedReportResponse = {
      report: { ...report, lastComputedAt: new Date().toISOString() },
      interactionSeq: seq,
      effectiveDepartments,
      policyScope: `${policy.policyId}:v${policy.policyVersion}`,
      cacheHit: false,
      visualResults,
    };

    if (!opts?.chartKindOverride) {
      this.policyResultCache.set(cacheKey, structuredClone(response));
    }

    this.audit?.append({
      auditId: `aud_${randomUUID()}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: "system",
      action: "bi.evaluate",
      outcome: "success",
      summary: `Evaluated report '${report.reportId}' for scope [${effectiveDepartments.join(",")}] (${response.policyScope})`,
      createdAt: response.report.lastComputedAt,
    });

    return response;
  }

  drillToPermittedDetail(
    actor: ActorContext,
    policy: DataScopePolicy,
    reportId: string,
    filter: { departments?: string[]; page?: number; pageSize?: number },
  ): {
    rows: Array<Record<string, unknown>>;
    totalPermittedRows: number;
    effectiveDepartments: string[];
    returnFilterContext: { departments?: string[] };
  } {
    this.assertNotRevoked(actor);
    const report = this.getReport(actor, reportId);
    const effectiveDepartments = this.resolveEffectiveDepartments(policy, filter.departments);
    const baseRows =
      this.datasetRowsByManifest.get(`${actor.tenantId}::${report.datasetManifestId}::${report.datasetVersion}`) ?? [];
    const allowedDeptSet = new Set(effectiveDepartments);
    const allowedColSet = new Set(policy.allowedColumns);

    const permitted = baseRows
      .filter((r) => r.reportingMonth === "2026-11" && allowedDeptSet.has(r.department))
      .map((r) => {
        const sanitized: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (allowedColSet.has(k)) {
            sanitized[k] = v;
          }
        }
        return sanitized;
      });

    const pageSize = Math.max(1, Math.min(50, filter.pageSize ?? 10));
    const page = Math.max(1, filter.page ?? 1);
    const startIdx = (page - 1) * pageSize;
    return {
      rows: permitted.slice(startIdx, startIdx + pageSize),
      totalPermittedRows: permitted.length,
      effectiveDepartments,
      returnFilterContext: { departments: filter.departments },
    };
  }

  requestDraftRefresh(
    actor: ActorContext,
    reportId: string,
    targetManifestVersion: number,
    opts: { idempotencyKey: string; outcome?: "succeeded" | "failed" | "cancelled"; failureReason?: string },
  ): { report: StudioReport; job: RefreshJobRecord } {
    assertCanPerform(actor, "document", "write");
    const existingJob = this.refreshJobs.get(`${actor.tenantId}::${opts.idempotencyKey}`);
    const report = this.getReport(actor, reportId);
    if (existingJob) {
      return { report, job: structuredClone(existingJob) };
    }

    const outcome = opts.outcome ?? "succeeded";
    const now = new Date().toISOString();
    const job: RefreshJobRecord = {
      jobId: `job_${randomUUID().slice(0, 8)}`,
      idempotencyKey: opts.idempotencyKey,
      reportId,
      tenantId: actor.tenantId,
      status: outcome,
      targetManifestVersion,
      previousGoodManifestVersion: report.datasetVersion,
      startedAt: now,
      finishedAt: now,
      error: outcome === "succeeded" ? undefined : opts.failureReason ?? `Refresh ${outcome}`,
    };

    if (outcome === "succeeded") {
      report.datasetVersion = targetManifestVersion;
      report.lastSuccessfulRefreshAt = now;
      report.staleWarning = undefined;
      report.revision += 1;
    } else {
      // Retain previous lastGoodManifest intact and surface clear stale/error indicator (BI-T21)
      report.staleWarning = `STALE_MANIFEST_RETAINED: Refresh ${outcome} (${job.error}); displaying last certified v${report.datasetVersion}.`;
    }

    this.reports.set(report.reportId, structuredClone(report));
    this.refreshJobs.set(`${actor.tenantId}::${opts.idempotencyKey}`, structuredClone(job));
    return { report, job };
  }

  publishSnapshot(
    actor: ActorContext,
    policy: DataScopePolicy,
    evaluated: EvaluatedReportResponse,
    idempotencyKey: string,
  ): PublishedBiSnapshot {
    this.assertNotRevoked(actor);
    if (!policy.canPublish) {
      throw new IntelligenceEngineError(403, "PUBLISH_FORBIDDEN", "Actor policy lacks publication permission.");
    }
    const existing = Array.from(this.snapshots.values()).find(
      (s) => s.tenantId === actor.tenantId && s.reportId === evaluated.report.reportId && s.filterContext.policyId === policy.policyId && s.snapshotSha256.length > 0 && (s as PublishedBiSnapshot & { _idemKey?: string })._idemKey === idempotencyKey,
    );
    if (existing) {
      return structuredClone(existing);
    }

    const mandatoryError = Object.values(evaluated.visualResults).find((v) => v.state === "error" || v.state === "suppressed");
    if (mandatoryError) {
      throw new IntelligenceEngineError(
        422,
        "INVALID_MANDATORY_METRIC",
        `Cannot publish BI snapshot while visual '${mandatoryError.visualId}' is '${mandatoryError.state}'.`,
      );
    }

    const visualResultsFlat: Record<string, AnalyticalResult> = {};
    for (const v of Object.values(evaluated.visualResults)) {
      for (const [mId, res] of Object.entries(v.metricResults)) {
        if (res.validationStatus === "blocked") {
          throw new IntelligenceEngineError(422, "BLOCKED_METRIC_CANNOT_PUBLISH", `Metric '${mId}' is blocked.`);
        }
        visualResultsFlat[`${v.visualId}::${mId}`] = structuredClone(res);
      }
    }

    const filterContext: FilterContext = {
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      semanticModelId: evaluated.report.semanticModelId,
      semanticModelVersion: evaluated.report.semanticModelVersion,
      datasetManifestId: evaluated.report.datasetManifestId,
      datasetVersion: evaluated.report.datasetVersion,
      periodStart: "2026-11-01",
      periodEndExclusive: "2026-12-01",
      timezone: "Asia/Phnom_Penh",
      reportFilters: [{ dimension: "department", operator: "in", values: evaluated.effectiveDepartments }],
      pageFilters: [],
      visualFilters: [],
      crossFilters: [],
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
    };

    const snapshotSha256 = createHash("sha256")
      .update(JSON.stringify({ visualResultsFlat, filterContext }))
      .digest("hex");

    const snapshot: PublishedBiSnapshot & { _idemKey?: string } = {
      snapshotId: `bisnap_${randomUUID().slice(0, 8)}`,
      reportId: evaluated.report.reportId,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      policyScope: evaluated.policyScope,
      datasetManifestId: evaluated.report.datasetManifestId,
      datasetVersion: evaluated.report.datasetVersion,
      metricVersions: [{ metricId: "FIN-OPERATING-PROFIT", version: 1 }],
      filterContext,
      visualResults: visualResultsFlat,
      snapshotSha256,
      publishedAt: new Date().toISOString(),
      _idemKey: idempotencyKey,
    };

    this.snapshots.set(snapshot.snapshotId, snapshot);
    const storedReport = this.reports.get(evaluated.report.reportId);
    if (storedReport) {
      storedReport.status = "published";
      storedReport.publishedSnapshotHash = snapshotSha256;
    }

    return structuredClone(snapshot);
  }

  getPublishedSnapshot(actor: ActorContext, snapshotId: string): PublishedBiSnapshot {
    this.assertNotRevoked(actor);
    const snap = this.snapshots.get(snapshotId);
    if (!snap) {
      throw new IntelligenceEngineError(404, "SNAPSHOT_NOT_FOUND", `BI snapshot '${snapshotId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, snap.tenantId, snap.workspaceId);
    return structuredClone(snap);
  }

  exportFilteredSummaryCsv(
    actor: ActorContext,
    policy: DataScopePolicy,
    evaluated: EvaluatedReportResponse,
    opts?: { requestUnderlyingDetail?: boolean },
  ): { csv: string; policyScope: string; datasetVersion: number; effectiveDepartments: string[] } {
    this.assertNotRevoked(actor);
    assertCanPerform(actor, "export", "export");
    if (opts?.requestUnderlyingDetail && !policy.canExportUnderlyingDetail) {
      throw new IntelligenceEngineError(
        403,
        "UNDERLYING_EXPORT_DENIED",
        "Policy restricts export to authorized summary aggregates only.",
      );
    }

    const csvEscape = (raw: string): string => {
      const dangerous = /^[\s\x00-\x1f]*[=+\-@]/.test(raw);
      const safe = dangerous ? `'${raw}` : raw;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };

    const lines: string[] = [
      "metric,scope,dataset_version,value,unit,provenance_id",
    ];
    const netSales = evaluated.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"];
    const opProfit = evaluated.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-PROFIT"];
    const opMargin = evaluated.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-MARGIN"];
    const scope = evaluated.effectiveDepartments.join("+");
    for (const r of [netSales, opProfit, opMargin]) {
      if (!r) continue;
      lines.push(
        [
          csvEscape(r.displayNameEn),
          csvEscape(scope),
          csvEscape(`v${r.provenance.datasetVersion}`),
          csvEscape(r.value.displayValue),
          csvEscape(r.value.unit),
          csvEscape(r.provenance.provenanceId),
        ].join(","),
      );
    }

    return {
      csv: lines.join("\n"),
      policyScope: evaluated.policyScope,
      datasetVersion: evaluated.report.datasetVersion,
      effectiveDepartments: evaluated.effectiveDepartments,
    };
  }

  createLinkedPresentationFromDashboard(
    actor: ActorContext,
    evaluated: EvaluatedReportResponse,
    language: "en" | "km" | "bilingual" = "bilingual",
  ): StudioPresentation {
    const netSalesRef: LinkedMetricReference =
      evaluated.visualResults.vis_kpi_net_sales!.metricResults["FIN-NET-SALES"]!.linkedMetricReference;
    const opProfitRef: LinkedMetricReference =
      evaluated.visualResults.vis_kpi_op_profit!.metricResults["FIN-OPERATING-PROFIT"]!.linkedMetricReference;
    const opMarginRef: LinkedMetricReference =
      evaluated.visualResults.vis_kpi_op_profit!.metricResults["FIN-OPERATING-MARGIN"]!.linkedMetricReference;

    const deck = createGoldenManagementDeck({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      language,
      scopeLabel: `Departments: ${evaluated.effectiveDepartments.join(" + ")} (v${evaluated.report.datasetVersion})`,
      netSalesRef,
      opProfitRef,
      opMarginRef,
      revenueChartSpec: evaluated.visualResults.vis_chart_dept_revenue!.chartSpec!,
      budgetChartSpec: evaluated.visualResults.vis_chart_budget_vs_actual!.chartSpec!,
    });
    return this.presentations.saveInitialDeck(actor, deck);
  }
}

export function planBiDashboardCommand(params: {
  command: string;
  inputLanguage: "en" | "km";
  outputLanguage?: "en" | "km";
}): BiOperationPlan {
  const safety = scanForUnsafeAnalyticalInput(params.command);
  if (!safety.safe) {
    throw new IntelligenceEngineError(400, "UNSAFE_BI_OPERATION", safety.reasons.join(" "));
  }
  const norm = params.command.normalize("NFC").trim().toLowerCase();
  const outLang = params.outputLanguage ?? params.inputLanguage;
  const planId = `bip_${randomUUID().slice(0, 8)}`;

  if (
    (norm.includes("sales") && norm.includes("services")) ||
    (norm.includes("ផ្នែកលក់") && norm.includes("សេវាកម្ម"))
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "set_department_filter",
      departments: ["Sales", "Services"],
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      explanationEn: "Filter dashboard scope to Sales + Services departments.",
      explanationKm: "ត្រងផ្ទាំងព័ត៌មានសម្រាប់ផ្នែកលក់ និងសេវាកម្ម។",
    };
  }

  if (
    norm.includes("horizontal bar") ||
    norm.includes("bar chart") ||
    norm.includes("ក្រាហ្វរបារផ្ដេក")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "set_chart_type",
      chartKind: "bar",
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      explanationEn: "Switch selected chart type to horizontal bar while preserving FR-05 data binding.",
      explanationKm: "ប្តូរក្រាហ្វទៅជាក្រាហ្វរបារផ្ដេកដោយរក្សាទិន្នន័យដើមដដែល។",
    };
  }

  if (
    norm.includes("create presentation") ||
    norm.includes("draft presentation") ||
    norm.includes("បង្កើតបទបង្ហាញពីផ្ទាំងព័ត៌មាន")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "create_presentation_draft",
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      explanationEn: "Generate a linked editable presentation draft from verified dashboard results.",
      explanationKm: "បង្កើតបទបង្ហាញដែលអាចកែសម្រួលបានពីលទ្ធផលផ្ទាំងព័ត៌មានដែលបានផ្ទៀងផ្ទាត់។",
    };
  }

  if (
    norm.includes("revenue") ||
    norm.includes("ចំណូល")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "query_metric",
      metricId: "FIN-NET-SALES",
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      explanationEn: "Retrieve approved Net sales revenue (FIN-NET-SALES).",
      explanationKm: "ទាញយកចំណូលលក់សុទ្ធ (FIN-NET-SALES) ដែលបានអនុម័ត។",
    };
  }

  throw new IntelligenceEngineError(422, "UNSUPPORTED_BI_COMMAND", `Command '${params.command}' not recognized by mock planner.`);
}

export interface BiWorkloadBenchmarkResult {
  rowCount: number;
  visualsRendered: number;
  p50Ms: number;
  p95Ms: number;
  rssDeltaMb: number;
}

export async function benchmarkBiWorkload(
  rowCount: number,
  visualsCount: number,
): Promise<BiWorkloadBenchmarkResult> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  const spec: ChartSpec = {
    chartId: "bench_chart",
    kind: "column",
    titleEn: "Benchmark Dept Revenue",
    titleKm: "ចំណូល",
    altSummaryEn: "Benchmark",
    altSummaryKm: "Benchmark",
    unit: "currency",
    currency: "USD",
    yAxisStartsAtZero: true,
    categories: ["Sales", "Services", "Retail"],
    series: [
      {
        seriesId: "rev",
        labelEn: "Revenue",
        labelKm: "ចំណូល",
        classification: "actual",
        unit: "currency",
        currency: "USD",
        values: [
          { category: "Sales", value: 1000, formatted: "$1,000", state: "available" },
          { category: "Services", value: 900, formatted: "$900", state: "available" },
          { category: "Retail", value: 800, formatted: "$800", state: "available" },
        ],
      },
    ],
    binding: {
      datasetId: "bench",
      datasetVersion: 1,
      metricRefs: [{ metricId: "FIN-NET-SALES", version: 1 }],
      reportingPeriod: "2026-11-01..2026-12-01",
      filterContext: { scope: "pol_all" },
      policyScope: "pol_all",
      provenanceId: "prov_bench",
      freshnessTimestamp: new Date().toISOString(),
      sourceAsOfTimestamp: new Date().toISOString(),
    },
    themeVersion: 1,
    linkedMetricRefs: [],
  };

  try {
    await conn.run("SET memory_limit = '256MB'");
    await conn.run("SET threads = 2");
    await conn.run(`
      CREATE TABLE bi_bench_sales AS
      SELECT
        'B_' || i::VARCHAR AS row_id,
        CASE i % 3 WHEN 0 THEN 'Sales' WHEN 1 THEN 'Services' ELSE 'Retail' END AS department,
        'C' || ((i % 200) + 1)::VARCHAR AS customer_id,
        'posted' AS status,
        95.00::DECIMAL(18,2) AS net_sales,
        50.00::DECIMAL(18,2) AS cogs,
        10.00::DECIMAL(18,2) AS opex
      FROM range(0, ${Math.trunc(rowCount)}) t(i);
    `);
    await conn.run("SET enable_external_access = false");

    const runOnce = async () => {
      await conn.runAndReadAll(`
        SELECT department, COUNT(DISTINCT customer_id)::INTEGER AS custs,
               SUM(net_sales)::DOUBLE AS rev, SUM(net_sales - cogs - opex)::DOUBLE AS op_profit
        FROM bi_bench_sales WHERE status = 'posted' GROUP BY department
      `);
      for (let v = 0; v < visualsCount; v++) {
        renderChartSpecToSvg(spec, 500, 280, "en");
      }
    };

    await runOnce();
    const rssBefore = process.memoryUsage().rss;
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await runOnce();
      samples.push(performance.now() - t0);
    }
    const rssAfter = process.memoryUsage().rss;
    samples.sort((a, b) => a - b);
    return {
      rowCount,
      visualsRendered: visualsCount,
      p50Ms: Math.round(samples[1]! * 100) / 100,
      p95Ms: Math.round(samples[2]! * 100) / 100,
      rssDeltaMb: Math.round(((rssAfter - rssBefore) / (1024 * 1024)) * 100) / 100,
    };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
