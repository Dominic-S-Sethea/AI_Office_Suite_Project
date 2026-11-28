import type { LinkedMetricReference } from "./documents.ts";

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
  stats?: Record<string, number | string | number[] | null>;
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

