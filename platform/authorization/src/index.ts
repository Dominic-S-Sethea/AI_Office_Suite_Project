import type {
  ActorContext,
  PolicyAction,
  PolicyDecision,
  PolicyDecisionRequest,
  PolicyResourceType,
  WorkspaceRole,
} from "@ai-office-suite/shared-contracts";

export type ResourceType = PolicyResourceType;
export type PermissionAction = PolicyAction;

const CONTENT_RESOURCES: ReadonlySet<PolicyResourceType> = new Set([
  "document",
  "spreadsheet",
  "presentation",
  "dashboard",
  "reporting_package",
  "file",
  "knowledge",
  "ai_assistant",
  "speech",
  "export",
]);

const ORG_SCOPED_RESOURCES: ReadonlySet<PolicyResourceType> = new Set([
  "organization",
  "billing",
  "usage",
  "entitlement",
  "policy",
  "audit",
]);

const METERED_ACTIONS: ReadonlySet<`${PolicyResourceType}:${PolicyAction}`> = new Set([
  "ai_assistant:read",
  "ai_assistant:apply_ai",
  "speech:transcribe",
  "job:create",
  "reporting_package:publish",
]);

const PRIVILEGED_MFA_ACTIONS: ReadonlySet<`${PolicyResourceType}:${PolicyAction}`> = new Set([
  "organization:transfer_ownership",
  "organization:manage",
  "policy:manage",
  "billing:manage",
  "membership:revoke",
  "document:admin_break_glass",
  "file:admin_break_glass",
]);

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<`${ResourceType}:${PermissionAction}`>> = {
  owner: new Set([
    "document:read",
    "document:create",
    "document:write",
    "document:restore",
    "document:delete",
    "document:admin_break_glass",
    "spreadsheet:read",
    "spreadsheet:create",
    "spreadsheet:write",
    "presentation:read",
    "presentation:create",
    "presentation:write",
    "dashboard:read",
    "dashboard:create",
    "dashboard:write",
    "reporting_package:read",
    "reporting_package:create",
    "reporting_package:write",
    "reporting_package:approve",
    "reporting_package:publish",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "ai_assistant:apply_ai",
    "knowledge:read",
    "knowledge:write",
    "audit:read",
    "metrics:read",
    "speech:transcribe",
    "organization:read",
    "organization:manage",
    "organization:transfer_ownership",
    "workspace:read",
    "workspace:create",
    "workspace:manage",
    "membership:read",
    "membership:manage",
    "membership:revoke",
    "invitation:read",
    "invitation:invite",
    "invitation:revoke",
    "file:read",
    "file:create",
    "file:write",
    "file:delete",
    "file:recover",
    "file:quarantine",
    "file:manage",
    "file:admin_break_glass",
    "billing:read",
    "billing:manage",
    "usage:read",
    "entitlement:read",
    "policy:read",
    "policy:manage",
    "job:read",
    "job:create",
    "job:cancel",
    "job:manage",
  ]),
  administrator: new Set([
    "document:read",
    "document:create",
    "document:write",
    "document:restore",
    "document:delete",
    "document:admin_break_glass",
    "spreadsheet:read",
    "spreadsheet:create",
    "spreadsheet:write",
    "presentation:read",
    "presentation:create",
    "presentation:write",
    "dashboard:read",
    "dashboard:create",
    "dashboard:write",
    "reporting_package:read",
    "reporting_package:create",
    "reporting_package:write",
    "reporting_package:approve",
    "reporting_package:publish",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "ai_assistant:apply_ai",
    "knowledge:read",
    "knowledge:write",
    "audit:read",
    "metrics:read",
    "speech:transcribe",
    "organization:read",
    "organization:manage",
    "workspace:read",
    "workspace:create",
    "workspace:manage",
    "membership:read",
    "membership:manage",
    "membership:revoke",
    "invitation:read",
    "invitation:invite",
    "invitation:revoke",
    "file:read",
    "file:create",
    "file:write",
    "file:delete",
    "file:recover",
    "file:quarantine",
    "file:manage",
    "file:admin_break_glass",
    "usage:read",
    "entitlement:read",
    "policy:read",
    "policy:manage",
    "job:read",
    "job:create",
    "job:cancel",
    "job:manage",
  ]),
  workspace_manager: new Set([
    "document:read",
    "document:create",
    "document:write",
    "document:restore",
    "spreadsheet:read",
    "spreadsheet:create",
    "spreadsheet:write",
    "presentation:read",
    "presentation:create",
    "presentation:write",
    "dashboard:read",
    "dashboard:create",
    "dashboard:write",
    "reporting_package:read",
    "reporting_package:create",
    "reporting_package:write",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "ai_assistant:apply_ai",
    "knowledge:read",
    "knowledge:write",
    "audit:read",
    "metrics:read",
    "speech:transcribe",
    "workspace:read",
    "workspace:manage",
    "membership:read",
    "membership:manage",
    "membership:revoke",
    "invitation:read",
    "invitation:invite",
    "invitation:revoke",
    "file:read",
    "file:create",
    "file:write",
    "file:delete",
    "file:recover",
    "file:quarantine",
    "file:manage",
    "job:read",
    "job:create",
    "job:cancel",
  ]),
  billing_admin: new Set([
    "organization:read",
    "billing:read",
    "billing:manage",
    "usage:read",
    "entitlement:read",
    "audit:read",
    "metrics:read",
  ]),
  auditor: new Set([
    "organization:read",
    "workspace:read",
    "membership:read",
    "audit:read",
    "metrics:read",
    "usage:read",
    "entitlement:read",
    "policy:read",
    "job:read",
  ]),
  editor: new Set([
    "document:read",
    "document:create",
    "document:write",
    "document:restore",
    "spreadsheet:read",
    "spreadsheet:create",
    "spreadsheet:write",
    "presentation:read",
    "presentation:create",
    "presentation:write",
    "dashboard:read",
    "dashboard:create",
    "dashboard:write",
    "reporting_package:read",
    "reporting_package:create",
    "reporting_package:write",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "ai_assistant:apply_ai",
    "knowledge:read",
    "knowledge:write",
    "audit:read",
    "speech:transcribe",
    "file:read",
    "file:create",
    "file:write",
    "job:read",
    "job:create",
    "job:cancel",
  ]),
  reviewer: new Set([
    "document:read",
    "spreadsheet:read",
    "presentation:read",
    "dashboard:read",
    "reporting_package:read",
    "reporting_package:approve",
    "reporting_package:publish",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "knowledge:read",
    "audit:read",
    "file:read",
    "job:read",
  ]),
  viewer: new Set([
    "document:read",
    "spreadsheet:read",
    "presentation:read",
    "dashboard:read",
    "reporting_package:read",
    "export:read",
    "knowledge:read",
    "file:read",
  ]),
};

export class AuthorizationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (
    value === "owner" ||
    value === "administrator" ||
    value === "workspace_manager" ||
    value === "billing_admin" ||
    value === "auditor" ||
    value === "editor" ||
    value === "reviewer" ||
    value === "viewer"
  );
}

export function canPerform(
  actor: ActorContext,
  resource: ResourceType,
  action: PermissionAction,
): boolean {
  const allowed = ROLE_PERMISSIONS[actor.role];
  if (!allowed) return false;
  return allowed.has(`${resource}:${action}`);
}

export function assertCanPerform(
  actor: ActorContext,
  resource: ResourceType,
  action: PermissionAction,
): void {
  if (!canPerform(actor, resource, action)) {
    throw new AuthorizationError(
      403,
      "FORBIDDEN_ROLE",
      `Role '${actor.role}' is not authorized for ${resource}:${action}.`,
    );
  }
}

export function assertTenantWorkspaceAccess(
  actor: ActorContext,
  resourceTenantId: string,
  resourceWorkspaceId: string,
): void {
  if (actor.tenantId !== resourceTenantId || actor.workspaceId !== resourceWorkspaceId) {
    throw new AuthorizationError(
      403,
      "TENANT_ISOLATION_DENIED",
      "Cross-tenant or cross-workspace access is denied.",
    );
  }
}

/**
 * Centralized V1.3 PolicyDecisionEngine (PA-00 / PLT-02 / PLT-06).
 * Evaluates tenant/workspace isolation, org suspension, MFA step-up assurance,
 * role capabilities, restricted workspace content isolation, and commercial entitlements
 * identically across manual, typed_ai, voice_command, and workflow sources.
 */
export function evaluatePolicyDecision(request: PolicyDecisionRequest): PolicyDecision {
  const evaluatedAt = request.nowIso ?? new Date().toISOString();
  const key: `${PolicyResourceType}:${PolicyAction}` = `${request.resource}:${request.action}`;
  const requiresUserApproval =
    request.riskLevel === "high" ||
    request.action === "publish" ||
    request.action === "delete" ||
    request.action === "transfer_ownership" ||
    (request.action === "apply_ai" && request.riskLevel !== "low") ||
    (request.source === "voice_command" &&
      (request.action === "write" || request.action === "apply_ai"));

  // 1. Tenant & Workspace isolation (fail-closed)
  if (!request.actor.tenantId || request.actor.tenantId !== request.resourceTenantId) {
    return {
      allowed: false,
      denialCategory: "tenant_boundary",
      code: "TENANT_ISOLATION_DENIED",
      reason: "Cross-tenant access is denied.",
      requiresUserApproval,
      evaluatedAt,
      source: request.source,
    };
  }

  if (
    request.resourceWorkspaceId &&
    !ORG_SCOPED_RESOURCES.has(request.resource) &&
    request.actor.workspaceId !== request.resourceWorkspaceId
  ) {
    return {
      allowed: false,
      denialCategory: "tenant_boundary",
      code: "WORKSPACE_ISOLATION_DENIED",
      reason: "Cross-workspace access is denied.",
      requiresUserApproval,
      evaluatedAt,
      source: request.source,
    };
  }

  // 2. Organization suspension (blocks mutations & active processing; allows explicit org reactivation)
  if (
    request.organizationStatus === "suspended" &&
    !(request.resource === "organization" && request.action === "manage")
  ) {
    return {
      allowed: false,
      denialCategory: "organization_suspended",
      code: "ORGANIZATION_SUSPENDED",
      reason: "Organization is suspended; active operations are blocked.",
      requiresUserApproval,
      evaluatedAt,
      source: request.source,
    };
  }

  // 3. Role capability check (voice commands and AI use exact same RBAC matrix as manual actions)
  if (!canPerform(request.actor, request.resource, request.action)) {
    return {
      allowed: false,
      denialCategory: "role_forbidden",
      code: "FORBIDDEN_ROLE",
      reason: `Role '${request.actor.role}' is not authorized for ${key} via source '${request.source}'.`,
      requiresUserApproval,
      evaluatedAt,
      source: request.source,
    };
  }

  // 4. Restricted workspace / restricted classification content separation
  // Prevents org-level admins/owners from silently accessing restricted workspaces (e.g., Payroll)
  // without an explicit workspaceContentGrant (or audited admin_break_glass).
  if (
    CONTENT_RESOURCES.has(request.resource) &&
    request.action !== "admin_break_glass" &&
    (request.workspaceVisibility === "restricted" || request.classification === "restricted") &&
    request.actor.workspaceContentGrant !== true
  ) {
    return {
      allowed: false,
      denialCategory: "workspace_content_isolated",
      code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      reason: "Explicit workspace content membership grant is required for restricted workspace/content access.",
      requiresUserApproval,
      evaluatedAt,
      source: request.source,
    };
  }

  // 5. Privileged MFA step-up check
  if (request.mfaRequiredForPrivileged && PRIVILEGED_MFA_ACTIONS.has(key)) {
    const maxAgeSec = request.mfaMaxAgeSeconds ?? 900;
    const nowMs = Date.parse(evaluatedAt);
    const verifiedMs = request.actor.mfaVerifiedAt ? Date.parse(request.actor.mfaVerifiedAt) : Number.NaN;
    if (!Number.isFinite(verifiedMs) || nowMs - verifiedMs > maxAgeSec * 1000 || verifiedMs > nowMs + 60_000) {
      return {
        allowed: false,
        denialCategory: "mfa_step_up_required",
        code: "MFA_STEP_UP_REQUIRED",
        reason: `Privileged action '${key}' requires fresh MFA step-up verification within ${maxAgeSec}s.`,
        requiresUserApproval,
        evaluatedAt,
        source: request.source,
      };
    }
  }

  // 6. Commercial subscription & entitlement governance (distinct from RBAC!)
  // Critical rule (PLT-06 / PLT-T27): Reading/exporting existing authorized user work MUST remain allowed
  // even when metered AI/voice quotas are exhausted or subscription is past_due/grace/downgraded.
  if (request.subscription && !request.isReadExistingAuthorizedWork) {
    const sub = request.subscription;
    if (sub.status === "suspended" || sub.status === "canceled") {
      return {
        allowed: false,
        denialCategory: "quota_or_subscription_restricted",
        code: "SUBSCRIPTION_INACTIVE",
        reason: `Subscription status '${sub.status}' blocks new operations while preserving read-only access to existing authorized artifacts.`,
        requiresUserApproval,
        evaluatedAt,
        source: request.source,
      };
    }

    if (sub.status === "past_due" && METERED_ACTIONS.has(key)) {
      return {
        allowed: false,
        denialCategory: "quota_or_subscription_restricted",
        code: "SUBSCRIPTION_PAST_DUE_METERED_BLOCKED",
        reason: "Subscription is past_due; metered AI, voice, and background job execution is paused.",
        requiresUserApproval,
        evaluatedAt,
        source: request.source,
      };
    }

    if (request.entitlementFeature && !sub.entitlements[request.entitlementFeature]) {
      return {
        allowed: false,
        denialCategory: "entitlement_missing",
        code: "PLAN_ENTITLEMENT_REQUIRED",
        reason: `Active plan '${sub.planId}@v${sub.planVersion}' does not include entitlement '${request.entitlementFeature}'.`,
        requiresUserApproval,
        evaluatedAt,
        source: request.source,
      };
    }
  }

  return {
    allowed: true,
    requiresUserApproval,
    evaluatedAt,
    source: request.source,
  };
}

export function assertPolicyAllowed(request: PolicyDecisionRequest): PolicyDecision {
  const decision = evaluatePolicyDecision(request);
  if (!decision.allowed) {
    const statusCode =
      decision.denialCategory === "quota_or_subscription_restricted" ||
      decision.denialCategory === "entitlement_missing"
        ? 402
        : 403;
    throw new AuthorizationError(
      statusCode,
      decision.code ?? "POLICY_DENIED",
      decision.reason ?? "Action denied by central policy engine.",
    );
  }
  return decision;
}
