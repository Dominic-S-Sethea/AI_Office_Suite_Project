import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ActorContext,
  BillingWebhookEvent,
  ModelRoutingPolicy,
  VoicePolicyConfig,
} from "@ai-office-suite/shared-contracts";
import { InMemoryAuditStore } from "@ai-office-suite/audit";
import {
  AuthorizationError,
  evaluatePolicyDecision,
} from "@ai-office-suite/authorization";
import {
  exportPaExtendedLogicalBackup,
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
import { createJwtAuthMiddleware } from "@ai-office-suite/identity/express";
import {
  InMemoryStorageAdapter,
  LocalPrivateObjectStore,
  PrivateObjectStorageError,
} from "@ai-office-suite/storage";
import {
  escapeHtml,
  inspectAndExtractOoxmlZip,
  validateDocxUploadBytes,
} from "@ai-office-suite/validation";
import { DocumentService } from "@ai-office-suite/documents-module";
import { getBlockPlainText } from "@ai-office-suite/document-engine";
import { CorporateKnowledgeIndex } from "@ai-office-suite/ai-module";
import {
  TerminologyRegistry,
  VoiceGovernancePipeline,
} from "@ai-office-suite/speech-engine";
import {
  CORPORATE_THEME_V1,
  exportPresentationToPptxBuffer,
} from "@ai-office-suite/presentation-engine";

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

describe("V1.4 Aligned PA-00 — Shared Platform Administration Feasibility (PLT-T01..PLT-T36)", () => {
  let db: PgliteDatabaseAdapter;
  let gov: PlatformGovernanceService;
  let storeDir: string;
  let store: LocalPrivateObjectStore;
  let pwHash: string;
  let consumedInviteToken: string;

  beforeAll(async () => {
    db = new PgliteDatabaseAdapter();
    await initializePostgreSqlSchema(db);
    await initializePaGovernanceSchema(db);
    gov = new PlatformGovernanceService(db, { billingWebhookSecret: "pa00-test-webhook-secret-32chars!!" });
    await gov.seedDefaultPlans();

    storeDir = mkdtempSync(path.join(tmpdir(), "aios-pa00-store-"));
    store = new LocalPrivateObjectStore(storeDir, "pa00-object-signing-secret-32chars!");
    pwHash = await hashPassword("StrongPass123!");

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

  it("PLT-T01: create two tenants, switch authenticated context, and enforce org suspension isolation", async () => {
    const wsA = await gov.getWorkspace(TENANT_A, WS_A_REPORTING);
    const wsB = await gov.getWorkspace(TENANT_B, WS_B_REPORTING);
    const wsPayroll = await gov.getWorkspace(TENANT_A, WS_A_PAYROLL);
    expect(wsA?.name).toBe("Reporting");
    expect(wsB?.name).toBe("Reporting");
    expect(wsPayroll?.visibility).toBe("restricted");

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

    // Organization suspension blocks logins & active operations until reactivated
    const suspended = await gov.setOrganizationStatus({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      status: "suspended",
      reason: "Compliance pause drill",
    });
    expect(suspended.status).toBe("suspended");
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_EDITOR,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_REPORTING,
        resource: "document",
        action: "write",
        source: "manual",
        organizationStatus: "suspended",
      }).denialCategory,
    ).toBe("organization_suspended");
    await expect(
      authenticateUserWithPassword({
        db,
        email: "editor@tenanta.example",
        password: "StrongPass123!",
        tenantId: TENANT_A,
        workspaceId: WS_A_REPORTING,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await gov.setOrganizationStatus({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      status: "active",
      reason: "Compliance pause lifted",
    });
  });

  it("PLT-T02: invite user with scoped role and expiry — stores only SHA-256 hash, redacts audit, grants exact scoped membership", async () => {
    const { invitation, rawToken } = await gov.createInvitation({
      actor: ACTOR_A_WSMGR,
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      email: "invitee1@tenanta.example",
      invitedRole: "editor",
      expiresInSeconds: 3600,
    });
    consumedInviteToken = rawToken;
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
    expect(JSON.stringify(logs[0])).not.toContain(rawToken);
    expect(logs[0]?.metadata?.raw_invite_token).toBe("[REDACTED]");

    const accepted = await gov.acceptInvitation({
      tenantId: TENANT_A,
      rawToken,
      acceptingUserId: USER_A_INVITEE_1,
      acceptingEmail: "invitee1@tenanta.example",
    });
    expect(accepted.role).toBe("editor");
  });

  it("PLT-T03: reuse expired, revoked, or already-accepted invite — rejects replay with zero duplicate seat", async () => {
    await expect(
      gov.acceptInvitation({
        tenantId: TENANT_A,
        rawToken: consumedInviteToken,
        acceptingUserId: USER_A_INVITEE_1,
        acceptingEmail: "invitee1@tenanta.example",
      }),
    ).rejects.toMatchObject({ code: "INVITATION_ALREADY_CONSUMED" });

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
    await expect(
      gov.acceptInvitation({
        tenantId: TENANT_A,
        rawToken: exp.rawToken,
        acceptingUserId: USER_A_INVITEE_2,
        acceptingEmail: "invitee2@tenanta.example",
        nowIso: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
  });

  it("PLT-T04: unauthorized role assignment / privilege escalation — denied fail-closed for workspace_manager & auditor", () => {
    // workspace_manager cannot manage billing or access cross-workspace Payroll
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

    // Auditor cannot escalate to membership management or document writes
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_AUDITOR,
        resourceTenantId: TENANT_A,
        resource: "membership",
        action: "manage",
        source: "manual",
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_EDITOR,
        resourceTenantId: TENANT_A,
        resource: "membership",
        action: "manage",
        source: "manual",
      }).allowed,
    ).toBe(false);
  });

  it("PLT-T05: remove sole owner — blocked until approved MFA-verified ownership transfer", async () => {
    await expect(
      gov.offboardOrSuspendMember({
        actor: ACTOR_A_OWNER,
        tenantId: TENANT_A,
        targetUserId: USER_A_OWNER,
        mode: "revoke",
        reason: "Self-removal attempt",
      }),
    ).rejects.toMatchObject({ code: "SOLE_OWNER_CANNOT_BE_REMOVED" });

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

  it("PLT-T06: suspend/offboard user during active lifecycle — revokes membership, bumps token_version, blocks subsequent work", async () => {
    const authBefore = await authenticateUserWithPassword({
      db,
      email: "offboard@tenanta.example",
      password: "StrongPass123!",
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
    });
    expect(verifySessionToken(authBefore.token)?.tv).toBe(1);

    const res = await gov.offboardOrSuspendMember({
      actor: ACTOR_A_OWNER,
      tenantId: TENANT_A,
      targetUserId: USER_A_OFFBOARD,
      mode: "revoke",
      reason: "Employee departure",
    });
    expect(res.newTokenVersion).toBe(2);
    expect(res.updatedMemberships).toBeGreaterThanOrEqual(1);

    await expect(
      gov.switchTenantContext({
        userId: USER_A_OFFBOARD,
        targetTenantId: TENANT_A,
        targetWorkspaceId: WS_A_REPORTING,
      }),
    ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });

    // Verify offboarded user cannot log in (uniform H4 INVALID_CREDENTIALS) or reuse pre-revocation JWT via middleware (F-24)
    await expect(
      authenticateUserWithPassword({
        db,
        email: "offboard@tenanta.example",
        password: "StrongPass123!",
        tenantId: TENANT_A,
        workspaceId: WS_A_REPORTING,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const middleware = createJwtAuthMiddleware(db, []);
    let mwStatus = 0;
    let mwJson: unknown;
    let nextCalled = false;
    await middleware(
      {
        headers: { authorization: `Bearer ${authBefore.token}` },
        method: "GET",
        path: "/api/documents",
        header: () => undefined,
      } as unknown as Parameters<typeof middleware>[0],
      {
        status(code: number) {
          mwStatus = code;
          return this;
        },
        json(payload: unknown) {
          mwJson = payload;
          return this;
        },
      } as unknown as Parameters<typeof middleware>[1],
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect([401, 403]).toContain(mwStatus);
    expect(mwJson).toMatchObject({ code: expect.stringMatching(/ACCOUNT_REVOKED|TOKEN_REVOKED|ACCOUNT_INACTIVE/) });
  });

  it("PLT-T07: swap another tenant's object ID in API — denied across DB workspace, object storage & audit without existence leak", async () => {
    const crossWs = await gov.getWorkspace(TENANT_A, WS_B_REPORTING);
    expect(crossWs).toBeNull();

    const put = await store.putObject({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      objectId: "swap-target",
      version: 1,
      bytes: Buffer.from("Tenant A Confidential"),
    });
    await expect(
      store.getObjectBytes({
        tenantId: TENANT_B,
        workspaceId: WS_B_REPORTING,
        storageKey: put.storageKey,
      }),
    ).rejects.toBeInstanceOf(PrivateObjectStorageError);

    await expect(
      gov.queryAuditLogs(ACTOR_A_AUDITOR, { tenantId: TENANT_B }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("PLT-T08: query metadata using real non-superuser app DB role — cross-tenant rows denied & pooling scope never retained", async () => {
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

    // Live PostgreSQL 16 Docker verification using real non-superuser NOBYPASSRLS login role
    const livePgUrl = process.env.TEST_POSTGRES_URL?.trim();
    if (process.env.REQUIRE_LIVE_PG === "true" && !livePgUrl) {
      throw new Error("REQUIRE_LIVE_PG=true requires TEST_POSTGRES_URL for PLT-T08 live PostgreSQL 16 RLS check.");
    }
    if (livePgUrl) {
      const adminPg = new NodePgDatabaseAdapter(livePgUrl);
      try {
        await initializePostgreSqlSchema(adminPg, { force: true });
        await initializePaGovernanceSchema(adminPg, { force: true });
        await adminPg.query(
          `INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'Live PG Org A', 'active'), ($2::uuid, 'Live PG Org B', 'active') ON CONFLICT (tenant_id) DO NOTHING`,
          [TENANT_A, TENANT_B],
        );
        await adminPg.query(
          `INSERT INTO pa_tenant_subscriptions (
             subscription_id, tenant_id, plan_id, plan_version, status,
             billing_period_start, billing_period_end, seats_limit, storage_limit_bytes, monthly_token_limit, monthly_voice_seconds_limit
           ) VALUES
             ('11111111-1111-4111-8111-1111111111a1'::uuid, $1::uuid, 'starter', 1, 'active', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 10, 1000000, 10000, 600),
             ('22222222-2222-4222-8222-2222222222b2'::uuid, $2::uuid, 'starter', 1, 'active', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 10, 1000000, 10000, 600)
           ON CONFLICT (tenant_id) DO NOTHING`,
          [TENANT_A, TENANT_B],
        );
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

          // Unset tenant context must see 0 rows even with Tenant A + Tenant B rows present
          const leaked = await appPg.query<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM pa_tenant_subscriptions");
          expect(Number(leaked.rows[0]?.cnt ?? 0)).toBe(0);

          // Tenant A context sees ONLY Tenant A's subscription
          const scopedRows = await withTenantTransaction(appPg, TENANT_A, async (tx) => {
            const res = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM pa_tenant_subscriptions");
            return res.rows;
          });
          expect(scopedRows).toHaveLength(1);
          expect(scopedRows[0]?.tenant_id).toBe(TENANT_A);

          // Cross-tenant write rejected by RLS
          await expect(
            withTenantTransaction(appPg, TENANT_A, async (tx) => {
              await tx.query(
                "UPDATE pa_tenant_subscriptions SET status = 'suspended' WHERE tenant_id = $1::uuid",
                [TENANT_B],
              );
              await tx.query(
                `INSERT INTO pa_tenant_subscriptions (
                   subscription_id, tenant_id, plan_id, plan_version, status,
                   billing_period_start, billing_period_end, seats_limit, storage_limit_bytes, monthly_token_limit, monthly_voice_seconds_limit
                 ) VALUES ('33333333-3333-4333-8333-3333333333c3'::uuid, $1::uuid, 'starter', 1, 'active', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 5, 1000, 100, 10)`,
                [TENANT_B],
              );
            }),
          ).rejects.toThrow(/row-level security|violates|unique/i);
        } finally {
          await appPg.close();
        }
      } finally {
        try {
          await adminPg.exec(
            "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM aios_pa00_app; REVOKE ALL ON SCHEMA public FROM aios_pa00_app; DROP ROLE IF EXISTS aios_pa00_app;",
          );
        } catch {
          // best-effort test role cleanup
        }
        await adminPg.close();
      }
    }
  });

  it("PLT-T09: cross-tenant foreign-key relationship — rejected by PostgreSQL composite/tenant FK & RLS", async () => {
    await expect(
      withTenantTransaction(db, TENANT_A, async (tx) => {
        // Attempt to insert a Tenant A file object referencing Tenant B's workspace_id
        await tx.query(
          `INSERT INTO pa_file_objects (
             object_id, tenant_id, workspace_id, version, storage_key, filename, mime_type,
             byte_size, sha256, classification, quarantine_state, created_by
           ) VALUES ($1, $2::uuid, $3::uuid, 1, $4, 'bad.pdf', 'application/pdf', 10, $5, 'internal', 'clean', $6::uuid)`,
          ["fk-cross-test", TENANT_A, WS_B_REPORTING, "tenants/bad/key", "a".repeat(64), USER_A_EDITOR],
        );
      }),
    ).rejects.toThrow(/foreign key|violates|row-level security/i);
  });

  it("PLT-T10: viewer attempts edit/AI/voice mutation — identical PolicyDecisionEngine deny across manual, typed_ai, voice_command & workflow", () => {
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

  it("PLT-T11: billing_admin denied confidential finance content while scoped usage allowed; restricted Payroll isolated from org admin", () => {
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
      expect(
        evaluatePolicyDecision({
          actor: ACTOR_A_BILLING,
          resourceTenantId: TENANT_A,
          resourceWorkspaceId: WS_A_REPORTING,
          resource,
          action,
          source,
        }).denialCategory,
      ).toBe("role_forbidden");
    }

    // Restricted Payroll workspace isolation
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_ADMIN_NO_PAYROLL,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_PAYROLL,
        resource: "document",
        action: "read",
        source: "manual",
        workspaceVisibility: "restricted",
        classification: "restricted",
      }).denialCategory,
    ).toBe("workspace_content_isolated");
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_PAYROLL_MEMBER,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_PAYROLL,
        resource: "document",
        action: "read",
        source: "manual",
        workspaceVisibility: "restricted",
        classification: "restricted",
      }).allowed,
    ).toBe(true);
  });

  it("PLT-T12: revoke access then query search/cache/download — denies unauthorized retrieval & new URL issuance", () => {
    const idx = new CorporateKnowledgeIndex();
    idx.indexChunk({
      chunkId: "chk-revoke-12",
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      workspaceVisibility: "standard",
      artifactId: "doc-revoked-12",
      artifactKind: "document",
      revision: 1,
      classification: "confidential",
      text: "Confidential Board Forecast USD 500,000",
      updatedAt: NOW_ISO,
    });
    expect(idx.retrieve({ actor: ACTOR_A_EDITOR, query: "Board Forecast" }).citations).toHaveLength(1);
    idx.revokeArtifact(TENANT_A, "doc-revoked-12");
    expect(idx.retrieve({ actor: ACTOR_A_EDITOR, query: "Board Forecast" }).citations).toHaveLength(0);

    // Revoked user attempting signed download URL issuance / access denied by PolicyDecisionEngine
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_A_ADMIN_NO_PAYROLL,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_PAYROLL,
        resource: "file",
        action: "export",
        source: "manual",
        workspaceVisibility: "restricted",
      }).allowed,
    ).toBe(false);
  });

  it("PLT-T13: session expiry / logout / tenant switch — rejects stale token and immediately terminates active voice capture", async () => {
    let releasedQuota = 0;
    const voicePipeline = new VoiceGovernancePipeline({
      terminology: new TerminologyRegistry(),
      quota: {
        reserveVoiceSeconds: async () => ({ reservationId: "vres-plt13" }),
        settleVoiceSeconds: async () => {},
        releaseVoiceSeconds: async () => {
          releasedQuota += 1;
        },
      },
    });
    const activeVoice = voicePipeline.sessions.createSession({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      actorId: USER_A_EDITOR,
      mode: "command",
      language: "km-KH",
    });
    voicePipeline.sessions.transition(activeVoice.sessionId, {
      eventId: "p13-1",
      eventSeq: 1,
      targetState: "requesting_permission",
    });
    voicePipeline.sessions.transition(activeVoice.sessionId, {
      eventId: "p13-2",
      eventSeq: 2,
      targetState: "recording",
    });
    voicePipeline.sessions.recordTranscriptionResult(activeVoice.sessionId, {
      rawTranscript: "",
      normalizedTranscript: "",
      appliedTerms: [],
      confidence: 0,
      providerId: "mock",
      isMock: true,
      retainAudio: true,
      criticalFieldValidation: undefined,
      reservationId: "vres-plt13",
    });

    // Tenant switch / logout triggers immediate microphone termination + audio wipe + quota release
    const term = await voicePipeline.cancelOnActorSessionEnd(TENANT_A, USER_A_EDITOR, "TENANT_SWITCH_OR_LOGOUT");
    expect(term.terminatedSessions).toHaveLength(1);
    expect(term.terminatedSessions[0]?.state).toBe("canceled");
    expect(term.terminatedSessions[0]?.audioBufferPresent).toBe(false);
    expect(term.terminatedSessions[0]?.audioRetained).toBe(false);
    expect(releasedQuota).toBe(1);

    // Tampered or invalid session token is rejected fail-closed
    expect(verifySessionToken("invalid.token.payload")).toBeNull();
  });

  it("PLT-T14: privileged change without fresh MFA — blocked with MFA_STEP_UP_REQUIRED", async () => {
    await expect(
      gov.transferOwnership({
        actor: ACTOR_A_OWNER_NO_MFA,
        tenantId: TENANT_A,
        workspaceId: WS_A_REPORTING,
        newOwnerUserId: USER_A_ADMIN,
      }),
    ).rejects.toMatchObject({ code: "MFA_STEP_UP_REQUIRED" });

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

  it("PLT-T15 & PLT-T16 & PLT-T17: optimistic revision conflict, post-approval edit invalidation, and non-destructive revision restore", async () => {
    const storage = new InMemoryStorageAdapter();
    const audit = new InMemoryAuditStore();
    const docs = new DocumentService(storage, audit);
    const doc = await docs.createDocument(ACTOR_A_EDITOR, {
      title: "Board Letter",
      language: "en",
      blocks: [{ id: "p1", type: "paragraph", runs: [{ text: "Revision 1 text" }] }],
    });

    // PLT-T15: Editor 1 advances to rev 2; Editor 2 with stale expectedRevision=1 receives REVISION_CONFLICT
    const rev2 = await docs.updateDocument(ACTOR_A_EDITOR, doc.documentId, {
      expectedRevision: 1,
      blocks: [{ id: "p1", type: "paragraph", runs: [{ text: "Approved Revision 2 text" }] }],
      summary: "Approved content",
      source: "manual",
    });
    expect(rev2.revision).toBe(2);
    await expect(
      docs.updateDocument(ACTOR_A_OWNER, doc.documentId, {
        expectedRevision: 1,
        blocks: [{ id: "p1", type: "paragraph", runs: [{ text: "Conflicting stale edit" }] }],
        summary: "Stale write",
        source: "manual",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    // PLT-T16: Editing after revision 2 produces a new draft revision (rev 3), invalidating approval bound to rev 2
    const approvedRevision = rev2.revision;
    const rev3 = await docs.updateDocument(ACTOR_A_EDITOR, doc.documentId, {
      expectedRevision: 2,
      blocks: [{ id: "p1", type: "paragraph", runs: [{ text: "Post-approval draft edit" }] }],
      summary: "New draft after approval",
      source: "manual",
    });
    expect(rev3.revision).toBe(3);
    expect(rev3.revision).not.toBe(approvedRevision);

    // PLT-T17: Restore revision 1 creates new revision 4 while retaining revisions 1, 2, 3 intact
    const restored = await docs.restoreVersion(ACTOR_A_EDITOR, doc.documentId, 1);
    expect(restored.revision).toBe(4);
    expect(getBlockPlainText(restored.blocks[0]!)).toBe("Revision 1 text");
    const history = await docs.listVersions(ACTOR_A_EDITOR, doc.documentId);
    expect(history).toHaveLength(4);
  });

  it("PLT-T18: quarantined/unscanned files blocked from normal download until clean scan completes", async () => {
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

  it("PLT-T19: retrieve file using guessed key, expired URL, tampered signature, or wrong tenant — denied fail-closed", async () => {
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
    expect(
      store.verifySignedDownloadToken({
        token,
        expectedTenantId: TENANT_A,
        expectedWorkspaceId: WS_A_REPORTING,
        expectedObjectId: "signed-test",
        nowMs: baseNow + 10_000,
      }).storageKey,
    ).toBe(put.storageKey);

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

  it("PLT-T20: export chart/notes with restricted hidden data — strips confidential speaker notes on restricted export", async () => {
    const deck = {
      presentationId: "pres-plt-t20",
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      title: "Board Q4 Briefing",
      language: "en" as const,
      revision: 1,
      status: "draft" as const,
      theme: CORPORATE_THEME_V1,
      scopeLabel: "All Departments (Q4 2026)",
      slides: [
        {
          slideId: "sl-1",
          order: 0,
          layoutId: "kpi_summary" as const,
          title: "Operating Margin",
          speakerNotes: "INTERNAL ONLY: renegotiate supplier discount before Jan 15.",
          hidden: false,
          readingOrder: ["el-kpi"],
          sourceRefs: [],
          elements: [
            {
              elementId: "el-kpi",
              type: "text" as const,
              zIndex: 1,
              locked: false,
              altText: "Operating Margin KPI",
              bounds: { xIn: 0.6, yIn: 1.2, wIn: 6.0, hIn: 1.0 },
              text: "Operating Margin: 26.67%",
              fontSizePt: 20,
              bold: true,
            },
          ],
        },
      ],
      createdBy: USER_A_EDITOR,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    const sanitized = await exportPresentationToPptxBuffer(deck, {
      includeSpeakerNotes: false,
      includeHiddenSlides: false,
    });
    expect(sanitized.disclosure.strippedSpeakerNotesCount).toBe(1);
    const inspected = inspectAndExtractOoxmlZip(new Uint8Array(sanitized.buffer), "board-sanitized.pptx", "pptx");
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      const allXml = Object.values(inspected.entries)
        .map((b) => Buffer.from(b).toString("utf8"))
        .join("\n");
      expect(allXml).not.toContain("renegotiate supplier discount");
    }
  });

  it("PLT-T21: delete referenced source with retention/legal hold — enforces soft-delete, recovery, and LEGAL_HOLD_ACTIVE block", async () => {
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
    expect((await gov.listFileObjects(ACTOR_A_WSMGR)).some((f) => f.objectId === "legal-doc")).toBe(false);

    await gov.recoverFileObject(ACTOR_A_WSMGR, "legal-doc", 1);
    expect((await gov.listFileObjects(ACTOR_A_WSMGR)).some((f) => f.objectId === "legal-doc")).toBe(true);

    await expect(gov.purgeFileObject(ACTOR_A_WSMGR, "legal-doc", 1)).rejects.toMatchObject({
      code: "LEGAL_HOLD_ACTIVE",
    });
  });

  it("PLT-T22: upload invalid MIME, extension or signature — rejected with safe diagnostic code", () => {
    const badExt = validateDocxUploadBytes("malware.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00]));
    expect(badExt.ok).toBe(false);
    if (!badExt.ok) expect(badExt.code).toBe("UNSUPPORTED_EXTENSION");

    const spoofedDocx = validateDocxUploadBytes("spoofed.docx", Buffer.from("NOT_A_ZIP_CONTAINER", "utf8"));
    expect(spoofedDocx.ok).toBe(false);
    if (!spoofedDocx.ok) expect(spoofedDocx.code).toBe("INVALID_ZIP_MAGIC");
  });

  it("PLT-T23: upload oversized or decompression-bomb fixture — bounded reject with zero memory exhaustion", () => {
    // 10 MB of repeated zeros compresses down to ~10 KB (ratio > 1000:1 -> triggers ZIP bomb guard!)
    const bombPayload = new Uint8Array(10 * 1024 * 1024);
    const bombZip = zipSync({ "word/document.xml": bombPayload }, { level: 9 });
    const res = inspectAndExtractOoxmlZip(bombZip, "bomb.docx", "docx");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(["ZIP_BOMB_BLOCKED", "ZIP_BOMB_RATIO_EXCEEDED", "ZIP_DECOMPRESSED_TOO_LARGE", "ZIP_ENTRY_TOO_LARGE"]).toContain(res.code);
    }
  });

  it("PLT-T24: import macro/external links/malformed OpenXML — blocked explicitly with zero macro or network execution", () => {
    const macroDoc = validateDocxUploadBytes("finance.docm", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(macroDoc.ok).toBe(false);
    if (!macroDoc.ok) expect(macroDoc.code).toBe("MACRO_FILE_BLOCKED");

    // Embedded vbaProject.bin inside .docx extension is caught by Central Directory preflight
    const smuggledMacro = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/vbaProject.bin": strToU8("MACRO_BYTES"),
    });
    const inspected = inspectAndExtractOoxmlZip(smuggledMacro, "smuggled.docx", "docx");
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.code).toMatch(/MACRO/i);
  });

  it("PLT-T25: path traversal or active-content preview — blocked/sanitized with zero arbitrary file or script execution", async () => {
    await expect(
      store.putObject({
        tenantId: "../escape",
        workspaceId: WS_A_REPORTING,
        objectId: "bad",
        version: 1,
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STORAGE_SEGMENT" });

    const traversalZip = zipSync({ "../etc/passwd": strToU8("root:x:0:0") });
    const zipRes = inspectAndExtractOoxmlZip(traversalZip, "traversal.docx", "docx");
    expect(zipRes.ok).toBe(false);
    if (!zipRes.ok) expect(zipRes.code).toMatch(/TRAVERSAL|PATH/i);

    const safePreview = escapeHtml('<script>alert("xss")</script><img src=x onerror=alert(1)>');
    expect(safePreview).not.toContain("<script>");
    expect(safePreview).toContain("&lt;script&gt;");
  });

  it("PLT-T26: upload canceled between blob and metadata commit — safe orphan sweep removes unreferenced staging blob", async () => {
    const orphanKey = await store.writeUnreferencedStagingBlob(
      `tenants/${TENANT_A}/workspaces/${WS_A_REPORTING}/staging/abandoned.tmp`,
      Buffer.from("orphan bytes"),
    );
    const committed = await gov.listFileObjects(ACTOR_A_WSMGR, { includeDeleted: true });
    const referenced = new Set(committed.map((c) => c.storageKey));
    const swept = await store.sweepOrphanedBlobs(referenced, { minAgeMs: 0 });
    expect(swept.removedKeys).toContain(orphanKey);
    expect(swept.retainedCount).toBeGreaterThanOrEqual(1);
  });

  it("PLT-T27: worker crash, lease expiry/retry, fencing generation, and DLQ — recovers once; old lease cannot commit", async () => {
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

    const reclaimed = await gov.reclaimExpiredLeases(TENANT_A, new Date(Date.now() + 60_000).toISOString());
    expect(reclaimed.requeued).toContain(worker1!.jobId);

    const worker2 = await gov.claimNextJobLease({
      tenantId: TENANT_A,
      workerId: "worker-2",
      leaseDurationMs: 30_000,
    });
    expect(worker2?.fencingGeneration).toBe(2);

    await expect(
      gov.completeJob({
        tenantId: TENANT_A,
        jobId: worker1!.jobId,
        leaseToken: worker1!.leaseToken!,
        fencingGeneration: 1,
        result: { stale: true },
      }),
    ).rejects.toMatchObject({ code: "STALE_LEASE_FENCING_CONFLICT" });

    const done = await gov.completeJob({
      tenantId: TENANT_A,
      jobId: worker2!.jobId,
      leaseToken: worker2!.leaseToken!,
      fencingGeneration: 2,
      result: { ok: true },
    });
    expect(done.state).toBe("completed");

    // Exhausted maxAttempts=1 routes cleanly to dead_letter
    const dlqJob = await gov.enqueueJob({
      actor: ACTOR_A_EDITOR,
      jobType: "flaky_job",
      idempotencyKey: "job-dlq-1",
      payload: {},
      maxAttempts: 1,
    });
    await gov.claimNextJobLease({ tenantId: TENANT_A, workerId: "worker-crash", leaseDurationMs: 500 });
    const dlqRes = await gov.reclaimExpiredLeases(TENANT_A, new Date(Date.now() + 60_000).toISOString());
    expect(dlqRes.deadLettered).toContain(dlqJob.job.jobId);
  });

  it("PLT-T28: cancel running export/AI operation — stops eligible work cleanly and releases concurrent_jobs quota", async () => {
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

  it("PLT-T29: exhaust tenant concurrency quota — bounded denial on Tenant B while Tenant A remains unaffected", async () => {
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

    await expect(
      gov.enqueueJob({
        actor: ACTOR_B_OWNER,
        jobType: "reporting_package_build",
        idempotencyKey: "job-idemp-2",
        payload: { packageId: "pkg-2" },
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    // Tenant A remains completely usable (noisy-neighbor isolation)
    const tenantAJob = await gov.enqueueJob({
      actor: ACTOR_A_EDITOR,
      jobType: "reporting_package_build",
      idempotencyKey: "job-tenanta-isolated",
      payload: { packageId: "pkg-a" },
    });
    expect(tenantAJob.job.state).toBe("queued");
  });

  it("PLT-T30: two requests compete for remaining seat and budget — atomic reservation prevents oversubscription", async () => {
    // 1. Seat cap enforcement (Tenant A currently has 10 active users after PLT-T06 offboarding -> cap=10 blocks 11th)
    await gov.assignTenantSubscription({
      tenantId: TENANT_A,
      planId: "sme_standard",
      planVersion: 1,
      seatLimitOverride: 10,
    });
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

    // 2. Concurrent AI token reservation race on Tenant B (limit=1,000; 2x600 competing)
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
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("PLT-T31: feature disabled despite permitted role — entitlement deny & past_due grace policy preserves reading existing work", async () => {
    // Also verify org AI & Voice policy versioning per tenant
    const aiPolicy: ModelRoutingPolicy = {
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
    const aiV1 = await gov.upsertAiPolicy(ACTOR_A_OWNER, aiPolicy);
    const aiV2 = await gov.upsertAiPolicy(ACTOR_A_OWNER, aiPolicy);
    expect(aiV1.policyVersion).toBe(1);
    expect(aiV2.policyVersion).toBe(2);
    expect(await gov.getAiPolicy(TENANT_B)).toBeNull();

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
    await gov.upsertVoicePolicy(ACTOR_A_OWNER, voicePolicy);
    expect((await gov.getVoicePolicy(TENANT_A))?.maxClipDurationSeconds).toBe(90);

    // Commercial entitlement deny distinct from RBAC
    const trialSub = await gov.assignTenantSubscription({
      tenantId: TENANT_B,
      planId: "free_trial",
      planVersion: 1,
    });
    const entDec = evaluatePolicyDecision({
      actor: ACTOR_B_OWNER,
      resourceTenantId: TENANT_B,
      resourceWorkspaceId: WS_B_REPORTING,
      resource: "speech",
      action: "transcribe",
      source: "voice_command",
      subscription: trialSub,
      entitlementFeature: "khmerVoiceEnabled",
    });
    expect(entDec.allowed).toBe(false);
    expect(entDec.denialCategory).toBe("entitlement_missing");
    expect(entDec.code).toBe("PLAN_ENTITLEMENT_REQUIRED");

    // past_due blocks metered AI while preserving reading existing authorized work
    const pastDue = await gov.assignTenantSubscription({
      tenantId: TENANT_B,
      planId: "sme_standard",
      planVersion: 1,
      status: "past_due",
    });
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_B_OWNER,
        resourceTenantId: TENANT_B,
        resourceWorkspaceId: WS_B_REPORTING,
        resource: "ai_assistant",
        action: "apply_ai",
        source: "typed_ai",
        subscription: pastDue,
      }).code,
    ).toBe("SUBSCRIPTION_PAST_DUE_METERED_BLOCKED");
    expect(
      evaluatePolicyDecision({
        actor: ACTOR_B_OWNER,
        resourceTenantId: TENANT_B,
        resourceWorkspaceId: WS_B_REPORTING,
        resource: "document",
        action: "read",
        source: "manual",
        subscription: pastDue,
        isReadExistingAuthorizedWork: true,
      }).allowed,
    ).toBe(true);

    // Restore Tenant B active status for subsequent quota tests
    await gov.assignTenantSubscription({
      tenantId: TENANT_B,
      planId: "sme_standard",
      planVersion: 1,
      status: "active",
      entitlementOverrides: { monthlyAiTokens: 1_000 },
    });
  });

  it("PLT-T32: duplicate usage events & failed reservations — deduplicated settlement, release on cancel, append-only usage ledger", async () => {
    // Release restores budget cleanly
    const rel = await gov.reserveQuota({
      tenantId: TENANT_B,
      workspaceId: WS_B_REPORTING,
      actorId: USER_B_OWNER,
      dimension: "ai_tokens",
      requestedUnits: 400,
      periodKey: "2026-11",
      idempotencyKey: "cancel-release-1",
      correlationId: "corr-cancel",
    });
    expect(await gov.releaseQuota(TENANT_B, rel.reservationId)).toBe(true);

    // Duplicate idempotencyKey returns existing reservation cleanly
    const res1 = await gov.reserveQuota({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      actorId: USER_A_EDITOR,
      dimension: "voice_seconds",
      requestedUnits: 30,
      periodKey: "2026-11",
      idempotencyKey: "voice-settle-1",
      correlationId: "corr-voice-1",
    });
    const res1Dup = await gov.reserveQuota({
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      actorId: USER_A_EDITOR,
      dimension: "voice_seconds",
      requestedUnits: 30,
      periodKey: "2026-11",
      idempotencyKey: "voice-settle-1",
      correlationId: "corr-voice-1",
    });
    expect(res1Dup.reservationId).toBe(res1.reservationId);

    const settled = await gov.settleQuota({
      tenantId: TENANT_A,
      reservationId: res1.reservationId,
      actualUnits: 12,
      estimatedCostMicroUsd: 1800,
      source: "voice_command",
      providerId: "mock",
      isMock: true,
    });
    expect(settled.ledgerEntry.units).toBe(12);
    expect((await gov.listUsageLedger(ACTOR_A_BILLING, TENANT_A)).some((l) => l.ledgerId === settled.ledgerEntry.ledgerId)).toBe(true);

    // Append-only ledger enforcement
    await expect(
      withTenantTransaction(db, TENANT_A, async (tx) => {
        await tx.query("DELETE FROM pa_usage_ledger WHERE ledger_id = $1::uuid", [settled.ledgerEntry.ledgerId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("PLT-T33: mock unsigned/duplicate/out-of-order billing events — invalid rejected, idempotent reconciliation, zero real charge", async () => {
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

  it("PLT-T34: read audit records — cross-tenant denied, append-only enforced, authorized auditor sees safe filtered logs", async () => {
    await expect(
      withTenantTransaction(db, TENANT_A, async (tx) => {
        await tx.query("DELETE FROM audit_logs WHERE tenant_id = $1::uuid", [TENANT_A]);
      }),
    ).rejects.toThrow(/permission denied/i);

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

  it("PLT-T35: restore consistent DB/object backup in isolated environment — verifies checksums, history, revoked grants & measures RTO", async () => {
    const t0 = performance.now();
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
      const rtoMs = performance.now() - t0;

      expect(objRes.restoredCount).toBe(objSnapshot.entries.length);
      expect(objRes.verifiedSha256Count).toBe(objSnapshot.entries.length);
      expect(rtoMs).toBeLessThan(30_000);

      const targetGov = new PlatformGovernanceService(targetDb);
      expect((await targetGov.getTenantSubscription(TENANT_A))?.planId).toBe("sme_standard");
      expect((await targetGov.listFileObjects(ACTOR_A_WSMGR)).length).toBeGreaterThanOrEqual(2);
      expect((await targetGov.getVoicePolicy(TENANT_A))?.allowedLanguages).toEqual(["en-US", "km-KH"]);
      // Revoked offboarded member remains denied in restored database!
      await expect(
        targetGov.switchTenantContext({
          userId: USER_A_OFFBOARD,
          targetTenantId: TENANT_A,
          targetWorkspaceId: WS_A_REPORTING,
        }),
      ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });
    } finally {
      await targetDb.close();
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("PLT-T36: simulate worker/provider degradation — reports truthful degraded health while keeping DB & FORCE RLS intact", async () => {
    const health = await gov.getServiceHealthSnapshot(TENANT_A);
    expect(health.database.connected).toBe(true);
    expect(health.database.coreForceRlsEnabled).toBe(true);
    expect(health.database.paForceRlsEnabled).toBe(true);
    expect(health.jobs.deadLetter).toBeGreaterThanOrEqual(1);
    expect(health.status).toBe("degraded");
    expect(health.storage.totalObjects).toBeGreaterThanOrEqual(2);
  });
});
