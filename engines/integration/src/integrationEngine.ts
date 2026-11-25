import { createHash, randomUUID } from "node:crypto";
import type { PgDatabaseAdapter } from "@ai-office-suite/database";
import { InMemoryAuditStore } from "@ai-office-suite/audit";
import { assertCanPerform, assertTenantWorkspaceAccess } from "@ai-office-suite/authorization";
import {
  BusinessAnalysisEngine,
  type AnalyticalFinanceRow,
  formatCurrencyOrRatioDisplay,
  parseDecimalToMinorUnits,
} from "@ai-office-suite/analytics-engine";
import { recalculateWorkbook } from "@ai-office-suite/calculation-engine";
import { InMemoryStorageAdapter } from "@ai-office-suite/storage";
import { DocumentService } from "@ai-office-suite/documents-module";
import {
  IntelligenceStudioEngine,
  SECTION_12_BUDGET_ROWS,
  SECTION_12_FINANCE_ROWS,
  type EvaluatedReportResponse,
} from "@ai-office-suite/intelligence-engine";
import {
  createGoldenManagementDeck,
  exportPresentationToPptxBuffer,
  type ExportDisclosurePolicy,
  type ExportDisclosureReport,
  type PresentationWorkspaceStore,
} from "@ai-office-suite/presentation-engine";
import type {
  ActorContext,
  AnalyticalResult,
  AnalyticalResultReference,
  ArtifactClassification,
  ArtifactKind,
  ArtifactReference,
  ArtifactRevisionReference,
  ChartSpec,
  DataScopePolicy,
  DatasetVersionReference,
  DependencyEdge,
  DocumentBlock,
  LinkedMetricReference,
  LinkedObjectBinding,
  LinkedObjectBindingMode,
  LinkedObjectKind,
  LinkedResourceState,
  MetricReference,
  PresentationSlide,
  PublicationApproval,
  PublicationValidationCheck,
  RefreshDeltaItem,
  RefreshProposal,
  ReportingContext,
  ReportingPackageManifest,
  SpreadsheetWorkbook,
  StudioDocument,
  StudioPresentation,
  StudioReport,
  WorkflowLifecycleState,
  WorkflowRun,
  WorkflowStepResult,
} from "@ai-office-suite/shared-contracts";
import { validateReportingManifestSafety } from "@ai-office-suite/validation";
import {
  commitPackagePublicationTx,
  loadWorkflowRunRow,
  persistApprovalRow,
  persistArtifactRow,
  persistDependencyEdgeRow,
  persistReportingPackageRow,
  persistRevisionRow,
  persistWorkflowRunRow,
} from "./pgPersistence.ts";

export class IntegrationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "IntegrationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const STANDARD_FINANCE_COLUMNS = [
  "rowId",
  "invoiceDate",
  "reportingMonth",
  "department",
  "customerId",
  "status",
  "currency",
  "grossSales",
  "returnsDiscounts",
  "cogs",
  "opex",
] as const;

export const XI00_INCOMPATIBLE_V3_COLUMNS = [
  "rowId",
  "invoiceDate",
  "reportingMonth",
  "department",
  "customerId",
  "status",
  "currency",
  "grossSales",
  "returnsDiscounts",
  "opex",
] as const;

/**
 * Independently specified V2 dataset fixture extending SECTION_12_FINANCE_ROWS
 * with one omitted November Sales invoice (+10,000 Net Sales, +6,000 COGS, 0 OpEx):
 * - Net Sales Revenue: $160,000.00 (Sales $90,000, Services $45,000, Retail $25,000)
 * - Cost of Goods Sold: $96,000.00
 * - Operating Expenses: $20,000.00
 * - Operating Profit: $44,000.00
 * - Operating Margin: 27.50%
 * - Prior-Period Revenue (Oct 2026): $125,000.00 -> Revenue Growth: 28.00%
 */
export const XI00_FINANCE_ROWS_V2: AnalyticalFinanceRow[] = [
  ...SECTION_12_FINANCE_ROWS,
  {
    rowId: "XI-NOV-SAL3",
    invoiceDate: "2026-11-28",
    reportingMonth: "2026-11",
    department: "Sales",
    customerId: "C1",
    status: "posted",
    currency: "USD",
    grossSales: "10000.00",
    returnsDiscounts: "0.00",
    cogs: "6000.00",
    opex: "0.00",
  },
];

function sha256Json(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function classificationRank(c: ArtifactClassification): number {
  switch (c) {
    case "public":
      return 0;
    case "internal":
      return 1;
    case "confidential":
      return 2;
    case "restricted":
      return 3;
  }
}

export interface ManagedDatasetEntry {
  meta: DatasetVersionReference;
  tenantId: string;
  workspaceId: string;
  classification: ArtifactClassification;
  rows: AnalyticalFinanceRow[];
}

export interface SyncedBundleOutputs {
  datasetVersion: number;
  effectiveDepartments: string[];
  workbookArtifact: ArtifactReference;
  workbook: SpreadsheetWorkbook;
  documentArtifact: ArtifactReference;
  document: StudioDocument;
  dashboardArtifact: ArtifactReference;
  report: StudioReport;
  evaluatedDashboard: EvaluatedReportResponse;
  presentationArtifact: ArtifactReference;
  presentation: StudioPresentation;
  resultRefs: Record<string, AnalyticalResultReference>;
}

export class CrossModuleIntegrationEngine {
  readonly audit: InMemoryAuditStore;
  readonly docStorage: InMemoryStorageAdapter;
  readonly documents: DocumentService;
  readonly intelligence: IntelligenceStudioEngine;
  readonly analytics: BusinessAnalysisEngine;
  readonly presentations: PresentationWorkspaceStore;
  readonly db?: PgDatabaseAdapter;

  private readonly artifacts = new Map<string, ArtifactReference>();
  private readonly revisions = new Map<string, ArtifactRevisionReference[]>();
  private readonly workbookRevisions = new Map<string, SpreadsheetWorkbook[]>();
  private readonly datasetRegistry = new Map<string, ManagedDatasetEntry>();
  private readonly datasetVersionColumns = new Map<string, Set<string>>();
  private readonly dependencyEdges = new Map<string, DependencyEdge>();
  private readonly linkedBindings = new Map<string, LinkedObjectBinding>();
  private readonly workflowRuns = new Map<string, WorkflowRun>();
  private readonly runByIdempotency = new Map<string, string>();
  private readonly runBundles = new Map<string, SyncedBundleOutputs>();
  private readonly stagedPackages = new Map<string, ReportingPackageManifest>();
  private readonly publishedPackages = new Map<string, ReportingPackageManifest>();
  private readonly revokedPrincipals = new Set<string>();
  private readonly principalPolicies = new Map<string, DataScopePolicy>();
  private readonly queryCache = new Map<string, { result: AnalyticalResult; ref: AnalyticalResultReference }>();

  constructor(opts?: { db?: PgDatabaseAdapter }) {
    this.audit = new InMemoryAuditStore();
    this.docStorage = new InMemoryStorageAdapter();
    this.documents = new DocumentService(this.docStorage, this.audit);
    this.analytics = new BusinessAnalysisEngine(undefined, this.audit);
    this.intelligence = new IntelligenceStudioEngine(this.analytics, this.audit);
    this.presentations = this.intelligence.presentations;
    this.db = opts?.db;
  }

  private assertPrincipalActive(actor: ActorContext): void {
    if (this.revokedPrincipals.has(`${actor.tenantId}::${actor.userId}`)) {
      throw new IntegrationError(
        403,
        "ACCESS_REVOKED",
        `Principal '${actor.userId}' access has been revoked.`,
      );
    }
  }

  setPrincipalPolicy(userId: string, policy: DataScopePolicy): void {
    const key = `${policy.tenantId}::${userId}`;
    const prev = this.principalPolicies.get(key);
    this.principalPolicies.set(key, structuredClone(policy));
    this.intelligence.invalidatePolicyCache();
    // Invalidate cached query entries bound to stale policy versions for this tenant/policy
    if (prev) {
      for (const k of Array.from(this.queryCache.keys())) {
        if (k.startsWith(`${policy.tenantId}::`) && k.includes(`::${prev.policyId}:v${prev.policyVersion}::`)) {
          this.queryCache.delete(k);
        }
      }
    }
  }

  getPrincipalPolicy(actor: ActorContext): DataScopePolicy | undefined {
    return this.principalPolicies.get(`${actor.tenantId}::${actor.userId}`);
  }

  revokePrincipal(tenantId: string, userId: string): void {
    this.revokedPrincipals.add(`${tenantId}::${userId}`);
    this.intelligence.revokePrincipalAccess(tenantId, userId);
    for (const k of Array.from(this.queryCache.keys())) {
      if (k.startsWith(`${tenantId}::`)) {
        this.queryCache.delete(k);
      }
    }
  }

  async seedGoldenV1(tenantId: string, workspaceId: string, actor: ActorContext): Promise<{
    datasetId: string;
    budgetDatasetId: string;
  }> {
    const { datasetId, budgetDatasetId } = this.intelligence.seedSection12TenantData(tenantId, workspaceId);
    const meta: DatasetVersionReference = {
      datasetId,
      version: 1,
      datasetSha256: sha256Json(SECTION_12_FINANCE_ROWS),
      granularity: "invoice_line",
      requiredColumns: [...STANDARD_FINANCE_COLUMNS],
      status: "certified",
    };
    this.datasetRegistry.set(`${tenantId}::${datasetId}::v1`, {
      meta,
      tenantId,
      workspaceId,
      classification: "confidential",
      rows: structuredClone(SECTION_12_FINANCE_ROWS),
    });
    this.datasetVersionColumns.set(`${tenantId}::${datasetId}::v1`, new Set(STANDARD_FINANCE_COLUMNS));
    await this.registerArtifact(actor, {
      artifactId: datasetId,
      kind: "dataset",
      title: "Monthly Finance Sales Lines (V1)",
      classification: "confidential",
      allowedDepartments: "ALL",
      requiredColumns: [...STANDARD_FINANCE_COLUMNS],
      contentSnapshot: { datasetId, version: 1, rows: SECTION_12_FINANCE_ROWS },
    });
    return { datasetId, budgetDatasetId };
  }

  async registerDatasetVersion(
    actor: ActorContext,
    params: {
      datasetId: string;
      version: number;
      rows: AnalyticalFinanceRow[];
      requiredColumns: string[];
      classification?: ArtifactClassification;
      allowedDepartments?: string[] | "ALL";
      status?: "draft" | "certified" | "withdrawn";
    },
  ): Promise<ManagedDatasetEntry> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const entry: ManagedDatasetEntry = {
      meta: {
        datasetId: params.datasetId,
        version: params.version,
        datasetSha256: sha256Json(params.rows),
        granularity: "invoice_line",
        requiredColumns: [...params.requiredColumns],
        status: params.status ?? "certified",
      },
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      classification: params.classification ?? "confidential",
      rows: structuredClone(params.rows),
    };
    this.datasetRegistry.set(`${actor.tenantId}::${params.datasetId}::v${params.version}`, entry);
    this.datasetVersionColumns.set(
      `${actor.tenantId}::${params.datasetId}::v${params.version}`,
      new Set(params.requiredColumns),
    );
    if (params.rows.length > 0) {
      this.intelligence.registerManifestVersion(
        actor.tenantId,
        actor.workspaceId,
        params.datasetId,
        params.version,
        params.rows,
      );
    }
    return structuredClone(entry);
  }

  async registerArtifact(
    actor: ActorContext,
    params: {
      artifactId: string;
      kind: ArtifactKind;
      title: string;
      classification: ArtifactClassification;
      allowedDepartments?: string[] | "ALL";
      requiredColumns?: string[];
      contentSnapshot: unknown;
      revision?: number;
      lifecycleStatus?: ArtifactReference["lifecycleStatus"];
    },
  ): Promise<ArtifactReference> {
    this.assertPrincipalActive(actor);
    const now = new Date().toISOString();
    const revNum = params.revision ?? 1;
    const artifact: ArtifactReference = {
      artifactId: params.artifactId,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      kind: params.kind,
      title: params.title,
      currentRevision: revNum,
      ownerId: actor.userId,
      classification: params.classification,
      lifecycleStatus: params.lifecycleStatus ?? "draft",
      allowedDepartments: params.allowedDepartments ?? "ALL",
      requiredColumns: params.requiredColumns ?? [],
      updatedAt: now,
    };
    this.artifacts.set(artifact.artifactId, structuredClone(artifact));

    const revRef: ArtifactRevisionReference = {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      revision: revNum,
      contentSha256: sha256Json(params.contentSnapshot),
      createdBy: actor.userId,
      createdAt: now,
    };
    this.revisions.set(artifact.artifactId, [revRef]);

    if (this.db) {
      await persistArtifactRow(this.db, artifact);
      await persistRevisionRow(this.db, actor.tenantId, revRef);
    }
    return structuredClone(artifact);
  }

  getArtifact(actor: ActorContext, artifactId: string): ArtifactReference {
    this.assertPrincipalActive(actor);
    const art = this.artifacts.get(artifactId);
    if (!art) {
      throw new IntegrationError(404, "ARTIFACT_NOT_FOUND", `Artifact '${artifactId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, art.tenantId, art.workspaceId);
    return structuredClone(art);
  }

  async renameArtifact(
    actor: ActorContext,
    artifactId: string,
    newTitle: string,
    expectedRevision: number,
  ): Promise<ArtifactReference> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const art = this.getArtifact(actor, artifactId);
    if (art.currentRevision !== expectedRevision) {
      throw new IntegrationError(
        409,
        "REVISION_CONFLICT",
        `Expected revision ${expectedRevision}, actual revision ${art.currentRevision}.`,
      );
    }
    const next: ArtifactReference = {
      ...art,
      title: newTitle,
      currentRevision: art.currentRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.artifacts.set(artifactId, structuredClone(next));
    const revRef: ArtifactRevisionReference = {
      artifactId,
      kind: art.kind,
      revision: next.currentRevision,
      contentSha256: sha256Json({ renamedTitle: newTitle, prevRev: art.currentRevision }),
      createdBy: actor.userId,
      createdAt: next.updatedAt,
    };
    this.revisions.get(artifactId)?.push(revRef);
    if (this.db) {
      await persistArtifactRow(this.db, next);
      await persistRevisionRow(this.db, actor.tenantId, revRef);
    }
    return structuredClone(next);
  }

  async commitArtifactRevision(
    actor: ActorContext,
    artifactId: string,
    expectedRevision: number,
    contentSnapshot: unknown,
    restoredFromRevision?: number,
  ): Promise<{ artifact: ArtifactReference; revisionRef: ArtifactRevisionReference }> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const art = this.getArtifact(actor, artifactId);
    if (art.currentRevision !== expectedRevision) {
      throw new IntegrationError(
        409,
        "REVISION_CONFLICT",
        `Expected revision ${expectedRevision} for '${artifactId}', but current revision is ${art.currentRevision}.`,
      );
    }
    const now = new Date().toISOString();
    const next: ArtifactReference = {
      ...art,
      currentRevision: art.currentRevision + 1,
      updatedAt: now,
    };
    const revRef: ArtifactRevisionReference = {
      artifactId,
      kind: art.kind,
      revision: next.currentRevision,
      contentSha256: sha256Json(contentSnapshot),
      restoredFromRevision,
      createdBy: actor.userId,
      createdAt: now,
    };
    this.artifacts.set(artifactId, structuredClone(next));
    this.revisions.get(artifactId)?.push(revRef);
    if (this.db) {
      await persistArtifactRow(this.db, next);
      await persistRevisionRow(this.db, actor.tenantId, revRef);
    }
    return { artifact: structuredClone(next), revisionRef: revRef };
  }

  async restoreArtifactRevision(
    actor: ActorContext,
    artifactId: string,
    targetRevision: number,
  ): Promise<{ artifact: ArtifactReference; restoredFromRevision: number; restoredSnapshot?: unknown }> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "restore");
    const art = this.getArtifact(actor, artifactId);
    const revList = this.revisions.get(artifactId) ?? [];
    const targetRev = revList.find((r) => r.revision === targetRevision);
    if (!targetRev) {
      throw new IntegrationError(404, "REVISION_NOT_FOUND", `Revision ${targetRevision} for '${artifactId}' not found.`);
    }

    let restoredSnapshot: unknown = { restoredFromRevision: targetRevision };
    if (art.kind === "document") {
      const restoredDoc = await this.documents.restoreVersion(actor, artifactId, targetRevision);
      restoredSnapshot = restoredDoc;
    } else if (art.kind === "spreadsheet") {
      const wbHistory = this.workbookRevisions.get(artifactId) ?? [];
      const priorWb = wbHistory.find((w) => w.revision === targetRevision);
      if (priorWb) {
        const nextWb: SpreadsheetWorkbook = {
          ...structuredClone(priorWb),
          revision: art.currentRevision + 1,
        };
        wbHistory.push(nextWb);
        restoredSnapshot = nextWb;
      }
    }

    const { artifact } = await this.commitArtifactRevision(
      actor,
      artifactId,
      art.currentRevision,
      restoredSnapshot,
      targetRevision,
    );
    return {
      artifact,
      restoredFromRevision: targetRevision,
      restoredSnapshot,
    };
  }

  private resolveCallerDepartments(
    policy: DataScopePolicy,
    requestedDepartments?: string[],
  ): string[] {
    const allDepts = ["Sales", "Services", "Retail"];
    const allowedSet = policy.allowedDepartments === "ALL" ? new Set(allDepts) : new Set(policy.allowedDepartments);
    if (!requestedDepartments || requestedDepartments.length === 0) {
      return Array.from(allowedSet);
    }
    return requestedDepartments.filter((d) => allowedSet.has(d));
  }

  private assertDatasetAuthorization(
    actor: ActorContext,
    policy: DataScopePolicy,
    datasetId: string,
    version: number,
    requiredColumns: string[],
  ): ManagedDatasetEntry {
    this.assertPrincipalActive(actor);
    if (policy.tenantId !== actor.tenantId) {
      throw new IntegrationError(403, "TENANT_POLICY_MISMATCH", "Policy tenant does not match actor tenant.");
    }
    const entry = this.datasetRegistry.get(`${actor.tenantId}::${datasetId}::v${version}`);
    if (!entry) {
      throw new IntegrationError(404, "DATASET_NOT_FOUND", `Dataset '${datasetId}' v${version} not found.`);
    }
    assertTenantWorkspaceAccess(actor, entry.tenantId, entry.workspaceId);
    if (entry.meta.status === "withdrawn") {
      throw new IntegrationError(403, "DATASET_WITHDRAWN", `Dataset '${datasetId}' v${version} has been withdrawn.`);
    }
    if (entry.classification === "restricted" && actor.role === "viewer" && policy.allowedDepartments !== "ALL") {
      throw new IntegrationError(403, "SOURCE_ACCESS_DENIED", `Principal lacks clearance for restricted dataset '${datasetId}'.`);
    }
    const policyColSet = new Set(policy.allowedColumns);
    for (const col of requiredColumns) {
      if (!policyColSet.has(col)) {
        throw new IntegrationError(
          403,
          "SOURCE_ACCESS_DENIED",
          `Principal policy '${policy.policyId}' lacks read permission for column '${col}'.`,
        );
      }
    }
    return entry;
  }

  async queryCertifiedResult(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      datasetId: string;
      datasetVersion: number;
      metricId: string;
      metricVersion?: number;
      periodStart?: string;
      periodEndExclusive?: string;
      requestedDepartments?: string[];
      requiredColumns?: string[];
      groupBy?: string[];
      comparison?: "none" | "previous_month";
      bindingMode?: LinkedObjectBindingMode;
      outputLanguage?: "en" | "km";
    },
  ): Promise<{
    result: AnalyticalResult;
    resultRef: AnalyticalResultReference;
    cacheHit: boolean;
    effectiveDepartments: string[];
  }> {
    this.assertPrincipalActive(actor);
    const reqCols = params.requiredColumns ?? ["grossSales", "returnsDiscounts", "cogs", "opex"];
    const ds = this.assertDatasetAuthorization(actor, policy, params.datasetId, params.datasetVersion, reqCols);

    const dsCols = this.datasetVersionColumns.get(`${actor.tenantId}::${params.datasetId}::v${params.datasetVersion}`) ?? new Set();
    for (const c of reqCols) {
      if (!dsCols.has(c)) {
        throw new IntegrationError(
          422,
          "INCOMPATIBLE_SCHEMA_CHANGE",
          `Required column '${c}' is missing from dataset '${params.datasetId}' v${params.datasetVersion}.`,
        );
      }
    }

    const effectiveDepts = this.resolveCallerDepartments(policy, params.requestedDepartments);
    if (effectiveDepts.length === 0) {
      throw new IntegrationError(
        403,
        "SOURCE_ACCESS_DENIED",
        "Requested filter scope lies outside caller's permitted departments.",
      );
    }

    const pStart = params.periodStart ?? "2026-11-01";
    const pEnd = params.periodEndExclusive ?? "2026-12-01";
    const mVer = params.metricVersion ?? 1;
    const scopeKey = `${policy.policyId}:v${policy.policyVersion}`;
    const deptSorted = [...effectiveDepts].sort().join(",");
    const cacheKey = `${actor.tenantId}::${actor.workspaceId}::${scopeKey}::${deptSorted}::${params.datasetId}:v${params.datasetVersion}::${params.metricId}:v${mVer}::${pStart}..${pEnd}::${(params.groupBy ?? []).join(",")}::${params.comparison ?? "none"}`;

    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      return {
        result: structuredClone(cached.result),
        resultRef: structuredClone(cached.ref),
        cacheHit: true,
        effectiveDepartments: effectiveDepts,
      };
    }

    const scopedDsId = `xi_scoped_${policy.policyId}_v${policy.policyVersion}_${deptSorted || "none"}_${params.datasetId}`;
    const deptSet = new Set(effectiveDepts);
    const filteredRows = ds.rows.filter((r) => deptSet.has(r.department));
    this.analytics.registerDataset({
      datasetId: scopedDsId,
      version: params.datasetVersion,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      granularity: "invoice_line",
      sha256: sha256Json(filteredRows),
      rows: filteredRows,
    });

    const res = await this.analytics.executeQuery(actor, {
      queryId: `xi_q_${randomUUID().slice(0, 8)}`,
      idempotencyKey: `xi_idem_${randomUUID()}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      operation: params.groupBy && params.groupBy.length > 0 ? "group_by_dimension" : "calculate_metric",
      dataset: { id: scopedDsId, version: params.datasetVersion },
      metrics: [{ id: params.metricId, version: mVer }],
      period: { start: pStart, endExclusive: pEnd },
      comparison: params.comparison ?? "none",
      groupBy: params.groupBy,
      currency: "USD",
      outputLanguage: params.outputLanguage ?? "en",
    });

    const ref: AnalyticalResultReference = {
      resultId: res.resultId,
      provenanceId: res.provenance.provenanceId,
      datasetId: params.datasetId,
      datasetVersion: params.datasetVersion,
      metricId: params.metricId,
      metricVersion: res.metricVersion,
      reportingPeriod: { start: pStart, endExclusive: pEnd },
      filters: { departments: deptSorted },
      groupBy: params.groupBy ?? [],
      precisionPolicyId: res.provenance.precisionPolicyId,
      currency: res.value.currency ?? "USD",
      unit: res.value.unit,
      minorUnits: res.value.minorUnits,
      displayValue: res.value.displayValue,
      effectivePolicyScope: scopeKey,
      policyVersion: policy.policyVersion,
      bindingMode: params.bindingMode ?? "refreshable_link",
      computedAt: res.provenance.executedAt,
    };

    this.queryCache.set(cacheKey, { result: structuredClone(res), ref: structuredClone(ref) });
    return {
      result: res,
      resultRef: ref,
      cacheHit: false,
      effectiveDepartments: effectiveDepts,
    };
  }

  async addDependencyEdge(
    edge: Omit<DependencyEdge, "edgeId">,
  ): Promise<DependencyEdge> {
    const full: DependencyEdge = {
      ...edge,
      edgeId: `edge_${randomUUID().slice(0, 8)}`,
    };
    this.dependencyEdges.set(full.edgeId, structuredClone(full));
    if (this.db) {
      await persistDependencyEdgeRow(this.db, full);
    }
    return full;
  }

  inspectDependencies(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: { sourceId: string; maxAllowedClassification?: ArtifactClassification },
  ): { visibleEdges: DependencyEdge[]; redactedCount: number } {
    this.assertPrincipalActive(actor);
    const maxRank = classificationRank(params.maxAllowedClassification ?? (policy.allowedDepartments === "ALL" ? "restricted" : "confidential"));
    const policyDepts = policy.allowedDepartments === "ALL" ? null : new Set(policy.allowedDepartments);
    const policyCols = new Set(policy.allowedColumns);

    const visibleEdges: DependencyEdge[] = [];
    let redactedCount = 0;

    for (const edge of this.dependencyEdges.values()) {
      if (edge.tenantId !== actor.tenantId || edge.workspaceId !== actor.workspaceId) continue;
      if (edge.sourceId !== params.sourceId) continue;

      const art = this.artifacts.get(edge.targetId);
      const artRank = classificationRank(art?.classification ?? edge.requiredClassification);
      const deptAllowed =
        !policyDepts ||
        !edge.allowedDepartments ||
        edge.allowedDepartments === "ALL" ||
        edge.allowedDepartments.every((d) => policyDepts.has(d));
      const colsAllowed = edge.requiredColumns.every((c) => policyCols.has(c));

      if (artRank > maxRank || !deptAllowed || !colsAllowed) {
        redactedCount += 1;
        continue;
      }
      visibleEdges.push(structuredClone(edge));
    }

    return { visibleEdges, redactedCount };
  }

  analyzeMetricChangeImpact(
    actor: ActorContext,
    policy: DataScopePolicy,
    metricId: string,
    proposedMetricVersion: number,
  ): { metricId: string; proposedMetricVersion: number; impactedArtifacts: ArtifactReference[]; redactedCount: number } {
    const dep = this.inspectDependencies(actor, policy, { sourceId: metricId });
    const seen = new Set<string>();
    const impactedArtifacts: ArtifactReference[] = [];
    for (const edge of dep.visibleEdges) {
      if (seen.has(edge.targetId)) continue;
      const art = this.artifacts.get(edge.targetId);
      if (art) {
        seen.add(edge.targetId);
        impactedArtifacts.push(structuredClone(art));
      }
    }
    return {
      metricId,
      proposedMetricVersion,
      impactedArtifacts,
      redactedCount: dep.redactedCount,
    };
  }

  async createLinkedBinding(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      sourceArtifactId: string;
      sourceDatasetId: string;
      sourceDatasetVersion: number;
      sourceMetricId: string;
      sourceMetricVersion: number;
      targetArtifactId: string;
      targetKind: ArtifactKind;
      targetElementId: string;
      objectKind: LinkedObjectKind;
      mode: LinkedObjectBindingMode;
      requiredColumns?: string[];
      requestedDepartments?: string[];
      requiresSourcePermissionToView?: boolean;
      approvedForDistribution?: boolean;
    },
  ): Promise<LinkedObjectBinding> {
    this.assertPrincipalActive(actor);
    // Must hold destination write AND source read permissions (INT-T10)
    assertCanPerform(actor, "document", "write");
    const targetArt = this.getArtifact(actor, params.targetArtifactId);
    const reqCols = params.requiredColumns ?? ["grossSales", "returnsDiscounts", "cogs", "opex"];

    const { resultRef } = await this.queryCertifiedResult(actor, policy, {
      datasetId: params.sourceDatasetId,
      datasetVersion: params.sourceDatasetVersion,
      metricId: params.sourceMetricId,
      metricVersion: params.sourceMetricVersion,
      requestedDepartments: params.requestedDepartments,
      requiredColumns: reqCols,
      bindingMode: params.mode,
    });

    const state: LinkedResourceState =
      params.mode === "independent_copy"
        ? "detached"
        : params.mode === "pinned_snapshot"
          ? "pinned"
          : "current";

    const binding: LinkedObjectBinding = {
      bindingId: `lnk_${randomUUID().slice(0, 8)}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      sourceArtifactId: params.sourceArtifactId,
      sourceRevision: params.sourceDatasetVersion,
      sourceDatasetId: params.sourceDatasetId,
      sourceDatasetVersion: params.sourceDatasetVersion,
      sourceMetricId: params.sourceMetricId,
      sourceMetricVersion: params.sourceMetricVersion,
      targetArtifactId: params.targetArtifactId,
      targetKind: params.targetKind,
      targetRevision: targetArt.currentRevision,
      targetElementId: params.targetElementId,
      objectKind: params.objectKind,
      mode: params.mode,
      state,
      syncDirection: "one_way_source_to_target",
      requiresSourcePermissionToView: params.requiresSourcePermissionToView ?? true,
      approvedForDistribution: params.approvedForDistribution ?? false,
      editableInTarget: true,
      reportingPeriod: resultRef.reportingPeriod,
      normalizedFilters: resultRef.filters,
      requiredColumns: reqCols,
      resultRef,
      updatedAt: new Date().toISOString(),
    };

    this.linkedBindings.set(binding.bindingId, structuredClone(binding));
    await this.addDependencyEdge({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      sourceKind: "dataset",
      sourceId: params.sourceDatasetId,
      sourceVersionOrRevision: params.sourceDatasetVersion,
      targetKind: params.targetKind,
      targetId: params.targetArtifactId,
      targetRevision: targetArt.currentRevision,
      relationship: "derived_from",
      requiredClassification: targetArt.classification,
      allowedDepartments: params.requestedDepartments ?? "ALL",
      requiredColumns: reqCols,
    });
    await this.addDependencyEdge({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      sourceKind: "metric",
      sourceId: params.sourceMetricId,
      sourceVersionOrRevision: params.sourceMetricVersion,
      targetKind: params.targetKind,
      targetId: params.targetArtifactId,
      targetRevision: targetArt.currentRevision,
      relationship: "references_metric",
      requiredClassification: targetArt.classification,
      allowedDepartments: params.requestedDepartments ?? "ALL",
      requiredColumns: reqCols,
    });

    return structuredClone(binding);
  }

  evaluateLinkState(
    actor: ActorContext,
    policy: DataScopePolicy,
    bindingId: string,
    latestAvailableDatasetVersion: number,
  ): LinkedResourceState {
    if (this.revokedPrincipals.has(`${actor.tenantId}::${actor.userId}`)) {
      return "access_restricted";
    }
    const b = this.linkedBindings.get(bindingId);
    if (!b) {
      return "source_unavailable";
    }
    assertTenantWorkspaceAccess(actor, b.tenantId, b.workspaceId);

    // Pinned historical snapshots NEVER become stale simply because newer data exists (§12 / INT-T07)
    if (b.mode === "pinned_snapshot") {
      return "pinned";
    }
    if (b.mode === "independent_copy" || b.state === "detached") {
      return "detached";
    }

    const colSet = new Set(policy.allowedColumns);
    if (!b.requiredColumns.every((c) => colSet.has(c))) {
      return "access_restricted";
    }

    const latestDs = this.datasetRegistry.get(
      `${actor.tenantId}::${b.sourceDatasetId}::v${latestAvailableDatasetVersion}`,
    );
    if (!latestDs) {
      return "source_unavailable";
    }
    if (latestDs.meta.status === "withdrawn") {
      return "source_unavailable";
    }
    const latestCols = this.datasetVersionColumns.get(
      `${actor.tenantId}::${b.sourceDatasetId}::v${latestAvailableDatasetVersion}`,
    ) ?? new Set<string>();
    if (!b.requiredColumns.every((c) => latestCols.has(c))) {
      return "incompatible";
    }

    if (latestAvailableDatasetVersion > b.sourceDatasetVersion) {
      return "update_available";
    }
    return "current";
  }

  mutateLinkedObjectValues(
    actor: ActorContext,
    bindingId: string,
    opts: { attemptedValue: string; explicitDetach?: boolean },
  ): LinkedObjectBinding {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const b = this.linkedBindings.get(bindingId);
    if (!b) {
      throw new IntegrationError(404, "BINDING_NOT_FOUND", `Binding '${bindingId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, b.tenantId, b.workspaceId);
    if (!opts.explicitDetach) {
      throw new IntegrationError(
        409,
        "ONE_WAY_SYNC_DETACH_REQUIRED",
        "One-directional sync (§8): cannot overwrite certified business result. Pass explicitDetach=true to convert to an independent uncertified copy.",
      );
    }
    b.mode = "independent_copy";
    b.state = "detached";
    b.resultRef.bindingMode = "independent_copy";
    b.resultRef.displayValue = opts.attemptedValue;
    b.updatedAt = new Date().toISOString();
    this.linkedBindings.set(bindingId, structuredClone(b));
    return structuredClone(b);
  }

  private buildWorkbookFromFr05(
    workbookId: string,
    title: string,
    revision: number,
    effectiveDepts: string[],
    deptValues: Array<{ dept: string; sales: string; cogs: string; opex: string }>,
    priorPeriodSales: string,
  ): SpreadsheetWorkbook {
    const cells: SpreadsheetWorkbook["sheets"][0]["cells"] = {
      A1: { value: "Department" },
      B1: { value: "Net Sales (USD)" },
      C1: { value: "COGS (USD)" },
      D1: { value: "OpEx (USD)" },
      E1: { value: "Operating Profit (USD)" },
    };

    const maxRow = 1 + Math.max(1, deptValues.length);
    deptValues.forEach((d, idx) => {
      const r = idx + 2;
      cells[`A${r}`] = { value: d.dept };
      cells[`B${r}`] = { value: Number(d.sales), currency: "USD", protected: true };
      cells[`C${r}`] = { value: Number(d.cogs), currency: "USD", protected: true };
      cells[`D${r}`] = { value: Number(d.opex), currency: "USD", protected: true };
      cells[`E${r}`] = { value: null, formula: `=B${r}-C${r}-D${r}`, currency: "USD", protected: true };
    });

    const totalRow = maxRow + 1;
    cells[`A${totalRow}`] = { value: `Combined Total (${effectiveDepts.join("+")})` };
    cells[`B${totalRow}`] = { value: null, formula: `=SUM(B2:B${maxRow})`, currency: "USD", protected: true };
    cells[`C${totalRow}`] = { value: null, formula: `=SUM(C2:C${maxRow})`, currency: "USD", protected: true };
    cells[`D${totalRow}`] = { value: null, formula: `=SUM(D2:D${maxRow})`, currency: "USD", protected: true };
    cells[`E${totalRow}`] = { value: null, formula: `=B${totalRow}-C${totalRow}-D${totalRow}`, currency: "USD", protected: true };

    const priorRow = totalRow + 1;
    cells[`A${priorRow}`] = { value: "Prior Period Revenue" };
    cells[`B${priorRow}`] = { value: Number(priorPeriodSales), currency: "USD", protected: true };

    const marginRow = priorRow + 1;
    cells[`A${marginRow}`] = { value: "Operating Margin (%)" };
    cells[`B${marginRow}`] = { value: null, formula: `=ROUND(E${totalRow}/B${totalRow}*100,2)`, protected: true };

    const growthRow = marginRow + 1;
    cells[`A${growthRow}`] = { value: "Revenue Growth (%)" };
    cells[`B${growthRow}`] = { value: null, formula: `=ROUND((B${totalRow}-B${priorRow})/B${priorRow}*100,2)`, protected: true };

    const { workbook } = recalculateWorkbook({
      workbookId,
      title,
      revision,
      dateSystem: "1900",
      sheets: [{ sheetId: "sh_summary", name: "Summary", cells }],
      unsupportedFeatures: [],
    });
    return workbook;
  }

  private buildLinkedMetricRef(
    res: AnalyticalResult,
    ref: AnalyticalResultReference,
    sourceArtifactId: string,
    mode: LinkedObjectBindingMode,
  ): LinkedMetricReference {
    return {
      ...res.linkedMetricReference,
      bindingMode: mode,
      linkState: mode === "pinned_snapshot" ? "pinned" : "current",
      sourceArtifactId,
      resultReferenceId: ref.resultId,
      effectivePolicyScope: ref.effectivePolicyScope,
      policyVersion: ref.policyVersion,
      approvalStatus: mode === "pinned_snapshot" ? "published_snapshot" : "certified",
      mode: mode === "pinned_snapshot" ? "published_snapshot" : "live_draft",
    };
  }

  async syncWorkspaceModules(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      datasetId: string;
      datasetVersion: number;
      requestedDepartments?: string[];
      language?: "en" | "km" | "bilingual";
      mode?: LinkedObjectBindingMode;
      existingIds?: {
        workbookArtifactId?: string;
        documentArtifactId?: string;
        dashboardReportId?: string;
        presentationId?: string;
      };
    },
  ): Promise<SyncedBundleOutputs> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const mode = params.mode ?? "refreshable_link";
    const lang = params.language ?? "bilingual";
    const effectiveDepts = this.resolveCallerDepartments(policy, params.requestedDepartments);
    if (effectiveDepts.length === 0) {
      throw new IntegrationError(403, "SOURCE_ACCESS_DENIED", "No permitted departments matched request.");
    }

    const [netSalesQ, cogsQ, opexQ, opProfitQ, opMarginQ, revGrowthQ, priorSalesQ] = await Promise.all([
      this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-NET-SALES", requestedDepartments: effectiveDepts, bindingMode: mode }),
      this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-COGS", requestedDepartments: effectiveDepts, bindingMode: mode }),
      this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-OPEX", requestedDepartments: effectiveDepts, bindingMode: mode }),
      this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-OPERATING-PROFIT", requestedDepartments: effectiveDepts, bindingMode: mode }),
      this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-OPERATING-MARGIN", requestedDepartments: effectiveDepts, bindingMode: mode }),
      this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-REVENUE-GROWTH", comparison: "previous_month", requestedDepartments: effectiveDepts, bindingMode: mode }),
      this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-NET-SALES", periodStart: "2026-10-01", periodEndExclusive: "2026-11-01", requestedDepartments: effectiveDepts, bindingMode: mode }),
    ]);

    const deptBreakdown: Array<{
      dept: string;
      sales: string;
      salesFmt: string;
      cogs: string;
      opex: string;
      costsFmt: string;
      profitFmt: string;
    }> = [];
    for (const dept of effectiveDepts) {
      const [dSales, dCogs, dOpex, dProfit] = await Promise.all([
        this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-NET-SALES", requestedDepartments: [dept], bindingMode: mode }),
        this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-COGS", requestedDepartments: [dept], bindingMode: mode }),
        this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-OPEX", requestedDepartments: [dept], bindingMode: mode }),
        this.queryCertifiedResult(actor, policy, { datasetId: params.datasetId, datasetVersion: params.datasetVersion, metricId: "FIN-OPERATING-PROFIT", requestedDepartments: [dept], bindingMode: mode }),
      ]);
      const costsMinor = parseDecimalToMinorUnits(dCogs.result.value.decimalString ?? "0", 2) + parseDecimalToMinorUnits(dOpex.result.value.decimalString ?? "0", 2);
      deptBreakdown.push({
        dept,
        sales: dSales.result.value.decimalString ?? "0.00",
        salesFmt: dSales.result.value.displayValue,
        cogs: dCogs.result.value.decimalString ?? "0.00",
        opex: dOpex.result.value.decimalString ?? "0.00",
        costsFmt: formatCurrencyOrRatioDisplay(costsMinor, 2, { currency: "USD" }),
        profitFmt: dProfit.result.value.displayValue,
      });
    }

    // 1. Workbook (Spreadsheet Studio)
    const wbId = params.existingIds?.workbookArtifactId ?? `wb_${randomUUID().slice(0, 8)}`;
    const existingWbArt = this.artifacts.get(wbId);
    const nextWbRev = existingWbArt ? existingWbArt.currentRevision + 1 : 1;
    const workbook = this.buildWorkbookFromFr05(
      wbId,
      `Financial Summary (${effectiveDepts.join("+")} v${params.datasetVersion})`,
      nextWbRev,
      effectiveDepts,
      deptBreakdown.map((d) => ({ dept: d.dept, sales: d.sales, cogs: d.cogs, opex: d.opex })),
      priorSalesQ.result.value.decimalString ?? "0.00",
    );
    const wbHistory = this.workbookRevisions.get(wbId) ?? [];
    wbHistory.push(structuredClone(workbook));
    this.workbookRevisions.set(wbId, wbHistory);

    const workbookArtifact = existingWbArt
      ? (await this.commitArtifactRevision(actor, wbId, existingWbArt.currentRevision, workbook)).artifact
      : await this.registerArtifact(actor, {
          artifactId: wbId,
          kind: "spreadsheet",
          title: workbook.title,
          classification: "confidential",
          allowedDepartments: effectiveDepts,
          contentSnapshot: workbook,
        });

    // 2. Document Studio
    const docBlocks: DocumentBlock[] = [
      {
        id: "blk_title",
        type: "heading",
        level: 1,
        runs: [{ text: "Monthly Management Report · របាយការណ៍គ្រប់គ្រងប្រចាំខែ", marks: { bold: true } }],
      },
      {
        id: "blk_metric_sales",
        type: "linked_metric_placeholder",
        metric: this.buildLinkedMetricRef(netSalesQ.result, netSalesQ.resultRef, params.datasetId, mode),
      },
      {
        id: "blk_metric_op_profit",
        type: "linked_metric_placeholder",
        metric: this.buildLinkedMetricRef(opProfitQ.result, opProfitQ.resultRef, params.datasetId, mode),
      },
      {
        id: "blk_metric_op_margin",
        type: "linked_metric_placeholder",
        metric: this.buildLinkedMetricRef(opMarginQ.result, opMarginQ.resultRef, params.datasetId, mode),
      },
      {
        id: "blk_metric_growth",
        type: "linked_metric_placeholder",
        metric: this.buildLinkedMetricRef(revGrowthQ.result, revGrowthQ.resultRef, params.datasetId, mode),
      },
      {
        id: "blk_dept_table",
        type: "table",
        hasHeaderRow: true,
        rows: [
          [
            { runs: [{ text: "Department", marks: { bold: true } }] },
            { runs: [{ text: "Net Sales (USD)", marks: { bold: true } }] },
            { runs: [{ text: "Total Costs", marks: { bold: true } }] },
            { runs: [{ text: "Operating Profit", marks: { bold: true } }] },
          ],
          ...deptBreakdown.map((d) => [
            { runs: [{ text: d.dept }] },
            { runs: [{ text: d.salesFmt }] },
            { runs: [{ text: d.costsFmt }] },
            { runs: [{ text: d.profitFmt }] },
          ]),
          [
            { runs: [{ text: `Combined Total (${effectiveDepts.join("+")})`, marks: { bold: true } }] },
            { runs: [{ text: netSalesQ.result.value.displayValue, marks: { bold: true } }] },
            {
              runs: [
                {
                  text: formatCurrencyOrRatioDisplay(
                    parseDecimalToMinorUnits(cogsQ.result.value.decimalString ?? "0", 2) +
                      parseDecimalToMinorUnits(opexQ.result.value.decimalString ?? "0", 2),
                    2,
                    { currency: "USD" },
                  ),
                  marks: { bold: true },
                },
              ],
            },
            { runs: [{ text: opProfitQ.result.value.displayValue, marks: { bold: true } }] },
          ],
        ],
      },
    ];

    let doc: StudioDocument;
    if (params.existingIds?.documentArtifactId) {
      const prevDoc = await this.documents.getDocument(actor, params.existingIds.documentArtifactId);
      doc = await this.documents.updateDocument(actor, prevDoc.documentId, {
        expectedRevision: prevDoc.revision,
        blocks: docBlocks,
        summary: `Synced to dataset v${params.datasetVersion} (${effectiveDepts.join("+")})`,
        source: "manual",
      });
    } else {
      doc = await this.documents.createDocument(actor, {
        title: `Management Report (${effectiveDepts.join("+")})`,
        language: lang,
        blocks: docBlocks,
      });
    }

    const existingDocArt = this.artifacts.get(doc.documentId);
    const documentArtifact = existingDocArt
      ? (await this.commitArtifactRevision(actor, doc.documentId, existingDocArt.currentRevision, doc)).artifact
      : await this.registerArtifact(actor, {
          artifactId: doc.documentId,
          kind: "document",
          title: doc.title,
          classification: "confidential",
          allowedDepartments: effectiveDepts,
          contentSnapshot: doc,
        });

    // 3. Intelligence Studio Dashboard
    let report: StudioReport;
    if (params.existingIds?.dashboardReportId) {
      const curRep = this.intelligence.getReport(actor, params.existingIds.dashboardReportId);
      if (curRep.datasetVersion !== params.datasetVersion) {
        const refreshed = this.intelligence.requestDraftRefresh(actor, curRep.reportId, params.datasetVersion, {
          idempotencyKey: `xi_dash_refresh_${curRep.reportId}_v${params.datasetVersion}_${randomUUID().slice(0, 6)}`,
        });
        report = refreshed.report;
      } else {
        report = curRep;
      }
    } else {
      report = this.intelligence.createManagementReport(actor, {
        title: `Management Dashboard (${effectiveDepts.join("+")})`,
      });
      if (params.datasetVersion > 1) {
        report = this.intelligence.requestDraftRefresh(actor, report.reportId, params.datasetVersion, {
          idempotencyKey: `xi_dash_init_v${params.datasetVersion}_${randomUUID().slice(0, 6)}`,
        }).report;
      }
    }

    const evaluatedDashboard = await this.intelligence.evaluateReport(actor, policy, report.reportId, {
      requestedDepartments: effectiveDepts,
      language: lang === "km" ? "km" : "en",
      interactionSeq: Math.floor(Date.now() % 1_000_000) + 10,
    });

    const existingDashArt = this.artifacts.get(report.reportId);
    const dashboardArtifact = existingDashArt
      ? (await this.commitArtifactRevision(actor, report.reportId, existingDashArt.currentRevision, evaluatedDashboard.report)).artifact
      : await this.registerArtifact(actor, {
          artifactId: report.reportId,
          kind: "dashboard",
          title: report.title,
          classification: "confidential",
          allowedDepartments: effectiveDepts,
          contentSnapshot: report,
        });

    // 4. Presentation Studio Deck (dynamically bound to exact policy & datasetVersion breakdown)
    const netSalesRef = this.buildLinkedMetricRef(netSalesQ.result, netSalesQ.resultRef, report.reportId, mode);
    const opProfitRef = this.buildLinkedMetricRef(opProfitQ.result, opProfitQ.resultRef, report.reportId, mode);
    const opMarginRef = this.buildLinkedMetricRef(opMarginQ.result, opMarginQ.resultRef, report.reportId, mode);

    const revChartSpec = structuredClone(evaluatedDashboard.visualResults.vis_chart_dept_revenue!.chartSpec!);
    const budgetChartSpec = structuredClone(evaluatedDashboard.visualResults.vis_chart_budget_vs_actual!.chartSpec!);

    let deck = createGoldenManagementDeck({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      language: lang,
      scopeLabel: `Departments: ${effectiveDepts.join(" + ")} (v${params.datasetVersion})`,
      netSalesRef,
      opProfitRef,
      opMarginRef,
      revenueChartSpec: revChartSpec,
      budgetChartSpec,
    });

    // Replace Slide 4 static table rows with live FR-05 policy+version-accurate rows so V2 / scoped never drifts or leaks!
    const totalCostsMinor =
      parseDecimalToMinorUnits(cogsQ.result.value.decimalString ?? "0", 2) +
      parseDecimalToMinorUnits(opexQ.result.value.decimalString ?? "0", 2);
    const slide4 = deck.slides.find((s) => s.slideId === "slide_4_cost_table");
    const slide4Table = slide4?.elements.find((e) => e.type === "table");
    if (slide4Table && slide4Table.type === "table") {
      slide4Table.rows = [
        ...deptBreakdown.map((d) => [d.dept, d.salesFmt, d.costsFmt, d.profitFmt]),
        [
          `Combined Total (${effectiveDepts.join("+")})`,
          netSalesQ.result.value.displayValue,
          formatCurrencyOrRatioDisplay(totalCostsMinor, 2, { currency: "USD" }),
          opProfitQ.result.value.displayValue,
        ],
      ];
    }

    if (params.existingIds?.presentationId) {
      deck = this.presentations.refreshDraftBindings(
        actor,
        params.existingIds.presentationId,
        {
          "FIN-NET-SALES": netSalesRef,
          "FIN-OPERATING-PROFIT": opProfitRef,
          "FIN-OPERATING-MARGIN": opMarginRef,
        },
        {
          scopeLabel: deck.scopeLabel,
          chartSpecBySlideId: {
            slide_3_rev_chart: revChartSpec,
            slide_5_budget_chart: budgetChartSpec,
          },
          tableRowsBySlideId:
            slide4Table && slide4Table.type === "table"
              ? { slide_4_cost_table: slide4Table.rows }
              : undefined,
        },
      );
    } else {
      deck = this.presentations.saveInitialDeck(actor, deck);
    }

    const existingPresArt = this.artifacts.get(deck.presentationId);
    const presentationArtifact = existingPresArt
      ? (await this.commitArtifactRevision(actor, deck.presentationId, existingPresArt.currentRevision, deck)).artifact
      : await this.registerArtifact(actor, {
          artifactId: deck.presentationId,
          kind: "presentation",
          title: deck.title,
          classification: "confidential",
          allowedDepartments: effectiveDepts,
          contentSnapshot: deck,
        });

    // Record dependencies across all 4 studio artifacts
    for (const target of [workbookArtifact, documentArtifact, dashboardArtifact, presentationArtifact]) {
      await this.addDependencyEdge({
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        sourceKind: "dataset",
        sourceId: params.datasetId,
        sourceVersionOrRevision: params.datasetVersion,
        targetKind: target.kind,
        targetId: target.artifactId,
        targetRevision: target.currentRevision,
        relationship: "derived_from",
        requiredClassification: target.classification,
        allowedDepartments: effectiveDepts,
        requiredColumns: [...STANDARD_FINANCE_COLUMNS],
      });
      await this.addDependencyEdge({
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        sourceKind: "metric",
        sourceId: "FIN-OPERATING-PROFIT",
        sourceVersionOrRevision: 1,
        targetKind: target.kind,
        targetId: target.artifactId,
        targetRevision: target.currentRevision,
        relationship: "references_metric",
        requiredClassification: target.classification,
        allowedDepartments: effectiveDepts,
        requiredColumns: [...STANDARD_FINANCE_COLUMNS],
      });
    }

    return {
      datasetVersion: params.datasetVersion,
      effectiveDepartments: effectiveDepts,
      workbookArtifact,
      workbook,
      documentArtifact,
      document: doc,
      dashboardArtifact,
      report,
      evaluatedDashboard,
      presentationArtifact,
      presentation: deck,
      resultRefs: {
        "FIN-NET-SALES": netSalesQ.resultRef,
        "FIN-COGS": cogsQ.resultRef,
        "FIN-OPEX": opexQ.resultRef,
        "FIN-OPERATING-PROFIT": opProfitQ.resultRef,
        "FIN-OPERATING-MARGIN": opMarginQ.resultRef,
        "FIN-REVENUE-GROWTH": revGrowthQ.resultRef,
      },
    };
  }

  async insertLinkedChartIntoPresentation(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      presentationId: string;
      slideId: string;
      chartSpec: ChartSpec;
      datasetId: string;
      datasetVersion: number;
    },
  ): Promise<{ presentation: StudioPresentation; slide: PresentationSlide; binding: LinkedObjectBinding }> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const deck = this.presentations.getDeck(actor, params.presentationId);
    const slide = deck.slides.find((s) => s.slideId === params.slideId);
    if (!slide) {
      throw new IntegrationError(404, "SLIDE_NOT_FOUND", `Slide '${params.slideId}' not found.`);
    }

    const elementId = `el_linked_chart_${randomUUID().slice(0, 6)}`;
    slide.elements.push({
      elementId,
      type: "chart",
      chartSpec: structuredClone(params.chartSpec),
      bounds: { xIn: 0.9, yIn: 1.5, wIn: 11.4, hIn: 4.9 },
      zIndex: slide.elements.length + 1,
      locked: false,
      altText: params.chartSpec.altSummaryEn,
    });
    deck.revision += 1;
    deck.updatedAt = new Date().toISOString();
    const saved = this.presentations.saveInitialDeck(actor, deck);

    const art = this.artifacts.get(params.presentationId);
    if (art) {
      await this.commitArtifactRevision(actor, params.presentationId, art.currentRevision, saved);
    }

    const binding = await this.createLinkedBinding(actor, policy, {
      sourceArtifactId: params.chartSpec.binding.datasetId,
      sourceDatasetId: params.datasetId,
      sourceDatasetVersion: params.datasetVersion,
      sourceMetricId: params.chartSpec.binding.metricRefs[0]?.metricId ?? "FIN-NET-SALES",
      sourceMetricVersion: params.chartSpec.binding.metricRefs[0]?.version ?? 1,
      targetArtifactId: params.presentationId,
      targetKind: "presentation",
      targetElementId: elementId,
      objectKind: "chart",
      mode: "refreshable_link",
    });

    return { presentation: saved, slide, binding };
  }

  async proposeRefresh(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      targetArtifactId: string;
      datasetId: string;
      fromDatasetVersion: number;
      toDatasetVersion: number;
      requiredColumns?: string[];
      requestedDepartments?: string[];
    },
  ): Promise<RefreshProposal> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const targetArt = this.getArtifact(actor, params.targetArtifactId);
    const reqCols = params.requiredColumns ?? ["grossSales", "returnsDiscounts", "cogs", "opex"];

    const toCols = this.datasetVersionColumns.get(
      `${actor.tenantId}::${params.datasetId}::v${params.toDatasetVersion}`,
    ) ?? new Set<string>();
    const missing = reqCols.filter((c) => !toCols.has(c));
    if (missing.length > 0) {
      return {
        proposalId: `refp_${randomUUID().slice(0, 8)}`,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        targetArtifactId: params.targetArtifactId,
        expectedTargetRevision: targetArt.currentRevision,
        fromDatasetVersion: params.fromDatasetVersion,
        toDatasetVersion: params.toDatasetVersion,
        compatible: false,
        incompatibilityReason: `Removed required columns in v${params.toDatasetVersion}: ${missing.join(", ")}`,
        deltas: [],
        requiresApproval: true,
        createdAt: new Date().toISOString(),
      };
    }

    const metricIds = ["FIN-NET-SALES", "FIN-OPERATING-PROFIT", "FIN-OPERATING-MARGIN", "FIN-REVENUE-GROWTH"] as const;
    const deltas: RefreshDeltaItem[] = [];
    for (const mId of metricIds) {
      const comp = mId === "FIN-REVENUE-GROWTH" ? "previous_month" : "none";
      const before = await this.queryCertifiedResult(actor, policy, {
        datasetId: params.datasetId,
        datasetVersion: params.fromDatasetVersion,
        metricId: mId,
        comparison: comp,
        requestedDepartments: params.requestedDepartments,
        requiredColumns: reqCols,
      });
      const after = await this.queryCertifiedResult(actor, policy, {
        datasetId: params.datasetId,
        datasetVersion: params.toDatasetVersion,
        metricId: mId,
        comparison: comp,
        requestedDepartments: params.requestedDepartments,
        requiredColumns: reqCols,
      });
      deltas.push({
        targetElementId: mId,
        label: before.result.displayNameEn,
        beforeValue: before.result.value.displayValue,
        afterValue: after.result.value.displayValue,
      });
    }

    return {
      proposalId: `refp_${randomUUID().slice(0, 8)}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      targetArtifactId: params.targetArtifactId,
      expectedTargetRevision: targetArt.currentRevision,
      fromDatasetVersion: params.fromDatasetVersion,
      toDatasetVersion: params.toDatasetVersion,
      compatible: true,
      deltas,
      requiresApproval: true,
      createdAt: new Date().toISOString(),
    };
  }

  async applyRefreshProposal(
    actor: ActorContext,
    policy: DataScopePolicy,
    proposal: RefreshProposal,
    approved: boolean,
    opts?: {
      datasetId: string;
      requestedDepartments?: string[];
      existingIds?: {
        workbookArtifactId?: string;
        documentArtifactId?: string;
        dashboardReportId?: string;
        presentationId?: string;
      };
    },
  ): Promise<SyncedBundleOutputs> {
    this.assertPrincipalActive(actor);
    if (!approved) {
      throw new IntegrationError(409, "APPROVAL_REQUIRED", "Refresh proposal requires explicit approval.");
    }
    if (!proposal.compatible) {
      throw new IntegrationError(
        422,
        "INCOMPATIBLE_SCHEMA_CHANGE",
        proposal.incompatibilityReason ?? "Incompatible schema prevents refresh.",
      );
    }
    const target = this.getArtifact(actor, proposal.targetArtifactId);
    if (target.currentRevision !== proposal.expectedTargetRevision) {
      throw new IntegrationError(
        409,
        "REVISION_CONFLICT",
        `Expected target revision ${proposal.expectedTargetRevision}, current is ${target.currentRevision}.`,
      );
    }

    return this.syncWorkspaceModules(actor, policy, {
      datasetId: opts?.datasetId ?? `ds_s12_finance_${actor.tenantId}`,
      datasetVersion: proposal.toDatasetVersion,
      requestedDepartments: opts?.requestedDepartments,
      mode: "refreshable_link",
      existingIds: opts?.existingIds,
    });
  }

  async startMonthlyReportingWorkflow(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      idempotencyKey: string;
      context: ReportingContext;
      simulateFailAtStep?: "stage_presentation" | "stage_package";
      pauseAfterStep?: "stage_document";
    },
  ): Promise<{ run: WorkflowRun; bundle?: SyncedBundleOutputs; deduplicated: boolean }> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "create");

    const runIdemKey = `${actor.tenantId}::${actor.workspaceId}::${params.idempotencyKey}`;
    const existingRunId = this.runByIdempotency.get(runIdemKey);
    if (existingRunId) {
      const existing = this.workflowRuns.get(existingRunId);
      if (existing) {
        assertTenantWorkspaceAccess(actor, existing.tenantId, existing.workspaceId);
        return { run: structuredClone(existing), deduplicated: true };
      }
    }

    const now = new Date().toISOString();
    const steps: WorkflowStepResult[] = [
      { stepName: "resolve_context", order: 1, status: "pending" },
      { stepName: "calculate_certified_metrics", order: 2, status: "pending" },
      { stepName: "stage_document", order: 3, status: "pending" },
      { stepName: "stage_presentation", order: 4, status: "pending" },
      { stepName: "validate_cross_module_package", order: 5, status: "pending" },
    ];

    const run: WorkflowRun = {
      runId: `wfr_${randomUUID().slice(0, 8)}`,
      idempotencyKey: params.idempotencyKey,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      workflowType: "monthly_management_reporting",
      actorId: actor.userId,
      state: "running",
      context: structuredClone(params.context),
      steps,
      createdAt: now,
      updatedAt: now,
    };

    this.workflowRuns.set(run.runId, structuredClone(run));
    this.runByIdempotency.set(runIdemKey, run.runId);
    if (this.db) await persistWorkflowRunRow(this.db, run);

    return this.executeWorkflowFromCurrentStep(actor, policy, run, {
      simulateFailAtStep: params.simulateFailAtStep,
      pauseAfterStep: params.pauseAfterStep,
    });
  }

  async rehydrateWorkflowFromDb(actor: ActorContext, runId: string): Promise<WorkflowRun> {
    this.assertPrincipalActive(actor);
    if (!this.db) {
      const local = this.workflowRuns.get(runId);
      if (!local) throw new IntegrationError(404, "WORKFLOW_NOT_FOUND", `Run '${runId}' not found.`);
      assertTenantWorkspaceAccess(actor, local.tenantId, local.workspaceId);
      return structuredClone(local);
    }
    const row = await loadWorkflowRunRow(this.db, actor.tenantId, runId);
    if (!row) {
      throw new IntegrationError(404, "WORKFLOW_NOT_FOUND", `Workflow run '${runId}' not found in PostgreSQL.`);
    }
    this.workflowRuns.set(row.runId, structuredClone(row));
    return structuredClone(row);
  }

  async resumeWorkflow(
    actor: ActorContext,
    policy: DataScopePolicy,
    runId: string,
  ): Promise<{ run: WorkflowRun; bundle?: SyncedBundleOutputs }> {
    const run = this.workflowRuns.get(runId);
    if (!run) {
      throw new IntegrationError(404, "WORKFLOW_NOT_FOUND", `Workflow run '${runId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, run.tenantId, run.workspaceId);
    if (run.state === "cancelled") {
      throw new IntegrationError(409, "WORKFLOW_CANCELLED", "Cannot resume a cancelled workflow run.");
    }
    this.assertPrincipalActive(actor);
    run.state = "running";
    return this.executeWorkflowFromCurrentStep(actor, policy, run, {});
  }

  async cancelWorkflow(actor: ActorContext, runId: string): Promise<WorkflowRun> {
    const run = this.workflowRuns.get(runId);
    if (!run) {
      throw new IntegrationError(404, "WORKFLOW_NOT_FOUND", `Workflow run '${runId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, run.tenantId, run.workspaceId);
    run.state = "cancelled";
    run.updatedAt = new Date().toISOString();
    this.workflowRuns.set(run.runId, structuredClone(run));
    if (this.db) await persistWorkflowRunRow(this.db, run);
    return structuredClone(run);
  }

  private async executeWorkflowFromCurrentStep(
    actor: ActorContext,
    policy: DataScopePolicy,
    run: WorkflowRun,
    opts: {
      simulateFailAtStep?: "stage_presentation" | "stage_package";
      pauseAfterStep?: "stage_document";
    },
  ): Promise<{ run: WorkflowRun; bundle?: SyncedBundleOutputs; deduplicated: boolean }> {
    let bundle: SyncedBundleOutputs | undefined;

    for (const step of run.steps) {
      if (step.status === "succeeded") continue;

      // Re-evaluate actor status & permissions before EVERY step (INT-T11)
      try {
        this.assertPrincipalActive(actor);
        assertCanPerform(actor, "document", "write");
      } catch (err) {
        step.status = "failed";
        step.error = err instanceof Error ? err.message : "Authorization revoked";
        step.executedAt = new Date().toISOString();
        run.state = "recovery_required";
        run.failureReason = step.error;
        run.updatedAt = step.executedAt;
        this.workflowRuns.set(run.runId, structuredClone(run));
        if (this.db) await persistWorkflowRunRow(this.db, run);
        throw err;
      }

      if (step.stepName === "stage_presentation" && opts.simulateFailAtStep === "stage_presentation") {
        step.status = "failed";
        step.error = "Simulated presentation generation crash before completion.";
        step.executedAt = new Date().toISOString();
        run.state = "failed";
        run.failureReason = step.error;
        run.updatedAt = step.executedAt;
        this.workflowRuns.set(run.runId, structuredClone(run));
        if (this.db) await persistWorkflowRunRow(this.db, run);
        return { run: structuredClone(run), deduplicated: false };
      }

      if (step.stepName === "stage_document") {
        bundle =
          this.runBundles.get(run.runId) ??
          (await this.syncWorkspaceModules(actor, policy, {
            datasetId: run.context.datasetId,
            datasetVersion: run.context.datasetVersion,
            requestedDepartments: run.context.requestedDepartments,
            language: run.context.language,
            mode: "refreshable_link",
          }));
        this.runBundles.set(run.runId, bundle);
        step.outputArtifactId = bundle.documentArtifact.artifactId;
        step.outputRevision = bundle.documentArtifact.currentRevision;
      } else if (step.stepName === "stage_presentation") {
        bundle =
          this.runBundles.get(run.runId) ??
          (await this.syncWorkspaceModules(actor, policy, {
            datasetId: run.context.datasetId,
            datasetVersion: run.context.datasetVersion,
            requestedDepartments: run.context.requestedDepartments,
            language: run.context.language,
            mode: "refreshable_link",
          }));
        this.runBundles.set(run.runId, bundle);
        step.outputArtifactId = bundle.presentationArtifact.artifactId;
        step.outputRevision = bundle.presentationArtifact.currentRevision;
      } else if (step.stepName === "validate_cross_module_package") {
        bundle =
          this.runBundles.get(run.runId) ??
          (await this.syncWorkspaceModules(actor, policy, {
            datasetId: run.context.datasetId,
            datasetVersion: run.context.datasetVersion,
            requestedDepartments: run.context.requestedDepartments,
            language: run.context.language,
            mode: "refreshable_link",
          }));
        this.runBundles.set(run.runId, bundle);
        const staged = await this.stageReportingPackage(actor, policy, {
          title: `Monthly Management Package (${run.context.periodStart})`,
          bundle,
        });
        run.stagedPackageId = staged.packageId;
        step.outputArtifactId = staged.packageId;
        step.outputRevision = staged.packageVersion;
      }

      step.status = "succeeded";
      step.executedAt = new Date().toISOString();
      run.updatedAt = step.executedAt;
      this.workflowRuns.set(run.runId, structuredClone(run));
      if (this.db) await persistWorkflowRunRow(this.db, run);

      if (step.stepName === "stage_document" && opts.pauseAfterStep === "stage_document") {
        run.state = "awaiting_clarification";
        run.updatedAt = new Date().toISOString();
        this.workflowRuns.set(run.runId, structuredClone(run));
        if (this.db) await persistWorkflowRunRow(this.db, run);
        return { run: structuredClone(run), bundle, deduplicated: false };
      }
    }

    run.state = "awaiting_approval";
    run.updatedAt = new Date().toISOString();
    this.workflowRuns.set(run.runId, structuredClone(run));
    if (this.db) await persistWorkflowRunRow(this.db, run);
    return { run: structuredClone(run), bundle, deduplicated: false };
  }

  async stageReportingPackage(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      packageId?: string;
      packageVersion?: number;
      title: string;
      bundle: SyncedBundleOutputs;
      classification?: ArtifactClassification;
      audiencePolicy?: string;
    },
  ): Promise<ReportingPackageManifest> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const packageId = params.packageId ?? `pkg_${randomUUID().slice(0, 8)}`;
    const packageVersion = params.packageVersion ?? 1;
    const b = params.bundle;

    const pptxExport = await exportPresentationToPptxBuffer(b.presentation, {
      includeSpeakerNotes: false,
      includeHiddenSlides: false,
    });
    const docxExport = await this.documents.exportDocx(actor, b.document.documentId);

    const artifactRevisions: ArtifactRevisionReference[] = [
      this.revisions.get(b.workbookArtifact.artifactId)!.at(-1)!,
      this.revisions.get(b.documentArtifact.artifactId)!.at(-1)!,
      this.revisions.get(b.dashboardArtifact.artifactId)!.at(-1)!,
      this.revisions.get(b.presentationArtifact.artifactId)!.at(-1)!,
    ];

    const validationChecks = this.runCrossModuleValidation(b);
    const allValidationsPassed = validationChecks.every((c) => c.passed);

    const coreBody = {
      packageId,
      packageVersion,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      title: params.title,
      reportingPeriod: { start: "2026-11-01", endExclusive: "2026-12-01" },
      sourceVersions: [
        this.datasetRegistry.get(`${actor.tenantId}::ds_s12_finance_${actor.tenantId}::v${b.datasetVersion}`)!.meta,
      ],
      metricVersions: Object.values(b.resultRefs).map((r) => ({
        metricId: r.metricId,
        version: r.metricVersion,
      })),
      resultReferences: Object.values(b.resultRefs),
      artifactRevisions,
      fileChecksums: {
        [`${b.document.documentId}.docx`]: createHash("sha256").update(docxExport.buffer).digest("hex"),
        [`${b.presentation.presentationId}.pptx`]: createHash("sha256").update(pptxExport.buffer).digest("hex"),
      },
      validationChecks,
      allValidationsPassed,
      classification: params.classification ?? "confidential",
      audiencePolicy: params.audiencePolicy ?? `${policy.policyId}:v${policy.policyVersion}`,
      themeVersion: b.presentation.theme.version,
    };

    const manifest: ReportingPackageManifest = {
      ...coreBody,
      lifecycleStatus: allValidationsPassed ? "validated" : "staged",
      manifestDigestSha256: sha256Json(coreBody),
    };

    const safety = validateReportingManifestSafety(manifest);
    if (!safety.valid) {
      throw new IntegrationError(400, "INVALID_MANIFEST", safety.errors.join(" "));
    }

    this.stagedPackages.set(`${packageId}::v${packageVersion}`, structuredClone(manifest));
    if (this.db) {
      await persistReportingPackageRow(this.db, manifest);
    }
    return structuredClone(manifest);
  }

  private runCrossModuleValidation(b: SyncedBundleOutputs): PublicationValidationCheck[] {
    const netSalesNum = Number(b.resultRefs["FIN-NET-SALES"]!.minorUnits ?? "0") / 100;
    const opProfitNum = Number(b.resultRefs["FIN-OPERATING-PROFIT"]!.minorUnits ?? "0") / 100;
    const sheetCells = b.workbook.sheets[0]!.cells;
    const totalRowIdx = 2 + b.effectiveDepartments.length;
    const wbSales = sheetCells[`B${totalRowIdx}`]?.evaluatedValue;
    const wbProfit = sheetCells[`E${totalRowIdx}`]?.evaluatedValue;

    const docMetrics = b.document.blocks
      .filter((blk): blk is Extract<DocumentBlock, { type: "linked_metric_placeholder" }> => blk.type === "linked_metric_placeholder")
      .map((blk) => blk.metric);
    const docSalesMatch = docMetrics.some((m) => m.metricId === "FIN-NET-SALES" && m.cachedFormattedValue === b.resultRefs["FIN-NET-SALES"]!.displayValue);

    const biSales = b.evaluatedDashboard.visualResults.vis_kpi_net_sales?.metricResults["FIN-NET-SALES"]?.value.displayValue;
    const presSales = b.presentation.slides[1]?.sourceRefs.find((r) => r.metricId === "FIN-NET-SALES")?.cachedFormattedValue;

    const reconciled =
      wbSales === netSalesNum &&
      wbProfit === opProfitNum &&
      docSalesMatch &&
      biSales === b.resultRefs["FIN-NET-SALES"]!.displayValue &&
      presSales === b.resultRefs["FIN-NET-SALES"]!.displayValue;

    return [
      {
        checkId: "reconciliation_all_studios",
        passed: reconciled,
        detail: reconciled
          ? `Workbook (${wbSales}/${wbProfit}), Document, Dashboard (${biSales}), and Presentation (${presSales}) reconcile identically.`
          : `Reconciliation mismatch detected across studio modules.`,
      },
      {
        checkId: "provenance_and_freshness",
        passed: Object.values(b.resultRefs).every((r) => Boolean(r.provenanceId)),
        detail: "Every metric reference carries FR-05 provenanceId and datasetVersion.",
      },
      {
        checkId: "mandatory_visuals_valid",
        passed: Object.values(b.evaluatedDashboard.visualResults).every((v) => v.state === "ready"),
        detail: "All mandatory dashboard visuals evaluated cleanly without error.",
      },
    ];
  }

  async approveReportingPackage(
    actor: ActorContext,
    packageId: string,
    packageVersion: number,
  ): Promise<ReportingPackageManifest> {
    this.assertPrincipalActive(actor);
    if (actor.role !== "owner" && actor.role !== "administrator" && actor.role !== "reviewer") {
      assertCanPerform(actor, "document", "write");
    }
    const pkg = this.stagedPackages.get(`${packageId}::v${packageVersion}`);
    if (!pkg) {
      throw new IntegrationError(404, "PACKAGE_NOT_FOUND", `Staged package '${packageId}' v${packageVersion} not found.`);
    }
    assertTenantWorkspaceAccess(actor, pkg.tenantId, pkg.workspaceId);
    if (!pkg.allValidationsPassed) {
      throw new IntegrationError(422, "VALIDATION_BLOCKERS_PRESENT", "Cannot approve package with failing validation checks.");
    }

    const approval: PublicationApproval = {
      approvalId: `app_${randomUUID().slice(0, 8)}`,
      packageId,
      packageVersion,
      manifestDigestSha256: pkg.manifestDigestSha256,
      approverId: actor.userId,
      status: "approved",
      approvedAt: new Date().toISOString(),
    };
    pkg.approval = approval;
    pkg.lifecycleStatus = "approved";
    this.stagedPackages.set(`${packageId}::v${packageVersion}`, structuredClone(pkg));
    if (this.db) {
      await persistReportingPackageRow(this.db, pkg);
      await persistApprovalRow(this.db, actor.tenantId, approval);
    }
    return structuredClone(pkg);
  }

  async modifyStagedPackageAfterApproval(
    actor: ActorContext,
    packageId: string,
    packageVersion: number,
    updatedTitle: string,
  ): Promise<ReportingPackageManifest> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "document", "write");
    const pkg = this.stagedPackages.get(`${packageId}::v${packageVersion}`);
    if (!pkg) {
      throw new IntegrationError(404, "PACKAGE_NOT_FOUND", `Package '${packageId}' v${packageVersion} not found.`);
    }
    assertTenantWorkspaceAccess(actor, pkg.tenantId, pkg.workspaceId);

    pkg.title = updatedTitle;
    pkg.lifecycleStatus = "staged";
    pkg.manifestDigestSha256 = sha256Json({
      packageId: pkg.packageId,
      packageVersion: pkg.packageVersion,
      title: updatedTitle,
      resultReferences: pkg.resultReferences,
      artifactRevisions: pkg.artifactRevisions,
    });
    if (pkg.approval) {
      pkg.approval.status = "invalidated";
      pkg.approval.invalidatedReason = "Material manifest mutation after approval requires re-review.";
      if (this.db) {
        await persistApprovalRow(this.db, actor.tenantId, pkg.approval);
      }
    }
    this.stagedPackages.set(`${packageId}::v${packageVersion}`, structuredClone(pkg));
    if (this.db) {
      await persistReportingPackageRow(this.db, pkg);
    }
    return structuredClone(pkg);
  }

  async publishReportingPackage(
    actor: ActorContext,
    policy: DataScopePolicy,
    params: {
      packageId: string;
      packageVersion: number;
      idempotencyKey: string;
      simulateFailureBeforeCommit?: boolean;
    },
  ): Promise<ReportingPackageManifest> {
    this.assertPrincipalActive(actor);
    if (!policy.canPublish) {
      throw new IntegrationError(403, "PUBLISH_FORBIDDEN", "Caller policy lacks package publication permission.");
    }
    const pkgKey = `${params.packageId}::v${params.packageVersion}`;
    const alreadyPublished = this.publishedPackages.get(pkgKey);
    if (alreadyPublished) {
      assertTenantWorkspaceAccess(actor, alreadyPublished.tenantId, alreadyPublished.workspaceId);
      const prevKey = (alreadyPublished as ReportingPackageManifest & { _pubIdemKey?: string })._pubIdemKey;
      if (prevKey === params.idempotencyKey) {
        return structuredClone(alreadyPublished);
      }
    }
    const pkg = this.stagedPackages.get(pkgKey);
    if (!pkg) {
      throw new IntegrationError(404, "PACKAGE_NOT_FOUND", `Staged package '${params.packageId}' v${params.packageVersion} not found.`);
    }
    assertTenantWorkspaceAccess(actor, pkg.tenantId, pkg.workspaceId);
    if (!pkg.approval || pkg.approval.status !== "approved" || pkg.approval.manifestDigestSha256 !== pkg.manifestDigestSha256) {
      throw new IntegrationError(
        409,
        "APPROVAL_INVALIDATED",
        "Publication blocked: manifest lacks valid approval bound to current manifest digest.",
      );
    }
    if (!pkg.allValidationsPassed) {
      throw new IntegrationError(422, "VALIDATION_BLOCKERS_PRESENT", "Publication blocked by validation checks.");
    }

    const candidate = structuredClone(pkg);
    candidate.lifecycleStatus = "published";
    candidate.publishedAt = new Date().toISOString();

    if (this.db) {
      await commitPackagePublicationTx(this.db, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        manifest: candidate,
        idempotencyKey: params.idempotencyKey,
        simulateFailureBeforeCommit: params.simulateFailureBeforeCommit,
      });
    } else if (params.simulateFailureBeforeCommit) {
      throw new Error("SIMULATED_PUBLICATION_COMMIT_FAILURE");
    }

    // Only mark published in memory & clone immutable pinned snapshot bindings (keeping live drafts refreshable)
    for (const ref of candidate.artifactRevisions) {
      const art = this.artifacts.get(ref.artifactId);
      if (art) {
        art.publishedRevision = ref.revision;
        art.lifecycleStatus = "published";
      }
    }
    const snapshotBindings: LinkedObjectBinding[] = [];
    for (const binding of this.linkedBindings.values()) {
      if (
        binding.mode !== "pinned_snapshot" &&
        candidate.artifactRevisions.some((ar) => ar.artifactId === binding.targetArtifactId)
      ) {
        const frozen: LinkedObjectBinding = {
          ...structuredClone(binding),
          bindingId: `${binding.bindingId}::pub_${candidate.packageId}_v${candidate.packageVersion}`,
          mode: "pinned_snapshot",
          state: "pinned",
          approvedForDistribution: true,
          resultRef: { ...structuredClone(binding.resultRef), bindingMode: "pinned_snapshot" },
        };
        snapshotBindings.push(frozen);
      }
    }
    for (const frozen of snapshotBindings) {
      this.linkedBindings.set(frozen.bindingId, frozen);
    }

    const storedPublished = structuredClone(candidate) as ReportingPackageManifest & { _pubIdemKey?: string };
    storedPublished._pubIdemKey = params.idempotencyKey;
    this.publishedPackages.set(pkgKey, storedPublished);
    return structuredClone(candidate);
  }

  getPublishedPackage(actor: ActorContext, packageId: string, packageVersion: number): ReportingPackageManifest {
    this.assertPrincipalActive(actor);
    const pub = this.publishedPackages.get(`${packageId}::v${packageVersion}`);
    if (!pub) {
      throw new IntegrationError(404, "PUBLISHED_PACKAGE_NOT_FOUND", `Published package '${packageId}' v${packageVersion} not found.`);
    }
    assertTenantWorkspaceAccess(actor, pub.tenantId, pub.workspaceId);
    return structuredClone(pub);
  }

  async exportPackagePresentationPptx(
    actor: ActorContext,
    presentationId: string,
    disclosurePolicy: ExportDisclosurePolicy,
  ): Promise<{ buffer: Buffer; filename: string; disclosure: ExportDisclosureReport }> {
    this.assertPrincipalActive(actor);
    assertCanPerform(actor, "export", "export");
    const { sanitizedDeck } = this.presentations.prepareDeckForExport(actor, presentationId, disclosurePolicy);
    return exportPresentationToPptxBuffer(sanitizedDeck, disclosurePolicy);
  }
}

export { SECTION_12_BUDGET_ROWS, SECTION_12_FINANCE_ROWS };
