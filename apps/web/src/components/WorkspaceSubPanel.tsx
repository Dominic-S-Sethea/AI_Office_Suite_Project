import { memo, useEffect, useRef, useState } from "react";
import type { ActorContext, PageLayoutConfig, StudioDocument, WorkspaceRole } from "@ai-office-suite/shared-contracts";
import { formatApiErrorMessage, safeReadJson } from "../lib/apiClient.ts";

export type WorkspaceUtilityPanelId =
  | null
  | "page_size"
  | "page_fonts"
  | "linked_metrics"
  | "data_prep"
  | "certified_metrics"
  | "duckdb_spill"
  | "workflow_links"
  | "workflow_packages"
  | "workflow_outbox"
  | "backup_restore"
  | "admin_rbac"
  | "admin_policies"
  | "admin_quotas"
  | "admin_health";

interface WorkspaceSubPanelProps {
  panelId: WorkspaceUtilityPanelId;
  onClose: () => void;
  authMode: "provisional-local" | "jwt-pg";
  sessionActor: ActorContext | null;
  prototypeRole: WorkspaceRole;
  readOnly: boolean;
  activeDoc: StudioDocument | null;
  apiHeaders: Record<string, string>;
  onRoleChange: (role: WorkspaceRole) => void;
  onLogout: (revokeAll: boolean) => Promise<void>;
  onLayoutChange: (layout: PageLayoutConfig) => void;
  onLanguageChange: (lang: StudioDocument["language"]) => void;
}

const SAMPLE_STAGE_CSV = [
  "org_id,invoice_id,line_no,department,amount",
  "ORG1,INV-001,1,Sales,80000",
  "ORG1,INV-002,1,Services,45000",
  "ORG1,INV-003,1,Operations,25000",
  "ORG1,INV-004,1,Operations,",
].join("\n");

const PANEL_TITLES: Record<Exclude<WorkspaceUtilityPanelId, null>, string> = {
  page_size: "Page & Style · Page Size & Paper Layout",
  page_fonts: "Page & Style · Khmer Typography, Headers & Footers",
  linked_metrics: "Page & Style · Linked Certified Metrics",
  data_prep: "Data Preparation · Stage & Profile (/api/data-prep/stage-and-profile)",
  certified_metrics: "Business Analysis · Certified FIN-POL-V1 Metrics",
  duckdb_spill: "Data & Analytics · DuckDB 1,000,000-Row Spill Benchmark (TF-04)",
  workflow_links: "Workflows · One-Way Linked Objects Registry (XI-00)",
  workflow_packages: "Workflows · Reporting Packages & SHA-256 Approval (XI-00)",
  workflow_outbox: "Workflows · Atomic PostgreSQL RLS Outbox (xi_outbox_events)",
  backup_restore: "Versions & Audit · Backup & Restore Governance Parity (R-28 / PLT-T35)",
  admin_rbac: "Admin & Governance · Role Switcher, 8-Role RBAC & PG16 RLS",
  admin_policies: "Admin & Governance · AI & Voice Policy Gates (HTTP 423)",
  admin_quotas: "Admin & Governance · Subscription Quotas & Fenced Jobs (PA-00)",
  admin_health: "Admin & Governance · Session & Operational Health",
};

const PANEL_PROVENANCE: Record<
  Exclude<WorkspaceUtilityPanelId, null>,
  { label: string; tone: "ok" | "neutral" }
> = {
  page_size: { label: "Live Controls", tone: "ok" },
  page_fonts: { label: "Live Controls", tone: "ok" },
  linked_metrics: { label: "Reference Benchmark", tone: "neutral" },
  data_prep: { label: "Live API", tone: "ok" },
  certified_metrics: { label: "Reference Benchmark", tone: "neutral" },
  duckdb_spill: { label: "Reference Benchmark", tone: "neutral" },
  workflow_links: { label: "Reference Benchmark", tone: "neutral" },
  workflow_packages: { label: "Reference Benchmark", tone: "neutral" },
  workflow_outbox: { label: "Reference Benchmark", tone: "neutral" },
  backup_restore: { label: "Reference Benchmark", tone: "neutral" },
  admin_rbac: { label: "Live Controls", tone: "ok" },
  admin_policies: { label: "Reference Benchmark", tone: "neutral" },
  admin_quotas: { label: "Reference Benchmark", tone: "neutral" },
  admin_health: { label: "Live API", tone: "ok" },
};

function WorkspaceSubPanelInner({
  panelId,
  onClose,
  authMode,
  sessionActor,
  prototypeRole,
  readOnly,
  activeDoc,
  apiHeaders,
  onRoleChange,
  onLogout,
  onLayoutChange,
  onLanguageChange,
}: WorkspaceSubPanelProps) {
  const [csvText, setCsvText] = useState(SAMPLE_STAGE_CSV);
  const [profileResult, setProfileResult] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isProfiling, setIsProfiling] = useState(false);

  const [healthText, setHealthText] = useState<string | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  const profileAbortRef = useRef<AbortController | null>(null);
  const profileSeqRef = useRef(0);
  const healthAbortRef = useRef<AbortController | null>(null);
  const healthSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      profileAbortRef.current?.abort();
      healthAbortRef.current?.abort();
      profileSeqRef.current += 1;
      healthSeqRef.current += 1;
      setIsProfiling(false);
      setIsCheckingHealth(false);
    };
  }, [panelId]);

  if (!panelId) return null;

  async function runStageAndProfile() {
    profileAbortRef.current?.abort();
    const controller = new AbortController();
    profileAbortRef.current = controller;
    const seq = ++profileSeqRef.current;

    setIsProfiling(true);
    setProfileError(null);
    setProfileResult(null);
    try {
      const res = await fetch("/api/data-prep/stage-and-profile", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        signal: controller.signal,
        body: JSON.stringify({
          filename: "november-2026.csv",
          csvText,
          profileScope: "full",
        }),
      });
      if (seq !== profileSeqRef.current) return;
      const data = await safeReadJson(res);
      if (seq !== profileSeqRef.current) return;
      if (!res.ok) {
        setProfileError(formatApiErrorMessage(res, data, "Data preparation profiling failed"));
        return;
      }
      setProfileResult(JSON.stringify(data.profile ?? data, null, 2));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (seq === profileSeqRef.current) {
        setProfileError("Unable to contact /api/data-prep/stage-and-profile.");
      }
    } finally {
      if (seq === profileSeqRef.current) {
        setIsProfiling(false);
      }
    }
  }

  async function checkHealthSnapshot() {
    healthAbortRef.current?.abort();
    const controller = new AbortController();
    healthAbortRef.current = controller;
    const seq = ++healthSeqRef.current;

    setIsCheckingHealth(true);
    try {
      const res = await fetch("/api/health", { credentials: "include", signal: controller.signal });
      if (seq !== healthSeqRef.current) return;
      const data = await safeReadJson(res);
      if (seq !== healthSeqRef.current) return;
      setHealthText(JSON.stringify(data, null, 2));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (seq === healthSeqRef.current) {
        setHealthText("Unable to fetch /api/health.");
      }
    } finally {
      if (seq === healthSeqRef.current) {
        setIsCheckingHealth(false);
      }
    }
  }

  return (
    <section className="workspace-subpanel" aria-label="Contextual Workspace Panel">
      <div className="panel-header-row">
        <div className="row-actions wrap">
          <strong className="subpanel-title">{PANEL_TITLES[panelId]}</strong>
          <span
            className={`badge ${PANEL_PROVENANCE[panelId].tone === "ok" ? "badge-ok" : "badge-neutral"}`}
          >
            {PANEL_PROVENANCE[panelId].label}
          </span>
        </div>
        <button type="button" className="btn btn-compact" onClick={onClose}>
          Close Panel
        </button>
      </div>

      {panelId === "page_size" &&
        (activeDoc ? (
          <div className="subpanel-grid">
            <label className="field-label">
              Page Size
              <select
                className="select-control"
                disabled={readOnly}
                aria-label="Subpanel page size"
                title={readOnly ? "Read-only role cannot modify page setup." : undefined}
                value={activeDoc.layout.size}
                onChange={(e) =>
                  onLayoutChange({ ...activeDoc.layout, size: e.target.value as "A4" | "Letter" })
                }
              >
                <option value="A4">A4 (210 × 297 mm)</option>
                <option value="Letter">Letter (8.5 × 11 in)</option>
              </select>
            </label>
            <label className="field-label">
              Orientation
              <select
                className="select-control"
                disabled={readOnly}
                aria-label="Subpanel orientation"
                title={readOnly ? "Read-only role cannot modify page orientation." : undefined}
                value={activeDoc.layout.orientation}
                onChange={(e) =>
                  onLayoutChange({
                    ...activeDoc.layout,
                    orientation: e.target.value as "portrait" | "landscape",
                  })
                }
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <div className="kpi-mini-card">
              <span className="meta-caption">Print Margins</span>
              <strong>20 mm uniform</strong>
              <span className="meta-caption">Paginated on HarfBuzz PDF export</span>
            </div>
          </div>
        ) : (
          <div className="muted-text">Select or create a document first to adjust page setup.</div>
        ))}

      {panelId === "page_fonts" &&
        (activeDoc ? (
          <div className="subpanel-grid">
            <label className="field-label">
              Document Language
              <select
                className="select-control"
                disabled={readOnly}
                aria-label="Subpanel document language"
                title={readOnly ? "Read-only role cannot modify document language." : undefined}
                value={activeDoc.language}
                onChange={(e) => onLanguageChange(e.target.value as StudioDocument["language"])}
              >
                <option value="bilingual">Bilingual (EN / ខ្មែរ)</option>
                <option value="en">English</option>
                <option value="km">ខ្មែរ (Khmer)</option>
              </select>
            </label>
            <label className="field-label">
              Header Text
              <input
                type="text"
                maxLength={300}
                className="input-field input-compact"
                disabled={readOnly}
                title={readOnly ? "Read-only role cannot edit header text." : undefined}
                value={activeDoc.layout.headerText}
                onChange={(e) => onLayoutChange({ ...activeDoc.layout, headerText: e.target.value })}
              />
            </label>
            <label className="field-label">
              Footer Text
              <input
                type="text"
                maxLength={300}
                className="input-field input-compact"
                disabled={readOnly}
                title={readOnly ? "Read-only role cannot edit footer text." : undefined}
                value={activeDoc.layout.footerText}
                onChange={(e) => onLayoutChange({ ...activeDoc.layout, footerText: e.target.value })}
              />
            </label>
            <div className="kpi-mini-card">
              <span className="meta-caption">Khmer Font Shaping</span>
              <strong>Noto Sans Khmer / Kantumruy Pro</strong>
              <span className="meta-caption">w:cs DOCX + HarfBuzz PDF active</span>
            </div>
          </div>
        ) : (
          <div className="muted-text">Select or create a document first to customize headers and typography.</div>
        ))}

      {panelId === "linked_metrics" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Linked Snapshot Source</span>
            <strong>published_snapshot</strong>
            <span className="meta-caption">Read-only certified value pill</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Net Operating Profit</span>
            <strong>$38,500.00</strong>
            <span className="meta-caption">Reconciled with FIN-POL-V1</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Mutation Policy</span>
            <strong>HTTP 409 Protected</strong>
            <span className="meta-caption">Must detach before manual overwrite</span>
          </div>
        </div>
      )}

      {panelId === "data_prep" && (
        <div className="stack-sm">
          <p className="muted-text">
            Calls live backend <code>POST /api/data-prep/stage-and-profile</code> (RFC 4180 CSV staging, null≠0 preservation,
            invalid/duplicate detection).
          </p>
          <textarea
            rows={4}
            className="input-field command-textarea"
            aria-label="CSV input for staging and profiling"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <div className="row-actions">
            <button
              type="button"
              className="btn primary"
              disabled={readOnly || isProfiling}
              title={
                readOnly
                  ? "Read-only role cannot run staging mutations."
                  : "Stage and profile CSV via live backend API"
              }
              onClick={() => void runStageAndProfile()}
            >
              {isProfiling ? "Profiling..." : "Run Stage & Profile"}
            </button>
          </div>
          {profileError && (
            <div className="banner-error" role="alert">
              {profileError}
            </div>
          )}
          {profileResult && <pre className="subpanel-code">{profileResult}</pre>}
        </div>
      )}

      {panelId === "certified_metrics" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Net Sales (FIN-POL-V1)</span>
            <strong>$150,000.00</strong>
            <span className="meta-caption">+20.00% vs Prior</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Operating Profit</span>
            <strong>$40,000.00</strong>
            <span className="meta-caption">Exact BigInt Minor Units</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Operating Margin</span>
            <strong>26.67%</strong>
            <span className="meta-caption">Ratio-of-Totals Certified</span>
          </div>
        </div>
      )}

      {panelId === "duckdb_spill" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Dataset Volume (TF-04)</span>
            <strong>1,000,000 rows</strong>
            <span className="meta-caption">Full aggregate + department group</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Memory Cap</span>
            <strong>256 MB strict</strong>
            <span className="meta-caption">Disk spill temp_directory verified</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Measured Latency</span>
            <strong>~605 ms</strong>
            <span className="meta-caption">0 OOM errors · local benchmark</span>
          </div>
        </div>
      )}

      {panelId === "workflow_links" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Sync Direction</span>
            <strong>One-Way (source → target)</strong>
            <span className="meta-caption">409 conflict unless detached</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Dependency Graph</span>
            <strong>Classification Redacted</strong>
            <span className="meta-caption">INT-T01..24 verified</span>
          </div>
        </div>
      )}

      {panelId === "workflow_packages" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Manifest Integrity</span>
            <strong>SHA-256 Digest Bound</strong>
            <span className="meta-caption">Post-approval edit auto-invalidates</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Cross-Module Reconciliation</span>
            <strong>Docs · Sheets · Slides · BI</strong>
            <span className="meta-caption">GOV-T01..08 verified</span>
          </div>
        </div>
      )}

      {panelId === "workflow_outbox" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Outbox Table</span>
            <strong>xi_outbox_events</strong>
            <span className="meta-caption">Atomic PG16 FORCE RLS commit</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Delivery Safety</span>
            <strong>Idempotent Lease Fencing</strong>
            <span className="meta-caption">Duplicate delivery suppressed</span>
          </div>
        </div>
      )}

      {panelId === "backup_restore" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Governance Parity (R-28)</span>
            <strong>Verified Fixed</strong>
            <span className="meta-caption">Revoked grants &amp; RLS survive restore</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Snapshot Suite</span>
            <strong>PLT-T35 Passing</strong>
            <span className="meta-caption">Non-destructive version history</span>
          </div>
        </div>
      )}

      {panelId === "admin_rbac" && (
        <div className="stack-sm">
          {authMode === "jwt-pg" ? (
            <div className="row-actions wrap">
              <span className="badge badge-ok">
                Role: {sessionActor?.role ?? "unauthenticated"} · Tenant: {sessionActor?.tenantId ?? "—"}
              </span>
              {sessionActor && (
                <>
                  <button type="button" className="btn" onClick={() => void onLogout(false)}>
                    Sign Out
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="Increment token_version to revoke all active sessions"
                    onClick={() => void onLogout(true)}
                  >
                    Revoke All Sessions
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="row-actions wrap">
              <label className="role-selector-label">
                Prototype Role:&nbsp;
                <select
                  className="select-control"
                  aria-label="Workspace role selector"
                  value={prototypeRole}
                  onChange={(e) => onRoleChange(e.target.value as WorkspaceRole)}
                >
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                  <option value="reviewer">Reviewer (Read-Only + Export)</option>
                  <option value="viewer">Viewer (Read-Only)</option>
                </select>
              </label>
              <span className="muted-text">
                8-role PolicyDecisionEngine (owner, administrator, workspace_manager, billing_admin, auditor, editor,
                reviewer, viewer) &amp; PG16 FORCE RLS verified (PLT-T01..36).
              </span>
            </div>
          )}
        </div>
      )}

      {panelId === "admin_policies" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">External LLMs (TF-08)</span>
            <strong>Fail-Closed (423)</strong>
            <span className="meta-caption">ZDR routing + regression gate</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Cloud STT &amp; P1 VOC-03 (TF-09)</span>
            <strong>Fail-Closed (423)</strong>
            <span className="meta-caption">Mock STT isMock=true disclosed</span>
          </div>
        </div>
      )}

      {panelId === "admin_quotas" && (
        <div className="subpanel-kpi-row">
          <div className="kpi-mini-card">
            <span className="meta-caption">Quota Accounting (PA-00)</span>
            <strong>FOR UPDATE Transactional</strong>
            <span className="meta-caption">Authorized reads preserved past_due</span>
          </div>
          <div className="kpi-mini-card">
            <span className="meta-caption">Background Workers</span>
            <strong>Fenced Leases</strong>
            <span className="meta-caption">Stale worker writes rejected</span>
          </div>
        </div>
      )}

      {panelId === "admin_health" && (
        <div className="stack-sm">
          <div className="row-actions">
            <button
              type="button"
              className="btn primary"
              disabled={isCheckingHealth}
              onClick={() => void checkHealthSnapshot()}
            >
              {isCheckingHealth ? "Checking..." : "Fetch /api/health"}
            </button>
            <span className="muted-text">
              Auth Mode: <code>{authMode}</code>
            </span>
          </div>
          {healthText && <pre className="subpanel-code">{healthText}</pre>}
        </div>
      )}
    </section>
  );
}

export const WorkspaceSubPanel = memo(WorkspaceSubPanelInner);
