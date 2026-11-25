import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { DocumentOperationProposal, StudioDocument } from "@ai-office-suite/shared-contracts";
import { initializePostgreSqlSchema, PgliteDatabaseAdapter, withTenantTransaction } from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import { createApiApp } from "../apps/api/src/app.ts";

describe("Phase 4 — Production Runtime Durability, Readiness Probe, Metrics RBAC & Redacted Logging", () => {
  it("verifies /api/ready RLS checks, /api/metrics RBAC, X-Request-Id + secret-redacted logs, and crash-safe durable AI idempotency across API restarts", async () => {
    process.env.NODE_ENV = "test";

    // Uninitialized DB reports 503 degraded on /api/ready
    const uninitDb = new PgliteDatabaseAdapter();
    const uninitApp = createApiApp({ authMode: "jwt-pg", db: uninitDb, inMemory: true, rateLimit: { enabled: false } });
    const uninitServer: Server = await new Promise((resolve) => {
      const s = uninitApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const url = `http://127.0.0.1:${(uninitServer.address() as AddressInfo).port}`;
      const degradedRes = await fetch(`${url}/api/ready`);
      expect(degradedRes.status).toBe(503);
      const body = (await degradedRes.json()) as { status: string; checks: { coreForceRlsEnabled: boolean } };
      expect(body.status).toBe("degraded");
      expect(body.checks.coreForceRlsEnabled).toBe(false);
    } finally {
      await new Promise<void>((resolve) => uninitServer.close(() => resolve()));
      await uninitDb.close();
    }

    // Initialized DB
    const db = new PgliteDatabaseAdapter();
    await initializePostgreSqlSchema(db);

    const tenantId = "10101010-1111-4111-8111-111111111111";
    const workspaceId = "20202020-2222-4222-8222-222222222222";
    const ownerId = "30303030-3333-4333-8333-333333333333";
    const editorId = "40404040-4444-4444-8444-444444444444";
    const pwHash = await hashPassword("RuntimePass!2026");

    await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1, 'Runtime Corp', 'active')", [tenantId]);
    await db.query("INSERT INTO workspaces (workspace_id, tenant_id, name) VALUES ($1, $2, 'HQ')", [workspaceId, tenantId]);
    await db.query(
      "INSERT INTO users (user_id, email, password_hash, status) VALUES ($1, 'owner@rt.kh', $3, 'active'), ($2, 'editor@rt.kh', $3, 'active')",
      [ownerId, editorId, pwHash],
    );
    await db.query(
      "INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'owner'), ($1, $2, $4, 'editor')",
      [tenantId, workspaceId, ownerId, editorId],
    );

    const capturedLogs: string[] = [];
    const app1 = createApiApp({
      authMode: "jwt-pg",
      db,
      inMemory: true,
      enableStructuredLogs: true,
      logSink: (line) => capturedLogs.push(line),
      rateLimit: { enabled: false },
    });

    const server1: Server = await new Promise((resolve) => {
      const s = app1.listen(0, "127.0.0.1", () => resolve(s));
    });

    let docId = "";
    let editorToken = "";
    let ownerToken = "";
    let proposal!: DocumentOperationProposal;

    try {
      const url1 = `http://127.0.0.1:${(server1.address() as AddressInfo).port}`;

      // /api/ready passes all RLS checks & echoes safe X-Request-Id
      const readyRes = await fetch(`${url1}/api/ready`, {
        headers: { "X-Request-Id": "req-phase4-check-01" },
      });
      expect(readyRes.status).toBe(200);
      expect(readyRes.headers.get("x-request-id")).toBe("req-phase4-check-01");
      const readyBody = (await readyRes.json()) as {
        status: string;
        checks: { connectivity: boolean; appRuntimeLeastPrivilege: boolean; coreForceRlsEnabled: boolean; missingForceRlsTables: string[] };
      };
      expect(readyBody.status).toBe("ready");
      expect(readyBody.checks.connectivity).toBe(true);
      expect(readyBody.checks.appRuntimeLeastPrivilege).toBe(true);
      expect(readyBody.checks.coreForceRlsEnabled).toBe(true);
      expect(readyBody.checks.missingForceRlsTables).toEqual([]);

      // Unsafe inbound X-Request-Id replaced with clean UUID
      const unsafeIdRes = await fetch(`${url1}/api/health`, {
        headers: { "X-Request-Id": "bad<script>id" },
      });
      expect(unsafeIdRes.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);

      // Login as owner and editor
      const login = async (email: string): Promise<string> => {
        const res = await fetch(`${url1}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "RuntimePass!2026", tenantId, workspaceId }),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { token: string }).token;
      };
      ownerToken = await login("owner@rt.kh");
      editorToken = await login("editor@rt.kh");

      // /api/metrics RBAC: unauth -> 401, editor -> 403, owner -> 200
      expect((await fetch(`${url1}/api/metrics`)).status).toBe(401);
      expect(
        (await fetch(`${url1}/api/metrics`, { headers: { Authorization: `Bearer ${editorToken}` } })).status,
      ).toBe(403);
      const metricsRes = await fetch(`${url1}/api/metrics`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      expect(metricsRes.status).toBe(200);
      const metricsBody = (await metricsRes.json()) as {
        metrics: { requestsTotal: number; statusClasses: { "2xx": number }; latencyMs: { sampleCount: number } };
      };
      expect(metricsBody.metrics.requestsTotal).toBeGreaterThanOrEqual(4);
      expect(metricsBody.metrics.statusClasses["2xx"]).toBeGreaterThanOrEqual(3);

      // Create document & plan/apply AI op on app1
      const createRes = await fetch(`${url1}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ title: "Durable AI Test", language: "bilingual" }),
      });
      expect(createRes.status).toBe(201);
      const created = ((await createRes.json()) as { document: StudioDocument }).document;
      docId = created.documentId;

      const planRes = await fetch(`${url1}/api/documents/${docId}/ai/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({
          command: "make bold",
          expectedRevision: 1,
          inputLanguage: "en",
          outputLanguage: "en",
          source: "typed_ai",
          selection: { blockId: created.blocks[0]!.id },
        }),
      });
      expect(planRes.status).toBe(200);
      proposal = ((await planRes.json()) as { proposal: DocumentOperationProposal }).proposal;

      const apply1Res = await fetch(`${url1}/api/documents/${docId}/ai/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ proposal, approved: true }),
      });
      expect(apply1Res.status).toBe(200);
      const apply1Body = (await apply1Res.json()) as { document: StudioDocument; deduplicated: boolean };
      expect(apply1Body.deduplicated).toBe(false);
      expect(apply1Body.document.revision).toBe(2);

      // Verify structured logs captured JSON records without leaking passwords or JWT tokens
      expect(capturedLogs.length).toBeGreaterThan(0);
      const joinedLogs = capturedLogs.join("\n");
      expect(joinedLogs).not.toContain("RuntimePass!2026");
      expect(joinedLogs).not.toContain(editorToken);
    } finally {
      await new Promise<void>((resolve) => server1.close(() => resolve()));
    }

    // Simulate full API process restart: spin up fresh app2 pointing at the same database!
    const app2 = createApiApp({ authMode: "jwt-pg", db, inMemory: true, rateLimit: { enabled: false } });
    const server2: Server = await new Promise((resolve) => {
      const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const url2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
      // Replay exact same AI operationId against fresh API instance -> MUST deduplicate from PostgreSQL ledger!
      const replayRes = await fetch(`${url2}/api/documents/${docId}/ai/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ proposal, approved: true }),
      });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as { document: StudioDocument; deduplicated: boolean };
      expect(replayBody.deduplicated).toBe(true);
      expect(replayBody.document.revision).toBe(2);

      // Verify append-only immutability on ai_applied_operations under app_runtime
      await expect(
        withTenantTransaction(db, tenantId, async (tx) => {
          await tx.query("DELETE FROM ai_applied_operations WHERE operation_id = $1", [proposal.operationId]);
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        withTenantTransaction(db, tenantId, async (tx) => {
          await tx.query("UPDATE ai_applied_operations SET result_revision = 99 WHERE operation_id = $1", [
            proposal.operationId,
          ]);
        }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      await db.close();
    }
  });
});
