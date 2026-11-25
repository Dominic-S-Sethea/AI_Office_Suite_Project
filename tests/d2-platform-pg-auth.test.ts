import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import {
  exportLogicalBackupSnapshot,
  initializePostgreSqlSchema,
  PgliteDatabaseAdapter,
  restoreLogicalBackupSnapshot,
  rollbackMigrationBatch,
  runLocalDataMigration,
  withTenantTransaction,
} from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import { createApiApp } from "../apps/api/src/app.ts";

const TENANT_ALPHA = "11111111-1111-4111-8111-111111111111";
const WS_ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_BETA = "22222222-2222-4222-8222-222222222222";
const WS_BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const USER_ALPHA_EDITOR = "33333333-3333-4333-8333-333333333333";
const USER_ALPHA_VIEWER = "44444444-4444-4444-8444-444444444444";
const USER_BETA_OWNER = "55555555-5555-4555-8555-555555555555";

describe("Phase D2 (G2) — PostgreSQL RLS, Hardened Auth/RBAC, Concurrency & Migration", () => {
  let db: PgliteDatabaseAdapter;
  let server: Server;
  let baseUrl: string;
  let scratchDir: string;

  beforeAll(async () => {
    db = new PgliteDatabaseAdapter();
    await db.ready();
    await initializePostgreSqlSchema(db);

    const editorHash = await hashPassword("StrongPass!2026");
    const viewerHash = await hashPassword("ViewerPass!2026");
    const betaHash = await hashPassword("BetaOwner!2026");

    await db.query(
      "INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, $2, 'active'), ($3::uuid, $4, 'active')",
      [TENANT_ALPHA, "Alpha Corp", TENANT_BETA, "Beta Ltd"],
    );
    await db.query(
      "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, $3), ($4::uuid, $5::uuid, $6)",
      [TENANT_ALPHA, WS_ALPHA, "Alpha HQ", TENANT_BETA, WS_BETA, "Beta HQ"],
    );
    await db.query(
      `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES
       ($1::uuid, 'editor@alpha.test', $2, 1, 'active'),
       ($3::uuid, 'viewer@alpha.test', $4, 1, 'active'),
       ($5::uuid, 'owner@beta.test', $6, 1, 'active')`,
      [USER_ALPHA_EDITOR, editorHash, USER_ALPHA_VIEWER, viewerHash, USER_BETA_OWNER, betaHash],
    );
    await db.query(
      `INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'editor'),
       ($1::uuid, $2::uuid, $4::uuid, 'viewer'),
       ($5::uuid, $6::uuid, $7::uuid, 'owner')`,
      [TENANT_ALPHA, WS_ALPHA, USER_ALPHA_EDITOR, USER_ALPHA_VIEWER, TENANT_BETA, WS_BETA, USER_BETA_OWNER],
    );

    const app = createApiApp({ inMemory: true, authMode: "jwt-pg", db });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    scratchDir = mkdtempSync(path.join(tmpdir(), "aios-d2-test-"));
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (db) {
      await db.close();
    }
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("enforces fail-closed PostgreSQL RLS as app_runtime, blocks cross-tenant queries/FKs, and forbids audit tampering", async () => {
    // 1. Login as Alpha editor via HTTP (cookie + JWT)
    const loginAlpha = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "editor@alpha.test",
        password: "StrongPass!2026",
        tenantId: TENANT_ALPHA,
        workspaceId: WS_ALPHA,
      }),
    });
    expect(loginAlpha.status).toBe(200);
    expect(loginAlpha.headers.get("x-auth-mode")).toBe("jwt-postgresql-rls");
    const setCookie = loginAlpha.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("aios_session=");
    expect(setCookie).toContain("HttpOnly");
    const { token: alphaToken } = (await loginAlpha.json()) as { token: string };

    // 2. Create a document in Alpha tenant
    const createRes = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alphaToken}`,
      },
      body: JSON.stringify({ title: "Alpha Confidential Budget", language: "bilingual" }),
    });
    expect(createRes.status).toBe(201);
    const { document: alphaDoc } = (await createRes.json()) as { document: StudioDocument };

    // 3. Direct DB check with unset app.current_tenant_id as app_runtime -> MUST return 0 rows (fail-closed)
    const unsetRows = await withTenantTransaction(db, null, async (tx) => {
      const r = await tx.query("SELECT document_id FROM documents");
      return r.rows;
    });
    expect(unsetRows).toHaveLength(0);

    // 4. Direct DB check under Tenant Beta RLS context -> sees ZERO Alpha documents & cannot delete/update audit_logs
    const betaRows = await withTenantTransaction(db, TENANT_BETA, async (tx) => {
      const r = await tx.query("SELECT document_id FROM documents");
      return r.rows;
    });
    expect(betaRows).toHaveLength(0);

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("DELETE FROM audit_logs");
      }),
    ).rejects.toThrow();

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("UPDATE document_versions SET snapshot_json = '{}'::jsonb");
      }),
    ).rejects.toThrow();

    // 5. Cross-tenant HTTP access via Beta Owner -> blocked on Alpha doc
    const loginBeta = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@beta.test",
        password: "BetaOwner!2026",
        tenantId: TENANT_BETA,
        workspaceId: WS_BETA,
      }),
    });
    const { token: betaToken } = (await loginBeta.json()) as { token: string };
    const crossRead = await fetch(`${baseUrl}/api/documents/${alphaDoc.documentId}`, {
      headers: { Authorization: `Bearer ${betaToken}` },
    });
    expect(crossRead.status).toBe(404);

    // Header spoofing against JWT claims is also rejected fail-closed with 403
    const spoofedHeaderRes = await fetch(`${baseUrl}/api/documents`, {
      headers: {
        Authorization: `Bearer ${betaToken}`,
        "x-tenant-id": TENANT_ALPHA,
      },
    });
    expect(spoofedHeaderRes.status).toBe(403);

    // 6. RBAC Viewer cannot create documents
    const loginViewer = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "viewer@alpha.test",
        password: "ViewerPass!2026",
        tenantId: TENANT_ALPHA,
        workspaceId: WS_ALPHA,
      }),
    });
    const { token: viewerToken } = (await loginViewer.json()) as { token: string };
    const viewerCreate = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ title: "Illegal Viewer Doc", language: "en" }),
    });
    expect(viewerCreate.status).toBe(403);

    // 7. Cookie CSRF protection + optimistic concurrency (409) + token_version revocation (401)
    const cookiePair = setCookie.split(";")[0]!;
    const csrfBlocked = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ title: "CSRF Attack", language: "en" }),
    });
    expect(csrfBlocked.status).toBe(403);

    // Concurrent revision update: two updates targeting expectedRevision 1
    const [u1, u2] = await Promise.all([
      fetch(`${baseUrl}/api/documents/${alphaDoc.documentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${alphaToken}` },
        body: JSON.stringify({
          expectedRevision: 1,
          title: "Alpha Budget Rev 2A",
          blocks: alphaDoc.blocks,
        }),
      }),
      fetch(`${baseUrl}/api/documents/${alphaDoc.documentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${alphaToken}` },
        body: JSON.stringify({
          expectedRevision: 1,
          title: "Alpha Budget Rev 2B",
          blocks: alphaDoc.blocks,
        }),
      }),
    ]);
    const statuses = [u1.status, u2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    // Revoke sessions -> increments token_version and invalidates prior Bearer token cleanly
    const revokeRes = await fetch(`${baseUrl}/api/auth/revoke-sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alphaToken}` },
    });
    expect(revokeRes.status).toBe(200);
    const staleTokenCheck = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${alphaToken}` },
    });
    expect(staleTokenCheck.status).toBe(401);
  });

  it("supports reversible .local-data/ migration (dry-run, apply, rollback) and logical SQL backup/restore", async () => {
    const legacyDocDir = path.join(scratchDir, "documents", "doc_local_fixture");
    mkdirSync(legacyDocDir, { recursive: true });
    const fixtureFile = path.join(legacyDocDir, "rev-1.json");
    const sampleDoc: StudioDocument = {
      documentId: "doc_local_fixture",
      tenantId: TENANT_ALPHA,
      workspaceId: WS_ALPHA,
      title: "Prototype Migrated Document",
      language: "bilingual",
      revision: 1,
      status: "draft",
      layout: {
        size: "A4",
        orientation: "portrait",
        marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
        headerText: "Header",
        footerText: "Footer",
        showPageNumbers: true,
      },
      blocks: [{ id: "b1", type: "paragraph", runs: [{ text: "សួស្តី World" }] }],
      createdBy: USER_ALPHA_EDITOR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rawContent = JSON.stringify({ revision: 1, snapshot: sampleDoc });
    writeFileSync(fixtureFile, rawContent, "utf8");
    const originalSha = createHash("sha256").update(rawContent).digest("hex");

    const dryRun = await runLocalDataMigration({
      db,
      localDataDir: scratchDir,
      targetTenantId: TENANT_ALPHA,
      targetWorkspaceId: WS_ALPHA,
      actorUserId: USER_ALPHA_EDITOR,
      mode: "dry-run",
    });
    expect(dryRun.documentsScanned).toBe(1);
    expect(dryRun.entries[0]?.sha256).toBe(originalSha);

    const applied = await runLocalDataMigration({
      db,
      localDataDir: scratchDir,
      targetTenantId: TENANT_ALPHA,
      targetWorkspaceId: WS_ALPHA,
      actorUserId: USER_ALPHA_EDITOR,
      mode: "apply",
    });
    expect(applied.documentsScanned).toBe(1);

    const rolledBack = await rollbackMigrationBatch(db, applied.batchId);
    expect(rolledBack.removedDocuments).toBe(1);
    expect(existsSync(fixtureFile)).toBe(true);
    expect(createHash("sha256").update(readFileSync(fixtureFile, "utf8")).digest("hex")).toBe(originalSha);

    // Logical PostgreSQL backup & restore drill into a fresh PGlite instance
    const snapshot = await exportLogicalBackupSnapshot(db);
    const restoreDb = new PgliteDatabaseAdapter();
    await restoreDb.ready();
    await initializePostgreSqlSchema(restoreDb);
    await restoreLogicalBackupSnapshot(restoreDb, snapshot);
    const restoredCount = await restoreDb.query<{ cnt: number }>("SELECT COUNT(*)::INTEGER AS cnt FROM documents");
    const restoredAuditCount = await restoreDb.query<{ cnt: number }>("SELECT COUNT(*)::INTEGER AS cnt FROM audit_logs");
    expect(Number(restoredCount.rows[0]?.cnt ?? 0)).toBe((snapshot.documents as unknown[]).length);
    expect(Number(restoredAuditCount.rows[0]?.cnt ?? 0)).toBe((snapshot.auditLogs as unknown[]).length);
    await restoreDb.close();
  });
});
