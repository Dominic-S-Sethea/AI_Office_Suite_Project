import type { OperationRiskLevel, OperationSource, WorkspaceRole } from "./core.ts";
import type { LinkedMetricReference } from "./documents.ts";
import type { AnalyticalQuery, AnalyticalResult } from "./analytics.ts";

// =============================================================================
// Stage 3 FR-06 & FR-07 — Shared Chart Contract (PS-00 / BI-00 / Cross-Module)
// =============================================================================

export type ChartKind =
  | "kpi"
  | "bar"
  | "column"
  | "grouped_bar"
  | "stacked_bar"
  | "line"
  | "pie"
  | "table";

export type ChartDataClassification =
  | "actual"
  | "budget"
  | "variance"
  | "forecast"
  | "scenario";

export type ChartPointState =
  | "available"
  | "undefined"
  | "missing"
  | "suppressed"
  | "error";

export interface ChartSeriesPoint {
  category: string;
  labelKm?: string;
  value: number | null;
  formatted: string;
  state: ChartPointState;
}

export interface ChartSeriesData {
  seriesId: string;
  labelEn: string;
  labelKm: string;
  classification: ChartDataClassification;
  unit: string;
  currency?: string;
  values: ChartSeriesPoint[];
}

export interface ChartDataBinding {
  datasetId: string;
  datasetVersion: number;
  metricRefs: Array<{ metricId: string; version: number }>;
  reportingPeriod: string;
  filterContext: Record<string, string>;
  policyScope: string;
  provenanceId: string;
  freshnessTimestamp: string;
  sourceAsOfTimestamp: string;
}

export interface ChartSpec {
  chartId: string;
  kind: ChartKind;
  titleEn: string;
  titleKm: string;
  altSummaryEn: string;
  altSummaryKm: string;
  unit: string;
  currency?: string;
  yAxisStartsAtZero: boolean;
  categories: string[];
  series: ChartSeriesData[];
  binding: ChartDataBinding;
  themeVersion: number;
  linkedMetricRefs: LinkedMetricReference[];
}

// =============================================================================
// Stage 3 FR-06 — Presentation Studio Contracts (Phase PS-00 Feasibility)
// =============================================================================

export interface SlideGeometry {
  xIn: number;
  yIn: number;
  wIn: number;
  hIn: number;
  rotationDeg?: number;
}

export interface PresentationTheme {
  themeId: string;
  version: number;
  name: string;
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontLatin: string;
  fontKhmer: string;
  slideWidthIn: number;
  slideHeightIn: number;
}

export interface SlideElementBase {
  elementId: string;
  bounds: SlideGeometry;
  zIndex: number;
  locked: boolean;
  altText: string;
  sourceRef?: LinkedMetricReference;
}

export interface SlideTextElement extends SlideElementBase {
  type: "text";
  text: string;
  fontSizePt: number;
  bold?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
}

export interface SlideShapeElement extends SlideElementBase {
  type: "shape";
  shapeKind: "rect" | "round_rect" | "arrow";
  fillColor: string;
  borderColor?: string;
  labelText?: string;
}

export interface SlideConnectorElement extends SlideElementBase {
  type: "connector";
  lineColor: string;
  strokeWidthPt: number;
}

export interface SlideImageElement extends SlideElementBase {
  type: "image";
  dataUriBase64: string;
  mimeType: "image/png" | "image/jpeg";
}

export interface SlideTableElement extends SlideElementBase {
  type: "table";
  headers: string[];
  rows: string[][];
}

export interface SlideChartElement extends SlideElementBase {
  type: "chart";
  chartSpec: ChartSpec;
}

export interface SlideMetricCardElement extends SlideElementBase {
  type: "metric";
  labelEn: string;
  labelKm: string;
  metricRef: LinkedMetricReference;
}

export type SlideElement =
  | SlideTextElement
  | SlideShapeElement
  | SlideConnectorElement
  | SlideImageElement
  | SlideTableElement
  | SlideChartElement
  | SlideMetricCardElement;

export interface PresentationSlide {
  slideId: string;
  order: number;
  layoutId: "title" | "kpi_summary" | "chart_story" | "table_focus" | "comparison" | "priorities";
  title: string;
  elements: SlideElement[];
  speakerNotes: string;
  hidden?: boolean;
  readingOrder: string[];
  sourceRefs: LinkedMetricReference[];
}

export interface StudioPresentation {
  presentationId: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  language: "en" | "km" | "bilingual";
  revision: number;
  status: "draft" | "in_review" | "approved" | "published";
  theme: PresentationTheme;
  slides: PresentationSlide[];
  scopeLabel: string;
  publishedSnapshotHash?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type PresentationOperationType =
  | "add_slide"
  | "replace_text"
  | "move_resize_element"
  | "apply_theme"
  | "insert_metric"
  | "change_chart_type"
  | "translate_narrative"
  | "undo_last";

export interface PresentationOperationProposal {
  operationId: string;
  presentationId: string;
  expectedRevision: number;
  targetSlideId: string;
  targetElementId?: string;
  action: PresentationOperationType;
  params: Record<string, unknown>;
  requiresApproval: boolean;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km";
  source: OperationSource;
  originalCommand: string;
  previewSummary: string;
}

// =============================================================================
// Stage 3 FR-07 — Intelligence Studio Contracts (Phase BI-00 Feasibility)
// =============================================================================

export interface DataScopePolicy {
  policyId: string;
  policyVersion: number;
  tenantId: string;
  principalRole: WorkspaceRole;
  allowedDepartments: string[] | "ALL";
  allowedColumns: string[];
  maxClassification?: "public" | "internal" | "confidential" | "restricted";
  canExportUnderlyingDetail: boolean;
  canPublish: boolean;
}

export interface FilterPredicate {
  dimension: string;
  operator: "eq" | "in" | "between";
  values: string[];
}

export interface FilterContext {
  tenantId: string;
  workspaceId: string;
  semanticModelId: string;
  semanticModelVersion: number;
  datasetManifestId: string;
  datasetVersion: number;
  periodStart: string;
  periodEndExclusive: string;
  timezone: string;
  reportFilters: FilterPredicate[];
  pageFilters: FilterPredicate[];
  visualFilters: FilterPredicate[];
  crossFilters: FilterPredicate[];
  policyId: string;
  policyVersion: number;
}

export interface VisualSpec {
  visualId: string;
  pageId: string;
  kind: ChartKind;
  titleEn: string;
  titleKm: string;
  metricRefs: Array<{ id: string; version?: number }>;
  groupBy?: string[];
  gridPosition: { row: number; col: number; w: number; h: number };
  visualFilters: FilterPredicate[];
  crossFilterTargets: string[];
  chartSpec?: ChartSpec;
  state: "ready" | "empty" | "error" | "suppressed" | "stale";
  errorDetail?: string;
}

export interface ReportPage {
  pageId: string;
  titleEn: string;
  titleKm: string;
  order: number;
  pageFilters: FilterPredicate[];
  visuals: VisualSpec[];
}

export interface StudioReport {
  reportId: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  revision: number;
  status: "draft" | "in_review" | "approved" | "published" | "superseded";
  semanticModelId: string;
  semanticModelVersion: number;
  datasetManifestId: string;
  datasetVersion: number;
  sourceAsOfTimestamp: string;
  lastSuccessfulRefreshAt: string;
  lastComputedAt: string;
  staleWarning?: string;
  pages: ReportPage[];
  publishedSnapshotHash?: string;
}

export interface RefreshJobRecord {
  jobId: string;
  idempotencyKey: string;
  reportId: string;
  tenantId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  targetManifestVersion: number;
  previousGoodManifestVersion: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface PublishedBiSnapshot {
  snapshotId: string;
  reportId: string;
  tenantId: string;
  workspaceId: string;
  policyScope: string;
  datasetManifestId: string;
  datasetVersion: number;
  metricVersions: Array<{ metricId: string; version: number }>;
  filterContext: FilterContext;
  visualResults: Record<string, AnalyticalResult>;
  snapshotSha256: string;
  publishedAt: string;
}

