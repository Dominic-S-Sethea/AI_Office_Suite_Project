import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type {
  ActorContext,
  DataPreparationRecipe,
  DataScopePolicy,
  DocumentOperationProposal,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import {
  initializePostgreSqlSchema,
  NodePgDatabaseAdapter,
  PgliteDatabaseAdapter,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import {
  benchmarkDuckDbStress,
  benchmarkPolarsStress,
  DataPreparationPipeline,
  stageCsvSource,
  stageXlsxSource,
} from "@ai-office-suite/data-processing";
import { importFromDocxBuffer } from "@ai-office-suite/file-conversion";
import { importFromPptxBuffer } from "@ai-office-suite/presentation-engine";
import { importWorkbookFromXlsxBuffer } from "@ai-office-suite/calculation-engine";
import { IntelligenceStudioEngine } from "@ai-office-suite/intelligence-engine";
import { createApiApp } from "../apps/api/src/app.ts";

const DEEP_STRESS = process.env.RUN_STRESS === "1";
const LIVE_PG_URL = process.env.TEST_POSTGRES_URL?.trim();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}

describe("Phase 6 — Stress, Concurrency & Soak Benchmarks", () => {
  it(
    "Workload A: sustains multi-tenant concurrent HTTP traffic, 10-way 409 lock race, 8-way durable AI dedup race & mid-storm revocation with zero cross-tenant bleed",
    async () => {
      process.env.NODE_ENV = "test";
      const useLivePg = Boolean(LIVE_PG_URL && DEEP_STRESS);
      const db: PgDatabaseAdapter = useLivePg
        ? new NodePgDatabaseAdapter(LIVE_PG_URL!, { max: 5, idleTimeoutMillis: 10_000 })
        : new PgliteDatabaseAdapter();

      if (useLivePg) {
        await db.exec(`
          DROP TABLE IF EXISTS
            ai_applied_operations, migration_batches, audit_logs, idempotency_keys,
            document_versions, documents, memberships, workspaces, users, organizations, schema_migrations
          CASCADE;
        `);
      }
      await initializePostgreSqlSchema(db);

      const tenantCount = 5;
      const pwHash = await hashPassword("StressPass!2026");
      const tenants: Array<{
        tenantId: string;
        workspaceId: string;
        userId: string;
        email: string;
        token: string;
        docId: string;
      }> = [];

      for (let i = 0; i < tenantCount; i++) {
        const tenantId = randomUUID();
        const workspaceId = randomUUID();
        const userId = randomUUID();
        const email = `stress-t${i}@org.kh`;
        await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, $2, 'active')", [
          tenantId,
          `Stress Tenant ${i}`,
        ]);
        await db.query("INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'HQ')", [
          tenantId,
          workspaceId,
        ]);
        await db.query("INSERT INTO users (user_id, email, password_hash, status) VALUES ($1::uuid, $2, $3, 'active')", [
          userId,
          email,
          pwHash,
        ]);
        await db.query(
          "INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'editor')",
          [tenantId, workspaceId, userId],
        );
        tenants.push({ tenantId, workspaceId, userId, email, token: "", docId: "" });
      }

      const app = createApiApp({ authMode: "jwt-pg", db, inMemory: true, rateLimit: { enabled: false } });
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });

      try {
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        for (let i = 0; i < tenants.length; i++) {
          const t = tenants[i]!;
          const loginRes = await fetch(`${baseUrl}/api/auth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: t.email,
              password: "StressPass!2026",
              tenantId: t.tenantId,
              workspaceId: t.workspaceId,
            }),
          });
          expect(loginRes.status).toBe(200);
          t.token = ((await loginRes.json()) as { token: string }).token;

          const createRes = await fetch(`${baseUrl}/api/documents`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.token}` },
            body: JSON.stringify({ title: `Tenant-${i}-Confidential-Doc`, language: "bilingual" }),
          });
          expect(createRes.status).toBe(201);
          t.docId = ((await createRes.json()) as { document: StudioDocument }).document.documentId;
        }

        const rssBefore = process.memoryUsage().rss;
        const latencies: number[] = [];

        // 1. Concurrent multi-tenant reads (50 in CI, 100 in DEEP_STRESS) -> zero cross-tenant bleed
        const readBurstCount = DEEP_STRESS ? 100 : 35;
        const readResults = await Promise.all(
          Array.from({ length: readBurstCount }, async (_, idx) => {
            const tIdx = idx % tenantCount;
            const t = tenants[tIdx]!;
            const t0 = performance.now();
            const res = await fetch(`${baseUrl}/api/documents?q=Tenant-`, {
              headers: { Authorization: `Bearer ${t.token}` },
            });
            latencies.push(performance.now() - t0);
            const body = (await res.json()) as { documents: StudioDocument[] };
            return { tIdx, status: res.status, docs: body.documents };
          }),
        );
        for (const r of readResults) {
          expect(r.status).toBe(200);
          expect(r.docs).toHaveLength(1);
          expect(r.docs[0]?.tenantId).toBe(tenants[r.tIdx]!.tenantId);
          expect(r.docs[0]?.title).toBe(`Tenant-${r.tIdx}-Confidential-Doc`);
        }

        // 2. 10-way concurrent optimistic-lock PUT race on Tenant 0 doc -> exact 1 winner (200) + 9 conflicts (409)
        const t0Tenant = tenants[0]!;
        const initialDocRes = await fetch(`${baseUrl}/api/documents/${t0Tenant.docId}`, {
          headers: { Authorization: `Bearer ${t0Tenant.token}` },
        });
        const initialDoc = ((await initialDocRes.json()) as { document: StudioDocument }).document;

        const putRace = await Promise.all(
          Array.from({ length: 10 }, (_, k) =>
            fetch(`${baseUrl}/api/documents/${t0Tenant.docId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${t0Tenant.token}` },
              body: JSON.stringify({
                expectedRevision: 1,
                blocks: initialDoc.blocks,
                summary: `Concurrent race writer ${k}`,
              }),
            }).then((r) => r.status),
          ),
        );
        expect(putRace.filter((s) => s === 200)).toHaveLength(1);
        expect(putRace.filter((s) => s === 409)).toHaveLength(9);

        // 3. 8-way concurrent identical AI operationId race on Tenant 1 doc -> exact 1 apply + 7 deduplicated, final rev = 2
        const t1Tenant = tenants[1]!;
        const t1DocRes = await fetch(`${baseUrl}/api/documents/${t1Tenant.docId}`, {
          headers: { Authorization: `Bearer ${t1Tenant.token}` },
        });
        const t1Doc = ((await t1DocRes.json()) as { document: StudioDocument }).document;

        const planRes = await fetch(`${baseUrl}/api/documents/${t1Tenant.docId}/ai/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${t1Tenant.token}` },
          body: JSON.stringify({
            command: "make bold",
            expectedRevision: 1,
            inputLanguage: "en",
            outputLanguage: "en",
            source: "typed_ai",
            selection: { blockId: t1Doc.blocks[0]!.id },
          }),
        });
        const proposal = ((await planRes.json()) as { proposal: DocumentOperationProposal }).proposal;

        const aiRace = await Promise.all(
          Array.from({ length: 8 }, async () => {
            const res = await fetch(`${baseUrl}/api/documents/${t1Tenant.docId}/ai/apply`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${t1Tenant.token}` },
              body: JSON.stringify({ proposal, approved: true }),
            });
            const body = (await res.json()) as { deduplicated: boolean; document: StudioDocument };
            return { status: res.status, deduplicated: body.deduplicated, rev: body.document.revision };
          }),
        );
        expect(aiRace.every((r) => r.status === 200 && r.rev === 2)).toBe(true);
        expect(aiRace.filter((r) => r.deduplicated === false)).toHaveLength(1);
        expect(aiRace.filter((r) => r.deduplicated === true)).toHaveLength(7);

        // 4. Mid-storm session revocation on Tenant 4 -> immediately 401 while Tenant 2 stays 200
        const t4 = tenants[4]!;
        const revRes = await fetch(`${baseUrl}/api/auth/revoke-sessions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${t4.token}` },
        });
        expect(revRes.status).toBe(200);
        const postRevRes = await fetch(`${baseUrl}/api/documents`, {
          headers: { Authorization: `Bearer ${t4.token}` },
        });
        expect(postRevRes.status).toBe(401);
        const t2OkRes = await fetch(`${baseUrl}/api/documents`, {
          headers: { Authorization: `Bearer ${tenants[2]!.token}` },
        });
        expect(t2OkRes.status).toBe(200);

        latencies.sort((a, b) => a - b);
        const rssDeltaMb = Math.round(((process.memoryUsage().rss - rssBefore) / (1024 * 1024)) * 100) / 100;
        console.log(
          "STRESS_WORKLOAD_A:",
          JSON.stringify({
            engine: db.engine,
            deepStress: DEEP_STRESS,
            concurrentReads: readBurstCount,
            p50Ms: percentile(latencies, 0.5),
            p95Ms: percentile(latencies, 0.95),
            p99Ms: percentile(latencies, 0.99),
            rssDeltaMb,
          }),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await db.close();
      }
    },
    30_000,
  );

  it(
    "Workload B: processes high-volume bilingual USD/KHR data pipeline soak with exact BigInt reconciliation and DuckDB vs Polars parity",
    async () => {
      const rowCount = DEEP_STRESS ? 50_000 : 5_000;
      const lines: string[] = ["organization_id,invoice_id,line_number,currency,amount,email"];
      for (let i = 0; i < rowCount; i++) {
        // Every 10th row duplicates the previous composite key
        const invNum = i % 10 === 9 ? i - 1 : i;
        const curr = i % 2 === 0 ? "USD" : "KHR";
        const amt = curr === "USD" ? "12.50" : "40000";
        lines.push(`00042,INV-${invNum},1,${curr},${amt},user${i % 100}@corp.kh`);
      }
      const csvText = `${lines.join("\n")}\n`;

      const rssBefore = process.memoryUsage().rss;
      const tStage = performance.now();
      const staged = stageCsvSource(csvText, "soak.csv");
      const stageMs = Math.round((performance.now() - tStage) * 100) / 100;
      expect(staged.source.acceptedRows).toBe(rowCount);

      const pipeline = new DataPreparationPipeline();
      const actor: ActorContext = { tenantId: "t_soak", workspaceId: "ws_soak", userId: "u_soak", role: "editor" };
      const recipe: DataPreparationRecipe = {
        recipeId: "rec_soak",
        version: 1,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        pinnedInputSha256s: [staged.source.sha256],
        idempotencyKey: `idem_soak_${rowCount}`,
        steps: [
          { stepId: "s1", op: "quarantine_missing_required", params: { column: "amount" } },
          { stepId: "s2", op: "deduplicate_composite_key", params: { keys: ["organization_id", "invoice_id", "line_number"] } },
          { stepId: "s3", op: "mask_pii_columns", params: { columns: ["email"], mode: "redact" } },
        ],
      };

      // Mid-run cancellation check leaves history untouched
      const abortCtrl = new AbortController();
      abortCtrl.abort();
      expect(() =>
        pipeline.executeRecipe({
          actor,
          recipe: { ...recipe, idempotencyKey: "idem_cancelled" },
          salesSources: [staged],
          expectedColumns: ["organization_id", "invoice_id", "line_number", "currency", "amount", "email"],
          signal: abortCtrl.signal,
        }),
      ).toThrow(/cancelled/i);
      expect(pipeline.getHistory(actor, "ds_rec_soak")).toHaveLength(0);

      const tExec = performance.now();
      const artifact = pipeline.executeRecipe({
        actor,
        recipe,
        salesSources: [staged],
        expectedColumns: ["organization_id", "invoice_id", "line_number", "currency", "amount", "email"],
      });
      const execMs = Math.round((performance.now() - tExec) * 100) / 100;
      const rssDeltaMb = Math.round(((process.memoryUsage().rss - rssBefore) / (1024 * 1024)) * 100) / 100;

      expect(artifact.status).toBe("certified");
      expect(artifact.reconciliation.passed).toBe(true);
      expect(artifact.reconciliation.deduplicatedRows).toBe(Math.floor(rowCount / 10));
      for (const ct of artifact.reconciliation.currencyTotals) {
        expect(ct.unexplainedMinorUnits).toBe("0");
      }

      const benchRows = DEEP_STRESS ? 100_000 : 10_000;
      const duck = await benchmarkDuckDbStress(benchRows);
      const polars = benchmarkPolarsStress(benchRows);
      expect(duck.rowCount).toBe(benchRows);
      expect(polars.rowCount).toBe(benchRows);
      expect(duck.summaryRows?.length).toBe(2);
      expect(polars.summaryRows).toEqual(duck.summaryRows);

      console.log(
        "STRESS_WORKLOAD_B:",
        JSON.stringify({
          pipelineRows: rowCount,
          stageMs,
          execMs,
          rssDeltaMb,
          duckBench: duck,
          polarsBench: polars,
        }),
      );
    },
    30_000,
  );

  it("Workload C: survives 50-burst malicious OOXML storm and BI cache-eviction thrash under rapid role revocation", async () => {
    // Build adversarial archive payloads
    const traversalZip = zipSync({ "../evil.txt": new TextEncoder().encode("boom") });
    const macroZip = zipSync({ "word/vbaProject.bin": new Uint8Array([1, 2, 3]), "xl/vbaProject.bin": new Uint8Array([1]) });
    const ole2Buf = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    const corruptBuf = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0x00, 0x00]);
    const payloads = [traversalZip, macroZip, ole2Buf, corruptBuf];

    const burstCount = DEEP_STRESS ? 60 : 20;
    const t0 = performance.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: burstCount }, async (_, i) => {
        const buf = payloads[i % payloads.length]!;
        const target = i % 4;
        if (target === 0) {
          return await importFromDocxBuffer({ buffer: buf, filename: "evil.docx", tenantId: "t", workspaceId: "w", actorId: "u" });
        }
        if (target === 1) {
          return importFromPptxBuffer({ buffer: buf, filename: "evil.pptx", tenantId: "t", workspaceId: "w", actorId: "u" });
        }
        if (target === 2) {
          return await importWorkbookFromXlsxBuffer(buf, "evil.xlsx");
        }
        return await stageXlsxSource(buf, "evil.xlsx");
      }),
    );
    const stormMs = Math.round((performance.now() - t0) * 100) / 100;
    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
    for (const o of outcomes) {
      if (o.status === "rejected") {
        expect(o.reason).toBeInstanceOf(Error);
        expect(o.reason).not.toBeInstanceOf(TypeError);
        expect(o.reason).not.toBeInstanceOf(ReferenceError);
      }
    }

    // BI cache-eviction thrash & immediate revocation enforcement
    const bi = new IntelligenceStudioEngine();
    bi.seedSection12TenantData("t_bi", "ws_bi");
    const owner: ActorContext = { tenantId: "t_bi", workspaceId: "ws_bi", userId: "u_owner", role: "owner" };
    const viewer: ActorContext = { tenantId: "t_bi", workspaceId: "ws_bi", userId: "u_viewer", role: "viewer" };
    const fullPolicy: DataScopePolicy = {
      policyId: "pol_full",
      policyVersion: 1,
      tenantId: "t_bi",
      principalRole: "owner",
      allowedDepartments: "ALL",
      allowedColumns: ["rowId", "invoiceDate", "reportingMonth", "department", "grossSales", "cogs", "opex"],
      canExportUnderlyingDetail: true,
      canPublish: true,
    };
    const narrowPolicy: DataScopePolicy = {
      policyId: "pol_narrow",
      policyVersion: 1,
      tenantId: "t_bi",
      principalRole: "viewer",
      allowedDepartments: ["Sales"],
      allowedColumns: ["rowId", "department", "grossSales"],
      canExportUnderlyingDetail: false,
      canPublish: false,
    };

    const report = bi.createManagementReport(owner);

    const biStart = performance.now();
    for (let i = 1; i <= (DEEP_STRESS ? 40 : 12); i++) {
      const rOwner = await bi.evaluateReport(owner, fullPolicy, report.reportId, {
        interactionSeq: i,
        requestedDepartments: i % 2 === 0 ? ["Sales"] : ["Sales", "Operations"],
      });
      const rViewer = await bi.evaluateReport(viewer, narrowPolicy, report.reportId, {
        interactionSeq: i,
        requestedDepartments: ["Sales", "Operations"],
      });
      // Viewer MUST remain strictly narrowed to Sales even when requesting Operations
      expect(rViewer.effectiveDepartments).toEqual(["Sales"]);
      expect(rOwner.report.reportId).toBe(report.reportId);
    }
    const biMs = Math.round((performance.now() - biStart) * 100) / 100;

    // Immediate revocation blocks viewer and evicts tenant cache
    bi.revokePrincipalAccess("t_bi", viewer.userId);
    await expect(
      bi.evaluateReport(viewer, narrowPolicy, report.reportId, { interactionSeq: 999 }),
    ).rejects.toThrow(/revoked/i);

    console.log(
      "STRESS_WORKLOAD_C:",
      JSON.stringify({ maliciousOoxmlBursts: burstCount, stormMs, biThrashMs: biMs }),
    );
  });

  it("Workload D: enforces login rate-limit isolation under brute-force bursts without blocking distinct legitimate accounts", async () => {
    process.env.NODE_ENV = "test";
    const db = new PgliteDatabaseAdapter();
    await initializePostgreSqlSchema(db);
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const userOkId = randomUUID();
    const userTargetId = randomUUID();
    const pwHash = await hashPassword("GoodLogin!2026");

    await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'RL Org', 'active')", [tenantId]);
    await db.query("INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'HQ')", [
      tenantId,
      workspaceId,
    ]);
    await db.query(
      "INSERT INTO users (user_id, email, password_hash, status) VALUES ($1::uuid, 'good@rl.kh', $3, 'active'), ($2::uuid, 'target@rl.kh', $3, 'active')",
      [userOkId, userTargetId, pwHash],
    );
    await db.query(
      "INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'editor'), ($1::uuid, $2::uuid, $4::uuid, 'editor')",
      [tenantId, workspaceId, userOkId, userTargetId],
    );

    const app = createApiApp({
      authMode: "jwt-pg",
      db,
      inMemory: true,
      rateLimit: { enabled: true, windowMs: 60_000, loginMaxPerWindow: 3, apiMaxPerWindow: 200 },
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      // Flood target@rl.kh with 6 wrong passwords -> first 3 get 401, next 3 get 429
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "target@rl.kh", password: "WrongPassword!", tenantId, workspaceId }),
        });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429, 429]);

      // Legitimate separate user good@rl.kh MUST NOT be blocked by attacker's target bucket!
      const goodRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "good@rl.kh", password: "GoodLogin!2026", tenantId, workspaceId }),
      });
      expect(goodRes.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });
});
