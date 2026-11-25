import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type {
  ActorContext,
  AuditEvent,
  DocumentVersion,
  PageLayoutConfig,
  StudioDocument,
  WorkspaceRole,
} from "@ai-office-suite/shared-contracts";
import { PLANNED_FUTURE_STUDIOS } from "@ai-office-suite/shared-contracts";
import { fromTiptapJson, toTiptapJson, type TiptapNode } from "@ai-office-suite/document-engine/tiptap-codec";
import { DocumentEditor, type EditorSelectionState } from "./components/DocumentEditor.tsx";
import { AiVoicePanel } from "./components/AiVoicePanel.tsx";
import { VersionAuditDrawer, type RevisionDiffPayload } from "./components/VersionAuditDrawer.tsx";

type AuthMode = "provisional-local" | "jwt-pg";

async function safeReadJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: `Request failed with HTTP ${res.status}` };
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const DEFAULT_PAGE_LAYOUT: PageLayoutConfig = {
  size: "A4",
  orientation: "portrait",
  marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
  headerText: "AI Office Suite",
  footerText: "Confidential",
  showPageNumbers: true,
};

export function App() {
  const [authMode, setAuthMode] = useState<AuthMode>("provisional-local");
  const [authInitialized, setAuthInitialized] = useState(false);
  const [sessionActor, setSessionActor] = useState<ActorContext | null>(null);
  const [prototypeRole, setPrototypeRole] = useState<WorkspaceRole>("editor");

  // jwt-pg sign-in form state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginTenantId, setLoginTenantId] = useState("");
  const [loginWorkspaceId, setLoginWorkspaceId] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Documents & filters
  const [docs, setDocs] = useState<StudioDocument[]>([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [languageFilter, setLanguageFilter] = useState<"" | "en" | "km" | "bilingual">("");
  const [activeDoc, setActiveDoc] = useState<StudioDocument | null>(null);
  const activeDocIdRef = useRef<string | null>(null);

  // Draft edits (content + metadata/layout)
  const [draftBlocks, setDraftBlocks] = useState<StudioDocument["blocks"] | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [draftLanguage, setDraftLanguage] = useState<StudioDocument["language"] | null>(null);
  const [draftLayout, setDraftLayout] = useState<PageLayoutConfig | null>(null);
  const [selection, setSelection] = useState<EditorSelectionState>({ selectedText: "" });

  // New blank document modal state
  const [newDocModalOpen, setNewDocModalOpen] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocLanguage, setNewDocLanguage] = useState<"en" | "km" | "bilingual">("bilingual");
  const [newDocSize, setNewDocSize] = useState<"A4" | "Letter">("A4");
  const [newDocOrientation, setNewDocOrientation] = useState<"portrait" | "landscape">("portrait");
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);

  // DOCX import state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isImportingDocx, setIsImportingDocx] = useState(false);

  const [panelOpen, setPanelOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  const [isExporting, setIsExporting] = useState<"docx" | "pdf" | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);

  const [statusMessage, setStatusMessage] = useState("Connecting to workspace API...");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const effectiveRole: WorkspaceRole = authMode === "jwt-pg" ? (sessionActor?.role ?? "viewer") : prototypeRole;
  const readOnly = effectiveRole === "viewer" || effectiveRole === "reviewer";
  const canExport = effectiveRole !== "viewer";
  const isAuthenticated = authMode === "provisional-local" || sessionActor !== null;
  const hasUnsavedChanges =
    draftBlocks !== null || draftTitle !== null || draftLanguage !== null || draftLayout !== null;

  const clearDrafts = useCallback(() => {
    setDraftBlocks(null);
    setDraftTitle(null);
    setDraftLanguage(null);
    setDraftLayout(null);
  }, []);

  // In jwt-pg mode, rely exclusively on HttpOnly `aios_session` cookie (never send spoofable prototype headers)
  const apiHeaders = useMemo((): Record<string, string> => {
    if (authMode === "jwt-pg") {
      return {};
    }
    return {
      "x-workspace-role": prototypeRole,
      "x-user-id": `user_${prototypeRole}`,
      "x-tenant-id": "tenant_demo_sme",
      "x-workspace-id": "ws_corporate_hq",
    };
  }, [authMode, prototypeRole]);

  useEffect(() => {
    activeDocIdRef.current = activeDoc?.documentId ?? null;
  }, [activeDoc]);

  // Detect backend auth mode & restore existing cookie session if running under jwt-pg
  useEffect(() => {
    let cancelled = false;
    async function initAuth() {
      try {
        const healthRes = await fetch("/api/health", { credentials: "include" });
        const health = await safeReadJson(healthRes);
        const detectedMode: AuthMode = health.authMode === "jwt-pg" ? "jwt-pg" : "provisional-local";
        if (cancelled) return;
        setAuthMode(detectedMode);

        if (detectedMode === "jwt-pg") {
          const meRes = await fetch("/api/auth/me", { credentials: "include" });
          if (meRes.ok) {
            const meData = await safeReadJson(meRes);
            if (!cancelled && meData.actor) {
              setSessionActor(meData.actor as ActorContext);
              setStatusMessage("Authenticated via PostgreSQL RLS session cookie.");
            }
          } else if (!cancelled) {
            setSessionActor(null);
            setStatusMessage("Sign in required (JWT + PostgreSQL RLS mode).");
          }
        } else {
          setStatusMessage("Ready (D1 Local Prototype — Loopback Only)");
        }
      } catch {
        if (!cancelled) {
          setErrorBanner("Unable to reach API server. Verify the backend is running.");
          setStatusMessage("API unreachable");
        }
      } finally {
        if (!cancelled) setAuthInitialized(true);
      }
    }
    void initAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnauthorized = useCallback(() => {
    if (authMode === "jwt-pg") {
      setSessionActor(null);
      setDocs([]);
      setTotalDocs(0);
      setActiveDoc(null);
      clearDrafts();
      setErrorBanner("Session expired or revoked. Please sign in again.");
      setStatusMessage("Authentication required");
    }
  }, [authMode, clearDrafts]);

  const loadDocuments = useCallback(async () => {
    if (!authInitialized || !isAuthenticated) return;
    setIsLoadingDocs(true);
    try {
      const qs = new URLSearchParams();
      if (searchQuery.trim()) qs.set("q", searchQuery.trim());
      if (languageFilter) qs.set("language", languageFilter);
      qs.set("limit", "50");
      const queryStr = qs.toString();
      const res = await fetch(`/api/documents${queryStr ? `?${queryStr}` : ""}`, {
        credentials: "include",
        headers: apiHeaders,
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (!res.ok) {
        setErrorBanner(String(data.error ?? "Failed to load workspace documents."));
        return;
      }
      const list = (data.documents ?? []) as StudioDocument[];
      setDocs(list);
      setTotalDocs(typeof data.total === "number" ? data.total : list.length);
      setErrorBanner(null);

      const currentId = activeDocIdRef.current;
      if (!currentId && list[0]) {
        setActiveDoc(list[0]);
      } else if (currentId) {
        const refreshed = list.find((d) => d.documentId === currentId);
        if (refreshed) setActiveDoc(refreshed);
        else if (!searchQuery.trim() && !languageFilter) setActiveDoc(list[0] ?? null);
      }
    } catch {
      setErrorBanner("Network error while loading workspace documents.");
    } finally {
      setIsLoadingDocs(false);
    }
  }, [apiHeaders, authInitialized, isAuthenticated, handleUnauthorized, searchQuery, languageFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDocuments();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [loadDocuments]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (isAuthenticating) return;
    setErrorBanner(null);
    setIsAuthenticating(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: loginEmail.trim(),
          password: loginPassword,
          tenantId: loginTenantId.trim(),
          workspaceId: loginWorkspaceId.trim(),
        }),
      });
      const data = await safeReadJson(res);
      if (!res.ok) {
        setErrorBanner(String(data.error ?? "Sign in failed. Verify credentials and tenant/workspace IDs."));
        return;
      }
      setSessionActor(data.actor as ActorContext);
      setLoginPassword("");
      setStatusMessage("Signed in via HttpOnly session cookie (PostgreSQL RLS).");
    } catch {
      setErrorBanner("Network error during sign in.");
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function handleLogout(revokeAll = false) {
    try {
      await fetch(revokeAll ? "/api/auth/revoke-sessions" : "/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setSessionActor(null);
      setDocs([]);
      setTotalDocs(0);
      setActiveDoc(null);
      clearDrafts();
      setConflictMessage(null);
      setStatusMessage(revokeAll ? "All sessions revoked." : "Signed out.");
    }
  }

  async function reloadActiveDocument() {
    if (!activeDoc) return;
    setErrorBanner(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}`, {
        credentials: "include",
        headers: apiHeaders,
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (!res.ok) {
        setErrorBanner(String(data.error ?? "Failed to reload latest document."));
        return;
      }
      const latest = data.document as StudioDocument;
      setActiveDoc(latest);
      clearDrafts();
      setConflictMessage(null);
      setDocs((prev) => prev.map((d) => (d.documentId === latest.documentId ? latest : d)));
      setStatusMessage(`Reloaded latest revision ${latest.revision}.`);
    } catch {
      setErrorBanner("Network error reloading latest revision.");
    }
  }

  async function handleCreateBlankDocument(e: FormEvent) {
    e.preventDefault();
    if (readOnly || isCreatingDoc || !newDocTitle.trim()) return;
    setErrorBanner(null);
    setIsCreatingDoc(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          title: newDocTitle.trim().normalize("NFC"),
          language: newDocLanguage,
          layout: {
            ...DEFAULT_PAGE_LAYOUT,
            size: newDocSize,
            orientation: newDocOrientation,
          },
        }),
      });
      if (res.status === 401) {
        setNewDocModalOpen(false);
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (!res.ok) {
        setErrorBanner(String(data.error ?? "Failed to create document."));
        return;
      }
      const created = data.document as StudioDocument;
      setActiveDoc(created);
      clearDrafts();
      setConflictMessage(null);
      setNewDocModalOpen(false);
      setNewDocTitle("");
      await loadDocuments();
      setStatusMessage(`Created '${created.title}' (${created.layout.size} ${created.layout.orientation}).`);
    } catch {
      setErrorBanner("Network error creating new document.");
    } finally {
      setIsCreatingDoc(false);
    }
  }

  async function handleDocxFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || readOnly || isImportingDocx) return;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setErrorBanner("Only .docx files are supported for Document Studio import (.docm macros are blocked).");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setErrorBanner("DOCX file exceeds 15 MB safety limit.");
      return;
    }
    setErrorBanner(null);
    setConflictMessage(null);
    setIsImportingDocx(true);
    try {
      const buf = await file.arrayBuffer();
      const contentBase64 = arrayBufferToBase64(buf);
      const res = await fetch("/api/documents/import/docx", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({ filename: file.name, contentBase64 }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (!res.ok) {
        setErrorBanner(String(data.error ?? "DOCX import failed."));
        setStatusMessage("DOCX import rejected.");
        return;
      }
      const created = data.document as StudioDocument;
      const diagnostics = data.diagnostics as { originalSha256?: string; warnings?: string[] } | undefined;
      setActiveDoc(created);
      clearDrafts();
      await loadDocuments();
      const shaPrefix = diagnostics?.originalSha256?.slice(0, 10) ?? "verified";
      const warnCount = diagnostics?.warnings?.length ?? 0;
      setStatusMessage(
        `Imported DOCX '${file.name}' (SHA-256 ${shaPrefix}${warnCount > 0 ? `, ${warnCount} warning(s)` : ""}).`,
      );
    } catch {
      setErrorBanner("Network or read error importing DOCX file.");
    } finally {
      setIsImportingDocx(false);
    }
  }

  async function handleSeedBilingual() {
    if (readOnly || isSeeding) return;
    setErrorBanner(null);
    setConflictMessage(null);
    setIsSeeding(true);
    try {
      const res = await fetch("/api/documents/seed-bilingual-fixture", {
        method: "POST",
        credentials: "include",
        headers: apiHeaders,
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (res.ok) {
        const created = data.document as StudioDocument;
        setActiveDoc(created);
        clearDrafts();
        await loadDocuments();
        setStatusMessage("Loaded bilingual English/Khmer management report fixture.");
      } else {
        const msg = String(data.error ?? "Failed to create fixture");
        setErrorBanner(msg);
        setStatusMessage(msg);
      }
    } catch {
      setErrorBanner("Network error creating bilingual fixture.");
    } finally {
      setIsSeeding(false);
    }
  }

  const handleSave = useCallback(async () => {
    if (!activeDoc || !hasUnsavedChanges || readOnly || isSaving) return;
    setErrorBanner(null);
    setIsSaving(true);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          expectedRevision: activeDoc.revision,
          title: (draftTitle ?? activeDoc.title).trim().normalize("NFC"),
          language: draftLanguage ?? activeDoc.language,
          layout: draftLayout ?? activeDoc.layout,
          blocks: draftBlocks ?? activeDoc.blocks,
          summary: "Manual editor save",
        }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (res.status === 409) {
        const msg = String(
          data.error ??
            `Revision conflict: expected rev ${activeDoc.revision}, but the document was modified elsewhere.`,
        );
        setConflictMessage(msg);
        setStatusMessage("Save blocked by revision conflict (409).");
        return;
      }
      if (res.ok) {
        const saved = data.document as StudioDocument;
        setActiveDoc(saved);
        clearDrafts();
        setConflictMessage(null);
        await loadDocuments();
        setStatusMessage(`Saved revision ${saved.revision}.`);
      } else {
        const msg = String(data.error ?? "Save failed");
        setErrorBanner(msg);
        setStatusMessage(msg);
      }
    } catch {
      setErrorBanner("Network error saving document.");
    } finally {
      setIsSaving(false);
    }
  }, [
    activeDoc,
    hasUnsavedChanges,
    readOnly,
    isSaving,
    apiHeaders,
    draftTitle,
    draftLanguage,
    draftLayout,
    draftBlocks,
    handleUnauthorized,
    clearDrafts,
    loadDocuments,
  ]);

  // Keyboard shortcut: Ctrl+S / Cmd+S to save current document
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  async function handleExport(kind: "docx" | "pdf") {
    if (!activeDoc || !canExport || isExporting) return;
    setErrorBanner(null);
    setIsExporting(kind);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}/export/${kind}`, {
        method: "POST",
        credentials: "include",
        headers: apiHeaders,
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        const data = await safeReadJson(res);
        const msg = String(data.error ?? `${kind.toUpperCase()} export failed`);
        setErrorBanner(msg);
        setStatusMessage(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeDoc.documentId}-rev${activeDoc.revision}.${kind}`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMessage(`Exported ${kind.toUpperCase()} snapshot (rev ${activeDoc.revision}).`);
    } catch {
      setErrorBanner(`Network error during ${kind.toUpperCase()} export.`);
    } finally {
      setIsExporting(null);
    }
  }

  async function openHistory() {
    if (!activeDoc) return;
    setErrorBanner(null);
    setHistoryOpen(true);
    setIsLoadingHistory(true);
    try {
      const [vRes, aRes] = await Promise.all([
        fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}/versions`, {
          credentials: "include",
          headers: apiHeaders,
        }),
        fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}/audit`, {
          credentials: "include",
          headers: apiHeaders,
        }),
      ]);
      if (vRes.status === 401 || aRes.status === 401) {
        setHistoryOpen(false);
        handleUnauthorized();
        return;
      }
      if (!vRes.ok || !aRes.ok) {
        const errData = await safeReadJson(!vRes.ok ? vRes : aRes);
        setErrorBanner(String(errData.error ?? "Failed to load version & audit history."));
        setHistoryOpen(false);
        return;
      }
      const vData = await safeReadJson(vRes);
      const aData = await safeReadJson(aRes);
      setVersions((vData.versions ?? []) as DocumentVersion[]);
      setAuditEvents((aData.events ?? []) as AuditEvent[]);
    } catch {
      setErrorBanner("Network error loading version & audit history.");
      setHistoryOpen(false);
    } finally {
      setIsLoadingHistory(false);
    }
  }

  async function handleCompareRevision(fromRev: number, toRev: number): Promise<RevisionDiffPayload | null> {
    if (!activeDoc) return null;
    try {
      const res = await fetch(
        `/api/documents/${encodeURIComponent(activeDoc.documentId)}/versions/${fromRev}/diff/${toRev}`,
        { credentials: "include", headers: apiHeaders },
      );
      if (res.status === 401) {
        setHistoryOpen(false);
        handleUnauthorized();
        return null;
      }
      const data = await safeReadJson(res);
      if (!res.ok) {
        setErrorBanner(String(data.error ?? "Failed to compute revision diff."));
        return null;
      }
      return (data.diff ?? null) as RevisionDiffPayload | null;
    } catch {
      setErrorBanner("Network error loading revision diff.");
      return null;
    }
  }

  async function handleRestore(revision: number) {
    if (!activeDoc || readOnly || restoringRevision !== null) return;
    setErrorBanner(null);
    setRestoringRevision(revision);
    try {
      const res = await fetch(
        `/api/documents/${encodeURIComponent(activeDoc.documentId)}/versions/${revision}/restore`,
        {
          method: "POST",
          credentials: "include",
          headers: apiHeaders,
        },
      );
      if (res.status === 401) {
        setHistoryOpen(false);
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (res.ok) {
        const restored = data.document as StudioDocument;
        setActiveDoc(restored);
        clearDrafts();
        setConflictMessage(null);
        setHistoryOpen(false);
        await loadDocuments();
        setStatusMessage(`Restored revision ${revision} as new revision ${restored.revision}.`);
      } else {
        const msg = String(data.error ?? "Restore failed");
        setErrorBanner(msg);
        setStatusMessage(msg);
      }
    } catch {
      setErrorBanner("Network error restoring document revision.");
    } finally {
      setRestoringRevision(null);
    }
  }

  function handleSelectDocument(nextDoc: StudioDocument) {
    if (activeDoc?.documentId === nextDoc.documentId) return;
    if (hasUnsavedChanges) {
      const confirmed = window.confirm("You have unsaved changes on the current document. Discard and switch?");
      if (!confirmed) return;
    }
    setActiveDoc(nextDoc);
    clearDrafts();
    setConflictMessage(null);
  }

  const effectiveActiveDoc = useMemo((): StudioDocument | null => {
    if (!activeDoc) return null;
    return {
      ...activeDoc,
      title: draftTitle ?? activeDoc.title,
      language: draftLanguage ?? activeDoc.language,
      layout: draftLayout ?? activeDoc.layout,
    };
  }, [activeDoc, draftTitle, draftLanguage, draftLayout]);

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
          <span className="badge">
            {authMode === "jwt-pg" ? "Document Studio · JWT + PG RLS" : "Document Studio · D1 Prototype"}
          </span>
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
              title="Planned for a future phase — gated pending founder approval"
            >
              {studio.studioId.charAt(0).toUpperCase() + studio.studioId.slice(1)} (Planned)
            </button>
          ))}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          {authMode === "jwt-pg" ? (
            sessionActor ? (
              <>
                <span className="badge badge-ok" title={`Tenant ${sessionActor.tenantId}`}>
                  Role: {sessionActor.role}
                </span>
                <button type="button" className="btn" onClick={() => void handleLogout(false)}>
                  Sign Out
                </button>
                <button
                  type="button"
                  className="btn"
                  title="Increment token_version to revoke all active sessions"
                  onClick={() => void handleLogout(true)}
                >
                  Revoke All
                </button>
              </>
            ) : (
              <span className="badge badge-warn">Not Signed In</span>
            )
          ) : (
            <label>
              Role:&nbsp;
              <select
                className="btn"
                value={prototypeRole}
                onChange={(e) => setPrototypeRole(e.target.value as WorkspaceRole)}
              >
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
                <option value="reviewer">Reviewer (Read-Only + Export)</option>
                <option value="viewer">Viewer (Read-Only)</option>
              </select>
            </label>
          )}
          <button type="button" className="btn" onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? "Hide AI Panel" : "Show AI Panel"}
          </button>
        </div>
      </header>

      {errorBanner && (
        <div className="banner-error banner-bar" role="alert">
          <span>{errorBanner}</span>
          <button type="button" className="btn" onClick={() => setErrorBanner(null)}>
            Dismiss
          </button>
        </div>
      )}

      {conflictMessage && (
        <div className="banner-conflict banner-bar" role="alert">
          <span>
            <strong>Revision Conflict (409):</strong> {conflictMessage}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn primary" onClick={() => void reloadActiveDocument()}>
              Reload Latest Revision
            </button>
            <button type="button" className="btn" onClick={() => setConflictMessage(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!authInitialized ? (
        <main className="canvas-area">
          <div className="preview-card" style={{ maxWidth: 420, marginTop: 60 }} role="status">
            <strong>Initializing AI Office Suite Workspace...</strong>
            <span>Checking API auth mode and active session.</span>
          </div>
        </main>
      ) : authMode === "jwt-pg" && !sessionActor ? (
        <main className="canvas-area">
          <form className="auth-card" onSubmit={(e) => void handleLogin(e)}>
            <h2 style={{ margin: "0 0 6px 0", fontSize: 18 }}>Sign In (PostgreSQL RLS Session)</h2>
            <p style={{ margin: "0 0 12px 0", fontSize: 12, color: "#475569" }}>
              Authenticates via HttpOnly <code>aios_session</code> cookie with CSRF protection and tenant isolation.
            </p>
            <label>
              Email
              <input
                type="email"
                required
                className="input-field"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="editor@company.example"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                minLength={8}
                className="input-field"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
              />
            </label>
            <label>
              Tenant UUID
              <input
                type="text"
                required
                className="input-field"
                value={loginTenantId}
                onChange={(e) => setLoginTenantId(e.target.value)}
                placeholder="11111111-1111-4111-8111-111111111111"
              />
            </label>
            <label>
              Workspace UUID
              <input
                type="text"
                required
                className="input-field"
                value={loginWorkspaceId}
                onChange={(e) => setLoginWorkspaceId(e.target.value)}
                placeholder="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
              />
            </label>
            <button type="submit" className="btn primary" disabled={isAuthenticating}>
              {isAuthenticating ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </main>
      ) : (
        <>
          <div className="toolbar">
            <button
              type="button"
              className="btn primary"
              disabled={readOnly}
              onClick={() => setNewDocModalOpen(true)}
            >
              + New Document
            </button>
            <button
              type="button"
              className="btn"
              disabled={readOnly || isSeeding}
              onClick={() => void handleSeedBilingual()}
            >
              {isSeeding ? "Creating..." : "+ Bilingual EN/KM Sample"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={readOnly || isImportingDocx}
              onClick={() => fileInputRef.current?.click()}
            >
              {isImportingDocx ? "Importing DOCX..." : "Import DOCX"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx"
              style={{ display: "none" }}
              onChange={(e) => void handleDocxFileSelected(e)}
            />
            <button
              type="button"
              className="btn"
              disabled={readOnly || !hasUnsavedChanges || isSaving}
              title="Save current changes (Ctrl+S / Cmd+S)"
              onClick={() => void handleSave()}
            >
              {isSaving ? "Saving..." : `Save${hasUnsavedChanges ? " *" : ""}`}
            </button>
            <button type="button" className="btn" disabled={!activeDoc} onClick={() => void openHistory()}>
              Versions &amp; Audit
            </button>
            <button
              type="button"
              className="btn"
              disabled={!activeDoc || !canExport || isExporting !== null}
              title={!canExport ? "Viewers cannot export files; Reviewer or Editor role required." : undefined}
              onClick={() => void handleExport("docx")}
            >
              {isExporting === "docx" ? "Exporting DOCX..." : "Export DOCX"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!activeDoc || !canExport || isExporting !== null}
              title={!canExport ? "Viewers cannot export files; Reviewer or Editor role required." : undefined}
              onClick={() => void handleExport("pdf")}
            >
              {isExporting === "pdf" ? "Rendering PDF..." : "Export PDF"}
            </button>
          </div>

          <div className={`workspace-body ${panelOpen ? "" : "panel-collapsed"}`}>
            <aside className="sidebar" aria-label="Workspace Documents">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 12 }}>Documents ({totalDocs})</strong>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "2px 6px", fontSize: 11 }}
                  disabled={isLoadingDocs}
                  onClick={() => void loadDocuments()}
                >
                  {isLoadingDocs ? "..." : "Refresh"}
                </button>
              </div>
              <div className="sidebar-filters">
                <input
                  type="search"
                  className="input-field"
                  style={{ padding: "5px 8px", fontSize: 12 }}
                  placeholder="Search title..."
                  aria-label="Search documents by title"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <select
                  className="input-field"
                  style={{ padding: "4px 8px", fontSize: 12 }}
                  aria-label="Filter documents by language"
                  value={languageFilter}
                  onChange={(e) => setLanguageFilter(e.target.value as "" | "en" | "km" | "bilingual")}
                >
                  <option value="">All Languages</option>
                  <option value="bilingual">Bilingual (EN/KM)</option>
                  <option value="en">English</option>
                  <option value="km">ខ្មែរ (Khmer)</option>
                </select>
              </div>
              {isLoadingDocs && docs.length === 0 && (
                <div style={{ fontSize: 12, color: "#64748b" }} role="status">
                  Loading documents...
                </div>
              )}
              {!isLoadingDocs && docs.length === 0 && (
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {searchQuery || languageFilter
                    ? "No matching documents found."
                    : 'No documents yet. Click "+ New Document" or "+ Bilingual EN/KM Sample".'}
                </div>
              )}
              {docs.map((d) => (
                <button
                  key={d.documentId}
                  type="button"
                  className={`doc-item ${activeDoc?.documentId === d.documentId ? "selected" : ""}`}
                  onClick={() => handleSelectDocument(d)}
                >
                  <div style={{ fontWeight: 600 }}>{d.title}</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>
                    Rev {d.revision} · {d.language} · {d.layout.size}
                  </div>
                </button>
              ))}
            </aside>

            <main className="canvas-area">
              {effectiveActiveDoc && activeDoc ? (
                <>
                  <div className="doc-meta-bar" aria-label="Document Settings">
                    <input
                      type="text"
                      className="input-field"
                      disabled={readOnly}
                      aria-label="Document title"
                      value={effectiveActiveDoc.title}
                      onChange={(e) => setDraftTitle(e.target.value)}
                    />
                    <select
                      className="btn"
                      disabled={readOnly}
                      aria-label="Document language"
                      value={effectiveActiveDoc.language}
                      onChange={(e) => setDraftLanguage(e.target.value as StudioDocument["language"])}
                    >
                      <option value="bilingual">Bilingual</option>
                      <option value="en">English</option>
                      <option value="km">ខ្មែរ</option>
                    </select>
                    <select
                      className="btn"
                      disabled={readOnly}
                      aria-label="Page size"
                      value={effectiveActiveDoc.layout.size}
                      onChange={(e) =>
                        setDraftLayout({
                          ...effectiveActiveDoc.layout,
                          size: e.target.value as "A4" | "Letter",
                        })
                      }
                    >
                      <option value="A4">A4</option>
                      <option value="Letter">Letter</option>
                    </select>
                    <select
                      className="btn"
                      disabled={readOnly}
                      aria-label="Page orientation"
                      value={effectiveActiveDoc.layout.orientation}
                      onChange={(e) =>
                        setDraftLayout({
                          ...effectiveActiveDoc.layout,
                          orientation: e.target.value as "portrait" | "landscape",
                        })
                      }
                    >
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </select>
                  </div>
                  <DocumentEditor
                    document={effectiveActiveDoc}
                    tiptapContent={tiptapContent}
                    readOnly={readOnly}
                    onDocChange={(json) => setDraftBlocks(fromTiptapJson(json as unknown as TiptapNode, activeDoc.blocks))}
                    onSelectionChange={setSelection}
                  />
                </>
              ) : (
                <div className="preview-card" style={{ maxWidth: 460, marginTop: 60 }}>
                  <strong>Welcome to AI Office Suite</strong>
                  <span>
                    Create a new document, import a <code>.docx</code> file, or load the bilingual English &amp; Khmer
                    fixture to test Tiptap editing, controlled AI operations, mock voice commands (<code>isMock: true</code>),
                    revision diffs, and HarfBuzz PDF export.
                  </span>
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
                selectionGraphemeCount={selection.graphemeCount}
                onDocumentUpdated={loadDocuments}
                onRevisionConflict={(msg) => setConflictMessage(msg)}
                onUnauthorized={handleUnauthorized}
                apiHeaders={apiHeaders}
              />
            )}
          </div>
        </>
      )}

      <footer className="statusbar">
        <span>{statusMessage}</span>
        <span>
          English / ខ្មែរ · {authMode === "jwt-pg" ? "PostgreSQL RLS Storage" : "Local Prototype Storage"}
        </span>
      </footer>

      {newDocModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Create New Document"
          onClick={(e) => {
            if (e.target === e.currentTarget) setNewDocModalOpen(false);
          }}
        >
          <form className="modal-card" onSubmit={(e) => void handleCreateBlankDocument(e)}>
            <h3 style={{ margin: 0 }}>Create New Document</h3>
            <label>
              Title
              <input
                type="text"
                required
                maxLength={200}
                className="input-field"
                value={newDocTitle}
                onChange={(e) => setNewDocTitle(e.target.value)}
                placeholder="e.g. របាយការណ៍ហិរញ្ញវត្ថុ Q4 / Q4 Finance Brief"
              />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <label>
                Language
                <select
                  className="input-field"
                  value={newDocLanguage}
                  onChange={(e) => setNewDocLanguage(e.target.value as "en" | "km" | "bilingual")}
                >
                  <option value="bilingual">Bilingual</option>
                  <option value="en">English</option>
                  <option value="km">ខ្មែរ</option>
                </select>
              </label>
              <label>
                Page Size
                <select
                  className="input-field"
                  value={newDocSize}
                  onChange={(e) => setNewDocSize(e.target.value as "A4" | "Letter")}
                >
                  <option value="A4">A4</option>
                  <option value="Letter">Letter</option>
                </select>
              </label>
              <label>
                Orientation
                <select
                  className="input-field"
                  value={newDocOrientation}
                  onChange={(e) => setNewDocOrientation(e.target.value as "portrait" | "landscape")}
                >
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
              <button type="button" className="btn" onClick={() => setNewDocModalOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={isCreatingDoc || !newDocTitle.trim()}>
                {isCreatingDoc ? "Creating..." : "Create Document"}
              </button>
            </div>
          </form>
        </div>
      )}

      {historyOpen && (
        <VersionAuditDrawer
          versions={versions}
          auditEvents={auditEvents}
          currentRevision={activeDoc?.revision}
          readOnly={readOnly}
          isLoading={isLoadingHistory}
          restoringRevision={restoringRevision}
          onRestore={handleRestore}
          onCompareRevision={handleCompareRevision}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
