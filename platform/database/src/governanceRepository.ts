import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ActorContext,
  ArtifactClassification,
  AuditEvent,
  BillingWebhookEvent,
  DurableJobRecord,
  FileQuarantineState,
  InvitationRecord,
  ModelRoutingPolicy,
  OperationSource,
  OrganizationRecord,
  OrganizationStatus,
  PlanEntitlements,
  PlanVersion,
  QuotaDimension,
  ServiceHealthSnapshot,
  SubscriptionStatus,
  TenantSubscription,
  UsageLedgerEntry,
  UsageReservation,
  VersionedFileObject,
  VoicePolicyConfig,
  WorkspaceRecord,
  WorkspaceRole,
  WorkspaceVisibility,
} from "@ai-office-suite/shared-contracts";
import { redactAuditString, redactAuditValue } from "@ai-office-suite/audit";
import { assertCanManageTargetRole, assertPolicyAllowed, isWorkspaceRole } from "@ai-office-suite/authorization";
import type { PgDatabaseAdapter, PgQueryExecutor } from "./adapter.ts";
import { verifyDatabaseRlsReadiness, withTenantTransaction } from "./schema.ts";

function clampGovernancePagination(options?: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const rawLimit = options?.limit ?? 200;
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 200;
  const rawOffset = options?.offset ?? 0;
  const offset = Number.isFinite(rawOffset) ? Math.min(100_000, Math.max(0, Math.trunc(rawOffset))) : 0;
  return { limit, offset };
}

function escapeSqlLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
import { verifyPaRlsReadiness } from "./paSchema.ts";
import {
  assertBackupRoleCanBypassRls,
  exportCoreAndXiInTx,
  restoreCoreAndXiInTx,
  verifyLogicalBackupSnapshot,
  type LogicalBackupSnapshot,
} from "./localDataMigrator.ts";

export class GovernanceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "GovernanceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const DEFAULT_PLAN_VERSIONS: readonly PlanVersion[] = [
  {
    planId: "free_trial",
    version: 1,
    displayName: "SME Free Trial (Local Feasibility)",
    entitlements: {
      aiCoreEnabled: true,
      voiceCommandsEnabled: false,
      khmerVoiceEnabled: false,
      crossModuleReportingEnabled: false,
      auditExportEnabled: false,
      maxWorkspaces: 2,
      maxSeats: 3,
      monthlyAiTokens: 50_000,
      monthlyAiRequests: 100,
      monthlyVoiceSeconds: 0,
      storageQuotaBytes: 100 * 1024 * 1024,
      maxConcurrentJobs: 2,
    },
    createdAt: "2026-11-26T00:00:00.000Z",
  },
  {
    planId: "sme_standard",
    version: 1,
    displayName: "SME Standard",
    entitlements: {
      aiCoreEnabled: true,
      voiceCommandsEnabled: true,
      khmerVoiceEnabled: true,
      crossModuleReportingEnabled: true,
      auditExportEnabled: true,
      maxWorkspaces: 10,
      maxSeats: 25,
      monthlyAiTokens: 1_000_000,
      monthlyAiRequests: 5_000,
      monthlyVoiceSeconds: 18_000,
      storageQuotaBytes: 10 * 1024 * 1024 * 1024,
      maxConcurrentJobs: 10,
    },
    createdAt: "2026-11-26T00:00:00.000Z",
  },
  {
    planId: "sme_pro",
    version: 1,
    displayName: "SME Pro",
    entitlements: {
      aiCoreEnabled: true,
      voiceCommandsEnabled: true,
      khmerVoiceEnabled: true,
      crossModuleReportingEnabled: true,
      auditExportEnabled: true,
      maxWorkspaces: 50,
      maxSeats: 100,
      monthlyAiTokens: 10_000_000,
      monthlyAiRequests: 50_000,
      monthlyVoiceSeconds: 90_000,
      storageQuotaBytes: 100 * 1024 * 1024 * 1024,
      maxConcurrentJobs: 50,
    },
    createdAt: "2026-11-26T00:00:00.000Z",
  },
];

/**
 * Redacts sensitive tokens/secrets recursively before writing metadata to audit logs (PLT-T33, F-13).
 */
export function redactSensitiveMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  return redactAuditValue(input) as Record<string, unknown>;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function signMockBillingWebhook(rawPayload: string, webhookSecret: string): string {
  return createHmac("sha256", webhookSecret).update(rawPayload, "utf8").digest("hex");
}

function parseJsonColumn<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUMULATIVE_QUOTA_DIMENSIONS: ReadonlySet<QuotaDimension> = new Set(["storage_bytes", "seats"]);
const ALLOWED_BILLING_EVENT_TYPES = new Set<BillingWebhookEvent["eventType"]>([
  "subscription.upgraded",
  "subscription.downgraded",
  "subscription.past_due",
  "subscription.grace",
  "subscription.reactivated",
  "subscription.canceled",
]);

function getQuotaLimitForDimension(entitlements: PlanEntitlements, dimension: QuotaDimension): number {
  switch (dimension) {
    case "ai_tokens":
      return entitlements.monthlyAiTokens;
    case "ai_requests":
      return entitlements.monthlyAiRequests;
    case "voice_seconds":
      return entitlements.monthlyVoiceSeconds;
    case "storage_bytes":
      return entitlements.storageQuotaBytes;
    case "concurrent_jobs":
      return entitlements.maxConcurrentJobs;
    case "seats":
      return entitlements.maxSeats;
  }
}

export interface PaExtendedLogicalBackupSnapshot {
  snapshotVersion?: number;
  exportedAt?: string;
  extendedIntegritySha256?: string;
  coreAndXi: LogicalBackupSnapshot;
  paTables: {
    paPlanVersions: Array<Record<string, unknown>>;
    paTenantSubscriptions: Array<Record<string, unknown>>;
    paInvitations: Array<Record<string, unknown>>;
    paUsageReservations: Array<Record<string, unknown>>;
    paUsageLedger: Array<Record<string, unknown>>;
    paBillingWebhooks: Array<Record<string, unknown>>;
    paFileObjects: Array<Record<string, unknown>>;
    paJobs: Array<Record<string, unknown>>;
    paAiPolicies: Array<Record<string, unknown>>;
    paVoicePolicies: Array<Record<string, unknown>>;
  };
}

/**
 * Shared Platform Administration repository & transactional governance service (PA-00 / FR-11).
 * Operates over PostgreSQL / PGlite with fail-closed `FORCE ROW LEVEL SECURITY` via `withTenantTransaction`.
 */
export class PlatformGovernanceService {
  private readonly db: PgDatabaseAdapter;
  private readonly billingWebhookSecret: string;

  constructor(db: PgDatabaseAdapter, options: { billingWebhookSecret?: string } = {}) {
    this.db = db;
    this.billingWebhookSecret = options.billingWebhookSecret ?? randomBytes(32).toString("hex");
  }

  getMockBillingWebhookSecret(): string {
    return this.billingWebhookSecret;
  }

  // ---------------------------------------------------------------------------
  // Audit helper (append-only, redacted, tenant-scoped)
  // ---------------------------------------------------------------------------
  async appendAuditLogTx(
    tx: PgQueryExecutor,
    entry: {
      tenantId: string;
      workspaceId?: string | null;
      actorId: string;
      actorRole: WorkspaceRole;
      source: AuditEvent["source"];
      action: string;
      outcome: "success" | "denied" | "failed";
      targetType: string;
      targetId: string;
      summary: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> {
    const auditId = randomUUID();
    const safeSummary = redactAuditString(entry.summary);
    const safeMeta = redactSensitiveMetadata(entry.metadata);
    await tx.query(
      `INSERT INTO audit_logs (
         audit_id, tenant_id, workspace_id, actor_id, actor_role, source,
         action, outcome, target_type, target_id, summary, metadata
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        auditId,
        entry.tenantId,
        entry.workspaceId ?? null,
        entry.actorId,
        entry.actorRole,
        entry.source,
        entry.action,
        entry.outcome,
        entry.targetType,
        entry.targetId,
        safeSummary,
        safeMeta ? JSON.stringify(safeMeta) : null,
      ],
    );
    return auditId;
  }

  // ---------------------------------------------------------------------------
  // Organizations, Workspaces & Plan Catalog
  // ---------------------------------------------------------------------------
  async seedDefaultPlans(): Promise<void> {
    for (const plan of DEFAULT_PLAN_VERSIONS) {
      await this.upsertPlanVersion(plan);
    }
  }

  async upsertPlanVersion(plan: PlanVersion): Promise<void> {
    await this.db.query(
      `INSERT INTO pa_plan_versions (plan_id, version, display_name, entitlements_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (plan_id, version) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           entitlements_json = EXCLUDED.entitlements_json`,
      [plan.planId, plan.version, plan.displayName, JSON.stringify(plan.entitlements)],
    );
  }

  async createOrganization(params: {
    tenantId?: string;
    name: string;
    mfaRequiredForPrivileged?: boolean;
  }): Promise<OrganizationRecord> {
    const tenantId = params.tenantId ?? randomUUID();
    const mfaRequired = params.mfaRequiredForPrivileged ?? false;
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        name: string;
        status: OrganizationStatus;
        mfa_required_for_privileged: boolean;
        created_at: Date | string;
      }>(
        `INSERT INTO organizations (tenant_id, name, status, mfa_required_for_privileged)
         VALUES ($1::uuid, $2, 'active', $3)
         RETURNING tenant_id, name, status, mfa_required_for_privileged, created_at`,
        [tenantId, params.name.trim(), mfaRequired],
      );
      const row = res.rows[0]!;
      return {
        tenantId: row.tenant_id,
        name: row.name,
        status: row.status,
        mfaRequiredForPrivileged: row.mfa_required_for_privileged,
        createdAt: toIso(row.created_at),
      };
    });
  }

  async getOrganization(tenantId: string): Promise<OrganizationRecord | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        name: string;
        status: OrganizationStatus;
        mfa_required_for_privileged: boolean;
        created_at: Date | string;
      }>(
        `SELECT tenant_id, name, status, mfa_required_for_privileged, created_at
         FROM organizations WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        tenantId: row.tenant_id,
        name: row.name,
        status: row.status,
        mfaRequiredForPrivileged: row.mfa_required_for_privileged,
        createdAt: toIso(row.created_at),
      };
    });
  }

  async setOrganizationStatus(params: {
    actor: ActorContext;
    tenantId: string;
    status: OrganizationStatus;
    reason: string;
  }): Promise<OrganizationRecord> {
    const org = await this.getOrganization(params.tenantId);
    if (!org) throw new GovernanceError(404, "ORG_NOT_FOUND", "Organization not found.");

    assertPolicyAllowed({
      actor: params.actor,
      resourceTenantId: params.tenantId,
      resource: "organization",
      action: "manage",
      source: "manual",
      organizationStatus: org.status,
      mfaRequiredForPrivileged: org.mfaRequiredForPrivileged,
    });

    return withTenantTransaction(this.db, params.tenantId, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        name: string;
        status: OrganizationStatus;
        mfa_required_for_privileged: boolean;
        created_at: Date | string;
      }>(
        `UPDATE organizations SET status = $2 WHERE tenant_id = $1::uuid
         RETURNING tenant_id, name, status, mfa_required_for_privileged, created_at`,
        [params.tenantId, params.status],
      );
      await this.appendAuditLogTx(tx, {
        tenantId: params.tenantId,
        workspaceId: params.actor.workspaceId,
        actorId: params.actor.userId,
        actorRole: params.actor.role,
        source: "manual",
        action: `organization.${params.status}`,
        outcome: "success",
        targetType: "organization",
        targetId: params.tenantId,
        summary: `Organization status changed to '${params.status}': ${params.reason}`,
        metadata: { reason: params.reason },
      });
      const row = res.rows[0]!;
      return {
        tenantId: row.tenant_id,
        name: row.name,
        status: row.status,
        mfaRequiredForPrivileged: row.mfa_required_for_privileged,
        createdAt: toIso(row.created_at),
      };
    });
  }

  async createWorkspace(params: {
    tenantId: string;
    workspaceId?: string;
    name: string;
    visibility?: WorkspaceVisibility;
  }): Promise<WorkspaceRecord> {
    const workspaceId = params.workspaceId ?? randomUUID();
    const visibility: WorkspaceVisibility = params.visibility ?? "standard";
    return withTenantTransaction(this.db, params.tenantId, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        workspace_id: string;
        name: string;
        visibility: WorkspaceVisibility;
        created_at: Date | string;
      }>(
        `INSERT INTO workspaces (tenant_id, workspace_id, name, visibility)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         RETURNING tenant_id, workspace_id, name, visibility, created_at`,
        [params.tenantId, workspaceId, params.name.trim(), visibility],
      );
      const row = res.rows[0]!;
      return {
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        name: row.name,
        visibility: row.visibility,
        createdAt: toIso(row.created_at),
      };
    });
  }

  async getWorkspace(tenantId: string, workspaceId: string): Promise<WorkspaceRecord | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        workspace_id: string;
        name: string;
        visibility: WorkspaceVisibility;
        created_at: Date | string;
      }>(
        `SELECT tenant_id, workspace_id, name, visibility, created_at
         FROM workspaces WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid`,
        [tenantId, workspaceId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        name: row.name,
        visibility: row.visibility,
        createdAt: toIso(row.created_at),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Memberships, Tenant Switch, Sole-Owner Guard & Ownership Transfer (PLT-01)
  // ---------------------------------------------------------------------------
  async upsertMembership(params: {
    tenantId: string;
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    contentAccess?: boolean;
  }): Promise<void> {
    const contentAccess =
      params.contentAccess ?? (params.role !== "billing_admin" && params.role !== "auditor");
    await withTenantTransaction(this.db, params.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO memberships (tenant_id, workspace_id, user_id, role, status, content_access)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', $5)
         ON CONFLICT (tenant_id, workspace_id, user_id) DO UPDATE
         SET role = EXCLUDED.role, status = 'active', content_access = EXCLUDED.content_access`,
        [params.tenantId, params.workspaceId, params.userId, params.role, contentAccess],
      );
    });
  }

  /**
   * Explicit tenant/workspace context switch verification (PLT-T13).
   * Never trusts client headers without live active membership + active org check.
   */
  async switchTenantContext(params: {
    userId: string;
    targetTenantId: string;
    targetWorkspaceId: string;
    mfaVerifiedAt?: string;
  }): Promise<ActorContext> {
    const row = await withTenantTransaction(
      this.db,
      params.targetTenantId,
      async (tx) => {
        const res = await tx.query<{
          role: string;
          status: string;
          content_access: boolean;
          org_status: OrganizationStatus;
          user_status: string;
        }>(
          `SELECT m.role, m.status, m.content_access, o.status AS org_status, u.status AS user_status
           FROM memberships m
           JOIN organizations o ON o.tenant_id = m.tenant_id
           JOIN users u ON u.user_id = m.user_id
           WHERE m.tenant_id = $1::uuid AND m.workspace_id = $2::uuid AND m.user_id = $3::uuid`,
          [params.targetTenantId, params.targetWorkspaceId, params.userId],
        );
        return res.rows[0] ?? null;
      },
      params.targetWorkspaceId,
    );
    if (!row || row.user_status !== "active" || row.status !== "active" || !isWorkspaceRole(row.role)) {
      throw new GovernanceError(
        403,
        "TENANT_SWITCH_DENIED",
        "User does not hold an active membership in the requested tenant/workspace.",
      );
    }
    if (row.org_status !== "active") {
      throw new GovernanceError(403, "ORGANIZATION_SUSPENDED", "Target organization is suspended.");
    }
    return {
      tenantId: params.targetTenantId,
      workspaceId: params.targetWorkspaceId,
      userId: params.userId,
      role: row.role,
      workspaceContentGrant: row.content_access,
      ...(params.mfaVerifiedAt ? { mfaVerifiedAt: params.mfaVerifiedAt } : {}),
    };
  }

  async offboardOrSuspendMember(params: {
    actor: ActorContext;
    tenantId: string;
    workspaceId?: string;
    targetUserId: string;
    mode: "suspend" | "revoke";
    reason: string;
  }): Promise<{ newTokenVersion: number; updatedMemberships: number }> {
    const org = await this.getOrganization(params.tenantId);
    if (!org) throw new GovernanceError(404, "ORG_NOT_FOUND", "Organization not found.");

    const scopedWorkspaceId =
      params.actor.role === "workspace_manager"
        ? (params.workspaceId ?? params.actor.workspaceId)
        : params.workspaceId;
    const rlsWorkspaceId = params.actor.role === "workspace_manager" ? scopedWorkspaceId : undefined;

    assertPolicyAllowed({
      actor: params.actor,
      resourceTenantId: params.tenantId,
      ...(scopedWorkspaceId ? { resourceWorkspaceId: scopedWorkspaceId } : {}),
      resource: "membership",
      action: "revoke",
      source: "manual",
      organizationStatus: org.status,
      mfaRequiredForPrivileged: org.mfaRequiredForPrivileged,
    });

    return withTenantTransaction(
      this.db,
      params.tenantId,
      async (tx) => {
        // Serialize owner count checks on the tenant row
        await tx.query("SELECT tenant_id FROM organizations WHERE tenant_id = $1::uuid FOR UPDATE", [
          params.tenantId,
        ]);

        const targetRoles = scopedWorkspaceId
          ? await tx.query<{ role: string }>(
              `SELECT role FROM memberships
               WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid AND status = 'active'`,
              [params.tenantId, scopedWorkspaceId, params.targetUserId],
            )
          : await tx.query<{ role: string }>(
              `SELECT role FROM memberships
               WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND status = 'active'`,
              [params.tenantId, params.targetUserId],
            );
        if (targetRoles.rows.length === 0) {
          throw new GovernanceError(404, "MEMBERSHIP_NOT_FOUND", "No active tenant membership found for user.");
        }

        const actionVerb = params.mode === "suspend" ? "suspend" : "revoke";
        for (const r of targetRoles.rows) {
          if (!isWorkspaceRole(r.role)) {
            throw new GovernanceError(400, "INVALID_MEMBERSHIP_ROLE", `Invalid membership role '${r.role}'.`);
          }
          assertCanManageTargetRole(params.actor, r.role, actionVerb);
        }

        const isOwner = targetRoles.rows.some((r) => r.role === "owner");
        if (isOwner) {
          const otherOwners = await tx.query<{ cnt: string | number }>(
            `SELECT COUNT(DISTINCT user_id) AS cnt
             FROM memberships
             WHERE tenant_id = $1::uuid AND role = 'owner' AND status = 'active' AND user_id <> $2::uuid`,
            [params.tenantId, params.targetUserId],
          );
          if (Number(otherOwners.rows[0]?.cnt ?? 0) === 0) {
            throw new GovernanceError(
              409,
              "SOLE_OWNER_CANNOT_BE_REMOVED",
              "Cannot suspend or offboard the sole active owner of an organization. Transfer ownership first.",
            );
          }
        }

        const nextStatus = params.mode === "suspend" ? "suspended" : "revoked";
        const upd = scopedWorkspaceId
          ? await tx.query(
              `UPDATE memberships SET status = $4, content_access = false
               WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid AND status = 'active'`,
              [params.tenantId, scopedWorkspaceId, params.targetUserId, nextStatus],
            )
          : await tx.query(
              `UPDATE memberships SET status = $3, content_access = false
               WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND status = 'active'`,
              [params.tenantId, params.targetUserId, nextStatus],
            );

        // Immediately revoke active sessions via SECURITY DEFINER token_version bump (F-04)
        const tvRes = await tx.query<{ token_version: number | null }>(
          `SELECT auth_bump_user_token_version($1::uuid) AS token_version`,
          [params.targetUserId],
        );

        await this.appendAuditLogTx(tx, {
          tenantId: params.tenantId,
          workspaceId: scopedWorkspaceId ?? params.actor.workspaceId,
          actorId: params.actor.userId,
          actorRole: params.actor.role,
          source: "manual",
          action: `membership.${nextStatus}`,
          outcome: "success",
          targetType: "user",
          targetId: params.targetUserId,
          summary: `Member ${params.targetUserId} marked ${nextStatus} and sessions revoked: ${params.reason}`,
          metadata: {
            reason: params.reason,
            mode: params.mode,
            scopedWorkspaceId: scopedWorkspaceId ?? null,
          },
        });

        return {
          newTokenVersion: tvRes.rows[0]?.token_version ?? 0,
          updatedMemberships: upd.rowCount,
        };
      },
      rlsWorkspaceId,
    );
  }

  async transferOwnership(params: {
    actor: ActorContext;
    tenantId: string;
    workspaceId: string;
    newOwnerUserId: string;
    demoteCurrentOwnerTo?: "administrator" | "editor";
  }): Promise<void> {
    const org = await this.getOrganization(params.tenantId);
    if (!org) throw new GovernanceError(404, "ORG_NOT_FOUND", "Organization not found.");

    assertPolicyAllowed({
      actor: params.actor,
      resourceTenantId: params.tenantId,
      resourceWorkspaceId: params.workspaceId,
      resource: "organization",
      action: "transfer_ownership",
      source: "manual",
      organizationStatus: org.status,
      mfaRequiredForPrivileged: org.mfaRequiredForPrivileged,
    });

    if (params.actor.userId === params.newOwnerUserId) {
      throw new GovernanceError(400, "INVALID_OWNERSHIP_TRANSFER", "Target owner must be a different user.");
    }

    await withTenantTransaction(this.db, params.tenantId, async (tx) => {
      await tx.query("SELECT tenant_id FROM organizations WHERE tenant_id = $1::uuid FOR UPDATE", [
        params.tenantId,
      ]);

      const targetMem = await tx.query<{ role: string }>(
        `SELECT role FROM memberships
         WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid AND status = 'active'`,
        [params.tenantId, params.workspaceId, params.newOwnerUserId],
      );
      if (targetMem.rows.length === 0) {
        throw new GovernanceError(
          404,
          "TARGET_MEMBER_NOT_ACTIVE",
          "New owner must hold an active membership in the organization workspace.",
        );
      }

      await tx.query(
        `UPDATE memberships SET role = 'owner'
         WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid`,
        [params.tenantId, params.workspaceId, params.newOwnerUserId],
      );

      if (params.demoteCurrentOwnerTo) {
        await tx.query(
          `UPDATE memberships SET role = $4
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid`,
          [params.tenantId, params.workspaceId, params.actor.userId, params.demoteCurrentOwnerTo],
        );
      }

      await this.appendAuditLogTx(tx, {
        tenantId: params.tenantId,
        workspaceId: params.workspaceId,
        actorId: params.actor.userId,
        actorRole: params.actor.role,
        source: "manual",
        action: "organization.ownership_transferred",
        outcome: "success",
        targetType: "user",
        targetId: params.newOwnerUserId,
        summary: `Ownership transferred from ${params.actor.userId} to ${params.newOwnerUserId}.`,
        metadata: {
          previousOwner: params.actor.userId,
          newOwner: params.newOwnerUserId,
          demotedTo: params.demoteCurrentOwnerTo ?? null,
        },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Hashed Single-Use Invitations with Transactional Seat Limit (PLT-T03..T05)
  // ---------------------------------------------------------------------------
  async createInvitation(params: {
    actor: ActorContext;
    tenantId: string;
    workspaceId: string;
    email: string;
    invitedRole: WorkspaceRole;
    expiresInSeconds?: number;
  }): Promise<{ invitation: InvitationRecord; rawToken: string }> {
    const org = await this.getOrganization(params.tenantId);
    if (!org) throw new GovernanceError(404, "ORG_NOT_FOUND", "Organization not found.");

    assertPolicyAllowed({
      actor: params.actor,
      resourceTenantId: params.tenantId,
      resourceWorkspaceId: params.workspaceId,
      resource: "invitation",
      action: "invite",
      source: "manual",
      organizationStatus: org.status,
    });
    assertCanManageTargetRole(params.actor, params.invitedRole, "invite");

    const invitationId = randomUUID();
    const rawToken = `inv_${randomBytes(24).toString("base64url")}`;
    const tokenSha256 = sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + (params.expiresInSeconds ?? 86_400) * 1000).toISOString();

    const invitation = await withTenantTransaction(
      this.db,
      params.tenantId,
      async (tx) => {
        const res = await tx.query<{
          invitation_id: string;
          tenant_id: string;
          workspace_id: string;
          email: string;
          invited_role: WorkspaceRole;
          invited_by: string;
          token_sha256: string;
          status: InvitationRecord["status"];
          expires_at: Date | string;
          created_at: Date | string;
        }>(
          `INSERT INTO pa_invitations (
             tenant_id, invitation_id, workspace_id, email, invited_role,
             invited_by, token_sha256, status, expires_at
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, 'pending', $8::timestamptz)
           RETURNING invitation_id, tenant_id, workspace_id, email, invited_role, invited_by, token_sha256, status, expires_at, created_at`,
          [
            params.tenantId,
            invitationId,
            params.workspaceId,
            params.email.trim().toLowerCase(),
            params.invitedRole,
            params.actor.userId,
            tokenSha256,
            expiresAt,
          ],
        );

        // Audit NEVER logs rawToken — only invitationId and metadata (redaction enforced)
        await this.appendAuditLogTx(tx, {
          tenantId: params.tenantId,
          workspaceId: params.workspaceId,
          actorId: params.actor.userId,
          actorRole: params.actor.role,
          source: "manual",
          action: "invitation.created",
          outcome: "success",
          targetType: "invitation",
          targetId: invitationId,
          summary: `Invitation created for ${params.email.trim().toLowerCase()} as '${params.invitedRole}'.`,
          metadata: { invitedRole: params.invitedRole, expiresAt, raw_invite_token: rawToken },
        });

        const r = res.rows[0]!;
        return {
          invitationId: r.invitation_id,
          tenantId: r.tenant_id,
          workspaceId: r.workspace_id,
          email: r.email,
          invitedRole: r.invited_role,
          invitedBy: r.invited_by,
          tokenSha256: r.token_sha256,
          status: r.status,
          expiresAt: toIso(r.expires_at),
          createdAt: toIso(r.created_at),
        };
      },
      params.workspaceId,
    );

    return { invitation, rawToken };
  }

  async revokeInvitation(params: {
    actor: ActorContext;
    tenantId: string;
    workspaceId: string;
    invitationId: string;
  }): Promise<void> {
    assertPolicyAllowed({
      actor: params.actor,
      resourceTenantId: params.tenantId,
      resourceWorkspaceId: params.workspaceId,
      resource: "invitation",
      action: "revoke",
      source: "manual",
    });

    await withTenantTransaction(
      this.db,
      params.tenantId,
      async (tx) => {
        const invRes = await tx.query<{ invited_role: string; status: string }>(
          `SELECT invited_role, status
           FROM pa_invitations
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND invitation_id = $3::uuid
           FOR UPDATE`,
          [params.tenantId, params.workspaceId, params.invitationId],
        );
        const inv = invRes.rows[0];
        if (!inv || inv.status !== "pending") {
          throw new GovernanceError(404, "INVITATION_NOT_PENDING", "Invitation not found or no longer pending.");
        }
        if (!isWorkspaceRole(inv.invited_role)) {
          throw new GovernanceError(400, "INVALID_INVITED_ROLE", `Invalid invited role '${inv.invited_role}'.`);
        }
        assertCanManageTargetRole(params.actor, inv.invited_role, "revoke invitation for");

        await tx.query(
          `UPDATE pa_invitations
           SET status = 'revoked', revoked_at = now()
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND invitation_id = $3::uuid AND status = 'pending'`,
          [params.tenantId, params.workspaceId, params.invitationId],
        );
        await this.appendAuditLogTx(tx, {
          tenantId: params.tenantId,
          workspaceId: params.workspaceId,
          actorId: params.actor.userId,
          actorRole: params.actor.role,
          source: "manual",
          action: "invitation.revoked",
          outcome: "success",
          targetType: "invitation",
          targetId: params.invitationId,
          summary: `Invitation ${params.invitationId} revoked.`,
        });
      },
      params.workspaceId,
    );
  }

  async acceptInvitation(params: {
    tenantId: string;
    rawToken: string;
    acceptingUserId: string;
    acceptingEmail: string;
    nowIso?: string;
  }): Promise<{ workspaceId: string; role: WorkspaceRole; invitationId: string }> {
    const tokenHash = sha256Hex(params.rawToken);
    const nowIso = params.nowIso ?? new Date().toISOString();

    const txOutcome = await withTenantTransaction(
      this.db,
      params.tenantId,
      async (
        tx,
      ): Promise<
        | { expired: true }
        | { expired: false; workspaceId: string; role: WorkspaceRole; invitationId: string }
      > => {
        // Lock subscription row first to prevent concurrent seat-limit oversubscription (PLT-T05)
        const subRes = await tx.query<{ seat_limit: number; status: SubscriptionStatus }>(
          `SELECT seat_limit, status FROM pa_tenant_subscriptions
           WHERE tenant_id = $1::uuid FOR UPDATE`,
          [params.tenantId],
        );
        const sub = subRes.rows[0];

        const invRes = await tx.query<{
          invitation_id: string;
          workspace_id: string;
          email: string;
          invited_role: WorkspaceRole;
          status: InvitationRecord["status"];
          expires_at: Date | string;
        }>(
          `SELECT invitation_id, workspace_id, email, invited_role, status, expires_at
           FROM pa_invitations
           WHERE tenant_id = $1::uuid AND token_sha256 = $2
           FOR UPDATE`,
          [params.tenantId, tokenHash],
        );

        const inv = invRes.rows[0];
        if (!inv) {
          throw new GovernanceError(404, "INVITATION_INVALID", "Invitation token is invalid.");
        }
        if (inv.status === "accepted") {
          throw new GovernanceError(409, "INVITATION_ALREADY_CONSUMED", "Invitation token has already been used.");
        }
        if (inv.status === "revoked") {
          throw new GovernanceError(410, "INVITATION_REVOKED", "Invitation has been revoked.");
        }
        if (inv.status === "expired" || Date.parse(toIso(inv.expires_at)) <= Date.parse(nowIso)) {
          if (inv.status !== "expired") {
            await tx.query(
              `UPDATE pa_invitations SET status = 'expired' WHERE tenant_id = $1::uuid AND invitation_id = $2::uuid`,
              [params.tenantId, inv.invitation_id],
            );
          }
          // Return cleanly so PostgreSQL commits status='expired' before throwing 410 (F-05)
          return { expired: true };
        }
        if (inv.email.toLowerCase() !== params.acceptingEmail.trim().toLowerCase()) {
          throw new GovernanceError(403, "INVITATION_EMAIL_MISMATCH", "Invitation email does not match authenticated user.");
        }

        if (sub) {
          if (sub.status === "suspended" || sub.status === "canceled") {
            throw new GovernanceError(402, "SUBSCRIPTION_INACTIVE", "Tenant subscription is inactive.");
          }
          const alreadySeated = await tx.query<{ cnt: string | number }>(
            `SELECT COUNT(*) AS cnt FROM memberships
             WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND status = 'active'`,
            [params.tenantId, params.acceptingUserId],
          );
          if (Number(alreadySeated.rows[0]?.cnt ?? 0) === 0) {
            const activeSeatsRes = await tx.query<{ cnt: string | number }>(
              `SELECT COUNT(DISTINCT user_id) AS cnt FROM memberships
               WHERE tenant_id = $1::uuid AND status = 'active'`,
              [params.tenantId],
            );
            const activeSeats = Number(activeSeatsRes.rows[0]?.cnt ?? 0);
            if (activeSeats + 1 > sub.seat_limit) {
              throw new GovernanceError(
                402,
                "SEAT_LIMIT_EXCEEDED",
                `Tenant seat limit (${sub.seat_limit}) reached; cannot accept invitation.`,
              );
            }
          }
        }

        const contentAccess = inv.invited_role !== "billing_admin" && inv.invited_role !== "auditor";
        await tx.query(
          `INSERT INTO memberships (tenant_id, workspace_id, user_id, role, status, content_access)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', $5)
           ON CONFLICT (tenant_id, workspace_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, status = 'active', content_access = EXCLUDED.content_access`,
          [params.tenantId, inv.workspace_id, params.acceptingUserId, inv.invited_role, contentAccess],
        );

        await tx.query(
          `UPDATE pa_invitations SET status = 'accepted', consumed_at = $3::timestamptz
           WHERE tenant_id = $1::uuid AND invitation_id = $2::uuid`,
          [params.tenantId, inv.invitation_id, nowIso],
        );

        await this.appendAuditLogTx(tx, {
          tenantId: params.tenantId,
          workspaceId: inv.workspace_id,
          actorId: params.acceptingUserId,
          actorRole: inv.invited_role,
          source: "manual",
          action: "invitation.accepted",
          outcome: "success",
          targetType: "invitation",
          targetId: inv.invitation_id,
          summary: `Invitation accepted for workspace ${inv.workspace_id} with role '${inv.invited_role}'.`,
        });

        return {
          expired: false,
          workspaceId: inv.workspace_id,
          role: inv.invited_role,
          invitationId: inv.invitation_id,
        };
      },
    );

    if (txOutcome.expired) {
      throw new GovernanceError(410, "INVITATION_EXPIRED", "Invitation token has expired.");
    }
    return {
      workspaceId: txOutcome.workspaceId,
      role: txOutcome.role,
      invitationId: txOutcome.invitationId,
    };
  }

  // ---------------------------------------------------------------------------
  // Subscriptions, Entitlements, Atomic Quotas & Mock Billing Webhooks (PLT-06)
  // ---------------------------------------------------------------------------
  async assignTenantSubscription(params: {
    tenantId: string;
    planId: string;
    planVersion: number;
    status?: SubscriptionStatus;
    seatLimitOverride?: number;
    entitlementOverrides?: Partial<PlanEntitlements>;
  }): Promise<TenantSubscription> {
    const planRes = await this.db.query<{ entitlements_json: unknown }>(
      `SELECT entitlements_json FROM pa_plan_versions WHERE plan_id = $1 AND version = $2`,
      [params.planId, params.planVersion],
    );
    if (planRes.rows.length === 0) {
      throw new GovernanceError(404, "PLAN_VERSION_NOT_FOUND", `Plan '${params.planId}@v${params.planVersion}' not found.`);
    }
    const baseEntitlements = parseJsonColumn<PlanEntitlements>(planRes.rows[0]!.entitlements_json);
    const entitlements: PlanEntitlements = { ...baseEntitlements, ...(params.entitlementOverrides ?? {}) };
    const seatLimit = params.seatLimitOverride ?? entitlements.maxSeats;
    const status: SubscriptionStatus = params.status ?? "active";

    return withTenantTransaction(this.db, params.tenantId, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        plan_id: string;
        plan_version: number;
        status: SubscriptionStatus;
        seat_limit: number;
        entitlements_json: unknown;
        policy_version: number;
        updated_at: Date | string;
      }>(
        `INSERT INTO pa_tenant_subscriptions (
           tenant_id, plan_id, plan_version, status, seat_limit, entitlements_json, policy_version
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 1)
         ON CONFLICT (tenant_id) DO UPDATE
         SET plan_id = EXCLUDED.plan_id,
             plan_version = EXCLUDED.plan_version,
             status = EXCLUDED.status,
             seat_limit = EXCLUDED.seat_limit,
             entitlements_json = EXCLUDED.entitlements_json,
             policy_version = pa_tenant_subscriptions.policy_version + 1,
             updated_at = now()
         RETURNING tenant_id, plan_id, plan_version, status, seat_limit, entitlements_json, policy_version, updated_at`,
        [params.tenantId, params.planId, params.planVersion, status, seatLimit, JSON.stringify(entitlements)],
      );
      const r = res.rows[0]!;
      return {
        tenantId: r.tenant_id,
        planId: r.plan_id,
        planVersion: r.plan_version,
        status: r.status,
        seatLimit: r.seat_limit,
        entitlements: parseJsonColumn<PlanEntitlements>(r.entitlements_json),
        policyVersion: r.policy_version,
        updatedAt: toIso(r.updated_at),
      };
    });
  }

  async getTenantSubscription(tenantId: string): Promise<TenantSubscription | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        plan_id: string;
        plan_version: number;
        status: SubscriptionStatus;
        seat_limit: number;
        entitlements_json: unknown;
        policy_version: number;
        updated_at: Date | string;
      }>(
        `SELECT tenant_id, plan_id, plan_version, status, seat_limit, entitlements_json, policy_version, updated_at
         FROM pa_tenant_subscriptions WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const r = res.rows[0];
      if (!r) return null;
      return {
        tenantId: r.tenant_id,
        planId: r.plan_id,
        planVersion: r.plan_version,
        status: r.status,
        seatLimit: r.seat_limit,
        entitlements: parseJsonColumn<PlanEntitlements>(r.entitlements_json),
        policyVersion: r.policy_version,
        updatedAt: toIso(r.updated_at),
      };
    });
  }

  private async computeCurrentUsageTx(
    tx: PgQueryExecutor,
    tenantId: string,
    dimension: QuotaDimension,
    periodKey: string,
  ): Promise<number> {
    if (dimension === "concurrent_jobs") {
      const activeRes = await tx.query<{ total: string | number }>(
        `SELECT COALESCE(SUM(reserved_units), 0) AS total
         FROM pa_usage_reservations
         WHERE tenant_id = $1::uuid AND dimension = 'concurrent_jobs' AND status = 'reserved'`,
        [tenantId],
      );
      return Number(activeRes.rows[0]?.total ?? 0);
    }
    if (CUMULATIVE_QUOTA_DIMENSIONS.has(dimension)) {
      const cumRes = await tx.query<{ total: string | number }>(
        `SELECT COALESCE(SUM(
           CASE
             WHEN status = 'reserved' THEN reserved_units
             WHEN status = 'settled' THEN settled_units
             ELSE 0
           END
         ), 0) AS total
         FROM pa_usage_reservations
         WHERE tenant_id = $1::uuid AND dimension = $2`,
        [tenantId, dimension],
      );
      return Number(cumRes.rows[0]?.total ?? 0);
    }
    const usedRes = await tx.query<{ total: string | number }>(
      `SELECT COALESCE(SUM(
         CASE
           WHEN status = 'reserved' THEN reserved_units
           WHEN status = 'settled' THEN settled_units
           ELSE 0
         END
       ), 0) AS total
       FROM pa_usage_reservations
       WHERE tenant_id = $1::uuid AND dimension = $2 AND period_key = $3`,
      [tenantId, dimension, periodKey],
    );
    return Number(usedRes.rows[0]?.total ?? 0);
  }

  private mapUsageReservationRow(r: {
    reservation_id: string;
    tenant_id: string;
    workspace_id: string;
    actor_id: string;
    dimension: QuotaDimension;
    period_key: string;
    reserved_units: string | number;
    settled_units: string | number;
    status: UsageReservation["status"];
    idempotency_key: string;
    correlation_id: string;
    created_at: Date | string;
    updated_at: Date | string;
  }): UsageReservation {
    return {
      reservationId: r.reservation_id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      actorId: r.actor_id,
      dimension: r.dimension,
      periodKey: r.period_key,
      reservedUnits: Number(r.reserved_units),
      settledUnits: Number(r.settled_units),
      status: r.status,
      idempotencyKey: r.idempotency_key,
      correlationId: r.correlation_id,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  async reserveQuotaTx(
    tx: PgQueryExecutor,
    params: {
      tenantId: string;
      workspaceId: string;
      actorId: string;
      dimension: QuotaDimension;
      requestedUnits: number;
      periodKey?: string;
      idempotencyKey: string;
      correlationId: string;
    },
  ): Promise<UsageReservation> {
    if (!Number.isInteger(params.requestedUnits) || params.requestedUnits < 0) {
      throw new GovernanceError(400, "INVALID_QUOTA_UNITS", "Requested quota units must be a non-negative integer.");
    }
    const periodKey = params.periodKey ?? new Date().toISOString().slice(0, 7);

    // Serialize reservations per tenant with row lock on subscription BEFORE idempotency check (F-05)
    const subRes = await tx.query<{ status: SubscriptionStatus; entitlements_json: unknown }>(
      `SELECT status, entitlements_json FROM pa_tenant_subscriptions
       WHERE tenant_id = $1::uuid FOR UPDATE`,
      [params.tenantId],
    );
    const subRow = subRes.rows[0];
    if (!subRow) {
      throw new GovernanceError(402, "SUBSCRIPTION_NOT_FOUND", "Tenant has no active subscription configured.");
    }

    const existingRes = await tx.query<{
      reservation_id: string;
      tenant_id: string;
      workspace_id: string;
      actor_id: string;
      dimension: QuotaDimension;
      period_key: string;
      reserved_units: string | number;
      settled_units: string | number;
      status: UsageReservation["status"];
      idempotency_key: string;
      correlation_id: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT * FROM pa_usage_reservations
       WHERE tenant_id = $1::uuid AND idempotency_key = $2`,
      [params.tenantId, params.idempotencyKey],
    );
    if (existingRes.rows[0]) {
      return this.mapUsageReservationRow(existingRes.rows[0]);
    }

    if (subRow.status === "suspended" || subRow.status === "canceled" || subRow.status === "past_due") {
      throw new GovernanceError(
        402,
        "SUBSCRIPTION_RESTRICTED",
        `Cannot reserve metered quota while subscription status is '${subRow.status}'.`,
      );
    }

    const entitlements = parseJsonColumn<PlanEntitlements>(subRow.entitlements_json);
    const limit = getQuotaLimitForDimension(entitlements, params.dimension);
    const used = await this.computeCurrentUsageTx(tx, params.tenantId, params.dimension, periodKey);

    if (used + params.requestedUnits > limit) {
      throw new GovernanceError(
        429,
        "QUOTA_EXCEEDED",
        `Quota exceeded for '${params.dimension}' (used=${used}, requested=${params.requestedUnits}, limit=${limit}).`,
      );
    }

    const reservationId = randomUUID();
    const ins = await tx.query<{
      reservation_id: string;
      tenant_id: string;
      workspace_id: string;
      actor_id: string;
      dimension: QuotaDimension;
      period_key: string;
      reserved_units: string | number;
      settled_units: string | number;
      status: UsageReservation["status"];
      idempotency_key: string;
      correlation_id: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `INSERT INTO pa_usage_reservations (
         tenant_id, reservation_id, workspace_id, actor_id, dimension,
         period_key, reserved_units, settled_units, status, idempotency_key, correlation_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, 0, 'reserved', $8, $9)
       RETURNING *`,
      [
        params.tenantId,
        reservationId,
        params.workspaceId,
        params.actorId,
        params.dimension,
        periodKey,
        params.requestedUnits,
        params.idempotencyKey,
        params.correlationId,
      ],
    );
    return this.mapUsageReservationRow(ins.rows[0]!);
  }

  async reserveQuota(params: {
    tenantId: string;
    workspaceId: string;
    actorId: string;
    dimension: QuotaDimension;
    requestedUnits: number;
    periodKey?: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<UsageReservation> {
    return withTenantTransaction(this.db, params.tenantId, async (tx) => this.reserveQuotaTx(tx, params));
  }

  async settleQuotaTx(
    tx: PgQueryExecutor,
    params: {
      tenantId: string;
      reservationId: string;
      actualUnits: number;
      estimatedCostMicroUsd: number;
      source: UsageLedgerEntry["source"];
      providerId?: string;
      modelId?: string;
      isMock?: boolean;
      overagePolicy?: "enforce_cap" | "allow_overage";
    },
  ): Promise<{ reservation: UsageReservation; ledgerEntry: UsageLedgerEntry }> {
    if (!Number.isInteger(params.actualUnits) || params.actualUnits < 0) {
      throw new GovernanceError(400, "INVALID_QUOTA_UNITS", "Settled quota units must be a non-negative integer.");
    }

    // Acquire subscription lock BEFORE reservation lock to match reserveQuotaTx lock ordering
    const subRes = await tx.query<{ status: SubscriptionStatus; entitlements_json: unknown }>(
      `SELECT status, entitlements_json FROM pa_tenant_subscriptions
       WHERE tenant_id = $1::uuid FOR UPDATE`,
      [params.tenantId],
    );
    const subRow = subRes.rows[0];

    const resRow = await tx.query<{
      reservation_id: string;
      tenant_id: string;
      workspace_id: string;
      actor_id: string;
      dimension: QuotaDimension;
      period_key: string;
      reserved_units: string | number;
      settled_units: string | number;
      status: UsageReservation["status"];
      idempotency_key: string;
      correlation_id: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT * FROM pa_usage_reservations
       WHERE tenant_id = $1::uuid AND reservation_id = $2::uuid FOR UPDATE`,
      [params.tenantId, params.reservationId],
    );
    const existing = resRow.rows[0];
    if (!existing) {
      throw new GovernanceError(404, "RESERVATION_NOT_FOUND", "Usage reservation not found.");
    }
    if (existing.status !== "reserved") {
      throw new GovernanceError(
        409,
        "RESERVATION_NOT_ACTIVE",
        `Cannot settle reservation in status '${existing.status}'.`,
      );
    }

    const reservedUnits = Number(existing.reserved_units);
    if (
      params.actualUnits > reservedUnits &&
      subRow &&
      (params.overagePolicy ?? "enforce_cap") === "enforce_cap"
    ) {
      const delta = params.actualUnits - reservedUnits;
      const entitlements = parseJsonColumn<PlanEntitlements>(subRow.entitlements_json);
      const limit = getQuotaLimitForDimension(entitlements, existing.dimension);
      const currentUsed = await this.computeCurrentUsageTx(
        tx,
        params.tenantId,
        existing.dimension,
        existing.period_key,
      );
      if (currentUsed + delta > limit) {
        throw new GovernanceError(
          429,
          "QUOTA_EXCEEDED",
          `Quota exceeded on settlement for '${existing.dimension}' (used=${currentUsed}, overageDelta=${delta}, limit=${limit}).`,
        );
      }
    }

    const upd = await tx.query<{ updated_at: Date | string }>(
      `UPDATE pa_usage_reservations
       SET status = 'settled', settled_units = $3, updated_at = now()
       WHERE tenant_id = $1::uuid AND reservation_id = $2::uuid
       RETURNING updated_at`,
      [params.tenantId, params.reservationId, params.actualUnits],
    );

    const ledgerId = randomUUID();
    const ledIns = await tx.query<{ created_at: Date | string }>(
      `INSERT INTO pa_usage_ledger (
         tenant_id, ledger_id, workspace_id, actor_id, source, dimension,
         units, estimated_cost_microusd, provider_id, model_id,
         correlation_id, reservation_id, is_mock
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
         $7, $8, $9, $10, $11, $12::uuid, $13
       ) RETURNING created_at`,
      [
        params.tenantId,
        ledgerId,
        existing.workspace_id,
        existing.actor_id,
        params.source,
        existing.dimension,
        params.actualUnits,
        params.estimatedCostMicroUsd,
        params.providerId ?? null,
        params.modelId ?? null,
        existing.correlation_id,
        params.reservationId,
        params.isMock ?? true,
      ],
    );

    return {
      reservation: {
        ...this.mapUsageReservationRow(existing),
        settledUnits: params.actualUnits,
        status: "settled",
        updatedAt: toIso(upd.rows[0]!.updated_at),
      },
      ledgerEntry: {
        ledgerId,
        tenantId: params.tenantId,
        workspaceId: existing.workspace_id,
        actorId: existing.actor_id,
        source: params.source,
        dimension: existing.dimension,
        units: params.actualUnits,
        estimatedCostMicroUsd: params.estimatedCostMicroUsd,
        ...(params.providerId ? { providerId: params.providerId } : {}),
        ...(params.modelId ? { modelId: params.modelId } : {}),
        correlationId: existing.correlation_id,
        reservationId: params.reservationId,
        isMock: params.isMock ?? true,
        createdAt: toIso(ledIns.rows[0]!.created_at),
      },
    };
  }

  async settleQuota(params: {
    tenantId: string;
    reservationId: string;
    actualUnits: number;
    estimatedCostMicroUsd: number;
    source: UsageLedgerEntry["source"];
    providerId?: string;
    modelId?: string;
    isMock?: boolean;
    overagePolicy?: "enforce_cap" | "allow_overage";
  }): Promise<{ reservation: UsageReservation; ledgerEntry: UsageLedgerEntry }> {
    return withTenantTransaction(this.db, params.tenantId, async (tx) => this.settleQuotaTx(tx, params));
  }

  async releaseQuotaTx(tx: PgQueryExecutor, tenantId: string, reservationId: string): Promise<boolean> {
    const upd = await tx.query(
      `UPDATE pa_usage_reservations
       SET status = 'released', settled_units = 0, updated_at = now()
       WHERE tenant_id = $1::uuid AND reservation_id = $2::uuid AND status = 'reserved'`,
      [tenantId, reservationId],
    );
    return upd.rowCount > 0;
  }

  async releaseQuota(tenantId: string, reservationId: string): Promise<boolean> {
    return withTenantTransaction(this.db, tenantId, async (tx) =>
      this.releaseQuotaTx(tx, tenantId, reservationId),
    );
  }

  async listUsageLedger(
    actor: ActorContext,
    tenantId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<UsageLedgerEntry[]> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: tenantId,
      resource: "usage",
      action: "read",
      source: "manual",
    });

    const { limit, offset } = clampGovernancePagination(options);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const res = await tx.query<{
        ledger_id: string;
        tenant_id: string;
        workspace_id: string;
        actor_id: string;
        source: UsageLedgerEntry["source"];
        dimension: QuotaDimension;
        units: string | number;
        estimated_cost_microusd: string | number;
        provider_id: string | null;
        model_id: string | null;
        correlation_id: string;
        reservation_id: string | null;
        is_mock: boolean;
        created_at: Date | string;
      }>(
        `SELECT * FROM pa_usage_ledger WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset],
      );
      return res.rows.map((r) => ({
        ledgerId: r.ledger_id,
        tenantId: r.tenant_id,
        workspaceId: r.workspace_id,
        actorId: r.actor_id,
        source: r.source,
        dimension: r.dimension,
        units: Number(r.units),
        estimatedCostMicroUsd: Number(r.estimated_cost_microusd),
        ...(r.provider_id ? { providerId: r.provider_id } : {}),
        ...(r.model_id ? { modelId: r.model_id } : {}),
        correlationId: r.correlation_id,
        ...(r.reservation_id ? { reservationId: r.reservation_id } : {}),
        isMock: r.is_mock,
        createdAt: toIso(r.created_at),
      }));
    });
  }

  async processMockBillingWebhook(params: {
    rawPayload: string;
    signatureHex: string;
  }): Promise<{ deduplicated: boolean; staleIgnored?: boolean; subscription: TenantSubscription }> {
    const expectedSig = signMockBillingWebhook(params.rawPayload, this.billingWebhookSecret);
    if (!/^[0-9a-f]{64}$/i.test(params.signatureHex)) {
      throw new GovernanceError(401, "INVALID_WEBHOOK_SIGNATURE", "Malformed billing webhook signature.");
    }
    const a = Buffer.from(params.signatureHex, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new GovernanceError(401, "INVALID_WEBHOOK_SIGNATURE", "Billing webhook HMAC signature mismatch.");
    }

    let event: BillingWebhookEvent;
    try {
      event = JSON.parse(params.rawPayload) as BillingWebhookEvent;
    } catch {
      throw new GovernanceError(400, "INVALID_WEBHOOK_PAYLOAD", "Billing webhook payload must be valid JSON.");
    }
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.providerEventId !== "string" ||
      !event.providerEventId.trim() ||
      typeof event.tenantId !== "string" ||
      !UUID_PATTERN.test(event.tenantId) ||
      !ALLOWED_BILLING_EVENT_TYPES.has(event.eventType) ||
      typeof event.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(event.occurredAt))
    ) {
      throw new GovernanceError(400, "INVALID_WEBHOOK_PAYLOAD", "Billing webhook payload failed schema validation.");
    }
    if (event.isMock !== true) {
      throw new GovernanceError(400, "LIVE_BILLING_NOT_AUTHORIZED", "Only mock billing webhooks are permitted in PA-00.");
    }
    const payloadHash = sha256Hex(params.rawPayload);

    return withTenantTransaction(this.db, event.tenantId, async (tx) => {
      type SubRow = {
        tenant_id: string;
        plan_id: string;
        plan_version: number;
        status: SubscriptionStatus;
        seat_limit: number;
        entitlements_json: unknown;
        policy_version: number;
        last_billing_event_at: Date | string | null;
        updated_at: Date | string;
      };
      const mapSub = (r: SubRow): TenantSubscription => ({
        tenantId: r.tenant_id,
        planId: r.plan_id,
        planVersion: r.plan_version,
        status: r.status,
        seatLimit: r.seat_limit,
        entitlements: parseJsonColumn<PlanEntitlements>(r.entitlements_json),
        policyVersion: r.policy_version,
        updatedAt: toIso(r.updated_at),
      });

      const currentRes = await tx.query<SubRow>(
        `SELECT * FROM pa_tenant_subscriptions WHERE tenant_id = $1::uuid FOR UPDATE`,
        [event.tenantId],
      );
      const currentRow = currentRes.rows[0];
      if (!currentRow) {
        throw new GovernanceError(404, "SUBSCRIPTION_NOT_FOUND", "Target tenant subscription not found.");
      }

      const webhookIns = await tx.query<{ provider_event_id: string }>(
        `INSERT INTO pa_billing_webhooks (
           tenant_id, provider_event_id, event_type, signature_verified, payload_sha256
         ) VALUES ($1::uuid, $2, $3, true, $4)
         ON CONFLICT (tenant_id, provider_event_id) DO NOTHING
         RETURNING provider_event_id`,
        [event.tenantId, event.providerEventId, event.eventType, payloadHash],
      );
      if (webhookIns.rows.length === 0) {
        return {
          deduplicated: true,
          subscription: mapSub(currentRow),
        };
      }

      if (
        currentRow.last_billing_event_at &&
        Date.parse(event.occurredAt) < Date.parse(toIso(currentRow.last_billing_event_at))
      ) {
        return {
          deduplicated: false,
          staleIgnored: true,
          subscription: mapSub(currentRow),
        };
      }

      let nextStatus: SubscriptionStatus | null = null;
      if (event.eventType === "subscription.past_due") nextStatus = "past_due";
      else if (event.eventType === "subscription.grace") nextStatus = "grace";
      else if (event.eventType === "subscription.canceled") nextStatus = "canceled";
      else if (
        event.eventType === "subscription.reactivated" ||
        event.eventType === "subscription.upgraded" ||
        event.eventType === "subscription.downgraded"
      ) {
        nextStatus = "active";
      }

      if (event.planId && event.planVersion) {
        const planRes = await tx.query<{ entitlements_json: unknown }>(
          `SELECT entitlements_json FROM pa_plan_versions WHERE plan_id = $1 AND version = $2`,
          [event.planId, event.planVersion],
        );
        if (planRes.rows.length === 0) {
          throw new GovernanceError(404, "PLAN_VERSION_NOT_FOUND", `Plan '${event.planId}@v${event.planVersion}' not found.`);
        }
        const ent = parseJsonColumn<PlanEntitlements>(planRes.rows[0]!.entitlements_json);
        await tx.query(
          `UPDATE pa_tenant_subscriptions
           SET plan_id = $2, plan_version = $3, status = COALESCE($4, status),
               seat_limit = $5, entitlements_json = $6::jsonb,
               last_billing_event_at = $7::timestamptz,
               policy_version = policy_version + 1, updated_at = now()
           WHERE tenant_id = $1::uuid`,
          [
            event.tenantId,
            event.planId,
            event.planVersion,
            nextStatus,
            ent.maxSeats,
            JSON.stringify(ent),
            event.occurredAt,
          ],
        );
      } else if (nextStatus) {
        await tx.query(
          `UPDATE pa_tenant_subscriptions
           SET status = $2,
               last_billing_event_at = $3::timestamptz,
               policy_version = policy_version + 1,
               updated_at = now()
           WHERE tenant_id = $1::uuid`,
          [event.tenantId, nextStatus, event.occurredAt],
        );
      } else {
        await tx.query(
          `UPDATE pa_tenant_subscriptions
           SET last_billing_event_at = $2::timestamptz, updated_at = now()
           WHERE tenant_id = $1::uuid`,
          [event.tenantId, event.occurredAt],
        );
      }

      const updated = await tx.query<SubRow>(`SELECT * FROM pa_tenant_subscriptions WHERE tenant_id = $1::uuid`, [
        event.tenantId,
      ]);
      return {
        deduplicated: false,
        subscription: mapSub(updated.rows[0]!),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Private Versioned File Metadata, Quarantine, Recovery & Legal Hold (PLT-03)
  // ---------------------------------------------------------------------------
  private async getWorkspaceVisibilityTx(
    tx: PgQueryExecutor,
    tenantId: string,
    workspaceId: string,
  ): Promise<WorkspaceVisibility> {
    const res = await tx.query<{ visibility: WorkspaceVisibility }>(
      `SELECT visibility FROM workspaces WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid`,
      [tenantId, workspaceId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new GovernanceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    return row.visibility;
  }

  async registerFileObject(params: {
    actor: ActorContext;
    objectId: string;
    version: number;
    storageKey: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    classification: ArtifactClassification;
    quarantineState?: FileQuarantineState;
    legalHold?: boolean;
    retentionUntil?: string;
  }): Promise<VersionedFileObject> {
    assertPolicyAllowed({
      actor: params.actor,
      resourceTenantId: params.actor.tenantId,
      resourceWorkspaceId: params.actor.workspaceId,
      resource: "file",
      action: "create",
      source: "manual",
      classification: params.classification,
    });

    return withTenantTransaction(
      this.db,
      params.actor.tenantId,
      async (tx) => {
        const workspaceVisibility = await this.getWorkspaceVisibilityTx(
          tx,
          params.actor.tenantId,
          params.actor.workspaceId,
        );
        assertPolicyAllowed({
          actor: params.actor,
          resourceTenantId: params.actor.tenantId,
          resourceWorkspaceId: params.actor.workspaceId,
          resource: "file",
          action: "create",
          source: "manual",
          workspaceVisibility,
          classification: params.classification,
        });

        const res = await tx.query<{ created_at: Date | string }>(
          `INSERT INTO pa_file_objects (
             tenant_id, workspace_id, object_id, version, storage_key, filename,
             mime_type, byte_size, sha256, classification, quarantine_state,
             legal_hold, retention_until, created_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::uuid
           ) RETURNING created_at`,
          [
            params.actor.tenantId,
            params.actor.workspaceId,
            params.objectId,
            params.version,
            params.storageKey,
            params.filename,
            params.mimeType,
            params.byteSize,
            params.sha256,
            params.classification,
            params.quarantineState ?? "pending_scan",
            params.legalHold ?? false,
            params.retentionUntil ?? null,
            params.actor.userId,
          ],
        );

        await this.appendAuditLogTx(tx, {
          tenantId: params.actor.tenantId,
          workspaceId: params.actor.workspaceId,
          actorId: params.actor.userId,
          actorRole: params.actor.role,
          source: "manual",
          action: "file.registered",
          outcome: "success",
          targetType: "file",
          targetId: `${params.objectId}@v${params.version}`,
          summary: `Registered file '${params.filename}' v${params.version} (${params.quarantineState ?? "pending_scan"}).`,
        });

        return {
          tenantId: params.actor.tenantId,
          workspaceId: params.actor.workspaceId,
          objectId: params.objectId,
          version: params.version,
          storageKey: params.storageKey,
          filename: params.filename,
          mimeType: params.mimeType,
          byteSize: params.byteSize,
          sha256: params.sha256,
          classification: params.classification,
          quarantineState: params.quarantineState ?? "pending_scan",
          legalHold: params.legalHold ?? false,
          ...(params.retentionUntil ? { retentionUntil: params.retentionUntil } : {}),
          createdBy: params.actor.userId,
          createdAt: toIso(res.rows[0]!.created_at),
        };
      },
      params.actor.workspaceId,
    );
  }

  async updateFileQuarantineState(params: {
    actor: ActorContext;
    objectId: string;
    version: number;
    quarantineState: FileQuarantineState;
  }): Promise<void> {
    assertPolicyAllowed({
      actor: params.actor,
      resourceTenantId: params.actor.tenantId,
      resourceWorkspaceId: params.actor.workspaceId,
      resource: "file",
      action: "quarantine",
      source: "manual",
    });

    await withTenantTransaction(
      this.db,
      params.actor.tenantId,
      async (tx) => {
        const workspaceVisibility = await this.getWorkspaceVisibilityTx(
          tx,
          params.actor.tenantId,
          params.actor.workspaceId,
        );
        assertPolicyAllowed({
          actor: params.actor,
          resourceTenantId: params.actor.tenantId,
          resourceWorkspaceId: params.actor.workspaceId,
          resource: "file",
          action: "quarantine",
          source: "manual",
          workspaceVisibility,
        });

        const existingRes = await tx.query<{ classification: ArtifactClassification }>(
          `SELECT classification
           FROM pa_file_objects
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $4
           FOR UPDATE`,
          [params.actor.tenantId, params.actor.workspaceId, params.objectId, params.version],
        );
        const existing = existingRes.rows[0];
        if (!existing) {
          throw new GovernanceError(404, "FILE_NOT_FOUND", "File object version not found.");
        }
        assertPolicyAllowed({
          actor: params.actor,
          resourceTenantId: params.actor.tenantId,
          resourceWorkspaceId: params.actor.workspaceId,
          resource: "file",
          action: "quarantine",
          source: "manual",
          workspaceVisibility,
          classification: existing.classification,
        });

        await tx.query(
          `UPDATE pa_file_objects
           SET quarantine_state = $4
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $5`,
          [params.actor.tenantId, params.actor.workspaceId, params.objectId, params.quarantineState, params.version],
        );
        await this.appendAuditLogTx(tx, {
          tenantId: params.actor.tenantId,
          workspaceId: params.actor.workspaceId,
          actorId: params.actor.userId,
          actorRole: params.actor.role,
          source: "manual",
          action: "file.quarantine_updated",
          outcome: "success",
          targetType: "file",
          targetId: `${params.objectId}@v${params.version}`,
          summary: `Updated file '${params.objectId}' v${params.version} quarantine state to '${params.quarantineState}'.`,
        });
      },
      params.actor.workspaceId,
    );
  }

  async softDeleteFileObject(actor: ActorContext, objectId: string, version: number): Promise<void> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "file",
      action: "delete",
      source: "manual",
    });
    await withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        const workspaceVisibility = await this.getWorkspaceVisibilityTx(tx, actor.tenantId, actor.workspaceId);
        assertPolicyAllowed({
          actor,
          resourceTenantId: actor.tenantId,
          resourceWorkspaceId: actor.workspaceId,
          resource: "file",
          action: "delete",
          source: "manual",
          workspaceVisibility,
        });

        const existingRes = await tx.query<{ classification: ArtifactClassification }>(
          `SELECT classification
           FROM pa_file_objects
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $4
           FOR UPDATE`,
          [actor.tenantId, actor.workspaceId, objectId, version],
        );
        const existing = existingRes.rows[0];
        if (!existing) {
          throw new GovernanceError(404, "FILE_NOT_FOUND", "File object version not found.");
        }
        assertPolicyAllowed({
          actor,
          resourceTenantId: actor.tenantId,
          resourceWorkspaceId: actor.workspaceId,
          resource: "file",
          action: "delete",
          source: "manual",
          workspaceVisibility,
          classification: existing.classification,
        });

        await tx.query(
          `UPDATE pa_file_objects SET deleted_at = now()
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $4`,
          [actor.tenantId, actor.workspaceId, objectId, version],
        );
        await this.appendAuditLogTx(tx, {
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "manual",
          action: "file.soft_deleted",
          outcome: "success",
          targetType: "file",
          targetId: `${objectId}@v${version}`,
          summary: `Soft-deleted file '${objectId}' v${version}.`,
        });
      },
      actor.workspaceId,
    );
  }

  async recoverFileObject(actor: ActorContext, objectId: string, version: number): Promise<void> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "file",
      action: "recover",
      source: "manual",
    });
    await withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        const workspaceVisibility = await this.getWorkspaceVisibilityTx(tx, actor.tenantId, actor.workspaceId);
        assertPolicyAllowed({
          actor,
          resourceTenantId: actor.tenantId,
          resourceWorkspaceId: actor.workspaceId,
          resource: "file",
          action: "recover",
          source: "manual",
          workspaceVisibility,
        });

        const existingRes = await tx.query<{
          classification: ArtifactClassification;
          deleted_at: Date | string | null;
        }>(
          `SELECT classification, deleted_at
           FROM pa_file_objects
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $4
           FOR UPDATE`,
          [actor.tenantId, actor.workspaceId, objectId, version],
        );
        const existing = existingRes.rows[0];
        if (!existing) {
          throw new GovernanceError(404, "FILE_NOT_DELETED", "Deleted file version not found for recovery.");
        }
        assertPolicyAllowed({
          actor,
          resourceTenantId: actor.tenantId,
          resourceWorkspaceId: actor.workspaceId,
          resource: "file",
          action: "recover",
          source: "manual",
          workspaceVisibility,
          classification: existing.classification,
        });
        if (existing.deleted_at == null) {
          throw new GovernanceError(404, "FILE_NOT_DELETED", "Deleted file version not found for recovery.");
        }

        await tx.query(
          `UPDATE pa_file_objects SET deleted_at = NULL
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $4`,
          [actor.tenantId, actor.workspaceId, objectId, version],
        );
        await this.appendAuditLogTx(tx, {
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "manual",
          action: "file.recovered",
          outcome: "success",
          targetType: "file",
          targetId: `${objectId}@v${version}`,
          summary: `Recovered soft-deleted file '${objectId}' v${version}.`,
        });
      },
      actor.workspaceId,
    );
  }

  async purgeFileObject(actor: ActorContext, objectId: string, version: number): Promise<string> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "file",
      action: "delete",
      source: "manual",
    });
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        const workspaceVisibility = await this.getWorkspaceVisibilityTx(tx, actor.tenantId, actor.workspaceId);
        assertPolicyAllowed({
          actor,
          resourceTenantId: actor.tenantId,
          resourceWorkspaceId: actor.workspaceId,
          resource: "file",
          action: "delete",
          source: "manual",
          workspaceVisibility,
        });

        const res = await tx.query<{
          classification: ArtifactClassification;
          legal_hold: boolean;
          storage_key: string;
          retention_until: Date | string | null;
        }>(
          `SELECT classification, legal_hold, storage_key, retention_until FROM pa_file_objects
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $4 FOR UPDATE`,
          [actor.tenantId, actor.workspaceId, objectId, version],
        );
        const row = res.rows[0];
        if (!row) throw new GovernanceError(404, "FILE_NOT_FOUND", "File object version not found.");
        assertPolicyAllowed({
          actor,
          resourceTenantId: actor.tenantId,
          resourceWorkspaceId: actor.workspaceId,
          resource: "file",
          action: "delete",
          source: "manual",
          workspaceVisibility,
          classification: row.classification,
        });
        if (row.legal_hold) {
          throw new GovernanceError(423, "LEGAL_HOLD_ACTIVE", "Cannot purge file object while legal hold is active.");
        }
        if (row.retention_until && Date.parse(toIso(row.retention_until)) > Date.now()) {
          throw new GovernanceError(423, "RETENTION_WINDOW_ACTIVE", "Cannot purge file before retention window expires.");
        }
        await tx.query(
          `DELETE FROM pa_file_objects
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND object_id = $3 AND version = $4`,
          [actor.tenantId, actor.workspaceId, objectId, version],
        );
        await this.appendAuditLogTx(tx, {
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "manual",
          action: "file.purged",
          outcome: "success",
          targetType: "file",
          targetId: `${objectId}@v${version}`,
          summary: `Permanently purged file '${objectId}' v${version}.`,
        });
        return row.storage_key;
      },
      actor.workspaceId,
    );
  }

  async listFileObjects(
    actor: ActorContext,
    options: { includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<VersionedFileObject[]> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "file",
      action: "read",
      source: "manual",
    });
    const { limit, offset } = clampGovernancePagination(options);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        const workspaceVisibility = await this.getWorkspaceVisibilityTx(tx, actor.tenantId, actor.workspaceId);
        assertPolicyAllowed({
          actor,
          resourceTenantId: actor.tenantId,
          resourceWorkspaceId: actor.workspaceId,
          resource: "file",
          action: "read",
          source: "manual",
          workspaceVisibility,
        });

        const restrictedFilter = actor.workspaceContentGrant === true ? "" : "AND classification <> 'restricted'";
        const res = await tx.query<{
          tenant_id: string;
          workspace_id: string;
          object_id: string;
          version: number;
          storage_key: string;
          filename: string;
          mime_type: string;
          byte_size: string | number;
          sha256: string;
          classification: ArtifactClassification;
          quarantine_state: FileQuarantineState;
          legal_hold: boolean;
          retention_until: Date | string | null;
          deleted_at: Date | string | null;
          created_by: string;
          created_at: Date | string;
        }>(
          `SELECT * FROM pa_file_objects
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
             ${options.includeDeleted ? "" : "AND deleted_at IS NULL"}
             ${restrictedFilter}
           ORDER BY object_id, version ASC
           LIMIT $3 OFFSET $4`,
          [actor.tenantId, actor.workspaceId, limit, offset],
        );
        return res.rows.map((r) => ({
          tenantId: r.tenant_id,
          workspaceId: r.workspace_id,
          objectId: r.object_id,
          version: r.version,
          storageKey: r.storage_key,
          filename: r.filename,
          mimeType: r.mime_type,
          byteSize: Number(r.byte_size),
          sha256: r.sha256,
          classification: r.classification,
          quarantineState: r.quarantine_state,
          legalHold: r.legal_hold,
          ...(r.retention_until ? { retentionUntil: toIso(r.retention_until) } : {}),
          ...(r.deleted_at ? { deletedAt: toIso(r.deleted_at) } : {}),
          createdBy: r.created_by,
          createdAt: toIso(r.created_at),
        }));
      },
      actor.workspaceId,
    );
  }

  // ---------------------------------------------------------------------------
  // Durable Fenced-Lease Job Queue (PLT-05 / PLT-T29..T32)
  // ---------------------------------------------------------------------------
  async enqueueJob(params: {
    actor: ActorContext;
    jobType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    simulateFailureBeforeCommit?: boolean;
  }): Promise<{ job: DurableJobRecord; deduplicated: boolean }> {
    return withTenantTransaction(
      this.db,
      params.actor.tenantId,
      async (tx) => {
        const subRes = await tx.query<{
          tenant_id: string;
          plan_id: string;
          plan_version: number;
          status: SubscriptionStatus;
          seat_limit: number;
          entitlements_json: unknown;
          policy_version: number;
          updated_at: Date | string;
        }>(`SELECT * FROM pa_tenant_subscriptions WHERE tenant_id = $1::uuid FOR UPDATE`, [
          params.actor.tenantId,
        ]);
        const subRow = subRes.rows[0];
        const sub: TenantSubscription | undefined = subRow
          ? {
              tenantId: subRow.tenant_id,
              planId: subRow.plan_id,
              planVersion: subRow.plan_version,
              status: subRow.status,
              seatLimit: subRow.seat_limit,
              entitlements: parseJsonColumn<PlanEntitlements>(subRow.entitlements_json),
              policyVersion: subRow.policy_version,
              updatedAt: toIso(subRow.updated_at),
            }
          : undefined;

        assertPolicyAllowed({
          actor: params.actor,
          resourceTenantId: params.actor.tenantId,
          resourceWorkspaceId: params.actor.workspaceId,
          resource: "job",
          action: "create",
          source: "workflow",
          ...(sub ? { subscription: sub } : {}),
        });

        const existingRes = await tx.query<Record<string, unknown>>(
          `SELECT * FROM pa_jobs
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND idempotency_key = $3`,
          [params.actor.tenantId, params.actor.workspaceId, params.idempotencyKey],
        );
        if (existingRes.rows[0]) {
          return { job: this.mapJobRow(existingRes.rows[0]), deduplicated: true };
        }

        let reservationId: string | undefined;
        if (sub) {
          const reservation = await this.reserveQuotaTx(tx, {
            tenantId: params.actor.tenantId,
            workspaceId: params.actor.workspaceId,
            actorId: params.actor.userId,
            dimension: "concurrent_jobs",
            requestedUnits: 1,
            idempotencyKey: `job-slot:${params.actor.workspaceId}:${params.idempotencyKey}`,
            correlationId: params.idempotencyKey,
          });
          reservationId = reservation.reservationId;
        }

        const jobId = randomUUID();
        const ins = await tx.query<Record<string, unknown>>(
          `INSERT INTO pa_jobs (
             tenant_id, job_id, workspace_id, actor_id, job_type,
             idempotency_key, state, payload_json, max_attempts, reservation_id
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
             $6, 'queued', $7::jsonb, $8, $9::uuid
           )
           ON CONFLICT (tenant_id, workspace_id, idempotency_key) DO NOTHING
           RETURNING *`,
          [
            params.actor.tenantId,
            jobId,
            params.actor.workspaceId,
            params.actor.userId,
            params.jobType,
            params.idempotencyKey,
            JSON.stringify(params.payload),
            params.maxAttempts ?? 3,
            reservationId ?? null,
          ],
        );
        if (ins.rows.length === 0) {
          if (reservationId) {
            await this.releaseQuotaTx(tx, params.actor.tenantId, reservationId);
          }
          const dupAfter = await tx.query<Record<string, unknown>>(
            `SELECT * FROM pa_jobs
             WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND idempotency_key = $3`,
            [params.actor.tenantId, params.actor.workspaceId, params.idempotencyKey],
          );
          return { job: this.mapJobRow(dupAfter.rows[0]!), deduplicated: true };
        }

        if (params.simulateFailureBeforeCommit) {
          throw new Error("SIMULATED_ENQUEUE_FAILURE_BEFORE_COMMIT: Testing atomic job and quota rollback.");
        }

        return { job: this.mapJobRow(ins.rows[0]!), deduplicated: false };
      },
      params.actor.workspaceId,
    );
  }

  async claimNextJobLease(params: {
    tenantId: string;
    workerId: string;
    leaseDurationMs?: number;
  }): Promise<DurableJobRecord | null> {
    const leaseMs = params.leaseDurationMs ?? 30_000;
    const leaseToken = `lease_${randomBytes(16).toString("hex")}`;
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();

    return withTenantTransaction(this.db, params.tenantId, async (tx) => {
      const next = await tx.query<{ job_id: string }>(
        `SELECT job_id FROM pa_jobs
         WHERE tenant_id = $1::uuid AND state = 'queued'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [params.tenantId],
      );
      const target = next.rows[0];
      if (!target) return null;

      const upd = await tx.query<Record<string, unknown>>(
        `UPDATE pa_jobs
         SET state = 'running',
             lease_token = $3,
             fencing_generation = fencing_generation + 1,
             worker_id = $4,
             lease_expires_at = $5::timestamptz,
             heartbeat_at = now(),
             attempt = attempt + 1,
             updated_at = now()
         WHERE tenant_id = $1::uuid AND job_id = $2::uuid
         RETURNING *`,
        [params.tenantId, target.job_id, leaseToken, params.workerId, expiresAt],
      );
      return this.mapJobRow(upd.rows[0]!);
    });
  }

  async heartbeatJobLease(params: {
    tenantId: string;
    jobId: string;
    leaseToken: string;
    fencingGeneration: number;
    extendMs?: number;
    nowIso?: string;
  }): Promise<DurableJobRecord> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
      throw new GovernanceError(400, "INVALID_TIMESTAMP", "Heartbeat timestamp must be valid ISO date.");
    }
    const nextExpiry = new Date(nowMs + (params.extendMs ?? 30_000)).toISOString();
    return withTenantTransaction(this.db, params.tenantId, async (tx) => {
      const upd = await tx.query<Record<string, unknown>>(
        `UPDATE pa_jobs
         SET heartbeat_at = $6::timestamptz, lease_expires_at = $5::timestamptz, updated_at = now()
         WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND state = 'running'
           AND lease_token = $3 AND fencing_generation = $4
           AND lease_expires_at > $6::timestamptz
         RETURNING *`,
        [params.tenantId, params.jobId, params.leaseToken, params.fencingGeneration, nextExpiry, nowIso],
      );
      if (upd.rows.length === 0) {
        throw new GovernanceError(
          409,
          "STALE_LEASE_FENCING_CONFLICT",
          "Job lease heartbeat rejected: stale lease token, expired lease, or fencing generation mismatch.",
        );
      }
      return this.mapJobRow(upd.rows[0]!);
    });
  }

  async completeJob(params: {
    tenantId: string;
    jobId: string;
    leaseToken: string;
    fencingGeneration: number;
    result: Record<string, unknown>;
    nowIso?: string;
  }): Promise<DurableJobRecord> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    return withTenantTransaction(this.db, params.tenantId, async (tx) => {
      const upd = await tx.query<Record<string, unknown>>(
        `UPDATE pa_jobs
         SET state = 'completed', result_json = $5::jsonb, lease_token = NULL,
             lease_expires_at = NULL, updated_at = now()
         WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND state = 'running'
           AND lease_token = $3 AND fencing_generation = $4
           AND (lease_expires_at IS NULL OR lease_expires_at > $6::timestamptz)
         RETURNING *`,
        [
          params.tenantId,
          params.jobId,
          params.leaseToken,
          params.fencingGeneration,
          JSON.stringify(params.result),
          nowIso,
        ],
      );
      if (upd.rows.length === 0) {
        throw new GovernanceError(
          409,
          "STALE_LEASE_FENCING_CONFLICT",
          "Stale worker attempted to commit job completion after lease loss or cancellation.",
        );
      }
      const completed = this.mapJobRow(upd.rows[0]!);
      if (completed.reservationId) {
        await this.settleQuotaTx(tx, {
          tenantId: params.tenantId,
          reservationId: completed.reservationId,
          actualUnits: 1,
          estimatedCostMicroUsd: 0,
          source: "workflow",
          isMock: true,
        });
      }
      return completed;
    });
  }

  async requestJobCancellation(actor: ActorContext, jobId: string): Promise<DurableJobRecord> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "job",
      action: "cancel",
      source: "manual",
    });

    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        const upd = await tx.query<Record<string, unknown>>(
          `UPDATE pa_jobs
           SET state = 'canceled', cancel_requested_at = now(), lease_token = NULL,
               lease_expires_at = NULL, updated_at = now()
           WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND job_id = $3::uuid
             AND state IN ('queued', 'running')
           RETURNING *`,
          [actor.tenantId, actor.workspaceId, jobId],
        );
        if (upd.rows.length === 0) {
          throw new GovernanceError(409, "JOB_NOT_CANCELABLE", "Job is not in a cancelable state.");
        }
        const canceled = this.mapJobRow(upd.rows[0]!);
        if (canceled.reservationId) {
          await this.releaseQuotaTx(tx, actor.tenantId, canceled.reservationId);
        }
        return canceled;
      },
      actor.workspaceId,
    );
  }

  async reclaimExpiredLeases(tenantId: string, nowIso?: string): Promise<{ requeued: string[]; deadLettered: string[] }> {
    const checkIso = nowIso ?? new Date().toISOString();

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const expired = await tx.query<{ job_id: string; attempt: number; max_attempts: number; reservation_id: string | null }>(
        `SELECT job_id, attempt, max_attempts, reservation_id
         FROM pa_jobs
         WHERE tenant_id = $1::uuid AND state = 'running' AND lease_expires_at <= $2::timestamptz
         FOR UPDATE`,
        [tenantId, checkIso],
      );

      const requeued: string[] = [];
      const deadLettered: string[] = [];

      for (const row of expired.rows) {
        if (row.attempt >= row.max_attempts) {
          await tx.query(
            `UPDATE pa_jobs
             SET state = 'dead_letter', lease_token = NULL, lease_expires_at = NULL,
                 error_json = $3::jsonb, updated_at = now()
             WHERE tenant_id = $1::uuid AND job_id = $2::uuid`,
            [
              tenantId,
              row.job_id,
              JSON.stringify({ code: "MAX_ATTEMPTS_EXCEEDED", message: "Worker lease expired after max attempts." }),
            ],
          );
          deadLettered.push(row.job_id);
          if (row.reservation_id) {
            await this.releaseQuotaTx(tx, tenantId, row.reservation_id);
          }
        } else {
          await tx.query(
            `UPDATE pa_jobs
             SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
             WHERE tenant_id = $1::uuid AND job_id = $2::uuid`,
            [tenantId, row.job_id],
          );
          requeued.push(row.job_id);
        }
      }
      return { requeued, deadLettered };
    });
  }

  private mapJobRow(r: Record<string, unknown>): DurableJobRecord {
    return {
      jobId: String(r.job_id),
      tenantId: String(r.tenant_id),
      workspaceId: String(r.workspace_id),
      actorId: String(r.actor_id),
      jobType: String(r.job_type),
      idempotencyKey: String(r.idempotency_key),
      state: r.state as DurableJobRecord["state"],
      payload: parseJsonColumn<Record<string, unknown>>(r.payload_json),
      ...(r.result_json ? { result: parseJsonColumn<Record<string, unknown>>(r.result_json) } : {}),
      ...(r.error_json ? { error: parseJsonColumn<{ code: string; message: string }>(r.error_json) } : {}),
      ...(r.lease_token ? { leaseToken: String(r.lease_token) } : {}),
      fencingGeneration: Number(r.fencing_generation),
      ...(r.worker_id ? { workerId: String(r.worker_id) } : {}),
      ...(r.lease_expires_at ? { leaseExpiresAt: toIso(r.lease_expires_at) } : {}),
      ...(r.heartbeat_at ? { heartbeatAt: toIso(r.heartbeat_at) } : {}),
      ...(r.cancel_requested_at ? { cancelRequestedAt: toIso(r.cancel_requested_at) } : {}),
      attempt: Number(r.attempt),
      maxAttempts: Number(r.max_attempts),
      ...(r.reservation_id ? { reservationId: String(r.reservation_id) } : {}),
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  // ---------------------------------------------------------------------------
  // Org AI & Voice Governance Policies (PLT-04 / PLT-T21..T22)
  // ---------------------------------------------------------------------------
  async upsertAiPolicy(actor: ActorContext, policy: ModelRoutingPolicy): Promise<ModelRoutingPolicy> {
    const org = await this.getOrganization(policy.tenantId);
    assertPolicyAllowed({
      actor,
      resourceTenantId: policy.tenantId,
      resource: "policy",
      action: "manage",
      source: "manual",
      ...(org ? { organizationStatus: org.status, mfaRequiredForPrivileged: org.mfaRequiredForPrivileged } : {}),
    });

    return withTenantTransaction(this.db, policy.tenantId, async (tx) => {
      const res = await tx.query<{ policy_version: number; updated_at: Date | string }>(
        `INSERT INTO pa_ai_policies (tenant_id, policy_version, policy_json, updated_by)
         VALUES ($1::uuid, $2, $3::jsonb, $4::uuid)
         ON CONFLICT (tenant_id) DO UPDATE
         SET policy_version = pa_ai_policies.policy_version + 1,
             policy_json = EXCLUDED.policy_json,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
         RETURNING policy_version, updated_at`,
        [policy.tenantId, policy.policyVersion, JSON.stringify(policy), actor.userId],
      );
      const stored: ModelRoutingPolicy = {
        ...policy,
        policyVersion: res.rows[0]!.policy_version,
        updatedAt: toIso(res.rows[0]!.updated_at),
      };
      await this.appendAuditLogTx(tx, {
        tenantId: policy.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "manual",
        action: "policy.ai_updated",
        outcome: "success",
        targetType: "ai_policy",
        targetId: policy.tenantId,
        summary: `Updated AI routing policy to v${stored.policyVersion}.`,
      });
      return stored;
    });
  }

  async getAiPolicy(tenantId: string): Promise<ModelRoutingPolicy | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const res = await tx.query<{ policy_version: number; policy_json: unknown; updated_at: Date | string }>(
        `SELECT policy_version, policy_json, updated_at FROM pa_ai_policies WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const r = res.rows[0];
      if (!r) return null;
      const parsed = parseJsonColumn<ModelRoutingPolicy>(r.policy_json);
      return { ...parsed, policyVersion: r.policy_version, updatedAt: toIso(r.updated_at) };
    });
  }

  async upsertVoicePolicy(actor: ActorContext, policy: VoicePolicyConfig): Promise<VoicePolicyConfig> {
    const org = await this.getOrganization(policy.tenantId);
    assertPolicyAllowed({
      actor,
      resourceTenantId: policy.tenantId,
      resource: "policy",
      action: "manage",
      source: "manual",
      ...(org ? { organizationStatus: org.status, mfaRequiredForPrivileged: org.mfaRequiredForPrivileged } : {}),
    });

    return withTenantTransaction(this.db, policy.tenantId, async (tx) => {
      const res = await tx.query<{ policy_version: number; updated_at: Date | string }>(
        `INSERT INTO pa_voice_policies (tenant_id, policy_version, policy_json, updated_by)
         VALUES ($1::uuid, $2, $3::jsonb, $4::uuid)
         ON CONFLICT (tenant_id) DO UPDATE
         SET policy_version = pa_voice_policies.policy_version + 1,
             policy_json = EXCLUDED.policy_json,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
         RETURNING policy_version, updated_at`,
        [policy.tenantId, policy.policyVersion, JSON.stringify(policy), actor.userId],
      );
      const stored: VoicePolicyConfig = {
        ...policy,
        policyVersion: res.rows[0]!.policy_version,
        updatedAt: toIso(res.rows[0]!.updated_at),
      };
      await this.appendAuditLogTx(tx, {
        tenantId: policy.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "manual",
        action: "policy.voice_updated",
        outcome: "success",
        targetType: "voice_policy",
        targetId: policy.tenantId,
        summary: `Updated voice governance policy to v${stored.policyVersion}.`,
      });
      return stored;
    });
  }

  async getVoicePolicy(tenantId: string): Promise<VoicePolicyConfig | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const res = await tx.query<{ policy_version: number; policy_json: unknown; updated_at: Date | string }>(
        `SELECT policy_version, policy_json, updated_at FROM pa_voice_policies WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const r = res.rows[0];
      if (!r) return null;
      const parsed = parseJsonColumn<VoicePolicyConfig>(r.policy_json);
      return { ...parsed, policyVersion: r.policy_version, updatedAt: toIso(r.updated_at) };
    });
  }

  // ---------------------------------------------------------------------------
  // Filtered Audit Query & Operational Health Snapshot (PLT-T34, PLT-T36)
  // ---------------------------------------------------------------------------
  async queryAuditLogs(
    actor: ActorContext,
    filter: {
      tenantId: string;
      workspaceId?: string;
      actorId?: string;
      actionPrefix?: string;
      source?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<AuditEvent[]> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: filter.tenantId,
      ...(filter.workspaceId ? { resourceWorkspaceId: filter.workspaceId } : {}),
      resource: "audit",
      action: "read",
      source: "manual",
    });
    const { limit, offset } = clampGovernancePagination(filter);

    return withTenantTransaction(
      this.db,
      filter.tenantId,
      async (tx) => {
        const clauses = ["tenant_id = $1::uuid"];
        const params: unknown[] = [filter.tenantId];
        if (filter.workspaceId) {
          params.push(filter.workspaceId);
          clauses.push(`workspace_id = $${params.length}::uuid`);
        }
        if (filter.actorId) {
          params.push(filter.actorId);
          clauses.push(`actor_id = $${params.length}::uuid`);
        }
        if (filter.actionPrefix) {
          params.push(`${escapeSqlLikePattern(filter.actionPrefix)}%`);
          clauses.push(`action LIKE $${params.length} ESCAPE '\\'`);
        }
        if (filter.source) {
          params.push(filter.source);
          clauses.push(`source = $${params.length}`);
        }
        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const res = await tx.query<{
          audit_id: string;
          tenant_id: string;
          workspace_id: string | null;
          actor_id: string;
          actor_role: string;
          source: AuditEvent["source"];
          action: string;
          outcome: AuditEvent["outcome"];
          target_id: string;
          summary: string;
          metadata: Record<string, unknown> | null;
          created_at: Date | string;
        }>(
          `SELECT audit_id, tenant_id, workspace_id, actor_id, actor_role, source,
                  action, outcome, target_id, summary, metadata, created_at
           FROM audit_logs
           WHERE ${clauses.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );

        return res.rows.map((r) => ({
          auditId: r.audit_id,
          tenantId: r.tenant_id,
          workspaceId: r.workspace_id ?? "",
          actorId: r.actor_id,
          actorRole: isWorkspaceRole(r.actor_role) ? r.actor_role : "viewer",
          source: r.source,
          action: r.action,
          outcome: r.outcome,
          summary: r.summary,
          ...(r.metadata ? { metadata: parseJsonColumn<Record<string, unknown>>(r.metadata) } : {}),
          createdAt: toIso(r.created_at),
        }));
      },
      filter.workspaceId ?? null,
    );
  }

  async getServiceHealthSnapshot(tenantId?: string): Promise<ServiceHealthSnapshot> {
    const core = await verifyDatabaseRlsReadiness(this.db);
    const pa = await verifyPaRlsReadiness(this.db);

    let queued = 0;
    let running = 0;
    let expiredLeases = 0;
    let deadLetter = 0;
    let totalObjects = 0;
    let quarantinedObjects = 0;

    if (tenantId) {
      await withTenantTransaction(this.db, tenantId, async (tx) => {
        const jobStats = await tx.query<{ state: string; cnt: string | number }>(
          `SELECT state, COUNT(*) AS cnt FROM pa_jobs WHERE tenant_id = $1::uuid GROUP BY state`,
          [tenantId],
        );
        for (const r of jobStats.rows) {
          if (r.state === "queued") queued = Number(r.cnt);
          if (r.state === "running") running = Number(r.cnt);
          if (r.state === "dead_letter") deadLetter = Number(r.cnt);
        }
        const expRes = await tx.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM pa_jobs
           WHERE tenant_id = $1::uuid AND state = 'running' AND lease_expires_at <= now()`,
          [tenantId],
        );
        expiredLeases = Number(expRes.rows[0]?.cnt ?? 0);

        const fileStats = await tx.query<{ total: string | number; quarantined: string | number }>(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE quarantine_state <> 'clean') AS quarantined
           FROM pa_file_objects WHERE tenant_id = $1::uuid AND deleted_at IS NULL`,
          [tenantId],
        );
        totalObjects = Number(fileStats.rows[0]?.total ?? 0);
        quarantinedObjects = Number(fileStats.rows[0]?.quarantined ?? 0);
      });
    }

    const healthy = core.ready && pa.paForceRlsEnabled && deadLetter === 0 && expiredLeases === 0;
    return {
      status: !core.checks.connectivity ? "unhealthy" : healthy ? "healthy" : "degraded",
      checkedAt: new Date().toISOString(),
      database: {
        connected: core.checks.connectivity,
        engine: core.engine,
        coreForceRlsEnabled: core.checks.coreForceRlsEnabled,
        paForceRlsEnabled: pa.paForceRlsEnabled,
      },
      jobs: { queued, running, expiredLeases, deadLetter },
      storage: { totalObjects, quarantinedObjects },
    };
  }
}

// -----------------------------------------------------------------------------
// Extended Logical Backup & Restore covering Core + XI + PA-00 Tables (PLT-T35)
// -----------------------------------------------------------------------------
const PA_BACKUP_TABLE_KEYS: ReadonlyArray<keyof PaExtendedLogicalBackupSnapshot["paTables"]> = [
  "paPlanVersions",
  "paTenantSubscriptions",
  "paInvitations",
  "paUsageReservations",
  "paUsageLedger",
  "paBillingWebhooks",
  "paFileObjects",
  "paJobs",
  "paAiPolicies",
  "paVoicePolicies",
];

function computePaExtendedIntegritySha256(
  coreIntegritySha256: string,
  paTables: PaExtendedLogicalBackupSnapshot["paTables"],
): string {
  return sha256Hex(JSON.stringify({ coreIntegritySha256, paTables }));
}

export async function exportPaExtendedLogicalBackup(
  db: PgDatabaseAdapter,
): Promise<PaExtendedLogicalBackupSnapshot> {
  return db.withTransaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertBackupRoleCanBypassRls(tx);

    const coreAndXi = await exportCoreAndXiInTx(tx);
    const q = async (sql: string) => (await tx.query<Record<string, unknown>>(sql)).rows;
    const paTables: PaExtendedLogicalBackupSnapshot["paTables"] = {
      paPlanVersions: await q("SELECT * FROM pa_plan_versions ORDER BY plan_id, version"),
      paTenantSubscriptions: await q("SELECT * FROM pa_tenant_subscriptions ORDER BY tenant_id"),
      paInvitations: await q("SELECT * FROM pa_invitations ORDER BY tenant_id, invitation_id"),
      paUsageReservations: await q("SELECT * FROM pa_usage_reservations ORDER BY tenant_id, reservation_id"),
      paUsageLedger: await q("SELECT * FROM pa_usage_ledger ORDER BY tenant_id, ledger_id"),
      paBillingWebhooks: await q("SELECT * FROM pa_billing_webhooks ORDER BY tenant_id, provider_event_id"),
      paFileObjects: await q("SELECT * FROM pa_file_objects ORDER BY tenant_id, object_id, version"),
      paJobs: await q("SELECT * FROM pa_jobs ORDER BY tenant_id, job_id"),
      paAiPolicies: await q("SELECT * FROM pa_ai_policies ORDER BY tenant_id"),
      paVoicePolicies: await q("SELECT * FROM pa_voice_policies ORDER BY tenant_id"),
    };

    return {
      snapshotVersion: 3,
      ...(coreAndXi.exportedAt ? { exportedAt: coreAndXi.exportedAt } : {}),
      extendedIntegritySha256: computePaExtendedIntegritySha256(coreAndXi.integritySha256 ?? "", paTables),
      coreAndXi,
      paTables,
    };
  });
}

export async function restorePaExtendedLogicalBackup(
  targetDb: PgDatabaseAdapter,
  snapshot: PaExtendedLogicalBackupSnapshot,
  options: { simulateFailureBeforeCommit?: boolean } = {},
): Promise<void> {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.coreAndXi || !snapshot.paTables) {
    throw new Error("INVALID_BACKUP_SNAPSHOT: Extended PA snapshot must contain coreAndXi and paTables.");
  }
  for (const key of PA_BACKUP_TABLE_KEYS) {
    if (!Array.isArray(snapshot.paTables[key])) {
      throw new Error(`INVALID_BACKUP_SNAPSHOT: Missing or invalid PA backup table '${key}'.`);
    }
  }

  verifyLogicalBackupSnapshot(snapshot.coreAndXi);

  if (!snapshot.coreAndXi.integritySha256 || !snapshot.extendedIntegritySha256) {
    throw new Error("BACKUP_INTEGRITY_MISMATCH: Extended PA logical backup SHA-256 digest is missing.");
  }
  const actualExtendedHash = computePaExtendedIntegritySha256(
    snapshot.coreAndXi.integritySha256,
    snapshot.paTables,
  );
  if (actualExtendedHash !== snapshot.extendedIntegritySha256) {
    throw new Error(
      "BACKUP_INTEGRITY_MISMATCH: Extended PA logical backup SHA-256 digest does not match payload.",
    );
  }

  const toJson = (v: unknown) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));

  await targetDb.withTransaction(async (tx) => {
    await restoreCoreAndXiInTx(tx, snapshot.coreAndXi, { idempotent: true });

    for (const r of snapshot.paTables.paPlanVersions) {
      await tx.query(
        `INSERT INTO pa_plan_versions (plan_id, version, display_name, entitlements_json, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz) ON CONFLICT DO NOTHING`,
        [r.plan_id, r.version, r.display_name, toJson(r.entitlements_json), r.created_at],
      );
    }
    for (const r of snapshot.paTables.paTenantSubscriptions) {
      await tx.query(
        `INSERT INTO pa_tenant_subscriptions (tenant_id, plan_id, plan_version, status, seat_limit, entitlements_json, policy_version, last_billing_event_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz) ON CONFLICT DO NOTHING`,
        [
          r.tenant_id,
          r.plan_id,
          r.plan_version,
          r.status,
          r.seat_limit,
          toJson(r.entitlements_json),
          r.policy_version,
          r.last_billing_event_at ?? null,
          r.updated_at,
        ],
      );
    }
    for (const r of snapshot.paTables.paInvitations) {
      await tx.query(
        `INSERT INTO pa_invitations (tenant_id, invitation_id, workspace_id, email, invited_role, invited_by, token_sha256, status, expires_at, consumed_at, revoked_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.invitation_id, r.workspace_id, r.email, r.invited_role, r.invited_by, r.token_sha256, r.status, r.expires_at, r.consumed_at ?? null, r.revoked_at ?? null, r.created_at],
      );
    }
    for (const r of snapshot.paTables.paUsageReservations) {
      await tx.query(
        `INSERT INTO pa_usage_reservations (tenant_id, reservation_id, workspace_id, actor_id, dimension, period_key, reserved_units, settled_units, status, idempotency_key, correlation_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.reservation_id, r.workspace_id, r.actor_id, r.dimension, r.period_key, r.reserved_units, r.settled_units, r.status, r.idempotency_key, r.correlation_id, r.created_at, r.updated_at],
      );
    }
    for (const r of snapshot.paTables.paUsageLedger) {
      await tx.query(
        `INSERT INTO pa_usage_ledger (tenant_id, ledger_id, workspace_id, actor_id, source, dimension, units, estimated_cost_microusd, provider_id, model_id, correlation_id, reservation_id, is_mock, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13, $14::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.ledger_id, r.workspace_id, r.actor_id, r.source, r.dimension, r.units, r.estimated_cost_microusd, r.provider_id ?? null, r.model_id ?? null, r.correlation_id, r.reservation_id ?? null, r.is_mock, r.created_at],
      );
    }
    for (const r of snapshot.paTables.paBillingWebhooks) {
      await tx.query(
        `INSERT INTO pa_billing_webhooks (tenant_id, provider_event_id, event_type, signature_verified, payload_sha256, processed_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.provider_event_id, r.event_type, r.signature_verified, r.payload_sha256, r.processed_at],
      );
    }
    for (const r of snapshot.paTables.paFileObjects) {
      await tx.query(
        `INSERT INTO pa_file_objects (tenant_id, workspace_id, object_id, version, storage_key, filename, mime_type, byte_size, sha256, classification, quarantine_state, legal_hold, retention_until, deleted_at, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::timestamptz, $15::uuid, $16::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.workspace_id, r.object_id, r.version, r.storage_key, r.filename, r.mime_type, r.byte_size, r.sha256, r.classification, r.quarantine_state, r.legal_hold, r.retention_until ?? null, r.deleted_at ?? null, r.created_by, r.created_at],
      );
    }
    for (const r of snapshot.paTables.paJobs) {
      await tx.query(
        `INSERT INTO pa_jobs (tenant_id, job_id, workspace_id, actor_id, job_type, idempotency_key, state, payload_json, result_json, error_json, lease_token, fencing_generation, worker_id, lease_expires_at, heartbeat_at, cancel_requested_at, attempt, max_attempts, reservation_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14::timestamptz, $15::timestamptz, $16::timestamptz, $17, $18, $19::uuid, $20::timestamptz, $21::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.job_id, r.workspace_id, r.actor_id, r.job_type, r.idempotency_key, r.state, toJson(r.payload_json), toJson(r.result_json), toJson(r.error_json), r.lease_token ?? null, r.fencing_generation, r.worker_id ?? null, r.lease_expires_at ?? null, r.heartbeat_at ?? null, r.cancel_requested_at ?? null, r.attempt, r.max_attempts, r.reservation_id ?? null, r.created_at, r.updated_at],
      );
    }
    for (const r of snapshot.paTables.paAiPolicies) {
      await tx.query(
        `INSERT INTO pa_ai_policies (tenant_id, policy_version, policy_json, updated_by, updated_at)
         VALUES ($1::uuid, $2, $3::jsonb, $4::uuid, $5::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.policy_version, toJson(r.policy_json), r.updated_by, r.updated_at],
      );
    }
    for (const r of snapshot.paTables.paVoicePolicies) {
      await tx.query(
        `INSERT INTO pa_voice_policies (tenant_id, policy_version, policy_json, updated_by, updated_at)
         VALUES ($1::uuid, $2, $3::jsonb, $4::uuid, $5::timestamptz) ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.policy_version, toJson(r.policy_json), r.updated_by, r.updated_at],
      );
    }

    if (options.simulateFailureBeforeCommit) {
      throw new Error("SIMULATED_RESTORE_FAILURE_BEFORE_COMMIT: Atomic PA backup restore aborted.");
    }
  });
}
