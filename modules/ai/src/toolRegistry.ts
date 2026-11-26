import type {
  ActorContext,
  OperationRiskLevel,
  OperationSource,
  PolicyAction,
  PolicyResourceType,
  ToolExecutionVerification,
  ToolValidationResult,
} from "@ai-office-suite/shared-contracts";
import { scanForPromptInjection } from "@ai-office-suite/validation";
import { AiPlanningError } from "./planner.ts";

export interface ToolExecutionContext {
  actor: ActorContext;
  source: OperationSource | "workflow";
  correlationId: string;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km" | "match";
}

export interface ToolDefinition<
  TState = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly toolId: string;
  readonly version: string;
  readonly studio: "document" | "spreadsheet" | "analytics" | "presentation" | "intelligence" | "integration";
  readonly riskLevel: OperationRiskLevel;
  readonly resource: PolicyResourceType;
  readonly action: PolicyAction;
  readonly requiresApproval: boolean;
  readonly allowedParamKeys: readonly string[];
  validateInput(params: Record<string, unknown>): ToolValidationResult;
  execute(
    ctx: ToolExecutionContext,
    params: Record<string, unknown>,
  ): Promise<{ beforeState: TState; afterState: TState; output: TOutput }>;
  verifyFinalState(
    beforeState: TState,
    afterState: TState,
    params: Record<string, unknown>,
    output: TOutput,
  ): ToolExecutionVerification;
}

function scanObjectStringsForInjection(value: unknown, path = "params"): string[] {
  const errors: string[] = [];
  if (typeof value === "string") {
    const scan = scanForPromptInjection(value);
    if (!scan.safe) {
      errors.push(`Prompt injection detected in '${path}': ${scan.reasons.join("; ") || "blocked"}`);
    }
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => errors.push(...scanObjectStringsForInjection(item, `${path}[${idx}]`)));
    return errors;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      errors.push(...scanObjectStringsForInjection(v, `${path}.${k}`));
    }
  }
  return errors;
}

/**
 * Shared versioned ToolDefinitionRegistry for AIC-00 (AI-04 / AI-07 / AI-T07..T13).
 * Enforces strict schema validation, unknown-parameter rejection, prompt-injection scanning,
 * deterministic execution through studio engines, and independent exact post-state verification.
 */
export class ToolDefinitionRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>();

  private key(toolId: string, version: string): string {
    return `${toolId}@${version}`;
  }

  register<TState, TOutput extends Record<string, unknown>>(def: ToolDefinition<TState, TOutput>): void {
    this.tools.set(this.key(def.toolId, def.version), def);
  }

  get(toolId: string, version: string): ToolDefinition<any, any> {
    const found = this.tools.get(this.key(toolId, version));
    if (!found) {
      const hasOtherVersion = Array.from(this.tools.values()).some((t) => t.toolId === toolId);
      if (hasOtherVersion) {
        throw new AiPlanningError(
          400,
          "TOOL_VERSION_MISMATCH",
          `Tool '${toolId}' exists but version '${version}' is not registered.`,
        );
      }
      throw new AiPlanningError(404, "TOOL_NOT_FOUND", `Tool '${toolId}@${version}' is not registered.`);
    }
    return found;
  }

  list(): Array<{
    toolId: string;
    version: string;
    studio: ToolDefinition["studio"];
    riskLevel: OperationRiskLevel;
    requiresApproval: boolean;
  }> {
    return Array.from(this.tools.values()).map((t) => ({
      toolId: t.toolId,
      version: t.version,
      studio: t.studio,
      riskLevel: t.riskLevel,
      requiresApproval: t.requiresApproval,
    }));
  }

  validateToolInvocation(
    toolId: string,
    version: string,
    params: Record<string, unknown>,
  ): { tool: ToolDefinition<any, any>; validation: ToolValidationResult } {
    const tool = this.get(toolId, version);
    const errors: string[] = [];

    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return { tool, validation: { valid: false, errors: ["Tool params must be a plain object."] } };
    }

    const allowed = new Set(tool.allowedParamKeys);
    for (const key of Object.keys(params)) {
      if (!allowed.has(key)) {
        errors.push(`Unexpected parameter '${key}' for tool '${toolId}@${version}'.`);
      }
    }

    const injectionHits = scanObjectStringsForInjection(params);
    if (injectionHits.length > 0) {
      throw new AiPlanningError(400, "PROMPT_INJECTION_DETECTED", injectionHits[0]!);
    }

    const custom = tool.validateInput(params);
    errors.push(...custom.errors);

    return {
      tool,
      validation: {
        valid: errors.length === 0,
        errors,
      },
    };
  }
}
