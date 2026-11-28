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
import { LeftNavRail, type FixedHeaderId, type NavFixedHeaderGroup } from "./components/LeftNavRail.tsx";
import { NewDocumentModal } from "./components/NewDocumentModal.tsx";
import type { HistorySectionTab, RevisionDiffPayload } from "./components/VersionAuditDrawer.tsx";
import { WorkspaceSubPanel, type WorkspaceUtilityPanelId } from "./components/WorkspaceSubPanel.tsx";
import {
  arrayBufferToBase64,
  formatApiErrorMessage,
  MAX_DOCX_UPLOAD_BYTES,
  safeReadJson,
  trapDialogTabKey,
} from "./lib/apiClient.ts";

const LazyVersionAuditDrawer = lazy(() => import("./components/VersionAuditDrawer.tsx"));

function DrawerLoadingFallback({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      trapDialogTabKey(panelRef.current, e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-loading-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className="drawer-panel">
        <div className="panel-header-row">
          <strong id="history-loading-title" className="modal-title">
            Version &amp; Audit History
          </strong>
          <button ref={closeBtnRef} type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="preview-card" role="status">
          Loading version &amp; audit drawer...
        </div>
      </div>
    </div>
  );
}

type AuthMode = "provisional-local" | "jwt-pg";
type BootState = "loading" | "ready" | "unreachable";
type ActiveStudioId = "documents" | "spreadsheets" | "presentations" | "analytics";

const PAGE_SIZE = 50;

const DOC_WRITE_ROLES = new Set<WorkspaceRole>(["owner", "administrator", "workspace_manager", "editor"]);
const DOC_EXPORT_ROLES = new Set<WorkspaceRole>(["owner", "administrator", "workspace_manager", "editor", "reviewer"]);
const DOC_READ_ROLES = new Set<WorkspaceRole>([
  "owner",
  "administrator",
  "workspace_manager",
  "editor",
  "reviewer",
  "viewer",
]);
const AUDIT_READ_ROLES = new Set<WorkspaceRole>([
  "owner",
  "administrator",
  "workspace_manager",
  "billing_admin",
  "auditor",
  "editor",
  "reviewer",
]);

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

  // 3-zone workspace navigation state
  const [activeStudio, setActiveStudio] = useState<ActiveStudioId>("documents");
  const [openFixedHeader, setOpenFixedHeader] = useState<FixedHeaderId | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [docsDrawerOpen, setDocsDrawerOpen] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? !window.matchMedia("(max-width: 960px)").matches
      : true,
  );
  const [activeSubPanel, setActiveSubPanel] = useState<WorkspaceUtilityPanelId>(null);
  const scrollStageRef = useRef<HTMLDivElement | null>(null);

  const toggleSubPanel = useCallback((panel: Exclude<WorkspaceUtilityPanelId, null>) => {
    setActiveSubPanel((prev) => {
      const next = prev === panel ? null : panel;
      if (next && scrollStageRef.current && typeof scrollStageRef.current.scrollTo === "function") {
        const prefersReduced =
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        scrollStageRef.current.scrollTo({ top: 0, behavior: prefersReduced ? "auto" : "smooth" });
      }
      return next;
    });
  }, []);

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

  const handleSelectionChange = useCallback((next: EditorSelectionState) => {
    setSelection((prev) =>
      prev.blockId === next.blockId &&
      prev.selectedText === next.selectedText &&
      prev.graphemeCount === next.graphemeCount &&
      prev.startOffset === next.startOffset &&
      prev.endOffset === next.endOffset
        ? prev
        : next,
    );
  }, []);

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

  // Version & audit drawer
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySection, setHistorySection] = useState<HistorySectionTab>("all");
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [versionsTotal, setVersionsTotal] = useState<number | undefined>(undefined);
  const [versionsHasMore, setVersionsHasMore] = useState(false);
  const [isLoadingMoreVersions, setIsLoadingMoreVersions] = useState(false);
  const [auditTotal, setAuditTotal] = useState<number | undefined>(undefined);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [isLoadingMoreAudit, setIsLoadingMoreAudit] = useState(false);
  const drawerTriggerElRef = useRef<HTMLElement | null>(null);

  // Request abort / sequence / session epoch guards (H23, F-17, FE-04, FE-05)
  const sessionEpochRef = useRef(0);
  const editGenRef = useRef(0);
  const activeRevisionRef = useRef<number | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);
  const listSeqRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const historySeqRef = useRef(0);
  const diffAbortRef = useRef<AbortController | null>(null);
  const reloadAbortRef = useRef<AbortController | null>(null);
  const reloadSeqRef = useRef(0);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  const [isExporting, setIsExporting] = useState<"docx" | "pdf" | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [editorSyncVersion, setEditorSyncVersion] = useState(0);

  const [statusMessage, setStatusMessage] = useState("Connecting to workspace API...");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const effectiveRole: WorkspaceRole = authMode === "jwt-pg" ? (sessionActor?.role ?? "viewer") : prototypeRole;
  const canReadDocs = DOC_READ_ROLES.has(effectiveRole);
  const readOnly = !DOC_WRITE_ROLES.has(effectiveRole);
  const canExport = DOC_EXPORT_ROLES.has(effectiveRole);
  const canReadAudit = AUDIT_READ_ROLES.has(effectiveRole);
  const isAuthenticated = bootState === "ready" && (authMode === "provisional-local" || sessionActor !== null);
  const hasUnsavedChanges =
    editorDirty || draftTitle !== null || draftLanguage !== null || draftLayout !== null;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 960px)");
    const onViewportChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setDocsDrawerOpen(false);
      } else {
        setMobileNavOpen(false);
      }
    };
    mq.addEventListener?.("change", onViewportChange);
    return () => mq.removeEventListener?.("change", onViewportChange);
  }, []);

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

  // Abort any in-flight fetches on unmount (H23, F-17)
  useEffect(() => {
    return () => {
      listAbortRef.current?.abort();
      historyAbortRef.current?.abort();
      diffAbortRef.current?.abort();
      reloadAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
      exportAbortRef.current?.abort();
    };
  }, []);

  const clearDrafts = useCallback(() => {
    setEditorDirty(false);
    setDraftTitle(null);
    setDraftLanguage(null);
    setDraftLayout(null);
  }, []);

  const handleEditMutation = useCallback(() => {
    editGenRef.current += 1;
  }, []);

  const handleTitleDraftChange = useCallback((value: string) => {
    editGenRef.current += 1;
    setDraftTitle(value);
  }, []);

  const handleLanguageDraftChange = useCallback((lang: StudioDocument["language"]) => {
    editGenRef.current += 1;
    setDraftLanguage(lang);
  }, []);

  const handleLayoutDraftChange = useCallback((layout: PageLayoutConfig) => {
    editGenRef.current += 1;
    setDraftLayout(layout);
  }, []);

  const resetSessionState = useCallback(() => {
    sessionEpochRef.current += 1;
    editGenRef.current += 1;
    listSeqRef.current += 1;
    historySeqRef.current += 1;
    reloadSeqRef.current += 1;
    listAbortRef.current?.abort();
    historyAbortRef.current?.abort();
    diffAbortRef.current?.abort();
    reloadAbortRef.current?.abort();
    mutationAbortRef.current?.abort();
    exportAbortRef.current?.abort();
    activeDocIdRef.current = null;
    activeRevisionRef.current = null;
    setSessionActor(null);
    setDocs([]);
    setTotalDocs(0);
    setDocOffset(0);
    setActiveDoc(null);
    setVersions([]);
    setAuditEvents([]);
    setVersionsTotal(undefined);
    setVersionsHasMore(false);
    setIsLoadingMoreVersions(false);
    setAuditTotal(undefined);
    setAuditHasMore(false);
    setIsLoadingMoreAudit(false);
    setSelection({ selectedText: "" });
    setHistoryOpen(false);
    setNewDocModalOpen(false);
    setNewDocTitle("");
    setNewDocError(null);
    setSearchQuery("");
    setLanguageFilter("");
    setActiveSubPanel(null);
    setConflictMessage(null);
    setIsLoadingHistory(false);
    setIsSaving(false);
    setIsSeeding(false);
    setIsCreatingDoc(false);
    setIsImportingDocx(false);
    setIsExporting(null);
    setRestoringRevision(null);
    clearDrafts();
    setEditorSyncVersion((v) => v + 1);
  }, [clearDrafts]);

  const confirmDiscardUnsavedChanges = useCallback((actionDescription: string): boolean => {
    if (!hasUnsavedChangesRef.current) return true;
    if (typeof window.confirm !== "function") return true;
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
    const prevId = activeDocIdRef.current;
    const nextId = activeDoc?.documentId ?? null;
    activeDocIdRef.current = nextId;
    activeRevisionRef.current = activeDoc?.revision ?? null;
    if (prevId !== nextId) {
      setSelection({ selectedText: "" });
    }
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
      resetSessionState();
      setErrorBanner("Session expired or revoked. Please sign in again.");
      setStatusMessage("Authentication required");
    }
  }, [authMode, resetSessionState]);

  const loadDocuments = useCallback(
    async (opts?: { forceSyncActive?: boolean }) => {
      if (bootState !== "ready" || !isAuthenticated) return;
      if (!canReadDocs) {
        listAbortRef.current?.abort();
        setDocs([]);
        setTotalDocs(0);
        setActiveDoc(null);
        setIsLoadingDocs(false);
        setStatusMessage(`Governance role (${effectiveRole}) active: document content access is restricted.`);
        return;
      }
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
          activeDocIdRef.current = list[0].documentId;
          setActiveDoc(list[0]);
        } else if (currentId) {
          const refreshed = list.find((d) => d.documentId === currentId);
          if (refreshed) {
            if (opts?.forceSyncActive || !hasUnsavedChangesRef.current) {
              setActiveDoc(refreshed);
            } else if (
              activeRevisionRef.current !== null &&
              refreshed.revision !== activeRevisionRef.current
            ) {
              setConflictMessage(
                `Server revision advanced to rev ${refreshed.revision} while you have unsaved edits on rev ${activeRevisionRef.current}.`,
              );
            }
          } else if (!searchQuery.trim() && !languageFilter && docOffset === 0 && !hasUnsavedChangesRef.current) {
            activeDocIdRef.current = list[0]?.documentId ?? null;
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
    [apiHeaders, bootState, isAuthenticated, canReadDocs, effectiveRole, handleUnauthorized, searchQuery, languageFilter, docOffset],
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
    if (isLoggingOut) return;
    if (!confirmDiscardUnsavedChanges(revokeAll ? "revoke all active sessions" : "sign out")) return;
    setErrorBanner(null);
    setIsLoggingOut(true);
    const epoch = sessionEpochRef.current;
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
      if (epoch === sessionEpochRef.current) {
        resetSessionState();
        setStatusMessage(revokeAll ? "All sessions revoked." : "Signed out.");
      }
    } catch {
      setErrorBanner(
        revokeAll
          ? "Network error while revoking sessions — existing sessions may still be active."
          : "Network error during sign out. Please retry.",
      );
    } finally {
      setIsLoggingOut(false);
    }
  }

  async function reloadActiveDocument() {
    if (!activeDoc) return;
    const targetDocId = activeDoc.documentId;
    const epoch = sessionEpochRef.current;
    reloadAbortRef.current?.abort();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    const seq = ++reloadSeqRef.current;
    setErrorBanner(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(targetDocId)}`, {
        credentials: "include",
        headers: apiHeaders,
        signal: controller.signal,
      });
      if (epoch !== sessionEpochRef.current || seq !== reloadSeqRef.current || activeDocIdRef.current !== targetDocId) return;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (epoch !== sessionEpochRef.current || seq !== reloadSeqRef.current || activeDocIdRef.current !== targetDocId) return;
      if (!res.ok) {
        setErrorBanner(formatApiErrorMessage(res, data, "Failed to reload latest document."));
        return;
      }
      const latest = data.document as StudioDocument;
      setActiveDoc(latest);
      clearDrafts();
      setEditorSyncVersion((v) => v + 1);
      setConflictMessage(null);
      setDocs((prev) => prev.map((d) => (d.documentId === latest.documentId ? latest : d)));
      setStatusMessage(`Reloaded latest revision ${latest.revision}.`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (seq === reloadSeqRef.current) {
        setErrorBanner("Network error reloading latest revision.");
      }
    }
  }

  async function handleCreateBlankDocument(e: FormEvent) {
    e.preventDefault();
    if (readOnly || isCreatingDoc || !newDocTitle.trim()) return;
    if (!confirmDiscardUnsavedChanges("create a new document")) return;
    const epoch = sessionEpochRef.current;
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setNewDocError(null);
    setErrorBanner(null);
    setIsCreatingDoc(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        signal: controller.signal,
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
      if (epoch !== sessionEpochRef.current) return;
      if (res.status === 401) {
        setNewDocModalOpen(false);
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (epoch !== sessionEpochRef.current) return;
      if (!res.ok) {
        setNewDocError(formatApiErrorMessage(res, data, "Failed to create document."));
        return;
      }
      const created = data.document as StudioDocument;
      activeDocIdRef.current = created.documentId;
      setActiveDoc(created);
      clearDrafts();
      setEditorSyncVersion((v) => v + 1);
      setSelection({ selectedText: "" });
      setConflictMessage(null);
      setNewDocModalOpen(false);
      setNewDocTitle("");
      setNewDocError(null);
      setDocOffset(0);
      await loadDocuments();
      if (epoch !== sessionEpochRef.current) return;
      setStatusMessage(`Created '${created.title}' (${created.layout.size} ${created.layout.orientation}).`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (epoch === sessionEpochRef.current) {
        setNewDocError("Network error creating new document.");
      }
    } finally {
      if (epoch === sessionEpochRef.current) {
        setIsCreatingDoc(false);
      }
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
    const epoch = sessionEpochRef.current;
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setErrorBanner(null);
    setConflictMessage(null);
    setIsImportingDocx(true);
    try {
      const buf = await file.arrayBuffer();
      if (epoch !== sessionEpochRef.current) return;
      const contentBase64 = arrayBufferToBase64(buf);
      const res = await fetch("/api/documents/import/docx", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        signal: controller.signal,
        body: JSON.stringify({ filename: file.name, contentBase64 }),
      });
      if (epoch !== sessionEpochRef.current) return;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (epoch !== sessionEpochRef.current) return;
      if (!res.ok) {
        setErrorBanner(formatApiErrorMessage(res, data, "DOCX import failed."));
        setStatusMessage("DOCX import rejected.");
        return;
      }
      const created = data.document as StudioDocument;
      const diagnostics = data.diagnostics as { originalSha256?: string; warnings?: string[] } | undefined;
      activeDocIdRef.current = created.documentId;
      setActiveDoc(created);
      clearDrafts();
      setEditorSyncVersion((v) => v + 1);
      setSelection({ selectedText: "" });
      setDocOffset(0);
      await loadDocuments();
      if (epoch !== sessionEpochRef.current) return;
      const shaPrefix = diagnostics?.originalSha256?.slice(0, 10) ?? "verified";
      const warnCount = diagnostics?.warnings?.length ?? 0;
      setStatusMessage(
        `Imported DOCX '${file.name}' (SHA-256 ${shaPrefix}${warnCount > 0 ? `, ${warnCount} warning(s)` : ""}).`,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (epoch === sessionEpochRef.current) {
        setErrorBanner("Network or read error importing DOCX file.");
      }
    } finally {
      if (epoch === sessionEpochRef.current) {
        setIsImportingDocx(false);
      }
    }
  }

  const handleSeedBilingual = useCallback(async () => {
    if (readOnly || isSeeding) return;
    if (!confirmDiscardUnsavedChanges("load a new bilingual sample document")) return;
    const epoch = sessionEpochRef.current;
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setErrorBanner(null);
    setConflictMessage(null);
    setIsSeeding(true);
    try {
      const res = await fetch("/api/documents/seed-bilingual-fixture", {
        method: "POST",
        credentials: "include",
        headers: apiHeaders,
        signal: controller.signal,
      });
      if (epoch !== sessionEpochRef.current) return;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (epoch !== sessionEpochRef.current) return;
      if (res.ok) {
        const created = data.document as StudioDocument;
        activeDocIdRef.current = created.documentId;
        setActiveDoc(created);
        clearDrafts();
        setEditorSyncVersion((v) => v + 1);
        setSelection({ selectedText: "" });
        setDocOffset(0);
        await loadDocuments();
        if (epoch !== sessionEpochRef.current) return;
        setStatusMessage("Loaded bilingual English/Khmer management report fixture.");
      } else {
        const msg = formatApiErrorMessage(res, data, "Failed to create fixture");
        setErrorBanner(msg);
        setStatusMessage(msg);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (epoch === sessionEpochRef.current) {
        setErrorBanner("Network error creating bilingual fixture.");
      }
    } finally {
      if (epoch === sessionEpochRef.current) {
        setIsSeeding(false);
      }
    }
  }, [readOnly, isSeeding, confirmDiscardUnsavedChanges, apiHeaders, handleUnauthorized, clearDrafts, loadDocuments]);

  const handleSave = useCallback(async () => {
    if (!activeDoc || !hasUnsavedChanges || readOnly || isSaving) return;
    const trimmedTitle = (draftTitle ?? activeDoc.title).trim().normalize("NFC");
    if (!trimmedTitle) {
      setErrorBanner("Document title cannot be empty.");
      return;
    }
    const targetDocId = activeDoc.documentId;
    const epoch = sessionEpochRef.current;
    const saveStartGen = editGenRef.current;
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setErrorBanner(null);
    setIsSaving(true);
    try {
      // Serialize Tiptap JSON into canonical DocumentBlock[] strictly on Save (H24)
      const currentJson = editorDirty ? editorRef.current?.getCurrentTiptapJson() : null;
      const blocksToSave = currentJson
        ? fromTiptapJson(currentJson as unknown as TiptapNode, activeDoc.blocks)
        : activeDoc.blocks;

      const res = await fetch(`/api/documents/${encodeURIComponent(targetDocId)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        signal: controller.signal,
        body: JSON.stringify({
          expectedRevision: activeDoc.revision,
          title: trimmedTitle,
          language: draftLanguage ?? activeDoc.language,
          layout: draftLayout ?? activeDoc.layout,
          blocks: blocksToSave,
          summary: "Manual editor save",
        }),
      });
      if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await safeReadJson(res);
      if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
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
        if (editGenRef.current === saveStartGen) {
          clearDrafts();
          setEditorSyncVersion((v) => v + 1);
        }
        setConflictMessage(null);
        await loadDocuments();
        if (epoch !== sessionEpochRef.current) return;
        setStatusMessage(`Saved revision ${saved.revision}.`);
      } else {
        const msg = formatApiErrorMessage(res, data, "Save failed");
        setErrorBanner(msg);
        setStatusMessage(msg);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (epoch === sessionEpochRef.current && activeDocIdRef.current === targetDocId) {
        setErrorBanner("Network error saving document.");
      }
    } finally {
      if (epoch === sessionEpochRef.current) {
        setIsSaving(false);
      }
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

  // Keyboard shortcut: Ctrl+S / Cmd+S to save current document (disabled when a modal dialog is active)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  const handleExport = useCallback(
    async (kind: "docx" | "pdf") => {
      if (!activeDoc || !canExport || isExporting) return;
      if (
        hasUnsavedChangesRef.current &&
        typeof window.confirm === "function" &&
        !window.confirm(
          "You have unsaved local changes. Export the last saved server revision without those unsaved changes?",
        )
      ) {
        return;
      }
      const targetDoc = activeDoc;
      const epoch = sessionEpochRef.current;
      const controller = new AbortController();
      exportAbortRef.current = controller;
      setErrorBanner(null);
      setIsExporting(kind);
      setStatusMessage(kind === "docx" ? "Exporting DOCX snapshot..." : "Rendering PDF snapshot (HarfBuzz)...");
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(targetDoc.documentId)}/export/${kind}`, {
          method: "POST",
          credentials: "include",
          headers: apiHeaders,
          signal: controller.signal,
        });
        if (epoch !== sessionEpochRef.current) return;
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!res.ok) {
          const data = await safeReadJson(res);
          if (epoch !== sessionEpochRef.current) return;
          const msg = formatApiErrorMessage(res, data, `${kind.toUpperCase()} export failed`);
          setErrorBanner(msg);
          setStatusMessage(msg);
          return;
        }
        const blob = await res.blob();
        if (epoch !== sessionEpochRef.current) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${targetDoc.documentId}-rev${targetDoc.revision}.${kind}`;
        a.click();
        // Defer object URL revocation so Safari & slow download managers finish streaming cleanly (M14)
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setStatusMessage(`Exported ${kind.toUpperCase()} snapshot (rev ${targetDoc.revision}).`);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (epoch === sessionEpochRef.current) {
          setErrorBanner(`Network error during ${kind.toUpperCase()} export.`);
        }
      } finally {
        if (epoch === sessionEpochRef.current) {
          setIsExporting(null);
        }
      }
    },
    [activeDoc, canExport, isExporting, apiHeaders, handleUnauthorized],
  );

  const openHistory = useCallback(
    async (section: HistorySectionTab = "all") => {
      if (!activeDoc) return;
      drawerTriggerElRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const targetDocId = activeDoc.documentId;
      const epoch = sessionEpochRef.current;
      historyAbortRef.current?.abort();
      const controller = new AbortController();
      historyAbortRef.current = controller;
      const seq = ++historySeqRef.current;

      setErrorBanner(null);
      setHistorySection(section);
      setHistoryOpen(true);
      setIsLoadingHistory(true);
      setVersionsTotal(undefined);
      setVersionsHasMore(false);
      setAuditTotal(undefined);
      setAuditHasMore(false);
      try {
        const [vRes, aRes] = await Promise.all([
          fetch(`/api/documents/${encodeURIComponent(targetDocId)}/versions?limit=100&offset=0&order=desc`, {
            credentials: "include",
            headers: apiHeaders,
            signal: controller.signal,
          }),
          canReadAudit
            ? fetch(`/api/documents/${encodeURIComponent(targetDocId)}/audit?limit=100&offset=0`, {
                credentials: "include",
                headers: apiHeaders,
                signal: controller.signal,
              })
            : Promise.resolve(null),
        ]);
        if (epoch !== sessionEpochRef.current || seq !== historySeqRef.current) return;
        if (vRes.status === 401 || aRes?.status === 401) {
          setHistoryOpen(false);
          handleUnauthorized();
          return;
        }
        if (!vRes.ok) {
          const errData = await safeReadJson(vRes);
          setErrorBanner(formatApiErrorMessage(vRes, errData, "Failed to load version history."));
          setHistoryOpen(false);
          return;
        }
        const vData = await safeReadJson(vRes);
        if (epoch !== sessionEpochRef.current || seq !== historySeqRef.current) return;
        const vList = (vData.versions ?? []) as DocumentVersion[];
        const vTotal = typeof vData.total === "number" ? vData.total : vList.length;
        const vMore = typeof vData.hasMore === "boolean" ? vData.hasMore : vList.length < vTotal;
        setVersions(vList);
        setVersionsTotal(vTotal);
        setVersionsHasMore(vMore);

        if (aRes && aRes.ok) {
          const aData = await safeReadJson(aRes);
          if (epoch !== sessionEpochRef.current || seq !== historySeqRef.current) return;
          const aList = (aData.events ?? []) as AuditEvent[];
          const aTotal = typeof aData.total === "number" ? aData.total : aList.length;
          const aMore = typeof aData.hasMore === "boolean" ? aData.hasMore : aList.length < aTotal;
          setAuditEvents(aList);
          setAuditTotal(aTotal);
          setAuditHasMore(aMore);
        } else {
          if (aRes && aRes.status !== 403) {
            const errData = await safeReadJson(aRes);
            setErrorBanner(formatApiErrorMessage(aRes, errData, "Failed to load audit log."));
          }
          setAuditEvents([]);
          setAuditTotal(0);
          setAuditHasMore(false);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (epoch === sessionEpochRef.current && seq === historySeqRef.current) {
          setErrorBanner("Network error loading version & audit history.");
          setHistoryOpen(false);
        }
      } finally {
        if (epoch === sessionEpochRef.current && seq === historySeqRef.current) {
          setIsLoadingHistory(false);
        }
      }
    },
    [activeDoc, apiHeaders, canReadAudit, handleUnauthorized],
  );

  const handleLoadMoreVersions = useCallback(async () => {
    if (!activeDoc || isLoadingMoreVersions || !versionsHasMore) return;
    const epoch = sessionEpochRef.current;
    const targetDocId = activeDoc.documentId;
    setIsLoadingMoreVersions(true);
    try {
      const offset = versions.length;
      const res = await fetch(
        `/api/documents/${encodeURIComponent(targetDocId)}/versions?limit=100&offset=${offset}&order=desc`,
        { credentials: "include", headers: apiHeaders },
      );
      if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) return;
      const vData = await safeReadJson(res);
      if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
      const nextPage = (vData.versions ?? []) as DocumentVersion[];
      const seen = new Set(versions.map((v) => v.versionId));
      const merged = [...versions, ...nextPage.filter((v) => !seen.has(v.versionId))];
      const total = typeof vData.total === "number" ? vData.total : versionsTotal ?? merged.length;
      const hasMore =
        typeof vData.hasMore === "boolean"
          ? vData.hasMore
          : nextPage.length > 0 && merged.length < total;
      setVersions(merged);
      setVersionsTotal(total);
      setVersionsHasMore(hasMore);
    } finally {
      if (epoch === sessionEpochRef.current) {
        setIsLoadingMoreVersions(false);
      }
    }
  }, [activeDoc, apiHeaders, handleUnauthorized, isLoadingMoreVersions, versions, versionsHasMore, versionsTotal]);

  const handleLoadMoreAudit = useCallback(async () => {
    if (!activeDoc || !canReadAudit || isLoadingMoreAudit || !auditHasMore) return;
    const epoch = sessionEpochRef.current;
    const targetDocId = activeDoc.documentId;
    setIsLoadingMoreAudit(true);
    try {
      const offset = auditEvents.length;
      const res = await fetch(
        `/api/documents/${encodeURIComponent(targetDocId)}/audit?limit=100&offset=${offset}`,
        { credentials: "include", headers: apiHeaders },
      );
      if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) return;
      const aData = await safeReadJson(res);
      if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
      const nextPage = (aData.events ?? []) as AuditEvent[];
      const seen = new Set(auditEvents.map((e) => e.auditId));
      const merged = [...auditEvents, ...nextPage.filter((e) => !seen.has(e.auditId))];
      const total = typeof aData.total === "number" ? aData.total : auditTotal ?? merged.length;
      const hasMore =
        typeof aData.hasMore === "boolean"
          ? aData.hasMore
          : nextPage.length > 0 && merged.length < total;
      setAuditEvents(merged);
      setAuditTotal(total);
      setAuditHasMore(hasMore);
    } finally {
      if (epoch === sessionEpochRef.current) {
        setIsLoadingMoreAudit(false);
      }
    }
  }, [activeDoc, apiHeaders, auditEvents, auditHasMore, auditTotal, canReadAudit, handleUnauthorized, isLoadingMoreAudit]);

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
      const targetDocId = activeDoc.documentId;
      const epoch = sessionEpochRef.current;
      const controller = new AbortController();
      mutationAbortRef.current = controller;
      setErrorBanner(null);
      setRestoringRevision(revision);
      try {
        const res = await fetch(
          `/api/documents/${encodeURIComponent(targetDocId)}/versions/${revision}/restore`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", ...apiHeaders },
            signal: controller.signal,
            body: JSON.stringify({ expectedRevision: activeDoc.revision }),
          },
        );
        if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
        if (res.status === 401) {
          setHistoryOpen(false);
          handleUnauthorized();
          return;
        }
        const data = await safeReadJson(res);
        if (epoch !== sessionEpochRef.current || activeDocIdRef.current !== targetDocId) return;
        if (res.status === 409) {
          const msg = String(
            data.error ??
              `Revision conflict: expected rev ${activeDoc.revision}, but the document was modified elsewhere.`,
          );
          setConflictMessage(msg);
          setHistoryOpen(false);
          setStatusMessage("Restore blocked by revision conflict (409).");
          return;
        }
        if (res.ok) {
          const restored = data.document as StudioDocument;
          setActiveDoc(restored);
          clearDrafts();
          setEditorSyncVersion((v) => v + 1);
          setConflictMessage(null);
          setHistoryOpen(false);
          await loadDocuments();
          if (epoch !== sessionEpochRef.current) return;
          setStatusMessage(`Restored revision ${revision} as new revision ${restored.revision}.`);
        } else {
          const msg = formatApiErrorMessage(res, data, "Restore failed");
          setErrorBanner(msg);
          setStatusMessage(msg);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (epoch === sessionEpochRef.current && activeDocIdRef.current === targetDocId) {
          setErrorBanner("Network error restoring document revision.");
        }
      } finally {
        if (epoch === sessionEpochRef.current) {
          setRestoringRevision(null);
        }
      }
    },
    [activeDoc, readOnly, restoringRevision, apiHeaders, handleUnauthorized, clearDrafts, loadDocuments],
  );

  function handleSelectDocument(nextDoc: StudioDocument) {
    if (activeDoc?.documentId === nextDoc.documentId) return;
    if (!confirmDiscardUnsavedChanges("switch documents")) return;
    reloadAbortRef.current?.abort();
    reloadSeqRef.current += 1;
    activeDocIdRef.current = nextDoc.documentId;
    setActiveDoc(nextDoc);
    setSelection({ selectedText: "" });
    clearDrafts();
    setConflictMessage(null);
  }

  function handlePrototypeRoleChange(nextRole: WorkspaceRole) {
    if (!confirmDiscardUnsavedChanges(`switch role to ${nextRole}`)) return;
    clearDrafts();
    setEditorSyncVersion((v) => v + 1);
    setConflictMessage(null);
    setPrototypeRole(nextRole);
  }

  const handleAiDocumentUpdated = useCallback(
    async (updatedDoc?: StudioDocument) => {
      clearDrafts();
      setEditorSyncVersion((v) => v + 1);
      setConflictMessage(null);
      if (updatedDoc) {
        activeDocIdRef.current = updatedDoc.documentId;
        setActiveDoc(updatedDoc);
        setDocs((prev) => prev.map((d) => (d.documentId === updatedDoc.documentId ? updatedDoc : d)));
      }
      await loadDocuments({ forceSyncActive: !updatedDoc });
    },
    [clearDrafts, loadDocuments],
  );

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

  const studioLabelMap: Record<string, string> = {
    spreadsheets: "Spreadsheets",
    presentations: "Presentations",
    analytics: "Intelligence BI",
  };

  const navGroups = useMemo<NavFixedHeaderGroup[]>(() => {
    const readOnlyTooltip = !canReadDocs
      ? `Governance role (${effectiveRole}): document reading and writing are disabled.`
      : effectiveRole === "reviewer"
        ? "Read-only role (Reviewer): creating, importing, editing, and saving documents are disabled."
        : effectiveRole === "viewer"
          ? "Read-only role (Viewer): creating, importing, editing, saving, and exporting are disabled."
          : "Read-only role active: document mutations are disabled.";
    const noDocTooltip = "Select or create a document first.";
    const exportTooltip = !activeDoc
      ? noDocTooltip
      : !canExport
        ? "Role lacks export permission (export:export); Reviewer or Editor role required."
        : isExporting !== null
          ? "Another export is already in progress."
          : undefined;
    const saveTooltip = readOnly
      ? readOnlyTooltip
      : !hasUnsavedChanges
        ? "No unsaved changes to save."
        : isSaving
          ? "Saving changes..."
          : "Save current changes (Ctrl+S / Cmd+S)";

    return [
      {
        id: "files",
        label: "Files & Docs",
        shortTag: "FD",
        subHeaders: [
          {
            id: "all_docs",
            label: docsDrawerOpen ? "Hide Document List" : "All Documents",
            badge: String(totalDocs),
            active: docsDrawerOpen,
            title: docsDrawerOpen ? "Collapse workspace documents drawer" : "Show workspace documents drawer",
            onSelect: () => {
              setActiveStudio("documents");
              setDocsDrawerOpen((v) => !v);
              setMobileNavOpen(false);
            },
          },
          {
            id: "new_blank",
            label: "+ New Blank",
            disabled: readOnly,
            title: readOnly ? readOnlyTooltip : "Create a new blank English, Khmer, or bilingual document",
            onSelect: () => {
              setActiveStudio("documents");
              setNewDocError(null);
              setNewDocModalOpen(true);
              setMobileNavOpen(false);
            },
          },
          {
            id: "seed_bilingual",
            label: isSeeding ? "Creating..." : "Bilingual Sample",
            disabled: readOnly || isSeeding,
            title: readOnly ? readOnlyTooltip : "Load the bilingual EN/KM management report fixture",
            onSelect: () => {
              setActiveStudio("documents");
              setMobileNavOpen(false);
              void handleSeedBilingual();
            },
          },
          {
            id: "import_docx",
            label: isImportingDocx ? "Importing..." : "Import DOCX",
            disabled: readOnly || isImportingDocx,
            title: readOnly ? readOnlyTooltip : "Import a .docx file into Document Studio",
            onSelect: () => {
              setActiveStudio("documents");
              setMobileNavOpen(false);
              fileInputRef.current?.click();
            },
          },
          {
            id: "save_doc",
            label: isSaving ? "Saving..." : `Save${hasUnsavedChanges ? " *" : ""}`,
            disabled: readOnly || !hasUnsavedChanges || isSaving || !(draftTitle ?? activeDoc?.title ?? "").trim(),
            title: !(draftTitle ?? activeDoc?.title ?? "").trim() && activeDoc ? "Document title cannot be empty." : saveTooltip,
            onSelect: () => {
              setMobileNavOpen(false);
              void handleSave();
            },
          },
          {
            id: "export_docx",
            label: isExporting === "docx" ? "Exporting..." : "Export DOCX",
            disabled: !activeDoc || !canExport || isExporting !== null,
            title: exportTooltip ?? "Export editable DOCX snapshot",
            onSelect: () => {
              setMobileNavOpen(false);
              void handleExport("docx");
            },
          },
          {
            id: "export_pdf",
            label: isExporting === "pdf" ? "Rendering..." : "Export PDF",
            disabled: !activeDoc || !canExport || isExporting !== null,
            title: exportTooltip ?? "Render paginated PDF snapshot (HarfBuzz)",
            onSelect: () => {
              setMobileNavOpen(false);
              void handleExport("pdf");
            },
          },
        ],
      },
      {
        id: "layout",
        label: "Page & Style",
        shortTag: "PS",
        subHeaders: [
          {
            id: "page_size",
            label: `Page Size (${effectiveActiveDoc?.layout.size ?? "A4"})`,
            active: activeSubPanel === "page_size",
            disabled: !activeDoc,
            title: !activeDoc ? noDocTooltip : "Configure paper size and margins",
            onSelect: () => {
              setActiveStudio("documents");
              toggleSubPanel("page_size");
              setMobileNavOpen(false);
            },
          },
          {
            id: "orientation",
            label: `Orientation (${effectiveActiveDoc?.layout.orientation ?? "portrait"})`,
            disabled: readOnly || !effectiveActiveDoc,
            title: readOnly
              ? readOnlyTooltip
              : !effectiveActiveDoc
                ? noDocTooltip
                : "Toggle portrait / landscape orientation",
            onSelect: () => {
              if (!effectiveActiveDoc) return;
              setActiveStudio("documents");
              handleLayoutDraftChange({
                ...effectiveActiveDoc.layout,
                orientation: effectiveActiveDoc.layout.orientation === "portrait" ? "landscape" : "portrait",
              });
              setMobileNavOpen(false);
            },
          },
          {
            id: "khmer_fonts",
            label: "Khmer Fonts & Headers",
            active: activeSubPanel === "page_fonts",
            disabled: !activeDoc,
            title: !activeDoc ? noDocTooltip : "Configure document language, headers, footers, and Khmer fonts",
            onSelect: () => {
              setActiveStudio("documents");
              toggleSubPanel("page_fonts");
              setMobileNavOpen(false);
            },
          },
          {
            id: "linked_metrics",
            label: "Linked Metrics",
            active: activeSubPanel === "linked_metrics",
            onSelect: () => {
              toggleSubPanel("linked_metrics");
              setMobileNavOpen(false);
            },
          },
        ],
      },
      {
        id: "data",
        label: "Data & Analytics",
        shortTag: "DA",
        subHeaders: [
          {
            id: "stage_profile",
            label: "Stage & Profile",
            badge: "API",
            active: activeSubPanel === "data_prep",
            onSelect: () => {
              toggleSubPanel("data_prep");
              setMobileNavOpen(false);
            },
          },
          {
            id: "certified_metrics",
            label: "Certified Metrics",
            badge: "V1",
            active: activeSubPanel === "certified_metrics",
            onSelect: () => {
              toggleSubPanel("certified_metrics");
              setMobileNavOpen(false);
            },
          },
          {
            id: "duckdb_spill",
            label: "DuckDB 1M Spill",
            badge: "TF-04",
            active: activeSubPanel === "duckdb_spill",
            onSelect: () => {
              toggleSubPanel("duckdb_spill");
              setMobileNavOpen(false);
            },
          },
        ],
      },
      {
        id: "workflows",
        label: "Workflows",
        shortTag: "WF",
        subHeaders: [
          {
            id: "linked_objects",
            label: "Linked Objects",
            active: activeSubPanel === "workflow_links",
            onSelect: () => {
              toggleSubPanel("workflow_links");
              setMobileNavOpen(false);
            },
          },
          {
            id: "reporting_packages",
            label: "Reporting Packages",
            badge: "XI-00",
            active: activeSubPanel === "workflow_packages",
            onSelect: () => {
              toggleSubPanel("workflow_packages");
              setMobileNavOpen(false);
            },
          },
          {
            id: "outbox_status",
            label: "Publication Outbox",
            active: activeSubPanel === "workflow_outbox",
            onSelect: () => {
              toggleSubPanel("workflow_outbox");
              setMobileNavOpen(false);
            },
          },
        ],
      },
      {
        id: "versions",
        label: "Versions & Audit",
        shortTag: "VA",
        subHeaders: [
          {
            id: "version_history",
            label: "Version History",
            disabled: !activeDoc,
            active: historyOpen && (historySection === "versions" || historySection === "all"),
            title: !activeDoc ? noDocTooltip : "Inspect immutable document revisions",
            onSelect: () => {
              setMobileNavOpen(false);
              void openHistory("versions");
            },
          },
          {
            id: "revision_diff",
            label: "Revision Diff",
            disabled: !activeDoc,
            active: historyOpen && historySection === "diff",
            title: !activeDoc ? noDocTooltip : "Compare block-level EN/KM changes between revisions",
            onSelect: () => {
              setMobileNavOpen(false);
              void openHistory("diff");
            },
          },
          {
            id: "audit_trail",
            label: "Audit Trail",
            disabled: !activeDoc || !canReadAudit,
            active: historyOpen && historySection === "audit",
            title: !activeDoc
              ? noDocTooltip
              : !canReadAudit
                ? "Audit trail requires Reviewer, Editor, Auditor, or Owner permission (audit:read)."
                : "Review append-only security and edit audit events",
            onSelect: () => {
              setMobileNavOpen(false);
              void openHistory("audit");
            },
          },
          {
            id: "backup_restore",
            label: "Backup & Restore",
            active: activeSubPanel === "backup_restore",
            onSelect: () => {
              toggleSubPanel("backup_restore");
              setMobileNavOpen(false);
            },
          },
        ],
      },
      {
        id: "admin",
        label: "Admin & Governance",
        shortTag: "AG",
        subHeaders: [
          {
            id: "role_rbac",
            label: `Role & RBAC (${effectiveRole})`,
            active: activeSubPanel === "admin_rbac",
            onSelect: () => {
              toggleSubPanel("admin_rbac");
              setMobileNavOpen(false);
            },
          },
          {
            id: "ai_voice_policy",
            label: "AI & Voice Policy",
            badge: "423",
            active: activeSubPanel === "admin_policies",
            onSelect: () => {
              toggleSubPanel("admin_policies");
              setMobileNavOpen(false);
            },
          },
          {
            id: "quotas_jobs",
            label: "Quotas & Jobs",
            badge: "PA-00",
            active: activeSubPanel === "admin_quotas",
            onSelect: () => {
              toggleSubPanel("admin_quotas");
              setMobileNavOpen(false);
            },
          },
          {
            id: "session_health",
            label: "Session & Health",
            active: activeSubPanel === "admin_health",
            onSelect: () => {
              toggleSubPanel("admin_health");
              setMobileNavOpen(false);
            },
          },
        ],
      },
    ];
  }, [
    docsDrawerOpen,
    totalDocs,
    canReadDocs,
    readOnly,
    effectiveRole,
    isSeeding,
    isImportingDocx,
    isSaving,
    hasUnsavedChanges,
    activeDoc,
    canExport,
    canReadAudit,
    isExporting,
    effectiveActiveDoc,
    activeSubPanel,
    historyOpen,
    historySection,
    handleSeedBilingual,
    handleSave,
    handleExport,
    toggleSubPanel,
    openHistory,
  ]);

  const titleReadOnlyTooltip = !canReadDocs
    ? `Governance role (${effectiveRole}): document content access is disabled.`
    : effectiveRole === "reviewer"
      ? "Read-only role (Reviewer): title editing and saving are disabled."
      : effectiveRole === "viewer"
        ? "Read-only role (Viewer): title editing and saving are disabled."
        : "Read-only role active: title editing and saving are disabled.";

  return (
    <div className="app-shell">
      {/* Zone 1: Master Top Header — Preserves the 4 Master Studio Headers in place */}
      <header className="topbar">
        <div className="brand">
          <h1 className="brand-title">AI Office Suite</h1>
          <span className="badge">
            {authMode === "jwt-pg" ? "JWT + PG RLS" : "Stage 1–3 Prototype"}
          </span>
        </div>

        <nav className="studio-tabs" aria-label="Workspace Studios">
          <button
            type="button"
            className={`studio-tab ${activeStudio === "documents" ? "active" : ""}`}
            aria-current={activeStudio === "documents" ? "page" : undefined}
            onClick={() => setActiveStudio("documents")}
          >
            Document Studio
          </button>
          {PLANNED_FUTURE_STUDIOS.map((studio) => {
            const tabId = studio.studioId as ActiveStudioId;
            const isActive = activeStudio === tabId;
            const descId = `studio-planned-desc-${studio.studioId}`;
            return (
              <div key={studio.studioId} className="studio-tab-wrap">
                <button
                  type="button"
                  className={`studio-tab studio-tab-gated ${isActive ? "active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                  aria-describedby={descId}
                  aria-description="Planned — Local Stage 1–3 engine verified; interactive studio UI planned for S2/S3"
                  title="Local Stage 1–3 engine verified; interactive studio UI planned for S2/S3"
                  onClick={() => setActiveStudio(tabId)}
                >
                  <span>{studioLabelMap[studio.studioId] ?? studio.studioId}</span>
                  <span className="studio-tab-tag" aria-hidden="true">
                    Planned
                  </span>
                </button>
                <span id={descId} className="visually-hidden">
                  Planned — Local Stage 1–3 engine verified; interactive studio UI planned for S2/S3
                </span>
              </div>
            );
          })}
        </nav>

        <div className="topbar-controls">
          <button
            type="button"
            className="btn mobile-nav-toggle"
            aria-expanded={mobileNavOpen}
            aria-controls="workspace-left-rail"
            onClick={() => setMobileNavOpen((v) => !v)}
          >
            {mobileNavOpen ? "Close Menu" : "Sections"}
          </button>
          <button
            type="button"
            className={`badge topbar-role-pill ${readOnly ? "is-readonly" : ""}`}
            title="Open Role & RBAC controls in Governance"
            onClick={() => {
              setOpenFixedHeader("admin");
              toggleSubPanel("admin_rbac");
              setMobileNavOpen(false);
            }}
          >
            Role: {effectiveRole}
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
        <div className={`workspace-shell ${docsDrawerOpen && activeStudio === "documents" ? "docs-drawer-open" : ""}`}>
          {/* Hidden DOCX file input triggered via Files & Docs -> Import DOCX */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            aria-label="Import DOCX file"
            className="visually-hidden"
            onChange={(e) => void handleDocxFileSelected(e)}
          />

          {/* Zone 2: Left Fixed-Header Rail with Animated Vertical Downward Sub-Header Dropdowns */}
          <LeftNavRail
            groups={navGroups}
            openHeaderId={openFixedHeader}
            onToggleHeader={setOpenFixedHeader}
            mobileOpen={mobileNavOpen}
          />

          {/* Optional Left Document Explorer (toggled via Files & Docs -> All Documents) */}
          {docsDrawerOpen && activeStudio === "documents" && (
            <aside className="sidebar" aria-label="Workspace Documents">
              <div className="panel-header-row">
                <strong className="sidebar-title">Documents ({totalDocs})</strong>
                <div className="row-actions-tight">
                  <button
                    type="button"
                    className="btn btn-compact"
                    disabled={isLoadingDocs}
                    onClick={() => void loadDocuments()}
                  >
                    {isLoadingDocs ? "..." : "Refresh"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-compact"
                    aria-label="Collapse documents drawer"
                    onClick={() => setDocsDrawerOpen(false)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="sidebar-filters">
                <input
                  type="search"
                  maxLength={120}
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
                    : 'No documents yet. Open "Files & Docs" on the left to create or seed a sample.'}
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

          {/* Zone 3: Center Workspace (Studio Canvas + Contextual Sub-Panels + Integrated AI & Voice Dock) */}
          <main className="center-workspace" aria-label="Center Workspace">
            <div ref={scrollStageRef} className="workspace-scroll-stage">
              <WorkspaceSubPanel
                panelId={activeSubPanel}
                onClose={() => setActiveSubPanel(null)}
                authMode={authMode}
                sessionActor={sessionActor}
                prototypeRole={prototypeRole}
                readOnly={readOnly}
                activeDoc={effectiveActiveDoc}
                apiHeaders={apiHeaders}
                onRoleChange={handlePrototypeRoleChange}
                onLogout={handleLogout}
                onLayoutChange={handleLayoutDraftChange}
                onLanguageChange={handleLanguageDraftChange}
                onUnauthorized={handleUnauthorized}
              />

              {activeStudio === "documents" ? (
                effectiveActiveDoc && activeDoc ? (
                  <>
                    <div className="doc-meta-bar" aria-label="Document Settings">
                      <input
                        type="text"
                        maxLength={200}
                        className="input-field"
                        disabled={readOnly}
                        aria-label="Document title"
                        title={readOnly ? titleReadOnlyTooltip : "Edit document title"}
                        value={effectiveActiveDoc.title}
                        onChange={(e) => handleTitleDraftChange(e.target.value)}
                      />
                      <span className="meta-caption">
                        Rev {effectiveActiveDoc.revision} · {effectiveActiveDoc.language} ·{" "}
                        {effectiveActiveDoc.layout.size} {effectiveActiveDoc.layout.orientation}
                      </span>
                      {readOnly && <span className="badge badge-readonly">Read-Only ({effectiveRole})</span>}
                      {isExporting && (
                        <span className="badge badge-warn" role="status">
                          {isExporting === "docx" ? "Exporting DOCX..." : "Rendering PDF..."}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn primary btn-compact"
                        disabled={readOnly || !hasUnsavedChanges || isSaving || !effectiveActiveDoc.title.trim()}
                        title={
                          readOnly
                            ? titleReadOnlyTooltip
                            : !effectiveActiveDoc.title.trim()
                              ? "Document title cannot be empty."
                              : !hasUnsavedChanges
                                ? "No unsaved changes to save."
                                : isSaving
                                  ? "Saving changes..."
                                  : "Save current changes (Ctrl+S / Cmd+S)"
                        }
                        onClick={() => void handleSave()}
                      >
                        {isSaving ? "Saving..." : `Save${hasUnsavedChanges ? " *" : ""}`}
                      </button>
                    </div>
                    <ErrorBoundary scopeLabel="Document Editor">
                      <DocumentEditor
                        key={activeDoc.documentId}
                        ref={editorRef}
                        document={effectiveActiveDoc}
                        tiptapContent={tiptapContent}
                        readOnly={readOnly}
                        effectiveRole={effectiveRole}
                        syncVersion={editorSyncVersion}
                        onDirtyChange={setEditorDirty}
                        onEditMutation={handleEditMutation}
                        onSelectionChange={handleSelectionChange}
                      />
                    </ErrorBoundary>
                  </>
                ) : (
                  <div className="preview-card welcome-card">
                    <strong>Welcome to AI Office Suite</strong>
                    <span>
                      Click <strong>Files &amp; Docs</strong> in the left fixed-header rail to create a blank document,
                      import a <code>.docx</code> file, or load the bilingual English &amp; Khmer report.
                    </span>
                  </div>
                )
              ) : (
                <div className="preview-card studio-engine-card">
                  <div className="panel-header-row">
                    <strong>
                      {activeStudio === "spreadsheets" && "Spreadsheet Studio (SS-00 Local Engine Verified · S2 UI Gated)"}
                      {activeStudio === "presentations" && "Presentation Studio (PS-00 Local Engine Verified · S3 UI Gated)"}
                      {activeStudio === "analytics" && "Intelligence Studio BI (BI-00 Local Engine Verified · S3 UI Gated)"}
                    </strong>
                    <span className="badge badge-warn">Engine Verified · UI Gated</span>
                  </div>
                  <p className="muted-text">
                    {activeStudio === "spreadsheets" &&
                      "Deterministic 19-function prototype evaluator, protected formula guards, exceljs XLSX round-trip, and OWASP CSV safety are verified in tests/d1-spreadsheet-feasibility.test.ts. Production grid selection (Univer vs Handsontable+HyperFormula) awaits TF-03 / APPROVAL-04."}
                    {activeStudio === "presentations" &&
                      "Canonical StudioPresentation model, pptxgenjs native OOXML export, speaker-note disclosure controls (RC-T03), keyboard delivery order (RC-T04), and HarfBuzz PDF rendering are verified in tests/g1-ps00-presentation-feasibility.test.ts. Interactive slide editor is scheduled for Milestone S3."}
                    {activeStudio === "analytics" &&
                      "Shared ChartSpec, Apache ECharts SSR visuals, DataScopePolicy row/column isolation, and FIN-POL-V1 cross-studio reconciliation ($150k Net Sales / $40k Operating Profit / 26.67% Margin) are verified in tests/g1-bi00-intelligence-feasibility.test.ts. Interactive BI canvas is scheduled for Milestone S3."}
                  </p>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => setActiveStudio("documents")}
                    >
                      Return to Document Studio
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setActiveSubPanel("certified_metrics")}
                    >
                      Inspect Certified FIN-POL-V1 Metrics
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Integrated AI & Voice Assistant Dock inside the Center Workspace */}
            {activeDoc && activeStudio === "documents" && (
              <AiVoicePanel
                variant="dock"
                defaultCompact={true}
                documentId={activeDoc.documentId}
                revision={activeDoc.revision}
                readOnly={readOnly}
                hasUnsavedChanges={hasUnsavedChanges}
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
          </main>
        </div>
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
        <Suspense fallback={<DrawerLoadingFallback onClose={handleCloseHistory} />}>
          <LazyVersionAuditDrawer
            versions={versions}
            auditEvents={auditEvents}
            currentRevision={activeDoc?.revision}
            initialSection={historySection}
            readOnly={readOnly}
            canReadAudit={canReadAudit}
            hasUnsavedChanges={hasUnsavedChanges}
            effectiveRole={effectiveRole}
            isLoading={isLoadingHistory}
            restoringRevision={restoringRevision}
            versionsTotal={versionsTotal}
            versionsHasMore={versionsHasMore}
            isLoadingMoreVersions={isLoadingMoreVersions}
            onLoadMoreVersions={() => void handleLoadMoreVersions()}
            auditTotal={auditTotal}
            auditHasMore={auditHasMore}
            isLoadingMoreAudit={isLoadingMoreAudit}
            onLoadMoreAudit={() => void handleLoadMoreAudit()}
            restoreFocusElRef={drawerTriggerElRef}
            onRestore={handleRestore}
            onCompareRevision={handleCompareRevision}
            onClose={handleCloseHistory}
          />
        </Suspense>
      )}
    </div>
  );
}
