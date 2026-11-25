import { randomUUID } from "node:crypto";
import type { AnalyticalQuery } from "@ai-office-suite/shared-contracts";
import { scanForUnsafeAnalyticalInput } from "@ai-office-suite/validation";
import { AnalyticsError } from "./precision.ts";

export interface AnalyticalPlanProposal {
  proposalId: string;
  isMockPlanner: true;
  clarificationRequired: boolean;
  clarificationQuestionEn?: string;
  clarificationQuestionKm?: string;
  candidateMetricIds?: string[];
  query?: AnalyticalQuery;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km";
  originalCommand: string;
  explanationEn: string;
  explanationKm: string;
}

export interface PlanAnalyticalCommandInput {
  tenantId: string;
  workspaceId: string;
  datasetId: string;
  datasetVersion: number;
  budgetDatasetId?: string;
  budgetDatasetVersion?: number;
  command: string;
  inputLanguage: "en" | "km";
  outputLanguage?: "en" | "km";
  periodStart: string;
  periodEndExclusive: string;
  currency?: string;
  idempotencyKey?: string;
}

function normalizeCmd(cmd: string): string {
  return cmd.normalize("NFC").trim().toLowerCase();
}

export function planAnalyticalCommand(input: PlanAnalyticalCommandInput): AnalyticalPlanProposal {
  const safety = scanForUnsafeAnalyticalInput(input.command);
  if (!safety.safe) {
    throw new AnalyticsError(
      400,
      "UNSAFE_ANALYTICAL_OPERATION",
      `Analytical command blocked by safety guard: ${safety.reasons.join(" ")}`,
    );
  }

  const normalized = normalizeCmd(input.command);
  const outLang = input.outputLanguage ?? input.inputLanguage;
  const currency = input.currency ?? "USD";
  const proposalId = `anp_${randomUUID()}`;

  // Ambiguous profit inquiry (ANA-T13) — never silently guess gross vs operating vs net profit
  const isAmbiguousProfitEn =
    /\b(calculate|show|get|what\s+is)\s+(the\s+)?profit\b/.test(normalized) &&
    !/gross\s+profit|operating\s+profit|net\s+profit/.test(normalized);
  const isAmbiguousProfitKm =
    (normalized.includes("ប្រាក់ចំណេញ") || normalized.includes("ចំណេញ")) &&
    !normalized.includes("ប្រាក់ចំណេញដុល") &&
    !normalized.includes("ប្រាក់ចំណេញប្រតិបត្តិការ") &&
    !normalized.includes("ប្រាក់ចំណេញសុទ្ធ");

  if (isAmbiguousProfitEn || isAmbiguousProfitKm) {
    return {
      proposalId,
      isMockPlanner: true,
      clarificationRequired: true,
      clarificationQuestionEn:
        "Please clarify which approved profit metric you need: Gross profit (FIN-GROSS-PROFIT) or Operating profit (FIN-OPERATING-PROFIT).",
      clarificationQuestionKm:
        "សូមបញ្ជាក់ថាតើអ្នកចង់គណនាប្រាក់ចំណេញមួយណា៖ ប្រាក់ចំណេញដុល (FIN-GROSS-PROFIT) ឬ ប្រាក់ចំណេញប្រតិបត្តិការ (FIN-OPERATING-PROFIT)?",
      candidateMetricIds: ["FIN-GROSS-PROFIT", "FIN-OPERATING-PROFIT"],
      inputLanguage: input.inputLanguage,
      outputLanguage: outLang,
      originalCommand: input.command,
      explanationEn: "Ambiguous 'profit' request requires explicit metric selection.",
      explanationKm: "សំណើ 'ប្រាក់ចំណេញ' មិនទាន់ច្បាស់លាស់ តម្រូវឱ្យជ្រើសរើសសូចនាករដែលបានអនុម័ត។",
    };
  }

  const makeQuery = (
    partial: Omit<AnalyticalQuery, "queryId" | "idempotencyKey" | "tenantId" | "workspaceId" | "currency" | "outputLanguage">,
  ): AnalyticalQuery => ({
    queryId: `qry_${randomUUID()}`,
    idempotencyKey: input.idempotencyKey ?? `idem_${randomUUID()}`,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    currency,
    outputLanguage: outLang,
    ...partial,
  });

  // 1. Compare this month's revenue with previous month / ប្រៀបធៀបចំណូលខែនេះជាមួយខែមុន
  if (
    (normalized.includes("compare") && normalized.includes("revenue") && normalized.includes("previous month")) ||
    (normalized.includes("ប្រៀបធៀប") && normalized.includes("ចំណូល") && normalized.includes("ខែមុន"))
  ) {
    return {
      proposalId,
      isMockPlanner: true,
      clarificationRequired: false,
      query: makeQuery({
        operation: "period_comparison",
        dataset: { id: input.datasetId, version: input.datasetVersion },
        metrics: [{ id: "FIN-NET-SALES" }, { id: "FIN-REVENUE-GROWTH" }],
        period: { start: input.periodStart, endExclusive: input.periodEndExclusive },
        comparison: "previous_month",
      }),
      inputLanguage: input.inputLanguage,
      outputLanguage: outLang,
      originalCommand: input.command,
      explanationEn: "Plan period comparison of Net sales revenue (FIN-NET-SALES) and Revenue growth (FIN-REVENUE-GROWTH) against previous month.",
      explanationKm: "គ្រោងការប្រៀបធៀបចំណូលលក់សុទ្ធ (FIN-NET-SALES) និងកំណើនចំណូល (FIN-REVENUE-GROWTH) ធៀបនឹងខែមុន។",
    };
  }

  // 2. Operating profit / ប្រាក់ចំណេញប្រតិបត្តិការ (optionally by department / តាមផ្នែកនីមួយៗ)
  if (
    normalized.includes("operating profit") ||
    normalized.includes("ប្រាក់ចំណេញប្រតិបត្តិការ")
  ) {
    const byDept = normalized.includes("department") || normalized.includes("តាមផ្នែក");
    return {
      proposalId,
      isMockPlanner: true,
      clarificationRequired: false,
      query: makeQuery({
        operation: byDept ? "group_by_dimension" : "calculate_metric",
        dataset: { id: input.datasetId, version: input.datasetVersion },
        metrics: [{ id: "FIN-OPERATING-PROFIT" }, { id: "FIN-OPERATING-MARGIN" }],
        period: { start: input.periodStart, endExclusive: input.periodEndExclusive },
        comparison: "none",
        groupBy: byDept ? ["department"] : undefined,
      }),
      inputLanguage: input.inputLanguage,
      outputLanguage: outLang,
      originalCommand: input.command,
      explanationEn: byDept
        ? "Calculate Operating profit & Operating margin by department using combined totals."
        : "Calculate approved Operating profit (FIN-OPERATING-PROFIT) and Operating margin.",
      explanationKm: byDept
        ? "គណនាប្រាក់ចំណេញប្រតិបត្តិការ និងអត្រាចំណេញតាមផ្នែកនីមួយៗ។"
        : "គណនាប្រាក់ចំណេញប្រតិបត្តិការ (FIN-OPERATING-PROFIT) និងអត្រាចំណេញ។",
    };
  }

  // 3. Calculate total/net revenue / គណនាចំណូលសរុបប្រចាំខែនេះ
  if (
    normalized.includes("net sales") ||
    normalized.includes("total revenue") ||
    (normalized.includes("ចំណូល") && (normalized.includes("សរុប") || normalized.includes("សុទ្ធ")))
  ) {
    return {
      proposalId,
      isMockPlanner: true,
      clarificationRequired: false,
      query: makeQuery({
        operation: "calculate_metric",
        dataset: { id: input.datasetId, version: input.datasetVersion },
        metrics: [{ id: "FIN-NET-SALES" }],
        period: { start: input.periodStart, endExclusive: input.periodEndExclusive },
        comparison: "none",
      }),
      inputLanguage: input.inputLanguage,
      outputLanguage: outLang,
      originalCommand: input.command,
      explanationEn: "Calculate approved Net sales revenue (FIN-NET-SALES).",
      explanationKm: "គណនាចំណូលលក់សុទ្ធ (FIN-NET-SALES) ដែលបានអនុម័ត។",
    };
  }

  // 4. Budget vs actual / ប្រៀបធៀបចំណាយជាក់ស្តែងជាមួយថវិកា
  if (
    (normalized.includes("budget") && (normalized.includes("actual") || normalized.includes("variance"))) ||
    (normalized.includes("ថវិកា") && normalized.includes("ជាក់ស្តែង"))
  ) {
    return {
      proposalId,
      isMockPlanner: true,
      clarificationRequired: false,
      query: makeQuery({
        operation: "budget_vs_actual",
        dataset: { id: input.datasetId, version: input.datasetVersion },
        budgetDataset: input.budgetDatasetId
          ? { id: input.budgetDatasetId, version: input.budgetDatasetVersion ?? 1 }
          : undefined,
        metrics: [{ id: "FIN-BUDGET-VARIANCE" }],
        period: { start: input.periodStart, endExclusive: input.periodEndExclusive },
        groupBy: ["department"],
      }),
      inputLanguage: input.inputLanguage,
      outputLanguage: outLang,
      originalCommand: input.command,
      explanationEn: "Run granularity-aligned Budget vs Actual analysis across departments.",
      explanationKm: "ដំណើរការវិភាគធៀបចំណាយជាក់ស្តែងជាមួយថវិកាប្រចាំខែតាមផ្នែក។",
    };
  }

  // 5. Highest expenditure department / រកផ្នែកដែលមានចំណាយខ្ពស់បំផុត
  if (
    (normalized.includes("highest") && (normalized.includes("expense") || normalized.includes("expenditure") || normalized.includes("cost"))) ||
    (normalized.includes("ផ្នែក") && normalized.includes("ចំណាយខ្ពស់បំផុត"))
  ) {
    return {
      proposalId,
      isMockPlanner: true,
      clarificationRequired: false,
      query: makeQuery({
        operation: "contribution_ranking",
        dataset: { id: input.datasetId, version: input.datasetVersion },
        metrics: [{ id: "FIN-TOTAL-COSTS" }],
        period: { start: input.periodStart, endExclusive: input.periodEndExclusive },
        groupBy: ["department"],
      }),
      inputLanguage: input.inputLanguage,
      outputLanguage: outLang,
      originalCommand: input.command,
      explanationEn: "Rank departments by Total costs (FIN-TOTAL-COSTS) and percentage contribution.",
      explanationKm: "រៀបចំណាត់ថ្នាក់ផ្នែកតាមចំណាយសរុប (FIN-TOTAL-COSTS) និងភាគរយរួមចំណែក។",
    };
  }

  // 6. Distinct customers
  if (normalized.includes("distinct customer") || normalized.includes("unique customer") || normalized.includes("អតិថិជន")) {
    return {
      proposalId,
      isMockPlanner: true,
      clarificationRequired: false,
      query: makeQuery({
        operation: "distinct_count",
        dataset: { id: input.datasetId, version: input.datasetVersion },
        metrics: [{ id: "FIN-DISTINCT-CUSTOMERS" }],
        period: { start: input.periodStart, endExclusive: input.periodEndExclusive },
      }),
      inputLanguage: input.inputLanguage,
      outputLanguage: outLang,
      originalCommand: input.command,
      explanationEn: "Count distinct eligible customers across full filtered scope.",
      explanationKm: "រាប់ចំនួនអតិថិជនផ្ទាល់ខ្លួនដោយមិនរាប់ស្ទួន។",
    };
  }

  throw new AnalyticsError(
    422,
    "UNSUPPORTED_ANALYTICAL_COMMAND",
    `Deterministic mock planner did not recognize analytical instruction '${input.command}'.`,
  );
}
