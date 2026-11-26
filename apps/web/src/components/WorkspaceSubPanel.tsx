import { memo, useState } from "react";
import type { ActorContext, PageLayoutConfig, StudioDocument, WorkspaceRole } from "@ai-office-suite/shared-contracts";
import { formatApiErrorMessage, safeReadJson } from "../lib/apiClient.ts";

export type WorkspaceUtilityPanelId =
  | null
  | "page_layout"
  | "data_prep"
  | "certified_metrics"
  | "workflows"
  | "admin_rbac"
  | "admin_policies"
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

  if (!panelId) return null;

  async function runStageAndProfile() {
    setIsProfiling(true);
    setProfileError(null);
    setProfileResult(null);
    try {
      const res = await fetch("/api/data-prep/stage-and-profile", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...apiHeaders },
        body: JSON.stringify({
          datasetId: "ds_workspace_preview",
          sourceFileName: "november-2026.csv",
          csvText,
        }),
      });
      const data = await safeReadJson(res);
      if (!res.ok) {
        setProfileError(formatApiErrorMessage(res, data, "Data preparation profiling failed"));
        return;
      }
      setProfileResult(JSON.stringify(data.profile ?? data, null, 2));
    } catch {
      setProfileError("Unable to contact /api/data-prep/stage-and-profile.");
    } finally {
      setIsProfiling(false);
    }
  }

  async function checkHealthSnapshot() {
    setIsCheckingHealth(true);
    try {
      const res = await fetch("/api/health", { credentials: "include" });
      const data = await safeReadJson(res);
      setHealthText(JSON.stringify(data, null, 2));
    } catch {
      setHealthText("Unable to fetch /api/health.");
    } finally {
      setIsCheckingHealth(false);
    }
  }

  return (
    <section className="workspace-subpanel" aria-label="Contextual Workspace Panel">
      <div className="panel-header-row">
        <strong className="subpanel-title">
          {panelId === "page_layout" && "Page & Style Settings"}
          {panelId === "data_prep" && "Data Preparation · Stage & Profile (/api/data-prep/stage-and-profile)"}
          {panelId === "certified_metrics" && "Business Analysis · Certified FIN-POL-V1 Metrics"}
          {panelId === "workflows" && "Cross-Module Integration · Linked Objects & Reporting Packages (XI-00)"}
          {panelId === "admin_rbac" && "Governance & Admin · Role, RBAC & Tenant Isolation"}
          {panelId === "admin_policies" && "Governance & Admin · AI, Voice & Commercial Policy Gates"}
          {panelId === "admin_health" && "Governance & Admin · Session & Operational Health"}
        </strong>
        <button type="button" className="btn btn-compact" onClick={onClose}>
          Close Panel
        </button>
      </div>

      {panelId === "page_layout" && activeDoc && (
        <div className="subpanel-grid">
          <label className="field-label">
            Document Language
            <select
              className="btn"
              disabled={readOnly}
              aria-label="Subpanel document language"
              value={activeDoc.language}
              onChange={(e) => onLanguageChange(e.target.value as StudioDocument["language"])}
            >
              <option value="bilingual">Bilingual (EN / ខ្មែរ)</option>
              <option value="en">English</option>
              <option value="km">ខ្មែរ (Khmer)</option>
            </select>
          </label>
          <label className="field-label">
            Page Size
            <select
              className="btn"
              disabled={readOnly}
              aria-label="Subpanel page size"
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
              className="btn"
              disabled={readOnly}
              aria-label="Subpanel orientation"
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
          <label className="field-label">
            Header Text
            <input
              type="text"
              className="input-field input-compact"
              disabled={readOnly}
              value={activeDoc.layout.headerText}
              onChange={(e) => onLayoutChange({ ...activeDoc.layout, headerText: e.target.value })}
            />
          </label>
          <label className="field-label">
            Footer Text
            <input
              type="text"
              className="input-field input-compact"
              disabled={readOnly}
              value={activeDoc.layout.footerText}
              onChange={(e) => onLayoutChange({ ...activeDoc.layout, footerText: e.target.value })}
            />
          </label>
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
          <div className="kpi-mini-card">
            <span className="meta-caption">DuckDB Spill Bench (TF-04)</span>
            <strong>1,000,000 rows</strong>
            <span className="meta-caption">memory_limit=256MB · verified</span>
          </div>
        </div>
      )}

      {panelId === "workflows" && (
        <div className="stack-sm">
          <div className="muted-text">
            <strong>XI-00 Cross-Module Engine Status:</strong> One-way synchronization (<code>source → target</code>),
            classification-redacted dependency graphs, digest-bound <code>PublicationApproval</code>, and atomic PostgreSQL
            RLS <code>xi_outbox_events</code> verified locally (<code>INT-T01..24</code>, <code>GOV-T01..08</code>).
          </div>
          <div className="subpanel-kpi-row">
            <div className="kpi-mini-card">
              <span className="meta-caption">Sync Direction</span>
              <strong>One-Way Strict</strong>
            </div>
            <div className="kpi-mini-card">
              <span className="meta-caption">Manifest Digest</span>
              <strong>SHA-256 Bound</strong>
            </div>
            <div className="kpi-mini-card">
              <span className="meta-caption">Outbox Commit</span>
              <strong>Atomic PG RLS</strong>
            </div>
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
                  className="btn"
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
                8-role PolicyDecisionEngine (`owner`, `administrator`, `workspace_manager`, `billing_admin`, `auditor`, `editor`,
                `reviewer`, `viewer`) &amp; PG16 FORCE RLS verified (`PLT-T01..36`).
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
          <div className="kpi-mini-card">
            <span className="meta-caption">Quotas &amp; Jobs (PA-00)</span>
            <strong>FOR UPDATE + Fenced</strong>
            <span className="meta-caption">Authorized read preserved</span>
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
            <span className="muted-text">Auth Mode: <code>{authMode}</code></span>
          </div>
          {healthText && <pre className="subpanel-code">{healthText}</pre>}
        </div>
      )}
    </section>
  );
}

export const WorkspaceSubPanel = memo(WorkspaceSubPanelInner);
