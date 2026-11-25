import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuditEvent,
  DocumentVersion,
  StudioDocument,
  WorkspaceRole,
} from "@ai-office-suite/shared-contracts";
import { PLANNED_FUTURE_STUDIOS } from "@ai-office-suite/shared-contracts";
import { fromTiptapJson, toTiptapJson, type TiptapNode } from "@ai-office-suite/document-engine/tiptap-codec";
import { DocumentEditor, type EditorSelectionState } from "./components/DocumentEditor.tsx";
import { AiVoicePanel } from "./components/AiVoicePanel.tsx";
import { VersionAuditDrawer } from "./components/VersionAuditDrawer.tsx";

export function App() {
  const [role, setRole] = useState<WorkspaceRole>("editor");
  const [docs, setDocs] = useState<StudioDocument[]>([]);
  const [activeDoc, setActiveDoc] = useState<StudioDocument | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<StudioDocument["blocks"] | null>(null);
  const [selection, setSelection] = useState<EditorSelectionState>({ selectedText: "" });
  const [panelOpen, setPanelOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [statusMessage, setStatusMessage] = useState("Ready (D1 Local Prototype)");

  const apiHeaders = useMemo(
    () => ({
      "x-workspace-role": role,
      "x-user-id": `user_${role}`,
      "x-tenant-id": "tenant_demo_sme",
      "x-workspace-id": "ws_corporate_hq",
    }),
    [role],
  );

  const readOnly = role === "viewer" || role === "reviewer";

  const loadDocuments = useCallback(async () => {
    const res = await fetch("/api/documents", { headers: apiHeaders });
    const data = await res.json();
    if (res.ok) {
      const list = data.documents as StudioDocument[];
      setDocs(list);
      if (!activeDoc && list[0]) {
        setActiveDoc(list[0]);
      } else if (activeDoc) {
        const refreshed = list.find((d) => d.documentId === activeDoc.documentId);
        if (refreshed) setActiveDoc(refreshed);
      }
    }
  }, [apiHeaders, activeDoc]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  async function handleSeedBilingual() {
    const res = await fetch("/api/documents/seed-bilingual-fixture", {
      method: "POST",
      headers: apiHeaders,
    });
    const data = await res.json();
    if (res.ok) {
      setActiveDoc(data.document as StudioDocument);
      setDraftBlocks(null);
      await loadDocuments();
      setStatusMessage("Loaded bilingual English/Khmer management report fixture.");
    } else {
      setStatusMessage(data.error ?? "Failed to create fixture");
    }
  }

  async function handleSave() {
    if (!activeDoc || !draftBlocks) return;
    const res = await fetch(`/api/documents/${activeDoc.documentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...apiHeaders },
      body: JSON.stringify({
        expectedRevision: activeDoc.revision,
        blocks: draftBlocks,
        summary: "Manual editor save",
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setActiveDoc(data.document as StudioDocument);
      setDraftBlocks(null);
      await loadDocuments();
      setStatusMessage(`Saved revision ${(data.document as StudioDocument).revision}.`);
    } else {
      setStatusMessage(data.error ?? "Save failed");
    }
  }

  async function handleExport(kind: "docx" | "pdf") {
    if (!activeDoc) return;
    const res = await fetch(`/api/documents/${activeDoc.documentId}/export/${kind}`, {
      method: "POST",
      headers: apiHeaders,
    });
    if (!res.ok) {
      const data = await res.json();
      setStatusMessage(data.error ?? `${kind.toUpperCase()} export failed`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeDoc.documentId}-rev${activeDoc.revision}.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMessage(`Exported ${kind.toUpperCase()} snapshot.`);
  }

  async function openHistory() {
    if (!activeDoc) return;
    const [vRes, aRes] = await Promise.all([
      fetch(`/api/documents/${activeDoc.documentId}/versions`, { headers: apiHeaders }),
      fetch(`/api/documents/${activeDoc.documentId}/audit`, { headers: apiHeaders }),
    ]);
    if (vRes.ok && aRes.ok) {
      const vData = await vRes.json();
      const aData = await aRes.json();
      setVersions(vData.versions as DocumentVersion[]);
      setAuditEvents(aData.events as AuditEvent[]);
      setHistoryOpen(true);
    }
  }

  async function handleRestore(revision: number) {
    if (!activeDoc) return;
    const res = await fetch(`/api/documents/${activeDoc.documentId}/versions/${revision}/restore`, {
      method: "POST",
      headers: apiHeaders,
    });
    const data = await res.json();
    if (res.ok) {
      setActiveDoc(data.document as StudioDocument);
      setDraftBlocks(null);
      setHistoryOpen(false);
      await loadDocuments();
      setStatusMessage(`Restored revision ${revision} as new revision ${(data.document as StudioDocument).revision}.`);
    } else {
      setStatusMessage(data.error ?? "Restore failed");
    }
  }

  const tiptapContent = useMemo(() => {
    return activeDoc
      ? (toTiptapJson(activeDoc) as unknown as Record<string, unknown>)
      : { type: "doc", content: [] };
  }, [activeDoc]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span>AI Office Suite</span>
          <span className="badge">Document Studio · D1 Prototype</span>
        </div>

        <nav className="studio-tabs" aria-label="Workspace Studios">
          <button type="button" className="studio-tab active">
            Document Studio
          </button>
          {PLANNED_FUTURE_STUDIOS.map((studio) => (
            <button
              key={studio.studioId}
              type="button"
              className="studio-tab planned"
              disabled
              title="Planned for a future phase — not yet implemented"
            >
              {studio.studioId.charAt(0).toUpperCase() + studio.studioId.slice(1)} (Planned)
            </button>
          ))}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <label>
            Role:&nbsp;
            <select
              className="btn"
              value={role}
              onChange={(e) => setRole(e.target.value as WorkspaceRole)}
            >
              <option value="editor">Editor</option>
              <option value="owner">Owner</option>
              <option value="reviewer">Reviewer (Read-Only)</option>
              <option value="viewer">Viewer (Read-Only)</option>
            </select>
          </label>
          <button type="button" className="btn" onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? "Hide AI Panel" : "Show AI Panel"}
          </button>
        </div>
      </header>

      <div className="toolbar">
        <button type="button" className="btn primary" disabled={readOnly} onClick={handleSeedBilingual}>
          + Bilingual EN/KM Report
        </button>
        <button type="button" className="btn" disabled={readOnly || !draftBlocks} onClick={handleSave}>
          Save{draftBlocks ? " *" : ""}
        </button>
        <button type="button" className="btn" disabled={!activeDoc} onClick={openHistory}>
          Versions &amp; Audit
        </button>
        <button type="button" className="btn" disabled={!activeDoc} onClick={() => handleExport("docx")}>
          Export DOCX
        </button>
        <button type="button" className="btn" disabled={!activeDoc} onClick={() => handleExport("pdf")}>
          Export PDF
        </button>
      </div>

      <div className={`workspace-body ${panelOpen ? "" : "panel-collapsed"}`}>
        <aside className="sidebar">
          <strong style={{ fontSize: 12 }}>Workspace Documents</strong>
          {docs.length === 0 && (
            <div style={{ fontSize: 12, color: "#64748b" }}>
              No documents yet. Click &ldquo;+ Bilingual EN/KM Report&rdquo; to begin.
            </div>
          )}
          {docs.map((d) => (
            <button
              key={d.documentId}
              type="button"
              className={`doc-item ${activeDoc?.documentId === d.documentId ? "selected" : ""}`}
              onClick={() => {
                setActiveDoc(d);
                setDraftBlocks(null);
              }}
            >
              <div style={{ fontWeight: 600 }}>{d.title}</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>
                Rev {d.revision} · {d.language}
              </div>
            </button>
          ))}
        </aside>

        <main className="canvas-area">
          {activeDoc ? (
            <DocumentEditor
              document={activeDoc}
              tiptapContent={tiptapContent}
              readOnly={readOnly}
              onDocChange={(json) => setDraftBlocks(fromTiptapJson(json as unknown as TiptapNode, activeDoc.blocks))}
              onSelectionChange={setSelection}
            />
          ) : (
            <div className="preview-card" style={{ maxWidth: 460, marginTop: 60 }}>
              <strong>Welcome to AI Office Suite (Phase D1 Prototype)</strong>
              <span>Create a bilingual English &amp; Khmer document to test Tiptap editing, controlled AI operations, mock voice commands, DOCX round-trip, and HarfBuzz PDF export.</span>
            </div>
          )}
        </main>

        {panelOpen && activeDoc && (
          <AiVoicePanel
            documentId={activeDoc.documentId}
            revision={activeDoc.revision}
            readOnly={readOnly}
            selectionBlockId={selection.blockId}
            selectedText={selection.selectedText}
            onDocumentUpdated={loadDocuments}
            apiHeaders={apiHeaders}
          />
        )}
      </div>

      <footer className="statusbar">
        <span>{statusMessage}</span>
        <span>English / ខ្មែរ · Local Prototype Storage</span>
      </footer>

      {historyOpen && (
        <VersionAuditDrawer
          versions={versions}
          auditEvents={auditEvents}
          readOnly={readOnly}
          onRestore={handleRestore}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
