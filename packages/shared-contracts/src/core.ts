export type WorkspaceRole =
  | "owner"
  | "administrator"
  | "editor"
  | "reviewer"
  | "viewer";

export interface ActorContext {
  tenantId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}


export type OperationRiskLevel = "low" | "medium" | "high";
export type OperationSource = "manual" | "typed_ai" | "voice_command";

export type LinkedObjectBindingMode =
  | "independent_copy"
  | "refreshable_link"
  | "pinned_snapshot";

export type LinkedResourceState =
  | "current"
  | "update_available"
  | "refreshing"
  | "stale"
  | "incompatible"
  | "access_restricted"
  | "source_unavailable"
  | "detached"
  | "pinned";

export interface AuditEvent {
  auditId: string;
  tenantId: string;
  workspaceId: string;
  documentId?: string;
  actorId: string;
  actorRole: WorkspaceRole;
  source: OperationSource | "import" | "export" | "restore" | "system";
  action: string;
  outcome: "success" | "denied" | "failed";
  revisionBefore?: number;
  revisionAfter?: number;
  operationId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Planned future studio boundary interfaces (Phase D2+ / D7).
 * Interfaces only — no implementation authorized in Phase D0/D1.
 */
export interface FutureStudioBoundaryDescriptor {
  studioId: "spreadsheets" | "presentations" | "analytics";
  status: "planned_future_phase";
  route: string;
  contractVersion: "0.1-placeholder";
}

export const PLANNED_FUTURE_STUDIOS: readonly FutureStudioBoundaryDescriptor[] = [
  { studioId: "spreadsheets", status: "planned_future_phase", route: "/spreadsheets", contractVersion: "0.1-placeholder" },
  { studioId: "presentations", status: "planned_future_phase", route: "/presentations", contractVersion: "0.1-placeholder" },
  { studioId: "analytics", status: "planned_future_phase", route: "/analytics", contractVersion: "0.1-placeholder" },
] as const;


// =============================================================================
// Phase D2 — Shared Platform Identity & Membership Contracts
// =============================================================================

export interface AuthenticatedUser {
  userId: string;
  email: string;
  status: "active" | "inactive" | "deleted";
  tokenVersion: number;
}

export interface TenantMembership {
  tenantId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

