export type WorkspaceRole =
  | "owner"
  | "administrator"
  | "editor"
  | "reviewer"
  | "viewer";

export interface ActorContext {
  tenantId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export type TextAlignment = "left" | "center" | "right" | "justify";
export type PageSize = "A4" | "Letter";
export type PageOrientation = "portrait" | "landscape";

export interface TextMarks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlight?: string;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
}

export interface TextRun {
  text: string;
  marks?: TextMarks;
}

export interface ParagraphBlock {
  id: string;
  type: "paragraph";
  alignment?: TextAlignment;
  runs: TextRun[];
}

export interface HeadingBlock {
  id: string;
  type: "heading";
  level: 1 | 2 | 3;
  alignment?: TextAlignment;
  runs: TextRun[];
}

export interface ListBlock {
  id: string;
  type: "bullet_list" | "ordered_list";
  items: TextRun[][];
}

export interface TableCell {
  runs: TextRun[];
  colspan?: number;
  rowspan?: number;
}

export interface TableBlock {
  id: string;
  type: "table";
  hasHeaderRow: boolean;
  rows: TableCell[][];
}

export interface PageBreakBlock {
  id: string;
  type: "page_break";
}

export interface LinkedMetricReference {
  datasetId: string;
  datasetVersion: string;
  metricId: string;
  metricVersion: string;
  reportingPeriod: string;
  filterContext: Record<string, string>;
  unit: string;
  currency?: string;
  approvalStatus: "draft" | "certified" | "published_snapshot";
  freshnessTimestamp: string;
  mode: "live_draft" | "published_snapshot";
  displayLabel: string;
  cachedFormattedValue: string;
  provenanceId?: string;
  calculationEngineVersion?: string;
  precisionPolicyId?: string;
  status?: "available" | "unavailable";
  unavailableReason?: string;
  bindingMode?: LinkedObjectBindingMode;
  linkState?: LinkedResourceState;
  sourceArtifactId?: string;
  resultReferenceId?: string;
  effectivePolicyScope?: string;
  policyVersion?: number;
}

export interface LinkedMetricPlaceholderBlock {
  id: string;
  type: "linked_metric_placeholder";
  metric: LinkedMetricReference;
}

export type DocumentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | TableBlock
  | PageBreakBlock
  | LinkedMetricPlaceholderBlock;

export interface PageLayoutConfig {
  size: PageSize;
  orientation: PageOrientation;
  marginsMm: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  headerText: string;
  footerText: string;
  showPageNumbers: boolean;
}

export interface StudioDocument {
  documentId: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  language: "en" | "km" | "bilingual";
  revision: number;
  status: "draft" | "in_review" | "approved";
  layout: PageLayoutConfig;
  blocks: DocumentBlock[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sourceImportSha256?: string;
}

export interface DocumentVersion {
  versionId: string;
  documentId: string;
  revision: number;
  snapshot: StudioDocument;
  summary: string;
  source: "manual" | "typed_ai" | "voice_command" | "import" | "restore";
  actorId: string;
  restoredFromRevision?: number;
  undoneRevision?: number;
  createdAt: string;
}

export interface ImportDiagnostics {
  originalSha256: string;
  filename: string;
  byteLength: number;
  macrosBlocked: boolean;
  warnings: string[];
  unsupportedFeatures: string[];
}

export type DocumentOperationType =
  | "insert_text"
  | "replace_selection"
  | "set_heading"
  | "toggle_bold"
  | "set_alignment"
  | "insert_table"
  | "undo_last";

export interface DocumentSelectionRef {
  blockId: string;
  startOffset?: number;
  endOffset?: number;
  selectedText?: string;
  selectionHash?: string;
}

export type OperationRiskLevel = "low" | "medium" | "high";
export type OperationSource = "manual" | "typed_ai" | "voice_command";

export interface DocumentOperationPreview {
  blockId?: string;
  beforeText: string;
  afterText: string;
  summary: string;
}

export interface DocumentOperationProposal {
  operationId: string;
  documentId: string;
  expectedRevision: number;
  selection?: DocumentSelectionRef;
  action: DocumentOperationType;
  params: Record<string, unknown>;
  requestedBy: string;
  riskLevel: OperationRiskLevel;
  requiresApproval: boolean;
  source: OperationSource;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km" | "match";
  originalCommand: string;
  explanation: string;
  previewDiff: DocumentOperationPreview;
  createdAt: string;
}

export type SpeechProviderId =
  | "mock"
  | "google-cloud-stt-v2"
  | "azure-speech"
  | "faster-whisper";

export type SpeechLanguageCode = "en-US" | "km-KH";

export interface SpeechRecognitionRequest {
  language: SpeechLanguageCode;
  mode: "dictation" | "command" | "contextual" | "workflow";
  fixtureId?: string;
  simulatedTranscript?: string;
  audioBase64?: string;
  mimeType?: string;
  durationMs?: number;
}

export interface SpeechRecognitionResult {
  transcript: string;
  language: SpeechLanguageCode;
  confidence: number;
  provider: SpeechProviderId;
  isMock: boolean;
  disclaimer?: string;
  durationMs: number;
  warnings: string[];
}

export interface SpeechRecognitionAdapter {
  readonly providerId: SpeechProviderId;
  readonly isMock: boolean;
  transcribe(request: SpeechRecognitionRequest): Promise<SpeechRecognitionResult>;
}

export interface AuditEvent {
  auditId: string;
  tenantId: string;
  workspaceId: string;
  documentId?: string;
  actorId: string;
  actorRole: WorkspaceRole;
  source: OperationSource | "import" | "export" | "restore" | "system";
  action: string;
  outcome: "success" | "denied" | "failed";
  revisionBefore?: number;
  revisionAfter?: number;
  operationId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Planned future studio boundary interfaces (Phase D2+ / D7).
 * Interfaces only — no implementation authorized in Phase D0/D1.
 */
export interface FutureStudioBoundaryDescriptor {
  studioId: "spreadsheets" | "presentations" | "analytics";
  status: "planned_future_phase";
  route: string;
  contractVersion: "0.1-placeholder";
}

export const PLANNED_FUTURE_STUDIOS: readonly FutureStudioBoundaryDescriptor[] = [
  { studioId: "spreadsheets", status: "planned_future_phase", route: "/spreadsheets", contractVersion: "0.1-placeholder" },
  { studioId: "presentations", status: "planned_future_phase", route: "/presentations", contractVersion: "0.1-placeholder" },
  { studioId: "analytics", status: "planned_future_phase", route: "/analytics", contractVersion: "0.1-placeholder" },
] as const;

// =============================================================================
// Stage 3 FR-03 — Spreadsheet Studio Feasibility Contracts (Phase SS-00 only)
// =============================================================================

export type ExcelErrorValue =
  | "#DIV/0!"
  | "#REF!"
  | "#VALUE!"
  | "#NAME?"
  | "#N/A"
  | "#NUM!"
  | "#SPILL!"
  | "#CYCLE!";

export type CellStoredValue = number | string | boolean | null;

export interface SpreadsheetCellRecord {
  /** Authoritative stored value (number, string ID with leading zeros, boolean, or null). */
  value: CellStoredValue;
  /** Optional formula starting with '='; calculated value is stored separately in evaluatedValue. */
  formula?: string;
  /** Evaluated output produced strictly by the deterministic calculation engine. */
  evaluatedValue?: CellStoredValue | { error: ExcelErrorValue; detail?: string };
  /** Display format kept distinct from stored value (e.g. '0.00%', '$#,##0.00', '៛#,##0'). */
  numberFormat?: string;
  /** Explicit currency code when cell represents money; prevents mixing USD and KHR silently. */
  currency?: "USD" | "KHR" | "NONE";
  /** Protected formula/metric cells cannot be overwritten without explicit unlock. */
  protected?: boolean;
  /** Unsupported formula warning (never silently evaluated as 0). */
  unsupportedWarning?: string;
}

export interface SpreadsheetWorksheet {
  sheetId: string;
  name: string;
  cells: Record<string, SpreadsheetCellRecord>;
}

export interface SpreadsheetWorkbook {
  workbookId: string;
  title: string;
  revision: number;
  dateSystem: "1900" | "1904";
  sheets: SpreadsheetWorksheet[];
  unsupportedFeatures: string[];
}

export type SpreadsheetOperationType =
  | "set_range_formula"
  | "set_cell_value"
  | "format_currency"
  | "create_sheet"
  | "undo_last";

export interface SpreadsheetOperationProposal {
  operationId: string;
  workbookId: string;
  expectedRevision: number;
  sheetName: string;
  targetRange: string;
  action: SpreadsheetOperationType;
  formula?: string;
  fillMode?: "adjust_relative_references" | "fixed";
  currencyDisplayOnly?: "USD" | "KHR";
  requiresApproval: boolean;
  blockedReason?: string;
  inputLanguage: "en" | "km";
  source: OperationSource;
  originalCommand: string;
  explanation: string;
}

export interface CsvExportSafetyReport {
  csv: string;
  neutralizedFormulaCells: number;
  warnings: string[];
}

// =============================================================================
// Stage 3 FR-04 — Data Preparation Studio Contracts (Phase DP-00 Feasibility)
// =============================================================================

export interface DatasetSourceRecord {
  sourceId: string;
  filename: string;
  format: "csv" | "xlsx";
  sha256: string;
  totalRowsRead: number;
  acceptedRows: number;
  rejectedRows: number;
  columnNames: string[];
  importedAt: string;
}

export interface ColumnQualityProfile {
  columnName: string;
  inferredType: "string" | "number" | "date" | "mixed";
  nonNullCount: number;
  nullCount: number;
  emptyStringCount: number;
  zeroCount: number;
  distinctCount: number;
  invalidCount: number;
}

export interface DatasetProfile {
  datasetId: string;
  scope: "sample" | "full";
  sampleSize: number;
  totalRows: number;
  columns: ColumnQualityProfile[];
}

export type DataTransformOpType =
  | "map_schema"
  | "trim_normalize"
  | "normalize_khmer_numerals"
  | "parse_date_locale"
  | "quarantine_missing_required"
  | "validate_schema_contract"
  | "mask_pii_columns"
  | "map_bilingual_dictionary"
  | "deduplicate_composite_key"
  | "append_datasets"
  | "validated_join";

export interface DataTransformStep {
  stepId: string;
  op: DataTransformOpType;
  params: Record<string, unknown>;
}

export interface DataPreparationRecipe {
  recipeId: string;
  version: number;
  tenantId: string;
  workspaceId: string;
  pinnedInputSha256s: string[];
  steps: DataTransformStep[];
  idempotencyKey: string;
}

export interface JoinCardinalityReport {
  expectedCardinality: "one_to_one" | "many_to_one" | "one_to_many" | "many_to_many";
  leftRows: number;
  rightRows: number;
  duplicateRightKeys: string[];
  unmatchedLeftKeys: string[];
  outputRows: number;
  blocked: boolean;
  reason?: string;
}

export interface CurrencyControlTotal {
  currency: string;
  sourceTotal: number;
  preparedTotal: number;
  excludedOrQuarantinedTotal: number;
  unexplainedDifference: number;
  scale?: number;
  sourceMinorUnits?: string;
  preparedMinorUnits?: string;
  excludedMinorUnits?: string;
  unexplainedMinorUnits?: string;
}

export interface ReconciliationReport {
  sourceAcceptedRows: number;
  preparedRows: number;
  quarantinedRows: number;
  deduplicatedRows: number;
  currencyTotals: CurrencyControlTotal[];
  criticalFailures: string[];
  passed: boolean;
}

export interface DatasetExceptionRecord {
  exceptionId: string;
  sourceFile: string;
  sourceRowNumber: number;
  severity: "warning" | "critical";
  code: string;
  message: string;
  rawRecord: Record<string, unknown>;
  resolved: boolean;
}

export interface CertifiedDatasetArtifact {
  datasetId: string;
  version: number;
  tenantId: string;
  workspaceId: string;
  status: "draft" | "certified" | "blocked";
  outputSha256: string;
  rows: Array<Record<string, unknown>>;
  exceptions: DatasetExceptionRecord[];
  reconciliation: ReconciliationReport;
  joinReport?: JoinCardinalityReport;
  lineage: {
    sourceSha256s: string[];
    recipeId: string;
    recipeVersion: number;
    engine: "pipeline-ts" | "duckdb" | "polars";
    createdAt: string;
  };
}

// =============================================================================
// Stage 3 FR-05 — Business Analysis & Calculation Engine Contracts (Phase AN-00)
// =============================================================================

export type RoundingMode = "HALF_UP" | "HALF_EVEN";
export type ZeroDenominatorPolicy = "return_unavailable" | "return_null";
export type MetricAggregationType =
  | "additive"
  | "distinct_count"
  | "ratio"
  | "semi_additive"
  | "average"
  | "derived";
export type VarianceDirection = "higher_is_favorable" | "lower_is_favorable" | "neutral";

export interface FinancialPrecisionPolicy {
  policyId: string;
  name: string;
  monetaryScale: number;
  ratioDisplayScale: number;
  intermediateScale: number;
  roundingMode: RoundingMode;
  zeroDenominatorPolicy: ZeroDenominatorPolicy;
  currencyCode: string;
  currencyConversionRule: "require_explicit_rate_source_date";
  overflowSafeMaxMinorUnits: string;
}

export interface MetricApproval {
  approvalStatus: "draft" | "reviewed" | "certified";
  ownerId: string;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
}

export interface MetricVersion {
  version: number;
  effectiveFrom: string;
  deprecatedAt?: string;
  formulaExpression: string;
  numeratorMetricId?: string;
  denominatorMetricId?: string;
  sourceDatasetId: string;
  granularity: string;
  currency: string;
  unit: string;
  aggregationType: MetricAggregationType;
  varianceDirection: VarianceDirection;
  inclusionRules: string[];
  exclusionRules: string[];
  missingDataPolicy: "block_certification" | "warn_and_exclude";
  precisionPolicyId: string;
  approval: MetricApproval;
  changeSummary: string;
}

export interface MetricDefinition {
  metricId: string;
  displayNameEn: string;
  displayNameKm: string;
  category:
    | "revenue"
    | "cost"
    | "profitability"
    | "growth"
    | "budget"
    | "customer"
    | "statistical";
  currentVersion: number;
  versions: MetricVersion[];
}

export type AnalyticalOperationType =
  | "calculate_metric"
  | "compare_metrics"
  | "group_by_dimension"
  | "budget_vs_actual"
  | "period_comparison"
  | "distinct_count"
  | "descriptive_stats"
  | "contribution_ranking"
  | "historical_trend"
  | "basic_anomaly";

export interface ExchangeRateSpecification {
  fromCurrency: string;
  toCurrency: string;
  rateDecimalString: string;
  source: string;
  effectiveDate: string;
}

export interface AnalyticalQuery {
  queryId: string;
  idempotencyKey: string;
  tenantId: string;
  workspaceId: string;
  operation: AnalyticalOperationType;
  dataset: { id: string; version: number };
  budgetDataset?: { id: string; version: number };
  metrics: Array<{ id: string; version?: number }>;
  period: {
    start: string;
    endExclusive: string;
    isPartialPeriod?: boolean;
    comparableDaysElapsed?: number;
    fullPeriodDays?: number;
    fiscalYearStartMonth?: number;
  };
  comparison?: "none" | "previous_month" | "previous_year" | "ytd" | "qtd";
  groupBy?: string[];
  filters?: Record<string, string | string[]>;
  currency: string;
  exchangeRate?: ExchangeRateSpecification;
  outputLanguage: "en" | "km";
}

export interface AnalysisProvenance {
  provenanceId: string;
  engineName: "duckdb-exact-minor-units";
  engineVersion: string;
  datasetId: string;
  datasetVersion: number;
  datasetSha256: string;
  budgetDatasetId?: string;
  budgetDatasetVersion?: number;
  metricId: string;
  metricVersion: number;
  precisionPolicyId: string;
  executedAt: string;
  inputRowCount: number;
  excludedRowCount: number;
  filterContext: Record<string, string>;
  reportingPeriod: string;
  assumptions: string[];
  warnings: string[];
}

export interface AnalyticalValuePayload {
  status: "available" | "unavailable";
  unavailableReason?: string;
  minorUnits?: string;
  decimalString?: string;
  displayValue: string;
  unit: string;
  currency?: string;
  varianceAssessment?: "favorable" | "unfavorable" | "on_budget" | "neutral";
}

export interface AnalyticalResult {
  resultId: string;
  queryId: string;
  idempotencyKey: string;
  tenantId: string;
  workspaceId: string;
  metricId: string;
  metricVersion: number;
  displayNameEn: string;
  displayNameKm: string;
  value: AnalyticalValuePayload;
  breakdown?: Array<{
    dimensionValues: Record<string, string>;
    value: AnalyticalValuePayload;
  }>;
  stats?: Record<string, number | string | number[]>;
  validationStatus: "certified" | "warning" | "blocked";
  validationErrors: string[];
  observedFacts: string[];
  aiInterpretation?: {
    summaryEn: string;
    summaryKm: string;
    disclaimer: string;
    isObservedFact: false;
  };
  provenance: AnalysisProvenance;
  linkedMetricReference: LinkedMetricReference;
}

// =============================================================================
// Phase D2 — Shared Platform Identity & Membership Contracts
// =============================================================================

export interface AuthenticatedUser {
  userId: string;
  email: string;
  status: "active" | "inactive" | "deleted";
  tokenVersion: number;
}

export interface TenantMembership {
  tenantId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

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

export type LinkedObjectBindingMode =
  | "independent_copy"
  | "refreshable_link"
  | "pinned_snapshot";

export type LinkedResourceState =
  | "current"
  | "update_available"
  | "refreshing"
  | "stale"
  | "incompatible"
  | "access_restricted"
  | "source_unavailable"
  | "detached"
  | "pinned";

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





