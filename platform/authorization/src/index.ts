import type { ActorContext, WorkspaceRole } from "@ai-office-suite/shared-contracts";

export type ResourceType = "document" | "ai_assistant" | "audit" | "export";
export type PermissionAction = "read" | "create" | "write" | "restore" | "export" | "apply_ai";

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<`${ResourceType}:${PermissionAction}`>> = {
  owner: new Set([
    "document:read",
    "document:create",
    "document:write",
    "document:restore",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "ai_assistant:apply_ai",
    "audit:read",
  ]),
  administrator: new Set([
    "document:read",
    "document:create",
    "document:write",
    "document:restore",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "ai_assistant:apply_ai",
    "audit:read",
  ]),
  editor: new Set([
    "document:read",
    "document:create",
    "document:write",
    "document:restore",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "ai_assistant:apply_ai",
    "audit:read",
  ]),
  reviewer: new Set([
    "document:read",
    "export:read",
    "export:export",
    "ai_assistant:read",
    "audit:read",
  ]),
  viewer: new Set([
    "document:read",
    "export:read",
    "audit:read",
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
