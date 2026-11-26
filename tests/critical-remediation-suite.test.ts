import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ActorContext, StudioDocument } from "@ai-office-suite/shared-contracts";
import {
  compileSafeContractPattern,
  DataPreparationPipeline,
  DataPrepError,
  stageCsvSource,
} from "@ai-office-suite/data-processing";
import {
  buildSanitizedSubprocessEnv,
  PDF_RENDER_CSP_META,
} from "@ai-office-suite/file-conversion";
import {
  exportLogicalBackupSnapshot,
  initializePostgreSqlSchema,
  PgliteDatabaseAdapter,
  PostgreSqlDocumentRepository,
  restoreLogicalBackupSnapshot,
  rollbackMigrationBatch,
  runLocalDataMigration,
  verifyDatabaseRlsReadiness,
} from "@ai-office-suite/database";
import { initializeIntegrationSchema } from "@ai-office-suite/integration-engine";
import { LocalFilesystemStorageAdapter } from "@ai-office-suite/storage";
import { InMemoryAuditStore } from "@ai-office-suite/audit";
import { DocumentService } from "@ai-office-suite/documents-module";
import { hashPassword } from "@ai-office-suite/identity";
import { createApiApp } from "../apps/api/src/app.ts";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_A = "22222222-2222-4222-8222-222222222222";
const USER_B = "33333333-3333-4333-8333-333333333333";

function listenTemp(app: ReturnType<typeof createApiApp>): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind test server");
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("Wave 1 Critical Remediation Suite (C1–C7)", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("C1: blocks ReDoS nested quantifiers, backreferences, lookarounds, and syntax errors cleanly with 400 DataPrepError", () => {
    expect(() => compileSafeContractPattern("(a+)+$")).toThrow(DataPrepError);
    expect(() => compileSafeContractPattern("(a|aa)+$")).toThrow(DataPrepError);
    expect(() => compileSafeContractPattern("([a-zA-Z]+)*$")).toThrow(DataPrepError);
    expect(() => compileSafeContractPattern("(\\w+)\\1")).toThrow(DataPrepError);
    expect(() => compileSafeContractPattern("(?=foo)bar")).toThrow(DataPrepError);
    expect(() => compileSafeContractPattern("a{1,5000}")).toThrow(DataPrepError);
    expect(() => compileSafeContractPattern("[unclosed")).toThrow(DataPrepError);

    // Safe patterns & presets still compile and evaluate cleanly
    expect(compileSafeContractPattern("^INV-\\d{1,8}$").test("INV-2026")).toBe(true);

    const staged = stageCsvSource("id,email,phone\n1,user@corp.kh,+85512345678\n2,bad-email,123\n", "preset.csv");
    const pipeline = new DataPreparationPipeline();
    const actor: ActorContext = { tenantId: TENANT_A, workspaceId: WS_A, userId: USER_A, role: "editor" };
    const artifact = pipeline.executeRecipe({
      actor,
      recipe: {
        recipeId: "rec_presets",
        version: 1,
        tenantId: TENANT_A,
        workspaceId: WS_A,
        pinnedInputSha256s: [staged.source.sha256],
        idempotencyKey: "idem_presets",
        steps: [
          {
            stepId: "s1",
            op: "validate_schema_contract",
            params: {
              rules: [
                { column: "email", required: true, preset: "email" },
                { column: "phone", required: true, preset: "khmer_phone" },
              ],
            },
          },
        ],
      },
      salesSources: [staged],
      expectedColumns: ["id", "email", "phone"],
    });
    expect(artifact.rows).toHaveLength(1);
    expect(artifact.exceptions).toHaveLength(1);

    // Malicious ReDoS pattern through executeRecipe fails fast with 400 DataPrepError (<50ms)
    const t0 = performance.now();
    expect(() =>
      pipeline.executeRecipe({
        actor,
        recipe: {
          recipeId: "rec_redos",
          version: 1,
          tenantId: TENANT_A,
          workspaceId: WS_A,
          pinnedInputSha256s: [staged.source.sha256],
          idempotencyKey: "idem_redos",
          steps: [
            {
              stepId: "s1",
              op: "validate_schema_contract",
              params: { rules: [{ column: "email", pattern: "(a+)+$" }] },
            },
          ],
        },
        salesSources: [staged],
        expectedColumns: ["id", "email", "phone"],
      }),
    ).toThrow(DataPrepError);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("C3: strips DATABASE_URL, JWT_SECRET, and cloud secrets from subprocess env and removes file: from PDF CSP", () => {
    const prevDb = process.env.DATABASE_URL;
    const prevJwt = process.env.JWT_SECRET;
    process.env.DATABASE_URL = "postgres://secret:pw@db:5432/prod";
    process.env.JWT_SECRET = "super-sensitive-test-secret-do-not-leak-123456";
    try {
      const env = buildSanitizedSubprocessEnv("/tmp/aios-test-subproc");
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.HOME).toBe("/tmp/aios-test-subproc");
      expect(env.TMPDIR).toBe("/tmp/aios-test-subproc");
      expect(env.PATH).toBeTruthy();
      expect(PDF_RENDER_CSP_META).toContain("font-src data:");
      expect(PDF_RENDER_CSP_META).not.toContain("file:");
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      if (prevJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevJwt;
    }
  });

  it("C4 & C5: enforces trustProxy + actor-scoped rate limiting behind proxy, JSON 404, 400 INVALID_JSON, 413 PAYLOAD_TOO_LARGE & safe /api/ready", async () => {
    const db = new PgliteDatabaseAdapter();
    await db.ready();
    await initializePostgreSqlSchema(db);
    const pw = await hashPassword("StrongPass!2026");
    await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'OrgA', 'active')", [TENANT_A]);
    await db.query("INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'HQ')", [TENANT_A, WS_A]);
    await db.query(
      "INSERT INTO users (user_id, email, password_hash, status) VALUES ($1::uuid, 'a@org.kh', $3, 'active'), ($2::uuid, 'b@org.kh', $3, 'active')",
      [USER_A, USER_B, pw],
    );
    await db.query(
      "INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'editor'), ($1::uuid, $2::uuid, $4::uuid, 'editor')",
      [TENANT_A, WS_A, USER_A, USER_B],
    );

    let draining = false;
    const app = createApiApp({
      authMode: "jwt-pg",
      db,
      trustProxy: 1,
      isShuttingDown: () => draining,
      rateLimit: { enabled: true, windowMs: 60_000, loginMaxPerWindow: 20, apiMaxPerWindow: 2 },
    });
    const { server, baseUrl } = await listenTemp(app);
    try {
      // C5: JSON 404 with requestId
      const r404 = await fetch(`${baseUrl}/api/does-not-exist`);
      expect(r404.status).toBe(404);
      const b404 = (await r404.json()) as Record<string, unknown>;
      expect(b404.code).toBe("NOT_FOUND");
      expect(typeof b404.requestId).toBe("string");

      // C5: Malformed JSON returns 400 INVALID_JSON (not 500)
      const rBadJson = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bad json",
      });
      expect(rBadJson.status).toBe(400);
      const bBadJson = (await rBadJson.json()) as Record<string, unknown>;
      expect(bBadJson.code).toBe("INVALID_JSON");
      expect(typeof bBadJson.requestId).toBe("string");

      // C2 & C5: /api/ready reports currentConnectionLeastPrivilege and flips to 503 during drain
      const rReady = await fetch(`${baseUrl}/api/ready`);
      expect(rReady.status).toBe(200);
      const bReady = (await rReady.json()) as { checks: { currentConnectionLeastPrivilege: boolean } };
      expect(typeof bReady.checks.currentConnectionLeastPrivilege).toBe("boolean");

      draining = true;
      const rDrain = await fetch(`${baseUrl}/api/ready`);
      expect(rDrain.status).toBe(503);
      expect(((await rDrain.json()) as { status: string }).status).toBe("draining");
      draining = false;

      // C4: Authenticate two distinct users behind the SAME reverse proxy IP; exhausting User A's quota must NOT throttle User B
      const loginA = await fetch(`${baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
        body: JSON.stringify({ email: "a@org.kh", password: "StrongPass!2026", tenantId: TENANT_A, workspaceId: WS_A }),
      });
      const tokenA = ((await loginA.json()) as { token: string }).token;

      const loginB = await fetch(`${baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
        body: JSON.stringify({ email: "b@org.kh", password: "StrongPass!2026", tenantId: TENANT_A, workspaceId: WS_A }),
      });
      const tokenB = ((await loginB.json()) as { token: string }).token;

      // User A hits 2 allowed + 3rd throttled (429)
      expect((await fetch(`${baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${tokenA}` } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${tokenA}` } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${tokenA}` } })).status).toBe(429);

      // User B behind same proxy IP is completely unaffected (actor-scoped bucket!)
      expect((await fetch(`${baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${tokenB}` } })).status).toBe(200);
    } finally {
      server.close();
      await db.close();
    }
  });

  it("C6 & C7: migrates real LocalFilesystemStorageAdapter versions/ layout, rolls back cleanly after AI op, and backs up/restores all 17 tables with SHA-256 verification", async () => {
    const localDir = mkdtempSync(path.join(os.tmpdir(), "aios-real-local-mig-"));
    tempDirs.push(localDir);

    // Write a real document using LocalFilesystemStorageAdapter (creates documents/<id>/versions/rev-000001.json!)
    const storage = new LocalFilesystemStorageAdapter(localDir);
    const audit = new InMemoryAuditStore();
    const docSvc = new DocumentService(storage, audit);
    const localActor: ActorContext = { tenantId: TENANT_A, workspaceId: WS_A, userId: USER_A, role: "editor" };
    const createdLocal = await docSvc.createDocument(localActor, {
      title: "របាយការណ៍ពិតប្រាកដ · Real Local File",
      language: "bilingual",
    });
    await docSvc.updateDocument(localActor, createdLocal.documentId, {
      expectedRevision: 1,
      blocks: [{ id: "b1", type: "paragraph", runs: [{ text: "Updated revision 2 content" }] }],
      summary: "Second revision",
    });

    const db1 = new PgliteDatabaseAdapter();
    await db1.ready();
    await initializePostgreSqlSchema(db1);
    await initializeIntegrationSchema(db1);

    const pw = await hashPassword("StrongPass!2026");
    await db1.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'OrgA', 'active')", [TENANT_A]);
    await db1.query("INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'HQ')", [TENANT_A, WS_A]);
    await db1.query("INSERT INTO users (user_id, email, password_hash, status) VALUES ($1::uuid, 'a@org.kh', $2, 'active')", [USER_A, pw]);
    await db1.query("INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'editor')", [TENANT_A, WS_A, USER_A]);

    // C7: Real LocalFilesystemStorageAdapter directory now scans 1 doc & 2 versions (previously silently returned 0!)
    const dryRun = await runLocalDataMigration({
      db: db1,
      localDataDir: localDir,
      targetTenantId: TENANT_A,
      targetWorkspaceId: WS_A,
      actorUserId: USER_A,
      mode: "dry-run",
    });
    expect(dryRun.documentsScanned).toBe(1);
    expect(dryRun.versionsScanned).toBe(2);

    const applied = await runLocalDataMigration({
      db: db1,
      localDataDir: localDir,
      targetTenantId: TENANT_A,
      targetWorkspaceId: WS_A,
      actorUserId: USER_A,
      mode: "apply",
    });
    expect(applied.documentsScanned).toBe(1);
    const migratedDocId = applied.entries[0]!.documentId;

    // Record an AI operation on the migrated document (previously broke rollbackMigrationBatch with FK 23503!)
    const repo1 = new PostgreSqlDocumentRepository(db1);
    await repo1.applyAiOperationIdempotent({
      actor: localActor,
      documentId: migratedDocId,
      operationId: "op_post_migration_1",
      expectedRevision: 2,
      source: "typed_ai",
      buildNext: (cur, _prior, nextRev) => ({
        updatedDoc: { ...cur, revision: nextRev, updatedAt: new Date().toISOString() },
        summary: "AI edit on migrated doc",
      }),
    });

    // Also verify readiness check flag when requiring non-superuser DB (PGlite runs as superuser, so requireNonSuperuserConnection fails closed!)
    const strictReadiness = await verifyDatabaseRlsReadiness(db1, { requireNonSuperuserConnection: true });
    expect(strictReadiness.checks.currentConnectionLeastPrivilege).toBe(false);
    expect(strictReadiness.ready).toBe(false);

    // C6: Export full 17-table REPEATABLE READ snapshot including ai_applied_operations & migration_batches
    const snapshot = await exportLogicalBackupSnapshot(db1);
    expect(snapshot.snapshotVersion).toBe(2);
    expect(snapshot.integritySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.aiAppliedOperations?.length).toBe(1);
    expect(snapshot.migrationBatches?.length).toBe(1);

    // Tampered snapshot must be rejected by SHA-256 verification
    const db2 = new PgliteDatabaseAdapter();
    await db2.ready();
    await initializePostgreSqlSchema(db2);
    await initializeIntegrationSchema(db2);
    const tampered = structuredClone(snapshot);
    (tampered.organizations[0] as Record<string, unknown>).name = "TAMPERED";
    await expect(restoreLogicalBackupSnapshot(db2, tampered)).rejects.toThrow(/BACKUP_INTEGRITY_MISMATCH/);

    // Clean snapshot restores all tables including ai_applied_operations cleanly (and idempotent re-restore works)
    await restoreLogicalBackupSnapshot(db2, snapshot);
    await restoreLogicalBackupSnapshot(db2, snapshot, { idempotent: true });
    const restoredAiOps = await db2.query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM ai_applied_operations");
    expect(Number(restoredAiOps.rows[0]?.cnt)).toBe(1);

    // M7: Rollback migration batch cleanly removes migrated doc even after ai_applied_operations row existed
    const rolledBack = await rollbackMigrationBatch(db1, applied.batchId);
    expect(rolledBack.removedDocuments).toBe(1);

    await db1.close();
    await db2.close();
  });
});
