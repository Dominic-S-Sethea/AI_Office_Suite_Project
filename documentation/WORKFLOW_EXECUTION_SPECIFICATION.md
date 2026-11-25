# Durable Cross-Module Workflow Execution Specification (`FR-08` / `XI-00`)

**Implemented Prototype:** `engines/integration/src/integrationEngine.ts` (`startMonthlyReportingWorkflow`, `resumeWorkflow`, `rehydrateWorkflowFromDb`, `cancelWorkflow`) + `engines/integration/src/aiWorkflowPlanner.ts` (`planCrossModuleWorkflow`).

---

## 1. Workflow Lifecycle & State Transitions

Supported `WorkflowLifecycleState` values:
`planned` -> `awaiting_clarification` / `running` -> `awaiting_approval` -> `completed` | `failed` | `cancelled` | `recovery_required`.

P0 Predefined Workflows (`WorkflowDefinition`):
1. `monthly_management_reporting` (Spreadsheet + Document + Dashboard + Presentation + Reporting Package)
2. `financial_report_generation`
3. `executive_presentation_generation`
4. `departmental_kpi_dashboard`

---

## 2. Durability, Idempotency & Security Invariants

1. **Idempotent Execution (`INT-T14`):** `xi_workflow_runs` enforces `UNIQUE (tenant_id, idempotency_key)`; duplicate requests return `deduplicated: true` referencing the existing `runId` without regenerating artifacts.
2. **PostgreSQL Crash/Restart Rehydration (`INT-T14`):** Every step commits its output artifact ID and status into `xi_workflow_runs` inside a tenant-isolated `withTenantTransaction`. `rehydrateWorkflowFromDb()` restores paused/interrupted runs across worker restarts.
3. **Step-Boundary Re-Authorization (`INT-T11`):** Before each step executes, active principal status (`ACCESS_REVOKED`) and RBAC permissions are re-evaluated. Mid-run revocation stops execution immediately in `recovery_required` state without touching prior approved packages.
4. **Failure Isolation & Cancellation (`INT-T13`, `INT-T15`):** Step failure marks `state = "failed"` and stages **zero** partial package; cancellation transitions to `state = "cancelled"` and rejects subsequent `resumeWorkflow` (`409 WORKFLOW_CANCELLED`), leaving previously published revisions intact.

---

## 3. Bilingual EN/KM Workflow Planning (`aiWorkflowPlanner.ts`)

`planCrossModuleWorkflow()` (`isMockPlanner: true`) maps equivalent English and Khmer commands from FR-08 §14 & §16 (e.g., `សូមប្រើទិន្នន័យហិរញ្ញវត្ថុដែលបានអនុម័ត ដើម្បីបង្កើតរបាយការណ៍គ្រប់គ្រងប្រចាំខែ បទបង្ហាញ និងផ្ទាំងព័ត៌មាន។`) onto the same allowlisted `WorkflowDefinition`, prompts for missing reporting period when `hasReportingPeriodContext: false`, enforces `requiresApproval: true`, and refuses direct unapproved auto-publication (`blockedDirectExecution: true`).
