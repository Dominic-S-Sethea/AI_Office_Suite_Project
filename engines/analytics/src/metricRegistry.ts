import type {
  MetricDefinition,
  MetricVersion,
} from "@ai-office-suite/shared-contracts";
import { AnalyticsError } from "./precision.ts";

const INITIAL_METRICS: MetricDefinition[] = [
  {
    metricId: "FIN-GROSS-SALES",
    displayNameEn: "Gross sales",
    displayNameKm: "ចំណូលលក់សរុបមុនកាត់បន្ថយ",
    category: "revenue",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "SUM(gross_sales_amount)",
        sourceDatasetId: "finance_sales_lines",
        granularity: "invoice_line + reporting_period + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "additive",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["status = 'posted'", "transaction_type = 'sale'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial approved V1 Gross Sales definition.",
      },
    ],
  },
  {
    metricId: "FIN-NET-SALES",
    displayNameEn: "Net sales revenue",
    displayNameKm: "ចំណូលលក់សុទ្ធ",
    category: "revenue",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "SUM(gross_sales_amount - return_discount_amount)",
        sourceDatasetId: "finance_sales_lines",
        granularity: "invoice_line + reporting_period + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "additive",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'", "out_of_period"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Net sales = Gross sales minus approved returns & discounts.",
      },
    ],
  },
  {
    metricId: "FIN-COGS",
    displayNameEn: "Cost of goods sold",
    displayNameKm: "ថ្លៃដើមទំនិញលក់",
    category: "cost",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "SUM(cogs_amount)",
        sourceDatasetId: "finance_sales_lines",
        granularity: "invoice_line + reporting_period + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "additive",
        varianceDirection: "lower_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Cost of Goods Sold definition.",
      },
    ],
  },
  {
    metricId: "FIN-GROSS-PROFIT",
    displayNameEn: "Gross profit",
    displayNameKm: "ប្រាក់ចំណេញដុល",
    category: "profitability",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "FIN-NET-SALES - FIN-COGS",
        numeratorMetricId: "FIN-NET-SALES",
        denominatorMetricId: "FIN-COGS",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_period + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "derived",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Gross Profit = Net sales - COGS.",
      },
    ],
  },
  {
    metricId: "FIN-GROSS-MARGIN",
    displayNameEn: "Gross profit margin",
    displayNameKm: "អត្រាប្រាក់ចំណេញដុល",
    category: "profitability",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "DIVIDE(FIN-GROSS-PROFIT, FIN-NET-SALES) * 100%",
        numeratorMetricId: "FIN-GROSS-PROFIT",
        denominatorMetricId: "FIN-NET-SALES",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_period + department",
        currency: "USD",
        unit: "percent",
        aggregationType: "ratio",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Gross Margin = combined Gross Profit / combined Net Sales.",
      },
    ],
  },
  {
    metricId: "FIN-OPEX",
    displayNameEn: "Operating expenses",
    displayNameKm: "ចំណាយប្រតិបត្តិការ",
    category: "cost",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "SUM(opex_amount)",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_period + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "additive",
        varianceDirection: "lower_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Operating Expenses.",
      },
    ],
  },
  {
    metricId: "FIN-TOTAL-COSTS",
    displayNameEn: "Total operating & direct costs",
    displayNameKm: "ចំណាយសរុប",
    category: "cost",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "FIN-COGS + FIN-OPEX",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_period + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "additive",
        varianceDirection: "lower_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Total Costs = COGS + OpEx.",
      },
    ],
  },
  {
    metricId: "FIN-OPERATING-PROFIT",
    displayNameEn: "Operating profit",
    displayNameKm: "ប្រាក់ចំណេញប្រតិបត្តិការ",
    category: "profitability",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "FIN-NET-SALES - FIN-COGS - FIN-OPEX",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_period + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "derived",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["approved transactions within reporting period"],
        exclusionRules: ["voided and out-of-scope transactions"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Operating Profit = Net Sales - COGS - OpEx.",
      },
    ],
  },
  {
    metricId: "FIN-OPERATING-MARGIN",
    displayNameEn: "Operating profit margin",
    displayNameKm: "អត្រាប្រាក់ចំណេញប្រតិបត្តិការ",
    category: "profitability",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "DIVIDE(FIN-OPERATING-PROFIT, FIN-NET-SALES) * 100%",
        numeratorMetricId: "FIN-OPERATING-PROFIT",
        denominatorMetricId: "FIN-NET-SALES",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_period + department",
        currency: "USD",
        unit: "percent",
        aggregationType: "ratio",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Operating Margin = combined Operating Profit / combined Net Sales.",
      },
    ],
  },
  {
    metricId: "FIN-REVENUE-GROWTH",
    displayNameEn: "Revenue growth",
    displayNameKm: "កំណើនចំណូល",
    category: "growth",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "DIVIDE(Current_FIN-NET-SALES - Prior_FIN-NET-SALES, Prior_FIN-NET-SALES) * 100%",
        numeratorMetricId: "FIN-NET-SALES",
        denominatorMetricId: "FIN-NET-SALES",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_period",
        currency: "USD",
        unit: "percent",
        aggregationType: "derived",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["status = 'posted'"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Period-over-Period Revenue Growth.",
      },
    ],
  },
  {
    metricId: "FIN-BUDGET-VARIANCE",
    displayNameEn: "Budget variance",
    displayNameKm: "គម្លាតធៀបនឹងថវិកា",
    category: "budget",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "Actual_Aggregated - Budget_Monthly",
        sourceDatasetId: "finance_sales_lines",
        granularity: "reporting_month + department",
        currency: "USD",
        unit: "currency",
        aggregationType: "derived",
        varianceDirection: "neutral",
        inclusionRules: ["aggregated at department + month before join"],
        exclusionRules: ["unmatched voided items"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Budget vs Actual variance after granularity alignment.",
      },
    ],
  },
  {
    metricId: "FIN-DISTINCT-CUSTOMERS",
    displayNameEn: "Distinct customer count",
    displayNameKm: "ចំនួនអតិថិជនផ្ទាល់ខ្លួន",
    category: "customer",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        effectiveFrom: "2026-01-01",
        formulaExpression: "COUNT_DISTINCT(customer_id)",
        sourceDatasetId: "finance_sales_lines",
        granularity: "filtered_dataset",
        currency: "NONE",
        unit: "count",
        aggregationType: "distinct_count",
        varianceDirection: "higher_is_favorable",
        inclusionRules: ["status = 'posted'", "customer_id IS NOT NULL"],
        exclusionRules: ["status = 'voided'"],
        missingDataPolicy: "block_certification",
        precisionPolicyId: "FIN-POL-V1",
        approval: {
          approvalStatus: "certified",
          ownerId: "finance_controller",
          approvedBy: "cfo_delegate",
          approvedAt: "2026-11-26T00:00:00.000Z",
        },
        changeSummary: "Initial V1 Distinct Customer Count recalculated across full filtered scope.",
      },
    ],
  },
];

export class BusinessMetricRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();

  constructor(seedMetrics: MetricDefinition[] = INITIAL_METRICS) {
    for (const def of seedMetrics) {
      this.definitions.set(def.metricId, structuredClone(def));
    }
  }

  listMetrics(): MetricDefinition[] {
    return Array.from(this.definitions.values()).map((d) => structuredClone(d));
  }

  getDefinition(metricId: string): MetricDefinition {
    const def = this.definitions.get(metricId);
    if (!def) {
      throw new AnalyticsError(404, "UNKNOWN_METRIC", `Metric '${metricId}' is not registered in BusinessMetricRegistry.`);
    }
    return structuredClone(def);
  }

  getMetricVersion(metricId: string, version?: number): {
    definition: MetricDefinition;
    versionSpec: MetricVersion;
  } {
    const def = this.getDefinition(metricId);
    const targetVer = version ?? def.currentVersion;
    const versionSpec = def.versions.find((v) => v.version === targetVer);
    if (!versionSpec) {
      throw new AnalyticsError(
        404,
        "UNKNOWN_METRIC_VERSION",
        `Metric '${metricId}' version V${targetVer} does not exist.`,
      );
    }
    return {
      definition: def,
      versionSpec: structuredClone(versionSpec),
    };
  }

  /**
   * Appends a new immutable version to an existing metric definition without altering or deleting
   * historical versions, ensuring published historical reports retain their original semantics.
   */
  registerMetricVersion(
    metricId: string,
    newVersion: Omit<MetricVersion, "version">,
  ): MetricVersion {
    const def = this.definitions.get(metricId);
    if (!def) {
      throw new AnalyticsError(404, "UNKNOWN_METRIC", `Cannot version unknown metric '${metricId}'.`);
    }
    const nextNumber = Math.max(...def.versions.map((v) => v.version)) + 1;
    const prev = def.versions.find((v) => v.version === def.currentVersion);
    if (prev && !prev.deprecatedAt) {
      prev.deprecatedAt = new Date().toISOString();
    }
    const created: MetricVersion = {
      ...structuredClone(newVersion),
      version: nextNumber,
    };
    def.versions.push(created);
    def.currentVersion = nextNumber;
    return structuredClone(created);
  }
}
