import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "@ai-office-suite/shared-contracts";
import { scanForUnsafeAnalyticalInput } from "@ai-office-suite/validation";

export type CrossModulePlannerAction =
  | "create_monthly_package"
  | "insert_linked_table"
  | "insert_linked_chart"
  | "refresh_report_from_new_data"
  | "find_dependent_artifacts"
  | "reconcile_report_and_slides"
  | "publish_package_blocked";

export interface CrossModuleWorkflowPlan {
  planId: string;
  isMockPlanner: true;
  action: CrossModulePlannerAction;
  workflowType?: WorkflowDefinition["workflowType"];
  targetModules: string[];
  clarificationRequired: boolean;
  clarificationQuestionEn?: string;
  clarificationQuestionKm?: string;
  requiresApproval: true;
  blockedDirectExecution?: boolean;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km";
  originalCommand: string;
  proposedTools: string[];
  explanationEn: string;
  explanationKm: string;
}

export class WorkflowPlannerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "WorkflowPlannerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function planCrossModuleWorkflow(params: {
  command: string;
  inputLanguage: "en" | "km";
  outputLanguage?: "en" | "km";
  hasReportingPeriodContext?: boolean;
}): CrossModuleWorkflowPlan {
  const safety = scanForUnsafeAnalyticalInput(params.command);
  if (!safety.safe) {
    throw new WorkflowPlannerError(400, "UNSAFE_WORKFLOW_COMMAND", safety.reasons.join(" "));
  }

  const norm = params.command.normalize("NFC").trim().toLowerCase();
  const outLang = params.outputLanguage ?? params.inputLanguage;
  const planId = `xiplan_${randomUUID().slice(0, 8)}`;

  if (
    norm.includes("bypass approval") ||
    norm.includes("skip review") ||
    norm.includes("auto publish") ||
    norm.includes("ផ្សាយដោយគ្មានការអនុម័ត")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "publish_package_blocked",
      targetModules: ["reporting_package"],
      clarificationRequired: false,
      requiresApproval: true,
      blockedDirectExecution: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      proposedTools: ["request_package_review"],
      explanationEn: "Direct unapproved package publication is prohibited; explicit human approval evidence bound to the manifest digest is mandatory.",
      explanationKm: "ការបោះផ្សាយដោយគ្មានការអនុម័តត្រូវបានហាមឃាត់; ត្រូវតែមានការអនុម័តជាលាយលក្ខណ៍អក្សរភ្ជាប់នឹងសារលិខិតទិន្នន័យ។",
    };
  }

  if (
    norm.includes("reconcile") ||
    norm.includes("consistent") ||
    norm.includes("ត្រូវគ្នាឬអត់") ||
    norm.includes("ពិនិត្យថាតួលេខ")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "reconcile_report_and_slides",
      targetModules: ["documents", "presentations", "intelligence", "spreadsheets"],
      clarificationRequired: false,
      requiresApproval: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      proposedTools: ["reconcile_artifact_metrics", "validate_package"],
      explanationEn: "Reconcile figures across Document, Presentation, Spreadsheet, and Dashboard against certified FR-05 results.",
      explanationKm: "ផ្ទៀងផ្ទាត់តួលេខក្នុងឯកសារ ស្លាយ សៀវភៅបញ្ជី និងផ្ទាំងព័ត៌មានធៀបនឹងលទ្ធផល FR-05។",
    };
  }

  if (
    norm.includes("find") && (norm.includes("artifact") || norm.includes("using this dataset")) ||
    norm.includes("រកឯកសារដែលប្រើទិន្នន័យនេះ")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "find_dependent_artifacts",
      targetModules: ["registry"],
      clarificationRequired: false,
      requiresApproval: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      proposedTools: ["find_artifacts", "get_artifact_metadata"],
      explanationEn: "Inspect permission-filtered dependency graph to list authorized artifacts linked to this dataset.",
      explanationKm: "ស្វែងរកឯកសារដែលមានសិទ្ធិអនុញ្ញាត និងកំពុងភ្ជាប់ទៅទិន្នន័យនេះ។",
    };
  }

  if (
    norm.includes("update the report") ||
    norm.includes("new data") ||
    norm.includes("ធ្វើបច្ចុប្បន្នភាពរបាយការណ៍")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "refresh_report_from_new_data",
      targetModules: ["documents", "analytics"],
      clarificationRequired: false,
      requiresApproval: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      proposedTools: ["check_source_updates", "preview_refresh"],
      explanationEn: "Preview and stage a draft refresh from the newer dataset version without modifying published snapshots.",
      explanationKm: "បង្ហាញការប្រែប្រួល និងធ្វើបច្ចុប្បន្នភាពសេចក្តីព្រាងដោយមិនប៉ះពាល់កំណែបោះផ្សាយចាស់។",
    };
  }

  if (
    norm.includes("insert") && norm.includes("chart") ||
    norm.includes("បញ្ចូលក្រាហ្វ")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "insert_linked_chart",
      targetModules: ["intelligence", "presentations"],
      clarificationRequired: false,
      requiresApproval: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      proposedTools: ["execute_metric_query", "insert_linked_chart"],
      explanationEn: "Insert linked ChartSpec from Intelligence Studio into editable Presentation slide with provenance binding.",
      explanationKm: "បញ្ចូលក្រាហ្វដែលភ្ជាប់ទិន្នន័យពិតពីផ្ទាំងព័ត៌មានទៅក្នុងស្លាយបទបង្ហាញ។",
    };
  }

  if (
    norm.includes("insert") && norm.includes("table") ||
    norm.includes("យកតារាងនេះទៅបញ្ចូល")
  ) {
    return {
      planId,
      isMockPlanner: true,
      action: "insert_linked_table",
      targetModules: ["analytics", "documents"],
      clarificationRequired: false,
      requiresApproval: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      proposedTools: ["get_verified_result", "insert_linked_metric"],
      explanationEn: "Insert verified financial summary table into Document draft with source metadata and freshness tag.",
      explanationKm: "បញ្ចូលតារាងហិរញ្ញវត្ថុដែលបានផ្ទៀងផ្ទាត់ទៅក្នុងរបាយការណ៍ជាមួយប្រភពទិន្នន័យ។",
    };
  }

  if (
    norm.includes("monthly management") ||
    norm.includes("management-reporting package") ||
    (norm.includes("report") && norm.includes("presentation")) ||
    norm.includes("របាយការណ៍គ្រប់គ្រងប្រចាំខែ") ||
    (norm.includes("របាយការណ៍") && norm.includes("បទបង្ហាញ"))
  ) {
    const needsClarification = params.hasReportingPeriodContext === false;
    return {
      planId,
      isMockPlanner: true,
      action: "create_monthly_package",
      workflowType: "monthly_management_reporting",
      targetModules: ["spreadsheets", "documents", "intelligence", "presentations", "reporting_package"],
      clarificationRequired: needsClarification,
      clarificationQuestionEn: needsClarification ? "Please confirm the reporting period (e.g. November 2026) and target currency." : undefined,
      clarificationQuestionKm: needsClarification ? "សូមបញ្ជាក់រយៈពេលរបាយការណ៍ (ឧ. វិច្ឆិកា ២០២៦) និងរូបិយប័ណ្ណ។" : undefined,
      requiresApproval: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      originalCommand: params.command,
      proposedTools: [
        "resolve_reporting_context",
        "execute_metric_query",
        "create_workflow_plan",
        "run_workflow_step",
        "reconcile_artifact_metrics",
        "request_package_review",
      ],
      explanationEn: "Execute end-to-end Monthly Management Reporting workflow across Spreadsheet, Document, Dashboard, Presentation, and Staged Reporting Package.",
      explanationKm: "ដំណើរការកញ្ចប់របាយការណ៍គ្រប់គ្រងប្រចាំខែរួមបញ្ចូលគ្នាទាំងសៀវភៅបញ្ជី ឯកសារ ផ្ទាំងព័ត៌មាន និងស្លាយបទបង្ហាញ។",
    };
  }

  throw new WorkflowPlannerError(422, "UNSUPPORTED_WORKFLOW_COMMAND", `Command '${params.command}' not recognized by mock cross-module planner.`);
}
