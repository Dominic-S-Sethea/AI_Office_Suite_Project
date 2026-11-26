# AI Tool & Operation Contracts — AI Office Suite

**Phase:** D1 / D4.01 & SS-00 Baseline  
**Invariant:** AI models never mutate database, filesystem, or DOM state directly. They emit structured, schema-validated proposals checked against revision locks, selection hashes, RBAC, and explicit user approval.

## 1. Document Operation Proposal (`DocumentOperationProposal`)

Validated by Zod schema in `packages/validation/src/index.ts` and executed deterministically in `engines/document/src/documentEngine.ts`:

```json
{
  "operationId": "op_uuid",
  "documentId": "doc_uuid",
  "expectedRevision": 2,
  "selection": {
    "blockId": "blk_exec_summary",
    "startOffset": 0,
    "endOffset": 145,
    "selectedText": "...",
    "selectionHash": "a1b2c3d4e5f60718"
  },
  "action": "replace_selection",
  "params": { "replacement": "..." },
  "requestedBy": "user_editor_1",
  "riskLevel": "medium",
  "requiresApproval": true,
  "source": "voice_command",
  "inputLanguage": "km",
  "outputLanguage": "km",
  "originalCommand": "បកប្រែកថាខណ្ឌនេះជាភាសាខ្មែរ",
  "explanation": "Translate the selected paragraph into Khmer and preserve its corporate meaning.",
  "previewDiff": {
    "blockId": "blk_exec_summary",
    "beforeText": "...",
    "afterText": "...",
    "summary": "Replace selected content in block blk_exec_summary."
  },
  "createdAt": "2026-11-26T00:00:00.000Z"
}
```

### Supported D1.04 Actions (English & Khmer Commands)
1. `insert_text` — snaps offset to Khmer `Intl.Segmenter` grapheme boundaries (never splits `U+17D2` coeng clusters).
2. `replace_selection` — verifies `selectionHash`; throws `409 SELECTION_MISMATCH` if block text drifted.
3. `set_heading` — converts paragraph/heading between normal (`0`) and `H1..H3`.
4. `toggle_bold` — applies or removes bold formatting.
5. `set_alignment` — `left | center | right | justify`.
6. `insert_table` — bounded `1..20` rows × `1..10` cols; parses both Arabic (`3x3`) and Khmer (`៣x៣`) numerals.
7. `undo_last` — creates a new non-destructive revision restoring the previous revision's snapshot.

## 2. Spreadsheet Operation Proposal (`SpreadsheetOperationProposal`, FR-03 SS-00)

```json
{
  "operationId": "sop_uuid",
  "workbookId": "wb_finance_demo",
  "expectedRevision": 1,
  "sheetName": "Finance",
  "targetRange": "D2:D4",
  "action": "set_range_formula",
  "formula": "=B2-C2",
  "fillMode": "adjust_relative_references",
  "requiresApproval": true,
  "inputLanguage": "km",
  "source": "voice_command",
  "originalCommand": "គណនាប្រាក់ចំណេញ ដោយយកចំណូលដកចំណាយ",
  "explanation": "Insert editable formula =B2-C2 across D2:D4 with relative row adjustment."
}
```

### Guardrails
- **Formula over hardcoded values:** Calculation proposals insert editable formulas evaluated by `recalculateWorkbook()`.
- **Protected cells:** Targets marked `protected: true` fail with `403 PROTECTED_CELL`.
- **Format vs Conversion:** `"Format as USD"` changes `numberFormat` only; `"Convert to USD"` returns `blockedReason: "EXCHANGE_RATE_REQUIRED"` until rate, source, and effective date are supplied.

## 3. Analytical Operation & Result Contracts (`AnalyticalQuery`, `AnalyticalResult`, `LinkedMetricReference`, FR-05 AN-00)

Validates all natural-language analytical plans via `scanForUnsafeAnalyticalInput()` and deterministic `planAnalyticalCommand()` (`isMockPlanner: true`), compiling only allowlisted operations executed by `BusinessAnalysisEngine` (`engines/analytics/src/analyticalEngine.ts`):

- **Supported Allowlisted Operations:** `calculate_metric`, `compare_metrics`, `group_by_dimension`, `budget_vs_actual`, `period_comparison`, `distinct_count`, `descriptive_stats`, `contribution_ranking`, `historical_trend`, `basic_anomaly`.
- **Clarification Gate:** Ambiguous `"Calculate profit"` / `"គណនាប្រាក់ចំណេញ"` resolves to `clarificationRequired: true` rather than guessing `FIN-GROSS-PROFIT` vs `FIN-OPERATING-PROFIT`.
- **Observed Facts vs AI Interpretation:** Every `AnalyticalResult` populates `observedFacts` strictly from executed BigInt/DuckDB numbers and marks optional narrative commentary with `aiInterpretation.isObservedFact = false`.
- **Cross-Module Extension:** `LinkedMetricReference` adds `provenanceId`, `calculationEngineVersion`, `precisionPolicyId`, `status`, and `unavailableReason` cleanly in place across Document Studio, Spreadsheet Studio, Presentation Studio, and Intelligence Studio.

## 4. Presentation Operation Proposal (`PresentationOperationProposal`, FR-06 PS-00)

Validates all typed/mock English & Khmer commands in `PresentationWorkspaceStore`:
- **Actions:** `add_slide`, `replace_text`, `move_resize_element`, `apply_theme`, `insert_metric`, `change_chart_type`, `translate_narrative`, `undo_last`.
- **Invariants:** Explicit `expectedRevision` (`409`), `requiresApproval: true`, exact `targetElementId` binding, immutable certified `sourceRefs` & `chartSpec.series` when swapping `chartType` or translating slide text, and `scanForPromptInjection()` over both commands and slide text.

## 5. Intelligence Studio Operations & Shared `ChartSpec` (`FR-07 BI-00`)

- **`planBiDashboardCommand` (`isMockPlanner: true`):** Bounded EN/KM operation resolution (`set_department_filter`, `set_chart_type`, `query_metric`, `create_presentation_draft`) sanitized via `scanForUnsafeAnalyticalInput()`.
- **`ChartSpec` & `ChartDataBinding`:** Shared chart payload validated via `validateChartSpecSafety()` (no `<script>`, URLs, or JS callbacks) and compiled uniformly by Apache ECharts SSR (`engines/intelligence/src/chartAdapters.ts`), Vega-Lite comparison JSON, and `PptxGenJS` native OOXML chart generation (`engines/presentation/src/pptxExporter.ts`).

## 6. Cross-Module Integration & Workflow Operation Registry (`FR-08 XI-00`)

- **`planCrossModuleWorkflow()` (`engines/integration/src/aiWorkflowPlanner.ts`, `isMockPlanner: true`):** Parses equivalent English and Khmer multi-module instructions (FR-08 §14 & §16), requests clarification when reporting period/context is missing, enforces `requiresApproval: true`, and refuses unapproved direct package publication (`blockedDirectExecution: true`).
- **Allowlisted Cross-Module Tool Targets:** `find_artifacts`, `get_artifact_metadata`, `resolve_reporting_context`, `execute_metric_query`, `get_verified_result`, `insert_linked_metric`, `insert_linked_chart`, `check_source_updates`, `preview_refresh`, `create_workflow_plan`, `run_workflow_step`, `reconcile_artifact_metrics`, `validate_package`, `request_package_review`, `publish_approved_package` (requires matching digest-bound `PublicationApproval`), `cancel_workflow`, `resume_workflow`, `restore_revision`.

## 7. Unified AI Intelligence Core (`FR-09 AIC-00`)

Unifies all studio planners behind a single app-owned governance and verification layer in `modules/ai`:
- **Provider & Routing Policy (`modules/ai/src/providers.ts`):** `AIProviderAdapter` + `AIModelDescriptor` capability registry + fail-closed `ModelRoutingPolicyEngine`. Missing policies reject with `MISSING_MODEL_ROUTING_POLICY`; privacy-unsafe fallbacks reject with `PRIVACY_UNSAFE_FAILOVER_BLOCKED`; external LLM providers (`openai`, `anthropic`, `google-gemini`) fail closed with `423 EXTERNAL_AI_PROVIDER_NOT_AUTHORIZED`; local mocks carry `isMock: true`.
- **Versioned Tool Registry & Exact Final-State Verifier (`modules/ai/src/toolRegistry.ts`):** `ToolDefinitionRegistry` validates strict `allowedParamKeys`, scans all string arguments via `scanForPromptInjection()`, checks semantic versions (`TOOL_VERSION_MISMATCH`), invokes real deterministic engines, and runs independent `verifyFinalState()` post-execution invariant assertions (`POST_EXECUTION_VERIFICATION_FAILED` on `#DIV/0!`, cycles, or revision drift).
- **Permission-Aware Corporate Knowledge Retrieval (`modules/ai/src/knowledgeRetrieval.ts`):** Two-stage authorization (ACL pre-filter by tenant, workspace visibility, role, department, and non-revoked revision before prompt assembly, plus response-time `recheckCitations()` against live revocation tombstones), indirect prompt-injection sanitization, contradictory-metric detection (`conflicting_evidence`), and explicit `insufficient_evidence` reporting.
- **Durable `AgentRun` Lifecycle (`modules/ai/src/agentRuntime.ts`):** `AiIntelligenceCore` enforces `PolicyDecisionEngine` authorization BEFORE model invocation, explicit approval gating (`APPROVAL_REQUIRED`), atomic quota reserve/settle/release hooks, idempotency by `(tenantId, workspaceId, idempotencyKey)`, safe mid-run cancellation, and explicit separation of `verifiedFacts` from non-authoritative `aiInterpretation` (`isAuthoritative: false`).
