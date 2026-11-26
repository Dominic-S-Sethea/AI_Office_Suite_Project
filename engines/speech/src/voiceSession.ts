import { randomUUID } from "node:crypto";
import type {
  SpeechLanguageCode,
  SpeechProviderId,
  VoiceInputMode,
  VoiceSessionRecord,
  VoiceSessionState,
} from "@ai-office-suite/shared-contracts";
import { SpeechProviderError } from "./errors.ts";

const ALLOWED_TRANSITIONS: Record<VoiceSessionState, ReadonlySet<VoiceSessionState>> = {
  idle: new Set(["requesting_permission", "canceled", "expired"]),
  requesting_permission: new Set(["recording", "error", "canceled", "expired"]),
  recording: new Set(["finalizing", "error", "canceled", "expired"]),
  finalizing: new Set(["transcribing", "error", "canceled", "expired"]),
  transcribing: new Set(["review_clarify", "propose", "error", "canceled", "expired"]),
  review_clarify: new Set(["propose", "error", "canceled", "expired"]),
  propose: new Set(["authorize", "error", "canceled", "expired"]),
  authorize: new Set(["execute_verify", "error", "canceled", "expired"]),
  execute_verify: new Set(["completed", "error", "canceled"]),
  completed: new Set([]),
  canceled: new Set([]),
  error: new Set([]),
  expired: new Set([]),
};

export type P1VoiceFeatureId =
  | "realtime_streaming"
  | "en_km_tts"
  | "vad_barge_in"
  | "within_utterance_code_switching"
  | "custom_pronunciation"
  | "continuous_workflow"
  | "live_km_corpus_eval";

/**
 * Explicit P1 voice feature gate (VOC-03.01..07 / VOC-T24..T30).
 * Always fails closed during VI-00 feasibility so P1 capabilities are never misrepresented as live.
 */
export function assertP1VoiceFeatureAuthorized(feature: P1VoiceFeatureId): never {
  if (feature === "live_km_corpus_eval") {
    throw new SpeechProviderError(
      423,
      "CONSENTED_CORPUS_PENDING",
      "Live native Khmer (km-KH) WER/CER evaluation requires a consented human audio corpus and founder sign-off.",
    );
  }
  throw new SpeechProviderError(
    423,
    "P1_VOICE_FEATURE_GATED",
    `P1 voice expansion feature '${feature}' (VOC-03) is gated pending VI-01+ and P1 authorization.`,
  );
}

export interface VoiceTransitionEvent {
  eventId: string;
  eventSeq: number;
  targetState: VoiceSessionState;
  isPartialTranscript?: boolean;
  nowIso?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface VoiceTransitionOutcome {
  session: VoiceSessionRecord;
  deduplicated: boolean;
  dropped: boolean;
  dropReason?: string;
}

/**
 * Explicit deterministic VoiceSession state machine (VI-00 / VOC-01 / VOC-T01..T07).
 * Enforces legal transitions, event ID deduplication, sequence/late-partial drop protection,
 * inactivity expiry, cancellation cleanup, and ephemeral audio wiping.
 */
export class VoiceSessionManager {
  private readonly sessions = new Map<string, VoiceSessionRecord>();

  createSession(params: {
    tenantId: string;
    workspaceId: string;
    actorId: string;
    mode: VoiceInputMode;
    language: SpeechLanguageCode;
    outputLanguage?: "en" | "km" | "match";
    ttlSeconds?: number;
    nowIso?: string;
  }): VoiceSessionRecord {
    const now = params.nowIso ?? new Date().toISOString();
    const ttlMs = (params.ttlSeconds ?? 180) * 1000;
    const record: VoiceSessionRecord = {
      sessionId: `vs_${randomUUID()}`,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      mode: params.mode,
      language: params.language,
      outputLanguage: params.outputLanguage ?? "match",
      state: "idle",
      lastEventSeq: 0,
      seenEventIds: [],
      appliedTerms: [],
      isMock: true,
      audioBufferPresent: false,
      audioRetained: false,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(record.sessionId, record);
    return structuredClone(record);
  }

  getSession(sessionId: string): VoiceSessionRecord | null {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : null;
  }

  private getMutable(sessionId: string): VoiceSessionRecord {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new SpeechProviderError(404, "VOICE_SESSION_NOT_FOUND", `Voice session '${sessionId}' not found.`);
    }
    return s;
  }

  transition(sessionId: string, event: VoiceTransitionEvent): VoiceTransitionOutcome {
    const s = this.getMutable(sessionId);
    const nowIso = event.nowIso ?? new Date().toISOString();

    // 1. Idempotent duplicate event guard (VOC-T03)
    if (s.seenEventIds.includes(event.eventId)) {
      return { session: structuredClone(s), deduplicated: true, dropped: false };
    }

    // 2. Late / out-of-order partial transcript guard (VOC-T04)
    if (
      event.isPartialTranscript &&
      (event.eventSeq <= s.lastEventSeq ||
        s.state === "finalizing" ||
        s.state === "transcribing" ||
        s.state === "review_clarify" ||
        s.state === "propose" ||
        s.state === "authorize" ||
        s.state === "execute_verify" ||
        s.state === "completed" ||
        s.state === "canceled" ||
        s.state === "expired")
    ) {
      s.seenEventIds.push(event.eventId);
      return {
        session: structuredClone(s),
        deduplicated: false,
        dropped: true,
        dropReason: "LATE_PARTIAL_TRANSCRIPT_IGNORED",
      };
    }

    if (event.eventSeq <= s.lastEventSeq) {
      s.seenEventIds.push(event.eventId);
      return {
        session: structuredClone(s),
        deduplicated: false,
        dropped: true,
        dropReason: "OUT_OF_ORDER_SEQUENCE",
      };
    }

    // 3. Expiry check (VOC-T07)
    if (
      event.targetState !== "expired" &&
      event.targetState !== "canceled" &&
      Date.parse(nowIso) > Date.parse(s.expiresAt)
    ) {
      s.state = "expired";
      s.audioBufferPresent = false;
      s.updatedAt = nowIso;
      s.errorCode = "VOICE_SESSION_EXPIRED";
      s.errorMessage = "Voice session expired due to inactivity.";
      throw new SpeechProviderError(
        410,
        "VOICE_SESSION_EXPIRED",
        "Voice session expired; start a new voice session before executing.",
      );
    }

    // 4. Strict state transition check (VOC-T02)
    const allowed = ALLOWED_TRANSITIONS[s.state];
    if (!allowed.has(event.targetState)) {
      throw new SpeechProviderError(
        409,
        "ILLEGAL_VOICE_STATE_TRANSITION",
        `Illegal VoiceSession transition '${s.state}' -> '${event.targetState}'.`,
      );
    }

    s.state = event.targetState;
    s.lastEventSeq = event.eventSeq;
    s.seenEventIds.push(event.eventId);
    s.updatedAt = nowIso;

    if (event.targetState === "recording") {
      s.audioBufferPresent = true;
    }
    if (event.targetState === "canceled" || event.targetState === "expired" || event.targetState === "error") {
      s.audioBufferPresent = false;
      s.audioRetained = false;
      if (event.errorCode) s.errorCode = event.errorCode;
      if (event.errorMessage) s.errorMessage = event.errorMessage;
    }

    return { session: structuredClone(s), deduplicated: false, dropped: false };
  }

  recordTranscriptionResult(
    sessionId: string,
    params: {
      rawTranscript: string;
      normalizedTranscript: string;
      appliedTerms: Array<{ matchedAlias: string; canonical: string }>;
      confidence: number;
      providerId: SpeechProviderId;
      isMock: boolean;
      retainAudio: boolean;
      criticalFieldValidation: VoiceSessionRecord["criticalFieldValidation"];
      reservationId?: string;
    },
  ): VoiceSessionRecord {
    const s = this.getMutable(sessionId);
    s.rawTranscript = params.rawTranscript;
    s.normalizedTranscript = params.normalizedTranscript;
    s.appliedTerms = params.appliedTerms;
    s.confidence = params.confidence;
    s.providerId = params.providerId;
    s.isMock = params.isMock;
    // Immediately wipe transient audio buffer in ephemeral mode (VOC-T22)
    s.audioBufferPresent = params.retainAudio;
    s.audioRetained = params.retainAudio;
    if (params.criticalFieldValidation) {
      s.criticalFieldValidation = params.criticalFieldValidation;
    }
    if (params.reservationId) {
      s.reservationId = params.reservationId;
    }
    s.updatedAt = new Date().toISOString();
    return structuredClone(s);
  }

  editTranscriptDuringReview(sessionId: string, editedTranscript: string): VoiceSessionRecord {
    const s = this.getMutable(sessionId);
    if (s.state !== "review_clarify") {
      throw new SpeechProviderError(
        409,
        "EDIT_ONLY_ALLOWED_IN_REVIEW",
        `Cannot edit transcript while session is in state '${s.state}'.`,
      );
    }
    s.editedTranscript = editedTranscript.trim();
    s.updatedAt = new Date().toISOString();
    return structuredClone(s);
  }

  /**
   * Immediately terminates all active (non-terminal) voice sessions for a tenant+actor
   * on sign-out, tenant switch, or voice UI close (VOC-T27 / PLT-T13).
   * Guarantees ephemeral audio buffer wiping.
   */
  terminateActiveSessionsForActor(
    tenantId: string,
    actorId: string,
    reason = "ACTOR_SESSION_ENDED",
  ): VoiceSessionRecord[] {
    const terminated: VoiceSessionRecord[] = [];
    const nowIso = new Date().toISOString();
    for (const s of this.sessions.values()) {
      if (s.tenantId !== tenantId || s.actorId !== actorId) continue;
      if (s.state === "completed" || s.state === "canceled" || s.state === "error" || s.state === "expired") {
        continue;
      }
      s.state = "canceled";
      s.audioBufferPresent = false;
      s.audioRetained = false;
      s.errorCode = reason;
      s.errorMessage = `Voice capture terminated safely (${reason}).`;
      s.updatedAt = nowIso;
      terminated.push(structuredClone(s));
    }
    return terminated;
  }

  /**
   * Safely terminates an active session on microphone disconnect (VOC-T17) or
   * mid-recording network failure (VOC-T18), wiping transient audio buffers without executing operations.
   */
  handleHardwareOrNetworkInterruption(
    sessionId: string,
    kind: "microphone_disconnected" | "network_failure",
    eventId: string,
    eventSeq: number,
  ): VoiceTransitionOutcome {
    const errorCode = kind === "microphone_disconnected" ? "MICROPHONE_DISCONNECTED" : "VOICE_NETWORK_FAILURE";
    const errorMessage =
      kind === "microphone_disconnected"
        ? "Microphone disconnected during capture; session terminated safely without execution."
        : "Network connection interrupted during voice capture; session failed safely without duplicate effects.";
    return this.transition(sessionId, {
      eventId,
      eventSeq,
      targetState: "error",
      errorCode,
      errorMessage,
    });
  }
}
