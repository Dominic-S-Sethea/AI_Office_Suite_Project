import { useEffect, useState } from "react";
import type { AuditEvent, DocumentVersion } from "@ai-office-suite/shared-contracts";

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
    unchanged: number;
  };
  blocks: Array<{
    blockId: string;
    blockType: string;
    changeType: "added" | "removed" | "modified";
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

export function VersionAuditDrawer({
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleCompare(fromRev: number) {
    if (!onCompareRevision || currentRevision === undefined) return;
    setDiffLoadingRev(fromRev);
    try {
      const diff = await onCompareRevision(fromRev, currentRevision);
      setDiffResult(diff);
    } finally {
      setDiffLoadingRev(null);
    }
  }

  return (
    <div
      className="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Version and Audit History"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="drawer-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Version &amp; Audit History</h3>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {diffResult && (
          <section className="diff-card" aria-label="Revision Diff Summary">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>
                Diff: Rev {diffResult.fromRevision} → Rev {diffResult.toRevision}
              </strong>
              <button type="button" className="btn" onClick={() => setDiffResult(null)}>
                Clear Diff
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#475569" }}>
              +{diffResult.summary.added} added · -{diffResult.summary.removed} removed · ~{diffResult.summary.modified}{" "}
              modified · {diffResult.summary.unchanged} unchanged
              {diffResult.metadataChanged.titleChanged ? " · Title changed" : ""}
              {diffResult.metadataChanged.layoutChanged ? " · Layout changed" : ""}
            </div>
            {diffResult.blocks.length === 0 ? (
              <div style={{ fontSize: 12, color: "#64748b" }}>No block content changes between these revisions.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                {diffResult.blocks.map((b) => (
                  <div key={`${b.blockId}-${b.changeType}`} className={`diff-row diff-${b.changeType}`}>
                    <div style={{ fontWeight: 600, fontSize: 11 }}>
                      [{b.changeType.toUpperCase()}] {b.blockType} ({b.blockId})
                    </div>
                    {b.beforeText !== undefined && (
                      <div style={{ color: "#991b1b" }}>- {b.beforeText || "(empty)"}</div>
                    )}
                    {b.afterText !== undefined && (
                      <div style={{ color: "#166534" }}>+ {b.afterText || "(empty)"}</div>
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
              <h4 style={{ margin: "0 0 8px 0" }}>Immutable Versions ({versions.length})</h4>
              {versions.length === 0 ? (
                <div className="preview-card" style={{ color: "#64748b" }}>
                  No saved revisions recorded for this document yet.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {[...versions].reverse().map((v) => {
                    const isCurrent = currentRevision !== undefined && v.revision === currentRevision;
                    const isRestoringThis = restoringRevision === v.revision;
                    const isDiffLoading = diffLoadingRev === v.revision;
                    return (
                      <div key={v.versionId} className="preview-card">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                          <strong>
                            Revision {v.revision} ({v.source})
                          </strong>
                          {isCurrent ? (
                            <span className="badge badge-ok">Current</span>
                          ) : (
                            <div style={{ display: "flex", gap: 4 }}>
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
                        <div style={{ fontSize: 11, color: "#64748b" }}>
                          Actor: {v.actorId} · {new Date(v.createdAt).toLocaleString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <h4 style={{ margin: "0 0 8px 0" }}>Append-Only Audit Log ({auditEvents.length})</h4>
              {auditEvents.length === 0 ? (
                <div className="preview-card" style={{ color: "#64748b" }}>
                  No audit events recorded for this document yet.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {auditEvents.map((ev) => {
                    const badgeClass =
                      ev.outcome === "success"
                        ? "badge badge-ok"
                        : ev.outcome === "denied"
                          ? "badge badge-danger"
                          : "badge badge-warn";
                    return (
                      <div key={ev.auditId} className="preview-card">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <strong>{ev.action}</strong>
                          <span className={badgeClass}>{ev.outcome}</span>
                        </div>
                        <div>{ev.summary}</div>
                        <div style={{ fontSize: 11, color: "#64748b" }}>
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
