import { useRef, useState } from "react";
import type { DocumentOperationProposal, SpeechRecognitionResult } from "@ai-office-suite/shared-contracts";

interface AiVoicePanelProps {
  documentId: string;
  revision: number;
  readOnly: boolean;
  selectionBlockId?: string;
  selectedText: string;
  onDocumentUpdated: () => Promise<void>;
  apiHeaders: Record<string, string>;
}

export function AiVoicePanel({
  documentId,
  revision,
  readOnly,
  selectionBlockId,
  selectedText,
  onDocumentUpdated,
  apiHeaders,
}: AiVoicePanelProps) {
  const [inputLanguage, setInputLanguage] = useState<"en" | "km">("en");
  const [outputLanguage, setOutputLanguage] = useState<"match" | "en" | "km">("match");
  const [mode, setMode] = useState<"command" | "dictation" | "contextual">("contextual");
  const [command, setCommand] = useState("");
  const [source, setSource] = useState<"typed_ai" | "voice_command">("typed_ai");
  const [recording, setRecording] = useState(false);
  const [micStatus, setMicStatus] = useState<string | null>(null);
  const [recognitionMeta, setRecognitionMeta] = useState<SpeechRecognitionResult | null>(null);
  const [proposal, setProposal] = useState<DocumentOperationProposal | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  async function startPushToTalk() {
    setErrorMsg(null);
    setMicStatus("Requesting microphone permission...");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicStatus("Browser microphone unavailable; use Simulate EN/KM Voice or type a command.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setRecording(true);
      setMicStatus(`Recording (${inputLanguage === "km" ? "ខ្មែរ km-KH" : "English en-US"})... Click Stop to transcribe via mock adapter.`);
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
    setErrorMsg(null);
    const lang = fixtureId.startsWith("km-") ? "km-KH" : "en-US";
    const res = await fetch("/api/speech/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiHeaders },
      body: JSON.stringify({
        provider: "mock",
        language: lang,
        mode,
        fixtureId,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorMsg(data.error ?? "Speech transcription failed");
      return;
    }
    const rec = data.recognition as SpeechRecognitionResult;
    setRecognitionMeta(rec);
    setInputLanguage(lang === "km-KH" ? "km" : "en");
    setSource("voice_command");
    setCommand(rec.transcript);
  }

  async function handlePlan() {
    setErrorMsg(null);
    setProposal(null);
    const res = await fetch(`/api/documents/${documentId}/ai/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiHeaders },
      body: JSON.stringify({
        command,
        expectedRevision: revision,
        inputLanguage,
        outputLanguage,
        source,
        selection: selectionBlockId
          ? {
              blockId: selectionBlockId,
              selectedText: selectedText || undefined,
            }
          : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorMsg(data.error ?? "Failed to plan AI operation");
      return;
    }
    setProposal(data.proposal as DocumentOperationProposal);
  }

  async function handleApply() {
    if (!proposal) return;
    setErrorMsg(null);
    const res = await fetch(`/api/documents/${documentId}/ai/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiHeaders },
      body: JSON.stringify({ proposal, approved: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorMsg(data.error ?? "Failed to apply AI operation");
      return;
    }
    setProposal(null);
    await onDocumentUpdated();
  }

  async function handleUndoLast() {
    setErrorMsg(null);
    const planRes = await fetch(`/api/documents/${documentId}/ai/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiHeaders },
      body: JSON.stringify({
        command: inputLanguage === "km" ? "មិនធ្វើវិញ" : "undo",
        expectedRevision: revision,
        inputLanguage,
        outputLanguage,
        source: "typed_ai",
      }),
    });
    const planData = await planRes.json();
    if (!planRes.ok) {
      setErrorMsg(planData.error ?? "Undo failed");
      return;
    }
    setProposal(planData.proposal as DocumentOperationProposal);
  }

  return (
    <aside className="ai-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>AI &amp; Voice Assistant</strong>
        <span className="badge">D1 Prototype</span>
      </div>

      <div className="notice-mock">
        <strong>Mock Speech &amp; Local AI Planner:</strong> Voice and AI operations validate against backend RBAC, revision locks, and preview approval. Live acoustic ASR is disabled pending D1 review.
      </div>

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
        </div>
        <div style={{ maxHeight: 54, overflow: "hidden", color: "#334155" }}>
          {selectedText ? `"${selectedText}"` : "(Whole target block if no range highlighted)"}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {!recording ? (
          <button type="button" className="btn" onClick={startPushToTalk}>
            Mic Push-to-Talk
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => stopPushToTalk()}>
            Stop Recording
          </button>
        )}
        <button type="button" className="btn" onClick={() => simulateVoiceFixture("en-translate-khmer")}>
          Mock EN Voice
        </button>
        <button type="button" className="btn" onClick={() => simulateVoiceFixture("km-insert-table")}>
          Mock KM Voice
        </button>
      </div>

      {micStatus && <div style={{ fontSize: 11, color: "#1d4ed8" }}>{micStatus}</div>}

      {recognitionMeta && (
        <div style={{ fontSize: 11, color: "#475569", background: "#f8fafc", padding: 6, borderRadius: 6, border: "1px solid #e2e8f0" }}>
          Provider: <strong>{recognitionMeta.provider}</strong> · Mock: <strong>{String(recognitionMeta.isMock)}</strong> · {recognitionMeta.disclaimer}
        </div>
      )}

      <label style={{ fontSize: 12 }}>
        Editable Transcript / Typed Instruction
        <textarea
          rows={3}
          className="btn"
          style={{ width: "100%", marginTop: 4, textAlign: "left" }}
          placeholder="e.g. make bold | insert 3x3 table | ធ្វើឱ្យដិត | បញ្ចូលតារាង ៣x៣ | បកប្រែកថាខណ្ឌនេះជាភាសាខ្មែរ"
          value={command}
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
          disabled={readOnly || !command.trim()}
          onClick={handlePlan}
        >
          Plan Operation
        </button>
        <button type="button" className="btn" disabled={readOnly || revision <= 1} onClick={handleUndoLast}>
          Undo Last Change
        </button>
      </div>

      {errorMsg && (
        <div style={{ fontSize: 12, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: 8 }}>
          {errorMsg}
        </div>
      )}

      {proposal && (
        <div className="preview-card">
          <div style={{ display: "flex", justifyContent: "space-between" }}>
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
            <button type="button" className="btn primary" onClick={handleApply}>
              Approve &amp; Apply
            </button>
            <button type="button" className="btn" onClick={() => setProposal(null)}>
              Reject
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
