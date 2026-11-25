import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ActorContext,
  DataScopePolicy,
  ReportingContext,
} from "@ai-office-suite/shared-contracts";
import {
  initializePostgreSqlSchema,
  PgliteDatabaseAdapter,
  withTenantTransaction,
} from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import {
  CrossModuleIntegrationEngine,
  getPackageLifecycleRow,
  initializeIntegrationSchema,
  listOutboxEventsForTenant,
  planCrossModuleWorkflow,
  SECTION_12_FINANCE_ROWS,
  STANDARD_FINANCE_COLUMNS,
  XI00_FINANCE_ROWS_V2,
  XI00_INCOMPATIBLE_V3_COLUMNS,
} from "@ai-office-suite/integration-engine";

const TENANT_ALPHA = "10000000-0000-4000-8000-000000000001";
const TENANT_BETA = "20000000-0000-4000-8000-000000000002";
const WS_ALPHA = "a0000000-0000-4000-8000-000000000001";
const WS_BETA = "b0000000-0000-4000-8000-000000000002";

const OWNER_ID = "c0000000-0000-4000-8000-000000000001";
const EDITOR_ID = "c0000000-0000-4000-8000-000000000002";
const VIEWER_ID = "c0000000-0000-4000-8000-000000000003";
const REVOKABLE_EDITOR_ID = "c0000000-0000-4000-8000-000000000004";
const BETA_OWNER_ID = "c0000000-0000-4000-8000-000000000005";

const OWNER_ACTOR: ActorContext = {
  tenantId: TENANT_ALPHA,
  workspaceId: WS_ALPHA,
  userId: OWNER_ID,
  role: "owner",
};

const EDITOR_ACTOR: ActorContext = {
  tenantId: TENANT_ALPHA,
  workspaceId: WS_ALPHA,
  userId: EDITOR_ID,
  role: "editor",
};

const VIEWER_ACTOR: ActorContext = {
  tenantId: TENANT_ALPHA,
  workspaceId: WS_ALPHA,
  userId: VIEWER_ID,
  role: "viewer",
};

const BETA_ACTOR: ActorContext = {
  tenantId: TENANT_BETA,
  workspaceId: WS_BETA,
  userId: BETA_OWNER_ID,
  role: "owner",
};

const POLICY_ALL_V1: DataScopePolicy = {
  policyId: "pol_exec_all",
  policyVersion: 1,
  tenantId: TENANT_ALPHA,
  principalRole: "owner",
  allowedDepartments: "ALL",
  allowedColumns: [...STANDARD_FINANCE_COLUMNS],
  canExportUnderlyingDetail: true,
  canPublish: true,
};

const POLICY_SALES_SCOPED_V1: DataScopePolicy = {
  policyId: "pol_sales_only",
  policyVersion: 1,
  tenantId: TENANT_ALPHA,
  principalRole: "editor",
  allowedDepartments: ["Sales"],
  allowedColumns: ["rowId", "invoiceDate", "reportingMonth", "department", "customerId", "status", "currency", "grossSales", "returnsDiscounts", "cogs", "opex"],
  canExportUnderlyingDetail: false,
  canPublish: false,
};

const POLICY_SALES_RESTRICTED_NO_COGS: DataScopePolicy = {
  policyId: "pol_sales_viewer_restricted",
  policyVersion: 1,
  tenantId: TENANT_ALPHA,
  principalRole: "viewer",
  allowedDepartments: ["Sales"],
  allowedColumns: ["reportingMonth", "department", "grossSales", "returnsDiscounts"],
  canExportUnderlyingDetail: false,
  canPublish: false,
};

describe("FR-08 XI-00 — Cross-Module Integration Feasibility (INT-T01 .. INT-T24)", () => {
  let db: PgliteDatabaseAdapter;
  let engine: CrossModuleIntegrationEngine;
  let datasetId: string;

  beforeAll(async () => {
    db = new PgliteDatabaseAdapter();
    await db.ready();
    await initializePostgreSqlSchema(db);
    await initializeIntegrationSchema(db);

    const pwHash = await hashPassword("IntegrationPass!2026");
    await db.query(
      "INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, $2, 'active'), ($3::uuid, $4, 'active')",
      [TENANT_ALPHA, "Alpha Integrated Corp", TENANT_BETA, "Beta Isolated Corp"],
    );
    await db.query(
      "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, $3), ($4::uuid, $5::uuid, $6)",
      [TENANT_ALPHA, WS_ALPHA, "Alpha HQ", TENANT_BETA, WS_BETA, "Beta HQ"],
    );
    await db.query(
      `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES
       ($1::uuid, 'owner@alpha.test', $6, 1, 'active'),
       ($2::uuid, 'editor@alpha.test', $6, 1, 'active'),
       ($3::uuid, 'viewer@alpha.test', $6, 1, 'active'),
       ($4::uuid, 'revoke@alpha.test', $6, 1, 'active'),
       ($5::uuid, 'owner@beta.test', $6, 1, 'active')`,
      [OWNER_ID, EDITOR_ID, VIEWER_ID, REVOKABLE_EDITOR_ID, BETA_OWNER_ID, pwHash],
    );

    engine = new CrossModuleIntegrationEngine({ db });
    const seeded = await engine.seedGoldenV1(TENANT_ALPHA, WS_ALPHA, OWNER_ACTOR);
    datasetId = seeded.datasetId;
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it("INT-T01..T09, INT-T23: synchronizes all 4 studios identically, handles rename/refresh/pinned snapshot/one-way detach, impact & incompatible schema, and restore", async () => {
    // INT-T01: Synchronize V1 Golden Fixture across Workbook, Document, Dashboard, Presentation
    const v1Bundle = await engine.syncWorkspaceModules(OWNER_ACTOR, POLICY_ALL_V1, {
      datasetId,
      datasetVersion: 1,
    });

    // Independently specified V1 expectations across all 4 modules: $150k, $40k, 26.67%, 20.00%
    expect(v1Bundle.resultRefs["FIN-NET-SALES"]!.displayValue).toBe("$150,000.00");
    expect(v1Bundle.resultRefs["FIN-OPERATING-PROFIT"]!.displayValue).toBe("$40,000.00");
    expect(v1Bundle.resultRefs["FIN-OPERATING-MARGIN"]!.displayValue).toBe("26.67%");
    expect(v1Bundle.resultRefs["FIN-REVENUE-GROWTH"]!.displayValue).toBe("20.00%");

    const wbCells = v1Bundle.workbook.sheets[0]!.cells;
    expect(wbCells.B5?.evaluatedValue).toBe(150000);
    expect(wbCells.E5?.evaluatedValue).toBe(40000);
    expect(wbCells.B7?.evaluatedValue).toBe(26.67);
    expect(wbCells.B8?.evaluatedValue).toBe(20);

    expect(v1Bundle.evaluatedDashboard.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue).toBe("$150,000.00");
    expect(v1Bundle.presentation.slides[1]?.sourceRefs.find((r) => r.metricId === "FIN-OPERATING-PROFIT")?.cachedFormattedValue).toBe("$40,000.00");

    // INT-T02: Filtered analytical table (Sales + Services -> $125,000.00 Net Sales, $35,000.00 Profit, 28.00% Margin)
    const filteredBundle = await engine.syncWorkspaceModules(OWNER_ACTOR, POLICY_ALL_V1, {
      datasetId,
      datasetVersion: 1,
      requestedDepartments: ["Sales", "Services"],
    });
    expect(filteredBundle.resultRefs["FIN-NET-SALES"]!.filters.departments).toBe("Sales,Services");
    expect(filteredBundle.resultRefs["FIN-NET-SALES"]!.displayValue).toBe("$125,000.00");
    expect(filteredBundle.resultRefs["FIN-OPERATING-PROFIT"]!.displayValue).toBe("$35,000.00");
    expect(filteredBundle.resultRefs["FIN-OPERATING-MARGIN"]!.displayValue).toBe("28.00%");

    // INT-T03: Convert dashboard chart into editable Presentation slide chart
    const inserted = await engine.insertLinkedChartIntoPresentation(OWNER_ACTOR, POLICY_ALL_V1, {
      presentationId: v1Bundle.presentation.presentationId,
      slideId: "slide_6_priorities",
      chartSpec: v1Bundle.evaluatedDashboard.visualResults.vis_line_monthly_rev!.chartSpec!,
      datasetId,
      datasetVersion: 1,
    });
    const chartEl = inserted.slide.elements.find((e) => e.type === "chart" && e.chartSpec.chartId === "chart_monthly_trend");
    expect(chartEl).toBeTruthy();

    // Create refreshable binding on Document + pinned snapshot binding on Historical Package (INT-T04 / T05 / T07)
    const refreshableDocBinding = await engine.createLinkedBinding(OWNER_ACTOR, POLICY_ALL_V1, {
      sourceArtifactId: v1Bundle.workbookArtifact.artifactId,
      sourceDatasetId: datasetId,
      sourceDatasetVersion: 1,
      sourceMetricId: "FIN-OPERATING-PROFIT",
      sourceMetricVersion: 1,
      targetArtifactId: v1Bundle.documentArtifact.artifactId,
      targetKind: "document",
      targetElementId: "blk_metric_op_profit",
      objectKind: "metric",
      mode: "refreshable_link",
    });

    // INT-T04: Rename source workbook -> artifactId stays stable and link stays current
    const renamedWb = await engine.renameArtifact(
      OWNER_ACTOR,
      v1Bundle.workbookArtifact.artifactId,
      "Renamed Q4 Finance Workbook 2026",
      v1Bundle.workbookArtifact.currentRevision,
    );
    expect(renamedWb.artifactId).toBe(v1Bundle.workbookArtifact.artifactId);
    expect(engine.evaluateLinkState(OWNER_ACTOR, POLICY_ALL_V1, refreshableDocBinding.bindingId, 1)).toBe("current");

    // Stage, approve & publish V1 Reporting Package (INT-T07 baseline)
    const stagedV1 = await engine.stageReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
      packageId: "pkg_nov_mgmt",
      packageVersion: 1,
      title: "November Management Reporting Package V1",
      bundle: v1Bundle,
    });
    expect(stagedV1.allValidationsPassed).toBe(true);
    await engine.approveReportingPackage(OWNER_ACTOR, "pkg_nov_mgmt", 1);
    const publishedV1 = await engine.publishReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
      packageId: "pkg_nov_mgmt",
      packageVersion: 1,
      idempotencyKey: "pub_v1_initial",
    });
    expect(publishedV1.lifecycleStatus).toBe("published");

    // Explicit pinned snapshot binding representing published V1 archive
    const pinnedPkgBinding = await engine.createLinkedBinding(OWNER_ACTOR, POLICY_ALL_V1, {
      sourceArtifactId: v1Bundle.workbookArtifact.artifactId,
      sourceDatasetId: datasetId,
      sourceDatasetVersion: 1,
      sourceMetricId: "FIN-OPERATING-PROFIT",
      sourceMetricVersion: 1,
      targetArtifactId: v1Bundle.presentation.presentationId,
      targetKind: "presentation",
      targetElementId: "el_s2_profit_card",
      objectKind: "metric",
      mode: "pinned_snapshot",
    });

    // INT-T05: Publish V2 dataset (+10k Sales, +6k COGS => $160k Net Sales, $44k Profit, 27.50%, +28.00%)
    await engine.registerDatasetVersion(OWNER_ACTOR, {
      datasetId,
      version: 2,
      rows: XI00_FINANCE_ROWS_V2,
      requiredColumns: [...STANDARD_FINANCE_COLUMNS],
    });
    expect(engine.evaluateLinkState(OWNER_ACTOR, POLICY_ALL_V1, refreshableDocBinding.bindingId, 2)).toBe("update_available");
    expect(engine.evaluateLinkState(OWNER_ACTOR, POLICY_ALL_V1, pinnedPkgBinding.bindingId, 2)).toBe("pinned");

    // One-directional sync enforcement: direct overwrite blocked unless explicitDetach=true
    expect(() =>
      engine.mutateLinkedObjectValues(OWNER_ACTOR, refreshableDocBinding.bindingId, {
        attemptedValue: "$999,999.00",
      }),
    ).toThrowError(/One-directional sync/);

    // INT-T06: Propose & apply refresh on draft -> V2 values across all 4 modules; INT-T07: V1 published package untouched!
    const refreshProp = await engine.proposeRefresh(OWNER_ACTOR, POLICY_ALL_V1, {
      targetArtifactId: v1Bundle.documentArtifact.artifactId,
      datasetId,
      fromDatasetVersion: 1,
      toDatasetVersion: 2,
    });
    expect(refreshProp.compatible).toBe(true);
    expect(refreshProp.deltas.find((d) => d.targetElementId === "FIN-NET-SALES")).toMatchObject({
      beforeValue: "$150,000.00",
      afterValue: "$160,000.00",
    });
    expect(refreshProp.deltas.find((d) => d.targetElementId === "FIN-OPERATING-PROFIT")).toMatchObject({
      beforeValue: "$40,000.00",
      afterValue: "$44,000.00",
    });

    const v2Bundle = await engine.applyRefreshProposal(OWNER_ACTOR, POLICY_ALL_V1, refreshProp, true, {
      datasetId,
      existingIds: {
        workbookArtifactId: v1Bundle.workbookArtifact.artifactId,
        documentArtifactId: v1Bundle.documentArtifact.artifactId,
        dashboardReportId: v1Bundle.dashboardArtifact.artifactId,
        presentationId: v1Bundle.presentationArtifact.artifactId,
      },
    });
    expect(v2Bundle.workbook.sheets[0]!.cells.B5?.evaluatedValue).toBe(160000);
    expect(v2Bundle.workbook.sheets[0]!.cells.E5?.evaluatedValue).toBe(44000);
    expect(v2Bundle.workbook.sheets[0]!.cells.B7?.evaluatedValue).toBe(27.5);
    expect(v2Bundle.workbook.sheets[0]!.cells.B8?.evaluatedValue).toBe(28);
    expect(v2Bundle.documentArtifact.currentRevision).toBe(2);

    // INT-T07 check: Published V1 manifest stays immutable at $150,000.00 / $40,000.00!
    const archivedV1 = engine.getPublishedPackage(OWNER_ACTOR, "pkg_nov_mgmt", 1);
    expect(archivedV1.resultReferences.find((r) => r.metricId === "FIN-NET-SALES")?.displayValue).toBe("$150,000.00");
    expect(archivedV1.resultReferences.find((r) => r.metricId === "FIN-OPERATING-PROFIT")?.displayValue).toBe("$40,000.00");

    // INT-T08: Metric formula version bump impact analysis
    const opV1 = engine.analytics.registry.getMetricVersion("FIN-OPERATING-PROFIT", 1).versionSpec;
    engine.analytics.registry.registerMetricVersion("FIN-OPERATING-PROFIT", {
      ...opV1,
      changeSummary: "V2 adjusted operating profit definition for impact test.",
    });
    const impact = engine.analyzeMetricChangeImpact(OWNER_ACTOR, POLICY_ALL_V1, "FIN-OPERATING-PROFIT", 2);
    expect(impact.impactedArtifacts.length).toBeGreaterThanOrEqual(4);

    // INT-T09: Register V3 dataset missing 'cogs' column -> incompatible state & blocked refresh
    await engine.registerDatasetVersion(OWNER_ACTOR, {
      datasetId,
      version: 3,
      rows: [],
      requiredColumns: [...XI00_INCOMPATIBLE_V3_COLUMNS],
    });
    expect(engine.evaluateLinkState(OWNER_ACTOR, POLICY_ALL_V1, refreshableDocBinding.bindingId, 3)).toBe("incompatible");
    const badRefresh = await engine.proposeRefresh(OWNER_ACTOR, POLICY_ALL_V1, {
      targetArtifactId: v2Bundle.documentArtifact.artifactId,
      datasetId,
      fromDatasetVersion: 2,
      toDatasetVersion: 3,
    });
    expect(badRefresh.compatible).toBe(false);
    expect(badRefresh.incompatibilityReason).toContain("cogs");
    await expect(engine.applyRefreshProposal(OWNER_ACTOR, POLICY_ALL_V1, badRefresh, true, { datasetId })).rejects.toThrowError(/cogs/);

    // INT-T23: Non-destructive restore of Document to revision 1 creates revision 3 preserving V1 text/value
    const restoredDoc = await engine.restoreArtifactRevision(OWNER_ACTOR, v2Bundle.documentArtifact.artifactId, 1);
    expect(restoredDoc.artifact.currentRevision).toBe(3);
    expect(restoredDoc.restoredFromRevision).toBe(1);
    const docVersions = await engine.documents.listVersions(OWNER_ACTOR, v2Bundle.documentArtifact.artifactId);
    expect(docVersions.length).toBe(3);
  });

  it("INT-T12..T17, INT-T22: runs durable multi-module workflow, crash/rehydrate recovery, cancellation, 409 conflicts, approval invalidation & atomic PostgreSQL commit", async () => {
    const context: ReportingContext = {
      tenantId: TENANT_ALPHA,
      workspaceId: WS_ALPHA,
      periodStart: "2026-11-01",
      periodEndExclusive: "2026-12-01",
      datasetId,
      datasetVersion: 1,
      metricIds: ["FIN-NET-SALES", "FIN-OPERATING-PROFIT", "FIN-OPERATING-MARGIN", "FIN-REVENUE-GROWTH"],
      currency: "USD",
      language: "bilingual",
      themeId: "theme_corporate_navy",
      themeVersion: 1,
    };

    // Seed an independent prior approved baseline package so INT-T13 verifies preservation without coupling tests
    const baselineBundle = await engine.syncWorkspaceModules(OWNER_ACTOR, POLICY_ALL_V1, {
      datasetId,
      datasetVersion: 1,
    });
    await engine.stageReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
      packageId: "pkg_baseline_block2",
      packageVersion: 1,
      title: "Baseline Approved Package V1",
      bundle: baselineBundle,
    });
    await engine.approveReportingPackage(OWNER_ACTOR, "pkg_baseline_block2", 1);
    await engine.publishReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
      packageId: "pkg_baseline_block2",
      packageVersion: 1,
      idempotencyKey: "pub_baseline_block2_v1",
    });

    // INT-T13: Failure during presentation generation fails cleanly without publishing incomplete package
    const failedRun = await engine.startMonthlyReportingWorkflow(OWNER_ACTOR, POLICY_ALL_V1, {
      idempotencyKey: "wf_fail_pres_1",
      context,
      simulateFailAtStep: "stage_presentation",
    });
    expect(failedRun.run.state).toBe("failed");
    expect(failedRun.run.stagedPackageId).toBeUndefined();
    // Baseline published package remains completely untouched!
    expect(engine.getPublishedPackage(OWNER_ACTOR, "pkg_baseline_block2", 1).lifecycleStatus).toBe("published");

    // INT-T14 (Part A - Idempotency): Duplicate request does not rerun or duplicate artifacts
    const wfSuccess = await engine.startMonthlyReportingWorkflow(OWNER_ACTOR, POLICY_ALL_V1, {
      idempotencyKey: "wf_monthly_nov_1",
      context,
    });
    expect(wfSuccess.run.state).toBe("awaiting_approval");
    expect(wfSuccess.run.stagedPackageId).toBeTruthy();
    const wfDup = await engine.startMonthlyReportingWorkflow(OWNER_ACTOR, POLICY_ALL_V1, {
      idempotencyKey: "wf_monthly_nov_1",
      context,
    });
    expect(wfDup.deduplicated).toBe(true);
    expect(wfDup.run.runId).toBe(wfSuccess.run.runId);

    // INT-T14 (Part B - Worker Restart Recovery via PostgreSQL persistence)
    const paused = await engine.startMonthlyReportingWorkflow(OWNER_ACTOR, POLICY_ALL_V1, {
      idempotencyKey: "wf_restart_recovery_1",
      context,
      pauseAfterStep: "stage_document",
    });
    expect(paused.run.state).toBe("awaiting_clarification");
    const freshEngine = new CrossModuleIntegrationEngine({ db });
    await freshEngine.seedGoldenV1(TENANT_ALPHA, WS_ALPHA, OWNER_ACTOR);
    const rehydrated = await freshEngine.rehydrateWorkflowFromDb(OWNER_ACTOR, paused.run.runId);
    expect(rehydrated.runId).toBe(paused.run.runId);
    const resumed = await freshEngine.resumeWorkflow(OWNER_ACTOR, POLICY_ALL_V1, paused.run.runId);
    expect(resumed.run.state).toBe("awaiting_approval");
    expect(resumed.run.stagedPackageId).toBeTruthy();

    // INT-T15: Cancel active paused workflow -> preserves state & blocks resume
    const toCancel = await engine.startMonthlyReportingWorkflow(OWNER_ACTOR, POLICY_ALL_V1, {
      idempotencyKey: "wf_cancel_test_1",
      context,
      pauseAfterStep: "stage_document",
    });
    const cancelled = await engine.cancelWorkflow(OWNER_ACTOR, toCancel.run.runId);
    expect(cancelled.state).toBe("cancelled");
    await expect(engine.resumeWorkflow(OWNER_ACTOR, POLICY_ALL_V1, cancelled.runId)).rejects.toThrowError(/cancelled/i);

    // INT-T16: Concurrent artifact revision conflict (409 REVISION_CONFLICT)
    const docId = wfSuccess.bundle!.documentArtifact.artifactId;
    await expect(
      engine.commitArtifactRevision(OWNER_ACTOR, docId, 999, { bogus: true }),
    ).rejects.toThrowError(/Expected revision 999/);

    // INT-T17: Post-approval manifest modification invalidates prior approval
    const pkgId = wfSuccess.run.stagedPackageId!;
    const approved = await engine.approveReportingPackage(OWNER_ACTOR, pkgId, 1);
    expect(approved.approval?.status).toBe("approved");
    const mutated = await engine.modifyStagedPackageAfterApproval(OWNER_ACTOR, pkgId, 1, "Amended Draft Package Title");
    expect(mutated.approval?.status).toBe("invalidated");
    await expect(
      engine.publishReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
        packageId: pkgId,
        packageVersion: 1,
        idempotencyKey: "pub_after_invalid_1",
      }),
    ).rejects.toThrowError(/lacks valid approval/);

    // INT-T22: Re-approve, simulate mid-transaction commit failure -> full PostgreSQL rollback -> retry succeeds atomically!
    const pkgV2 = await engine.stageReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
      packageId: pkgId,
      packageVersion: 2,
      title: "November Management Package V2 Final",
      bundle: wfSuccess.bundle!,
    });
    await engine.approveReportingPackage(OWNER_ACTOR, pkgV2.packageId, 2);

    const outboxBefore = await listOutboxEventsForTenant(db, TENANT_ALPHA);
    await expect(
      engine.publishReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
        packageId: pkgId,
        packageVersion: 2,
        idempotencyKey: "pub_fail_rollback_test",
        simulateFailureBeforeCommit: true,
      }),
    ).rejects.toThrowError(/SIMULATED_PUBLICATION_COMMIT_FAILURE/);

    const rolledBackRow = await getPackageLifecycleRow(db, TENANT_ALPHA, pkgId, 2);
    expect(rolledBackRow?.lifecycle_status).not.toBe("published");
    expect((await listOutboxEventsForTenant(db, TENANT_ALPHA)).length).toBe(outboxBefore.length);

    // Now commit cleanly -> DB package, artifacts, audit_logs, and outbox updated atomically
    const committed = await engine.publishReportingPackage(OWNER_ACTOR, POLICY_ALL_V1, {
      packageId: pkgId,
      packageVersion: 2,
      idempotencyKey: "pub_atomic_success_v2",
    });
    expect(committed.lifecycleStatus).toBe("published");
    const publishedDbRow = await getPackageLifecycleRow(db, TENANT_ALPHA, pkgId, 2);
    expect(publishedDbRow?.lifecycle_status).toBe("published");
    const outboxAfter = await listOutboxEventsForTenant(db, TENANT_ALPHA);
    expect(outboxAfter.length).toBe(outboxBefore.length + 1);
  });

  it("INT-T10..T11, INT-T18..T21, INT-T24: enforces BOLA, mid-workflow revocation, dependency redaction, disclosure PPTX export, policy cache invalidation, EN/KM parity & latency telemetry", async () => {
    const t0 = performance.now();

    // INT-T10: Register a restricted Payroll artifact + dataset, verify viewer/restricted user denial & PostgreSQL RLS tenant isolation
    await engine.registerArtifact(OWNER_ACTOR, {
      artifactId: "art_payroll_2026_restricted",
      kind: "document",
      title: "Executive Payroll Ledger 2026 (CONFIDENTIAL)",
      classification: "restricted",
      allowedDepartments: ["Retail"],
      requiredColumns: ["grossSales", "cogs", "opex"],
      contentSnapshot: { salaryTotal: 550000 },
    });
    await engine.addDependencyEdge({
      tenantId: TENANT_ALPHA,
      workspaceId: WS_ALPHA,
      sourceKind: "dataset",
      sourceId: datasetId,
      sourceVersionOrRevision: 1,
      targetKind: "document",
      targetId: "art_payroll_2026_restricted",
      targetRevision: 1,
      relationship: "derived_from",
      requiredClassification: "restricted",
      allowedDepartments: ["Retail"],
      requiredColumns: ["grossSales", "cogs", "opex"],
    });

    await expect(
      engine.queryCertifiedResult(VIEWER_ACTOR, POLICY_SALES_RESTRICTED_NO_COGS, {
        datasetId,
        datasetVersion: 1,
        metricId: "FIN-OPERATING-PROFIT",
        requiredColumns: ["grossSales", "cogs", "opex"],
      }),
    ).rejects.toThrowError(/lacks read permission for column 'cogs'/);

    expect(() => engine.getArtifact(BETA_ACTOR, "art_payroll_2026_restricted")).toThrowError(/Cross-tenant/);

    // Verify PostgreSQL RLS under Beta tenant reads 0 Alpha packages
    const betaVisiblePackages = await withTenantTransaction(db, TENANT_BETA, async (tx) => {
      const res = await tx.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM xi_reporting_packages");
      return Number(res.rows[0]?.count ?? "0");
    });
    expect(betaVisiblePackages).toBe(0);

    // INT-T20: Limited caller inspecting dependency graph sees ZERO restricted payroll titles/IDs
    const fullDeps = engine.inspectDependencies(OWNER_ACTOR, POLICY_ALL_V1, {
      sourceId: datasetId,
      maxAllowedClassification: "restricted",
    });
    expect(fullDeps.visibleEdges.some((e) => e.targetId === "art_payroll_2026_restricted")).toBe(true);

    const limitedDeps = engine.inspectDependencies(EDITOR_ACTOR, POLICY_SALES_SCOPED_V1, {
      sourceId: datasetId,
      maxAllowedClassification: "confidential",
    });
    expect(limitedDeps.redactedCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(limitedDeps.visibleEdges)).not.toContain("art_payroll_2026_restricted");
    expect(JSON.stringify(limitedDeps.visibleEdges)).not.toContain("Executive Payroll");

    // INT-T11: Mid-workflow permission revocation stops next workflow step safely
    const revActor: ActorContext = {
      tenantId: TENANT_ALPHA,
      workspaceId: WS_ALPHA,
      userId: REVOKABLE_EDITOR_ID,
      role: "editor",
    };
    const wfRevokePaused = await engine.startMonthlyReportingWorkflow(revActor, POLICY_ALL_V1, {
      idempotencyKey: "wf_revoke_midrun_1",
      context: {
        tenantId: TENANT_ALPHA,
        workspaceId: WS_ALPHA,
        periodStart: "2026-11-01",
        periodEndExclusive: "2026-12-01",
        datasetId,
        datasetVersion: 1,
        metricIds: ["FIN-NET-SALES"],
        currency: "USD",
        language: "en",
        themeId: "theme_corporate_navy",
        themeVersion: 1,
      },
      pauseAfterStep: "stage_document",
    });
    engine.revokePrincipal(TENANT_ALPHA, REVOKABLE_EDITOR_ID);
    await expect(engine.resumeWorkflow(revActor, POLICY_ALL_V1, wfRevokePaused.run.runId)).rejects.toThrowError(/revoked/i);

    // INT-T24: Policy scope reduction invalidates cached results -> never serves leaked prior $150k cache
    engine.setPrincipalPolicy(EDITOR_ID, POLICY_ALL_V1);
    const beforeChange = await engine.queryCertifiedResult(EDITOR_ACTOR, POLICY_ALL_V1, {
      datasetId,
      datasetVersion: 1,
      metricId: "FIN-NET-SALES",
    });
    expect(beforeChange.result.value.displayValue).toBe("$150,000.00");

    const narrowPolicy: DataScopePolicy = { ...POLICY_SALES_SCOPED_V1, policyVersion: 2 };
    engine.setPrincipalPolicy(EDITOR_ID, narrowPolicy);
    const afterChange = await engine.queryCertifiedResult(EDITOR_ACTOR, narrowPolicy, {
      datasetId,
      datasetVersion: 1,
      metricId: "FIN-NET-SALES",
    });
    expect(afterChange.cacheHit).toBe(false);
    expect(afterChange.result.value.displayValue).toBe("$80,000.00");
    expect(afterChange.resultRef.effectivePolicyScope).toBe("pol_sales_only:v2");

    // INT-T19 & INT-T21: Sales-only PPTX export omits Services/Retail, invoice IDs, and speaker notes; Viewer blocked on export
    const salesBundle = await engine.syncWorkspaceModules(EDITOR_ACTOR, narrowPolicy, {
      datasetId,
      datasetVersion: 1,
    });
    await expect(
      engine.exportPackagePresentationPptx(VIEWER_ACTOR, salesBundle.presentation.presentationId, {
        includeSpeakerNotes: false,
        includeHiddenSlides: false,
      }),
    ).rejects.toThrowError(/not authorized for export:export/);

    const exportedSalesPptx = await engine.exportPackagePresentationPptx(
      EDITOR_ACTOR,
      salesBundle.presentation.presentationId,
      { includeSpeakerNotes: false, includeHiddenSlides: false },
    );
    const unzipped = unzipSync(new Uint8Array(exportedSalesPptx.buffer));
    const xmlAll = Object.entries(unzipped)
      .filter(([name]) => name.endsWith(".xml"))
      .map(([name, bytes]) => `${name}:::${Buffer.from(bytes).toString("utf8")}`)
      .join("\n");
    const notesXml = Object.entries(unzipped)
      .filter(([name]) => name.startsWith("ppt/notesSlides/") && name.endsWith(".xml"))
      .map(([, bytes]) => Buffer.from(bytes).toString("utf8"))
      .join("\n");

    expect(xmlAll).toContain("80000");
    expect(xmlAll).not.toContain("Services");
    expect(xmlAll).not.toContain("Retail");
    expect(xmlAll).not.toContain("S12-NOV-SAL1");
    expect(notesXml).not.toContain("Observed KPI figures");

    // INT-T18: Equivalent EN & KM Cross-module Workflow Planner parity & unapproved auto-publish refusal
    const enPlan = planCrossModuleWorkflow({
      command: "Use the approved financial data to create a monthly management report, presentation and dashboard.",
      inputLanguage: "en",
      hasReportingPeriodContext: true,
    });
    const kmPlan = planCrossModuleWorkflow({
      command: "សូមប្រើទិន្នន័យហិរញ្ញវត្ថុដែលបានអនុម័ត ដើម្បីបង្កើតរបាយការណ៍គ្រប់គ្រងប្រចាំខែ បទបង្ហាញ និងផ្ទាំងព័ត៌មាន។",
      inputLanguage: "km",
      hasReportingPeriodContext: true,
    });
    expect(enPlan.action).toBe("create_monthly_package");
    expect(kmPlan.action).toBe(enPlan.action);
    expect(kmPlan.workflowType).toBe(enPlan.workflowType);
    expect(kmPlan.proposedTools).toEqual(enPlan.proposedTools);
    expect(kmPlan.isMockPlanner).toBe(true);
    expect(kmPlan.requiresApproval).toBe(true);

    const kmClarify = planCrossModuleWorkflow({
      command: "បង្កើតកញ្ចប់របាយការណ៍គ្រប់គ្រងប្រចាំខែ",
      inputLanguage: "km",
      hasReportingPeriodContext: false,
    });
    expect(kmClarify.clarificationRequired).toBe(true);

    const autoPublishBlocked = planCrossModuleWorkflow({
      command: "Create monthly report and auto publish immediately",
      inputLanguage: "en",
    });
    expect(autoPublishBlocked.blockedDirectExecution).toBe(true);

    const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
    console.info("XI-00 Integration Telemetry:", JSON.stringify({ securityAndSyncTestMs: elapsedMs, verifiedScenarios: "INT-T01..INT-T24" }));
  });
});
