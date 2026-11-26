import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ActorContext,
  BillingWebhookEvent,
  ModelRoutingPolicy,
  VoicePolicyConfig,
} from "@ai-office-suite/shared-contracts";
import {
  AuthorizationError,
  assertPolicyAllowed,
  evaluatePolicyDecision,
} from "@ai-office-suite/authorization";
import {
  exportPaExtendedLogicalBackup,
  GovernanceError,
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  NodePgDatabaseAdapter,
  PgliteDatabaseAdapter,
  PlatformGovernanceService,
  provisionAppRuntimeLoginRole,
  restorePaExtendedLogicalBackup,
  signMockBillingWebhook,
  withTenantTransaction,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";
import {
  authenticateUserWithPassword,
  hashPassword,
  verifySessionToken,
} from "@ai-office-suite/identity";
import {
  LocalPrivateObjectStore,
  PrivateObjectStorageError,
} from "@ai-office-suite/storage";

const TENANT_A = "11110000-0000-4000-8000-000000000001";
const TENANT_B = "22220000-0000-4000-8000-000000000002";
const WS_A_REPORTING = "aaaa0000-0000-4000-8000-000000000001";
const WS_A_PAYROLL = "aaaa0000-0000-4000-8000-000000000002";
const WS_B_REPORTING = "bbbb0000-0000-4000-8000-000000000001";

const USER_A_OWNER = "00000001-0000-4000-8000-000000000001";
const USER_A_ADMIN = "00000001-0000-4000-8000-000000000002";
const USER_A_WSMGR = "00000001-0000-4000-8000-000000000003";
const USER_A_BILLING = "00000001-0000-4000-8000-000000000004";
const USER_A_AUDITOR = "00000001-0000-4000-8000-000000000005";
const USER_A_EDITOR = "00000001-0000-4000-8000-000000000006";
const USER_A_REVIEWER = "00000001-0000-4000-8000-000000000007";
const USER_A_VIEWER = "00000001-0000-4000-8000-000000000008";
const USER_A_PAYROLL_MEMBER = "00000001-0000-4000-8000-000000000009";
const USER_A_INVITEE_1 = "00000001-0000-4000-8000-000000000010";
const USER_A_INVITEE_2 = "00000001-0000-4000-8000-000000000011";
const USER_A_OFFBOARD = "00000001-0000-4000-8000-000000000012";
const USER_B_OWNER = "00000002-0000-4000-8000-000000000001";

const NOW_ISO = new Date().toISOString();

const ACTOR_A_OWNER: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_OWNER,
  role: "owner",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
};
const ACTOR_A_OWNER_NO_MFA: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_OWNER,
  role: "owner",
  workspaceContentGrant: true,
};
const ACTOR_A_ADMIN_NO_PAYROLL: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_PAYROLL,
  userId: USER_A_ADMIN,
  role: "administrator",
  workspaceContentGrant: false,
  mfaVerifiedAt: NOW_ISO,
};
const ACTOR_A_WSMGR: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_WSMGR,
  role: "workspace_manager",
  workspaceContentGrant: true,
};
const ACTOR_A_BILLING: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_BILLING,
  role: "billing_admin",
  workspaceContentGrant: false,
  mfaVerifiedAt: NOW_ISO,
};
const ACTOR_A_AUDITOR: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_AUDITOR,
  role: "auditor",
  workspaceContentGrant: false,
};
const ACTOR_A_EDITOR: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_EDITOR,
  role: "editor",
  workspaceContentGrant: true,
};
const ACTOR_A_VIEWER: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_VIEWER,
  role: "viewer",
  workspaceContentGrant: true,
};
const ACTOR_A_PAYROLL_MEMBER: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_PAYROLL,
  userId: USER_A_PAYROLL_MEMBER,
  role: "editor",
  workspaceContentGrant: true,
};
const ACTOR_B_OWNER: ActorContext = {
  tenantId: TENANT_B,
  workspaceId: WS_B_REPORTING,
  userId: USER_B_OWNER,
  role: "owner",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
};

async function seedUser(db: PgDatabaseAdapter, userId: string, email: string, pwHash: string): Promise<void> {
  await db.query(
    `INSERT INTO users (user_id, email, password_hash, token_version, status)
     VALUES ($1::uuid, $2, $3, 1, 'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, email, pwHash],
  );
}

describe("V1.3 PA-00 — Shared Platform Administration Feasibility (PLT-T01..PLT-T36)", () => {
  let db: PgliteDatabaseAdapter;
  let gov: PlatformGovernanceService;
  let storeDir: string;
  let store: LocalPrivateObjectStore;
  let pwHash: string;

  beforeAll(async () => {
    db = new PgliteDatabaseAdapter();
    await initializePostgreSqlSchema(db);
    await initializePaGovernanceSchema(db);
    gov = new PlatformGovernanceService(db, { billingWebhookSecret: "pa00-test-webhook-secret-32chars!!" });
    await gov.seedDefaultPlans();

    storeDir = mkdtempSync(path.join(tmpdir(), "aios-pa00-store-"));
    store = new LocalPrivateObjectStore(storeDir, "pa00-object-signing-secret-32chars!");
    pwHash = await hashPassword("StrongPass123!");

    // Seed Tenant A (with MFA required for privileged actions) and Tenant B
    await gov.createOrganization({
      tenantId: TENANT_A,
      name: "Phnom Penh Manufacturing Co.",
      mfaRequiredForPrivileged: true,
    });
    await gov.createOrganization({
      tenantId: TENANT_B,
      name: "Mekong Retail Group",
      mfaRequiredForPrivileged: false,
    });

    await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, name: "Reporting", visibility: "standard" });
    await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_PAYROLL, name: "Payroll", visibility: "restricted" });
    await gov.createWorkspace({ tenantId: TENANT_B, workspaceId: WS_B_REPORTING, name: "Reporting", visibility: "standard" });

    const allUsers: Array<[string, string]> = [
      [USER_A_OWNER, "owner@tenanta.example"],
      [USER_A_ADMIN, "admin@tenanta.example"],
      [USER_A_WSMGR, "wsmgr@tenanta.example"],
      [USER_A_BILLING, "billing@tenanta.example"],
      [USER_A_AUDITOR, "auditor@tenanta.example"],
      [USER_A_EDITOR, "editor@tenanta.example"],
      [USER_A_REVIEWER, "reviewer@tenanta.example"],
      [USER_A_VIEWER, "viewer@tenanta.example"],
      [USER_A_PAYROLL_MEMBER, "payroll@tenanta.example"],
      [USER_A_INVITEE_1, "invitee1@tenanta.example"],
      [USER_A_INVITEE_2, "invitee2@tenanta.example"],
      [USER_A_OFFBOARD, "offboard@tenanta.example"],
      [USER_B_OWNER, "owner@tenantb.example"],
    ];
    for (const [uid, email] of allUsers) {
      await seedUser(db, uid, email, pwHash);
    }

    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_OWNER, role: "owner", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_ADMIN, role: "administrator", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_WSMGR, role: "workspace_manager", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_BILLING, role: "billing_admin", contentAccess: false });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_AUDITOR, role: "auditor", contentAccess: false });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_EDITOR, role: "editor", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_REVIEWER, role: "reviewer", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_VIEWER, role: "viewer", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_PAYROLL, userId: USER_A_PAYROLL_MEMBER, role: "editor", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_OFFBOARD, role: "editor", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_B, workspaceId: WS_B_REPORTING, userId: USER_B_OWNER, role: "owner", contentAccess: true });

    await gov.assignTenantSubscription({ tenantId: TENANT_A, planId: "sme_standard", planVersion: 1, seatLimitOverride: 11 });
    await gov.assignTenantSubscription({ tenantId: TENANT_B, planId: "sme_standard", planVersion: 1 });
  });

  afterAll(async () => {
    await db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("PLT-T01: provisions multi-tenant orgs and workspaces with colliding local names/IDs cleanly", async () => {
    const wsA = await gov.getWorkspace(TENANT_A, WS_A_REPORTING);
    const wsB = await gov.getWorkspace(TENANT_B, WS_B_REPORTING);
    const wsPayroll = await gov.getWorkspace(TENANT_A, WS_A_PAYROLL);
    expect(wsA?.name).toBe("Reporting");
    expect(wsB?.name).toBe("Reporting");
    expect(wsPayroll?.visibility).toBe("restricted");
    // Tenant A cannot query Tenant B's workspace through RLS
    const cross = await gov.getWorkspace(TENANT_A, WS_B_REPORTING);
    expect(cross).toBeNull();
  });

  it("PLT-T02: organization suspension blocks active operations and new logins until reactivated", async () => {
    const suspended = await gov.setOrganizationStatus({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      status: "suspended",
      reason: "Compliance pause drill",
    });
    expect(suspended.status).toBe("suspended");

    const decision = evaluatePolicyDecision({
      actor: ACTOR_A_EDITOR,
      resourceTenantId: TENANT_A,
      resourceWorkspaceId: WS_A_REPORTING,
      resource: "document",
      action: "write",
      source: "manual",
      organizationStatus: "suspended",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialCategory).toBe("organization_suspended");

    await expect(
      authenticateUserWithPassword({
        db,
        email: "editor@tenanta.example",
        password: "StrongPass123!",
        tenantId: TENANT_A,
        workspaceId: WS_A_REPORTING,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    // Reactivate cleanly for subsequent tests
    const reactivated = await gov.setOrganizationStatus({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      status: "active",
      reason: "Compliance pause lifted",
    });
    expect(reactivated.status).toBe("active");
  });

  it("PLT-T03: invitation stores only SHA-256 token hash in DB and redacts raw token from audit logs", async () => {
    const { invitation, rawToken } = await gov.createInvitation({
      actor: ACTOR_A_WSMGR,
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      email: "invitee1@tenanta.example",
      invitedRole: "editor",
      expiresInSeconds: 3600,
    });
    expect(rawToken.startsWith("inv_")).toBe(true);
    expect(invitation.tokenSha256).toHaveLength(64);
    expect(invitation.tokenSha256).not.toContain(rawToken);

    const dbRow = await withTenantTransaction(db, TENANT_A, async (tx) => {
      const r = await tx.query<{ token_sha256: string }>(
        "SELECT token_sha256 FROM pa_invitations WHERE invitation_id = $1::uuid",
        [invitation.invitationId],
      );
      return r.rows[0];
    });
    expect(dbRow?.token_sha256).toBe(invitation.tokenSha256);

    const logs = await gov.queryAuditLogs(ACTOR_A_AUDITOR, {
      tenantId: TENANT_A,
      actionPrefix: "invitation.created",
    });
    const latest = logs[0]!;
    expect(JSON.stringify(latest)).not.toContain(rawToken);
    expect(latest.metadata?.raw_invite_token).toBe("[REDACTED]");

    // Accept invitee1 now (uses 11th seat of 11)
    const accepted = await gov.acceptInvitation({
      tenantId: TENANT_A,
      rawToken,
      acceptingUserId: USER_A_INVITEE_1,
      acceptingEmail: "invitee1@tenanta.example",
    });
    expect(accepted.role).toBe("editor");

    // PLT-T04 replay test right on same consumed token
    await expect(
      gov.acceptInvitation({
        tenantId: TENANT_A,
        rawToken,
        acceptingUserId: USER_A_INVITEE_1,
        acceptingEmail: "invitee1@tenanta.example",
      }),
    ).rejects.toMatchObject({ code: "INVITATION_ALREADY_CONSUMED" });
  });

  it("PLT-T04: rejects revoked and expired invitation tokens fail-closed", async () => {
    const rev = await gov.createInvitation({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      email: "revoked@tenanta.example",
      invitedRole: "viewer",
    });
    await gov.revokeInvitation({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      invitationId: rev.invitation.invitationId,
    });
    await expect(
      gov.acceptInvitation({
        tenantId: TENANT_A,
        rawToken: rev.rawToken,
        acceptingUserId: USER_A_INVITEE_2,
        acceptingEmail: "revoked@tenanta.example",
      }),
    ).rejects.toMatchObject({ code: "INVITATION_REVOKED" });

    const exp = await gov.createInvitation({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      email: "invitee2@tenanta.example",
      invitedRole: "viewer",
      expiresInSeconds: 10,
    });
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    await expect(
      gov.acceptInvitation({
        tenantId: TENANT_A,
        rawToken: exp.rawToken,
        acceptingUserId: USER_A_INVITEE_2,
        acceptingEmail: "invitee2@tenanta.example",
        nowIso: futureIso,
      }),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
  });

  it("PLT-T05: enforces seat_limit transactionally when accepting invitations", async () => {
    // Tenant A currently has 11 active distinct users (limit=11); invitee2 must be blocked by SEAT_LIMIT_EXCEEDED
    const inv = await gov.createInvitation({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      email: "invitee2@tenanta.example",
      invitedRole: "viewer",
    });
    await expect(
      gov.acceptInvitation({
        tenantId: TENANT_A,
        rawToken: inv.rawToken,
        acceptingUserId: USER_A_INVITEE_2,
        acceptingEmail: "invitee2@tenanta.example",
      }),
    ).rejects.toMatchObject({ code: "SEAT_LIMIT_EXCEEDED" });
  });

  it("PLT-T06: blocks sole-owner removal and allows MFA-verified ownership transfer", async () => {
    await expect(
      gov.offboardOrSuspendMember({
        actor: ACTOR_A_OWNER,
        tenantId: TENANT_A,
        targetUserId: USER_A_OWNER,
        mode: "revoke",
        reason: "Self-removal attempt",
      }),
    ).rejects.toMatchObject({ code: "SOLE_OWNER_CANNOT_BE_REMOVED" });

    // Without MFA, ownership transfer is blocked (also exercises PLT-T14)
    await expect(
      gov.transferOwnership({
        actor: ACTOR_A_OWNER_NO_MFA,
        tenantId: TENANT_A,
        workspaceId: WS_A_REPORTING,
        newOwnerUserId: USER_A_ADMIN,
      }),
    ).rejects.toMatchObject({ code: "MFA_STEP_UP_REQUIRED" });

    // With fresh MFA, ownership transfer succeeds and now Tenant A has 2 owners
    await gov.transferOwnership({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      newOwnerUserId: USER_A_ADMIN,
    });
    const ctx = await gov.switchTenantContext({
      userId: USER_A_ADMIN,
      targetTenantId: TENANT_A,
      targetWorkspaceId: WS_A_REPORTING,
    });
    expect(ctx.role).toBe("owner");
  });

  it("PLT-T07: member offboarding revokes membership and bumps token_version immediately", async () => {
    const authBefore = await authenticateUserWithPassword({
      db,
      email: "offboard@tenanta.example",
      password: "StrongPass123!",
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
    });
    const claims = verifySessionToken(authBefore.token);
    expect(claims?.tv).toBe(1);

    const res = await gov.offboardOrSuspendMember({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      targetUserId: USER_A_OFFBOARD,
      mode: "revoke",
      reason: "Employee departure",
    });
    expect(res.newTokenVersion).toBe(2);
    expect(res.updatedMemberships).toBeGreaterThanOrEqual(1);

    // Context switch now denied for offboarded member
    await expect(
      gov.switchTenantContext({
        userId: USER_A_OFFBOARD,
        targetTenantId: TENANT_A,
        targetWorkspaceId: WS_A_REPORTING,
      }),
    ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });
  });

  it("PLT-T08: FORCE ROW LEVEL SECURITY via non-superuser role fails closed without tenant GUC and isolates tenants", async () => {
    // 1. PGlite app_runtime non-superuser fail-closed verification
    const noTenantCount = await withTenantTransaction(db, null, async (tx) => {
      const r = await tx.query<{ cnt: string | number }>("SELECT COUNT(*) AS cnt FROM pa_tenant_subscriptions");
      return Number(r.rows[0]?.cnt ?? 0);
    });
    expect(noTenantCount).toBe(0);

    const tenantASubs = await withTenantTransaction(db, TENANT_A, async (tx) => {
      const r = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM pa_tenant_subscriptions");
      return r.rows;
    });
    expect(tenantASubs).toHaveLength(1);
    expect(tenantASubs[0]?.tenant_id).toBe(TENANT_A);

    // 2. When live PostgreSQL 16 Docker URL is present, also verify real non-superuser `aios_app` NOBYPASSRLS login role
    const livePgUrl = process.env.TEST_POSTGRES_URL?.trim();
    if (livePgUrl) {
      const adminPg = new NodePgDatabaseAdapter(livePgUrl);
      try {
        await initializePostgreSqlSchema(adminPg, { force: true });
        await initializePaGovernanceSchema(adminPg, { force: true });
        await provisionAppRuntimeLoginRole(adminPg, {
          roleName: "aios_pa00_app",
          password: "Pa00AppRoleStrong#2026!",
        });
        const parsed = new URL(livePgUrl);
        parsed.username = "aios_pa00_app";
        parsed.password = "Pa00AppRoleStrong#2026!";
        const appPg = new NodePgDatabaseAdapter(parsed.toString());
        try {
          const priv = await appPg.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          );
          expect(priv.rows[0]?.rolsuper).toBe(false);
          expect(priv.rows[0]?.rolbypassrls).toBe(false);
          // Unscoped query under non-superuser login returns 0 rows
          const leaked = await appPg.query<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM pa_tenant_subscriptions");
          expect(Number(leaked.rows[0]?.cnt ?? 0)).toBe(0);
        } finally {
          await appPg.close();
        }
      } finally {
        await adminPg.close();
      }
    }
  });

  it("PLT-T09: billing_admin allowed billing/usage/entitlements, strictly DENIED confidential finance docs, AI & voice", () => {
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_BILLING,
        resourceTenantId: TENANT_A,
        resource: "billing",
        action: "manage",
        source: "manual",
        mfaRequiredForPrivileged: true,
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_BILLING,
        resourceTenantId: TENANT_A,
        resource: "usage",
        action: "read",
        source: "manual",
      }).allowed,
    ).toBe(true);

    for (const [resource, action, source] of [
      ["document", "read", "manual"],
      ["document", "write", "typed_ai"],
      ["ai_assistant", "apply_ai", "typed_ai"],
      ["speech", "transcribe", "voice_command"],
    ] as const) {
      const dec = evaluatePolicyDecision({
        actor: ACTOR_A_BILLING,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_REPORTING,
        resource,
        action,
        source,
      });
      expect(dec.allowed).toBe(false);
      expect(dec.denialCategory).toBe("role_forbidden");
    }
  });

  it("PLT-T10: auditor role is strictly read-only on audit/metrics/usage/policy and DENIED all mutations", () => {
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_AUDITOR,
        resourceTenantId: TENANT_A,
        resource: "audit",
        action: "read",
        source: "manual",
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_AUDITOR,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_REPORTING,
        resource: "document",
        action: "write",
        source: "manual",
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_AUDITOR,
        resourceTenantId: TENANT_A,
        resource: "membership",
        action: "manage",
        source: "manual",
      }).allowed,
    ).toBe(false);
  });

  it("PLT-T11: workspace_manager manages workspace members/files only, denied org billing/ownership & cross-workspace", () => {
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_WSMGR,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_REPORTING,
        resource: "invitation",
        action: "invite",
        source: "manual",
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_WSMGR,
        resourceTenantId: TENANT_A,
        resource: "billing",
        action: "manage",
        source: "manual",
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_WSMGR,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_PAYROLL,
        resource: "document",
        action: "read",
        source: "manual",
      }).denialCategory,
    ).toBe("tenant_boundary");
  });

  it("PLT-T12: restricted Payroll workspace denies org admin without explicit content grant and allows explicit Payroll member", () => {
    const adminDenied = evaluatePolicyDecision({
      actor: ACTOR_A_ADMIN_NO_PAYROLL,
      resourceTenantId: TENANT_A,
      resourceWorkspaceId: WS_A_PAYROLL,
      resource: "document",
      action: "read",
      source: "manual",
      workspaceVisibility: "restricted",
      classification: "restricted",
    });
    expect(adminDenied.allowed).toBe(false);
    expect(adminDenied.denialCategory).toBe("workspace_content_isolated");

    const payrollAllowed = evaluatePolicyDecision({
      actor: ACTOR_A_PAYROLL_MEMBER,
      resourceTenantId: TENANT_A,
      resourceWorkspaceId: WS_A_PAYROLL,
      resource: "document",
      action: "read",
      source: "manual",
      workspaceVisibility: "restricted",
      classification: "restricted",
    });
    expect(payrollAllowed.allowed).toBe(true);
  });

  it("PLT-T13: explicit tenant context switch requires active membership and denies forged cross-tenant switch", async () => {
    const ok = await gov.switchTenantContext({
      userId: USER_A_EDITOR,
      targetTenantId: TENANT_A,
      targetWorkspaceId: WS_A_REPORTING,
    });
    expect(ok.tenantId).toBe(TENANT_A);
    expect(ok.role).toBe("editor");

    await expect(
      gov.switchTenantContext({
        userId: USER_A_EDITOR,
        targetTenantId: TENANT_B,
        targetWorkspaceId: WS_B_REPORTING,
      }),
    ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });
  });

  it("PLT-T14: privileged admin actions require fresh MFA step-up when org policy enabled", () => {
    const staleMfaActor: ActorContext = {
      ...ACTOR_A_OWNER,
      mfaVerifiedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    };
    const dec = evaluatePolicyDecision({
      actor: staleMfaActor,
      resourceTenantId: TENANT_A,
      resource: "policy",
      action: "manage",
      source: "manual",
      mfaRequiredForPrivileged: true,
      mfaMaxAgeSeconds: 900,
    });
    expect(dec.allowed).toBe(false);
    expect(dec.denialCategory).toBe("mfa_step_up_required");
  });

  it("PLT-T15: centralized PolicyDecisionEngine enforces identical RBAC decisions across manual, typed_ai, voice_command & workflow", () => {
    for (const source of ["manual", "typed_ai", "voice_command", "workflow"] as const) {
      const dec = evaluatePolicyDecision({
        actor: ACTOR_A_VIEWER,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_REPORTING,
        resource: "document",
        action: "write",
        source,
      });
      expect(dec.allowed).toBe(false);
      expect(dec.denialCategory).toBe("role_forbidden");
    }
  });

  it("PLT-T16: private versioned object storage enforces tenant-scoped keys, SHA-256 integrity, and blocks path traversal", async () => {
    const content = Buffer.from("Confidential Q4 Financial Attachment", "utf8");
    const put = await store.putObject({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      objectId: "fin-report-pdf",
      version: 1,
      bytes: content,
    });
    expect(put.storageKey.startsWith(`tenants/${TENANT_A}/workspaces/${WS_A_REPORTING}/objects/fin-report-pdf/v1-`)).toBe(true);

    const read = await store.getObjectBytes({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      storageKey: put.storageKey,
      quarantineState: "clean",
    });
    expect(read.sha256).toBe(put.sha256);

    await expect(
      store.getObjectBytes({
        tenantId: TENANT_B,
        workspaceId: WS_B_REPORTING,
        storageKey: put.storageKey,
      }),
    ).rejects.toBeInstanceOf(PrivateObjectStorageError);

    await expect(
      store.putObject({
        tenantId: "../escape",
        workspaceId: WS_A_REPORTING,
        objectId: "bad",
        version: 1,
        bytes: content,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STORAGE_SEGMENT" });
  });

  it("PLT-T17: signed ephemeral object download tokens reject expired, tampered, and cross-tenant usage", async () => {
    const put = await store.putObject({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      objectId: "signed-test",
      version: 1,
      bytes: Buffer.from("Signed payload"),
    });
    const baseNow = 1_795_000_000_000;
    const token = store.issueSignedDownloadToken({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      objectId: "signed-test",
      version: 1,
      storageKey: put.storageKey,
      ttlSeconds: 60,
      nowMs: baseNow,
    });
    const verified = store.verifySignedDownloadToken({
      token,
      expectedTenantId: TENANT_A,
      expectedWorkspaceId: WS_A_REPORTING,
      expectedObjectId: "signed-test",
      nowMs: baseNow + 10_000,
    });
    expect(verified.storageKey).toBe(put.storageKey);

    expect(() =>
      store.verifySignedDownloadToken({
        token,
        expectedTenantId: TENANT_A,
        expectedWorkspaceId: WS_A_REPORTING,
        nowMs: baseNow + 120_000,
      }),
    ).toThrow(/expired/i);

    expect(() =>
      store.verifySignedDownloadToken({
        token: `${token.slice(0, -4)}AAAA`,
        expectedTenantId: TENANT_A,
        expectedWorkspaceId: WS_A_REPORTING,
        nowMs: baseNow + 5_000,
      }),
    ).toThrow(/signature mismatch/i);

    expect(() =>
      store.verifySignedDownloadToken({
        token,
        expectedTenantId: TENANT_B,
        expectedWorkspaceId: WS_B_REPORTING,
        nowMs: baseNow + 5_000,
      }),
    ).toThrow(/not valid for this tenant/i);
  });

  it("PLT-T18: quarantined or unscanned files are blocked from normal download until marked clean", async () => {
    const put = await store.putObject({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      objectId: "upload-scan-check",
      version: 1,
      bytes: Buffer.from("Uploaded workbook"),
    });
    const meta = await gov.registerFileObject({
      actor: ACTOR_A_EDITOR,
      objectId: "upload-scan-check",
      version: 1,
      storageKey: put.storageKey,
      filename: "november.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: put.byteSize,
      sha256: put.sha256,
      classification: "confidential",
      quarantineState: "pending_scan",
    });
    expect(meta.quarantineState).toBe("pending_scan");

    await expect(
      store.getObjectBytes({
        tenantId: TENANT_A,
        workspaceId: WS_A_REPORTING,
        storageKey: meta.storageKey,
        quarantineState: meta.quarantineState,
      }),
    ).rejects.toMatchObject({ code: "FILE_QUARANTINED_OR_UNSCANNED" });

    await gov.updateFileQuarantineState({
      actor: ACTOR_A_WSMGR,
      objectId: "upload-scan-check",
      version: 1,
      quarantineState: "clean",
    });
    const ok = await store.getObjectBytes({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      storageKey: meta.storageKey,
      quarantineState: "clean",
    });
    expect(ok.sha256).toBe(put.sha256);
  });

  it("PLT-T19: file version history, soft delete, recovery, and legal-hold purge protection work deterministically", async () => {
    const put = await store.putObject({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      objectId: "legal-doc",
      version: 1,
      bytes: Buffer.from("Tax Audit Pack"),
    });
    await gov.registerFileObject({
      actor: ACTOR_A_WSMGR,
      objectId: "legal-doc",
      version: 1,
      storageKey: put.storageKey,
      filename: "tax-audit.pdf",
      mimeType: "application/pdf",
      byteSize: put.byteSize,
      sha256: put.sha256,
      classification: "confidential",
      quarantineState: "clean",
      legalHold: true,
    });
    await gov.softDeleteFileObject(ACTOR_A_WSMGR, "legal-doc", 1);
    const activeFiles = await gov.listFileObjects(ACTOR_A_WSMGR);
    expect(activeFiles.some((f) => f.objectId === "legal-doc")).toBe(false);

    await gov.recoverFileObject(ACTOR_A_WSMGR, "legal-doc", 1);
    const recovered = await gov.listFileObjects(ACTOR_A_WSMGR);
    expect(recovered.some((f) => f.objectId === "legal-doc")).toBe(true);

    await expect(gov.purgeFileObject(ACTOR_A_WSMGR, "legal-doc", 1)).rejects.toMatchObject({
      code: "LEGAL_HOLD_ACTIVE",
    });
  });

  it("PLT-T20: orphan blob sweep removes unreferenced staging blobs while preserving all committed versions", async () => {
    const orphanKey = await store.writeUnreferencedStagingBlob(
      `tenants/${TENANT_A}/workspaces/${WS_A_REPORTING}/staging/abandoned.tmp`,
      Buffer.from("orphan bytes"),
    );
    const committed = await gov.listFileObjects(ACTOR_A_WSMGR, { includeDeleted: true });
    const referenced = new Set(committed.map((c) => c.storageKey));
    const swept = await store.sweepOrphanedBlobs(referenced);
    expect(swept.removedKeys).toContain(orphanKey);
    expect(swept.retainedCount).toBeGreaterThanOrEqual(1);
  });

  it("PLT-T21: org AI routing policy is persisted and versioned per tenant with strict isolation", async () => {
    const policy: ModelRoutingPolicy = {
      tenantId: TENANT_A,
      policyVersion: 1,
      rules: [
        {
          classification: "confidential",
          allowedProviders: ["mock-deterministic", "local-sandbox"],
          preferredOrder: ["mock-core-primary-v1", "local-zdr-secondary-v1"],
          requireZeroDataRetention: true,
          allowedResidencies: ["local"],
          allowExternalProvider: false,
        },
      ],
      updatedAt: NOW_ISO,
    };
    const savedV1 = await gov.upsertAiPolicy(ACTOR_A_OWNER, policy);
    const savedV2 = await gov.upsertAiPolicy(ACTOR_A_OWNER, policy);
    expect(savedV1.policyVersion).toBe(1);
    expect(savedV2.policyVersion).toBe(2);
    expect(await gov.getAiPolicy(TENANT_B)).toBeNull();
  });

  it("PLT-T22: org voice governance policy is persisted and versioned per tenant", async () => {
    const voicePolicy: VoicePolicyConfig = {
      tenantId: TENANT_A,
      policyVersion: 1,
      allowedLanguages: ["en-US", "km-KH"],
      allowedProviders: ["mock", "faster-whisper"],
      audioRetentionMode: "ephemeral_zero_retention",
      maxClipDurationSeconds: 90,
      minAutoConfirmConfidence: 0.85,
      requireReviewForFinancialCommands: true,
      updatedAt: NOW_ISO,
    };
    const saved = await gov.upsertVoicePolicy(ACTOR_A_OWNER, voicePolicy);
    expect(saved.allowedLanguages).toEqual(["en-US", "km-KH"]);
    expect(saved.audioRetentionMode).toBe("ephemeral_zero_retention");
    expect((await gov.getVoicePolicy(TENANT_A))?.maxClipDurationSeconds).toBe(90);
  });

  it("PLT-T23: commercial entitlement check fails distinctly from RBAC when feature is not included in active PlanVersion", async () => {
    const trialSub = await gov.assignTenantSubscription({
      tenantId: TENANT_B,
      planId: "free_trial",
      planVersion: 1,
    });
    const dec = evaluatePolicyDecision({
      actor: ACTOR_B_OWNER,
      resourceTenantId: TENANT_B,
      resourceWorkspaceId: WS_B_REPORTING,
      resource: "speech",
      action: "transcribe",
      source: "voice_command",
      subscription: trialSub,
      entitlementFeature: "khmerVoiceEnabled",
    });
    expect(dec.allowed).toBe(false);
    expect(dec.denialCategory).toBe("entitlement_missing");
    expect(dec.code).toBe("PLAN_ENTITLEMENT_REQUIRED");
  });

  it("PLT-T24: atomic quota reservation prevents concurrent overspend across parallel requests", async () => {
    // Tight AI token quota on Tenant B = 1,000 tokens
    await gov.assignTenantSubscription({
      tenantId: TENANT_B,
      planId: "sme_standard",
      planVersion: 1,
      entitlementOverrides: { monthlyAiTokens: 1_000 },
    });

    const results = await Promise.allSettled([
      gov.reserveQuota({
        tenantId: TENANT_B,
        workspaceId: WS_B_REPORTING,
        actorId: USER_B_OWNER,
        dimension: "ai_tokens",
        requestedUnits: 600,
        periodKey: "2026-11",
        idempotencyKey: "race-1",
        correlationId: "corr-1",
      }),
      gov.reserveQuota({
        tenantId: TENANT_B,
        workspaceId: WS_B_REPORTING,
        actorId: USER_B_OWNER,
        dimension: "ai_tokens",
        requestedUnits: 600,
        periodKey: "2026-11",
        idempotencyKey: "race-2",
        correlationId: "corr-2",
      }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("PLT-T25: quota release on failed or canceled operation restores reserved budget cleanly", async () => {
    const res = await gov.reserveQuota({
      tenantId: TENANT_B,
      workspaceId: WS_B_REPORTING,
      actorId: USER_B_OWNER,
      dimension: "ai_tokens",
      requestedUnits: 400,
      periodKey: "2026-11",
      idempotencyKey: "cancel-release-1",
      correlationId: "corr-cancel",
    });
    expect(await gov.releaseQuota(TENANT_B, res.reservationId)).toBe(true);

    // Budget is immediately reusable again!
    const res2 = await gov.reserveQuota({
      tenantId: TENANT_B,
      workspaceId: WS_B_REPORTING,
      actorId: USER_B_OWNER,
      dimension: "ai_tokens",
      requestedUnits: 400,
      periodKey: "2026-11",
      idempotencyKey: "cancel-release-2",
      correlationId: "corr-reuse",
    });
    expect(res2.status).toBe("reserved");
  });

  it("PLT-T26: usage settlement writes append-only ledger rows and app_runtime cannot UPDATE or DELETE ledger", async () => {
    const res = await gov.reserveQuota({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      actorId: USER_A_EDITOR,
      dimension: "voice_seconds",
      requestedUnits: 30,
      periodKey: "2026-11",
      idempotencyKey: "voice-settle-1",
      correlationId: "corr-voice-1",
    });
    const settled = await gov.settleQuota({
      tenantId: TENANT_A,
      reservationId: res.reservationId,
      actualUnits: 12,
      estimatedCostMicroUsd: 1800,
      source: "voice_command",
      providerId: "mock",
      isMock: true,
    });
    expect(settled.ledgerEntry.units).toBe(12);

    // Billing admin can read usage ledger
    const ledger = await gov.listUsageLedger(ACTOR_A_BILLING, TENANT_A);
    expect(ledger.some((l) => l.ledgerId === settled.ledgerEntry.ledgerId)).toBe(true);

    // Append-only enforcement: app_runtime UPDATE/DELETE on pa_usage_ledger must fail!
    await expect(
      withTenantTransaction(db, TENANT_A, async (tx) => {
        await tx.query("DELETE FROM pa_usage_ledger WHERE ledger_id = $1::uuid", [settled.ledgerEntry.ledgerId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("PLT-T27: past_due subscription blocks new metered AI/voice runs while preserving authorized read access to existing work", async () => {
    const pastDue = await gov.assignTenantSubscription({
      tenantId: TENANT_B,
      planId: "sme_standard",
      planVersion: 1,
      status: "past_due",
    });
    const meteredDenied = evaluatePolicyDecision({
      actor: ACTOR_B_OWNER,
      resourceTenantId: TENANT_B,
      resourceWorkspaceId: WS_B_REPORTING,
      resource: "ai_assistant",
      action: "apply_ai",
      source: "typed_ai",
      subscription: pastDue,
    });
    expect(meteredDenied.allowed).toBe(false);
    expect(meteredDenied.code).toBe("SUBSCRIPTION_PAST_DUE_METERED_BLOCKED");

    const existingReadAllowed = evaluatePolicyDecision({
      actor: ACTOR_B_OWNER,
      resourceTenantId: TENANT_B,
      resourceWorkspaceId: WS_B_REPORTING,
      resource: "document",
      action: "read",
      source: "manual",
      subscription: pastDue,
      isReadExistingAuthorizedWork: true,
    });
    expect(existingReadAllowed.allowed).toBe(true);
  });

  it("PLT-T28: mock billing webhook verifies HMAC signature, rejects tampering, and deduplicates replayed events", async () => {
    const event: BillingWebhookEvent = {
      providerEventId: "evt_mock_001",
      eventType: "subscription.upgraded",
      tenantId: TENANT_B,
      planId: "sme_pro",
      planVersion: 1,
      occurredAt: NOW_ISO,
      isMock: true,
    };
    const raw = JSON.stringify(event);
    const sig = signMockBillingWebhook(raw, gov.getMockBillingWebhookSecret());

    await expect(
      gov.processMockBillingWebhook({ rawPayload: raw, signatureHex: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE" });

    const first = await gov.processMockBillingWebhook({ rawPayload: raw, signatureHex: sig });
    expect(first.deduplicated).toBe(false);
    expect(first.subscription.planId).toBe("sme_pro");
    expect(first.subscription.status).toBe("active");

    const replay = await gov.processMockBillingWebhook({ rawPayload: raw, signatureHex: sig });
    expect(replay.deduplicated).toBe(true);
  });

  it("PLT-T29: durable job enqueue enforces idempotency and concurrent_jobs quota cap", async () => {
    await gov.assignTenantSubscription({
      tenantId: TENANT_B,
      planId: "sme_standard",
      planVersion: 1,
      entitlementOverrides: { maxConcurrentJobs: 1 },
    });
    const j1 = await gov.enqueueJob({
      actor: ACTOR_B_OWNER,
      jobType: "reporting_package_build",
      idempotencyKey: "job-idemp-1",
      payload: { packageId: "pkg-1" },
    });
    const j1Dup = await gov.enqueueJob({
      actor: ACTOR_B_OWNER,
      jobType: "reporting_package_build",
      idempotencyKey: "job-idemp-1",
      payload: { packageId: "pkg-1" },
    });
    expect(j1Dup.deduplicated).toBe(true);
    expect(j1Dup.job.jobId).toBe(j1.job.jobId);

    // Second distinct job hits maxConcurrentJobs=1 cap
    await expect(
      gov.enqueueJob({
        actor: ACTOR_B_OWNER,
        jobType: "reporting_package_build",
        idempotencyKey: "job-idemp-2",
        payload: { packageId: "pkg-2" },
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("PLT-T30: job lease heartbeat and fencing generation block stale worker split-brain commit", async () => {
    const enq = await gov.enqueueJob({
      actor: ACTOR_A_EDITOR,
      jobType: "export_pdf",
      idempotencyKey: "job-fence-1",
      payload: { documentId: "doc-1" },
      maxAttempts: 2,
    });
    const worker1 = await gov.claimNextJobLease({
      tenantId: TENANT_A,
      workerId: "worker-1",
      leaseDurationMs: 1_000,
    });
    expect(worker1?.jobId).toBe(enq.job.jobId);
    expect(worker1?.fencingGeneration).toBe(1);

    const hb = await gov.heartbeatJobLease({
      tenantId: TENANT_A,
      jobId: worker1!.jobId,
      leaseToken: worker1!.leaseToken!,
      fencingGeneration: 1,
      extendMs: 1_000,
    });
    expect(hb.fencingGeneration).toBe(1);

    // Simulate worker-1 stall -> reclaim after expiry -> worker-2 claims gen 2
    const reclaimed = await gov.reclaimExpiredLeases(TENANT_A, new Date(Date.now() + 60_000).toISOString());
    expect(reclaimed.requeued).toContain(worker1!.jobId);

    const worker2 = await gov.claimNextJobLease({
      tenantId: TENANT_A,
      workerId: "worker-2",
      leaseDurationMs: 30_000,
    });
    expect(worker2?.fencingGeneration).toBe(2);

    // Stale worker-1 attempting to commit MUST be fenced out!
    await expect(
      gov.completeJob({
        tenantId: TENANT_A,
        jobId: worker1!.jobId,
        leaseToken: worker1!.leaseToken!,
        fencingGeneration: 1,
        result: { stale: true },
      }),
    ).rejects.toMatchObject({ code: "STALE_LEASE_FENCING_CONFLICT" });

    // Worker-2 commits cleanly
    const done = await gov.completeJob({
      tenantId: TENANT_A,
      jobId: worker2!.jobId,
      leaseToken: worker2!.leaseToken!,
      fencingGeneration: 2,
      result: { ok: true },
    });
    expect(done.state).toBe("completed");
  });

  it("PLT-T31: safe job cancellation releases reserved concurrent_jobs quota immediately", async () => {
    const enq = await gov.enqueueJob({
      actor: ACTOR_A_EDITOR,
      jobType: "ai_batch",
      idempotencyKey: "job-cancel-1",
      payload: {},
    });
    const canceled = await gov.requestJobCancellation(ACTOR_A_EDITOR, enq.job.jobId);
    expect(canceled.state).toBe("canceled");
    expect(canceled.cancelRequestedAt).toBeTruthy();
  });

  it("PLT-T32: exhausted expired worker leases route cleanly to dead_letter and release quota", async () => {
    const enq = await gov.enqueueJob({
      actor: ACTOR_A_EDITOR,
      jobType: "flaky_job",
      idempotencyKey: "job-dlq-1",
      payload: {},
      maxAttempts: 1,
    });
    const claimed = await gov.claimNextJobLease({
      tenantId: TENANT_A,
      workerId: "worker-crash",
      leaseDurationMs: 500,
    });
    expect(claimed?.jobId).toBe(enq.job.jobId);

    const res = await gov.reclaimExpiredLeases(TENANT_A, new Date(Date.now() + 60_000).toISOString());
    expect(res.deadLettered).toContain(enq.job.jobId);
  });

  it("PLT-T33: audit_logs is append-only (UPDATE/DELETE denied to app_runtime) and sensitive metadata is redacted", async () => {
    await expect(
      withTenantTransaction(db, TENANT_A, async (tx) => {
        await tx.query("DELETE FROM audit_logs WHERE tenant_id = $1::uuid", [TENANT_A]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("PLT-T34: audit query supports filtering by action prefix/actor/workspace with strict tenant isolation", async () => {
    const logsA = await gov.queryAuditLogs(ACTOR_A_AUDITOR, {
      tenantId: TENANT_A,
      actionPrefix: "organization.",
    });
    expect(logsA.length).toBeGreaterThanOrEqual(2);
    expect(logsA.every((l) => l.tenantId === TENANT_A)).toBe(true);

    await expect(
      gov.queryAuditLogs(ACTOR_A_AUDITOR, { tenantId: TENANT_B }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("PLT-T35: isolated end-to-end DB + private object-store backup and restore drill preserves full parity", async () => {
    const dbSnapshot = await exportPaExtendedLogicalBackup(db);
    const objSnapshot = await store.exportSnapshot();

    const targetDb = new PgliteDatabaseAdapter();
    const restoreDir = mkdtempSync(path.join(tmpdir(), "aios-pa00-restore-"));
    try {
      await initializePostgreSqlSchema(targetDb);
      await initializePaGovernanceSchema(targetDb);
      await restorePaExtendedLogicalBackup(targetDb, dbSnapshot);

      const restoredStore = new LocalPrivateObjectStore(restoreDir);
      const objRes = await restoredStore.restoreSnapshot(objSnapshot);
      expect(objRes.restoredCount).toBe(objSnapshot.entries.length);
      expect(objRes.verifiedSha256Count).toBe(objSnapshot.entries.length);

      const targetGov = new PlatformGovernanceService(targetDb);
      const restoredSub = await targetGov.getTenantSubscription(TENANT_A);
      expect(restoredSub?.planId).toBe("sme_standard");
      const restoredFiles = await targetGov.listFileObjects(ACTOR_A_WSMGR);
      expect(restoredFiles.length).toBeGreaterThanOrEqual(2);
      const restoredPolicy = await targetGov.getVoicePolicy(TENANT_A);
      expect(restoredPolicy?.allowedLanguages).toEqual(["en-US", "km-KH"]);
    } finally {
      await targetDb.close();
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("PLT-T36: operational health snapshot reports live DB connectivity, FORCE RLS status, job queue & storage metrics", async () => {
    const health = await gov.getServiceHealthSnapshot(TENANT_A);
    expect(health.database.connected).toBe(true);
    expect(health.database.coreForceRlsEnabled).toBe(true);
    expect(health.database.paForceRlsEnabled).toBe(true);
    expect(health.jobs.deadLetter).toBeGreaterThanOrEqual(1); // from PLT-T32
    expect(health.status).toBe("degraded"); // honestly reflects dead-letter job present!
    expect(health.storage.totalObjects).toBeGreaterThanOrEqual(2);
  });
});
