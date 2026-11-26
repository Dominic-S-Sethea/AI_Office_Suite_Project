import type {
  AIModelCapability,
  AIModelDescriptor,
  AIProviderId,
  ArtifactClassification,
  ModelRoutingDecision,
  ModelRoutingPolicy,
} from "@ai-office-suite/shared-contracts";

export class AIProviderError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AIProviderError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface AIInferenceRequest {
  model: AIModelDescriptor;
  prompt: string;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km" | "match";
  classification: ArtifactClassification;
  structuredOutputSchemaId?: string;
  groundedContextSummary?: string;
}

export interface AIInferenceResponse {
  providerId: AIProviderId;
  modelId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicroUsd: number;
  isMock: boolean;
  disclaimer?: string;
}

export interface AIProviderAdapter {
  readonly providerId: AIProviderId;
  readonly isMock: boolean;
  infer(request: AIInferenceRequest): Promise<AIInferenceResponse>;
}

const CLASSIFICATION_RANK: Record<ArtifactClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export const DEFAULT_AI_MODEL_CATALOG: readonly AIModelDescriptor[] = [
  {
    providerId: "mock-deterministic",
    modelId: "mock-core-primary-v1",
    displayName: "Mock Deterministic Primary (AIC-00 Local Feasibility)",
    capabilities: ["structured_json", "tool_calling", "khmer_bilingual", "grounded_qa"],
    maxContextTokens: 128_000,
    maxClassification: "restricted",
    dataResidency: "local",
    zeroDataRetention: true,
    estimatedInputMicroUsdPer1k: 500,
    estimatedOutputMicroUsdPer1k: 1_500,
    isMock: true,
    healthy: true,
  },
  {
    providerId: "local-sandbox",
    modelId: "local-zdr-secondary-v1",
    displayName: "Local Sandbox ZDR Secondary (AIC-00 Feasibility Fallback)",
    capabilities: ["structured_json", "tool_calling", "khmer_bilingual", "grounded_qa"],
    maxContextTokens: 64_000,
    maxClassification: "restricted",
    dataResidency: "local",
    zeroDataRetention: true,
    estimatedInputMicroUsdPer1k: 300,
    estimatedOutputMicroUsdPer1k: 900,
    isMock: true,
    healthy: true,
  },
  {
    providerId: "openai",
    modelId: "gpt-4.1-mini-external-gated",
    displayName: "External OpenAI Model (GATED 423)",
    capabilities: ["structured_json", "tool_calling", "khmer_bilingual", "grounded_qa"],
    maxContextTokens: 128_000,
    maxClassification: "confidential",
    dataResidency: "us",
    zeroDataRetention: true,
    estimatedInputMicroUsdPer1k: 400,
    estimatedOutputMicroUsdPer1k: 1_600,
    isMock: false,
    healthy: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-external-gated",
    displayName: "External Anthropic Model (GATED 423)",
    capabilities: ["structured_json", "tool_calling", "khmer_bilingual", "grounded_qa"],
    maxContextTokens: 200_000,
    maxClassification: "confidential",
    dataResidency: "us",
    zeroDataRetention: true,
    estimatedInputMicroUsdPer1k: 3_000,
    estimatedOutputMicroUsdPer1k: 15_000,
    isMock: false,
    healthy: true,
  },
  {
    providerId: "google-gemini",
    modelId: "gemini-non-zdr-standard-gated",
    displayName: "External Gemini Standard Non-ZDR (GATED 423)",
    capabilities: ["structured_json", "tool_calling", "khmer_bilingual", "grounded_qa"],
    maxContextTokens: 1_000_000,
    maxClassification: "internal",
    dataResidency: "us",
    zeroDataRetention: false,
    estimatedInputMicroUsdPer1k: 350,
    estimatedOutputMicroUsdPer1k: 1_050,
    isMock: false,
    healthy: true,
  },
];

export class DeterministicMockAIProviderAdapter implements AIProviderAdapter {
  readonly providerId: AIProviderId;
  readonly isMock = true;

  constructor(providerId: "mock-deterministic" | "local-sandbox" = "mock-deterministic") {
    this.providerId = providerId;
  }

  async infer(request: AIInferenceRequest): Promise<AIInferenceResponse> {
    const targetLang =
      request.outputLanguage === "match" ? request.inputLanguage : request.outputLanguage;
    const inputTokens = Math.max(20, Math.ceil(request.prompt.length / 4));
    const text =
      targetLang === "km"
        ? `សេចក្តីពន្យល់ព្រាង (មិនមែនជាប្រភពគណនាផ្លូវការ): ផ្អែកលើទិន្នន័យដែលបានអនុញ្ញាត — ${request.groundedContextSummary ?? request.prompt}`
        : `Draft commentary (non-authoritative): Based on verified workspace figures — ${request.groundedContextSummary ?? request.prompt}`;
    const outputTokens = Math.max(15, Math.ceil(text.length / 4));
    const estimatedCostMicroUsd =
      Math.ceil((inputTokens / 1000) * request.model.estimatedInputMicroUsdPer1k) +
      Math.ceil((outputTokens / 1000) * request.model.estimatedOutputMicroUsdPer1k);

    return {
      providerId: this.providerId,
      modelId: request.model.modelId,
      text,
      inputTokens,
      outputTokens,
      estimatedCostMicroUsd,
      isMock: true,
      disclaimer: "MOCK AI ADAPTER (AIC-00): Deterministic local response — not live LLM inference.",
    };
  }
}

export class FailClosedExternalAIProviderAdapter implements AIProviderAdapter {
  readonly providerId: AIProviderId;
  readonly isMock = false;

  constructor(providerId: "openai" | "anthropic" | "google-gemini") {
    this.providerId = providerId;
  }

  async infer(_request: AIInferenceRequest): Promise<AIInferenceResponse> {
    if (process.env.ALLOW_LIVE_AI_PROVIDERS !== "true") {
      throw new AIProviderError(
        423,
        "EXTERNAL_AI_PROVIDER_NOT_AUTHORIZED",
        `External AI provider '${this.providerId}' is locked in AIC-00 feasibility (requires founder authorization and ALLOW_LIVE_AI_PROVIDERS=true).`,
      );
    }
    throw new AIProviderError(
      501,
      "EXTERNAL_AI_TRANSPORT_DEFERRED",
      `External AI provider '${this.providerId}' live transport is deferred until AIC-01 production authorization.`,
    );
  }
}

export function getAIProviderAdapter(providerId: AIProviderId): AIProviderAdapter {
  switch (providerId) {
    case "mock-deterministic":
      return new DeterministicMockAIProviderAdapter("mock-deterministic");
    case "local-sandbox":
      return new DeterministicMockAIProviderAdapter("local-sandbox");
    case "openai":
    case "anthropic":
    case "google-gemini":
      return new FailClosedExternalAIProviderAdapter(providerId);
  }
}

/**
 * Fail-closed, data-classification & privacy-safe AI model router (AIC-00 / AI-02 / AI-T01..T06).
 */
export class ModelRoutingPolicyEngine {
  private readonly catalog: Map<string, AIModelDescriptor>;

  constructor(catalog: readonly AIModelDescriptor[] = DEFAULT_AI_MODEL_CATALOG) {
    this.catalog = new Map(catalog.map((m) => [m.modelId, m]));
  }

  listCatalog(): AIModelDescriptor[] {
    return Array.from(this.catalog.values());
  }

  resolveRoute(params: {
    policy: ModelRoutingPolicy | null | undefined;
    classification: ArtifactClassification;
    requiredCapabilities: readonly AIModelCapability[];
    unhealthyModelIds?: ReadonlySet<string>;
  }): ModelRoutingDecision {
    if (!params.policy || !Array.isArray(params.policy.rules) || params.policy.rules.length === 0) {
      throw new AIProviderError(
        403,
        "MISSING_MODEL_ROUTING_POLICY",
        "Fail-closed: no tenant ModelRoutingPolicy is configured for AI execution.",
      );
    }

    const rule = params.policy.rules.find((r) => r.classification === params.classification);
    if (!rule || rule.preferredOrder.length === 0) {
      throw new AIProviderError(
        403,
        "MISSING_CLASSIFICATION_ROUTING_RULE",
        `Fail-closed: no routing rule configured for data classification '${params.classification}'.`,
      );
    }

    const attempted: ModelRoutingDecision["attemptedModels"] = [];
    let primaryWasUnhealthy = false;
    let blockedForPrivacyCount = 0;

    for (let i = 0; i < rule.preferredOrder.length; i++) {
      const modelId = rule.preferredOrder[i]!;
      const model = this.catalog.get(modelId);
      if (!model) {
        attempted.push({
          modelId,
          providerId: "mock-deterministic",
          status: "blocked",
          reason: "UNKNOWN_MODEL_ID",
        });
        continue;
      }

      if (!rule.allowedProviders.includes(model.providerId)) {
        blockedForPrivacyCount += 1;
        attempted.push({
          modelId: model.modelId,
          providerId: model.providerId,
          status: "blocked",
          reason: "PROVIDER_NOT_IN_ALLOWLIST",
        });
        continue;
      }

      if (!rule.allowExternalProvider && !model.isMock && model.dataResidency !== "local") {
        blockedForPrivacyCount += 1;
        attempted.push({
          modelId: model.modelId,
          providerId: model.providerId,
          status: "blocked",
          reason: "EXTERNAL_PROVIDER_BLOCKED_BY_POLICY",
        });
        continue;
      }

      if (CLASSIFICATION_RANK[model.maxClassification] < CLASSIFICATION_RANK[params.classification]) {
        blockedForPrivacyCount += 1;
        attempted.push({
          modelId: model.modelId,
          providerId: model.providerId,
          status: "blocked",
          reason: "EXCEEDS_MODEL_CLASSIFICATION_CEILING",
        });
        continue;
      }

      if (rule.requireZeroDataRetention && !model.zeroDataRetention) {
        blockedForPrivacyCount += 1;
        attempted.push({
          modelId: model.modelId,
          providerId: model.providerId,
          status: "blocked",
          reason: "ZERO_DATA_RETENTION_REQUIRED",
        });
        continue;
      }

      if (rule.allowedResidencies && !rule.allowedResidencies.includes(model.dataResidency)) {
        blockedForPrivacyCount += 1;
        attempted.push({
          modelId: model.modelId,
          providerId: model.providerId,
          status: "blocked",
          reason: "DATA_RESIDENCY_DISALLOWED",
        });
        continue;
      }

      const missingCap = params.requiredCapabilities.find((c) => !model.capabilities.includes(c));
      if (missingCap) {
        attempted.push({
          modelId: model.modelId,
          providerId: model.providerId,
          status: "blocked",
          reason: `MISSING_CAPABILITY:${missingCap}`,
        });
        continue;
      }

      if (model.healthy === false || params.unhealthyModelIds?.has(model.modelId)) {
        if (i === 0) primaryWasUnhealthy = true;
        attempted.push({
          modelId: model.modelId,
          providerId: model.providerId,
          status: "unhealthy",
          reason: "PROVIDER_UNHEALTHY",
        });
        continue;
      }

      attempted.push({
        modelId: model.modelId,
        providerId: model.providerId,
        status: "selected",
      });

      return {
        selected: model,
        attemptedModels: attempted,
        policyVersion: params.policy.policyVersion,
        classification: params.classification,
        failoverUsed: i > 0 || primaryWasUnhealthy,
        isMock: model.isMock,
      };
    }

    if (primaryWasUnhealthy && blockedForPrivacyCount > 0) {
      throw new AIProviderError(
        403,
        "PRIVACY_UNSAFE_FAILOVER_BLOCKED",
        `Primary model unavailable and remaining fallback models failed privacy/classification policy for '${params.classification}'.`,
      );
    }

    throw new AIProviderError(
      403,
      "NO_ELIGIBLE_AI_MODEL",
      `No healthy policy-compliant AI model available for classification '${params.classification}'.`,
    );
  }
}

export interface AdapterArchitectureComparisonResult {
  iterations: number;
  directAdapterMeanUs: number;
  sdkWrapperSimulatedMeanUs: number;
  recommendation: "app_owned_direct_adapter";
  rationale: string[];
}

/**
 * Local deterministic microbenchmark comparing app-owned AIProviderAdapter dispatch vs
 * an extra SDK-style translation wrapper layer (AI-T28).
 */
export async function benchmarkDirectAdapterVsSdkWrapper(
  iterations = 200,
): Promise<AdapterArchitectureComparisonResult> {
  const adapter = new DeterministicMockAIProviderAdapter("mock-deterministic");
  const model = DEFAULT_AI_MODEL_CATALOG[0]!;
  const req: AIInferenceRequest = {
    model,
    prompt: "Summarize approved November 2026 operating margin.",
    inputLanguage: "en",
    outputLanguage: "en",
    classification: "confidential",
  };

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    await adapter.infer(req);
  }
  const directMs = performance.now() - t0;

  // Simulates an intermediate SDK normalization/envelope translation wrapper
  const t1 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const sdkEnvelope = JSON.parse(JSON.stringify({ messages: [{ role: "user", content: req.prompt }], meta: req })) as {
      meta: AIInferenceRequest;
    };
    const raw = await adapter.infer(sdkEnvelope.meta);
    JSON.parse(JSON.stringify({ text: raw.text, usage: { promptTokens: raw.inputTokens, completionTokens: raw.outputTokens } }));
  }
  const wrapperMs = performance.now() - t1;

  return {
    iterations,
    directAdapterMeanUs: Number(((directMs * 1000) / iterations).toFixed(2)),
    sdkWrapperSimulatedMeanUs: Number(((wrapperMs * 1000) / iterations).toFixed(2)),
    recommendation: "app_owned_direct_adapter",
    rationale: [
      "App-owned AIProviderAdapter keeps data-classification routing, ZDR policy enforcement, and failover strictly inside our domain boundary.",
      "Zero external SDK dependency coupling or transitive supply-chain license exposure during feasibility.",
      "Optional Vercel AI SDK / provider transport adapter can still sit behind AIProviderAdapter in AIC-01+ if streaming UI ergonomics warrant it.",
    ],
  };
}
