import { memo, useEffect, useRef, useState } from "react";
import type { DocumentOperationProposal, SpeechRecognitionResult } from "@ai-office-suite/shared-contracts";
import { formatApiErrorMessage, safeReadJson } from "../lib/apiClient.ts";

interface AiVoicePanelProps {
  documentId: string;
  revision: number;
  readOnly: boolean;
  selectionBlockId?: string;
  selectedText: string;
  selectionGraphemeCount?: number;
  selectionStartOffset?: number;
  selectionEndOffset?: number;
  onDocumentUpdated: () => Promise<void>;
  onRevisionConflict?: (message: string) => void;
  onUnauthorized?: () => void;
  apiHeaders: Record<string, string>;
}

function AiVoicePanelInner({
  documentId,
  revision,
  readOnly,
  selectionBlockId,
  selectedText,
  selectionGraphemeCount,
  selectionStartOffset,
  selectionEndOffset,
  onDocumentUpdated,
  onRevisionConflict,
  onUnauthorized,
  apiHeaders,
}: AiVoicePanelProps) {
  const [inputLanguage, setInputLanguage] = useState<"en" | "km">("en");
  const [outputLanguage, setOutputLanguage] = useState<"match" | "en" | "km">("match");
  const [mode, setMode] = useState<"command" | "dictation" | "contextual">("contextual");
  const [command, setCommand] = useState("");
  const [source, setSource] = useState<"typed_ai" | "voice_command">("typed_ai");
  const [voiceEdited, setVoiceEdited] = useState(false);
  const [recording, setRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [micStatus, setMicStatus] = useState<string | null>(null);
  const [recognitionMeta, setRecognitionMeta] = useState<SpeechRecognitionResult | null>(null);
  const [proposal, setProposal] = useState<DocumentOperationProposal | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const busy = isTranscribing || isPlanning || isApplying;

  // Clear stale proposals whenever document or revision changes so user cannot apply outdated diffs
  useEffect(() => {
    setProposal(null);
    setErrorMsg(null);
  }, [documentId, revision]);

  // Always stop active microphone stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  async function startPushToTalk() {
    if (readOnly || busy) return;
    setErrorMsg(null);
    setMicStatus("Requesting browser microphone permission (hardware check only — mock STT active)...");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicStatus("Browser microphone unavailable; use Mock EN/KM Voice or type a command.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setRecording(true);
      setMicStatus(
        `Mic active (${inputLanguage === "km" ? "ខ្មែរ km-KH" : "English en-US"}) — hardware capture check only. Click Stop to run deterministic MockSpeechAdapter (isMock: true).`,
      );
    } catch {
      setMicStatus("Microphone permission denied or unavailable. Text controls remain active.");
    }
  }

  async function stopPushToTalk(fixtureId?: string) {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setRecording(false);
    setMicStatus(null);
    await simulateVoiceFixture(fixtureId ?? (inputLanguage === "km" ? "km-bold-selection" : "en-bold-selection"));
  }

  async function simulateVoiceFixture(fixtureId: string) {
    if (busy) return;
    setErrorMsg(null);
    setIsTranscribing(true);
    const lang = fixtureId.startsWith("km-") ? "km-KH" : "en-US";
    try {
      const res = await fetch("/api/speech/transcribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          provider: "mock",
          language: lang,
          mode,
          fixtureId,
        }),
      });
      const data = await safeReadJson(res);
      if (res.status === 401) {
        onUnauthorized?.();
        setErrorMsg("Session expired. Please sign in again.");
        return;
      }
      if (!res.ok) {
        setErrorMsg(formatApiErrorMessage(res, data, "Speech transcription failed"));
        return;
      }
      const rec = data.recognition as SpeechRecognitionResult;
      setRecognitionMeta(rec);
      setInputLanguage(lang === "km-KH" ? "km" : "en");
      setSource("voice_command");
      setVoiceEdited(false);
      setCommand(rec.transcript);
    } catch {
      setErrorMsg("Network error contacting speech transcription API.");
    } finally {
      setIsTranscribing(false);
    }
  }

  async function handlePlan() {
    if (readOnly || busy || !command.trim()) return;
    setErrorMsg(null);
    setProposal(null);
    setIsPlanning(true);
    try {
      // Honor interaction mode cleanly (M16):
      // - contextual: attach blockId + NFC selectedText + NFC startOffset/endOffset
      // - dictation: convert plain dictated text into explicit insert_text command when not already a command
      // - command: send document-level command with blockId target (no accidental partial range overwrite)
      const normalizedCmd = command.normalize("NFC").trim();
      const effectiveCommand =
        mode === "dictation" && !/^(insert|replace|make|bold|italic|heading|undo|translate|បញ្ចូល|ធ្វើឱ្យ|បកប្រែ|មិនធ្វើវិញ)/i.test(normalizedCmd)
          ? `insert "${normalizedCmd.replace(/"/g, "'")}"`
          : normalizedCmd;

      const selectionPayload =
        mode === "contextual" && selectionBlockId
          ? {
              blockId: selectionBlockId,
              ...(selectedText ? { selectedText: selectedText.normalize("NFC") } : {}),
              ...(typeof selectionStartOffset === "number" &&
              typeof selectionEndOffset === "number" &&
              selectionEndOffset > selectionStartOffset
                ? { startOffset: selectionStartOffset, endOffset: selectionEndOffset }
                : {}),
            }
          : selectionBlockId
            ? { blockId: selectionBlockId }
            : undefined;

      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/ai/plan`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          command: effectiveCommand,
          expectedRevision: revision,
          inputLanguage,
          outputLanguage,
          source,
          selection: selectionPayload,
        }),
      });
      const data = await safeReadJson(res);
      if (res.status === 401) {
        onUnauthorized?.();
        setErrorMsg("Session expired. Please sign in again.");
        return;
      }
      if (res.status === 409) {
        const msg = String(data.error ?? "Revision conflict — reloading latest document.");
        setErrorMsg(msg);
        onRevisionConflict?.(msg);
        return;
      }
      if (!res.ok) {
        setErrorMsg(formatApiErrorMessage(res, data, "Failed to plan AI operation"));
        return;
      }
      setProposal(data.proposal as DocumentOperationProposal);
    } catch {
      setErrorMsg("Network error planning AI operation.");
    } finally {
      setIsPlanning(false);
    }
  }

  async function handleApply() {
    if (!proposal || readOnly || busy) return;
    setErrorMsg(null);
    setIsApplying(true);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/ai/apply`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({ proposal, approved: true }),
      });
      const data = await safeReadJson(res);
      if (res.status === 401) {
        onUnauthorized?.();
        setErrorMsg("Session expired. Please sign in again.");
        return;
      }
      if (res.status === 409) {
        const msg = String(data.error ?? "Document changed before approval — reload and re-plan.");
        setProposal(null);
        setErrorMsg(msg);
        onRevisionConflict?.(msg);
        return;
      }
      if (!res.ok) {
        setErrorMsg(formatApiErrorMessage(res, data, "Failed to apply AI operation"));
        return;
      }
      setProposal(null);
      await onDocumentUpdated();
    } catch {
      setErrorMsg("Network error applying AI operation.");
    } finally {
      setIsApplying(false);
    }
  }

  async function handleUndoLast() {
    if (readOnly || busy || revision <= 1) return;
    setErrorMsg(null);
    setIsPlanning(true);
    try {
      const planRes = await fetch(`/api/documents/${encodeURIComponent(documentId)}/ai/plan`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          command: inputLanguage === "km" ? "មិនធ្វើវិញ" : "undo",
          expectedRevision: revision,
          inputLanguage,
          outputLanguage,
          source: "typed_ai",
        }),
      });
      const planData = await safeReadJson(planRes);
      if (planRes.status === 401) {
        onUnauthorized?.();
        setErrorMsg("Session expired. Please sign in again.");
        return;
      }
      if (planRes.status === 409) {
        const msg = String(planData.error ?? "Revision changed — reload before undoing.");
        setErrorMsg(msg);
        onRevisionConflict?.(msg);
        return;
      }
      if (!planRes.ok) {
        setErrorMsg(formatApiErrorMessage(planRes, planData, "Undo failed"));
        return;
      }
      setProposal(planData.proposal as DocumentOperationProposal);
    } catch {
      setErrorMsg("Network error planning undo operation.");
    } finally {
      setIsPlanning(false);
    }
  }

  return (
    <aside className="ai-panel" aria-label="AI and Voice Assistant">
      <div className="panel-header-row">
        <strong>AI &amp; Voice Assistant</strong>
        <span className="badge badge-warn">Mock Speech · Local Planner</span>
      </div>

      <div className="notice-mock" role="note">
        <strong>Explicit Mock Disclosure (isMock: true):</strong> Voice buttons invoke the deterministic{" "}
        <code>MockSpeechAdapter</code>; external cloud STT/LLM adapters fail closed (HTTP 423) until authorized.
        Every mutation still enforces live backend RBAC, revision locks (409), and explicit preview approval.
      </div>

      {readOnly && (
        <div className="notice-readonly" role="status">
          Read-only role active: AI &amp; voice document mutations are disabled server-side and client-side.
        </div>
      )}

      <div className="panel-grid-2">
        <label className="field-label">
          Input Language
          <select
            className="btn full-width-control"
            value={inputLanguage}
            onChange={(e) => setInputLanguage(e.target.value as "en" | "km")}
          >
            <option value="en">English (en-US)</option>
            <option value="km">ខ្មែរ (km-KH)</option>
          </select>
        </label>
        <label className="field-label">
          Output Language
          <select
            className="btn full-width-control"
            value={outputLanguage}
            onChange={(e) => setOutputLanguage(e.target.value as "match" | "en" | "km")}
          >
            <option value="match">Match Input</option>
            <option value="en">English</option>
            <option value="km">ខ្មែរ (Khmer)</option>
          </select>
        </label>
      </div>

      <label className="field-label">
        Interaction Mode
        <select
          className="btn full-width-control"
          value={mode}
          onChange={(e) => setMode(e.target.value as "command" | "dictation" | "contextual")}
        >
          <option value="contextual">Contextual (Selected Range / Block)</option>
          <option value="command">Command Mode (Block / Document)</option>
          <option value="dictation">Dictation Mode (Insert Text)</option>
        </select>
      </label>

      <div className="preview-card">
        <div className="strong-text">Active Selection Target</div>
        <div className="muted-text">
          Block: <code>{selectionBlockId ?? "auto"}</code>
          {typeof selectionGraphemeCount === "number" && selectionGraphemeCount > 0
            ? ` · ${selectionGraphemeCount} graphemes`
            : ""}
          {mode === "contextual" &&
          typeof selectionStartOffset === "number" &&
          typeof selectionEndOffset === "number" &&
          selectionEndOffset > selectionStartOffset
            ? ` · [${selectionStartOffset}..${selectionEndOffset}]`
            : ""}
        </div>
        <div className="selection-excerpt">
          {selectedText ? `"${selectedText}"` : "(Whole target block if no range highlighted)"}
        </div>
      </div>

      <div className="row-actions wrap">
        {!recording ? (
          <button
            type="button"
            className="btn"
            disabled={readOnly || busy}
            title="Tests browser microphone permission and runs MockSpeechAdapter (isMock: true) on stop"
            onClick={() => void startPushToTalk()}
          >
            Mic Test (Mock STT)
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy} onClick={() => void stopPushToTalk()}>
            Stop &amp; Run Mock STT
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={readOnly || busy}
          onClick={() => void simulateVoiceFixture("en-translate-khmer")}
        >
          {isTranscribing ? "Transcribing..." : "Mock EN Voice"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={readOnly || busy}
          onClick={() => void simulateVoiceFixture("km-insert-table")}
        >
          {isTranscribing ? "Transcribing..." : "Mock KM Voice"}
        </button>
      </div>

      {micStatus && (
        <div className="mic-status-text" role="status">
          {micStatus}
        </div>
      )}

      {recognitionMeta && (
        <div className="recognition-meta-box">
          Provider: <strong>{recognitionMeta.provider}</strong> ·{" "}
          <strong>{recognitionMeta.isMock ? "SIMULATED (isMock: true)" : "LIVE"}</strong>
          {recognitionMeta.disclaimer ? ` · ${recognitionMeta.disclaimer}` : ""}
        </div>
      )}

      <label className="field-label">
        <span>
          Editable Transcript / Typed Instruction{" "}
          {source === "voice_command" && (
            <span className="badge badge-ok">{voiceEdited ? "Voice (edited)" : "Voice"}</span>
          )}
        </span>
        <textarea
          rows={3}
          className="btn command-textarea"
          disabled={readOnly || busy}
          placeholder="e.g. make bold | insert 3x3 table | ធ្វើឱ្យដិត | បញ្ចូលតារាង ៣x៣ | បកប្រែកថាខណ្ឌនេះជាភាសាខ្មែរ"
          value={command}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handlePlan();
            }
          }}
          onChange={(e) => {
            const nextVal = e.target.value;
            setCommand(nextVal);
            // Preserve voice_command provenance when correcting a transcript; only reset when cleared (M16)
            if (!nextVal.trim()) {
              setSource("typed_ai");
              setVoiceEdited(false);
            } else if (source === "voice_command") {
              setVoiceEdited(true);
            }
          }}
        />
      </label>

      <div className="row-actions">
        <button
          type="button"
          className="btn primary"
          disabled={readOnly || busy || !command.trim()}
          onClick={() => void handlePlan()}
        >
          {isPlanning ? "Planning..." : "Plan Operation"}
        </button>
        <button type="button" className="btn" disabled={readOnly || busy || revision <= 1} onClick={() => void handleUndoLast()}>
          Undo Last Change
        </button>
      </div>

      {errorMsg && (
        <div className="banner-error" role="alert">
          {errorMsg}
        </div>
      )}

      {proposal && (
        <div className="preview-card">
          <div className="panel-header-row">
            <strong>Proposed Action: {proposal.action}</strong>
            <span className="badge">Risk: {proposal.riskLevel}</span>
          </div>
          <div>{proposal.explanation}</div>
          <div className="meta-caption">
            Rev {proposal.expectedRevision} · Source: {proposal.source}
          </div>
          <div className="proposal-diff-box">
            <div className="diff-before">Before: {proposal.previewDiff.beforeText}</div>
            <div className="diff-after">After: {proposal.previewDiff.afterText}</div>
          </div>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={busy || readOnly} onClick={() => void handleApply()}>
              {isApplying ? "Applying..." : "Approve & Apply"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setProposal(null)}>
              Reject
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

export const AiVoicePanel = memo(AiVoicePanelInner);
