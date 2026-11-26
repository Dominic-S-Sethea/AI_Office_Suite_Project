import type { LinkedObjectBindingMode, LinkedResourceState, WorkspaceRole } from "./core.ts";
import type { AnalyticalResult } from "./analytics.ts";

// =============================================================================
// Stage 3 FR-08 — Cross-module Integration Contracts (Phase XI-00 Feasibility)
// =============================================================================

export type ArtifactKind =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "dashboard"
  | "dataset"
  | "reporting_package";

export type ArtifactClassification = "public" | "internal" | "confidential" | "restricted";

export type ArtifactLifecycleStatus =
  | "draft"
  | "reviewed"
  | "published"
  | "withdrawn"
  | "archived";

export interface ArtifactReference {
  artifactId: string;
  tenantId: string;
  workspaceId: string;
  kind: ArtifactKind;
  title: string;
  currentRevision: number;
  publishedRevision?: number;
  ownerId: string;
  classification: ArtifactClassification;
  lifecycleStatus: ArtifactLifecycleStatus;
  allowedDepartments?: string[] | "ALL";
  requiredColumns?: string[];
  updatedAt: string;
}

export interface ArtifactRevisionReference {
  artifactId: string;
  kind: ArtifactKind;
  revision: number;
  contentSha256: string;
  restoredFromRevision?: number;
  createdBy: string;
  createdAt: string;
}

export interface DatasetVersionReference {
  datasetId: string;
  version: number;
  datasetSha256: string;
  granularity: string;
  requiredColumns: string[];
  status: "draft" | "certified" | "withdrawn";
}

export interface MetricReference {
  metricId: string;
  version: number;
  formulaDigest?: string;
}

export interface AnalyticalResultReference {
  resultId: string;
  provenanceId: string;
  datasetId: string;
  datasetVersion: number;
  metricId: string;
  metricVersion: number;
  reportingPeriod: {
    start: string;
    endExclusive: string;
  };
  filters: Record<string, string>;
  groupBy: string[];
  precisionPolicyId: string;
  currency: string;
  unit: string;
  minorUnits?: string;
  displayValue: string;
  effectivePolicyScope: string;
  policyVersion: number;
  bindingMode: LinkedObjectBindingMode;
  computedAt: string;
}

export type LinkedObjectKind = "metric" | "table" | "chart" | "referenced_content";

export interface LinkedObjectBinding {
  bindingId: string;
  tenantId: string;
  workspaceId: string;
  sourceArtifactId: string;
  sourceRevision: number;
  sourceDatasetId: string;
  sourceDatasetVersion: number;
  sourceMetricId: string;
  sourceMetricVersion: number;
  targetArtifactId: string;
  targetKind: ArtifactKind;
  targetRevision: number;
  targetElementId: string;
  objectKind: LinkedObjectKind;
  mode: LinkedObjectBindingMode;
  state: LinkedResourceState;
  syncDirection: "one_way_source_to_target";
  requiresSourcePermissionToView: boolean;
  approvedForDistribution: boolean;
  editableInTarget: boolean;
  reportingPeriod: {
    start: string;
    endExclusive: string;
  };
  normalizedFilters: Record<string, string>;
  requiredColumns: string[];
  resultRef: AnalyticalResultReference;
  freshnessDeadlineIso?: string;
  updatedAt: string;
}

export interface ReportingContext {
  tenantId: string;
  workspaceId: string;
  periodStart: string;
  periodEndExclusive: string;
  datasetId: string;
  datasetVersion: number;
  budgetDatasetId?: string;
  budgetDatasetVersion?: number;
  metricIds: string[];
  requestedDepartments?: string[];
  currency: string;
  language: "en" | "km" | "bilingual";
  themeId: string;
  themeVersion: number;
}

export interface DependencyEdge {
  edgeId: string;
  tenantId: string;
  workspaceId: string;
  sourceKind: ArtifactKind | "metric";
  sourceId: string;
  sourceVersionOrRevision: number;
  targetKind: ArtifactKind | "metric";
  targetId: string;
  targetRevision: number;
  relationship: "derived_from" | "references_metric" | "links_chart" | "links_table" | "packaged_in";
  requiredClassification: ArtifactClassification;
  allowedDepartments?: string[] | "ALL";
  requiredColumns: string[];
}

export type WorkflowLifecycleState =
  | "planned"
  | "awaiting_clarification"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovery_required";

export interface WorkflowDefinition {
  workflowType:
    | "monthly_management_reporting"
    | "financial_report_generation"
    | "executive_presentation_generation"
    | "departmental_kpi_dashboard";
  priority: "P0" | "P1";
  steps: string[];
}

export interface WorkflowStepResult {
  stepName: string;
  order: number;
  status: "pending" | "succeeded" | "failed" | "skipped";
  outputArtifactId?: string;
  outputRevision?: number;
  error?: string;
  executedAt?: string;
}

export interface WorkflowRun {
  runId: string;
  idempotencyKey: string;
  tenantId: string;
  workspaceId: string;
  workflowType: WorkflowDefinition["workflowType"];
  actorId: string;
  state: WorkflowLifecycleState;
  context: ReportingContext;
  steps: WorkflowStepResult[];
  stagedPackageId?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RefreshDeltaItem {
  targetElementId: string;
  label: string;
  beforeValue: string;
  afterValue: string;
}

export interface RefreshProposal {
  proposalId: string;
  tenantId: string;
  workspaceId: string;
  targetArtifactId: string;
  expectedTargetRevision: number;
  fromDatasetVersion: number;
  toDatasetVersion: number;
  compatible: boolean;
  incompatibilityReason?: string;
  deltas: RefreshDeltaItem[];
  requiresApproval: boolean;
  createdAt: string;
}

export interface PublicationValidationCheck {
  checkId: string;
  passed: boolean;
  detail: string;
}

export interface PublicationApproval {
  approvalId: string;
  packageId: string;
  packageVersion: number;
  manifestDigestSha256: string;
  approverId: string;
  status: "approved" | "invalidated";
  invalidatedReason?: string;
  approvedAt: string;
}

export interface ReportingPackageManifest {
  packageId: string;
  packageVersion: number;
  tenantId: string;
  workspaceId: string;
  title: string;
  reportingPeriod: {
    start: string;
    endExclusive: string;
  };
  sourceVersions: DatasetVersionReference[];
  metricVersions: MetricReference[];
  resultReferences: AnalyticalResultReference[];
  artifactRevisions: ArtifactRevisionReference[];
  fileChecksums: Record<string, string>;
  validationChecks: PublicationValidationCheck[];
  allValidationsPassed: boolean;
  classification: ArtifactClassification;
  audiencePolicy: string;
  themeVersion: number;
  lifecycleStatus: "staged" | "validated" | "approved" | "published" | "superseded";
  manifestDigestSha256: string;
  approval?: PublicationApproval;
  publishedAt?: string;
}





