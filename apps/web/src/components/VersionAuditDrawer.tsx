import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AuditEvent, DocumentVersion, WorkspaceRole } from "@ai-office-suite/shared-contracts";
import { trapDialogTabKey } from "../lib/apiClient.ts";

export interface RevisionDiffPayload {
  documentId: string;
  fromRevision: number;
  toRevision: number;
  metadataChanged: {
    titleChanged: boolean;
    languageChanged: boolean;
    layoutChanged: boolean;
  };
  summary: {
    added: number;
    removed: number;
    modified: number;
    moved?: number;
    unchanged: number;
  };
  blocks: Array<{
    blockId: string;
    blockType: string;
    changeType: "added" | "removed" | "modified" | "moved";
    beforeText?: string;
    afterText?: string;
  }>;
}

export type HistorySectionTab = "all" | "versions" | "diff" | "audit";

const HISTORY_TABS: ReadonlyArray<readonly [HistorySectionTab, string]> = [
  ["all", "All"],
  ["versions", "Versions"],
  ["diff", "Revision Diff"],
  ["audit", "Audit Trail"],
];

function getDrawerReadOnlyMessage(role?: WorkspaceRole): string {
  if (role === "reviewer") {
    return "Read-only role (Reviewer): Restoring revisions is disabled. You can inspect immutable versions, compare diffs, and review the audit trail.";
  }
  if (role === "viewer") {
    return "Read-only role (Viewer): Restoring revisions, exporting, and reading the audit log (audit:read) are disabled. You can inspect immutable versions and compare revision diffs.";
  }
  return "Read-only role active: Restoring revisions is disabled for your current role.";
}

interface VersionAuditDrawerProps {
  versions: DocumentVersion[];
  auditEvents: AuditEvent[];
  currentRevision?: number;
  initialSection?: HistorySectionTab;
  readOnly: boolean;
  canReadAudit?: boolean;
  hasUnsavedChanges?: boolean;
  effectiveRole?: WorkspaceRole;
  isLoading?: boolean;
  restoringRevision?: number | null;
  versionsTotal?: number;
  versionsHasMore?: boolean;
  isLoadingMoreVersions?: boolean;
  onLoadMoreVersions?: () => void;
  auditTotal?: number;
  auditHasMore?: boolean;
  isLoadingMoreAudit?: boolean;
  onLoadMoreAudit?: () => void;
  restoreFocusElRef?: { current: HTMLElement | null };
  onRestore: (revision: number) => Promise<void>;
  onCompareRevision?: (fromRevision: number, toRevision: number) => Promise<RevisionDiffPayload | null>;
  onClose: () => void;
}

function VersionAuditDrawerInner({
  versions,
  auditEvents,
  currentRevision,
  initialSection = "all",
  readOnly,
  canReadAudit = true,
  hasUnsavedChanges = false,
  effectiveRole,
  isLoading = false,
  restoringRevision = null,
  versionsTotal,
  versionsHasMore = false,
  isLoadingMoreVersions = false,
  onLoadMoreVersions,
  auditTotal,
  auditHasMore = false,
  isLoadingMoreAudit = false,
  onLoadMoreAudit,
  restoreFocusElRef,
  onRestore,
  onCompareRevision,
  onClose,
}: VersionAuditDrawerProps) {
  const [activeTab, setActiveTab] = useState<HistorySectionTab>(initialSection);
  const [diffResult, setDiffResult] = useState<RevisionDiffPayload | null>(null);
  const [diffLoadingRev, setDiffLoadingRev] = useState<number | null>(null);
  const [confirmRestoreRev, setConfirmRestoreRev] = useState<number | null>(null);
  const confirmRestoreRevRef = useRef<number | null>(null);
  confirmRestoreRevRef.current = confirmRestoreRev;

  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef<Record<HistorySectionTab, HTMLButtonElement | null>>({
    all: null,
    versions: null,
    diff: null,
    audit: null,
  });
  const compareSeqRef = useRef(0);

  useEffect(() => {
    setActiveTab(initialSection);
  }, [initialSection]);

  useEffect(() => {
    compareSeqRef.current += 1;
    setConfirmRestoreRev(null);
    setDiffResult(null);
    setDiffLoadingRev(null);
  }, [readOnly, currentRevision]);

  useEffect(() => {
    const previouslyFocused =
      restoreFocusElRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (confirmRestoreRevRef.current !== null) {
          setConfirmRestoreRev(null);
          return;
        }
        onClose();
        return;
      }
      trapDialogTabKey(drawerRef.current, e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const focusTarget = restoreFocusElRef?.current ?? previouslyFocused;
      if (restoreFocusElRef) restoreFocusElRef.current = null;
      if (
        focusTarget &&
        document.contains(focusTarget) &&
        focusTarget.tabIndex >= 0 &&
        focusTarget.offsetParent !== null &&
        !(focusTarget as HTMLButtonElement).disabled
      ) {
        focusTarget.focus();
      } else {
        document.querySelector<HTMLElement>(".fixed-header-btn, .topbar-role-pill, main button")?.focus();
      }
    };
  }, [onClose, restoreFocusElRef]);

  function handleTabListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const currentIdx = HISTORY_TABS.findIndex(([id]) => id === activeTab);
    if (currentIdx === -1) return;

    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") {
      nextIdx = (currentIdx + 1) % HISTORY_TABS.length;
    } else if (e.key === "ArrowLeft") {
      nextIdx = (currentIdx - 1 + HISTORY_TABS.length) % HISTORY_TABS.length;
    } else if (e.key === "Home") {
      nextIdx = 0;
    } else if (e.key === "End") {
      nextIdx = HISTORY_TABS.length - 1;
    }

    if (nextIdx !== null) {
      e.preventDefault();
      const nextTab = HISTORY_TABS[nextIdx]![0];
      setActiveTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  }

  async function handleCompare(fromRev: number) {
    if (!onCompareRevision || currentRevision === undefined) return;
    const seq = ++compareSeqRef.current;
    setDiffLoadingRev(fromRev);
    try {
      const diff = await onCompareRevision(fromRev, currentRevision);
      if (seq === compareSeqRef.current) {
        setDiffResult(diff);
      }
    } finally {
      if (seq === compareSeqRef.current) {
        setDiffLoadingRev(null);
      }
    }
  }

  const readOnlyMessage = getDrawerReadOnlyMessage(effectiveRole);
  const showVersions = activeTab === "all" || activeTab === "versions" || activeTab === "diff";
  const showAudit = activeTab === "all" || activeTab === "audit";

  return (
    <div
      className="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-history-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={drawerRef} className="drawer-panel">
        <div className="panel-header-row">
          <h2 id="drawer-history-title" className="modal-title">
            Version &amp; Audit History
          </h2>
          <button ref={closeBtnRef} type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div
          className="drawer-tab-bar"
          role="tablist"
          aria-label="History view filter"
          onKeyDown={handleTabListKeyDown}
        >
          {HISTORY_TABS.map(([tabId, label]) => (
            <button
              key={tabId}
              id={`history-tab-${tabId}`}
              ref={(el) => {
                tabRefs.current[tabId] = el;
              }}
              type="button"
              role="tab"
              aria-selected={activeTab === tabId}
              aria-controls="history-tabpanel"
              tabIndex={activeTab === tabId ? 0 : -1}
              className={`btn btn-compact ${activeTab === tabId ? "active" : ""}`}
              onClick={() => setActiveTab(tabId)}
            >
              {label}
            </button>
          ))}
        </div>

        {readOnly && (
          <div id="drawer-readonly-notice" className="notice-readonly" role="status">
            {readOnlyMessage}
          </div>
        )}

        <div
          id="history-tabpanel"
          role="tabpanel"
          aria-labelledby={`history-tab-${activeTab}`}
          className="drawer-tabpanel"
        >
          {activeTab === "diff" && !diffResult && !isLoading && (
            <div className="preview-card muted-text">
              {versions.length < 2
                ? "Save a second revision to compare changes between revisions."
                : "Click Diff on any prior revision below to inspect block-level English/Khmer changes."}
            </div>
          )}

          {diffResult && (
            <section className="diff-card" aria-label="Revision Diff Summary">
              <div className="panel-header-row">
                <strong>
                  Diff: Rev {diffResult.fromRevision} → Rev {diffResult.toRevision}
                </strong>
                <button type="button" className="btn" onClick={() => setDiffResult(null)}>
                  Clear Diff
                </button>
              </div>
              <div className="meta-caption">
                +{diffResult.summary.added} added · -{diffResult.summary.removed} removed · ~{diffResult.summary.modified}{" "}
                modified
                {typeof diffResult.summary.moved === "number" && diffResult.summary.moved > 0
                  ? ` · ↕${diffResult.summary.moved} moved`
                  : ""}{" "}
                · {diffResult.summary.unchanged} unchanged
                {diffResult.metadataChanged.titleChanged ? " · Title changed" : ""}
                {diffResult.metadataChanged.languageChanged ? " · Language changed" : ""}
                {diffResult.metadataChanged.layoutChanged ? " · Layout changed" : ""}
              </div>
              {diffResult.blocks.length === 0 ? (
                <div className="muted-text">No block content changes between these revisions.</div>
              ) : (
                <div className="diff-list">
                  {diffResult.blocks.map((b) => (
                    <div key={`${b.blockId}-${b.changeType}`} className={`diff-row diff-${b.changeType}`}>
                      <div className="diff-row-header">
                        [{b.changeType.toUpperCase()}] {b.blockType} ({b.blockId})
                      </div>
                      {b.beforeText !== undefined && (
                        <div className="diff-before">- {b.beforeText || "(empty)"}</div>
                      )}
                      {b.afterText !== undefined && (
                        <div className="diff-after">+ {b.afterText || "(empty)"}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {isLoading ? (
            <div className="preview-card" role="status">
              Loading immutable version history and audit trail...
            </div>
          ) : (
            <>
              {showVersions && (
                <section>
                  <h3 className="drawer-section-heading">
                    Immutable Versions (
                    {versionsTotal !== undefined && versionsTotal > versions.length
                      ? `${versions.length} of ${versionsTotal}`
                      : versions.length}
                    )
                  </h3>
                  {versions.length === 0 ? (
                    <div className="preview-card muted-text">
                      No saved revisions recorded for this document yet.
                    </div>
                  ) : (
                    <div className="stack-sm">
                      {[...versions]
                        .sort((a, b) => b.revision - a.revision)
                        .map((v) => {
                        const isCurrent = currentRevision !== undefined && v.revision === currentRevision;
                        const isRestoringThis = restoringRevision === v.revision;
                        const isDiffLoading = diffLoadingRev === v.revision;
                        const isConfirming = !isCurrent && !readOnly && confirmRestoreRev === v.revision;
                        return (
                          <div key={v.versionId} className="preview-card">
                            <div className="panel-header-row">
                              <strong>
                                Revision {v.revision} ({v.source})
                              </strong>
                              {isCurrent ? (
                                <span className="badge badge-ok">Current</span>
                              ) : (
                                <div className="row-actions-tight">
                                  {onCompareRevision && currentRevision !== undefined && (
                                    <button
                                      type="button"
                                      className="btn"
                                      disabled={isDiffLoading}
                                      onClick={() => void handleCompare(v.revision)}
                                    >
                                      {isDiffLoading ? "Diffing..." : "Diff"}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={readOnly || restoringRevision !== null}
                                    aria-describedby={readOnly ? "drawer-readonly-notice" : undefined}
                                    aria-expanded={!readOnly ? isConfirming : undefined}
                                    title={readOnly ? readOnlyMessage : `Restore revision ${v.revision} as a new revision`}
                                    onClick={() => setConfirmRestoreRev(v.revision)}
                                  >
                                    {isRestoringThis ? "Restoring..." : "Restore"}
                                  </button>
                                </div>
                              )}
                            </div>
                            {isConfirming && (
                              <div
                                className="restore-confirm-box"
                                role="region"
                                aria-label={`Confirm restore revision ${v.revision}`}
                              >
                                <div className="stack-xs">
                                  <span>
                                    Restore <strong>Revision {v.revision}</strong> as a new non-destructive head
                                    revision?
                                  </span>
                                  {hasUnsavedChanges && (
                                    <strong className="restore-unsaved-warning">
                                      Unsaved edits on the current document will be discarded.
                                    </strong>
                                  )}
                                </div>
                                <div className="row-actions-tight">
                                  <button
                                    type="button"
                                    className="btn btn-danger"
                                    disabled={restoringRevision !== null}
                                    onClick={() => {
                                      void (async () => {
                                        await onRestore(v.revision);
                                        setConfirmRestoreRev(null);
                                      })();
                                    }}
                                  >
                                    {isRestoringThis ? "Restoring..." : "Confirm Restore"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={restoringRevision !== null}
                                    onClick={() => setConfirmRestoreRev(null)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            <div>{v.summary}</div>
                            <div className="meta-caption">
                              Actor: {v.actorId} · {new Date(v.createdAt).toLocaleString()}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {versionsHasMore && onLoadMoreVersions && (
                    <div className="row-actions" style={{ marginTop: "8px" }}>
                      <span className="meta-caption">
                        Showing newest {versions.length}
                        {versionsTotal !== undefined ? ` of ${versionsTotal}` : ""} revisions.
                      </span>
                      <button
                        type="button"
                        className="btn btn-compact"
                        disabled={isLoadingMoreVersions}
                        onClick={onLoadMoreVersions}
                      >
                        {isLoadingMoreVersions ? "Loading..." : "Load older revisions"}
                      </button>
                    </div>
                  )}
                </section>
              )}

              {showAudit && (
                <section>
                  <h3 className="drawer-section-heading">
                    Append-Only Audit Log (
                    {auditTotal !== undefined && auditTotal > auditEvents.length
                      ? `${auditEvents.length} of ${auditTotal}`
                      : auditEvents.length}
                    )
                  </h3>
                  {!canReadAudit ? (
                    <div className="notice-readonly" role="status">
                      Audit log inspection requires Reviewer, Editor, Auditor, or Owner permission (<code>audit:read</code>).
                    </div>
                  ) : auditEvents.length === 0 ? (
                    <div className="preview-card muted-text">
                      No audit events recorded for this document yet.
                    </div>
                  ) : (
                    <div className="stack-sm">
                      {auditEvents.map((ev) => {
                        const badgeClass =
                          ev.outcome === "success"
                            ? "badge badge-ok"
                            : ev.outcome === "denied"
                              ? "badge badge-danger"
                              : "badge badge-warn";
                        return (
                          <div key={ev.auditId} className="preview-card">
                            <div className="panel-header-row">
                              <strong>{ev.action}</strong>
                              <span className={badgeClass}>{ev.outcome}</span>
                            </div>
                            <div>{ev.summary}</div>
                            <div className="meta-caption">
                              {ev.actorId} ({ev.actorRole}) · {ev.source} · {new Date(ev.createdAt).toLocaleTimeString()}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {auditHasMore && onLoadMoreAudit && (
                    <div className="row-actions" style={{ marginTop: "8px" }}>
                      <span className="meta-caption">
                        Showing newest {auditEvents.length}
                        {auditTotal !== undefined ? ` of ${auditTotal}` : ""} events.
                      </span>
                      <button
                        type="button"
                        className="btn btn-compact"
                        disabled={isLoadingMoreAudit}
                        onClick={onLoadMoreAudit}
                      >
                        {isLoadingMoreAudit ? "Loading..." : "Load older events"}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const VersionAuditDrawer = memo(VersionAuditDrawerInner);
export default VersionAuditDrawer;
