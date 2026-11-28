import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AuthorizationError,
  assertCanManageTargetRole,
  canManageTargetRole,
  evaluatePolicyDecision,
} from "@ai-office-suite/authorization";
import {
  CORE_SCHEMA_VERSION,
  PA_SCHEMA_VERSION,
  PgliteDatabaseAdapter,
  PlatformGovernanceService,
  exportPaExtendedLogicalBackup,
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  restorePaExtendedLogicalBackup,
} from "@ai-office-suite/database";
import { initializeIntegrationSchema } from "@ai-office-suite/integration-engine";
import {
  authenticateUserWithPassword,
  hashPassword,
  signSessionToken,
} from "@ai-office-suite/identity";
import {
  DEFAULT_PROPOSAL_TTL_MS,
  signDocumentProposal,
  verifyDocumentProposalSignature,
} from "@ai-office-suite/ai-module";
import {
  DEFAULT_VOICE_POLICY,
  FasterWhisperLocalAdapter,
  MAX_AUDIO_BYTES,
  MockSpeechAdapter,
  SpeechProviderError,
  TerminologyRegistry,
  VoiceGovernancePipeline,
} from "@ai-office-suite/speech-engine";
import { LocalPrivateObjectStore } from "@ai-office-suite/storage";
import type {
  ActorContext,
  DocumentOperationProposal,
  TenantSubscription,
} from "@ai-office-suite/shared-contracts";
import { createApiApp } from "../apps/api/src/app.ts";
import { loadApiServerConfig } from "../apps/api/src/config.ts";

const TENANT_A = "aaaa1111-0000-4000-8000-000000000001";
const TENANT_B = "bbbb2222-0000-4000-8000-000000000002";
const WS_A_STD = "aaaa1111-1111-4000-8000-000000000001";
const WS_A_PAYROLL = "aaaa1111-2222-4000-8000-000000000002";

const USER_OWNER_1 = "00000001-aaaa-4000-8000-000000000001";
const USER_OWNER_2 = "00000001-aaaa-4000-8000-000000000002";
const USER_ADMIN = "00000001-aaaa-4000-8000-000000000003";
const USER_WSMGR = "00000001-aaaa-4000-8000-000000000004";
const USER_EDITOR = "00000001-aaaa-4000-8000-000000000005";
const USER_OTHER_EDITOR = "00000001-aaaa-4000-8000-000000000006";
const USER_MULTI_WS = "00000001-aaaa-4000-8000-000000000007";
const USER_B_EDITOR = "00000002-bbbb-4000-8000-000000000001";

const NOW_ISO = new Date().toISOString();

const ACTOR_OWNER: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_STD,
  userId: USER_OWNER_1,
  role: "owner",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
};

const ACTOR_ADMIN: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_STD,
  userId: USER_ADMIN,
  role: "administrator",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
};

const ACTOR_ADMIN_NO_PAYROLL_GRANT: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_PAYROLL,
  userId: USER_ADMIN,
  role: "administrator",
  workspaceContentGrant: false,
  mfaVerifiedAt: NOW_ISO,
};

const ACTOR_ADMIN_NO_STD_GRANT: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_STD,
  userId: USER_ADMIN,
  role: "administrator",
  workspaceContentGrant: false,
  mfaVerifiedAt: NOW_ISO,
};

const ACTOR_WSMGR: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_STD,
  userId: USER_WSMGR,
  role: "workspace_manager",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
};

const ACTOR_EDITOR: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_STD,
  userId: USER_EDITOR,
  role: "editor",
  workspaceContentGrant: true,
};

const ACTIVE_SUB: TenantSubscription = {
  tenantId: TENANT_A,
  planId: "sme_standard",
  planVersion: 1,
  status: "active",
  seatLimit: 25,
  policyVersion: 1,
  updatedAt: NOW_ISO,
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
    monthlyVoiceSeconds: 3_600,
    storageQuotaBytes: 100 * 1024 * 1024,
    maxConcurrentJobs: 5,
  },
};

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function listenTemp(app: ReturnType<typeof createApiApp>): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("WP-0 Security & Recovery Containment (F-08, F-09, F-10, F-22, F-27, F-30)", () => {
  it("F-08: enforces memberships.status = 'active' in core schema, password login, and JWT middleware", async () => {
    const db = new PgliteDatabaseAdapter();
    try {
      const init1 = await initializePostgreSqlSchema(db);
      expect(init1).toEqual({ applied: true, version: CORE_SCHEMA_VERSION });
      const init2 = await initializePostgreSqlSchema(db);
      expect(init2).toEqual({ applied: false, version: CORE_SCHEMA_VERSION });

      const pw = await hashPassword("StrongPass!2026");
      await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'OrgF08', 'active')", [
        TENANT_A,
      ]);
      await db.query("INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'Std')", [
        TENANT_A,
        WS_A_STD,
      ]);
      await db.query(
        "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, 'f08@org.kh', $2, 1, 'active')",
        [USER_EDITOR, pw],
      );
      await db.query(
        "INSERT INTO memberships (tenant_id, workspace_id, user_id, role, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'editor', 'active')",
        [TENANT_A, WS_A_STD, USER_EDITOR],
      );

      // Active membership authenticates and passes JWT middleware
      const authActive = await authenticateUserWithPassword({
        db,
        email: "f08@org.kh",
        password: "StrongPass!2026",
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
      });
      const existingToken = signSessionToken({
        userId: USER_EDITOR,
        email: "f08@org.kh",
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        role: "editor",
        tv: 1,
      });
      expect(authActive.actor.role).toBe("editor");

      const app = createApiApp({
        authMode: "jwt-pg",
        db,
        rateLimit: { enabled: false },
      });
      const { server, baseUrl } = await listenTemp(app);
      try {
        const resOk = await fetch(`${baseUrl}/api/documents`, {
          headers: { Authorization: `Bearer ${existingToken}` },
        });
        expect(resOk.status).toBe(200);

        // Revoking membership status WITHOUT bumping token_version still blocks BOTH password login and live JWT requests
        await db.query(
          "UPDATE memberships SET status = 'revoked' WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid",
          [TENANT_A, WS_A_STD, USER_EDITOR],
        );
        await expect(
          authenticateUserWithPassword({
            db,
            email: "f08@org.kh",
            password: "StrongPass!2026",
            tenantId: TENANT_A,
            workspaceId: WS_A_STD,
          }),
        ).rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });

        const resRevoked = await fetch(`${baseUrl}/api/documents`, {
          headers: { Authorization: `Bearer ${existingToken}` },
        });
        expect(resRevoked.status).toBe(403);
        expect(((await resRevoked.json()) as { code: string }).code).toBe("ACCOUNT_REVOKED");

        // Suspended membership is equally blocked on both paths
        await db.query(
          "UPDATE memberships SET status = 'suspended' WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid",
          [TENANT_A, WS_A_STD, USER_EDITOR],
        );
        await expect(
          authenticateUserWithPassword({
            db,
            email: "f08@org.kh",
            password: "StrongPass!2026",
            tenantId: TENANT_A,
            workspaceId: WS_A_STD,
          }),
        ).rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });

        const resSuspended = await fetch(`${baseUrl}/api/documents`, {
          headers: { Authorization: `Bearer ${existingToken}` },
        });
        expect(resSuspended.status).toBe(403);
        expect(((await resSuspended.json()) as { code: string }).code).toBe("ACCOUNT_REVOKED");
      } finally {
        server.close();
      }
    } finally {
      await db.close();
    }
  });

  it("F-09: enforces role hierarchy on invitations/offboarding and scopes workspace_manager & revokeInvitation to workspace", async () => {
    expect(canManageTargetRole("owner", "owner")).toBe(true);
    expect(canManageTargetRole("administrator", "owner")).toBe(false);
    expect(canManageTargetRole("administrator", "administrator")).toBe(true);
    expect(canManageTargetRole("workspace_manager", "administrator")).toBe(false);
    expect(canManageTargetRole("workspace_manager", "workspace_manager")).toBe(false);
    expect(canManageTargetRole("workspace_manager", "editor")).toBe(true);
    expect(() => assertCanManageTargetRole(ACTOR_WSMGR, "administrator", "invite")).toThrow(AuthorizationError);

    const db = new PgliteDatabaseAdapter();
    try {
      await initializePostgreSqlSchema(db);
      const paInit = await initializePaGovernanceSchema(db);
      expect(paInit.version).toBe(PA_SCHEMA_VERSION);

      const gov = new PlatformGovernanceService(db);
      await gov.seedDefaultPlans();
      await gov.createOrganization({ tenantId: TENANT_A, name: "OrgF09", mfaRequiredForPrivileged: true });
      await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_STD, name: "Std", visibility: "standard" });
      await gov.createWorkspace({
        tenantId: TENANT_A,
        workspaceId: WS_A_PAYROLL,
        name: "Payroll",
        visibility: "restricted",
      });

      const pw = await hashPassword("StrongPass!2026");
      for (const [uid, email] of [
        [USER_OWNER_1, "owner1@org.kh"],
        [USER_OWNER_2, "owner2@org.kh"],
        [USER_ADMIN, "admin@org.kh"],
        [USER_WSMGR, "wsmgr@org.kh"],
        [USER_MULTI_WS, "multiws@org.kh"],
      ] as const) {
        await db.query(
          "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, $2, $3, 1, 'active')",
          [uid, email, pw],
        );
      }

      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_OWNER_1, role: "owner" });
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_OWNER_2, role: "owner" });
      await gov.upsertMembership({
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_ADMIN,
        role: "administrator",
      });
      await gov.upsertMembership({
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_WSMGR,
        role: "workspace_manager",
      });
      // Multi-workspace editor active in BOTH Std and Payroll
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_MULTI_WS, role: "editor" });
      await gov.upsertMembership({
        tenantId: TENANT_A,
        workspaceId: WS_A_PAYROLL,
        userId: USER_MULTI_WS,
        role: "editor",
      });

      // workspace_manager cannot invite owner, administrator, workspace_manager, billing_admin, or auditor
      for (const forbiddenRole of ["owner", "administrator", "workspace_manager", "billing_admin", "auditor"] as const) {
        await expect(
          gov.createInvitation({
            actor: ACTOR_WSMGR,
            tenantId: TENANT_A,
            workspaceId: WS_A_STD,
            email: `blocked-${forbiddenRole}@org.kh`,
            invitedRole: forbiddenRole,
          }),
        ).rejects.toMatchObject({ statusCode: 403, code: "ROLE_HIERARCHY_DENIED" });
      }

      // administrator cannot invite owner, even when organization allows invitations
      await expect(
        gov.createInvitation({
          actor: ACTOR_ADMIN,
          tenantId: TENANT_A,
          workspaceId: WS_A_STD,
          email: "new-owner@org.kh",
          invitedRole: "owner",
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "ROLE_HIERARCHY_DENIED" });

      // administrator cannot offboard/suspend an owner even when 2 active owners exist
      await expect(
        gov.offboardOrSuspendMember({
          actor: ACTOR_ADMIN,
          tenantId: TENANT_A,
          targetUserId: USER_OWNER_2,
          mode: "revoke",
          reason: "Privilege escalation attempt",
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "ROLE_HIERARCHY_DENIED" });

      // workspace_manager cannot revoke an administrator invitation in the same workspace
      const adminInvite = await gov.createInvitation({
        actor: ACTOR_OWNER,
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        email: "co-admin@org.kh",
        invitedRole: "administrator",
      });
      await expect(
        gov.revokeInvitation({
          actor: ACTOR_WSMGR,
          tenantId: TENANT_A,
          workspaceId: WS_A_STD,
          invitationId: adminInvite.invitation.invitationId,
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "ROLE_HIERARCHY_DENIED" });

      // Cross-workspace revokeInvitation with wrong workspaceId fails cleanly (cannot mutate across workspaces)
      const editorInvite = await gov.createInvitation({
        actor: ACTOR_WSMGR,
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        email: "ed@org.kh",
        invitedRole: "editor",
      });
      await expect(
        gov.revokeInvitation({
          actor: ACTOR_OWNER,
          tenantId: TENANT_A,
          workspaceId: WS_A_PAYROLL,
          invitationId: editorInvite.invitation.invitationId,
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "WORKSPACE_ISOLATION_DENIED" });

      await expect(
        gov.revokeInvitation({
          actor: { ...ACTOR_OWNER, workspaceId: WS_A_PAYROLL },
          tenantId: TENANT_A,
          workspaceId: WS_A_PAYROLL,
          invitationId: editorInvite.invitation.invitationId,
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "INVITATION_NOT_PENDING" });

      // workspace_manager cannot offboard another workspace explicitly, and own-workspace offboard preserves Payroll membership
      await expect(
        gov.offboardOrSuspendMember({
          actor: ACTOR_WSMGR,
          tenantId: TENANT_A,
          workspaceId: WS_A_PAYROLL,
          targetUserId: USER_MULTI_WS,
          mode: "revoke",
          reason: "Cross-workspace attempt",
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_ISOLATION_DENIED" });

      const wsScopedOff = await gov.offboardOrSuspendMember({
        actor: ACTOR_WSMGR,
        tenantId: TENANT_A,
        targetUserId: USER_MULTI_WS,
        mode: "revoke",
        reason: "Removed from Standard workspace only",
      });
      expect(wsScopedOff.updatedMemberships).toBe(1);

      // Std membership is revoked, while Payroll membership remains active
      await expect(
        gov.switchTenantContext({
          userId: USER_MULTI_WS,
          targetTenantId: TENANT_A,
          targetWorkspaceId: WS_A_STD,
        }),
      ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });

      const payrollCtx = await gov.switchTenantContext({
        userId: USER_MULTI_WS,
        targetTenantId: TENANT_A,
        targetWorkspaceId: WS_A_PAYROLL,
      });
      expect(payrollCtx.role).toBe("editor");
    } finally {
      await db.close();
    }
  });

  it("F-10: enforces restricted workspace & restricted classification content isolation across PA-00 file ops and fails closed on NaN MFA timestamps", async () => {
    // 1. Fail-closed NaN timestamp check in PolicyDecisionEngine
    const invalidTimeDecision = evaluatePolicyDecision({
      actor: ACTOR_OWNER,
      resourceTenantId: TENANT_A,
      resource: "organization",
      action: "manage",
      source: "manual",
      mfaRequiredForPrivileged: true,
      nowIso: "not-a-valid-timestamp",
    });
    expect(invalidTimeDecision.allowed).toBe(false);
    expect(invalidTimeDecision.code).toBe("MFA_STEP_UP_REQUIRED");

    const storeDir = mkdtempSync(path.join(tmpdir(), "aios-wp0-f10-"));
    tempDirs.push(storeDir);
    const db = new PgliteDatabaseAdapter();
    try {
      await initializePostgreSqlSchema(db);
      await initializePaGovernanceSchema(db);
      const gov = new PlatformGovernanceService(db);
      const store = new LocalPrivateObjectStore(storeDir, "wp0-f10-object-signing-secret-32c!");

      await gov.createOrganization({ tenantId: TENANT_A, name: "OrgF10", mfaRequiredForPrivileged: true });
      await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_STD, name: "Std", visibility: "standard" });
      await gov.createWorkspace({
        tenantId: TENANT_A,
        workspaceId: WS_A_PAYROLL,
        name: "Payroll",
        visibility: "restricted",
      });

      const pw = await hashPassword("StrongPass!2026");
      await db.query(
        "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, 'admin@org.kh', $3, 1, 'active'), ($2::uuid, 'payroll@org.kh', $3, 1, 'active')",
        [USER_ADMIN, USER_EDITOR, pw],
      );
      await gov.upsertMembership({
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_ADMIN,
        role: "administrator",
        contentAccess: true,
      });
      await gov.upsertMembership({
        tenantId: TENANT_A,
        workspaceId: WS_A_PAYROLL,
        userId: USER_EDITOR,
        role: "editor",
        contentAccess: true,
      });

      const payrollActorGranted: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_PAYROLL,
        userId: USER_OWNER_1,
        role: "owner",
        workspaceContentGrant: true,
      };
      // Ensure FK user exists for USER_OWNER_1
      await db.query(
        "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, 'owner@org.kh', $2, 1, 'active')",
        [USER_OWNER_1, pw],
      );

      const payrollPut = await store.putObject({
        tenantId: TENANT_A,
        workspaceId: WS_A_PAYROLL,
        objectId: "payroll-sheet",
        version: 1,
        bytes: Buffer.from("Confidential Payroll Register"),
      });
      await gov.registerFileObject({
        actor: payrollActorGranted,
        objectId: "payroll-sheet",
        version: 1,
        storageKey: payrollPut.storageKey,
        filename: "payroll-2026.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize: payrollPut.byteSize,
        sha256: payrollPut.sha256,
        classification: "confidential",
        quarantineState: "pending_scan",
      });

      // Admin WITHOUT explicit Payroll workspaceContentGrant is denied on ALL 6 file operations
      await expect(
        gov.registerFileObject({
          actor: ACTOR_ADMIN_NO_PAYROLL_GRANT,
          objectId: "unauth-payroll",
          version: 1,
          storageKey: payrollPut.storageKey,
          filename: "unauth.pdf",
          mimeType: "application/pdf",
          byteSize: 10,
          sha256: payrollPut.sha256,
          classification: "internal",
        }),
      ).rejects.toMatchObject({ code: "RESTRICTED_WORKSPACE_CONTENT_DENIED" });

      await expect(gov.listFileObjects(ACTOR_ADMIN_NO_PAYROLL_GRANT)).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });
      await expect(
        gov.updateFileQuarantineState({
          actor: ACTOR_ADMIN_NO_PAYROLL_GRANT,
          objectId: "payroll-sheet",
          version: 1,
          quarantineState: "clean",
        }),
      ).rejects.toMatchObject({ code: "RESTRICTED_WORKSPACE_CONTENT_DENIED" });
      await expect(gov.softDeleteFileObject(ACTOR_ADMIN_NO_PAYROLL_GRANT, "payroll-sheet", 1)).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });
      await expect(gov.recoverFileObject(ACTOR_ADMIN_NO_PAYROLL_GRANT, "payroll-sheet", 1)).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });
      await expect(gov.purgeFileObject(ACTOR_ADMIN_NO_PAYROLL_GRANT, "payroll-sheet", 1)).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });

      // Even a non-existent file in restricted workspace rejects with RESTRICTED_WORKSPACE_CONTENT_DENIED (no existence oracle)
      await expect(gov.softDeleteFileObject(ACTOR_ADMIN_NO_PAYROLL_GRANT, "does-not-exist", 1)).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });

      // Restricted-classified file inside a STANDARD workspace is hidden/denied from actor with workspaceContentGrant=false
      const stdPut = await store.putObject({
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        objectId: "board-restricted",
        version: 1,
        bytes: Buffer.from("Restricted M&A File"),
      });
      await gov.registerFileObject({
        actor: ACTOR_ADMIN,
        objectId: "board-restricted",
        version: 1,
        storageKey: stdPut.storageKey,
        filename: "mna.pdf",
        mimeType: "application/pdf",
        byteSize: stdPut.byteSize,
        sha256: stdPut.sha256,
        classification: "restricted",
        quarantineState: "pending_scan",
      });

      expect(await gov.listFileObjects(ACTOR_ADMIN_NO_STD_GRANT)).toHaveLength(0);
      await expect(
        gov.updateFileQuarantineState({
          actor: ACTOR_ADMIN_NO_STD_GRANT,
          objectId: "board-restricted",
          version: 1,
          quarantineState: "clean",
        }),
      ).rejects.toMatchObject({ code: "RESTRICTED_WORKSPACE_CONTENT_DENIED" });

      // Authorized actor succeeds and produces append-only audit events
      await gov.updateFileQuarantineState({
        actor: ACTOR_ADMIN,
        objectId: "board-restricted",
        version: 1,
        quarantineState: "clean",
      });
      await gov.softDeleteFileObject(ACTOR_ADMIN, "board-restricted", 1);
      await gov.recoverFileObject(ACTOR_ADMIN, "board-restricted", 1);
      await gov.purgeFileObject(ACTOR_ADMIN, "board-restricted", 1);

      const fileAuditActions = (
        await gov.queryAuditLogs(ACTOR_ADMIN, { tenantId: TENANT_A, actionPrefix: "file." })
      ).map((e) => e.action);
      expect(fileAuditActions).toEqual(
        expect.arrayContaining(["file.registered", "file.quarantine_updated", "file.soft_deleted", "file.recovered", "file.purged"]),
      );
    } finally {
      await db.close();
    }
  });

  it("F-22: aligns AI_PROPOSAL_SIGNING_SECRET, rejects expired/skewed proposals, and enforces distinct production secrets in API config", () => {
    const savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      JWT_SECRET: process.env.JWT_SECRET,
      AI_PROPOSAL_SIGNING_SECRET: process.env.AI_PROPOSAL_SIGNING_SECRET,
      PROPOSAL_SIGNING_KEY: process.env.PROPOSAL_SIGNING_KEY,
    };

    try {
      const strongJwt = "prod-jwt-signing-secret-alpha-00001";
      const strongProposal = "prod-ai-proposal-secret-beta-000002";
      const strongPii = "prod-pii-pseudonymization-gamma-03";
      const dbUrl = "postgres://app_runtime:secretpass@127.0.0.1:5432/ai_office";

      expect(() =>
        loadApiServerConfig({
          NODE_ENV: "production",
          AUTH_MODE: "jwt-pg",
          DATABASE_URL: dbUrl,
          PII_PSEUDONYMIZATION_KEY: strongPii,
          AI_PROPOSAL_SIGNING_SECRET: strongProposal,
        }),
      ).toThrow(/JWT_SECRET/);

      expect(() =>
        loadApiServerConfig({
          NODE_ENV: "production",
          AUTH_MODE: "jwt-pg",
          DATABASE_URL: dbUrl,
          JWT_SECRET: strongJwt,
          PII_PSEUDONYMIZATION_KEY: strongPii,
        }),
      ).toThrow(/AI_PROPOSAL_SIGNING_SECRET/);

      expect(() =>
        loadApiServerConfig({
          NODE_ENV: "production",
          AUTH_MODE: "jwt-pg",
          DATABASE_URL: dbUrl,
          JWT_SECRET: strongJwt,
          AI_PROPOSAL_SIGNING_SECRET: strongJwt,
          PII_PSEUDONYMIZATION_KEY: strongPii,
        }),
      ).toThrow(/PRODUCTION_SECRET_REUSE_FORBIDDEN/);

      expect(() =>
        loadApiServerConfig({
          NODE_ENV: "production",
          AUTH_MODE: "jwt-pg",
          DATABASE_URL: dbUrl,
          JWT_SECRET: strongJwt,
          AI_PROPOSAL_SIGNING_SECRET: strongProposal,
          PII_PSEUDONYMIZATION_KEY: "changeme-placeholder-secret-value-1234",
        }),
      ).toThrow(/PII_PSEUDONYMIZATION_KEY/);

      const warnings: string[] = [];
      const legacyWarnCfg = loadApiServerConfig(
        {
          NODE_ENV: "production",
          AUTH_MODE: "jwt-pg",
          DATABASE_URL: dbUrl,
          JWT_SECRET: strongJwt,
          PROPOSAL_SIGNING_KEY: strongProposal,
          PII_PSEUDONYMIZATION_KEY: strongPii,
        },
        { onWarn: (msg) => warnings.push(msg) },
      );
      expect(legacyWarnCfg.authMode).toBe("jwt-pg");
      expect(warnings.some((w) => w.includes("AI_PROPOSAL_SIGNING_SECRET"))).toBe(true);

      const prodCfg = loadApiServerConfig({
        NODE_ENV: "production",
        AUTH_MODE: "jwt-pg",
        DATABASE_URL: dbUrl,
        JWT_SECRET: strongJwt,
        AI_PROPOSAL_SIGNING_SECRET: strongProposal,
        PII_PSEUDONYMIZATION_KEY: strongPii,
      });
      expect(prodCfg.requireNonSuperuserDb).toBe(true);

      // AI proposal signing in production fails closed without distinct AI_PROPOSAL_SIGNING_SECRET
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = strongJwt;
      delete process.env.AI_PROPOSAL_SIGNING_SECRET;
      delete process.env.PROPOSAL_SIGNING_KEY;

      const baseProposal: DocumentOperationProposal = {
        operationId: "op-f22-1",
        documentId: "doc-f22-1",
        expectedRevision: 1,
        action: "replace_selection",
        params: { text: "Updated copy" },
        requestedBy: ACTOR_EDITOR.userId,
        riskLevel: "low",
        requiresApproval: true,
        source: "typed_ai",
        inputLanguage: "en",
        outputLanguage: "en",
        originalCommand: "replace with Updated copy",
        explanation: "Replace selection",
        previewDiff: {
          blockId: "b1",
          beforeText: "Old",
          afterText: "Updated copy",
          summary: "Update b1",
        },
        createdAt: "2026-11-28T00:00:00.000Z",
      };

      expect(() => signDocumentProposal(ACTOR_EDITOR, baseProposal)).toThrow(/AI_PROPOSAL_SIGNING_SECRET/);

      process.env.AI_PROPOSAL_SIGNING_SECRET = strongJwt;
      expect(() => signDocumentProposal(ACTOR_EDITOR, baseProposal)).toThrow(/distinct from JWT_SECRET/);

      process.env.AI_PROPOSAL_SIGNING_SECRET = strongProposal;
      const sig = signDocumentProposal(ACTOR_EDITOR, baseProposal);
      const signedProposal: DocumentOperationProposal = { ...baseProposal, proposalSignature: sig };
      const createdMs = Date.parse(baseProposal.createdAt);

      expect(verifyDocumentProposalSignature(ACTOR_EDITOR, signedProposal, { nowMs: createdMs + 5_000 })).toBe(true);
      expect(
        verifyDocumentProposalSignature(ACTOR_EDITOR, signedProposal, {
          nowMs: createdMs + DEFAULT_PROPOSAL_TTL_MS + 1_000,
        }),
      ).toBe(false);
      expect(
        verifyDocumentProposalSignature(ACTOR_EDITOR, signedProposal, {
          nowMs: createdMs - 120_000,
        }),
      ).toBe(false);
      expect(
        verifyDocumentProposalSignature(ACTOR_EDITOR, { ...signedProposal, createdAt: "invalid-date" }),
      ).toBe(false);
    } finally {
      if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv.NODE_ENV;
      if (savedEnv.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = savedEnv.JWT_SECRET;
      if (savedEnv.AI_PROPOSAL_SIGNING_SECRET === undefined) delete process.env.AI_PROPOSAL_SIGNING_SECRET;
      else process.env.AI_PROPOSAL_SIGNING_SECRET = savedEnv.AI_PROPOSAL_SIGNING_SECRET;
      if (savedEnv.PROPOSAL_SIGNING_KEY === undefined) delete process.env.PROPOSAL_SIGNING_KEY;
      else process.env.PROPOSAL_SIGNING_KEY = savedEnv.PROPOSAL_SIGNING_KEY;
    }
  });

  it("F-27: verifies PA table integrity checksums and guarantees single-transaction atomic rollback on restore failure", async () => {
    const db = new PgliteDatabaseAdapter();
    try {
      await initializePostgreSqlSchema(db);
      await initializeIntegrationSchema(db);
      await initializePaGovernanceSchema(db);

      const gov = new PlatformGovernanceService(db);
      await gov.seedDefaultPlans();
      await gov.createOrganization({ tenantId: TENANT_A, name: "OrgF27", mfaRequiredForPrivileged: true });
      await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_STD, name: "Std", visibility: "standard" });
      await gov.createWorkspace({
        tenantId: TENANT_A,
        workspaceId: WS_A_PAYROLL,
        name: "Payroll",
        visibility: "restricted",
      });
      const pw = await hashPassword("StrongPass!2026");
      await db.query(
        "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, 'owner@f27.kh', $3, 1, 'active'), ($2::uuid, 'revoked@f27.kh', $3, 1, 'active')",
        [USER_OWNER_1, USER_EDITOR, pw],
      );
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_OWNER_1, role: "owner" });
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_EDITOR, role: "editor" });
      await gov.assignTenantSubscription({ tenantId: TENANT_A, planId: "sme_standard", planVersion: 1 });
      await gov.offboardOrSuspendMember({
        actor: ACTOR_OWNER,
        tenantId: TENANT_A,
        targetUserId: USER_EDITOR,
        mode: "revoke",
        reason: "Departure before backup",
      });
      await gov.registerFileObject({
        actor: ACTOR_OWNER,
        objectId: "f27-ledger",
        version: 1,
        storageKey: "tenants/a/ws/std/f27-ledger/v1",
        filename: "ledger.pdf",
        mimeType: "application/pdf",
        byteSize: 256,
        sha256: "a".repeat(64),
        classification: "confidential",
      });

      const snapshot = await exportPaExtendedLogicalBackup(db);
      expect(snapshot.snapshotVersion).toBe(3);
      expect(snapshot.extendedIntegritySha256).toMatch(/^[0-9a-f]{64}$/);

      const targetDb = new PgliteDatabaseAdapter();
      try {
        await initializePostgreSqlSchema(targetDb);
        await initializeIntegrationSchema(targetDb);
        await initializePaGovernanceSchema(targetDb);

        // 1. Tampering with PA table payload or omitting extended checksum rejects before writing
        const tampered = structuredClone(snapshot);
        tampered.paTables.paTenantSubscriptions[0]!.seat_limit = 9999;
        await expect(restorePaExtendedLogicalBackup(targetDb, tampered)).rejects.toThrow(
          /BACKUP_INTEGRITY_MISMATCH/,
        );

        const missingDigest = structuredClone(snapshot);
        delete missingDigest.extendedIntegritySha256;
        await expect(restorePaExtendedLogicalBackup(targetDb, missingDigest)).rejects.toThrow(
          /BACKUP_INTEGRITY_MISMATCH/,
        );

        // 2. Mid-restore failure rolls back ALL core AND PA rows atomically
        await expect(
          restorePaExtendedLogicalBackup(targetDb, snapshot, { simulateFailureBeforeCommit: true }),
        ).rejects.toThrow(/SIMULATED_RESTORE_FAILURE_BEFORE_COMMIT/);
        expect((await targetDb.query("SELECT * FROM organizations")).rows).toHaveLength(0);
        expect((await targetDb.query("SELECT * FROM pa_file_objects")).rows).toHaveLength(0);

        // 3. Valid restore commits atomically with additive core columns preserved
        await restorePaExtendedLogicalBackup(targetDb, snapshot);
        const restoredGov = new PlatformGovernanceService(targetDb);
        const restoredOrg = await restoredGov.getOrganization(TENANT_A);
        const restoredPayroll = await restoredGov.getWorkspace(TENANT_A, WS_A_PAYROLL);
        expect(restoredOrg?.mfaRequiredForPrivileged).toBe(true);
        expect(restoredPayroll?.visibility).toBe("restricted");
        expect((await restoredGov.listFileObjects(ACTOR_OWNER)).some((f) => f.objectId === "f27-ledger")).toBe(true);
        await expect(
          restoredGov.switchTenantContext({
            userId: USER_EDITOR,
            targetTenantId: TENANT_A,
            targetWorkspaceId: WS_A_STD,
          }),
        ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });
      } finally {
        await targetDb.close();
      }
    } finally {
      await db.close();
    }
  });

  it("F-30: authorizes voice session operations by actor, avoids double-release after quota settlement, and hardens Faster-Whisper inputs", async () => {
    let releaseCalls = 0;
    let settleCalls = 0;
    const pipeline = new VoiceGovernancePipeline({
      terminology: new TerminologyRegistry(),
      quota: {
        reserveVoiceSeconds: async ({ idempotencyKey }) => ({ reservationId: `res:${idempotencyKey}` }),
        settleVoiceSeconds: async () => {
          settleCalls += 1;
        },
        releaseVoiceSeconds: async () => {
          releaseCalls += 1;
        },
      },
    });

    const paused = await pipeline.processUtterance({
      actor: ACTOR_EDITOR,
      policy: DEFAULT_VOICE_POLICY(TENANT_A),
      adapter: new MockSpeechAdapter(),
      mode: "command",
      language: "en-US",
      durationMs: 2000,
      simulatedTranscript: "Update Net Sales to 150000 for 2026-11",
      subscription: ACTIVE_SUB,
      idempotencyKey: "f30-settled-review",
    });
    expect(paused.outcome).toBe("awaiting_review_clarify");
    expect(settleCalls).toBe(1);
    expect(paused.session.quotaSettled).toBe(true);

    const sameWsAttacker: ActorContext = { ...ACTOR_EDITOR, userId: USER_OTHER_EDITOR };
    const wrongWsAttacker: ActorContext = { ...ACTOR_EDITOR, workspaceId: WS_A_PAYROLL };
    const crossTenantAttacker: ActorContext = {
      tenantId: TENANT_B,
      workspaceId: WS_A_STD,
      userId: USER_B_EDITOR,
      role: "editor",
    };

    for (const attacker of [sameWsAttacker, wrongWsAttacker, crossTenantAttacker]) {
      expect(() =>
        pipeline.confirmReviewedTranscript({
          actor: attacker,
          sessionId: paused.session.sessionId,
          editedTranscript: "Hijacked command",
          eventId: `att-c-${attacker.userId}`,
          eventSeq: 6,
        }),
      ).toThrowError(SpeechProviderError);

      await expect(
        pipeline.cancelSessionWithQuotaRelease({
          actor: attacker,
          sessionId: paused.session.sessionId,
          eventId: `att-x-${attacker.userId}`,
          eventSeq: 7,
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "VOICE_SESSION_FORBIDDEN" });

      await expect(
        pipeline.handleInterruption({
          actor: attacker,
          sessionId: paused.session.sessionId,
          kind: "microphone_disconnected",
          eventId: `att-i-${attacker.userId}`,
          eventSeq: 8,
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "VOICE_SESSION_FORBIDDEN" });
    }

    // Session remains cleanly intact after forbidden probes, and rightful owner cancel does NOT double-release settled quota
    const intact = pipeline.sessions.getSession(paused.session.sessionId);
    expect(intact?.state).toBe("review_clarify");
    expect(intact?.editedTranscript).toBeUndefined();

    const canceledAfterSettle = await pipeline.cancelSessionWithQuotaRelease({
      actor: ACTOR_EDITOR,
      sessionId: paused.session.sessionId,
      eventId: "owner-cancel-after-settle",
      eventSeq: 6,
    });
    expect(canceledAfterSettle.session.state).toBe("canceled");
    expect(canceledAfterSettle.quotaReleased).toBe(false);
    expect(releaseCalls).toBe(0);

    // Sign-out cleanup releases only UNSETTLED reservations while skipping already-settled sessions
    const settledReview2 = await pipeline.processUtterance({
      actor: ACTOR_EDITOR,
      policy: DEFAULT_VOICE_POLICY(TENANT_A),
      adapter: new MockSpeechAdapter(),
      mode: "command",
      language: "en-US",
      durationMs: 2000,
      simulatedTranscript: "Update Net Sales to 250000 for 2026-11",
      subscription: ACTIVE_SUB,
      idempotencyKey: "f30-settled-review-2",
    });
    expect(settledReview2.session.quotaSettled).toBe(true);

    const activeUnsettled = pipeline.sessions.createSession({
      tenantId: TENANT_A,
      workspaceId: WS_A_STD,
      actorId: ACTOR_EDITOR.userId,
      mode: "command",
      language: "en-US",
    });
    pipeline.sessions.transition(activeUnsettled.sessionId, {
      eventId: "u1",
      eventSeq: 1,
      targetState: "requesting_permission",
    });
    pipeline.sessions.transition(activeUnsettled.sessionId, {
      eventId: "u2",
      eventSeq: 2,
      targetState: "recording",
    });
    pipeline.sessions.recordTranscriptionResult(activeUnsettled.sessionId, {
      rawTranscript: "",
      normalizedTranscript: "",
      appliedTerms: [],
      confidence: 0,
      providerId: "mock",
      isMock: true,
      retainAudio: false,
      criticalFieldValidation: undefined,
      reservationId: "res:unsettled-recording",
    });

    const endSummary = await pipeline.cancelOnActorSessionEnd(TENANT_A, ACTOR_EDITOR.userId);
    expect(endSummary.terminatedSessions).toHaveLength(2);
    expect(endSummary.releasedReservations).toBe(1);
    expect(releaseCalls).toBe(1);

    // Faster-Whisper adapter input hardening: model allowlist & audio size limit enforced before Python spawn
    const prevAllowFw = process.env.ALLOW_LOCAL_FASTER_WHISPER;
    const prevModel = process.env.FASTER_WHISPER_MODEL;
    try {
      process.env.ALLOW_LOCAL_FASTER_WHISPER = "true";
      const fw = new FasterWhisperLocalAdapter();

      process.env.FASTER_WHISPER_MODEL = "large-v3;malicious";
      await expect(
        fw.transcribe({
          language: "en-US",
          mode: "command",
          durationMs: 1000,
          audioBase64: Buffer.from("RIFFDATA").toString("base64"),
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_WHISPER_MODEL" });

      process.env.FASTER_WHISPER_MODEL = "tiny";
      const oversizedBase64 = Buffer.alloc(MAX_AUDIO_BYTES + 1024).toString("base64");
      await expect(
        fw.transcribe({
          language: "en-US",
          mode: "command",
          durationMs: 1000,
          audioBase64: oversizedBase64,
        }),
      ).rejects.toMatchObject({ statusCode: 413, code: "AUDIO_PAYLOAD_TOO_LARGE" });
    } finally {
      if (prevAllowFw === undefined) delete process.env.ALLOW_LOCAL_FASTER_WHISPER;
      else process.env.ALLOW_LOCAL_FASTER_WHISPER = prevAllowFw;
      if (prevModel === undefined) delete process.env.FASTER_WHISPER_MODEL;
      else process.env.FASTER_WHISPER_MODEL = prevModel;
    }
  });
});
