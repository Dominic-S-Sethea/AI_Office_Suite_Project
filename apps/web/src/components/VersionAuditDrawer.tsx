import type { AuditEvent, DocumentVersion } from "@ai-office-suite/shared-contracts";

interface VersionAuditDrawerProps {
  versions: DocumentVersion[];
  auditEvents: AuditEvent[];
  readOnly: boolean;
  onRestore: (revision: number) => Promise<void>;
  onClose: () => void;
}

export function VersionAuditDrawer({
  versions,
  auditEvents,
  readOnly,
  onRestore,
  onClose,
}: VersionAuditDrawerProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.4)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 40,
      }}
    >
      <div
        style={{
          width: 480,
          background: "#ffffff",
          height: "100%",
          padding: 18,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Version &amp; Audit History</h3>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <section>
          <h4 style={{ margin: "0 0 8px 0" }}>Immutable Versions ({versions.length})</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[...versions].reverse().map((v) => (
              <div key={v.versionId} className="preview-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>Revision {v.revision} ({v.source})</strong>
                  <button
                    type="button"
                    className="btn"
                    disabled={readOnly}
                    onClick={() => onRestore(v.revision)}
                  >
                    Restore as New Rev
                  </button>
                </div>
                <div>{v.summary}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  Actor: {v.actorId} · {new Date(v.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h4 style={{ margin: "0 0 8px 0" }}>Append-Only Audit Log ({auditEvents.length})</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {auditEvents.map((ev) => (
              <div key={ev.auditId} className="preview-card">
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{ev.action}</strong>
                  <span className="badge">{ev.outcome}</span>
                </div>
                <div>{ev.summary}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  {ev.actorId} ({ev.actorRole}) · {ev.source} · {new Date(ev.createdAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
