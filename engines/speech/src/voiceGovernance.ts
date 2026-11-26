import type {
  ActorContext,
  ArtifactClassification,
  OrganizationStatus,
  PolicyAction,
  PolicyResourceType,
  SpeechLanguageCode,
  SpeechProviderId,
  SpeechRecognitionAdapter,
  TenantSubscription,
  VoiceInputMode,
  VoicePolicyConfig,
  VoiceSessionRecord,
  WorkspaceVisibility,
} from "@ai-office-suite/shared-contracts";
import { assertPolicyAllowed } from "@ai-office-suite/authorization";
import { scanForPromptInjection } from "@ai-office-suite/validation";
import { SpeechProviderError } from "./errors.ts";
import { validateVoiceCriticalFields } from "./criticalFields.ts";
import type { TerminologyRegistry } from "./terminology.ts";
import { VoiceSessionManager } from "./voiceSession.ts";

export interface VoiceQuotaHooks {
  reserveVoiceSeconds(params: {
    tenantId: string;
    workspaceId: string;
    actorId: string;
    estimatedSeconds: number;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<{ reservationId: string }>;
  settleVoiceSeconds(params: {
    tenantId: string;
    reservationId: string;
    actualSeconds: number;
    estimatedCostMicroUsd: number;
    providerId: string;
    isMock: boolean;
  }): Promise<void>;
  releaseVoiceSeconds(tenantId: string, reservationId: string): Promise<void>;
}

export interface ProcessVoiceUtteranceInput {
  actor: ActorContext;
  policy: VoicePolicyConfig;
  adapter: SpeechRecognitionAdapter;
  mode: VoiceInputMode;
  language: SpeechLanguageCode;
  outputLanguage?: "en" | "km" | "match";
  durationMs: number;
  simulatedTranscript?: string;
  fixtureId?: string;
  overrideConfidence?: number;
  targetResource?: PolicyResourceType;
  targetAction?: PolicyAction;
  workspaceVisibility?: WorkspaceVisibility;
  classification?: ArtifactClassification;
  organizationStatus?: OrganizationStatus;
  subscription?: TenantSubscription;
  idempotencyKey: string;
}

export interface ProcessVoiceUtteranceResult {
  session: VoiceSessionRecord;
  outcome: "dictated_text_only" | "awaiting_review_clarify" | "ready_to_propose";
  effectiveTranscript: string;
  literalText?: string;
  executableCommand: string | null;
  isMock: boolean;
  warnings: string[];
}

export const DEFAULT_VOICE_POLICY = (tenantId: string): VoicePolicyConfig => ({
  tenantId,
  policyVersion: 1,
  allowedLanguages: ["en-US", "km-KH"],
  allowedProviders: ["mock", "faster-whisper"],
  audioRetentionMode: "ephemeral_zero_retention",
  maxClipDurationSeconds: 120,
  minAutoConfirmConfidence: 0.85,
  requireReviewForFinancialCommands: true,
  updatedAt: new Date().toISOString(),
});

/**
 * End-to-end Voice Governance Pipeline (VI-00 / FR-10 / VOC-T08..T23).
 * Enforces:
 * - Language/provider/clip-duration policies and central PolicyDecisionEngine parity
 * - Atomic voice-seconds quota reservation/settlement/release
 * - Strict dictation-vs-command isolation (dictated imperatives NEVER execute)
 * - Tenant-scoped EN/KM terminology normalization & prompt-injection defense
 * - CriticalField validation (currency, FX vs format, dates, ambiguous targets) & low-confidence confirmation
 * - Ephemeral zero-retention audio cleanup
 */
export class VoiceGovernancePipeline {
  readonly sessions: VoiceSessionManager;
  readonly terminology: TerminologyRegistry;
  private readonly quota?: VoiceQuotaHooks;

  constructor(deps: {
    sessions?: VoiceSessionManager;
    terminology: TerminologyRegistry;
    quota?: VoiceQuotaHooks;
  }) {
    this.sessions = deps.sessions ?? new VoiceSessionManager();
    this.terminology = deps.terminology;
    if (deps.quota) this.quota = deps.quota;
  }

  async processUtterance(input: ProcessVoiceUtteranceInput): Promise<ProcessVoiceUtteranceResult> {
    const durationSec = Math.max(1, Math.ceil(input.durationMs / 1000));

    // 1. Voice policy checks (language, provider, max clip duration)
    if (!input.policy.allowedLanguages.includes(input.language)) {
      throw new SpeechProviderError(
        403,
        "VOICE_LANGUAGE_NOT_ALLOWED",
        `Language '${input.language}' is disabled by tenant voice policy.`,
      );
    }
    if (!input.policy.allowedProviders.includes(input.adapter.providerId)) {
      throw new SpeechProviderError(
        403,
        "VOICE_PROVIDER_NOT_ALLOWED",
        `Speech provider '${input.adapter.providerId}' is not permitted by tenant voice policy.`,
      );
    }
    if (durationSec > input.policy.maxClipDurationSeconds) {
      throw new SpeechProviderError(
        413,
        "VOICE_CLIP_TOO_LONG",
        `Audio clip duration (${durationSec}s) exceeds tenant maximum (${input.policy.maxClipDurationSeconds}s).`,
      );
    }

    // 2. Central PolicyDecisionEngine authorization + entitlement check (voice CANNOT bypass RBAC!)
    assertPolicyAllowed({
      actor: input.actor,
      resourceTenantId: input.actor.tenantId,
      resourceWorkspaceId: input.actor.workspaceId,
      resource: "speech",
      action: "transcribe",
      source: "voice_command",
      ...(input.organizationStatus ? { organizationStatus: input.organizationStatus } : {}),
      ...(input.workspaceVisibility ? { workspaceVisibility: input.workspaceVisibility } : {}),
      ...(input.classification ? { classification: input.classification } : {}),
      ...(input.subscription ? { subscription: input.subscription } : {}),
      entitlementFeature: input.language === "km-KH" ? "khmerVoiceEnabled" : "voiceCommandsEnabled",
    });

    if (input.mode !== "dictation" && input.targetResource && input.targetAction) {
      assertPolicyAllowed({
        actor: input.actor,
        resourceTenantId: input.actor.tenantId,
        resourceWorkspaceId: input.actor.workspaceId,
        resource: input.targetResource,
        action: input.targetAction,
        source: "voice_command",
        ...(input.organizationStatus ? { organizationStatus: input.organizationStatus } : {}),
        ...(input.workspaceVisibility ? { workspaceVisibility: input.workspaceVisibility } : {}),
        ...(input.classification ? { classification: input.classification } : {}),
        ...(input.subscription ? { subscription: input.subscription } : {}),
      });
    }

    // 3. Drive VoiceSession state machine cleanly through capture -> transcribing
    const created = this.sessions.createSession({
      tenantId: input.actor.tenantId,
      workspaceId: input.actor.workspaceId,
      actorId: input.actor.userId,
      mode: input.mode,
      language: input.language,
      outputLanguage: input.outputLanguage ?? "match",
    });
    this.sessions.transition(created.sessionId, {
      eventId: `${created.sessionId}:perm`,
      eventSeq: 1,
      targetState: "requesting_permission",
    });
    this.sessions.transition(created.sessionId, {
      eventId: `${created.sessionId}:rec`,
      eventSeq: 2,
      targetState: "recording",
    });

    // 4. Atomic voice-seconds quota reservation
    let reservationId: string | undefined;
    if (this.quota) {
      const res = await this.quota.reserveVoiceSeconds({
        tenantId: input.actor.tenantId,
        workspaceId: input.actor.workspaceId,
        actorId: input.actor.userId,
        estimatedSeconds: durationSec,
        idempotencyKey: `voice:${input.idempotencyKey}`,
        correlationId: created.sessionId,
      });
      reservationId = res.reservationId;
    }

    try {
      this.sessions.transition(created.sessionId, {
        eventId: `${created.sessionId}:fin`,
        eventSeq: 3,
        targetState: "finalizing",
      });
      this.sessions.transition(created.sessionId, {
        eventId: `${created.sessionId}:tr`,
        eventSeq: 4,
        targetState: "transcribing",
      });

      const asr = await input.adapter.transcribe({
        language: input.language,
        mode: input.mode,
        durationMs: input.durationMs,
        ...(input.simulatedTranscript !== undefined ? { simulatedTranscript: input.simulatedTranscript } : {}),
        ...(input.fixtureId !== undefined ? { fixtureId: input.fixtureId } : {}),
      });

      const confidence = input.overrideConfidence ?? asr.confidence;
      const retainAudio = input.policy.audioRetentionMode === "opt_in_short_term";

      // 5. Tenant-scoped terminology normalization (VOC-T17)
      const norm = this.terminology.normalizeTranscript(input.actor.tenantId, asr.transcript);

      // 6. Strict Dictation Mode Isolation (VOC-T08, VOC-T09) — NEVER executes imperatives!
      if (input.mode === "dictation") {
        const validation = validateVoiceCriticalFields(norm.normalizedTranscript, {
          language: input.language,
          mode: "dictation",
        });
        this.sessions.recordTranscriptionResult(created.sessionId, {
          rawTranscript: asr.transcript,
          normalizedTranscript: norm.normalizedTranscript,
          appliedTerms: norm.appliedTerms,
          confidence,
          providerId: asr.provider,
          isMock: asr.isMock,
          retainAudio,
          criticalFieldValidation: validation,
          ...(reservationId ? { reservationId } : {}),
        });
        this.sessions.transition(created.sessionId, {
          eventId: `${created.sessionId}:prop`,
          eventSeq: 5,
          targetState: "propose",
        });
        this.sessions.transition(created.sessionId, {
          eventId: `${created.sessionId}:auth`,
          eventSeq: 6,
          targetState: "authorize",
        });
        this.sessions.transition(created.sessionId, {
          eventId: `${created.sessionId}:exec`,
          eventSeq: 7,
          targetState: "execute_verify",
        });
        const done = this.sessions.transition(created.sessionId, {
          eventId: `${created.sessionId}:done`,
          eventSeq: 8,
          targetState: "completed",
        }).session;

        if (this.quota && reservationId) {
          await this.quota.settleVoiceSeconds({
            tenantId: input.actor.tenantId,
            reservationId,
            actualSeconds: durationSec,
            estimatedCostMicroUsd: durationSec * 150,
            providerId: asr.provider,
            isMock: asr.isMock,
          });
        }

        return {
          session: done,
          outcome: "dictated_text_only",
          effectiveTranscript: norm.normalizedTranscript,
          literalText: norm.normalizedTranscript,
          executableCommand: null,
          isMock: asr.isMock,
          warnings: asr.warnings,
        };
      }

      // 7. Prompt-injection resistance for spoken commands (VOC-T21)
      const rawScan = scanForPromptInjection(asr.transcript);
      const normScan = scanForPromptInjection(norm.normalizedTranscript);
      if (!rawScan.safe || !normScan.safe) {
        const injectionReason =
          [...rawScan.reasons, ...normScan.reasons].join("; ") ||
          "Spoken command rejected by prompt-injection safeguard.";
        this.sessions.transition(created.sessionId, {
          eventId: `${created.sessionId}:err-inj`,
          eventSeq: 5,
          targetState: "error",
          errorCode: "PROMPT_INJECTION_DETECTED",
          errorMessage: injectionReason,
        });
        if (this.quota && reservationId) {
          await this.quota.releaseVoiceSeconds(input.actor.tenantId, reservationId);
        }
        throw new SpeechProviderError(400, "PROMPT_INJECTION_DETECTED", injectionReason);
      }

      // 8. Bilingual EN/KM CriticalField validation & low-confidence gate (VOC-T10..T15)
      const validation = validateVoiceCriticalFields(norm.normalizedTranscript, {
        language: input.language,
        mode: input.mode,
      });

      this.sessions.recordTranscriptionResult(created.sessionId, {
        rawTranscript: asr.transcript,
        normalizedTranscript: norm.normalizedTranscript,
        appliedTerms: norm.appliedTerms,
        confidence,
        providerId: asr.provider,
        isMock: asr.isMock,
        retainAudio,
        criticalFieldValidation: validation,
        ...(reservationId ? { reservationId } : {}),
      });

      const hasFinancialFields = validation.fields.some(
        (f) => f.kind === "amount" || f.kind === "currency_intent" || f.kind === "percentage",
      );
      const needsReview =
        validation.requiresClarification ||
        confidence < input.policy.minAutoConfirmConfidence ||
        (input.policy.requireReviewForFinancialCommands && hasFinancialFields) ||
        norm.appliedTerms.length > 0;

      if (this.quota && reservationId) {
        await this.quota.settleVoiceSeconds({
          tenantId: input.actor.tenantId,
          reservationId,
          actualSeconds: durationSec,
          estimatedCostMicroUsd: durationSec * 150,
          providerId: asr.provider,
          isMock: asr.isMock,
        });
      }

      if (needsReview) {
        const paused = this.sessions.transition(created.sessionId, {
          eventId: `${created.sessionId}:review`,
          eventSeq: 5,
          targetState: "review_clarify",
        }).session;
        return {
          session: paused,
          outcome: "awaiting_review_clarify",
          effectiveTranscript: norm.normalizedTranscript,
          executableCommand: null,
          isMock: asr.isMock,
          warnings: [
            ...asr.warnings,
            ...validation.clarificationPrompts,
            ...(confidence < input.policy.minAutoConfirmConfidence
              ? [`Low ASR confidence (${confidence.toFixed(2)} < ${input.policy.minAutoConfirmConfidence}); user confirmation required.`]
              : []),
          ],
        };
      }

      const ready = this.sessions.transition(created.sessionId, {
        eventId: `${created.sessionId}:prop`,
        eventSeq: 5,
        targetState: "propose",
      }).session;

      return {
        session: ready,
        outcome: "ready_to_propose",
        effectiveTranscript: norm.normalizedTranscript,
        executableCommand: norm.normalizedTranscript,
        isMock: asr.isMock,
        warnings: asr.warnings,
      };
    } catch (err) {
      if (this.quota && reservationId) {
        try {
          await this.quota.releaseVoiceSeconds(input.actor.tenantId, reservationId);
        } catch {
          // best-effort release
        }
      }
      throw err;
    }
  }

  /**
   * Confirms (and optionally edits) a paused `review_clarify` session, re-running prompt-injection
   * and CriticalField validation before releasing the command for proposal (VOC-T16).
   */
  confirmReviewedTranscript(params: {
    sessionId: string;
    editedTranscript?: string;
    eventId: string;
    eventSeq: number;
  }): { session: VoiceSessionRecord; effectiveCommand: string } {
    if (params.editedTranscript !== undefined) {
      this.sessions.editTranscriptDuringReview(params.sessionId, params.editedTranscript);
    }
    const current = this.sessions.getSession(params.sessionId);
    if (!current) {
      throw new SpeechProviderError(404, "VOICE_SESSION_NOT_FOUND", "Voice session not found.");
    }
    const effective = (current.editedTranscript ?? current.normalizedTranscript ?? "").trim();
    const scan = scanForPromptInjection(effective);
    if (!scan.safe) {
      throw new SpeechProviderError(
        400,
        "PROMPT_INJECTION_DETECTED",
        scan.reasons.join("; ") || "Edited transcript rejected by prompt-injection safeguard.",
      );
    }

    const validation = validateVoiceCriticalFields(effective, {
      language: current.language,
      mode: current.mode,
    });
    if (validation.requiresClarification) {
      throw new SpeechProviderError(
        400,
        validation.ambiguityCodes[0] ?? "CRITICAL_FIELD_CLARIFICATION_REQUIRED",
        validation.clarificationPrompts.join(" "),
      );
    }

    const updated = this.sessions.transition(params.sessionId, {
      eventId: params.eventId,
      eventSeq: params.eventSeq,
      targetState: "propose",
    }).session;

    return { session: updated, effectiveCommand: effective };
  }

  async cancelSessionWithQuotaRelease(params: {
    sessionId: string;
    eventId: string;
    eventSeq: number;
  }): Promise<{ session: VoiceSessionRecord; quotaReleased: boolean }> {
    const before = this.sessions.getSession(params.sessionId);
    const canceled = this.sessions.transition(params.sessionId, {
      eventId: params.eventId,
      eventSeq: params.eventSeq,
      targetState: "canceled",
    }).session;
    let quotaReleased = false;
    if (this.quota && before?.reservationId) {
      await this.quota.releaseVoiceSeconds(before.tenantId, before.reservationId);
      quotaReleased = true;
    }
    return { session: canceled, quotaReleased };
  }
}
