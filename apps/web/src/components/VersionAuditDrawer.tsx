import { memo, useEffect, useRef, useState } from "react";
import type { AuditEvent, DocumentVersion } from "@ai-office-suite/shared-contracts";
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

interface VersionAuditDrawerProps {
  versions: DocumentVersion[];
  auditEvents: AuditEvent[];
  currentRevision?: number;
  readOnly: boolean;
  isLoading?: boolean;
  restoringRevision?: number | null;
  onRestore: (revision: number) => Promise<void>;
  onCompareRevision?: (fromRevision: number, toRevision: number) => Promise<RevisionDiffPayload | null>;
  onClose: () => void;
}

function VersionAuditDrawerInner({
  versions,
  auditEvents,
  currentRevision,
  readOnly,
  isLoading = false,
  restoringRevision = null,
  onRestore,
  onCompareRevision,
  onClose,
}: VersionAuditDrawerProps) {
  const [diffResult, setDiffResult] = useState<RevisionDiffPayload | null>(null);
  const [diffLoadingRev, setDiffLoadingRev] = useState<number | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const compareSeqRef = useRef(0);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      trapDialogTabKey(drawerRef.current, e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

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
            <section>
              <h3 className="drawer-section-heading">Immutable Versions ({versions.length})</h3>
              {versions.length === 0 ? (
                <div className="preview-card muted-text">
                  No saved revisions recorded for this document yet.
                </div>
              ) : (
                <div className="stack-sm">
                  {[...versions].reverse().map((v) => {
                    const isCurrent = currentRevision !== undefined && v.revision === currentRevision;
                    const isRestoringThis = restoringRevision === v.revision;
                    const isDiffLoading = diffLoadingRev === v.revision;
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
                                onClick={() => void onRestore(v.revision)}
                              >
                                {isRestoringThis ? "Restoring..." : "Restore"}
                              </button>
                            </div>
                          )}
                        </div>
                        <div>{v.summary}</div>
                        <div className="meta-caption">
                          Actor: {v.actorId} · {new Date(v.createdAt).toLocaleString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <h3 className="drawer-section-heading">Append-Only Audit Log ({auditEvents.length})</h3>
              {auditEvents.length === 0 ? (
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
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export const VersionAuditDrawer = memo(VersionAuditDrawerInner);
export default VersionAuditDrawer;
