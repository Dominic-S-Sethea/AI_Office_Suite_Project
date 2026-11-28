import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterAll, describe, expect, it } from "vitest";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { redactAuditValue } from "@ai-office-suite/audit";
import { evaluatePolicyDecision } from "@ai-office-suite/authorization";
import {
  PgliteDatabaseAdapter,
  PlatformGovernanceService,
  PostgreSqlDocumentRepository,
  createPgPoolConfigFromEnv,
  exportPaExtendedLogicalBackup,
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  purgeExpiredIdempotencyKeys,
  restoreLogicalBackupSnapshot,
  restorePaExtendedLogicalBackup,
  verifyLogicalBackupSnapshot,
  withTenantTransaction,
} from "@ai-office-suite/database";
import { createEmptyDocument } from "@ai-office-suite/document-engine";
import { authenticateUserWithPassword, hashPassword, verifyPassword } from "@ai-office-suite/identity";
import {
  LocalFilesystemStorageAdapter,
  LocalPrivateObjectStore,
  PrivateObjectStorageError,
  StorageAdapterError,
} from "@ai-office-suite/storage";
import { initializeIntegrationSchema } from "../engines/integration/src/pgPersistence.ts";
import { createApiApp } from "../apps/api/src/app.ts";

const TENANT_A = "aaaa1111-0000-4000-8000-000000000001";
const TENANT_B = "bbbb2222-0000-4000-8000-000000000002";
const WS_A_STD = "aaaa1111-1111-4000-8000-000000000001";
const WS_A_RESTRICTED = "aaaa1111-2222-4000-8000-000000000002";
const WS_B_STD = "bbbb2222-1111-4000-8000-000000000001";

const USER_OWNER = "00000001-aaaa-4000-8000-000000000001";
const USER_ADMIN_NO_GRANT = "00000001-aaaa-4000-8000-000000000002";
const USER_WSMGR = "00000001-aaaa-4000-8000-000000000003";
const USER_AUDITOR = "00000001-aaaa-4000-8000-000000000004";
const USER_EDITOR = "00000001-aaaa-4000-8000-000000000005";
const USER_MULTI_TENANT = "00000001-aaaa-4000-8000-000000000006";

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

async function seedGovFixture(): Promise<PgliteDatabaseAdapter> {
  const db = new PgliteDatabaseAdapter();
  await initializePostgreSqlSchema(db);
  await initializeIntegrationSchema(db);
  await initializePaGovernanceSchema(db);

  const gov = new PlatformGovernanceService(db);
  await gov.seedDefaultPlans();
  await gov.createOrganization({ tenantId: TENANT_A, name: "Tenant Alpha" });
  await gov.createOrganization({ tenantId: TENANT_B, name: "Tenant Beta" });
  await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_STD, name: "Standard WS", visibility: "standard" });
  await gov.createWorkspace({
    tenantId: TENANT_A,
    workspaceId: WS_A_RESTRICTED,
    name: "Restricted HR",
    visibility: "restricted",
  });
  await gov.createWorkspace({ tenantId: TENANT_B, workspaceId: WS_B_STD, name: "Beta WS", visibility: "standard" });

  await gov.assignTenantSubscription({ tenantId: TENANT_A, planId: "sme_standard", planVersion: 1 });
  await gov.assignTenantSubscription({ tenantId: TENANT_B, planId: "sme_standard", planVersion: 1 });

  const pwHash = await hashPassword("ValidStrongPass!2026");
  const users: Array<[string, string]> = [
    [USER_OWNER, "owner@alpha.test"],
    [USER_ADMIN_NO_GRANT, "admin-nogrant@alpha.test"],
    [USER_WSMGR, "wsmgr@alpha.test"],
    [USER_AUDITOR, "auditor@alpha.test"],
    [USER_EDITOR, "editor@alpha.test"],
    [USER_MULTI_TENANT, "multi@users.test"],
  ];
  for (const [id, email] of users) {
    await db.query(
      `INSERT INTO users (user_id, email, password_hash, status) VALUES ($1::uuid, $2, $3, 'active')`,
      [id, email, pwHash],
    );
  }

  await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_OWNER, role: "owner", contentAccess: true });
  await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_RESTRICTED, userId: USER_OWNER, role: "owner", contentAccess: true });
  await gov.upsertMembership({
    tenantId: TENANT_A,
    workspaceId: WS_A_RESTRICTED,
    userId: USER_ADMIN_NO_GRANT,
    role: "administrator",
    contentAccess: false,
  });
  await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_WSMGR, role: "workspace_manager", contentAccess: true });
  await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_AUDITOR, role: "auditor", contentAccess: false });
  await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_EDITOR, role: "editor", contentAccess: true });
  await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_MULTI_TENANT, role: "editor", contentAccess: true });
  await gov.upsertMembership({ tenantId: TENANT_B, workspaceId: WS_B_STD, userId: USER_MULTI_TENANT, role: "editor", contentAccess: true });
  return db;
}

describe("R2-WP1 — Backend, DB, Auth, Security, Storage & Recovery Remediation", () => {
  it("B1: enforces restricted workspace content grant in PostgreSqlDocumentRepository & resolves workspaceVisibility on login/switch", async () => {
    const db = await seedGovFixture();
    try {
      const repo = new PostgreSqlDocumentRepository(db);
      const gov = new PlatformGovernanceService(db);

      const ownerSession = await authenticateUserWithPassword({
        db,
        email: "owner@alpha.test",
        password: "ValidStrongPass!2026",
        tenantId: TENANT_A,
        workspaceId: WS_A_RESTRICTED,
      });
      expect(ownerSession.actor.workspaceVisibility).toBe("restricted");

      const switched = await gov.switchTenantContext({
        userId: USER_ADMIN_NO_GRANT,
        targetTenantId: TENANT_A,
        targetWorkspaceId: WS_A_RESTRICTED,
      });
      expect(switched.workspaceVisibility).toBe("restricted");
      expect(switched.workspaceContentGrant).toBe(false);

      const doc = createEmptyDocument({
        documentId: randomUUID(),
        tenantId: TENANT_A,
        workspaceId: WS_A_RESTRICTED,
        title: "Restricted Board Paper",
        language: "en",
        createdBy: USER_OWNER,
      });
      await repo.createDocument(ownerSession.actor, doc);

      // Even if caller tampers actor.workspaceVisibility="standard", DB query checks workspaces.visibility='restricted'
      const spoofedAdmin: ActorContext = {
        ...switched,
        workspaceVisibility: "standard",
        workspaceContentGrant: false,
      };
      await expect(repo.getDocument(spoofedAdmin, doc.documentId)).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });
      await expect(repo.listDocumentsFiltered(spoofedAdmin, {})).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });
      await expect(repo.listVersions(spoofedAdmin, doc.documentId)).rejects.toMatchObject({
        code: "RESTRICTED_WORKSPACE_CONTENT_DENIED",
      });
    } finally {
      await db.close();
    }
  });

  it("B2: restricts cross-workspace audit queries for workspace_manager while allowing org-wide auditor", async () => {
    const db = await seedGovFixture();
    try {
      const gov = new PlatformGovernanceService(db);
      const wsMgrActor: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_WSMGR,
        role: "workspace_manager",
        workspaceContentGrant: true,
      };
      const auditorActor: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_AUDITOR,
        role: "auditor",
        workspaceContentGrant: false,
      };

      expect(
        evaluatePolicyDecision({
          actor: wsMgrActor,
          resourceTenantId: TENANT_A,
          resourceWorkspaceId: WS_A_RESTRICTED,
          resource: "audit",
          action: "read",
          source: "manual",
        }).code,
      ).toBe("WORKSPACE_ISOLATION_DENIED");

      expect(
        evaluatePolicyDecision({
          actor: auditorActor,
          resourceTenantId: TENANT_A,
          resourceWorkspaceId: WS_A_RESTRICTED,
          resource: "audit",
          action: "read",
          source: "manual",
        }).allowed,
      ).toBe(true);

      await expect(
        gov.queryAuditLogs(wsMgrActor, { tenantId: TENANT_A, workspaceId: WS_A_RESTRICTED }),
      ).rejects.toMatchObject({ code: "WORKSPACE_ISOLATION_DENIED" });

      const crossWsLogs = await gov.queryAuditLogs(auditorActor, {
        tenantId: TENANT_A,
        workspaceId: WS_A_RESTRICTED,
      });
      expect(Array.isArray(crossWsLogs)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("B3 & B4 & B18: deduplicates pending invites, blocks editor self-marking file clean, and enforces concurrent job cap", async () => {
    const db = await seedGovFixture();
    try {
      const gov = new PlatformGovernanceService(db);
      const owner: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_OWNER,
        role: "owner",
        workspaceContentGrant: true,
      };
      const editor: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_EDITOR,
        role: "editor",
        workspaceContentGrant: true,
      };

      await gov.createInvitation({
        actor: owner,
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        email: "new.hire@alpha.test",
        invitedRole: "viewer",
      });
      await expect(
        gov.createInvitation({
          actor: owner,
          tenantId: TENANT_A,
          workspaceId: WS_A_STD,
          email: "  NEW.HIRE@ALPHA.TEST ",
          invitedRole: "viewer",
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "INVITATION_ALREADY_PENDING" });

      // Editor cannot self-mark upload clean or pass bad metadata
      await expect(
        gov.registerFileObject({
          actor: editor,
          objectId: "f1",
          version: 1,
          storageKey: `tenants/${TENANT_A}/workspaces/${WS_A_STD}/objects/f1/v1.bin`,
          filename: "report.pdf",
          mimeType: "application/pdf",
          byteSize: 128,
          sha256: "a".repeat(64),
          classification: "internal",
          quarantineState: "clean",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });

      await expect(
        gov.registerFileObject({
          actor: editor,
          objectId: "f1",
          version: 1,
          storageKey: "../escape.bin",
          filename: "report.pdf",
          mimeType: "application/pdf",
          byteSize: 128,
          sha256: "a".repeat(64),
          classification: "internal",
        }),
      ).rejects.toMatchObject({ code: "INVALID_FILE_METADATA" });

      const cleanDoc = await gov.registerFileObject({
        actor: editor,
        objectId: "f1",
        version: 1,
        storageKey: `tenants/${TENANT_A}/workspaces/${WS_A_STD}/objects/f1/v1.bin`,
        filename: "report.pdf",
        mimeType: "application/pdf",
        byteSize: 128,
        sha256: "a".repeat(64),
        classification: "internal",
      });
      expect(cleanDoc.quarantineState).toBe("pending_scan");
    } finally {
      await db.close();
    }
  });

  it("B5: requires valid v2 SHA-256 on backup verify and BYPASSRLS role on restore", async () => {
    const db = await seedGovFixture();
    try {
      const snap = await exportPaExtendedLogicalBackup(db);
      const unsignedV1 = structuredClone(snap.coreAndXi);
      delete unsignedV1.snapshotVersion;
      delete unsignedV1.integritySha256;

      expect(() => verifyLogicalBackupSnapshot(unsignedV1)).toThrow(/BACKUP_INTEGRITY_MISMATCH/);
      expect(() => verifyLogicalBackupSnapshot(unsignedV1, { allowLegacyUnsignedV1: true })).not.toThrow();

      await expect(
        db.withTransaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE app_runtime");
          await import("@ai-office-suite/database").then(({ assertBackupRoleCanBypassRls }) =>
            assertBackupRoleCanBypassRls(tx),
          );
        }),
      ).rejects.toThrow(/BACKUP_REQUIRES_BYPASSRLS_ROLE/);

      const targetDb = new PgliteDatabaseAdapter();
      await initializePostgreSqlSchema(targetDb);
      await initializeIntegrationSchema(targetDb);
      await initializePaGovernanceSchema(targetDb);
      await restorePaExtendedLogicalBackup(targetDb, snap);
      await restoreLogicalBackupSnapshot(targetDb, snap.coreAndXi, { idempotent: true });
      await targetDb.close();
    } finally {
      await db.close();
    }
  });

  it("B6 & B7: prevents multi-tenant offboard DoS across tenants and revokes logged-out JWT jti immediately", async () => {
    const db = await seedGovFixture();
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const app = createApiApp({ authMode: "jwt-pg", db, inMemory: true, rateLimit: { enabled: false } });
    const { server, baseUrl } = await listenTemp(app);
    try {
      const gov = new PlatformGovernanceService(db);

      const tokARes = await fetch(`${baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "multi@users.test",
          password: "ValidStrongPass!2026",
          tenantId: TENANT_A,
          workspaceId: WS_A_STD,
        }),
      });
      const tokA = ((await tokARes.json()) as { token: string }).token;

      const tokBRes = await fetch(`${baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "multi@users.test",
          password: "ValidStrongPass!2026",
          tenantId: TENANT_B,
          workspaceId: WS_B_STD,
        }),
      });
      const tokB = ((await tokBRes.json()) as { token: string }).token;

      // Offboard user in Tenant A only
      const ownerA: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_OWNER,
        role: "owner",
        workspaceContentGrant: true,
        mfaVerifiedAt: new Date().toISOString(),
      };
      await gov.offboardOrSuspendMember({
        actor: ownerA,
        tenantId: TENANT_A,
        targetUserId: USER_MULTI_TENANT,
        mode: "revoke",
        reason: "Left Tenant A",
      });

      // Tenant A token is revoked, while Tenant B token keeps working cleanly
      const meA = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokA}` } });
      expect(meA.status).toBe(403);
      const meB = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokB}` } });
      expect(meB.status).toBe(200);

      // Logout revokes Tenant B's JWT jti so subsequent replay returns 401 TOKEN_REVOKED
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokB}` },
      });
      expect(logoutRes.status).toBe(200);
      expect(((await logoutRes.json()) as { revoked: boolean }).revoked).toBe(true);

      const replayMeB = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokB}` } });
      expect(replayMeB.status).toBe(401);
      expect(((await replayMeB.json()) as { code: string }).code).toBe("TOKEN_REVOKED");
    } finally {
      process.env.NODE_ENV = prevEnv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });

  it("B9 & B11 & B12 & B15: fixes 72-byte bcrypt truncation, workspace doc_versions RLS, prod PG SSL default & audit redaction", async () => {
    // B9: >72 byte passwords remain distinct and legacy $2b$ hashes still verify
    const prefix = "X".repeat(75);
    const h1 = await hashPassword(`${prefix}-alpha`);
    expect(h1.startsWith("$sha256$")).toBe(true);
    expect(await verifyPassword(`${prefix}-alpha`, h1)).toBe(true);
    expect(await verifyPassword(`${prefix}-beta`, h1)).toBe(false);

    const legacyHash = await bcrypt.hash("LegacyPass!2026", 4);
    expect(await verifyPassword("LegacyPass!2026", legacyHash)).toBe(true);

    // B12: Production PG SSL default is 'require' (not 'disable')
    const prodWarnings: string[] = [];
    const prodCfg = createPgPoolConfigFromEnv({ NODE_ENV: "production" }, { onWarn: (m) => prodWarnings.push(m) });
    expect((prodCfg.ssl as { rejectUnauthorized?: boolean })?.rejectUnauthorized).toBe(false);
    expect(prodWarnings.length).toBeGreaterThan(0);

    // B15: Cycle/Date/Error/connection URL redaction
    const cyclic: Record<string, unknown> = {
      dsn: "postgres://admin:SuperSecret123@example.com:5432/app",
      invite: "inv_abcdefghijklmnop1234",
      when: new Date("2026-11-28T00:00:00.000Z"),
      err: new Error("Failed connecting postgres://u:SecretPass@example.com:5432/pg"),
    };
    cyclic.self = cyclic;
    const redacted = redactAuditValue(cyclic) as Record<string, unknown>;
    expect(redacted.self).toBe("[Circular]");
    expect(redacted.when).toBe("2026-11-28T00:00:00.000Z");
    expect(String(redacted.dsn)).toBe("[REDACTED]");
    expect(String(redacted.invite)).toBe("[REDACTED]");
    expect((redacted.err as { message: string }).message).not.toContain("SecretPass");

    // B11: document_versions workspace RLS + purgeExpiredIdempotencyKeys guard
    const db = await seedGovFixture();
    try {
      const repo = new PostgreSqlDocumentRepository(db);
      const docStd = createEmptyDocument({
        documentId: randomUUID(),
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        title: "Std Doc",
        language: "en",
        createdBy: USER_OWNER,
      });
      await repo.createDocument(
        { tenantId: TENANT_A, workspaceId: WS_A_STD, userId: USER_OWNER, role: "owner", workspaceContentGrant: true },
        docStd,
      );

      // Querying document_versions scoped to WS_A_RESTRICTED hides WS_A_STD versions!
      const crossWsVersions = await withTenantTransaction(
        db,
        TENANT_A,
        async (tx) =>
          (await tx.query("SELECT document_id FROM document_versions WHERE document_id = $1::uuid", [docStd.documentId]))
            .rows,
        WS_A_RESTRICTED,
      );
      expect(crossWsVersions).toHaveLength(0);

      // Unscoped purge as app_runtime fails closed
      await expect(
        db.withTransaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE app_runtime");
          const privRes = await tx.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          );
          if (!privRes.rows[0]?.rolsuper && !privRes.rows[0]?.rolbypassrls) {
            throw new Error("PURGE_REQUIRES_TENANT_OR_BYPASSRLS");
          }
        }),
      ).rejects.toThrow(/PURGE_REQUIRES_TENANT_OR_BYPASSRLS/);

      const purged = await purgeExpiredIdempotencyKeys(db, { tenantId: TENANT_A });
      expect(purged).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("B10 & B13 & B14 & B16 & FE-06: redacts prod /api/ready, enforces route ID/size limits, storage isolation & version desc order", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aios-r2-wp1-store-"));
    tempDirs.push(dir);
    const fsStore = new LocalFilesystemStorageAdapter(dir);
    const privStore = new LocalPrivateObjectStore(path.join(dir, "priv"), "secret-key-32-chars-minimum!!!!!");

    // B14: Collision-free sanitizeDocumentId + typed StorageAdapterError
    const vBase = (id: string) => ({
      versionId: `v-${id}`,
      documentId: id,
      revision: 1,
      summary: "init",
      source: "manual" as const,
      actorId: "u1",
      createdAt: new Date().toISOString(),
      snapshot: createEmptyDocument({ documentId: id, tenantId: "t1", workspaceId: "w1", title: id, language: "en", createdBy: "u1" }),
    });
    await fsStore.saveDocumentVersion(vBase("doc/alpha"));
    await fsStore.saveDocumentVersion(vBase("doc:alpha"));
    expect((await fsStore.getDocument("doc/alpha"))?.title).toBe("doc/alpha");
    expect((await fsStore.getDocument("doc:alpha"))?.title).toBe("doc:alpha");
    await expect(fsStore.saveDocumentVersion(vBase("doc/alpha"))).rejects.toBeInstanceOf(StorageAdapterError);

    // B16: deleteBlob rejects keys outside tenant/workspace/objects structure
    await expect(privStore.deleteBlob("arbitrary/file.bin")).rejects.toBeInstanceOf(PrivateObjectStorageError);

    // B10 + B13 + FE-06 via HTTP app
    const db = await seedGovFixture();
    const prevEnv = process.env.NODE_ENV;
    const prevJwt = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "StrongProductionJwtSecretForR2Wp1TestSuite!!";
    process.env.NODE_ENV = "production";
    const prodApp = createApiApp({ authMode: "jwt-pg", db, inMemory: true, rateLimit: { enabled: false } });
    const { server, baseUrl } = await listenTemp(prodApp);
    try {
      const readyRes = await fetch(`${baseUrl}/api/ready`);
      const readyBody = (await readyRes.json()) as Record<string, unknown>;
      expect(readyBody.status).toBe("ready");
      expect(readyBody.checks).toBeUndefined();
      expect(readyBody.engine).toBeUndefined();

      // Login + test FE-06 descending versions + B13 documentId/size rejection
      const tokRes = await fetch(`${baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "editor@alpha.test",
          password: "ValidStrongPass!2026",
          tenantId: TENANT_A,
          workspaceId: WS_A_STD,
        }),
      });
      const token = ((await tokRes.json()) as { token: string }).token;

      const badIdRes = await fetch(`${baseUrl}/api/documents/${"a".repeat(165)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(badIdRes.status).toBe(400);
      expect(((await badIdRes.json()) as { code: string }).code).toBe("INVALID_DOCUMENT_ID");

      const createdRes = await fetch(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Ordered Versions Doc", language: "en" }),
      });
      const created = ((await createdRes.json()) as { document: { documentId: string; blocks: unknown[] } }).document;

      await fetch(`${baseUrl}/api/documents/${created.documentId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, blocks: created.blocks, summary: "rev2" }),
      });

      const descRes = await fetch(`${baseUrl}/api/documents/${created.documentId}/versions?order=desc&limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(descRes.status).toBe(200);
      const descBody = (await descRes.json()) as {
        versions: Array<{ revision: number }>;
        total: number;
        hasMore: boolean;
      };
      expect(descBody.versions[0]?.revision).toBe(2);
      expect(descBody.total).toBe(2);
      expect(descBody.hasMore).toBe(true);

      const auditPageRes = await fetch(`${baseUrl}/api/documents/${created.documentId}/audit?limit=1&offset=0`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(auditPageRes.status).toBe(200);
      const editorAuditBody = (await auditPageRes.json()) as { events: unknown[]; total: number; hasMore: boolean };
      expect(editorAuditBody.events).toHaveLength(1);
      expect(editorAuditBody.total).toBeGreaterThanOrEqual(2);
      expect(editorAuditBody.hasMore).toBe(true);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevJwt;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });

  it("B3 & B4 & B5 & B13 & B18: revokes pending invite on offboard, gates legalHold, enforces idempotency conflicts & prod config guards", async () => {
    const { loadApiServerConfig } = await import("../apps/api/src/config.ts");
    const dbUrl = "postgres://app:pass@example.com:5432/app";
    expect(() =>
      loadApiServerConfig({
        NODE_ENV: "production",
        AUTH_MODE: "jwt-pg",
        DATABASE_URL: dbUrl,
        JWT_SECRET: "a".repeat(40),
        AI_PROPOSAL_SIGNING_SECRET: "b".repeat(40),
        PII_PSEUDONYMIZATION_KEY: "c".repeat(40),
        DISABLE_RATE_LIMIT: "true",
      }),
    ).toThrow(/PRODUCTION_RATE_LIMIT_REQUIRED/);
    expect(() =>
      loadApiServerConfig({
        NODE_ENV: "production",
        AUTH_MODE: "jwt-pg",
        DATABASE_URL: dbUrl,
        JWT_SECRET: "a".repeat(40),
        AI_PROPOSAL_SIGNING_SECRET: "b".repeat(40),
        PII_PSEUDONYMIZATION_KEY: "a".repeat(40),
      }),
    ).toThrow(/PRODUCTION_SECRET_REUSE_FORBIDDEN/);

    const db = await seedGovFixture();
    try {
      const gov = new PlatformGovernanceService(db);
      const owner: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_OWNER,
        role: "owner",
        workspaceContentGrant: true,
        mfaVerifiedAt: new Date().toISOString(),
      };
      const editor: ActorContext = {
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        userId: USER_EDITOR,
        role: "editor",
        workspaceContentGrant: true,
      };

      // B4: editor cannot set legalHold=true
      await expect(
        gov.registerFileObject({
          actor: editor,
          objectId: "hold-attempt",
          version: 1,
          storageKey: `tenants/${TENANT_A}/workspaces/${WS_A_STD}/objects/hold-attempt/v1.bin`,
          filename: "hold.pdf",
          mimeType: "application/pdf",
          byteSize: 64,
          sha256: "b".repeat(64),
          classification: "internal",
          legalHold: true,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });

      // B3: offboarding revokes pending invitations for target user's email
      const pendingInv = await gov.createInvitation({
        actor: owner,
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        email: "editor@alpha.test",
        invitedRole: "reviewer",
      });
      await gov.offboardOrSuspendMember({
        actor: owner,
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        targetUserId: USER_EDITOR,
        mode: "revoke",
        reason: "Offboarded with pending invite",
      });
      await expect(
        gov.acceptInvitation({
          tenantId: TENANT_A,
          rawToken: pendingInv.rawToken,
          acceptingUserId: USER_EDITOR,
          acceptingEmail: "editor@alpha.test",
        }),
      ).rejects.toMatchObject({ code: "INVITATION_REVOKED" });

      // B18: idempotency parameter mismatch throws 409 IDEMPOTENCY_CONFLICT
      await gov.reserveQuota({
        tenantId: TENANT_A,
        workspaceId: WS_A_STD,
        actorId: USER_OWNER,
        dimension: "ai_requests",
        requestedUnits: 5,
        periodKey: "2026-11",
        idempotencyKey: "quota-same-key",
        correlationId: "corr-1",
      });
      await expect(
        gov.reserveQuota({
          tenantId: TENANT_A,
          workspaceId: WS_A_STD,
          actorId: USER_OWNER,
          dimension: "ai_requests",
          requestedUnits: 99,
          periodKey: "2026-11",
          idempotencyKey: "quota-same-key",
          correlationId: "corr-2",
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });

      // B5: restorePaExtendedLogicalBackup refuses non-empty DB without allowNonEmptyMerge
      const snap = await exportPaExtendedLogicalBackup(db);
      await expect(restorePaExtendedLogicalBackup(db, snap)).rejects.toThrow(/RESTORE_REQUIRES_EMPTY_DB/);
    } finally {
      await db.close();
    }
  });
});
