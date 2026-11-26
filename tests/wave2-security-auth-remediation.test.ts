import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { createApiApp } from "../apps/api/src/app.ts";
import { DataPreparationPipeline, stageCsvSource } from "@ai-office-suite/data-processing";
import {
  PgliteDatabaseAdapter,
  initializePostgreSqlSchema,
  withTenantTransaction,
} from "@ai-office-suite/database";
import { getJwtSecret, hashPassword, signSessionToken, verifySessionToken } from "@ai-office-suite/identity";
import {
  inspectAndExtractOoxmlZip,
  scanForUnsafeAnalyticalInput,
  validateChartSpecSafety,
} from "@ai-office-suite/validation";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("Wave 2 — Security & Auth Remediation (H1-H5, M11-M13)", () => {
  it("H1: defeats forged Central Directory originalSize ZIP bombs mid-stream and blocks duplicate ZIP entries", () => {
    // 1. Construct a 2MB compressible entry (compresses to ~2KB) and forge BOTH Local & Central Directory originalSize to 10 bytes!
    const payload = new Uint8Array(2 * 1024 * 1024);
    const rawZip = zipSync({ "word/document.xml": [payload, { level: 9 }] });
    const spoofed = new Uint8Array(rawZip);
    const view = new DataView(spoofed.buffer, spoofed.byteOffset, spoofed.byteLength);

    // Patch Local File Header uncompressed size (offset 22, uint32 LE) to 10 bytes
    view.setUint32(22, 10, true);
    // Find Central Directory signature PK\x01\x02 and patch its uncompressed size (offset +24) to 10 bytes
    for (let i = 0; i < spoofed.length - 28; i++) {
      if (spoofed[i] === 0x50 && spoofed[i + 1] === 0x4b && spoofed[i + 2] === 0x01 && spoofed[i + 3] === 0x02) {
        view.setUint32(i + 24, 10, true);
      }
    }

    const bombRes = inspectAndExtractOoxmlZip(spoofed, "spoofed-bomb.docx", "docx");
    expect(bombRes.ok).toBe(false);
    if (!bombRes.ok) {
      expect(bombRes.code).toBe("ZIP_BOMB_BLOCKED");
    }

    // 2. Duplicate normalized entry names (case / slash differential) must be rejected
    const dupZip = zipSync({
      "word/document.xml": new TextEncoder().encode("<w:document/>"),
      "WORD/Document.xml": new TextEncoder().encode("<w:document>evil</w:document>"),
    });
    const dupRes = inspectAndExtractOoxmlZip(dupZip, "dup.docx", "docx");
    expect(dupRes.ok).toBe(false);
    if (!dupRes.ok) {
      expect(dupRes.code).toBe("DUPLICATE_ARCHIVE_ENTRY");
    }
  });

  it("H2, H3, H4: enforces cookie-only login, browser-blocked /api/auth/token, strict CSRF, JWT iss/aud/jti, workspace RLS 404, viewer RBAC, and uniform 401", async () => {
    // H4: Ephemeral dev JWT secret is random 64-hex (never the old hardcoded string)
    expect(getJwtSecret()).not.toBe("aios-ephemeral-test-jwt-secret-min-32-chars-only");
    expect(getJwtSecret().length).toBeGreaterThanOrEqual(32);

    // H2: Token claims require iss/aud/jti
    const validToken = signSessionToken({
      userId: "22222222-2222-4222-8222-222222222222",
      email: "user@test.kh",
      tenantId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "editor",
      tv: 1,
    });
    const parsedValid = verifySessionToken(validToken);
    expect(parsedValid?.jti).toBeTruthy();

    const missingIssAud = jwt.sign(
      {
        sub: "22222222-2222-4222-8222-222222222222",
        email: "user@test.kh",
        tenant_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "editor",
        tv: 1,
      },
      getJwtSecret(),
      { algorithm: "HS256", expiresIn: "1h" },
    );
    expect(verifySessionToken(missingIssAud)).toBeNull();

    const db = new PgliteDatabaseAdapter();
    await initializePostgreSqlSchema(db);
    const tenantA = "11111111-1111-4111-8111-111111111111";
    const ws1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const ws2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const editor1Id = "22222222-2222-4222-8222-222222222221";
    const editor2Id = "22222222-2222-4222-8222-222222222222";
    const viewer1Id = "33333333-3333-4333-8333-333333333331";
    const inactiveId = "44444444-4444-4444-8444-444444444441";
    const pw = await hashPassword("Wave2Secret!2026");

    await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'Org A', 'active')", [tenantA]);
    await db.query(
      "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'WS 1'), ($1::uuid, $3::uuid, 'WS 2')",
      [tenantA, ws1, ws2],
    );
    await db.query(
      `INSERT INTO users (user_id, email, password_hash, status) VALUES
         ($1::uuid, 'ed1@org.kh', $5, 'active'),
         ($2::uuid, 'ed2@org.kh', $5, 'active'),
         ($3::uuid, 'vw1@org.kh', $5, 'active'),
         ($4::uuid, 'inactive@org.kh', $5, 'inactive')`,
      [editor1Id, editor2Id, viewer1Id, inactiveId, pw],
    );
    await db.query(
      `INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES
         ($1::uuid, $2::uuid, $4::uuid, 'editor'),
         ($1::uuid, $3::uuid, $5::uuid, 'editor'),
         ($1::uuid, $2::uuid, $6::uuid, 'viewer'),
         ($1::uuid, $2::uuid, $7::uuid, 'editor')`,
      [tenantA, ws1, ws2, editor1Id, editor2Id, viewer1Id, inactiveId],
    );

    const app = createApiApp({
      authMode: "jwt-pg",
      db,
      inMemory: true,
      rateLimit: { enabled: false },
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      // H4: Uniform 401 INVALID_CREDENTIALS for unknown email, wrong password, inactive user, and non-member workspace
      const loginFailures = await Promise.all([
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ghost@org.kh", password: "Wave2Secret!2026", tenantId: tenantA, workspaceId: ws1 }),
        }),
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ed1@org.kh", password: "WrongPassword!99", tenantId: tenantA, workspaceId: ws1 }),
        }),
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "inactive@org.kh", password: "Wave2Secret!2026", tenantId: tenantA, workspaceId: ws1 }),
        }),
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ed1@org.kh", password: "Wave2Secret!2026", tenantId: tenantA, workspaceId: ws2 }),
        }),
      ]);
      for (const r of loginFailures) {
        expect(r.status).toBe(401);
        const body = (await r.json()) as { code: string };
        expect(body.code).toBe("INVALID_CREDENTIALS");
      }

      // H2: Browser /api/auth/login sets HttpOnly cookie and omits raw JWT token
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ed1@org.kh", password: "Wave2Secret!2026", tenantId: tenantA, workspaceId: ws1 }),
      });
      expect(loginRes.status).toBe(200);
      const cookiePair = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect(cookiePair).toContain("aios_session=");
      const loginJson = (await loginRes.json()) as Record<string, unknown>;
      expect(loginJson.token).toBeUndefined();

      // H2: /api/auth/token blocks browser Origin and Sec-Fetch-Mode headers
      const browserTokenAttempt = await fetch(`${baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5174" },
        body: JSON.stringify({ email: "ed1@org.kh", password: "Wave2Secret!2026", tenantId: tenantA, workspaceId: ws1 }),
      });
      expect(browserTokenAttempt.status).toBe(403);

      // H2: Cookie CSRF rejects sec-fetch-site: same-site (sibling subdomain CSRF)
      const sameSiteCsrf = await fetch(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          Origin: "http://localhost:5174",
          "Sec-Fetch-Site": "same-site",
        },
        body: JSON.stringify({ title: "Subdomain CSRF", language: "en" }),
      });
      expect(sameSiteCsrf.status).toBe(403);

      // Fetch programmatic tokens for ws1 editor, ws2 editor, and ws1 viewer
      const getToken = async (email: string, wsId: string) => {
        const res = await fetch(`${baseUrl}/api/auth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "Wave2Secret!2026", tenantId: tenantA, workspaceId: wsId }),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { token: string }).token;
      };
      const ed1Token = await getToken("ed1@org.kh", ws1);
      const ed2Token = await getToken("ed2@org.kh", ws2);
      const vw1Token = await getToken("vw1@org.kh", ws1);

      // Create document in WS1
      const createRes = await fetch(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ed1Token}` },
        body: JSON.stringify({ title: "WS1 Secret Plan", language: "en" }),
      });
      expect(createRes.status).toBe(201);
      const ws1DocId = ((await createRes.json()) as { document: { documentId: string } }).document.documentId;

      // H3: Same-tenant WS2 editor gets uniform 404 (not 403 existence oracle!) on WS1 doc
      const crossWsRead = await fetch(`${baseUrl}/api/documents/${ws1DocId}`, {
        headers: { Authorization: `Bearer ${ed2Token}` },
      });
      expect(crossWsRead.status).toBe(404);
      const nonExistentRead = await fetch(`${baseUrl}/api/documents/${randomUUID()}`, {
        headers: { Authorization: `Bearer ${ed2Token}` },
      });
      expect(nonExistentRead.status).toBe(404);

      // H3: Direct PostgreSQL RLS enforces workspace isolation when app.current_workspace_id is set
      const directWs2Rows = await withTenantTransaction(
        db,
        tenantA,
        async (tx) => (await tx.query("SELECT document_id FROM documents")).rows,
        ws2,
      );
      expect(directWs2Rows).toHaveLength(0);

      // H3 & M10: Viewer blocked from /audit, /metrics, and /speech/transcribe (403)
      const viewerAudit = await fetch(`${baseUrl}/api/documents/${ws1DocId}/audit`, {
        headers: { Authorization: `Bearer ${vw1Token}` },
      });
      expect(viewerAudit.status).toBe(403);

      const viewerSpeech = await fetch(`${baseUrl}/api/speech/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${vw1Token}` },
        body: JSON.stringify({ provider: "mock", language: "en-US", mode: "command", fixtureId: "en-bold-selection" }),
      });
      expect(viewerSpeech.status).toBe(403);

      const editorMetrics = await fetch(`${baseUrl}/api/metrics`, {
        headers: { Authorization: `Bearer ${ed1Token}` },
      });
      expect(editorMetrics.status).toBe(403);
    } finally {
      server.close();
      await db.close();
    }
  });

  it("H5: blocks prototype-polluting CSV headers and uses server-keyed HMAC-SHA256 for PII hash_token", () => {
    for (const badHeader of ["__proto__", "constructor", "prototype", "__sourceFile"]) {
      expect(() => stageCsvSource(`${badHeader},amount\nval,100\n`, "bad.csv")).toThrow(/reserved or unsafe header/i);
    }

    const staged = stageCsvSource(
      "organization_id,invoice_id,line_number,currency,amount,customer_email\norg1,INV1,1,USD,100.00,alice@company.kh\n",
      "pii.csv",
    );
    const pipeline = new DataPreparationPipeline();
    const actor = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "22222222-2222-4222-8222-222222222222",
      role: "editor" as const,
    };

    const prevKey = process.env.PII_PSEUDONYMIZATION_KEY;
    try {
      process.env.PII_PSEUDONYMIZATION_KEY = "key-alpha-secret-32-chars-minimum-0001";
      const outA = pipeline.executeRecipe({
        actor,
        recipe: {
          recipeId: "rec_hmac_a",
          version: 1,
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          pinnedInputSha256s: [staged.source.sha256],
          idempotencyKey: "hmac-a",
          steps: [{ stepId: "m1", op: "mask_pii_columns", params: { columns: ["customer_email"], mode: "hash_token", salt: "pub" } }],
        },
        salesSources: [staged],
        expectedColumns: ["organization_id", "invoice_id", "line_number", "currency", "amount", "customer_email"],
      });

      const unkeyedDigest = createHash("sha256").update("pub::customer_email::alice@company.kh").digest("hex").slice(0, 16);
      const tokenA = String(outA.rows[0]?.customer_email);
      expect(tokenA).toMatch(/^pii_[0-9a-f]{16}$/);
      expect(tokenA).not.toBe(`pii_${unkeyedDigest}`);

      process.env.PII_PSEUDONYMIZATION_KEY = "key-beta-different-32-chars-minimum-02";
      const outB = pipeline.executeRecipe({
        actor,
        recipe: {
          recipeId: "rec_hmac_b",
          version: 1,
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          pinnedInputSha256s: [staged.source.sha256],
          idempotencyKey: "hmac-b",
          steps: [{ stepId: "m1", op: "mask_pii_columns", params: { columns: ["customer_email"], mode: "hash_token", salt: "pub" } }],
        },
        salesSources: [staged],
        expectedColumns: ["organization_id", "invoice_id", "line_number", "currency", "amount", "customer_email"],
      });
      expect(String(outB.rows[0]?.customer_email)).not.toBe(tokenA);
    } finally {
      if (prevKey === undefined) delete process.env.PII_PSEUDONYMIZATION_KEY;
      else process.env.PII_PSEUDONYMIZATION_KEY = prevKey;
    }
  });

  it("M11, M12, M13: normalizes zero-width bypasses, enforces WAV bounds in Python worker, and hardens Nginx headers", async () => {
    // M11: zero-width obfuscation inside analytical & chart inputs caught after NFKC/zero-width normalization
    expect(scanForUnsafeAnalyticalInput("SELECT * FROM r\u200bead_csv('secret.csv')").safe).toBe(false);
    expect(
      validateChartSpecSafety({
        titleEn: "<sc\u200bript>alert(1)</script>",
        titleKm: "របាយការណ៍",
        altSummaryEn: "Summary",
        altSummaryKm: "សង្ខេប",
        categories: ["Q1"],
        series: [{ labelEn: "Rev", labelKm: "ចំណូល" }],
      }).safe,
    ).toBe(false);

    // M12: Python worker rejects invalid WAV sample rate (> 96000 Hz)
    const dir = mkdtempSync(path.join(os.tmpdir(), "aios-wav-bounds-"));
    tempDirs.push(dir);
    const badWav = path.join(dir, "bad-rate.wav");
    // Minimal 44-byte PCM WAV header with sampleRate = 200000 Hz
    const wavBuf = Buffer.alloc(46);
    wavBuf.write("RIFF", 0);
    wavBuf.writeUInt32LE(38, 4);
    wavBuf.write("WAVE", 8);
    wavBuf.write("fmt ", 12);
    wavBuf.writeUInt32LE(16, 16);
    wavBuf.writeUInt16LE(1, 20); // PCM
    wavBuf.writeUInt16LE(1, 22); // mono
    wavBuf.writeUInt32LE(200000, 24); // invalid sample rate
    wavBuf.writeUInt32LE(400000, 28);
    wavBuf.writeUInt16LE(2, 32);
    wavBuf.writeUInt16LE(16, 34);
    wavBuf.write("data", 36);
    wavBuf.writeUInt32LE(2, 40);
    writeFileSync(badWav, wavBuf);

    const pyCheck = await execFileAsync("python3", [
      "-c",
      `import sys; sys.path.insert(0, 'scripts'); import faster_whisper_worker as w
try:
  w.load_pcm_wav_16k(sys.argv[1])
  print('UNEXPECTED_OK')
except ValueError as e:
  print('REJECTED:' + str(e))`,
      badWav,
    ]);
    expect(pyCheck.stdout).toContain("REJECTED:Unsupported WAV sample rate");

    // M13: Nginx security headers present
    const nginxConf = readFileSync(path.resolve("docker/nginx.conf"), "utf8");
    expect(nginxConf).toContain("Permissions-Policy");
    expect(nginxConf).toContain("X-Permitted-Cross-Domain-Policies");
  });
});
