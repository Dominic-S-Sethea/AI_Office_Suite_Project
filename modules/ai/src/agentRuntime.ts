import { randomUUID } from "node:crypto";
import type {
  ActorContext,
  AgentRunRecord,
  AgentStepRecord,
  ArtifactClassification,
  ModelRoutingPolicy,
  OperationSource,
  OrganizationStatus,
  TenantSubscription,
  WorkspaceVisibility,
} from "@ai-office-suite/shared-contracts";
import { assertPolicyAllowed } from "@ai-office-suite/authorization";
import type { AuditStore } from "@ai-office-suite/audit";
import { scanForPromptInjection } from "@ai-office-suite/validation";
import { AiPlanningError } from "./planner.ts";
import {
  getAIProviderAdapter,
  ModelRoutingPolicyEngine,
  type AIProviderAdapter,
} from "./providers.ts";
import type { CorporateKnowledgeIndex } from "./knowledgeRetrieval.ts";
import type { ToolDefinitionRegistry } from "./toolRegistry.ts";

export interface QuotaAccountingHooks {
  reserveTokens(params: {
    tenantId: string;
    workspaceId: string;
    actorId: string;
    estimatedTokens: number;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<{ reservationId: string }>;
  settleTokens(params: {
    tenantId: string;
    reservationId: string;
    actualTokens: number;
    estimatedCostMicroUsd: number;
    source: OperationSource | "workflow";
    providerId: string;
    modelId: string;
    isMock: boolean;
  }): Promise<void>;
  releaseTokens(tenantId: string, reservationId: string): Promise<void>;
}

export interface PlannedToolStep {
  toolId: string;
  toolVersion: string;
  params: Record<string, unknown>;
}

export const MAX_AGENT_STEPS = 25;
export const MAX_RUNTIME_CACHE_ENTRIES = 2_000;

export interface ExecuteAgentRunInput {
  actor: ActorContext;
  source: OperationSource | "workflow";
  idempotencyKey: string;
  /** Optional caller-supplied run identifier so cancellation can occur before inference begins. */
  runId?: string;
  instruction: string;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km" | "match";
  classification: ArtifactClassification;
  workspaceVisibility?: WorkspaceVisibility;
  organizationStatus?: OrganizationStatus;
  subscription?: TenantSubscription;
  routingPolicy: ModelRoutingPolicy | null | undefined;
  unhealthyModelIds?: ReadonlySet<string>;
  approved: boolean;
  knowledgeQuery?: string;
  steps: readonly PlannedToolStep[];
  /** Optional hook invoked right before provider inference; return `{ cancel: true }` to test pre-inference cancel. */
  beforeInferenceHook?: (runId: string) => Promise<{ cancel?: boolean } | void>;
  /** Optional hook invoked right before executing a step; return true to trigger mid-run cancellation (AI-T24). */
  beforeStepHook?: (stepIndex: number, run: AgentRunRecord) => Promise<{ cancel?: boolean } | void>;
  /** Optional hook invoked right before final citation recheck (tests mid-flight revocation AI-T17). */
  beforeCitationRecheckHook?: () => Promise<void>;
}

/**
 * Unified AI Intelligence Core orchestrator (AIC-00 / FR-09).
 * Enforces:
 * 1. Direct prompt-injection defense
 * 2. Centralized PolicyDecisionEngine authorization + entitlement check BEFORE provider invocation
 * 3. Fail-closed classification-aware ModelRoutingPolicyEngine
 * 4. Atomic quota reservation / settlement / release
 * 5. Permission-aware knowledge retrieval with live citation recheck + fact-vs-interpretation separation
 * 6. Deterministic multi-step tool execution + independent exact post-state verification
 * 7. Idempotency by (tenantId, workspaceId, idempotencyKey) and safe mid-run cancellation
 */
export class AiIntelligenceCore {
  private readonly router: ModelRoutingPolicyEngine;
  private readonly tools: ToolDefinitionRegistry;
  private readonly knowledge?: CorporateKnowledgeIndex;
  private readonly audit: AuditStore;
  private readonly quota?: QuotaAccountingHooks;
  private readonly adapterResolver: (providerId: any) => AIProviderAdapter;
  private readonly runsByIdempotency = new Map<string, AgentRunRecord>();
  private readonly canceledRunIds = new Set<string>();

  constructor(deps: {
    router?: ModelRoutingPolicyEngine;
    tools: ToolDefinitionRegistry;
    knowledge?: CorporateKnowledgeIndex;
    audit: AuditStore;
    quota?: QuotaAccountingHooks;
    adapterResolver?: (providerId: any) => AIProviderAdapter;
  }) {
    this.router = deps.router ?? new ModelRoutingPolicyEngine();
    this.tools = deps.tools;
    if (deps.knowledge) this.knowledge = deps.knowledge;
    this.audit = deps.audit;
    if (deps.quota) this.quota = deps.quota;
    this.adapterResolver = deps.adapterResolver ?? getAIProviderAdapter;
  }

  requestCancel(runId: string): void {
    if (this.canceledRunIds.size >= MAX_RUNTIME_CACHE_ENTRIES && !this.canceledRunIds.has(runId)) {
      const oldestRunId = this.canceledRunIds.keys().next().value;
      if (oldestRunId !== undefined) {
        this.canceledRunIds.delete(oldestRunId);
      }
    }
    this.canceledRunIds.add(runId);
  }

  private recordCompletedRun(idempKey: string, run: AgentRunRecord): void {
    if (this.runsByIdempotency.size >= MAX_RUNTIME_CACHE_ENTRIES && !this.runsByIdempotency.has(idempKey)) {
      const oldestKey = this.runsByIdempotency.keys().next().value;
      if (oldestKey !== undefined) {
        this.runsByIdempotency.delete(oldestKey);
      }
    }
    this.runsByIdempotency.set(idempKey, structuredClone(run));
  }

  private async cancelRun(params: {
    input: ExecuteAgentRunInput;
    idempKey: string;
    run: AgentRunRecord;
    fromStepIndex: number;
    reservationId?: string;
    inferenceMeta?: {
      estimatedCostMicroUsd: number;
      providerId: string;
      modelId: string;
      isMock: boolean;
    };
    summary: string;
  }): Promise<{ run: AgentRunRecord; deduplicated: false }> {
    const { input, idempKey, run, fromStepIndex, reservationId, inferenceMeta, summary } = params;
    for (let rem = fromStepIndex; rem < run.steps.length; rem++) {
      run.steps[rem]!.status = "skipped_canceled";
    }
    run.state = "canceled";
    run.updatedAt = new Date().toISOString();
    if (this.quota && reservationId) {
      if (run.tokensUsed > 0 && inferenceMeta) {
        await this.quota.settleTokens({
          tenantId: input.actor.tenantId,
          reservationId,
          actualTokens: run.tokensUsed,
          estimatedCostMicroUsd: inferenceMeta.estimatedCostMicroUsd,
          source: input.source,
          providerId: inferenceMeta.providerId,
          modelId: inferenceMeta.modelId,
          isMock: inferenceMeta.isMock,
        });
      } else {
        await this.quota.releaseTokens(input.actor.tenantId, reservationId);
      }
    }
    this.audit.append({
      auditId: `aud_${randomUUID()}`,
      tenantId: input.actor.tenantId,
      workspaceId: input.actor.workspaceId,
      actorId: input.actor.userId,
      actorRole: input.actor.role,
      source: input.source === "workflow" ? "system" : input.source,
      action: "ai_core.run_canceled",
      outcome: "success",
      operationId: run.runId,
      summary,
      createdAt: run.updatedAt,
    });
    this.canceledRunIds.delete(run.runId);
    this.recordCompletedRun(idempKey, run);
    return { run, deduplicated: false };
  }

  async executeRun(input: ExecuteAgentRunInput): Promise<{ run: AgentRunRecord; deduplicated: boolean }> {
    const idempKey = `${input.actor.tenantId}::${input.actor.workspaceId}::${input.idempotencyKey}`;
    const existing = this.runsByIdempotency.get(idempKey);
    if (existing) {
      return { run: structuredClone(existing), deduplicated: true };
    }

    if (input.steps.length > MAX_AGENT_STEPS) {
      throw new AiPlanningError(
        400,
        "TOO_MANY_STEPS",
        `Agent run requested ${input.steps.length} steps, exceeding maximum allowed (${MAX_AGENT_STEPS}).`,
      );
    }

    const now = new Date().toISOString();
    const runId = input.runId?.trim() || `run_${randomUUID()}`;

    // 1. Direct prompt-injection check
    const promptScan = scanForPromptInjection(input.instruction);
    if (!promptScan.safe) {
      this.audit.append({
        auditId: `aud_${randomUUID()}`,
        tenantId: input.actor.tenantId,
        workspaceId: input.actor.workspaceId,
        actorId: input.actor.userId,
        actorRole: input.actor.role,
        source: input.source === "workflow" ? "system" : input.source,
        action: "ai_core.prompt_injection_blocked",
        outcome: "denied",
        summary: `Blocked prompt injection in AI instruction: ${promptScan.reasons.join("; ") || "unsafe payload"}`,
        createdAt: now,
      });
      throw new AiPlanningError(
        400,
        "PROMPT_INJECTION_DETECTED",
        promptScan.reasons.join("; ") || "Instruction rejected by prompt-injection safeguard.",
      );
    }

    // 2. Central policy & entitlement authorization BEFORE any model call or quota spend (AI-T27)
    const primaryAction = input.steps.length > 0 ? "apply_ai" : "read";
    assertPolicyAllowed({
      actor: input.actor,
      resourceTenantId: input.actor.tenantId,
      resourceWorkspaceId: input.actor.workspaceId,
      resource: "ai_assistant",
      action: primaryAction,
      source: input.source,
      ...(input.organizationStatus ? { organizationStatus: input.organizationStatus } : {}),
      ...(input.workspaceVisibility ? { workspaceVisibility: input.workspaceVisibility } : {}),
      classification: input.classification,
      ...(input.subscription ? { subscription: input.subscription } : {}),
      entitlementFeature: "aiCoreEnabled",
    });

    // Validate all planned tools & check per-tool authorization + approval requirement up front
    const validatedSteps: Array<{
      step: PlannedToolStep;
      tool: ReturnType<ToolDefinitionRegistry["get"]>;
    }> = [];
    let requiresApproval = false;

    for (const step of input.steps) {
      const { tool, validation } = this.tools.validateToolInvocation(
        step.toolId,
        step.toolVersion,
        step.params,
      );
      if (!validation.valid) {
        throw new AiPlanningError(
          400,
          "TOOL_INPUT_INVALID",
          `Validation failed for '${step.toolId}@${step.toolVersion}': ${validation.errors.join("; ")}`,
        );
      }

      const policyDecision = assertPolicyAllowed({
        actor: input.actor,
        resourceTenantId: input.actor.tenantId,
        resourceWorkspaceId: input.actor.workspaceId,
        resource: tool.resource,
        action: tool.action,
        source: input.source,
        ...(input.organizationStatus ? { organizationStatus: input.organizationStatus } : {}),
        ...(input.workspaceVisibility ? { workspaceVisibility: input.workspaceVisibility } : {}),
        classification: input.classification,
        ...(input.subscription ? { subscription: input.subscription } : {}),
        riskLevel: tool.riskLevel,
      });

      if (tool.requiresApproval || policyDecision.requiresUserApproval) {
        requiresApproval = true;
      }
      validatedSteps.push({ step, tool });
    }

    // 3. Fail-closed classification-aware model routing (AI-T02..T06)
    const requiredCapabilities = [
      "structured_json" as const,
      ...(input.steps.length > 0 ? (["tool_calling"] as const) : []),
      ...(input.inputLanguage === "km" || input.outputLanguage === "km"
        ? (["khmer_bilingual"] as const)
        : []),
      ...(input.knowledgeQuery ? (["grounded_qa"] as const) : []),
    ];

    const routingDecision = this.router.resolveRoute({
      policy: input.routingPolicy,
      classification: input.classification,
      requiredCapabilities,
      ...(input.unhealthyModelIds ? { unhealthyModelIds: input.unhealthyModelIds } : {}),
    });

    const adapter = this.adapterResolver(routingDecision.selected.providerId);

    // 4. Approval gate check (AI-T08)
    const stepRecords: AgentStepRecord[] = validatedSteps.map(({ step, tool }, idx) => ({
      stepIndex: idx,
      toolId: tool.toolId,
      toolVersion: tool.version,
      status: "pending",
      riskLevel: tool.riskLevel,
      params: step.params,
    }));

    if (requiresApproval && !input.approved) {
      this.audit.append({
        auditId: `aud_${randomUUID()}`,
        tenantId: input.actor.tenantId,
        workspaceId: input.actor.workspaceId,
        actorId: input.actor.userId,
        actorRole: input.actor.role,
        source: input.source === "workflow" ? "system" : input.source,
        action: "ai_core.approval_required",
        outcome: "denied",
        operationId: runId,
        summary: `Run ${runId} requires explicit user approval before executing ${stepRecords.length} step(s).`,
        createdAt: new Date().toISOString(),
      });
      throw new AiPlanningError(
        400,
        "APPROVAL_REQUIRED",
        "Explicit user approval is required before executing medium/high-risk AI or voice tool operations.",
      );
    }

    // 5. Atomic quota reservation before inference & execution
    const estimatedTokens = Math.max(250, Math.ceil(input.instruction.length / 2) + input.steps.length * 150);
    let reservationId: string | undefined;
    if (this.quota) {
      const res = await this.quota.reserveTokens({
        tenantId: input.actor.tenantId,
        workspaceId: input.actor.workspaceId,
        actorId: input.actor.userId,
        estimatedTokens,
        idempotencyKey: `ai-run:${input.idempotencyKey}`,
        correlationId: runId,
      });
      reservationId = res.reservationId;
    }

    const run: AgentRunRecord = {
      runId,
      tenantId: input.actor.tenantId,
      workspaceId: input.actor.workspaceId,
      actorId: input.actor.userId,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      state: "executing",
      inputLanguage: input.inputLanguage,
      outputLanguage: input.outputLanguage,
      classification: input.classification,
      routingDecision,
      steps: stepRecords,
      verifiedFacts: [],
      ...(reservationId ? { reservationId } : {}),
      tokensUsed: 0,
      isMock: adapter.isMock,
      createdAt: now,
      updatedAt: now,
    };

    try {
      // 6. Permission-aware corporate knowledge retrieval (if requested)
      let groundedSummary: string | undefined;
      let retrievalResult = this.knowledge && input.knowledgeQuery
        ? this.knowledge.retrieve({ actor: input.actor, query: input.knowledgeQuery })
        : undefined;

      // Pre-inference cancellation check: full quota release when canceled before model inference
      if (input.beforeInferenceHook) {
        const hookRes = await input.beforeInferenceHook(runId);
        if (hookRes?.cancel) {
          this.requestCancel(runId);
        }
      }
      if (this.canceledRunIds.has(runId)) {
        return this.cancelRun({
          input,
          idempKey,
          run,
          fromStepIndex: 0,
          reservationId,
          summary: `AgentRun ${runId} canceled safely before provider inference.`,
        });
      }

      // 7. Provider inference (strictly fail-closed for locked external providers!)
      const inference = await adapter.infer({
        model: routingDecision.selected,
        prompt: input.instruction,
        inputLanguage: input.inputLanguage,
        outputLanguage: input.outputLanguage,
        classification: input.classification,
        ...(retrievalResult?.citations[0]
          ? { groundedContextSummary: retrievalResult.citations.map((c) => c.excerpt).join(" | ") }
          : {}),
      });
      run.tokensUsed = inference.inputTokens + inference.outputTokens;
      run.isMock = inference.isMock;

      if (retrievalResult && this.knowledge) {
        if (input.beforeCitationRecheckHook) {
          await input.beforeCitationRecheckHook();
        }
        retrievalResult = this.knowledge.recheckCitations(input.actor, retrievalResult);
        run.verifiedFacts = retrievalResult.verifiedFacts.map((f) => ({
          claim: f.claim,
          citation: f.citation,
        }));
        if (retrievalResult.status === "insufficient_evidence") {
          groundedSummary = "INSUFFICIENT_EVIDENCE";
        } else if (retrievalResult.status === "conflicting_evidence") {
          groundedSummary = `CONFLICTING_EVIDENCE (${retrievalResult.conflicts.length} conflict(s))`;
        } else if (retrievalResult.revokedAtRecheckCount > 0) {
          // Scrub ungrounded pre-revocation model narrative and expose only surviving cited facts
          const survivingClaims = run.verifiedFacts
            .map((f) =>
              f.citation
                ? `${f.claim} [${f.citation.artifactId}#rev${f.citation.revision}]`
                : f.claim,
            )
            .join("; ");
          groundedSummary = survivingClaims
            ? `GROUNDED_AFTER_REVOCATION: ${survivingClaims}`
            : "INSUFFICIENT_EVIDENCE";
        } else {
          groundedSummary = inference.text;
        }
      }

      run.aiInterpretation = {
        text: groundedSummary ?? inference.text,
        isAuthoritative: false,
        disclaimer:
          inference.disclaimer ??
          "AI interpretation is draft narrative only; authoritative figures come strictly from deterministic engines.",
      };

      // 8. Deterministic multi-step tool execution + independent exact post-state verification
      for (let idx = 0; idx < validatedSteps.length; idx++) {
        if (input.beforeStepHook) {
          const hookRes = await input.beforeStepHook(idx, run);
          if (hookRes?.cancel) {
            this.requestCancel(runId);
          }
        }

        if (this.canceledRunIds.has(runId)) {
          return this.cancelRun({
            input,
            idempKey,
            run,
            fromStepIndex: idx,
            reservationId,
            inferenceMeta: {
              estimatedCostMicroUsd: inference.estimatedCostMicroUsd,
              providerId: inference.providerId,
              modelId: inference.modelId,
              isMock: inference.isMock,
            },
            summary: `AgentRun ${runId} canceled safely before step ${idx}.`,
          });
        }

        const { step, tool } = validatedSteps[idx]!;
        const stepRec = run.steps[idx]!;
        try {
          const execRes = await tool.execute(
            {
              actor: input.actor,
              source: input.source,
              correlationId: runId,
              inputLanguage: input.inputLanguage,
              outputLanguage: input.outputLanguage,
            },
            step.params,
          );
          run.state = "verifying";
          const verification = tool.verifyFinalState(
            execRes.beforeState,
            execRes.afterState,
            step.params,
            execRes.output,
          );
          stepRec.output = execRes.output;
          stepRec.verification = verification;
          if (!verification.verified) {
            stepRec.status = "failed";
            stepRec.error = {
              code: "POST_EXECUTION_VERIFICATION_FAILED",
              message: verification.discrepancies.join("; ") || "Post-state invariant check failed.",
            };
            run.state = "failed";
            run.updatedAt = new Date().toISOString();
            break;
          }
          stepRec.status = "completed";
          run.state = "executing";
        } catch (err) {
          stepRec.status = "failed";
          stepRec.error = {
            code: (err as { code?: string }).code ?? "TOOL_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err),
          };
          run.state = "failed";
          run.updatedAt = new Date().toISOString();
          break;
        }
      }

      if (run.state !== "failed") {
        run.state = "completed";
      }
      run.updatedAt = new Date().toISOString();

      if (this.quota && reservationId) {
        await this.quota.settleTokens({
          tenantId: input.actor.tenantId,
          reservationId,
          actualTokens: run.tokensUsed,
          estimatedCostMicroUsd: inference.estimatedCostMicroUsd,
          source: input.source,
          providerId: inference.providerId,
          modelId: inference.modelId,
          isMock: inference.isMock,
        });
      }

      this.audit.append({
        auditId: `aud_${randomUUID()}`,
        tenantId: input.actor.tenantId,
        workspaceId: input.actor.workspaceId,
        actorId: input.actor.userId,
        actorRole: input.actor.role,
        source: input.source === "workflow" ? "system" : input.source,
        action: run.state === "completed" ? "ai_core.run_completed" : "ai_core.run_failed",
        outcome: run.state === "completed" ? "success" : "failed",
        operationId: runId,
        summary: `AgentRun ${runId} finished in state '${run.state}' (${run.steps.filter((s) => s.status === "completed").length}/${run.steps.length} verified steps).`,
        metadata: {
          modelId: inference.modelId,
          providerId: inference.providerId,
          isMock: inference.isMock,
          tokensUsed: run.tokensUsed,
        },
        createdAt: run.updatedAt,
      });

      this.recordCompletedRun(idempKey, run);
      return { run, deduplicated: false };
    } catch (err) {
      // Release quota cleanly if inference/setup failed before completion
      if (this.quota && reservationId) {
        await this.quota.releaseTokens(input.actor.tenantId, reservationId);
      }
      throw err;
    }
  }
}
