import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ActorContext,
  DataScopePolicy,
  ReportingContext,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import {
  exportLogicalBackupSnapshot,
  initializePostgreSqlSchema,
  NodePgDatabaseAdapter,
  restoreLogicalBackupSnapshot,
  rollbackMigrationBatch,
  runLocalDataMigration,
  withTenantTransaction,
} from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import {
  CrossModuleIntegrationEngine,
  getPackageLifecycleRow,
  initializeIntegrationSchema,
  listOutboxEventsForTenant,
  STANDARD_FINANCE_COLUMNS,
} from "@ai-office-suite/integration-engine";
import { createApiApp } from "../apps/api/src/app.ts";

const LIVE_PG_URL = process.env.TEST_POSTGRES_URL?.trim();
const describeLivePg = LIVE_PG_URL ? describe : describe.skip;

const TENANT_ALPHA = "11111111-1111-4111-8111-111111111111";
const WS_ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_BETA = "22222222-2222-4222-8222-222222222222";
const WS_BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const USER_ALPHA_OWNER = "33333333-3333-4333-8333-333333333331";
const USER_ALPHA_EDITOR = "33333333-3333-4333-8333-333333333333";
const USER_ALPHA_VIEWER = "44444444-4444-4444-8444-444444444444";
const USER_BETA_OWNER = "55555555-5555-4555-8555-555555555555";

const OWNER_ALPHA_ACTOR: ActorContext = {
  tenantId: TENANT_ALPHA,
  workspaceId: WS_ALPHA,
  userId: USER_ALPHA_OWNER,
  role: "owner",
};

const POLICY_ALL_V1: DataScopePolicy = {
  policyId: "pol_pg16_exec_all",
  policyVersion: 1,
  tenantId: TENANT_ALPHA,
  principalRole: "owner",
  allowedDepartments: "ALL",
  allowedColumns: [...STANDARD_FINANCE_COLUMNS],
  canExportUnderlyingDetail: true,
  canPublish: true,
};

function buildSiblingDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeLivePg("Phase 1 — Real PostgreSQL 16 Verification (RLS, Pooled Isolation, Revocations, XI-00 & Backup/Restore)", () => {
  let db: NodePgDatabaseAdapter;
  let server: Server;
  let baseUrl: string;
  let scratchDir: string;

  beforeAll(async () => {
    db = new NodePgDatabaseAdapter(LIVE_PG_URL!);
    // Clean slate in target database before schema initialization
    await db.exec(`
      DROP TABLE IF EXISTS
        xi_outbox_events,
        xi_package_approvals,
        xi_reporting_packages,
        xi_workflow_runs,
        xi_dependency_edges,
        xi_artifact_revisions,
        xi_artifacts,
        migration_batches,
        ai_applied_operations,
        audit_logs,
        idempotency_keys,
        document_versions,
        documents,
        memberships,
        workspaces,
        users,
        organizations,
        schema_migrations
      CASCADE;
    `);
    await initializePostgreSqlSchema(db);
    await initializeIntegrationSchema(db);

    const ownerHash = await hashPassword("OwnerPass!2026");
    const editorHash = await hashPassword("StrongPass!2026");
    const viewerHash = await hashPassword("ViewerPass!2026");
    const betaHash = await hashPassword("BetaOwner!2026");

    await db.query(
      "INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, $2, 'active'), ($3::uuid, $4, 'active')",
      [TENANT_ALPHA, "Alpha PG16 Corp", TENANT_BETA, "Beta PG16 Ltd"],
    );
    await db.query(
      "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, $3), ($4::uuid, $5::uuid, $6)",
      [TENANT_ALPHA, WS_ALPHA, "Alpha HQ", TENANT_BETA, WS_BETA, "Beta HQ"],
    );
    await db.query(
      `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES
       ($1::uuid, 'owner@alpha.pg16.test', $2, 1, 'active'),
       ($3::uuid, 'editor@alpha.pg16.test', $4, 1, 'active'),
       ($5::uuid, 'viewer@alpha.pg16.test', $6, 1, 'active'),
       ($7::uuid, 'owner@beta.pg16.test', $8, 1, 'active')`,
      [
        USER_ALPHA_OWNER,
        ownerHash,
        USER_ALPHA_EDITOR,
        editorHash,
        USER_ALPHA_VIEWER,
        viewerHash,
        USER_BETA_OWNER,
        betaHash,
      ],
    );
    await db.query(
      `INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'owner'),
       ($1::uuid, $2::uuid, $4::uuid, 'editor'),
       ($1::uuid, $2::uuid, $5::uuid, 'viewer'),
       ($6::uuid, $7::uuid, $8::uuid, 'owner')`,
      [
        TENANT_ALPHA,
        WS_ALPHA,
        USER_ALPHA_OWNER,
        USER_ALPHA_EDITOR,
        USER_ALPHA_VIEWER,
        TENANT_BETA,
        WS_BETA,
        USER_BETA_OWNER,
      ],
    );

    const app = createApiApp({ inMemory: true, authMode: "jwt-pg", db });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    scratchDir = mkdtempSync(path.join(tmpdir(), "aios-pg16-test-"));
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

  it("verifies PostgreSQL 16 engine version, least-privilege app_runtime role attributes, and FORCE RLS catalogs", async () => {
    const verRes = await db.query<{ version_num: number; version: string }>(
      "SELECT current_setting('server_version_num')::int AS version_num, version()",
    );
    expect(verRes.rows[0]!.version_num).toBeGreaterThanOrEqual(160000);

    const roleRes = await db.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
    }>(
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = 'app_runtime'",
    );
    expect(roleRes.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: false,
    });

    const expectedRlsTables = [
      "workspaces",
      "documents",
      "document_versions",
      "idempotency_keys",
      "audit_logs",
      "ai_applied_operations",
      "xi_artifacts",
      "xi_artifact_revisions",
      "xi_dependency_edges",
      "xi_workflow_runs",
      "xi_reporting_packages",
      "xi_package_approvals",
      "xi_outbox_events",
    ];
    const rlsRes = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])
       ORDER BY relname`,
      [expectedRlsTables],
    );
    expect(rlsRes.rows).toHaveLength(expectedRlsTables.length);
    for (const row of rlsRes.rows) {
      expect(row.relrowsecurity, `RLS enabled on ${row.relname}`).toBe(true);
      expect(row.relforcerowsecurity, `FORCE RLS enabled on ${row.relname}`).toBe(true);
    }

    const readyRes = await fetch(`${baseUrl}/api/ready`);
    expect(readyRes.status).toBe(200);
    const readyJson = (await readyRes.json()) as { status: string; checks: { coreForceRlsEnabled: boolean } };
    expect(readyJson.status).toBe("ready");
    expect(readyJson.checks.coreForceRlsEnabled).toBe(true);
  });

  it("enforces FORCE RLS across reads, joins, cross-tenant writes, pooled transactions, and revokes audit/version tampering", async () => {
    // Login as Alpha editor via cookie (/api/auth/login) and Bearer (/api/auth/token)
    const loginAlpha = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "editor@alpha.pg16.test",
        password: "StrongPass!2026",
        tenantId: TENANT_ALPHA,
        workspaceId: WS_ALPHA,
      }),
    });
    expect(loginAlpha.status).toBe(200);
    const setCookie = loginAlpha.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("aios_session=");
    expect(setCookie).toContain("HttpOnly");
    const loginAlphaBody = (await loginAlpha.json()) as { token?: string };
    expect(loginAlphaBody.token).toBeUndefined();

    const tokenAlphaRes = await fetch(`${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "editor@alpha.pg16.test",
        password: "StrongPass!2026",
        tenantId: TENANT_ALPHA,
        workspaceId: WS_ALPHA,
      }),
    });
    expect(tokenAlphaRes.status).toBe(200);
    const { token: alphaToken } = (await tokenAlphaRes.json()) as { token: string };

    const loginBeta = await fetch(`${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@beta.pg16.test",
        password: "BetaOwner!2026",
        tenantId: TENANT_BETA,
        workspaceId: WS_BETA,
      }),
    });
    expect(loginBeta.status).toBe(200);
    const { token: betaToken } = (await loginBeta.json()) as { token: string };

    // Create documents in both tenants
    const alphaCreateRes = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alphaToken}` },
      body: JSON.stringify({ title: "PG16 Alpha Confidential", language: "bilingual" }),
    });
    expect(alphaCreateRes.status).toBe(201);
    const { document: alphaDoc } = (await alphaCreateRes.json()) as { document: StudioDocument };

    const betaCreateRes = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${betaToken}` },
      body: JSON.stringify({ title: "PG16 Beta Confidential", language: "en" }),
    });
    expect(betaCreateRes.status).toBe(201);
    const { document: betaDoc } = (await betaCreateRes.json()) as { document: StudioDocument };

    // 1. Fail-closed unset tenant context -> 0 rows across documents, versions, workspaces, audit_logs
    const unsetCounts = await withTenantTransaction(db, null, async (tx) => {
      const docs = await tx.query("SELECT document_id FROM documents");
      const vers = await tx.query("SELECT document_id FROM document_versions");
      const ws = await tx.query("SELECT workspace_id FROM workspaces");
      const aud = await tx.query("SELECT audit_id FROM audit_logs");
      return {
        docs: docs.rows.length,
        vers: vers.rows.length,
        ws: ws.rows.length,
        aud: aud.rows.length,
      };
    });
    expect(unsetCounts).toEqual({ docs: 0, vers: 0, ws: 0, aud: 0 });

    // 2. Cross-tenant JOIN query under Beta sees ONLY Beta doc, never Alpha doc
    const betaJoined = await withTenantTransaction(db, TENANT_BETA, async (tx) => {
      const res = await tx.query<{ document_id: string; tenant_id: string }>(
        `SELECT d.document_id::text, d.tenant_id::text
         FROM documents d
         JOIN document_versions v ON v.document_id = d.document_id`,
      );
      return res.rows;
    });
    expect(betaJoined).toHaveLength(1);
    expect(betaJoined[0]).toEqual({ document_id: betaDoc.documentId, tenant_id: TENANT_BETA });

    // 3. Cross-tenant INSERT under Beta targeting Alpha tenant_id -> MUST FAIL RLS WITH CHECK (42501)
    await expect(
      withTenantTransaction(db, TENANT_BETA, async (tx) => {
        await tx.query(
          `INSERT INTO documents
             (tenant_id, workspace_id, document_id, title, language, current_revision, status, created_by)
           VALUES ($1::uuid, $2::uuid, gen_random_uuid(), 'Forged Cross-Tenant', 'en', 1, 'draft', $3::uuid)`,
          [TENANT_ALPHA, WS_ALPHA, USER_BETA_OWNER],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    // 4. Cross-tenant UPDATE under Beta targeting Alpha document_id -> 0 rows updated
    const crossUpdateCount = await withTenantTransaction(db, TENANT_BETA, async (tx) => {
      const res = await tx.query(
        "UPDATE documents SET title = 'Hacked' WHERE document_id = $1::uuid",
        [alphaDoc.documentId],
      );
      return res.rowCount;
    });
    expect(crossUpdateCount).toBe(0);

    // 5. Real PostgreSQL privilege revocation: UPDATE/DELETE on audit_logs & DELETE/UPDATE on document_versions
    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("UPDATE audit_logs SET summary = 'tampered'");
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("DELETE FROM audit_logs");
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("DELETE FROM document_versions");
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("UPDATE document_versions SET snapshot_json = '{}'::jsonb");
      }),
    ).rejects.toThrow(/permission denied/i);

    // 6. Pooled connection isolation stress test (20 parallel interleaved transactions + deliberate rollbacks)
    const smallPoolDb = new NodePgDatabaseAdapter(LIVE_PG_URL!, { max: 2 });
    try {
      const tasks = Array.from({ length: 20 }, (_, idx) => {
        const mode = idx % 4;
        if (mode === 0) {
          return withTenantTransaction(smallPoolDb, TENANT_ALPHA, async (tx) => {
            const r = await tx.query<{ tenant_id: string }>("SELECT tenant_id::text FROM documents");
            expect(r.rows.every((row) => row.tenant_id === TENANT_ALPHA)).toBe(true);
            expect(r.rows.length).toBeGreaterThanOrEqual(1);
          });
        }
        if (mode === 1) {
          return withTenantTransaction(smallPoolDb, TENANT_BETA, async (tx) => {
            const r = await tx.query<{ tenant_id: string }>("SELECT tenant_id::text FROM documents");
            expect(r.rows.every((row) => row.tenant_id === TENANT_BETA)).toBe(true);
            expect(r.rows.length).toBeGreaterThanOrEqual(1);
          });
        }
        if (mode === 2) {
          return withTenantTransaction(smallPoolDb, null, async (tx) => {
            const r = await tx.query("SELECT document_id FROM documents");
            expect(r.rows).toHaveLength(0);
          });
        }
        // Mode 3: deliberate error inside Alpha transaction -> rollback must not leak Alpha context to next pooled consumer
        return withTenantTransaction(smallPoolDb, TENANT_ALPHA, async (tx) => {
          await tx.query("SELECT 1");
          throw new Error("DELIBERATE_TX_ABORT");
        }).catch(() => undefined);
      });
      await Promise.all(tasks);

      // Immediately verify no leaked role or tenant setting on subsequent unset query
      const afterPoolCheck = await withTenantTransaction(smallPoolDb, null, async (tx) => {
        const r = await tx.query("SELECT document_id FROM documents");
        return r.rows.length;
      });
      expect(afterPoolCheck).toBe(0);
    } finally {
      await smallPoolDb.close();
    }

    // 7. 5-way concurrent optimistic revision conflict (real PG16 FOR UPDATE row lock -> exactly one 200, four 409)
    const concurrentUpdates = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        fetch(`${baseUrl}/api/documents/${alphaDoc.documentId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${alphaToken}` },
          body: JSON.stringify({
            expectedRevision: 1,
            title: `PG16 Alpha Race Winner #${idx}`,
            blocks: alphaDoc.blocks,
          }),
        }),
      ),
    );
    const raceStatuses = concurrentUpdates.map((r) => r.status).sort((a, b) => a - b);
    expect(raceStatuses).toEqual([200, 409, 409, 409, 409]);

    // 8. Cookie CSRF cross-site check + session token_version revocation
    const cookiePair = setCookie.split(";")[0]!;
    const csrfRes = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ title: "CSRF Blocked", language: "en" }),
    });
    expect(csrfRes.status).toBe(403);

    const revokeRes = await fetch(`${baseUrl}/api/auth/revoke-sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alphaToken}` },
    });
    expect(revokeRes.status).toBe(200);
    const afterRevoke = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${alphaToken}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("verifies engines/integration (xi_* RLS, workflow crash/rehydrate, atomic commitPackagePublicationTx & outbox) on real PG16", async () => {
    const engine = new CrossModuleIntegrationEngine({ db });
    const seeded = await engine.seedGoldenV1(TENANT_ALPHA, WS_ALPHA, OWNER_ALPHA_ACTOR);

    const context: ReportingContext = {
      tenantId: TENANT_ALPHA,
      workspaceId: WS_ALPHA,
      periodStart: "2026-11-01",
      periodEndExclusive: "2026-12-01",
      datasetId: seeded.datasetId,
      datasetVersion: 1,
      metricIds: ["FIN-NET-SALES", "FIN-OPERATING-PROFIT", "FIN-OPERATING-MARGIN"],
      requestedDepartments: ["Sales", "Services", "Retail"],
      currency: "USD",
      language: "bilingual",
      themeId: "corp_default_v1",
      themeVersion: 1,
    };

    // Pause mid-workflow -> crash -> rehydrate from real PG16 -> resume
    const paused = await engine.startMonthlyReportingWorkflow(OWNER_ALPHA_ACTOR, POLICY_ALL_V1, {
      idempotencyKey: "pg16_wf_rehydrate_1",
      context,
      pauseAfterStep: "stage_document",
    });
    expect(paused.run.state).toBe("awaiting_clarification");

    const restartedEngine = new CrossModuleIntegrationEngine({ db });
    await restartedEngine.seedGoldenV1(TENANT_ALPHA, WS_ALPHA, OWNER_ALPHA_ACTOR);
    const rehydrated = await restartedEngine.rehydrateWorkflowFromDb(OWNER_ALPHA_ACTOR, paused.run.runId);
    expect(rehydrated.runId).toBe(paused.run.runId);
    const resumed = await restartedEngine.resumeWorkflow(OWNER_ALPHA_ACTOR, POLICY_ALL_V1, paused.run.runId);
    expect(resumed.run.state).toBe("awaiting_approval");
    expect(resumed.run.stagedPackageId).toBeTruthy();

    const pkgId = resumed.run.stagedPackageId!;
    await restartedEngine.approveReportingPackage(OWNER_ALPHA_ACTOR, pkgId, 1);

    // Simulated mid-tx commit failure -> full PG16 rollback
    const outboxBefore = await listOutboxEventsForTenant(db, TENANT_ALPHA);
    await expect(
      restartedEngine.publishReportingPackage(OWNER_ALPHA_ACTOR, POLICY_ALL_V1, {
        packageId: pkgId,
        packageVersion: 1,
        idempotencyKey: "pg16_pub_rollback_1",
        simulateFailureBeforeCommit: true,
      }),
    ).rejects.toThrow(/SIMULATED_PUBLICATION_COMMIT_FAILURE/);
    expect((await getPackageLifecycleRow(db, TENANT_ALPHA, pkgId, 1))?.lifecycle_status).not.toBe("published");
    expect((await listOutboxEventsForTenant(db, TENANT_ALPHA)).length).toBe(outboxBefore.length);

    // Clean atomic PG16 publication commit -> package + artifacts + audit_logs + xi_outbox_events
    const published = await restartedEngine.publishReportingPackage(OWNER_ALPHA_ACTOR, POLICY_ALL_V1, {
      packageId: pkgId,
      packageVersion: 1,
      idempotencyKey: "pg16_pub_commit_1",
    });
    expect(published.lifecycleStatus).toBe("published");
    expect((await getPackageLifecycleRow(db, TENANT_ALPHA, pkgId, 1))?.lifecycle_status).toBe("published");
    const outboxAfter = await listOutboxEventsForTenant(db, TENANT_ALPHA);
    expect(outboxAfter.length).toBe(outboxBefore.length + 1);

    // Tenant Beta sees ZERO Alpha xi_* rows and app_runtime cannot DELETE/UPDATE immutable xi_* tables
    const betaXiVisibility = await withTenantTransaction(db, TENANT_BETA, async (tx) => {
      const arts = await tx.query("SELECT artifact_id FROM xi_artifacts");
      const pkgs = await tx.query("SELECT package_id FROM xi_reporting_packages");
      const outbox = await tx.query("SELECT event_id FROM xi_outbox_events");
      return { arts: arts.rows.length, pkgs: pkgs.rows.length, outbox: outbox.rows.length };
    });
    expect(betaXiVisibility).toEqual({ arts: 0, pkgs: 0, outbox: 0 });

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("DELETE FROM xi_outbox_events");
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("DELETE FROM xi_package_approvals");
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("DELETE FROM xi_artifact_revisions");
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTransaction(db, TENANT_ALPHA, async (tx) => {
        await tx.query("UPDATE xi_artifact_revisions SET content_sha256 = repeat('0', 64)");
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("verifies reversible .local-data migration (dry-run/apply/rollback) and logical SQL backup/restore across real PG16 databases", async () => {
    const legacyDocDir = path.join(scratchDir, "documents", "doc_pg16_fixture");
    mkdirSync(legacyDocDir, { recursive: true });
    const fixtureFile = path.join(legacyDocDir, "rev-1.json");
    const sampleDoc: StudioDocument = {
      documentId: "doc_pg16_fixture",
      tenantId: TENANT_ALPHA,
      workspaceId: WS_ALPHA,
      title: "PG16 Migrated Bilingual Report · របាយការណ៍",
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
      blocks: [{ id: "b1", type: "paragraph", runs: [{ text: "សួស្តី PostgreSQL 16" }] }],
      createdBy: USER_ALPHA_OWNER,
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
      actorUserId: USER_ALPHA_OWNER,
      mode: "dry-run",
    });
    expect(dryRun.documentsScanned).toBe(1);
    expect(dryRun.entries[0]?.sha256).toBe(originalSha);

    const applied = await runLocalDataMigration({
      db,
      localDataDir: scratchDir,
      targetTenantId: TENANT_ALPHA,
      targetWorkspaceId: WS_ALPHA,
      actorUserId: USER_ALPHA_OWNER,
      mode: "apply",
    });
    expect(applied.documentsScanned).toBe(1);

    const rolledBack = await rollbackMigrationBatch(db, applied.batchId);
    expect(rolledBack.removedDocuments).toBe(1);
    expect(existsSync(fixtureFile)).toBe(true);
    expect(createHash("sha256").update(readFileSync(fixtureFile, "utf8")).digest("hex")).toBe(originalSha);

    // Export logical backup snapshot, round-trip through JSON, and restore into a brand new PG16 database
    const snapshot = JSON.parse(JSON.stringify(await exportLogicalBackupSnapshot(db))) as Awaited<
      ReturnType<typeof exportLogicalBackupSnapshot>
    >;
    expect(snapshot.documents.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.auditLogs.length).toBeGreaterThanOrEqual(2);

    const restoreDbName = "aios_restore_verify";
    await db.exec(`DROP DATABASE IF EXISTS ${restoreDbName}`);
    await db.exec(`CREATE DATABASE ${restoreDbName}`);
    const restoreDb = new NodePgDatabaseAdapter(buildSiblingDatabaseUrl(LIVE_PG_URL!, restoreDbName));
    try {
      await initializePostgreSqlSchema(restoreDb);
      await restoreLogicalBackupSnapshot(restoreDb, snapshot);

      const [docCnt, verCnt, audCnt] = await Promise.all([
        restoreDb.query<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM documents"),
        restoreDb.query<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM document_versions"),
        restoreDb.query<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM audit_logs"),
      ]);
      expect(docCnt.rows[0]!.cnt).toBe(snapshot.documents.length);
      expect(verCnt.rows[0]!.cnt).toBe(snapshot.documentVersions.length);
      expect(audCnt.rows[0]!.cnt).toBe(snapshot.auditLogs.length);
    } finally {
      await restoreDb.close();
      await db.exec(`DROP DATABASE IF EXISTS ${restoreDbName}`);
    }
  });
});
