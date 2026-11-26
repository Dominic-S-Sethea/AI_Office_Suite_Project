import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
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
import {
  DocumentEditor,
  type DocumentEditorHandle,
  type EditorSelectionState,
} from "./components/DocumentEditor.tsx";
import { AiVoicePanel } from "./components/AiVoicePanel.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { NewDocumentModal } from "./components/NewDocumentModal.tsx";
import type { RevisionDiffPayload } from "./components/VersionAuditDrawer.tsx";
import {
  arrayBufferToBase64,
  formatApiErrorMessage,
  MAX_DOCX_UPLOAD_BYTES,
  safeReadJson,
} from "./lib/apiClient.ts";

const LazyVersionAuditDrawer = lazy(() => import("./components/VersionAuditDrawer.tsx"));

type AuthMode = "provisional-local" | "jwt-pg";
type BootState = "loading" | "ready" | "unreachable";

const PAGE_SIZE = 50;

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
  const [bootState, setBootState] = useState<BootState>("loading");
  const [bootAttempt, setBootAttempt] = useState(0);
  const [sessionActor, setSessionActor] = useState<ActorContext | null>(null);
  const [prototypeRole, setPrototypeRole] = useState<WorkspaceRole>("editor");

  // jwt-pg sign-in form state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginTenantId, setLoginTenantId] = useState("");
  const [loginWorkspaceId, setLoginWorkspaceId] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Documents, filters & pagination (M15)
  const [docs, setDocs] = useState<StudioDocument[]>([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [docOffset, setDocOffset] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [languageFilter, setLanguageFilter] = useState<"" | "en" | "km" | "bilingual">("");
  const [activeDoc, setActiveDoc] = useState<StudioDocument | null>(null);
  const activeDocIdRef = useRef<string | null>(null);

  // Imperative editor handle avoids per-keystroke fromTiptapJson serialization (H24)
  const editorRef = useRef<DocumentEditorHandle | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
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
  const [newDocError, setNewDocError] = useState<string | null>(null);
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);

  // DOCX import state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isImportingDocx, setIsImportingDocx] = useState(false);

  // Responsive panels & drawers (H27)
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  // Request abort / sequence guards (H23)
  const listAbortRef = useRef<AbortController | null>(null);
  const listSeqRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const historySeqRef = useRef(0);
  const diffAbortRef = useRef<AbortController | null>(null);

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
  const isAuthenticated = bootState === "ready" && (authMode === "provisional-local" || sessionActor !== null);
  const hasUnsavedChanges =
    editorDirty || draftTitle !== null || draftLanguage !== null || draftLayout !== null;

  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  // Warn browser unload when unsaved changes exist (H25)
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  // Abort any in-flight fetches on unmount (H23)
  useEffect(() => {
    return () => {
      listAbortRef.current?.abort();
      historyAbortRef.current?.abort();
      diffAbortRef.current?.abort();
    };
  }, []);

  const clearDrafts = useCallback(() => {
    setEditorDirty(false);
    setDraftTitle(null);
    setDraftLanguage(null);
    setDraftLayout(null);
  }, []);

  const confirmDiscardUnsavedChanges = useCallback((actionDescription: string): boolean => {
    if (!hasUnsavedChangesRef.current) return true;
    return window.confirm(`You have unsaved changes on the current document. Discard them and ${actionDescription}?`);
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

  // Detect backend auth mode & restore existing cookie session if running under jwt-pg (M14 offline retry)
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function initAuth() {
      setBootState("loading");
      setErrorBanner(null);
      setStatusMessage("Connecting to workspace API...");
      try {
        const healthRes = await fetch("/api/health", { credentials: "include", signal: controller.signal });
        if (!healthRes.ok) {
          throw new Error(`API health check failed (HTTP ${healthRes.status})`);
        }
        const health = await safeReadJson(healthRes);
        const detectedMode: AuthMode = health.authMode === "jwt-pg" ? "jwt-pg" : "provisional-local";
        if (cancelled) return;
        setAuthMode(detectedMode);

        if (detectedMode === "jwt-pg") {
          const meRes = await fetch("/api/auth/me", { credentials: "include", signal: controller.signal });
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
        if (!cancelled) setBootState("ready");
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        setErrorBanner("Unable to reach API server. Verify the backend is running and click Retry Connection.");
        setStatusMessage("API unreachable");
        setBootState("unreachable");
      }
    }
    void initAuth();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bootAttempt]);

  const handleUnauthorized = useCallback(() => {
    if (authMode === "jwt-pg") {
      setSessionActor(null);
      setDocs([]);
      setTotalDocs(0);
      setDocOffset(0);
      setActiveDoc(null);
      clearDrafts();
      setErrorBanner("Session expired or revoked. Please sign in again.");
      setStatusMessage("Authentication required");
    }
  }, [authMode, clearDrafts]);

  const loadDocuments = useCallback(
    async (opts?: { forceSyncActive?: boolean }) => {
      if (bootState !== "ready" || !isAuthenticated) return;
      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;
      const seq = ++listSeqRef.current;

      setIsLoadingDocs(true);
      try {
        const qs = new URLSearchParams();
        if (searchQuery.trim()) qs.set("q", searchQuery.trim());
        if (languageFilter) qs.set("language", languageFilter);
        qs.set("limit", String(PAGE_SIZE));
        qs.set("offset", String(docOffset));
        const res = await fetch(`/api/documents?${qs.toString()}`, {
          credentials: "include",
          headers: apiHeaders,
          signal: controller.signal,
        });
        if (seq !== listSeqRef.current) return;
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        const data = await safeReadJson(res);
        if (seq !== listSeqRef.current) return;
        if (!res.ok) {
          setErrorBanner(formatApiErrorMessage(res, data, "Failed to load workspace documents."));
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
          if (refreshed) {
            if (opts?.forceSyncActive || !hasUnsavedChangesRef.current) {
              setActiveDoc(refreshed);
            } else {
              setActiveDoc((prev) => {
                if (prev && refreshed.revision !== prev.revision) {
                  setConflictMessage(
                    `Server revision advanced to rev ${refreshed.revision} while you have unsaved edits on rev ${prev.revision}.`,
                  );
                }
                return prev;
              });
            }
          } else if (!searchQuery.trim() && !languageFilter && docOffset === 0 && !hasUnsavedChangesRef.current) {
            setActiveDoc(list[0] ?? null);
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (seq === listSeqRef.current) {
          setErrorBanner("Network error while loading workspace documents.");
        }
      } finally {
        if (seq === listSeqRef.current) {
          setIsLoadingDocs(false);
        }
      }
    },
    [apiHeaders, bootState, isAuthenticated, handleUnauthorized, searchQuery, languageFilter, docOffset],
  );

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
        setErrorBanner(formatApiErrorMessage(res, data, "Sign in failed. Verify credentials and tenant/workspace IDs."));
        return;
      }
      setSessionActor(data.actor as ActorContext);
      setLoginPassword("");
      setDocOffset(0);
      setStatusMessage("Signed in via HttpOnly session cookie (PostgreSQL RLS).");
    } catch {
      setErrorBanner("Network error during sign in.");
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function handleLogout(revokeAll = false) {
    if (!confirmDiscardUnsavedChanges(revokeAll ? "revoke all active sessions" : "sign out")) return;
    setErrorBanner(null);
    try {
      const res = await fetch(revokeAll ? "/api/auth/revoke-sessions" : "/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok && res.status !== 401) {
        const data = await safeReadJson(res);
        // Truthful error feedback when server-side revocation fails (M14)
        setErrorBanner(
          formatApiErrorMessage(
            res,
            data,
            revokeAll ? "Server failed to revoke all sessions. Please retry." : "Sign out request failed.",
          ),
        );
        return;
      }
      setSessionActor(null);
      setDocs([]);
      setTotalDocs(0);
      setDocOffset(0);
      setActiveDoc(null);
      clearDrafts();
      setConflictMessage(null);
      setStatusMessage(revokeAll ? "All sessions revoked." : "Signed out.");
    } catch {
      setErrorBanner(
        revokeAll
          ? "Network error while revoking sessions — existing sessions may still be active."
          : "Network error during sign out. Please retry.",
      );
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
        setErrorBanner(formatApiErrorMessage(res, data, "Failed to reload latest document."));
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
    if (!confirmDiscardUnsavedChanges("create a new document")) return;
    setNewDocError(null);
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
        setNewDocError(formatApiErrorMessage(res, data, "Failed to create document."));
        return;
      }
      const created = data.document as StudioDocument;
      setActiveDoc(created);
      clearDrafts();
      setConflictMessage(null);
      setNewDocModalOpen(false);
      setNewDocTitle("");
      setNewDocError(null);
      setDocOffset(0);
      await loadDocuments();
      setStatusMessage(`Created '${created.title}' (${created.layout.size} ${created.layout.orientation}).`);
    } catch {
      setNewDocError("Network error creating new document.");
    } finally {
      setIsCreatingDoc(false);
    }
  }

  async function handleDocxFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || readOnly || isImportingDocx) return;
    if (!confirmDiscardUnsavedChanges("import a DOCX file")) return;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setErrorBanner("Only .docx files are supported for Document Studio import (.docm macros are blocked).");
      return;
    }
    if (file.size > MAX_DOCX_UPLOAD_BYTES) {
      setErrorBanner("DOCX file exceeds 10 MB safety limit.");
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
        setErrorBanner(formatApiErrorMessage(res, data, "DOCX import failed."));
        setStatusMessage("DOCX import rejected.");
        return;
      }
      const created = data.document as StudioDocument;
      const diagnostics = data.diagnostics as { originalSha256?: string; warnings?: string[] } | undefined;
      setActiveDoc(created);
      clearDrafts();
      setDocOffset(0);
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
    if (!confirmDiscardUnsavedChanges("load a new bilingual sample document")) return;
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
        setDocOffset(0);
        await loadDocuments();
        setStatusMessage("Loaded bilingual English/Khmer management report fixture.");
      } else {
        const msg = formatApiErrorMessage(res, data, "Failed to create fixture");
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
      // Serialize Tiptap JSON into canonical DocumentBlock[] strictly on Save (H24)
      const currentJson = editorDirty ? editorRef.current?.getCurrentTiptapJson() : null;
      const blocksToSave = currentJson
        ? fromTiptapJson(currentJson as unknown as TiptapNode, activeDoc.blocks)
        : activeDoc.blocks;

      const res = await fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          expectedRevision: activeDoc.revision,
          title: (draftTitle ?? activeDoc.title).trim().normalize("NFC"),
          language: draftLanguage ?? activeDoc.language,
          layout: draftLayout ?? activeDoc.layout,
          blocks: blocksToSave,
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
        const msg = formatApiErrorMessage(res, data, "Save failed");
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
    editorDirty,
    readOnly,
    isSaving,
    apiHeaders,
    draftTitle,
    draftLanguage,
    draftLayout,
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
        const msg = formatApiErrorMessage(res, data, `${kind.toUpperCase()} export failed`);
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
      // Defer object URL revocation so Safari & slow download managers finish streaming cleanly (M14)
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatusMessage(`Exported ${kind.toUpperCase()} snapshot (rev ${activeDoc.revision}).`);
    } catch {
      setErrorBanner(`Network error during ${kind.toUpperCase()} export.`);
    } finally {
      setIsExporting(null);
    }
  }

  async function openHistory() {
    if (!activeDoc) return;
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    const seq = ++historySeqRef.current;

    setErrorBanner(null);
    setHistoryOpen(true);
    setIsLoadingHistory(true);
    try {
      const [vRes, aRes] = await Promise.all([
        fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}/versions`, {
          credentials: "include",
          headers: apiHeaders,
          signal: controller.signal,
        }),
        fetch(`/api/documents/${encodeURIComponent(activeDoc.documentId)}/audit`, {
          credentials: "include",
          headers: apiHeaders,
          signal: controller.signal,
        }),
      ]);
      if (seq !== historySeqRef.current) return;
      if (vRes.status === 401 || aRes.status === 401) {
        setHistoryOpen(false);
        handleUnauthorized();
        return;
      }
      if (!vRes.ok || !aRes.ok) {
        const badRes = !vRes.ok ? vRes : aRes;
        const errData = await safeReadJson(badRes);
        setErrorBanner(formatApiErrorMessage(badRes, errData, "Failed to load version & audit history."));
        setHistoryOpen(false);
        return;
      }
      const vData = await safeReadJson(vRes);
      const aData = await safeReadJson(aRes);
      if (seq !== historySeqRef.current) return;
      setVersions((vData.versions ?? []) as DocumentVersion[]);
      setAuditEvents((aData.events ?? []) as AuditEvent[]);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (seq === historySeqRef.current) {
        setErrorBanner("Network error loading version & audit history.");
        setHistoryOpen(false);
      }
    } finally {
      if (seq === historySeqRef.current) {
        setIsLoadingHistory(false);
      }
    }
  }

  const handleCompareRevision = useCallback(
    async (fromRev: number, toRev: number): Promise<RevisionDiffPayload | null> => {
      if (!activeDoc) return null;
      diffAbortRef.current?.abort();
      const controller = new AbortController();
      diffAbortRef.current = controller;
      try {
        const res = await fetch(
          `/api/documents/${encodeURIComponent(activeDoc.documentId)}/versions/${fromRev}/diff/${toRev}`,
          { credentials: "include", headers: apiHeaders, signal: controller.signal },
        );
        if (res.status === 401) {
          setHistoryOpen(false);
          handleUnauthorized();
          return null;
        }
        const data = await safeReadJson(res);
        if (!res.ok) {
          setErrorBanner(formatApiErrorMessage(res, data, "Failed to compute revision diff."));
          return null;
        }
        return (data.diff ?? null) as RevisionDiffPayload | null;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return null;
        setErrorBanner("Network error loading revision diff.");
        return null;
      }
    },
    [activeDoc, apiHeaders, handleUnauthorized],
  );

  const handleRestore = useCallback(
    async (revision: number) => {
      if (!activeDoc || readOnly || restoringRevision !== null) return;
      if (!confirmDiscardUnsavedChanges(`restore revision ${revision}`)) return;
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
          const msg = formatApiErrorMessage(res, data, "Restore failed");
          setErrorBanner(msg);
          setStatusMessage(msg);
        }
      } catch {
        setErrorBanner("Network error restoring document revision.");
      } finally {
        setRestoringRevision(null);
      }
    },
    [activeDoc, readOnly, restoringRevision, confirmDiscardUnsavedChanges, apiHeaders, handleUnauthorized, clearDrafts, loadDocuments],
  );

  function handleSelectDocument(nextDoc: StudioDocument) {
    if (activeDoc?.documentId === nextDoc.documentId) return;
    if (!confirmDiscardUnsavedChanges("switch documents")) return;
    setActiveDoc(nextDoc);
    clearDrafts();
    setConflictMessage(null);
  }

  function handlePrototypeRoleChange(nextRole: WorkspaceRole) {
    if (!confirmDiscardUnsavedChanges(`switch role to ${nextRole}`)) return;
    setPrototypeRole(nextRole);
  }

  const handleAiDocumentUpdated = useCallback(async () => {
    clearDrafts();
    await loadDocuments({ forceSyncActive: true });
  }, [clearDrafts, loadDocuments]);

  const handleCloseHistory = useCallback(() => {
    historyAbortRef.current?.abort();
    diffAbortRef.current?.abort();
    setHistoryOpen(false);
  }, []);

  const handleCloseNewDocModal = useCallback(() => {
    setNewDocModalOpen(false);
    setNewDocError(null);
  }, []);

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

  const pageStart = totalDocs === 0 ? 0 : docOffset + 1;
  const pageEnd = Math.min(docOffset + docs.length, totalDocs);
  const hasPrevPage = docOffset > 0;
  const hasNextPage = docOffset + PAGE_SIZE < totalDocs;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1 className="brand-title">AI Office Suite</h1>
          <span className="badge">
            {authMode === "jwt-pg" ? "Document Studio · JWT + PG RLS" : "Document Studio · D1 Prototype"}
          </span>
        </div>

        <nav className="studio-tabs" aria-label="Workspace Studios">
          <button type="button" className="studio-tab active" aria-current="page">
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

        <div className="topbar-controls">
          {bootState === "ready" && isAuthenticated && (
            <button
              type="button"
              className="btn mobile-drawer-toggle"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? "Hide Docs" : "Documents"}
            </button>
          )}
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
            <label className="role-selector-label">
              Role:&nbsp;
              <select
                className="btn"
                value={prototypeRole}
                onChange={(e) => handlePrototypeRoleChange(e.target.value as WorkspaceRole)}
              >
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
                <option value="reviewer">Reviewer (Read-Only + Export)</option>
                <option value="viewer">Viewer (Read-Only)</option>
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
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
          <div className="row-actions-tight">
            <button type="button" className="btn primary" onClick={() => void reloadActiveDocument()}>
              Reload Latest Revision
            </button>
            <button type="button" className="btn" onClick={() => setConflictMessage(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {bootState === "loading" ? (
        <main className="canvas-area">
          <div className="preview-card boot-status-card" role="status">
            <strong>Initializing AI Office Suite Workspace...</strong>
            <span>Checking API auth mode and active session.</span>
          </div>
        </main>
      ) : bootState === "unreachable" ? (
        <main className="canvas-area">
          <div className="preview-card boot-status-card" role="alert">
            <strong>Workspace API Unreachable</strong>
            <span className="muted-text">
              Could not verify API health or authentication mode. Ensure the backend service is running, then retry.
            </span>
            <div className="row-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => setBootAttempt((n) => n + 1)}
              >
                Retry Connection
              </button>
            </div>
          </div>
        </main>
      ) : authMode === "jwt-pg" && !sessionActor ? (
        <main className="canvas-area">
          <form className="auth-card" onSubmit={(e) => void handleLogin(e)}>
            <h2 className="auth-card-title">Sign In (PostgreSQL RLS Session)</h2>
            <p className="auth-card-subtitle">
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
          <div className="toolbar" role="toolbar" aria-label="Workspace Actions">
            <button
              type="button"
              className="btn primary"
              disabled={readOnly}
              onClick={() => {
                setNewDocError(null);
                setNewDocModalOpen(true);
              }}
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
              aria-label="Import DOCX file"
              className="visually-hidden"
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

          <div
            className={`workspace-body ${panelOpen ? "" : "panel-collapsed"} ${sidebarOpen ? "" : "sidebar-collapsed"}`}
          >
            {sidebarOpen && (
              <aside className="sidebar" aria-label="Workspace Documents">
                <div className="panel-header-row">
                  <strong className="sidebar-title">Documents ({totalDocs})</strong>
                  <button
                    type="button"
                    className="btn btn-compact"
                    disabled={isLoadingDocs}
                    onClick={() => void loadDocuments()}
                  >
                    {isLoadingDocs ? "..." : "Refresh"}
                  </button>
                </div>
                <div className="sidebar-filters">
                  <input
                    type="search"
                    className="input-field input-compact"
                    placeholder="Search title..."
                    aria-label="Search documents by title"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setDocOffset(0);
                    }}
                  />
                  <select
                    className="input-field input-compact"
                    aria-label="Filter documents by language"
                    value={languageFilter}
                    onChange={(e) => {
                      setLanguageFilter(e.target.value as "" | "en" | "km" | "bilingual");
                      setDocOffset(0);
                    }}
                  >
                    <option value="">All Languages</option>
                    <option value="bilingual">Bilingual (EN/KM)</option>
                    <option value="en">English</option>
                    <option value="km">ខ្មែរ (Khmer)</option>
                  </select>
                </div>
                {isLoadingDocs && docs.length === 0 && (
                  <div className="muted-text" role="status">
                    Loading documents...
                  </div>
                )}
                {!isLoadingDocs && docs.length === 0 && (
                  <div className="muted-text">
                    {searchQuery || languageFilter
                      ? "No matching documents found."
                      : 'No documents yet. Click "+ New Document" or "+ Bilingual EN/KM Sample".'}
                  </div>
                )}
                {docs.map((d) => {
                  const isSelected = activeDoc?.documentId === d.documentId;
                  return (
                    <button
                      key={d.documentId}
                      type="button"
                      aria-current={isSelected ? "true" : undefined}
                      className={`doc-item ${isSelected ? "selected" : ""}`}
                      onClick={() => handleSelectDocument(d)}
                    >
                      <div className="strong-text">{d.title}</div>
                      <div className="meta-caption">
                        Rev {d.revision} · {d.language} · {d.layout.size}
                      </div>
                    </button>
                  );
                })}
                {totalDocs > PAGE_SIZE && (
                  <div className="pagination-bar" role="navigation" aria-label="Document pagination">
                    <span className="meta-caption">
                      {pageStart}–{pageEnd} of {totalDocs}
                    </span>
                    <div className="row-actions-tight">
                      <button
                        type="button"
                        className="btn btn-compact"
                        disabled={!hasPrevPage || isLoadingDocs}
                        onClick={() => setDocOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        className="btn btn-compact"
                        disabled={!hasNextPage || isLoadingDocs}
                        onClick={() => setDocOffset((prev) => prev + PAGE_SIZE)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </aside>
            )}

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
                  <ErrorBoundary scopeLabel="Document Editor">
                    <DocumentEditor
                      ref={editorRef}
                      document={effectiveActiveDoc}
                      tiptapContent={tiptapContent}
                      readOnly={readOnly}
                      onDirtyChange={setEditorDirty}
                      onSelectionChange={setSelection}
                    />
                  </ErrorBoundary>
                </>
              ) : (
                <div className="preview-card welcome-card">
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
                selectionStartOffset={selection.startOffset}
                selectionEndOffset={selection.endOffset}
                onDocumentUpdated={handleAiDocumentUpdated}
                onRevisionConflict={setConflictMessage}
                onUnauthorized={handleUnauthorized}
                apiHeaders={apiHeaders}
              />
            )}
          </div>
        </>
      )}

      <footer className="statusbar">
        <span role="status" aria-live="polite">
          {statusMessage}
        </span>
        <span>
          English / ខ្មែរ · {authMode === "jwt-pg" ? "PostgreSQL RLS Storage" : "Local Prototype Storage"}
        </span>
      </footer>

      {newDocModalOpen && (
        <NewDocumentModal
          title={newDocTitle}
          language={newDocLanguage}
          size={newDocSize}
          orientation={newDocOrientation}
          isCreating={isCreatingDoc}
          errorMessage={newDocError}
          onTitleChange={setNewDocTitle}
          onLanguageChange={setNewDocLanguage}
          onSizeChange={setNewDocSize}
          onOrientationChange={setNewDocOrientation}
          onSubmit={handleCreateBlankDocument}
          onClose={handleCloseNewDocModal}
        />
      )}

      {historyOpen && (
        <Suspense
          fallback={
            <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Loading history drawer">
              <div className="drawer-panel">
                <div className="preview-card" role="status">
                  Loading version &amp; audit drawer...
                </div>
              </div>
            </div>
          }
        >
          <LazyVersionAuditDrawer
            versions={versions}
            auditEvents={auditEvents}
            currentRevision={activeDoc?.revision}
            readOnly={readOnly}
            isLoading={isLoadingHistory}
            restoringRevision={restoringRevision}
            onRestore={handleRestore}
            onCompareRevision={handleCompareRevision}
            onClose={handleCloseHistory}
          />
        </Suspense>
      )}
    </div>
  );
}
