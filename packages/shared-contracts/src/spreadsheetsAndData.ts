import type { OperationRiskLevel, OperationSource } from "./core.ts";

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

