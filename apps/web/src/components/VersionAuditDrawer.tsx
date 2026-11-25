import { useEffect } from "react";
import type { AuditEvent, DocumentVersion } from "@ai-office-suite/shared-contracts";

interface VersionAuditDrawerProps {
  versions: DocumentVersion[];
  auditEvents: AuditEvent[];
  currentRevision?: number;
  readOnly: boolean;
  isLoading?: boolean;
  restoringRevision?: number | null;
  onRestore: (revision: number) => Promise<void>;
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
  onClose,
}: VersionAuditDrawerProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
                    return (
                      <div key={v.versionId} className="preview-card">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <strong>
                            Revision {v.revision} ({v.source})
                          </strong>
                          {isCurrent ? (
                            <span className="badge badge-ok">Current</span>
                          ) : (
                            <button
                              type="button"
                              className="btn"
                              disabled={readOnly || restoringRevision !== null}
                              onClick={() => void onRestore(v.revision)}
                            >
                              {isRestoringThis ? "Restoring..." : "Restore as New Rev"}
                            </button>
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
