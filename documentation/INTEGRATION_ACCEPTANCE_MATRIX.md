# Cross-Module Integration Acceptance Matrix (`INT-T01` .. `INT-T24`)

**Verification Suite:** `tests/g1-xi00-cross-module-integration.test.ts`  
**Latest Verified Result (`task-1032`):** **PASS — 3/3 integration test blocks (`12/12` workspace suites, `32/32` tests)** against real `PgliteDatabaseAdapter` PostgreSQL RLS/outbox transactions, FR-05 `BusinessAnalysisEngine`, `DocumentService`, `recalculateWorkbook`, `PresentationWorkspaceStore` + `pptxgenjs`, and `IntelligenceStudioEngine` + `echarts`.

| ID | Scenario | Independently Specified Expected Outcome | Verified Status in `XI-00` |
| :--- | :--- | :--- | :--- |
| **INT-T01** | Insert certified V1 metrics into Workbook, Document, Dashboard & Presentation | Identical `$150,000.00` Net Sales, `$40,000.00` Operating Profit, `26.67%` Margin, `20.00%` Growth | **PASS** |
| **INT-T02** | Insert filtered analytical table (`Sales + Services`) | `$125,000.00`, `$35,000.00`, `28.00%`, filter `departments=Sales,Services`, USD unit | **PASS** |
| **INT-T03** | Convert dashboard chart into presentation slide chart | Native `<c:chart>` element bound to `ChartSpec` inserted and editable | **PASS** |
| **INT-T04** | Rename source workbook | `artifactId` unchanged; internal `LinkedObjectBinding` remains `"current"` | **PASS** |
| **INT-T05** | Register Dataset V2 (`+10k` Sales, `+6k` COGS) | Live draft binding detects `"update_available"`; V1 archive remains `"pinned"` | **PASS** |
| **INT-T06** | Preview & apply draft refresh on V2 | Exact delta (`$150k->$160k`, `$40k->$44k`, `26.67%->27.50%`, `20%->28%`), draft rev 2 | **PASS** |
| **INT-T07** | Open published V1 package after V2 refresh | Historical V1 package retains immutable `$150,000.00` / `$40,000.00` | **PASS** |
| **INT-T08** | Bump metric formula version (`FIN-OPERATING-PROFIT` V2) | `analyzeMetricChangeImpact()` identifies all 4 dependent studio artifacts | **PASS** |
| **INT-T09** | Remove required `cogs` column in Dataset V3 | `evaluateLinkState` returns `"incompatible"`; `applyRefreshProposal` throws `422` | **PASS** |
| **INT-T10** | Attempt unauthorized column/tenant source access | Rejected (`403 SOURCE_ACCESS_DENIED` / `TENANT_ISOLATION_DENIED`), `0` PG RLS beta rows | **PASS** |
| **INT-T11** | Revoke access during active workflow | Subsequent `resumeWorkflow` fails closed (`403 ACCESS_REVOKED`) | **PASS** |
| **INT-T12** | Generate multi-artifact monthly reporting package | All 4 artifacts reconcile & bind exact dataset/metric versions | **PASS** |
| **INT-T13** | Simulate failure during presentation step | Workflow fails cleanly (`state: "failed"`); zero partial package; V1 intact | **PASS** |
| **INT-T14** | Duplicate `idempotencyKey` & crash/rehydrate resume | Deduplicated rerun + clean `rehydrateWorkflowFromDb()` resume across restart | **PASS** |
| **INT-T15** | Cancel paused workflow | Transitions to `"cancelled"`; blocks further resume (`409 WORKFLOW_CANCELLED`) | **PASS** |
| **INT-T16** | Concurrent artifact revision edit (`expectedRevision: 999`) | Rejected atomically (`409 REVISION_CONFLICT`) | **PASS** |
| **INT-T17** | Modify staged package after approval | Recomputes digest, invalidates approval, blocks publish (`409 APPROVAL_INVALIDATED`) | **PASS** |
| **INT-T18** | Equivalent English & Khmer workflow commands | Matching plans/tools (`isMockPlanner: true`), clarification prompt, blocks auto-publish | **PASS** |
| **INT-T19** | Unauthorized external export (viewer role) | Rejected (`403 FORBIDDEN_ROLE`) | **PASS** |
| **INT-T20** | Inspect dependency graph with limited access | Restricted `Executive Payroll Ledger 2026` redacted completely (`redactedCount >= 1`) | **PASS** |
| **INT-T21** | Export Sales-only embedded PPTX chart & disclosure | XML contains `80000` only; omits Services/Retail, invoice IDs & speaker note text | **PASS** |
| **INT-T22** | Failure during PostgreSQL publication commit | Full TX rollback (`0` partial publish, `0` outbox events); atomic retry succeeds | **PASS** |
| **INT-T23** | Restore Document to revision 1 | Creates revision 3 (`restoredFromRevision: 1`) preserving full history | **PASS** |
| **INT-T24** | Policy narrowed (`ALL -> Sales only`) cache check | Cache invalidated (`cacheHit: false`, `pol_sales_only:v2`), returns `$80,000.00` | **PASS** |

## Deferred P1 Scope
- `INT-04.01` (Scheduled linked-content refresh), `INT-04.02` (Visual workflow builder), and `INT-04.03` (External connectors) remain explicitly **PENDING P1**.
