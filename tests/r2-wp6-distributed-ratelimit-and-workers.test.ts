import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";
import type { ActorContext, SpreadsheetWorkbook, StudioDocument, StudioPresentation } from "@ai-office-suite/shared-contracts";
import { exportWorkbookToXlsxBuffer, WorkbookInteroperabilityError } from "@ai-office-suite/calculation-engine";
import { DataPrepError } from "@ai-office-suite/data-processing";
import {
  PgliteDatabaseAdapter,
  PlatformGovernanceService,
  checkAndIncrementPgRateLimit,
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  pruneExpiredPgRateLimits,
  verifyDatabaseRlsReadiness,
} from "@ai-office-suite/database";
import { getBlockPlainText } from "@ai-office-suite/document-engine";
import {
  DocxImportError,
  PdfExportError,
  detectChromiumBinary,
  exportToDocxBuffer,
} from "@ai-office-suite/file-conversion";
import { hashPassword } from "@ai-office-suite/identity";
import {
  CORPORATE_THEME_V1,
  PptxImportError,
  exportPresentationToPptxBuffer,
} from "@ai-office-suite/presentation-engine";
import {
  IsolatedParserWorkerClient,
  WorkerIsolationError,
  buildSanitizedWorkerEnv,
} from "@ai-office-suite/workers";
import { initializeIntegrationSchema } from "../engines/integration/src/pgPersistence.ts";
import { createApiApp } from "../apps/api/src/app.ts";
import { loadApiServerConfig } from "../apps/api/src/config.ts";
import { createPostgresBackedRateLimiter } from "../apps/api/src/rateLimit.ts";
import { createWorkerHttpServer } from "../apps/workers/src/workerServer.ts";
import { buildBilingualManagementReportFixture } from "./fixtures/bilingual-management-report.ts";

const TENANT_A = "aaaa6666-0000-4000-8000-000000000001";
const WS_A = "aaaa6666-1111-4000-8000-000000000001";
const USER_EDITOR = "00000006-aaaa-4000-8000-000000000001";
const USER_SECOND = "00000006-aaaa-4000-8000-000000000002";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listenExpress(app: { listen: (...args: any[]) => Server }): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function listenRawServer(server: Server): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function seedRateLimitFixture(): Promise<PgliteDatabaseAdapter> {
  const db = new PgliteDatabaseAdapter();
  await initializePostgreSqlSchema(db);
  await initializeIntegrationSchema(db);
  await initializePaGovernanceSchema(db);

  const gov = new PlatformGovernanceService(db);
  await gov.seedDefaultPlans();
  await gov.createOrganization({ tenantId: TENANT_A, name: "RateLimit Test Org" });
  await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A, name: "Main WS", visibility: "standard" });
  await gov.assignTenantSubscription({ tenantId: TENANT_A, planId: "sme_standard", planVersion: 1 });

  const pwHash = await hashPassword("RateLimitPass!2026");
  await db.query(
    `INSERT INTO users (user_id, email, password_hash, status) VALUES
     ($1::uuid, 'rl1@alpha.test', $3, 'active'),
     ($2::uuid, 'rl2@alpha.test', $3, 'active')`,
    [USER_EDITOR, USER_SECOND, pwHash],
  );
  await gov.upsertMembership({
    tenantId: TENANT_A,
    workspaceId: WS_A,
    userId: USER_EDITOR,
    role: "editor",
    contentAccess: true,
  });
  await gov.upsertMembership({
    tenantId: TENANT_A,
    workspaceId: WS_A,
    userId: USER_SECOND,
    role: "editor",
    contentAccess: true,
  });
  return db;
}

describe("R2-WP6 — Distributed PostgreSQL Rate Limiting & Isolated OOXML/PDF Parser Workers", () => {
  it("enforces shared PostgreSQL rate limits across two independent API replicas and isolates api_rate_limits from app_runtime", async () => {
    const db = await seedRateLimitFixture();
    const replicaA = createApiApp({
      authMode: "jwt-pg",
      db,
      inMemory: true,
      rateLimit: {
        enabled: true,
        store: "postgres",
        apiMaxPerWindow: 3,
        loginMaxPerWindow: 3,
        loginIpMaxPerWindow: 20,
        windowMs: 60_000,
      },
    });
    const replicaB = createApiApp({
      authMode: "jwt-pg",
      db,
      inMemory: true,
      rateLimit: {
        enabled: true,
        store: "postgres",
        apiMaxPerWindow: 3,
        loginMaxPerWindow: 3,
        loginIpMaxPerWindow: 20,
        windowMs: 60_000,
      },
    });

    const srvA = await listenExpress(replicaA);
    const srvB = await listenExpress(replicaB);
    try {
      const readiness = await verifyDatabaseRlsReadiness(db);
      expect(readiness.ready).toBe(true);
      expect(readiness.checks.usersPasswordHashIsolated).toBe(true);

      // Direct table read under restricted `app_runtime` MUST fail closed; only SECURITY DEFINER RPC is allowed
      await expect(
        db.withTransaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE app_runtime");
          await tx.query("SELECT * FROM api_rate_limits");
        }),
      ).rejects.toThrow(/permission denied/i);

      // Login attempts for editor #1 & #2 via programmatic token endpoint
      const tokRes1 = await fetch(`${srvA.baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "rl1@alpha.test",
          password: "RateLimitPass!2026",
          tenantId: TENANT_A,
          workspaceId: WS_A,
        }),
      });
      expect(tokRes1.status).toBe(200);
      const token1 = ((await tokRes1.json()) as { token: string }).token;

      const tokRes2 = await fetch(`${srvB.baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "rl2@alpha.test",
          password: "RateLimitPass!2026",
          tenantId: TENANT_A,
          workspaceId: WS_A,
        }),
      });
      expect(tokRes2.status).toBe(200);
      const token2 = ((await tokRes2.json()) as { token: string }).token;

      // Alternate API calls for user #1 across replicaA and replicaB -> shared window limit = 3
      const r1 = await fetch(`${srvA.baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${token1}` } });
      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-ratelimit-store")).toBe("postgres");
      expect(r1.headers.get("x-ratelimit-remaining")).toBe("2");

      const r2 = await fetch(`${srvB.baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${token1}` } });
      expect(r2.status).toBe(200);
      expect(r2.headers.get("x-ratelimit-remaining")).toBe("1");

      const r3 = await fetch(`${srvA.baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${token1}` } });
      expect(r3.status).toBe(200);
      expect(r3.headers.get("x-ratelimit-remaining")).toBe("0");

      const r4 = await fetch(`${srvB.baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${token1}` } });
      expect(r4.status).toBe(429);
      expect(r4.headers.get("retry-after")).toBeTruthy();
      expect(((await r4.json()) as { code: string }).code).toBe("RATE_LIMITED");

      // Separate actor remains unaffected on replicaA while actor #1 is throttled
      const rOther = await fetch(`${srvA.baseUrl}/api/documents`, { headers: { Authorization: `Bearer ${token2}` } });
      expect(rOther.status).toBe(200);

      // Shared login brute-force protection across replicaA & replicaB
      // (`rl2@alpha.test` spent 1 of 3 shared hits on `/api/auth/token`, 2nd on replicaA, 3rd on replicaB -> 4th blocked)
      const failLoginA = await fetch(`${srvA.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "rl2@alpha.test",
          password: "WrongPassword!999",
          tenantId: TENANT_A,
          workspaceId: WS_A,
        }),
      });
      expect(failLoginA.status).toBe(401);

      const failLoginB = await fetch(`${srvB.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "rl2@alpha.test",
          password: "WrongPassword!999",
          tenantId: TENANT_A,
          workspaceId: WS_A,
        }),
      });
      expect(failLoginB.status).toBe(401);

      const blockedLoginA = await fetch(`${srvA.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "rl2@alpha.test",
          password: "RateLimitPass!2026",
          tenantId: TENANT_A,
          workspaceId: WS_A,
        }),
      });
      expect(blockedLoginA.status).toBe(429);

      // Direct prune check on artificially expired bucket
      await db.query(
        `INSERT INTO api_rate_limits (bucket_key, window_start, request_count, expires_at)
         VALUES ('expired:test:bucket', now() - interval '10 minutes', 5, now() - interval '5 minutes')`,
      );
      const pruned = await pruneExpiredPgRateLimits(db, 100);
      expect(pruned).toBeGreaterThanOrEqual(1);

      const firstHit = await checkAndIncrementPgRateLimit(db, "unit:rollover:bucket", 60_000, 1);
      expect(firstHit.allowed).toBe(true);
      const secondHit = await checkAndIncrementPgRateLimit(db, "unit:rollover:bucket", 60_000, 1);
      expect(secondHit.allowed).toBe(false);
    } finally {
      await new Promise<void>((resolve) => srvA.server.close(() => resolve()));
      await new Promise<void>((resolve) => srvB.server.close(() => resolve()));
      await db.close();
    }
  });

  it("falls back safely to bounded local enforcement during transient PostgreSQL rate-limit errors and validates production config defaults", async () => {
    const errors: unknown[] = [];
    const failingDb = {
      engine: "node-pg" as const,
      query: async () => {
        throw new Error("SIMULATED_DB_OUTAGE");
      },
      exec: async () => undefined,
      withTransaction: async () => {
        throw new Error("SIMULATED_DB_OUTAGE");
      },
      close: async () => undefined,
    };
    const limiter = createPostgresBackedRateLimiter({
      db: failingDb,
      windowMs: 60_000,
      maxRequests: 1,
      keyGenerator: () => "fallback:client",
      onBackendError: (err) => errors.push(err),
    });

    const express = (await import("express")).default;
    const testApp = express();
    testApp.use(limiter.middleware);
    testApp.get("/ping", (_req, res) => res.json({ ok: true }));
    const srv = await listenExpress(testApp);
    try {
      const r1 = await fetch(`${srv.baseUrl}/ping`);
      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-ratelimit-store")).toBe("memory-fallback");

      const r2 = await fetch(`${srv.baseUrl}/ping`);
      expect(r2.status).toBe(429);
      expect(errors).toHaveLength(2);
      expect(limiter.getStats().fallbackCount).toBe(2);
    } finally {
      await new Promise<void>((resolve) => srv.server.close(() => resolve()));
    }

    const strongJwt = "prod-jwt-signing-secret-alpha-00001";
    const strongProposal = "prod-ai-proposal-secret-beta-000002";
    const strongPii = "prod-pii-pseudonymization-gamma-03";
    const dbUrl = "postgres://aios_app:StrongAppPass123@127.0.0.1:5432/ai_office";

    const prodCfg = loadApiServerConfig({
      NODE_ENV: "production",
      AUTH_MODE: "jwt-pg",
      DATABASE_URL: dbUrl,
      JWT_SECRET: strongJwt,
      AI_PROPOSAL_SIGNING_SECRET: strongProposal,
      PII_PSEUDONYMIZATION_KEY: strongPii,
    });
    expect(prodCfg.rateLimit.store).toBe("postgres");
    expect(prodCfg.workers.isolatedParsers).toBe(true);
    expect(prodCfg.workers.timeoutMs).toBe(30_000);
    expect(prodCfg.workers.maxOldSpaceMb).toBe(256);

    expect(() =>
      loadApiServerConfig({
        AUTH_MODE: "provisional-local",
        HOST: "127.0.0.1",
        RATE_LIMIT_STORE: "postgres",
      }),
    ).toThrow(/RATE_LIMIT_POSTGRES_REQUIRES_DB/);
    expect(() => loadApiServerConfig({ RATE_LIMIT_STORE: "redis" })).toThrow(/Invalid RATE_LIMIT_STORE/);
    expect(() => loadApiServerConfig({ PARSER_WORKER_URL: "ftp://invalid.host" })).toThrow(
      /Invalid PARSER_WORKER_URL/,
    );
    expect(() => createApiApp({ inMemory: true, rateLimit: { store: "postgres" } })).toThrow(
      /RATE_LIMIT_POSTGRES_REQUIRES_DB/,
    );
  });

  it("isolates OOXML parsing and Chromium PDF rendering in child processes stripped of secrets, enforcing timeouts & crash containment", async () => {
    const dirtyEnv: Record<string, string | undefined> = {
      ...process.env,
      JWT_SECRET: "super_secret_jwt_must_never_leak_into_worker",
      DATABASE_URL: "postgres://aios_app:secret@pg:5432/prod",
      PII_PSEUDONYMIZATION_KEY: "super_secret_pii_hmac_key_must_not_leak",
      AI_PROPOSAL_SIGNING_SECRET: "super_secret_proposal_hmac_must_not_leak",
      POSTGRES_APP_PASSWORD: "secret_db_password",
      CHROMIUM_NO_SANDBOX: process.env.CHROMIUM_NO_SANDBOX,
    };
    const sanitizedEnv = buildSanitizedWorkerEnv(dirtyEnv);
    expect(sanitizedEnv.JWT_SECRET).toBeUndefined();
    expect(sanitizedEnv.DATABASE_URL).toBeUndefined();
    expect(sanitizedEnv.PII_PSEUDONYMIZATION_KEY).toBeUndefined();
    expect(sanitizedEnv.AI_PROPOSAL_SIGNING_SECRET).toBeUndefined();
    expect(sanitizedEnv.POSTGRES_APP_PASSWORD).toBeUndefined();

    const worker = new IsolatedParserWorkerClient({ env: dirtyEnv, timeoutMs: 25_000, maxOldSpaceMb: 256 });
    const probe = await worker.probeIsolation();
    expect(probe.ok).toBe(true);
    expect(probe.pid).not.toBe(process.pid);
    expect(probe.envKeys).not.toContain("JWT_SECRET");
    expect(probe.envKeys).not.toContain("DATABASE_URL");
    expect(probe.envKeys).not.toContain("PII_PSEUDONYMIZATION_KEY");
    expect(probe.envKeys).not.toContain("AI_PROPOSAL_SIGNING_SECRET");
    expect(probe.envKeys).not.toContain("POSTGRES_APP_PASSWORD");

    // 1. Isolated DOCX parsing + macro rejection
    const sampleDoc: StudioDocument = buildBilingualManagementReportFixture();
    const cleanDocx = await exportToDocxBuffer(sampleDoc);
    const parsedDocx = await worker.parseDocx({
      buffer: cleanDocx,
      filename: "worker-bilingual.docx",
      tenantId: sampleDoc.tenantId,
      workspaceId: sampleDoc.workspaceId,
      actorId: "user_worker_test",
    });
    expect(parsedDocx.document.blocks.map(getBlockPlainText).join("\n")).toContain("ព្រះរាជាណាចក្រកម្ពុជា");

    const macroEntries = unzipSync(cleanDocx);
    macroEntries["word/vbaProject.bin"] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
    await expect(
      worker.parseDocx({
        buffer: zipSync(macroEntries),
        filename: "macro.docx",
        tenantId: sampleDoc.tenantId,
        workspaceId: sampleDoc.workspaceId,
        actorId: "user_worker_test",
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof DocxImportError && err.code === "MACRO_CONTENT_BLOCKED");

    // 2. Isolated XLSX parsing & staging
    const wbModel: SpreadsheetWorkbook = {
      workbookId: "wb-worker-1",
      title: "Worker Calc Sheet",
      revision: 1,
      dateSystem: "1900",
      unsupportedFeatures: [],
      sheets: [
        {
          sheetId: "sh_1",
          name: "Data",
          cells: {
            A1: { value: "account_id" },
            B1: { value: "amount_usd" },
            C1: { value: "doubled" },
            A2: { value: "001245" },
            B2: { value: 125.5 },
            C2: { value: null, formula: "=B2*2" },
          },
        },
      ],
    };
    const xlsxBuf = await exportWorkbookToXlsxBuffer(wbModel);
    const parsedXlsx = await worker.parseXlsx(xlsxBuf, "worker.xlsx");
    expect(parsedXlsx.sheets[0]?.cells.A2?.value).toBe("001245");
    expect(parsedXlsx.sheets[0]?.cells.C2?.formula).toBe("=B2*2");

    const stagedXlsx = await worker.stageXlsx(xlsxBuf, "worker.xlsx");
    expect(stagedXlsx.source.acceptedRows).toBe(1);
    expect(stagedXlsx.rows[0]?.account_id).toBe("001245");

    await expect(worker.parseXlsx(new Uint8Array([1, 2, 3, 4]), "bad.xlsx")).rejects.toBeInstanceOf(
      WorkbookInteroperabilityError,
    );
    await expect(worker.stageXlsx(new Uint8Array([1, 2, 3, 4]), "bad.xlsx")).rejects.toBeInstanceOf(DataPrepError);

    // 3. Isolated PPTX parsing
    const actor: ActorContext = {
      tenantId: sampleDoc.tenantId,
      workspaceId: sampleDoc.workspaceId,
      userId: "user_worker_test",
      role: "editor",
    };
    const deck: StudioPresentation = {
      presentationId: "pres_worker_1",
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      title: "Worker Bilingual Deck · របាយការណ៍",
      language: "bilingual",
      revision: 1,
      status: "draft",
      theme: CORPORATE_THEME_V1,
      scopeLabel: "All Departments",
      slides: [
        {
          slideId: "sl_1",
          order: 1,
          layoutId: "title",
          title: "Executive Brief",
          elements: [
            {
              type: "text",
              elementId: "el_title",
              bounds: { xIn: 0.7, yIn: 0.6, wIn: 10, hIn: 1.2 },
              zIndex: 1,
              locked: false,
              altText: "Deck title",
              text: "Executive Brief · របាយការណ៍សង្ខេប",
              fontSizePt: 24,
              bold: true,
            },
          ],
          speakerNotes: "Internal presenter notes",
          readingOrder: ["el_title"],
          sourceRefs: [],
        },
      ],
      createdBy: actor.userId,
      createdAt: "2026-11-29T00:00:00.000Z",
      updatedAt: "2026-11-29T00:00:00.000Z",
    };
    const { buffer: pptxBuf } = await exportPresentationToPptxBuffer(deck);
    const parsedPptx = await worker.parsePptx({
      buffer: pptxBuf,
      filename: "worker-deck.pptx",
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
    });
    expect(parsedPptx.presentation.slides.length).toBeGreaterThanOrEqual(1);
    await expect(
      worker.parsePptx({
        buffer: new Uint8Array([0, 1, 2, 3]),
        filename: "bad.pptx",
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
      }),
    ).rejects.toBeInstanceOf(PptxImportError);

    // 4. Isolated Chromium PDF render
    const browserPath = detectChromiumBinary();
    if (!browserPath) {
      if (process.env.REQUIRE_CHROMIUM === "true") {
        throw new Error("REQUIRE_CHROMIUM=true requires Chromium/Edge for isolated worker renderPdf test.");
      }
      await expect(worker.renderPdf(sampleDoc)).rejects.toSatisfy(
        (err: unknown) => err instanceof PdfExportError && err.code === "PDF_RENDERER_UNAVAILABLE",
      );
    } else {
      const rendered = await worker.renderPdf(sampleDoc);
      expect(rendered.engine).toBe("chromium-harfbuzz");
      expect(rendered.pdfBuffer.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    }

    // 5. Timeout enforcement & worker crash containment via disposable scripts
    const dir = mkdtempSync(path.join(os.tmpdir(), "aios-worker-test-"));
    tempDirs.push(dir);
    const sleepScript = path.join(dir, "sleep.mjs");
    writeFileSync(sleepScript, "setTimeout(() => process.exit(0), 10000);", "utf8");
    const timeoutWorker = new IsolatedParserWorkerClient({ timeoutMs: 300, workerScriptPath: sleepScript });
    await expect(timeoutWorker.probeIsolation()).rejects.toSatisfy(
      (err: unknown) => err instanceof WorkerIsolationError && err.code === "WORKER_TIMEOUT",
    );

    const crashScript = path.join(dir, "crash.mjs");
    writeFileSync(crashScript, "process.stderr.write('simulated parser segfault'); process.exit(17);", "utf8");
    const crashWorker = new IsolatedParserWorkerClient({ workerScriptPath: crashScript });
    await expect(crashWorker.probeIsolation()).rejects.toSatisfy(
      (err: unknown) => err instanceof WorkerIsolationError && err.code === "WORKER_CRASHED",
    );

    // 6. Remote worker HTTP microservice round-trip & API gateway integration (local + HTTP worker)
    const workerHttp = await listenRawServer(createWorkerHttpServer({ timeoutMs: 20_000, maxConcurrentJobs: 2 }));
    try {
      const healthRes = await fetch(`${workerHttp.baseUrl}/health`);
      expect(healthRes.status).toBe(200);

      const remoteClient = new IsolatedParserWorkerClient({ workerUrl: workerHttp.baseUrl });
      const remoteDocx = await remoteClient.parseDocx({
        buffer: cleanDocx,
        filename: "remote.docx",
        tenantId: sampleDoc.tenantId,
        workspaceId: sampleDoc.workspaceId,
        actorId: "user_remote_worker",
      });
      expect(remoteDocx.document.title).toBe("remote");

      await expect(
        remoteClient.parseDocx({
          buffer: zipSync(macroEntries),
          filename: "remote-macro.docx",
          tenantId: sampleDoc.tenantId,
          workspaceId: sampleDoc.workspaceId,
          actorId: "user_remote_worker",
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof DocxImportError && err.code === "MACRO_CONTENT_BLOCKED");

      const apiWithWorkers = createApiApp({
        inMemory: true,
        rateLimit: { enabled: false },
        workers: {
          isolatedParsers: true,
          workerUrl: workerHttp.baseUrl,
          timeoutMs: 25_000,
        },
      });
      const apiSrv = await listenExpress(apiWithWorkers);
      try {
        const importRes = await fetch(`${apiSrv.baseUrl}/api/documents/import/docx`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-workspace-role": "editor",
            "x-tenant-id": sampleDoc.tenantId,
            "x-workspace-id": sampleDoc.workspaceId,
          },
          body: JSON.stringify({
            filename: "via-worker.docx",
            contentBase64: cleanDocx.toString("base64"),
          }),
        });
        expect(importRes.status).toBe(201);
        const importedBody = (await importRes.json()) as { document: StudioDocument };
        expect(importedBody.document.blocks.map(getBlockPlainText).join("\n")).toContain("ព្រះរាជាណាចក្រកម្ពុជា");

        const macroRes = await fetch(`${apiSrv.baseUrl}/api/documents/import/docx`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-workspace-role": "editor",
            "x-tenant-id": sampleDoc.tenantId,
            "x-workspace-id": sampleDoc.workspaceId,
          },
          body: JSON.stringify({
            filename: "blocked.docx",
            contentBase64: Buffer.from(zipSync(macroEntries)).toString("base64"),
          }),
        });
        expect(macroRes.status).toBe(400);
        expect(((await macroRes.json()) as { code: string }).code).toBe("MACRO_CONTENT_BLOCKED");

        if (browserPath) {
          const pdfRes = await fetch(`${apiSrv.baseUrl}/api/documents/${importedBody.document.documentId}/export/pdf`, {
            method: "POST",
            headers: {
              "x-workspace-role": "editor",
              "x-tenant-id": sampleDoc.tenantId,
              "x-workspace-id": sampleDoc.workspaceId,
            },
          });
          expect(pdfRes.status).toBe(200);
          const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
          expect(pdfBytes.subarray(0, 5).toString("utf8")).toBe("%PDF-");
        }
      } finally {
        await new Promise<void>((resolve) => apiSrv.server.close(() => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => workerHttp.server.close(() => resolve()));
    }
  });
});
