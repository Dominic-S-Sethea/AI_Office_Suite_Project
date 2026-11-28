import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PA_SCHEMA_VERSION,
  PgliteDatabaseAdapter,
  PlatformGovernanceService,
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  signMockBillingWebhook,
  verifyDatabaseRlsReadiness,
  withTenantTransaction,
} from "@ai-office-suite/database";
import {
  authenticateUserWithPassword,
  hashPassword,
  revokeUserSessions,
} from "@ai-office-suite/identity";
import {
  DEFAULT_ORPHAN_SWEEP_MIN_AGE_MS,
  LocalPrivateObjectStore,
} from "@ai-office-suite/storage";
import type { ActorContext, BillingWebhookEvent } from "@ai-office-suite/shared-contracts";
import { createApiApp } from "../apps/api/src/app.ts";

const TENANT_A = "1111aaaa-0000-4000-8000-000000000001";
const TENANT_B = "2222bbbb-0000-4000-8000-000000000002";
const WS_A = "1111aaaa-1111-4000-8000-000000000001";
const WS_B = "2222bbbb-2222-4000-8000-000000000002";

const USER_OWNER_A = "00000001-1111-4000-8000-000000000001";
const USER_BILLING_A = "00000001-1111-4000-8000-000000000002";
const USER_INVITEE_A = "00000001-1111-4000-8000-000000000003";
const USER_OWNER_B = "00000002-2222-4000-8000-000000000001";

const ACTOR_OWNER_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A,
  userId: USER_OWNER_A,
  role: "owner",
  workspaceContentGrant: true,
  mfaVerifiedAt: new Date().toISOString(),
};

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
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

describe("WP-1 Governance Schema, Core Identity RLS & Transaction Integrity (F-01, F-04, F-05, F-21)", () => {
  it("F-01 & F-04: aligns 8-role core schema, isolates users.password_hash + enforces FORCE RLS on organizations/memberships, and hydrates grants/MFA in auth middleware", async () => {
    const db = new PgliteDatabaseAdapter();
    try {
      await initializePostgreSqlSchema(db);

      const readiness = await verifyDatabaseRlsReadiness(db);
      expect(readiness.ready).toBe(true);
      expect(readiness.checks.coreForceRlsEnabled).toBe(true);
      expect(readiness.checks.usersPasswordHashIsolated).toBe(true);
      expect(readiness.checks.missingForceRlsTables).toEqual([]);

      const pwHash = await hashPassword("StrongPass!2026");
      await db.query(
        "INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'OrgA', 'active'), ($2::uuid, 'OrgB', 'active')",
        [TENANT_A, TENANT_B],
      );
      await db.query(
        "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'WS A'), ($3::uuid, $4::uuid, 'WS B')",
        [TENANT_A, WS_A, TENANT_B, WS_B],
      );
      await db.query(
        `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES
           ($1::uuid, 'owner.a@org.kh', $4, 1, 'active'),
           ($2::uuid, 'billing.a@org.kh', $4, 1, 'active'),
           ($3::uuid, 'owner.b@org.kh', $4, 1, 'active')`,
        [USER_OWNER_A, USER_BILLING_A, USER_OWNER_B, pwHash],
      );
      // F-01: core-only schema (before PA-00 init!) accepts workspace_manager/billing_admin & content_access
      await db.query(
        `INSERT INTO memberships (tenant_id, workspace_id, user_id, role, status, content_access) VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'owner', 'active', true),
           ($1::uuid, $2::uuid, $4::uuid, 'billing_admin', 'active', false),
           ($5::uuid, $6::uuid, $7::uuid, 'owner', 'active', true)`,
        [TENANT_A, WS_A, USER_OWNER_A, USER_BILLING_A, TENANT_B, WS_B, USER_OWNER_B],
      );

      // F-04: under app_runtime with Tenant A context, Tenant B organizations & memberships are invisible
      // and direct SELECT(password_hash) / UPDATE on users are denied!
      await withTenantTransaction(
        db,
        TENANT_A,
        async (tx) => {
          const orgRows = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM organizations");
          expect(orgRows.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);

          const memRows = await tx.query<{ tenant_id: string; user_id: string }>(
            "SELECT tenant_id, user_id FROM memberships",
          );
          expect(memRows.rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);

          const updCrossOrg = await tx.query("UPDATE organizations SET name = 'Pwned' WHERE tenant_id = $1::uuid", [
            TENANT_B,
          ]);
          expect(updCrossOrg.rowCount).toBe(0);

          // Non-sensitive safe columns remain readable for joins
          const safeUser = await tx.query<{ user_id: string; status: string }>(
            "SELECT user_id, status FROM users WHERE user_id = $1::uuid",
            [USER_OWNER_A],
          );
          expect(safeUser.rows[0]?.status).toBe("active");
        },
        WS_A,
      );

      await expect(
        withTenantTransaction(db, TENANT_A, async (tx) => tx.query("SELECT password_hash FROM users"), WS_A),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        withTenantTransaction(db, TENANT_A, async (tx) => tx.query("UPDATE users SET status = 'deleted'"), WS_A),
      ).rejects.toThrow(/permission denied/i);

      // F-01: password auth + JWT /api/auth/me hydrate workspaceContentGrant & mfaVerifiedAt
      const mfaTs = new Date().toISOString();
      const ownerAuth = await authenticateUserWithPassword({
        db,
        email: "owner.a@org.kh",
        password: "StrongPass!2026",
        tenantId: TENANT_A,
        workspaceId: WS_A,
        mfaVerifiedAt: mfaTs,
      });
      expect(ownerAuth.actor.workspaceContentGrant).toBe(true);
      expect(ownerAuth.actor.mfaVerifiedAt).toBe(mfaTs);

      const billingAuth = await authenticateUserWithPassword({
        db,
        email: "billing.a@org.kh",
        password: "StrongPass!2026",
        tenantId: TENANT_A,
        workspaceId: WS_A,
      });
      expect(billingAuth.actor.workspaceContentGrant).toBe(false);

      const app = createApiApp({ authMode: "jwt-pg", db, rateLimit: { enabled: false } });
      const { server, baseUrl } = await listenTemp(app);
      try {
        const meOwner = await fetch(`${baseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${ownerAuth.token}` },
        });
        expect(meOwner.status).toBe(200);
        const meOwnerJson = (await meOwner.json()) as { actor: ActorContext };
        expect(meOwnerJson.actor.workspaceContentGrant).toBe(true);
        expect(meOwnerJson.actor.mfaVerifiedAt).toBe(mfaTs);

        const meBilling = await fetch(`${baseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${billingAuth.token}` },
        });
        expect(meBilling.status).toBe(200);
        const meBillingJson = (await meBilling.json()) as { actor: ActorContext };
        expect(meBillingJson.actor.workspaceContentGrant).toBe(false);
        expect(meBillingJson.actor.mfaVerifiedAt).toBeUndefined();

        // revokeUserSessions works via SECURITY DEFINER even under app_runtime / public pool
        const nextTv = await revokeUserSessions(db, USER_BILLING_A);
        expect(nextTv).toBe(2);
        const afterRevoke = await fetch(`${baseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${billingAuth.token}` },
        });
        expect(afterRevoke.status).toBe(401);
      } finally {
        server.close();
      }

      // Verify db-cli.mjs and server.ts reference unified PA-00 migration & verification
      const dbCliSrc = readFileSync(path.resolve(process.cwd(), "scripts/db-cli.mjs"), "utf8");
      const serverSrc = readFileSync(path.resolve(process.cwd(), "apps/api/src/server.ts"), "utf8");
      expect(dbCliSrc).toContain("initializePaGovernanceSchema");
      expect(dbCliSrc).toContain("verifyPaRlsReadiness");
      expect(dbCliSrc).toContain("exportPaExtendedLogicalBackup");
      expect(dbCliSrc).toContain("restorePaExtendedLogicalBackup");
      expect(dbCliSrc).toContain("pa_usage_ledger");
      expect(serverSrc).toContain("initializePaGovernanceSchema");
    } finally {
      await db.close();
    }
  });

  it("F-05: persists expired invitation status, enforces cumulative storage quotas & settlement overage caps, and handles webhooks atomically & monotonically", async () => {
    const db = new PgliteDatabaseAdapter();
    try {
      await initializePostgreSqlSchema(db);
      const paInit = await initializePaGovernanceSchema(db);
      expect(paInit.version).toBe(PA_SCHEMA_VERSION);

      const gov = new PlatformGovernanceService(db, {
        billingWebhookSecret: "wp1-webhook-secret-32-chars-minimum!",
      });
      await gov.seedDefaultPlans();
      await gov.createOrganization({ tenantId: TENANT_A, name: "OrgF05", mfaRequiredForPrivileged: true });
      await gov.createOrganization({ tenantId: TENANT_B, name: "OrgF05NoSub" });
      await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A, name: "WS A" });

      const pwHash = await hashPassword("StrongPass!2026");
      await db.query(
        "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, 'o@f05.kh', $3, 1, 'active'), ($2::uuid, 'inv@f05.kh', $3, 1, 'active')",
        [USER_OWNER_A, USER_INVITEE_A, pwHash],
      );
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A, userId: USER_OWNER_A, role: "owner" });
      await gov.assignTenantSubscription({
        tenantId: TENANT_A,
        planId: "sme_standard",
        planVersion: 1,
        entitlementOverrides: {
          storageQuotaBytes: 1_000,
          monthlyAiTokens: 100,
        },
      });

      // 1. Expired invitation status is COMMITTED before 410 is thrown
      const inv = await gov.createInvitation({
        actor: ACTOR_OWNER_A,
        tenantId: TENANT_A,
        workspaceId: WS_A,
        email: "inv@f05.kh",
        invitedRole: "editor",
        expiresInSeconds: 5,
      });
      await expect(
        gov.acceptInvitation({
          tenantId: TENANT_A,
          rawToken: inv.rawToken,
          acceptingUserId: USER_INVITEE_A,
          acceptingEmail: "inv@f05.kh",
          nowIso: new Date(Date.now() + 120_000).toISOString(),
        }),
      ).rejects.toMatchObject({ statusCode: 410, code: "INVITATION_EXPIRED" });

      const invStatusRow = await withTenantTransaction(db, TENANT_A, async (tx) => {
        const res = await tx.query<{ status: string }>(
          "SELECT status FROM pa_invitations WHERE invitation_id = $1::uuid",
          [inv.invitation.invitationId],
        );
        return res.rows[0]?.status;
      });
      expect(invStatusRow).toBe("expired");

      // 2. Cumulative quota (`storage_bytes`) persists across month boundaries (`2026-11` -> `2026-12`)
      const storageResNov = await gov.reserveQuota({
        tenantId: TENANT_A,
        workspaceId: WS_A,
        actorId: USER_OWNER_A,
        dimension: "storage_bytes",
        requestedUnits: 600,
        periodKey: "2026-11",
        idempotencyKey: "storage-nov-1",
        correlationId: "corr-nov",
      });
      await gov.settleQuota({
        tenantId: TENANT_A,
        reservationId: storageResNov.reservationId,
        actualUnits: 600,
        estimatedCostMicroUsd: 0,
        source: "manual",
      });
      await expect(
        gov.reserveQuota({
          tenantId: TENANT_A,
          workspaceId: WS_A,
          actorId: USER_OWNER_A,
          dimension: "storage_bytes",
          requestedUnits: 500,
          periodKey: "2026-12",
          idempotencyKey: "storage-dec-1",
          correlationId: "corr-dec",
        }),
      ).rejects.toMatchObject({ statusCode: 429, code: "QUOTA_EXCEEDED" });

      // 3. `settleQuota` enforces cap on positive overage (`actualUnits > reserved_units`)
      const tokRes = await gov.reserveQuota({
        tenantId: TENANT_A,
        workspaceId: WS_A,
        actorId: USER_OWNER_A,
        dimension: "ai_tokens",
        requestedUnits: 60,
        periodKey: "2026-11",
        idempotencyKey: "tok-cap-1",
        correlationId: "corr-tok",
      });
      await expect(
        gov.settleQuota({
          tenantId: TENANT_A,
          reservationId: tokRes.reservationId,
          actualUnits: 120,
          estimatedCostMicroUsd: 100,
          source: "typed_ai",
        }),
      ).rejects.toMatchObject({ statusCode: 429, code: "QUOTA_EXCEEDED" });

      const withinCap = await gov.settleQuota({
        tenantId: TENANT_A,
        reservationId: tokRes.reservationId,
        actualUnits: 90,
        estimatedCostMicroUsd: 90,
        source: "typed_ai",
      });
      expect(withinCap.reservation.settledUnits).toBe(90);

      // 4. Webhooks: missing subscription throws 404; concurrent delivery deduplicates atomically; older timestamp ignored
      const missingSubEvt: BillingWebhookEvent = {
        providerEventId: "evt_no_sub",
        eventType: "subscription.upgraded",
        tenantId: TENANT_B,
        planId: "sme_pro",
        planVersion: 1,
        occurredAt: "2026-11-28T00:00:00.000Z",
        isMock: true,
      };
      const missingRaw = JSON.stringify(missingSubEvt);
      await expect(
        gov.processMockBillingWebhook({
          rawPayload: missingRaw,
          signatureHex: signMockBillingWebhook(missingRaw, gov.getMockBillingWebhookSecret()),
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "SUBSCRIPTION_NOT_FOUND" });

      const upgradeEvt: BillingWebhookEvent = {
        providerEventId: "evt_upgrade_concurrent",
        eventType: "subscription.upgraded",
        tenantId: TENANT_A,
        planId: "sme_pro",
        planVersion: 1,
        occurredAt: "2026-11-28T10:00:00.000Z",
        isMock: true,
      };
      const upRaw = JSON.stringify(upgradeEvt);
      const upSig = signMockBillingWebhook(upRaw, gov.getMockBillingWebhookSecret());
      const [w1, w2] = await Promise.all([
        gov.processMockBillingWebhook({ rawPayload: upRaw, signatureHex: upSig }),
        gov.processMockBillingWebhook({ rawPayload: upRaw, signatureHex: upSig }),
      ]);
      expect([w1.deduplicated, w2.deduplicated].sort()).toEqual([false, true]);
      expect(w1.subscription.planId).toBe("sme_pro");

      const staleEvt: BillingWebhookEvent = {
        providerEventId: "evt_stale_past_due",
        eventType: "subscription.past_due",
        tenantId: TENANT_A,
        occurredAt: "2026-11-28T08:00:00.000Z",
        isMock: true,
      };
      const staleRaw = JSON.stringify(staleEvt);
      const staleOut = await gov.processMockBillingWebhook({
        rawPayload: staleRaw,
        signatureHex: signMockBillingWebhook(staleRaw, gov.getMockBillingWebhookSecret()),
      });
      expect(staleOut.staleIgnored).toBe(true);
      expect(staleOut.subscription.status).toBe("active");
      expect(staleOut.subscription.planId).toBe("sme_pro");
    } finally {
      await db.close();
    }
  });

  it("F-21: guarantees atomic enqueueJob + quota rollback, rejects expired lease heartbeats, enforces orphan sweep grace period, and checks live download state", async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), "aios-wp1-f21-"));
    tempDirs.push(storeDir);
    const db = new PgliteDatabaseAdapter();
    try {
      await initializePostgreSqlSchema(db);
      await initializePaGovernanceSchema(db);
      const gov = new PlatformGovernanceService(db);
      await gov.seedDefaultPlans();
      await gov.createOrganization({ tenantId: TENANT_A, name: "OrgF21" });
      await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A, name: "WS A" });
      const pwHash = await hashPassword("StrongPass!2026");
      await db.query(
        "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, 'o@f21.kh', $2, 1, 'active')",
        [USER_OWNER_A, pwHash],
      );
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A, userId: USER_OWNER_A, role: "owner" });
      await gov.assignTenantSubscription({
        tenantId: TENANT_A,
        planId: "sme_standard",
        planVersion: 1,
        entitlementOverrides: { maxConcurrentJobs: 1 },
      });

      // 1. Simulated enqueueJob failure rolls back BOTH pa_jobs AND concurrent_jobs quota slot atomically
      await expect(
        gov.enqueueJob({
          actor: ACTOR_OWNER_A,
          jobType: "export_pdf",
          idempotencyKey: "job-atomic-fail",
          payload: { docId: "d1" },
          simulateFailureBeforeCommit: true,
        }),
      ).rejects.toThrow(/SIMULATED_ENQUEUE_FAILURE_BEFORE_COMMIT/);

      const enqOk = await gov.enqueueJob({
        actor: ACTOR_OWNER_A,
        jobType: "export_pdf",
        idempotencyKey: "job-atomic-succeed",
        payload: { docId: "d2" },
      });
      expect(enqOk.job.state).toBe("queued");

      // 2. Heartbeat rejects already-expired lease BEFORE reclaimExpiredLeases runs
      const claimed = await gov.claimNextJobLease({
        tenantId: TENANT_A,
        workerId: "worker-1",
        leaseDurationMs: 1_000,
      });
      expect(claimed?.leaseExpiresAt).toBeTruthy();
      const afterExpiryIso = new Date(Date.parse(claimed!.leaseExpiresAt!) + 5_000).toISOString();
      await expect(
        gov.heartbeatJobLease({
          tenantId: TENANT_A,
          jobId: claimed!.jobId,
          leaseToken: claimed!.leaseToken!,
          fencingGeneration: claimed!.fencingGeneration,
          nowIso: afterExpiryIso,
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "STALE_LEASE_FENCING_CONFLICT" });

      // 3. Orphan sweep default grace period preserves fresh staging blobs and sweeps only once aged out
      const store = new LocalPrivateObjectStore(storeDir, "wp1-f21-store-secret-32-chars-ok!");
      const orphanKey = await store.writeUnreferencedStagingBlob(
        `tenants/${TENANT_A}/workspaces/${WS_A}/staging/in-flight.tmp`,
        Buffer.from("fresh unreferenced bytes"),
      );
      const graceSweep = await store.sweepOrphanedBlobs(new Set());
      expect(graceSweep.removedKeys).toEqual([]);
      expect(graceSweep.skippedRecentKeys).toContain(orphanKey);

      const agedSweep = await store.sweepOrphanedBlobs(new Set(), {
        minAgeMs: DEFAULT_ORPHAN_SWEEP_MIN_AGE_MS,
        nowMs: Date.now() + DEFAULT_ORPHAN_SWEEP_MIN_AGE_MS + 10_000,
      });
      expect(agedSweep.removedKeys).toContain(orphanKey);

      // 4. Live authorization check on signed download tokens (quarantine, delete, revocation & consumeOnce replay)
      const put = await store.putObject({
        tenantId: TENANT_A,
        workspaceId: WS_A,
        objectId: "live-dl",
        version: 1,
        bytes: Buffer.from("Sensitive Report"),
      });
      const baseNow = 1_800_000_000_000;
      const dlToken = store.issueSignedDownloadToken({
        tenantId: TENANT_A,
        workspaceId: WS_A,
        objectId: "live-dl",
        version: 1,
        storageKey: put.storageKey,
        ttlSeconds: 120,
        nowMs: baseNow,
      });

      await expect(
        store.getAuthorizedObjectBytes({
          token: dlToken,
          expectedTenantId: TENANT_A,
          expectedWorkspaceId: WS_A,
          quarantineState: "quarantined",
          membershipActive: true,
          nowMs: baseNow + 1_000,
        }),
      ).rejects.toMatchObject({ statusCode: 423, code: "FILE_QUARANTINED_OR_UNSCANNED" });

      await expect(
        store.getAuthorizedObjectBytes({
          token: dlToken,
          expectedTenantId: TENANT_A,
          expectedWorkspaceId: WS_A,
          quarantineState: "clean",
          membershipActive: false,
          nowMs: baseNow + 1_000,
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "MEMBERSHIP_REVOKED" });

      await expect(
        store.getAuthorizedObjectBytes({
          token: dlToken,
          expectedTenantId: TENANT_A,
          expectedWorkspaceId: WS_A,
          quarantineState: "clean",
          deletedAt: "2026-11-28T00:00:00.000Z",
          nowMs: baseNow + 1_000,
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "OBJECT_DELETED" });

      const okFirst = await store.getAuthorizedObjectBytes({
        token: dlToken,
        expectedTenantId: TENANT_A,
        expectedWorkspaceId: WS_A,
        quarantineState: "clean",
        consumeOnce: true,
        nowMs: baseNow + 1_000,
      });
      expect(Buffer.from(okFirst.bytes).toString("utf8")).toBe("Sensitive Report");

      await expect(
        store.getAuthorizedObjectBytes({
          token: dlToken,
          expectedTenantId: TENANT_A,
          expectedWorkspaceId: WS_A,
          quarantineState: "clean",
          consumeOnce: true,
          nowMs: baseNow + 2_000,
        }),
      ).rejects.toMatchObject({ statusCode: 401, code: "SIGNED_TOKEN_REPLAYED" });
    } finally {
      await db.close();
    }
  });
});
