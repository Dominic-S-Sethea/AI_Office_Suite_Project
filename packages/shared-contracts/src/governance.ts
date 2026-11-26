import type {
  ActorContext,
  OperationRiskLevel,
  OperationSource,
  WorkspaceRole,
} from "./core.ts";
import type { ArtifactClassification } from "./integration.ts";
import type { SpeechLanguageCode, SpeechProviderId } from "./documents.ts";

// =============================================================================
// V1.3 Shared Governance Contracts — PA-00 (FR-11), AIC-00 (FR-09), VI-00 (FR-10)
// =============================================================================

export type OrganizationStatus = "active" | "suspended";
export type WorkspaceVisibility = "standard" | "restricted";
export type MembershipStatus = "active" | "suspended" | "revoked";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
export type SubscriptionStatus = "active" | "grace" | "past_due" | "suspended" | "canceled";
export type FileQuarantineState = "pending_scan" | "clean" | "quarantined";
export type DurableJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "dead_letter";

export type QuotaDimension =
  | "ai_tokens"
  | "ai_requests"
  | "voice_seconds"
  | "storage_bytes"
  | "concurrent_jobs"
  | "seats";

export interface OrganizationRecord {
  tenantId: string;
  name: string;
  status: OrganizationStatus;
  mfaRequiredForPrivileged: boolean;
  createdAt: string;
}

export interface WorkspaceRecord {
  tenantId: string;
  workspaceId: string;
  name: string;
  visibility: WorkspaceVisibility;
  createdAt: string;
}

export interface InvitationRecord {
  invitationId: string;
  tenantId: string;
  workspaceId: string;
  email: string;
  invitedRole: WorkspaceRole;
  invitedBy: string;
  tokenSha256: string;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export interface PlanEntitlements {
  aiCoreEnabled: boolean;
  voiceCommandsEnabled: boolean;
  khmerVoiceEnabled: boolean;
  crossModuleReportingEnabled: boolean;
  auditExportEnabled: boolean;
  maxWorkspaces: number;
  maxSeats: number;
  monthlyAiTokens: number;
  monthlyAiRequests: number;
  monthlyVoiceSeconds: number;
  storageQuotaBytes: number;
  maxConcurrentJobs: number;
}

export interface PlanVersion {
  planId: string;
  version: number;
  displayName: string;
  entitlements: PlanEntitlements;
  createdAt: string;
}

export interface TenantSubscription {
  tenantId: string;
  planId: string;
  planVersion: number;
  status: SubscriptionStatus;
  seatLimit: number;
  entitlements: PlanEntitlements;
  policyVersion: number;
  updatedAt: string;
}

export interface UsageReservation {
  reservationId: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
  dimension: QuotaDimension;
  periodKey: string;
  reservedUnits: number;
  settledUnits: number;
  status: "reserved" | "settled" | "released" | "expired";
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageLedgerEntry {
  ledgerId: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
  source: OperationSource | "system" | "workflow";
  dimension: QuotaDimension;
  units: number;
  estimatedCostMicroUsd: number;
  providerId?: string;
  modelId?: string;
  correlationId: string;
  reservationId?: string;
  isMock: boolean;
  createdAt: string;
}

export interface BillingWebhookEvent {
  providerEventId: string;
  eventType:
    | "subscription.upgraded"
    | "subscription.downgraded"
    | "subscription.past_due"
    | "subscription.grace"
    | "subscription.reactivated"
    | "subscription.canceled";
  tenantId: string;
  planId?: string;
  planVersion?: number;
  occurredAt: string;
  isMock: true;
}

export interface VersionedFileObject {
  tenantId: string;
  workspaceId: string;
  objectId: string;
  version: number;
  storageKey: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  classification: ArtifactClassification;
  quarantineState: FileQuarantineState;
  legalHold: boolean;
  retentionUntil?: string;
  deletedAt?: string;
  createdBy: string;
  createdAt: string;
}

export interface DurableJobRecord {
  jobId: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
  jobType: string;
  idempotencyKey: string;
  state: DurableJobState;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  leaseToken?: string;
  fencingGeneration: number;
  workerId?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  cancelRequestedAt?: string;
  attempt: number;
  maxAttempts: number;
  reservationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceHealthSnapshot {
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: string;
  database: {
    connected: boolean;
    engine: "pglite" | "node-pg";
    coreForceRlsEnabled: boolean;
    paForceRlsEnabled: boolean;
  };
  jobs: {
    queued: number;
    running: number;
    expiredLeases: number;
    deadLetter: number;
  };
  storage: {
    totalObjects: number;
    quarantinedObjects: number;
  };
}

// =============================================================================
// Policy Decision Engine Contracts (PA-00 / PLT-02)
// =============================================================================

export type PolicyResourceType =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "dashboard"
  | "reporting_package"
  | "ai_assistant"
  | "audit"
  | "export"
  | "metrics"
  | "speech"
  | "organization"
  | "workspace"
  | "membership"
  | "invitation"
  | "file"
  | "billing"
  | "usage"
  | "entitlement"
  | "policy"
  | "job"
  | "knowledge";

export type PolicyAction =
  | "read"
  | "create"
  | "write"
  | "restore"
  | "export"
  | "apply_ai"
  | "transcribe"
  | "manage"
  | "invite"
  | "revoke"
  | "approve"
  | "transfer_ownership"
  | "delete"
  | "recover"
  | "quarantine"
  | "cancel"
  | "publish"
  | "admin_break_glass";

export type PolicyDenialCategory =
  | "tenant_boundary"
  | "organization_suspended"
  | "mfa_step_up_required"
  | "role_forbidden"
  | "workspace_content_isolated"
  | "entitlement_missing"
  | "quota_or_subscription_restricted"
  | "quarantine_blocked";

export interface PolicyDecisionRequest {
  actor: ActorContext;
  resourceTenantId: string;
  resourceWorkspaceId?: string;
  resource: PolicyResourceType;
  action: PolicyAction;
  source: OperationSource | "workflow" | "system";
  organizationStatus?: OrganizationStatus;
  mfaRequiredForPrivileged?: boolean;
  mfaMaxAgeSeconds?: number;
  workspaceVisibility?: WorkspaceVisibility;
  classification?: ArtifactClassification;
  subscription?: TenantSubscription;
  entitlementFeature?: keyof Pick<
    PlanEntitlements,
    | "aiCoreEnabled"
    | "voiceCommandsEnabled"
    | "khmerVoiceEnabled"
    | "crossModuleReportingEnabled"
    | "auditExportEnabled"
  >;
  /** True when action accesses existing user-authorized work (must remain allowed even if quota/subscription restricts new metered runs). */
  isReadExistingAuthorizedWork?: boolean;
  riskLevel?: OperationRiskLevel;
  nowIso?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  denialCategory?: PolicyDenialCategory;
  code?: string;
  reason?: string;
  requiresUserApproval: boolean;
  evaluatedAt: string;
  source: OperationSource | "workflow" | "system";
}

// =============================================================================
// AIC-00 — AI Intelligence Core Contracts (FR-09)
// =============================================================================

export type AIProviderId =
  | "mock-deterministic"
  | "local-sandbox"
  | "openai"
  | "anthropic"
  | "google-gemini";

export type AIModelCapability =
  | "structured_json"
  | "tool_calling"
  | "khmer_bilingual"
  | "grounded_qa";

export interface AIModelDescriptor {
  providerId: AIProviderId;
  modelId: string;
  displayName: string;
  capabilities: readonly AIModelCapability[];
  maxContextTokens: number;
  maxClassification: ArtifactClassification;
  dataResidency: "local" | "ap-southeast" | "us" | "eu";
  zeroDataRetention: boolean;
  estimatedInputMicroUsdPer1k: number;
  estimatedOutputMicroUsdPer1k: number;
  isMock: boolean;
  healthy?: boolean;
}

export interface ModelRoutingRule {
  classification: ArtifactClassification;
  allowedProviders: readonly AIProviderId[];
  preferredOrder: readonly string[]; // modelIds
  requireZeroDataRetention: boolean;
  allowedResidencies?: readonly AIModelDescriptor["dataResidency"][];
  allowExternalProvider: boolean;
}

export interface ModelRoutingPolicy {
  tenantId: string;
  policyVersion: number;
  rules: readonly ModelRoutingRule[];
  updatedAt: string;
}

export interface ModelRoutingDecision {
  selected: AIModelDescriptor;
  attemptedModels: Array<{ modelId: string; providerId: AIProviderId; status: "selected" | "unhealthy" | "blocked"; reason?: string }>;
  policyVersion: number;
  classification: ArtifactClassification;
  failoverUsed: boolean;
  isMock: boolean;
}

export interface KnowledgeChunkRecord {
  chunkId: string;
  tenantId: string;
  workspaceId: string;
  workspaceVisibility: WorkspaceVisibility;
  artifactId: string;
  artifactKind: "document" | "spreadsheet" | "presentation" | "dashboard" | "dataset" | "reporting_package";
  revision: number;
  classification: ArtifactClassification;
  allowedRoles?: readonly WorkspaceRole[];
  allowedDepartments?: readonly string[] | "ALL";
  tombstoneRevoked: boolean;
  supersededByRevision?: number;
  text: string;
  contentHash: string;
  metricClaims?: Array<{ metricId: string; period: string; formattedValue: string }>;
  updatedAt: string;
}

export interface KnowledgeCitation {
  chunkId: string;
  artifactId: string;
  revision: number;
  contentHash: string;
  excerpt: string;
  verifiedAtRecheck: boolean;
}

export interface KnowledgeConflict {
  metricId: string;
  period: string;
  conflictingValues: Array<{ value: string; artifactId: string; revision: number; chunkId: string }>;
}

export interface KnowledgeRetrievalResult {
  status: "grounded" | "insufficient_evidence" | "conflicting_evidence";
  verifiedFacts: Array<{ claim: string; citation: KnowledgeCitation }>;
  citations: KnowledgeCitation[];
  conflicts: KnowledgeConflict[];
  filteredUnauthorizedCount: number;
  revokedAtRecheckCount: number;
  sanitizedInjectionChunks: string[];
}

export interface ToolValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ToolExecutionVerification {
  verified: boolean;
  checkedInvariants: string[];
  discrepancies: string[];
}

export type AgentRunState =
  | "planned"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "canceled"
  | "denied";

export interface AgentStepRecord {
  stepIndex: number;
  toolId: string;
  toolVersion: string;
  status: "pending" | "completed" | "failed" | "skipped_canceled";
  riskLevel: OperationRiskLevel;
  params: Record<string, unknown>;
  output?: Record<string, unknown>;
  verification?: ToolExecutionVerification;
  error?: { code: string; message: string };
}

export interface AgentRunRecord {
  runId: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
  source: OperationSource | "workflow";
  idempotencyKey: string;
  state: AgentRunState;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km" | "match";
  classification: ArtifactClassification;
  routingDecision?: ModelRoutingDecision;
  steps: AgentStepRecord[];
  verifiedFacts: Array<{ claim: string; citation?: KnowledgeCitation }>;
  aiInterpretation?: {
    text: string;
    isAuthoritative: false;
    disclaimer: string;
  };
  reservationId?: string;
  tokensUsed: number;
  isMock: boolean;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// VI-00 — Advanced Voice Intelligence Contracts (FR-10)
// =============================================================================

export type VoiceInputMode = "dictation" | "command" | "contextual" | "workflow";

export type VoiceSessionState =
  | "idle"
  | "requesting_permission"
  | "recording"
  | "finalizing"
  | "transcribing"
  | "review_clarify"
  | "propose"
  | "authorize"
  | "execute_verify"
  | "completed"
  | "canceled"
  | "error"
  | "expired";

export type CriticalFieldKind =
  | "amount"
  | "currency"
  | "currency_intent"
  | "date_period"
  | "percentage"
  | "cell_range"
  | "metric_target";

export interface ExtractedCriticalField {
  kind: CriticalFieldKind;
  rawText: string;
  normalizedValue: string;
  currency?: "USD" | "KHR";
  ambiguous: boolean;
  ambiguityCode?: string;
  clarificationPrompt?: string;
}

export interface CriticalFieldValidationResult {
  fields: ExtractedCriticalField[];
  requiresClarification: boolean;
  ambiguityCodes: string[];
  clarificationPrompts: string[];
  currencyActionKind?: "format_only" | "fx_conversion_requires_rate" | "none";
}

export interface TerminologyEntry {
  termId: string;
  canonical: string;
  language: "en" | "km" | "bilingual";
  aliases: readonly string[];
  category: "financial_metric" | "organization" | "branch" | "product" | "currency";
}

export interface TerminologyDictionaryVersion {
  tenantId: string;
  version: number;
  entries: readonly TerminologyEntry[];
  updatedAt: string;
}

export interface VoicePolicyConfig {
  tenantId: string;
  policyVersion: number;
  allowedLanguages: readonly SpeechLanguageCode[];
  allowedProviders: readonly SpeechProviderId[];
  audioRetentionMode: "ephemeral_zero_retention" | "opt_in_short_term";
  maxClipDurationSeconds: number;
  minAutoConfirmConfidence: number;
  requireReviewForFinancialCommands: boolean;
  updatedAt: string;
}

export interface VoiceSessionRecord {
  sessionId: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
  mode: VoiceInputMode;
  language: SpeechLanguageCode;
  outputLanguage: "en" | "km" | "match";
  state: VoiceSessionState;
  lastEventSeq: number;
  seenEventIds: string[];
  rawTranscript?: string;
  normalizedTranscript?: string;
  editedTranscript?: string;
  appliedTerms: Array<{ matchedAlias: string; canonical: string }>;
  confidence?: number;
  providerId?: SpeechProviderId;
  isMock: boolean;
  audioBufferPresent: boolean;
  audioRetained: boolean;
  criticalFieldValidation?: CriticalFieldValidationResult;
  reservationId?: string;
  errorCode?: string;
  errorMessage?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
