import { useEffect, useRef, useState } from "react";
import type { DocumentOperationProposal, SpeechRecognitionResult } from "@ai-office-suite/shared-contracts";

interface AiVoicePanelProps {
  documentId: string;
  revision: number;
  readOnly: boolean;
  selectionBlockId?: string;
  selectedText: string;
  selectionGraphemeCount?: number;
  onDocumentUpdated: () => Promise<void>;
  onRevisionConflict?: (message: string) => void;
  onUnauthorized?: () => void;
  apiHeaders: Record<string, string>;
}

async function safeReadJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: `Request failed with HTTP ${res.status}` };
  }
}

export function AiVoicePanel({
  documentId,
  revision,
  readOnly,
  selectionBlockId,
  selectedText,
  selectionGraphemeCount,
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
    setMicStatus("Requesting microphone permission...");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicStatus("Browser microphone unavailable; use Mock EN/KM Voice or type a command.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setRecording(true);
      setMicStatus(
        `Recording (${inputLanguage === "km" ? "ខ្មែរ km-KH" : "English en-US"})... Click Stop to transcribe via Mock Speech Adapter (isMock: true).`,
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
        setErrorMsg(String(data.error ?? "Speech transcription failed"));
        return;
      }
      const rec = data.recognition as SpeechRecognitionResult;
      setRecognitionMeta(rec);
      setInputLanguage(lang === "km-KH" ? "km" : "en");
      setSource("voice_command");
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
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/ai/plan`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          command: command.normalize("NFC"),
          expectedRevision: revision,
          inputLanguage,
          outputLanguage,
          source,
          selection: selectionBlockId
            ? {
                blockId: selectionBlockId,
                selectedText: selectedText ? selectedText.normalize("NFC") : undefined,
              }
            : undefined,
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
        setErrorMsg(String(data.error ?? "Failed to plan AI operation"));
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
        setErrorMsg(String(data.error ?? "Failed to apply AI operation"));
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
        setErrorMsg(String(planData.error ?? "Undo failed"));
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
        <label>
          Input Language
          <select
            className="btn"
            style={{ width: "100%", marginTop: 3 }}
            value={inputLanguage}
            onChange={(e) => setInputLanguage(e.target.value as "en" | "km")}
          >
            <option value="en">English (en-US)</option>
            <option value="km">ខ្មែរ (km-KH)</option>
          </select>
        </label>
        <label>
          Output Language
          <select
            className="btn"
            style={{ width: "100%", marginTop: 3 }}
            value={outputLanguage}
            onChange={(e) => setOutputLanguage(e.target.value as "match" | "en" | "km")}
          >
            <option value="match">Match Input</option>
            <option value="en">English</option>
            <option value="km">ខ្មែរ (Khmer)</option>
          </select>
        </label>
      </div>

      <label style={{ fontSize: 12 }}>
        Interaction Mode
        <select
          className="btn"
          style={{ width: "100%", marginTop: 3 }}
          value={mode}
          onChange={(e) => setMode(e.target.value as "command" | "dictation" | "contextual")}
        >
          <option value="contextual">Contextual (Selected Block)</option>
          <option value="command">Command Mode</option>
          <option value="dictation">Dictation Mode</option>
        </select>
      </label>

      <div className="preview-card">
        <div style={{ fontWeight: 600 }}>Active Selection Target</div>
        <div style={{ color: "#475569" }}>
          Block: <code>{selectionBlockId ?? "auto"}</code>
          {typeof selectionGraphemeCount === "number" && selectionGraphemeCount > 0
            ? ` · ${selectionGraphemeCount} graphemes`
            : ""}
        </div>
        <div style={{ maxHeight: 54, overflow: "hidden", color: "#334155" }}>
          {selectedText ? `"${selectedText}"` : "(Whole target block if no range highlighted)"}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {!recording ? (
          <button type="button" className="btn" disabled={readOnly || busy} onClick={startPushToTalk}>
            Mic Push-to-Talk
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy} onClick={() => stopPushToTalk()}>
            Stop Recording
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={readOnly || busy}
          onClick={() => simulateVoiceFixture("en-translate-khmer")}
        >
          {isTranscribing ? "Transcribing..." : "Mock EN Voice"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={readOnly || busy}
          onClick={() => simulateVoiceFixture("km-insert-table")}
        >
          {isTranscribing ? "Transcribing..." : "Mock KM Voice"}
        </button>
      </div>

      {micStatus && <div style={{ fontSize: 11, color: "#1d4ed8" }}>{micStatus}</div>}

      {recognitionMeta && (
        <div
          style={{
            fontSize: 11,
            color: "#475569",
            background: "#f8fafc",
            padding: 6,
            borderRadius: 6,
            border: "1px solid #e2e8f0",
          }}
        >
          Provider: <strong>{recognitionMeta.provider}</strong> ·{" "}
          <strong>{recognitionMeta.isMock ? "SIMULATED (isMock: true)" : "LIVE"}</strong>
          {recognitionMeta.disclaimer ? ` · ${recognitionMeta.disclaimer}` : ""}
        </div>
      )}

      <label style={{ fontSize: 12 }}>
        Editable Transcript / Typed Instruction
        <textarea
          rows={3}
          className="btn"
          disabled={readOnly || busy}
          style={{ width: "100%", marginTop: 4, textAlign: "left" }}
          placeholder="e.g. make bold | insert 3x3 table | ធ្វើឱ្យដិត | បញ្ចូលតារាង ៣x៣ | បកប្រែកថាខណ្ឌនេះជាភាសាខ្មែរ"
          value={command}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handlePlan();
            }
          }}
          onChange={(e) => {
            setSource("typed_ai");
            setCommand(e.target.value);
          }}
        />
      </label>

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn primary"
          disabled={readOnly || busy || !command.trim()}
          onClick={handlePlan}
        >
          {isPlanning ? "Planning..." : "Plan Operation"}
        </button>
        <button type="button" className="btn" disabled={readOnly || busy || revision <= 1} onClick={handleUndoLast}>
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Proposed Action: {proposal.action}</strong>
            <span className="badge">Risk: {proposal.riskLevel}</span>
          </div>
          <div>{proposal.explanation}</div>
          <div style={{ fontSize: 11, color: "#475569" }}>
            Rev {proposal.expectedRevision} · Source: {proposal.source}
          </div>
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", padding: 6, borderRadius: 4 }}>
            <div style={{ color: "#991b1b" }}>Before: {proposal.previewDiff.beforeText}</div>
            <div style={{ color: "#166534", marginTop: 4 }}>After: {proposal.previewDiff.afterText}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn primary" disabled={busy || readOnly} onClick={handleApply}>
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
