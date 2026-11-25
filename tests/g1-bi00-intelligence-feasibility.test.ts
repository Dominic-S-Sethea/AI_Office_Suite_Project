import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ActorContext, DataScopePolicy } from "@ai-office-suite/shared-contracts";
import { AuthorizationError } from "@ai-office-suite/authorization";
import { recalculateWorkbook } from "@ai-office-suite/calculation-engine";
import { buildCrossModuleReconciledOutputs } from "@ai-office-suite/analytics-engine";
import { exportPresentationToPptxBuffer } from "@ai-office-suite/presentation-engine";
import { detectChromiumBinary } from "@ai-office-suite/file-conversion";
import {
  benchmarkBiWorkload,
  ChartAdapterError,
  compileChartSpecToEChartsOption,
  compileChartSpecToVegaLiteJson,
  IntelligenceEngineError,
  IntelligenceStudioEngine,
  planBiDashboardCommand,
  renderChartSpecPngViaEdge,
  SECTION_12_FINANCE_ROWS,
} from "@ai-office-suite/intelligence-engine";

const TENANT_A = "tenant_bi_alpha";
const TENANT_B = "tenant_bi_beta";

const FULL_EDITOR: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: "ws_bi_hq",
  userId: "user_cfo",
  role: "editor",
};

const SALES_VIEWER: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: "ws_bi_hq",
  userId: "user_sales_mgr",
  role: "viewer",
};

const SALES_REVIEWER: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: "ws_bi_hq",
  userId: "user_sales_reviewer",
  role: "reviewer",
};

const TENANT_B_OWNER: ActorContext = {
  tenantId: TENANT_B,
  workspaceId: "ws_bi_other",
  userId: "user_beta_owner",
  role: "owner",
};

const POLICY_ALL: DataScopePolicy = {
  policyId: "pol_enterprise_all",
  policyVersion: 1,
  tenantId: TENANT_A,
  principalRole: "editor",
  allowedDepartments: "ALL",
  allowedColumns: ["rowId", "invoiceDate", "reportingMonth", "department", "grossSales", "cogs", "opex"],
  canExportUnderlyingDetail: true,
  canPublish: true,
};

const POLICY_SALES_ONLY: DataScopePolicy = {
  policyId: "pol_sales_scoped",
  policyVersion: 1,
  tenantId: TENANT_A,
  principalRole: "viewer",
  allowedDepartments: ["Sales"],
  allowedColumns: ["rowId", "invoiceDate", "department", "grossSales"], // cogs/opex hidden for restricted viewer
  canExportUnderlyingDetail: false,
  canPublish: false,
};

describe("FR-07 BI-00 & Integrated X-VIS — Intelligence Studio Feasibility (BI-T01 .. BI-T32, X-VIS-01 .. X-VIS-08)", () => {
  it("evaluates Section 12 Golden Fixture identically to FR-05, supports cross-filtering, drill-through, ECharts/Vega-Lite parity & Khmer UI (BI-T01..T15, T30..T31)", async () => {
    const engine = new IntelligenceStudioEngine();
    engine.seedSection12TenantData(TENANT_A, FULL_EDITOR.workspaceId);

    const report = engine.createManagementReport(FULL_EDITOR);
    report.title = "Monthly Management BI · របាយការណ៍វិភាគប្រចាំខែ";
    const saved = engine.saveReport(FULL_EDITOR, report);
    expect(saved.revision).toBe(2);
    expect(engine.getReport(FULL_EDITOR, saved.reportId).title).toBe(report.title);

    // BI-T01..T04 & T08..T10: Full enterprise scope ($150k / $40k / 26.67% / +20.00% / 3 distinct customers)
    const fullEval = await engine.evaluateReport(FULL_EDITOR, POLICY_ALL, saved.reportId, {
      interactionSeq: 1,
      language: "en",
    });
    expect(fullEval.effectiveDepartments.sort()).toEqual(["Retail", "Sales", "Services"]);
    expect(fullEval.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue).toBe("$150,000.00");
    expect(fullEval.visualResults.vis_kpi_net_sales?.metricResults["FIN-REVENUE-GROWTH"]?.value.displayValue).toBe("20.00%");
    expect(fullEval.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-PROFIT"]?.value.displayValue).toBe("$40,000.00");
    expect(fullEval.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-MARGIN"]?.value.displayValue).toBe("26.67%");
    expect(fullEval.visualResults.vis_table_dept_summary?.metricResults["FIN-DISTINCT-CUSTOMERS"]?.value.displayValue).toBe("3");

    // ECharts SVG + Vega-Lite JSON + Accessible Table parity on the exact same ChartSpec
    const deptChartSpec = fullEval.visualResults.vis_chart_dept_revenue?.chartSpec!;
    expect(fullEval.visualResults.vis_chart_dept_revenue?.svg?.startsWith("<svg")).toBe(true);
    expect(fullEval.visualResults.vis_chart_dept_revenue?.accessibleTableHtml).toContain("<table");
    const vegaLiteJson = compileChartSpecToVegaLiteJson(deptChartSpec, "en");
    expect((vegaLiteJson.data as { values: unknown[] }).values).toHaveLength(3);

    // Render ECharts chart PNG via headless Chromium/Edge into tests/artifacts/ for direct visual inspection
    if (detectChromiumBinary()) {
      const artifactsDir = path.resolve(process.cwd(), "tests", "artifacts");
      mkdirSync(artifactsDir, { recursive: true });
      const chartShot = await renderChartSpecPngViaEdge(
        fullEval.visualResults.vis_chart_budget_vs_actual?.chartSpec!,
        path.join(artifactsDir, "bi-dashboard-revenue-chart.png"),
        760,
        400,
        "en",
      );
      expect(chartShot.byteLength).toBeGreaterThan(5_000);
    } else {
      console.warn("DISCLOSURE: Skipping BI chart PNG render — no Chromium/Chrome/Edge binary detected on host.");
    }

    // BI-T05 & X-VIS-02: Cross-filter to Sales + Services ($125k / $35k / 28.00% / +19.05% / +$3k variance)
    const filteredEval = await engine.evaluateReport(FULL_EDITOR, POLICY_ALL, saved.reportId, {
      requestedDepartments: ["Sales", "Services"],
      interactionSeq: 2,
    });
    expect(filteredEval.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue).toBe("$125,000.00");
    expect(filteredEval.visualResults.vis_kpi_net_sales?.metricResults["FIN-REVENUE-GROWTH"]?.value.displayValue).toBe("19.05%");
    expect(filteredEval.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-PROFIT"]?.value.displayValue).toBe("$35,000.00");
    expect(filteredEval.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-MARGIN"]?.value.displayValue).toBe("28.00%");
    expect(filteredEval.visualResults.vis_chart_budget_vs_actual?.metricResults["FIN-BUDGET-VARIANCE"]?.value.displayValue).toBe("$3,000.00");

    // BI-T07: Drill-to-permitted detail returns exact filtered records & preserves return context
    const detail = engine.drillToPermittedDetail(FULL_EDITOR, POLICY_ALL, saved.reportId, {
      departments: ["Sales", "Services"],
      page: 1,
      pageSize: 10,
    });
    expect(detail.totalPermittedRows).toBe(4);
    expect(detail.returnFilterContext.departments).toEqual(["Sales", "Services"]);

    // BI-T14 & T15: Equivalent EN / KM BI voice/text commands map to identical scope & chart change
    const enFilterCmd = planBiDashboardCommand({ command: "Filter Sales and Services departments", inputLanguage: "en" });
    const kmFilterCmd = planBiDashboardCommand({ command: "បង្ហាញផ្នែកលក់ និងសេវាកម្ម", inputLanguage: "km" });
    expect(enFilterCmd.isMockPlanner).toBe(true);
    expect(enFilterCmd.departments).toEqual(kmFilterCmd.departments);

    const barOverride = await engine.evaluateReport(FULL_EDITOR, POLICY_ALL, saved.reportId, {
      requestedDepartments: ["Sales", "Services"],
      chartKindOverride: { vis_chart_dept_revenue: "bar" },
      interactionSeq: 3,
    });
    expect(barOverride.visualResults.vis_chart_dept_revenue?.chartSpec?.kind).toBe("bar");
    expect(barOverride.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue).toBe("$125,000.00");

    // BI-T06: Reset back to empty requestedDepartments restores approved default ALL ($150k)
    const resetEval = await engine.evaluateReport(FULL_EDITOR, POLICY_ALL, saved.reportId, {
      requestedDepartments: [],
      interactionSeq: 4,
    });
    expect(resetEval.cacheHit).toBe(true);
    expect(resetEval.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue).toBe("$150,000.00");

    // BI-T11: Zero matches returns explicit `empty` state rather than fabricated zero or unfiltered totals
    const zeroMatchEval = await engine.evaluateReport(SALES_VIEWER, POLICY_SALES_ONLY, saved.reportId, {
      requestedDepartments: ["Retail"], // Disallowed by Sales-only policy -> empty intersection!
      interactionSeq: 1,
    });
    expect(zeroMatchEval.effectiveDepartments).toEqual([]);
    expect(zeroMatchEval.visualResults.vis_kpi_net_sales?.state).toBe("empty");
  });

  it("enforces role scoping, policy-scoped caching, revocation, refresh failures, race guard, and exports (BI-T16..T28, BI-T32)", async () => {
    const engine = new IntelligenceStudioEngine();
    engine.seedSection12TenantData(TENANT_A, FULL_EDITOR.workspaceId);
    const report = engine.createManagementReport(FULL_EDITOR);

    // Warm Full-Scope Cache first
    const fullFirst = await engine.evaluateReport(FULL_EDITOR, POLICY_ALL, report.reportId, { interactionSeq: 1 });
    expect(fullFirst.cacheHit).toBe(false);

    // BI-T17 & BI-T18 & X-VIS-03: Sales-only viewer querying default "All" gets cache MISS on policy key & receives ONLY $80k / $20k / 25.00%
    const salesEval = await engine.evaluateReport(SALES_VIEWER, POLICY_SALES_ONLY, report.reportId, { interactionSeq: 1 });
    expect(salesEval.cacheHit).toBe(false);
    expect(salesEval.effectiveDepartments).toEqual(["Sales"]);
    expect(salesEval.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue).toBe("$80,000.00");
    expect(salesEval.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-PROFIT"]?.value.displayValue).toBe("$20,000.00");
    expect(salesEval.visualResults.vis_kpi_op_profit?.metricResults["FIN-OPERATING-MARGIN"]?.value.displayValue).toBe("25.00%");

    // Sales-only drill-through strips hidden `cogs` and `opex` columns!
    const salesDetail = engine.drillToPermittedDetail(SALES_VIEWER, POLICY_SALES_ONLY, report.reportId, {});
    expect(salesDetail.totalPermittedRows).toBe(2);
    expect(salesDetail.rows[0]).not.toHaveProperty("cogs");
    expect(salesDetail.rows[0]).not.toHaveProperty("opex");

    // BI-T26 & T27: Viewer blocked on export:export (`403 FORBIDDEN_ROLE`); Sales-scoped reviewer can export $80k summary only, never underlying detail
    expect(() => engine.exportFilteredSummaryCsv(SALES_VIEWER, POLICY_SALES_ONLY, salesEval)).toThrowError(AuthorizationError);
    const summaryCsv = engine.exportFilteredSummaryCsv(SALES_REVIEWER, POLICY_SALES_ONLY, salesEval);
    expect(summaryCsv.csv).toContain("$80,000.00");
    expect(() =>
      engine.exportFilteredSummaryCsv(SALES_REVIEWER, POLICY_SALES_ONLY, salesEval, { requestUnderlyingDetail: true }),
    ).toThrowError(IntelligenceEngineError);

    // BI-T16: Cross-tenant access rejected
    expect(() => engine.getReport(TENANT_B_OWNER, report.reportId)).toThrowError(AuthorizationError);

    // BI-T22 & T32: Rapid filter sequence discards stale seq < latest & supports AbortSignal cancellation
    await expect(
      engine.evaluateReport(FULL_EDITOR, POLICY_ALL, report.reportId, { interactionSeq: 0 }),
    ).rejects.toMatchObject({ code: "STALE_INTERACTION_DISCARDED" });
    const ac = new AbortController();
    ac.abort();
    await expect(
      engine.evaluateReport(FULL_EDITOR, POLICY_ALL, report.reportId, { interactionSeq: 2, abortSignal: ac.signal }),
    ).rejects.toMatchObject({ code: "QUERY_CANCELLED" });

    // BI-T24: Blocked mandatory visual prevents publication
    const badEval = await engine.evaluateReport(FULL_EDITOR, POLICY_ALL, report.reportId, {
      interactionSeq: 3,
      simulateInvalidMetric: true,
    });
    expect(() => engine.publishSnapshot(FULL_EDITOR, POLICY_ALL, badEval, "pub_bad_1")).toThrowError(
      /Cannot publish BI snapshot while visual 'vis_kpi_net_sales' is 'error'/i,
    );

    // BI-T25 & T20 & T21 & X-VIS-04 & X-VIS-08: Publish clean v1 snapshot -> refresh fails cleanly keeping v1 -> refresh v2 succeeds on draft only -> retry idempotency
    const snapV1 = engine.publishSnapshot(FULL_EDITOR, POLICY_ALL, fullFirst, "pub_v1_clean");
    const snapV1Retry = engine.publishSnapshot(FULL_EDITOR, POLICY_ALL, fullFirst, "pub_v1_clean");
    expect(snapV1Retry.snapshotId).toBe(snapV1.snapshotId);

    const failedRefresh = engine.requestDraftRefresh(FULL_EDITOR, report.reportId, 2, {
      idempotencyKey: "ref_fail_1",
      outcome: "failed",
      failureReason: "Upstream file checksum mismatch",
    });
    expect(failedRefresh.report.datasetVersion).toBe(1);
    expect(failedRefresh.report.staleWarning).toContain("STALE_MANIFEST_RETAINED");

    const updatedRows = SECTION_12_FINANCE_ROWS.map((r) =>
      r.rowId === "S12-NOV-SAL1" ? { ...r, grossSales: "60000.00" } : r,
    );
    engine.registerManifestVersion(TENANT_A, FULL_EDITOR.workspaceId, `ds_s12_finance_${TENANT_A}`, 2, updatedRows);
    const okRefresh = engine.requestDraftRefresh(FULL_EDITOR, report.reportId, 2, {
      idempotencyKey: "ref_ok_v2",
      outcome: "succeeded",
    });
    expect(okRefresh.report.datasetVersion).toBe(2);

    // Historical v1 snapshot remains completely unchanged until revoked!
    expect(engine.getPublishedSnapshot(FULL_EDITOR, snapV1.snapshotId).datasetVersion).toBe(1);

    // BI-T19: Principal revocation immediately blocks even historical snapshot retrieval
    engine.revokePrincipalAccess(TENANT_A, SALES_VIEWER.userId);
    expect(() => engine.getPublishedSnapshot(SALES_VIEWER, snapV1.snapshotId)).toThrowError(
      /User access has been revoked/i,
    );

    // BI-T28: Reject malicious XSS / JavaScript callbacks / external URIs inside ChartSpec or BI prompts
    expect(() =>
      planBiDashboardCommand({ command: "SELECT * FROM read_csv_auto('http://evil/x.csv')", inputLanguage: "en" }),
    ).toThrowError(IntelligenceEngineError);
    const xssSpec = structuredClone(fullFirst.visualResults.vis_chart_dept_revenue!.chartSpec!);
    xssSpec.titleEn = "<script>alert(1)</script>";
    expect(() => compileChartSpecToEChartsOption(xssSpec)).toThrowError(ChartAdapterError);
  });

  it("verifies cross-module X-VIS reconciliation (Sheet + Doc + BI + 6-slide PPTX) & 10k/100k BI workloads (BI-T29, X-VIS-01..08)", async () => {
    const engine = new IntelligenceStudioEngine();
    engine.seedSection12TenantData(TENANT_A, FULL_EDITOR.workspaceId);
    const report = engine.createManagementReport(FULL_EDITOR);

    // Evaluate Sales + Services ($125,000 / $35,000 / 28.00%)
    const scopedEval = await engine.evaluateReport(FULL_EDITOR, POLICY_ALL, report.reportId, {
      requestedDepartments: ["Sales", "Services"],
      interactionSeq: 1,
    });

    // Build synchronized Worksheet + Document via FR-05 helper
    const reconciledDocSheet = buildCrossModuleReconciledOutputs(FULL_EDITOR, {
      netSales: scopedEval.visualResults.vis_kpi_net_sales!.metricResults["FIN-NET-SALES"]!,
      operatingProfit: scopedEval.visualResults.vis_kpi_op_profit!.metricResults["FIN-OPERATING-PROFIT"]!,
      operatingMargin: scopedEval.visualResults.vis_kpi_op_profit!.metricResults["FIN-OPERATING-MARGIN"]!,
    });
    const recalcedSheet = recalculateWorkbook(reconciledDocSheet.workbook);
    expect(reconciledDocSheet.allMatchExactDecimals).toBe(true);
    expect(recalcedSheet.workbook.sheets[0]!.cells.B3!.evaluatedValue).toBe(28);

    // BI-T29 / X-VIS-01..02: Generate linked 6-slide presentation directly from the same evaluated dashboard scope
    const linkedDeck = engine.createLinkedPresentationFromDashboard(FULL_EDITOR, scopedEval, "bilingual");
    expect(linkedDeck.scopeLabel).toContain("Sales + Services");
    const slide2Profit = linkedDeck.slides[1]!.elements.find((e) => e.elementId === "el_kpi_profit");
    expect(slide2Profit?.type === "metric" && slide2Profit.metricRef.cachedFormattedValue).toBe("$35,000.00");

    const exportedPptx = await exportPresentationToPptxBuffer(linkedDeck);
    expect(exportedPptx.disclosure.includedScopeLabel).toContain("Sales + Services");
    writeFileSync(
      path.resolve(process.cwd(), "tests", "artifacts", "scoped-sales-services-deck.pptx"),
      exportedPptx.buffer,
    );

    // Run real DuckDB + ECharts SVG workload benchmarks (10k rows x 4 visuals, 100k rows x 8 visuals)
    const bench10k = await benchmarkBiWorkload(10_000, 4);
    const bench100k = await benchmarkBiWorkload(100_000, 8);
    expect(bench10k.visualsRendered).toBe(4);
    expect(bench100k.visualsRendered).toBe(8);
    console.info("BI-00 Workload Benchmarks:", JSON.stringify({ bench10k, bench100k }));
  });
});
