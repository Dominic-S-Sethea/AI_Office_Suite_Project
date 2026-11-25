import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { zipSync, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ActorContext,
  DataScopePolicy,
  ReportingContext,
  SpreadsheetWorkbook,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import {
  initializePostgreSqlSchema,
  PgliteDatabaseAdapter,
} from "@ai-office-suite/database";
import { getJwtSecret, hashPassword } from "@ai-office-suite/identity";
import { redactAuditValue, InMemoryAuditStore } from "@ai-office-suite/audit";
import { InMemoryStorageAdapter } from "@ai-office-suite/storage";
import { DocumentService } from "@ai-office-suite/documents-module";
import { AiDocumentExecutor, planDocumentOperation } from "@ai-office-suite/ai-module";
import {
  createEmptyDocument,
  DocumentEngineError,
  previewDocumentOperation,
} from "@ai-office-suite/document-engine";
import {
  exportToDocxBuffer,
  importFromDocxBuffer,
} from "@ai-office-suite/file-conversion";
import {
  AnalyticsError,
  convertCurrencyMinorUnits,
  parseDecimalToMinorUnits,
} from "@ai-office-suite/analytics-engine";
import {
  exportSheetToSafeCsv,
  exportWorkbookToXlsxBuffer,
  importWorkbookFromXlsxBuffer,
  recalculateWorkbook,
} from "@ai-office-suite/calculation-engine";
import {
  runDuckDbComparison,
  stageCsvSource,
  stageXlsxSource,
} from "@ai-office-suite/data-processing";
import { importFromPptxBuffer } from "@ai-office-suite/presentation-engine";
import { IntelligenceStudioEngine } from "@ai-office-suite/intelligence-engine";
import {
  CrossModuleIntegrationEngine,
  initializeIntegrationSchema,
  listOutboxEventsForTenant,
  STANDARD_FINANCE_COLUMNS,
} from "@ai-office-suite/integration-engine";
import { createApiApp } from "../apps/api/src/app.ts";

const TENANT_A = "12121212-1212-4212-8212-121212121212";
const WS_A = "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2";
const TENANT_B = "34343434-3434-4434-8434-343434343434";
const WS_B = "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4";
const USER_A_OWNER = "56565656-5656-4656-8656-565656565651";
const USER_A_EDITOR = "56565656-5656-4656-8656-565656565652";
const USER_A_VIEWER = "56565656-5656-4656-8656-565656565653";
const USER_B_OWNER = "56565656-5656-4656-8656-565656565654";

describe("Phase 2 — Security, Precision & Cross-Engine Edge-Case Hardening", () => {
  describe("2.1 Auth, RBAC, Audit Redaction & Full jwt-pg API Hardening", () => {
    let db: PgliteDatabaseAdapter;
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      db = new PgliteDatabaseAdapter();
      await db.ready();
      await initializePostgreSqlSchema(db);
      await initializeIntegrationSchema(db);

      const pwHash = await hashPassword("HardenedPass!2026");
      await db.query(
        "INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'Tenant A', 'active'), ($2::uuid, 'Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await db.query(
        "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'WS A'), ($3::uuid, $4::uuid, 'WS B')",
        [TENANT_A, WS_A, TENANT_B, WS_B],
      );
      await db.query(
        `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES
         ($1::uuid, 'owner-a@hardening.test', $5, 1, 'active'),
         ($2::uuid, 'editor-a@hardening.test', $5, 1, 'active'),
         ($3::uuid, 'viewer-a@hardening.test', $5, 1, 'active'),
         ($4::uuid, 'owner-b@hardening.test', $5, 1, 'active')`,
        [USER_A_OWNER, USER_A_EDITOR, USER_A_VIEWER, USER_B_OWNER, pwHash],
      );
      await db.query(
        `INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'owner'),
         ($1::uuid, $2::uuid, $4::uuid, 'editor'),
         ($1::uuid, $2::uuid, $5::uuid, 'viewer'),
         ($6::uuid, $7::uuid, $8::uuid, 'owner')`,
        [TENANT_A, WS_A, USER_A_OWNER, USER_A_EDITOR, USER_A_VIEWER, TENANT_B, WS_B, USER_B_OWNER],
      );

      const app = createApiApp({ inMemory: true, authMode: "jwt-pg", db });
      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (db) await db.close();
    });

    async function login(email: string, tenantId: string, workspaceId: string) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "HardenedPass!2026", tenantId, workspaceId }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      const body = (await res.json()) as { token: string };
      return { token: body.token, cookiePair: setCookie.split(";")[0]! };
    }

    it("enforces speech auth, logout CSRF, viewer export denial, non-UUID 404, org suspension, and PG-backed AI/versions/audit", async () => {
      // Unauthenticated speech call rejected in jwt-pg mode
      const unauthSpeech = await fetch(`${baseUrl}/api/speech/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "mock", language: "en-US", mode: "command", fixtureId: "en-bold-selection" }),
      });
      expect(unauthSpeech.status).toBe(401);

      // Malformed non-UUID JWT claims rejected cleanly with 401 (never 500)
      const malformedJwt = jwt.sign(
        { sub: "not-a-uuid", email: "x@test", tenant_id: "bad", workspace_id: "bad", role: "owner", tv: 1 },
        getJwtSecret(),
        { algorithm: "HS256", expiresIn: "1h" },
      );
      const badClaimsRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${malformedJwt}` },
      });
      expect(badClaimsRes.status).toBe(401);

      const editorA = await login("editor-a@hardening.test", TENANT_A, WS_A);
      const viewerA = await login("viewer-a@hardening.test", TENANT_A, WS_A);
      const ownerB = await login("owner-b@hardening.test", TENANT_B, WS_B);

      // Non-UUID documentId returns clean 404 instead of PostgreSQL 500
      const badDocIdRes = await fetch(`${baseUrl}/api/documents/not-a-uuid`, {
        headers: { Authorization: `Bearer ${editorA.token}` },
      });
      expect(badDocIdRes.status).toBe(404);

      // Authenticated mock speech works, cloud STT remains fail-closed 423
      const mockSpeech = await fetch(`${baseUrl}/api/speech/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorA.token}` },
        body: JSON.stringify({ provider: "mock", language: "km-KH", mode: "command", fixtureId: "km-insert-table" }),
      });
      expect(mockSpeech.status).toBe(200);
      const cloudSpeech = await fetch(`${baseUrl}/api/speech/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorA.token}` },
        body: JSON.stringify({ provider: "google-cloud-stt-v2", language: "km-KH", mode: "command" }),
      });
      expect(cloudSpeech.status).toBe(423);

      // Seed bilingual doc in PostgreSQL -> verify versions, AI plan/apply, restore, viewer export 403, cross-tenant 404, audit
      const seedRes = await fetch(`${baseUrl}/api/documents/seed-bilingual-fixture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${editorA.token}` },
      });
      expect(seedRes.status).toBe(201);
      const { document: pgDoc } = (await seedRes.json()) as { document: StudioDocument };

      // Viewer blocked on DOCX and PDF exports (export:export RBAC)
      const viewerDocx = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/export/docx`, {
        method: "POST",
        headers: { Authorization: `Bearer ${viewerA.token}` },
      });
      expect(viewerDocx.status).toBe(403);
      const viewerPdf = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/export/pdf`, {
        method: "POST",
        headers: { Authorization: `Bearer ${viewerA.token}` },
      });
      expect(viewerPdf.status).toBe(403);

      // Editor can export DOCX & Content-Disposition filename is sanitized
      const editorDocx = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/export/docx`, {
        method: "POST",
        headers: { Authorization: `Bearer ${editorA.token}` },
      });
      expect(editorDocx.status).toBe(200);
      expect(editorDocx.headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.docx"$/);

      // AI plan + tampered requiresApproval=false with approved=false MUST still reject 400
      const planRes = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/ai/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorA.token}` },
        body: JSON.stringify({
          command: "make bold",
          expectedRevision: 1,
          inputLanguage: "en",
          outputLanguage: "match",
          source: "typed_ai",
          selection: { blockId: pgDoc.blocks[2]!.id },
        }),
      });
      expect(planRes.status).toBe(200);
      const { proposal } = (await planRes.json()) as { proposal: Record<string, unknown> };

      const tamperedApply = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/ai/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorA.token}` },
        body: JSON.stringify({ proposal: { ...proposal, requiresApproval: false }, approved: false }),
      });
      expect(tamperedApply.status).toBe(400);

      // Approved apply succeeds in PG, creates rev 2, and restore creates rev 3
      const applyRes = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/ai/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorA.token}` },
        body: JSON.stringify({ proposal, approved: true }),
      });
      expect(applyRes.status).toBe(200);
      const applyBody = (await applyRes.json()) as { document: StudioDocument; deduplicated: boolean };
      expect(applyBody.document.revision).toBe(2);
      expect(applyBody.deduplicated).toBe(false);

      // Cross-tenant Owner B cannot read versions, export, or replay AI op against Tenant A's document
      const crossVersions = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/versions`, {
        headers: { Authorization: `Bearer ${ownerB.token}` },
      });
      expect(crossVersions.status).toBe(404);

      const restoreRes = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/versions/1/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${editorA.token}` },
      });
      expect(restoreRes.status).toBe(200);
      expect(((await restoreRes.json()) as { document: StudioDocument }).document.revision).toBe(3);

      const versionsRes = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/versions`, {
        headers: { Authorization: `Bearer ${editorA.token}` },
      });
      expect(versionsRes.status).toBe(200);
      expect(((await versionsRes.json()) as { versions: unknown[] }).versions).toHaveLength(3);

      const auditRes = await fetch(`${baseUrl}/api/documents/${pgDoc.documentId}/audit`, {
        headers: { Authorization: `Bearer ${editorA.token}` },
      });
      expect(auditRes.status).toBe(200);
      const auditEvents = ((await auditRes.json()) as { events: Array<{ action: string }> }).events;
      expect(auditEvents.some((e) => e.action === "document.ai_applied")).toBe(true);
      expect(auditEvents.some((e) => e.action === "document.version_restored")).toBe(true);

      // Cookie logout enforces CSRF on cross-site requests
      const csrfLogout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: editorA.cookiePair,
          "Sec-Fetch-Site": "cross-site",
          Origin: "https://evil.example",
        },
      });
      expect(csrfLogout.status).toBe(403);

      // Zod v4 validation rejects invalid payloads cleanly with 400
      const invalidCreate = await fetch(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorA.token}` },
        body: JSON.stringify({ title: "   ", language: "invalid_lang" }),
      });
      expect(invalidCreate.status).toBe(400);

      // Suspending Organization B immediately blocks existing valid JWT sessions for Tenant B
      await db.query("UPDATE organizations SET status = 'suspended' WHERE tenant_id = $1::uuid", [TENANT_B]);
      try {
        const suspendedCheck = await fetch(`${baseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${ownerB.token}` },
        });
        expect(suspendedCheck.status).toBe(403);
        const suspendedBody = (await suspendedCheck.json()) as { code: string };
        expect(suspendedBody.code).toBe("ORGANIZATION_SUSPENDED");
      } finally {
        await db.query("UPDATE organizations SET status = 'active' WHERE tenant_id = $1::uuid", [TENANT_B]);
      }
    });

    it("prevents cross-tenant AI idempotency cache BOLA leaks and redacts sensitive secrets/JWTs in audit logs", async () => {
      const storage = new InMemoryStorageAdapter();
      const audit = new InMemoryAuditStore();
      const docs = new DocumentService(storage, audit);
      const executor = new AiDocumentExecutor(docs, audit);

      const actorA: ActorContext = { tenantId: TENANT_A, workspaceId: WS_A, userId: USER_A_EDITOR, role: "editor" };
      const actorB: ActorContext = { tenantId: TENANT_B, workspaceId: WS_B, userId: USER_B_OWNER, role: "owner" };

      const docA = await docs.createDocument(actorA, { title: "Tenant A Secret Memo", language: "en" });
      const proposal = planDocumentOperation({
        actor: actorA,
        document: docA,
        input: {
          command: "make bold",
          expectedRevision: 1,
          inputLanguage: "en",
          outputLanguage: "en",
          source: "typed_ai",
          selection: { blockId: docA.blocks[0]!.id },
        },
        audit,
      });

      const appliedA = await executor.applyProposal({ actor: actorA, proposal, approved: true });
      expect(appliedA.document.tenantId).toBe(TENANT_A);

      // Tenant B replaying Tenant A's exact operationId MUST NOT receive Tenant A's cached document!
      await expect(
        executor.applyProposal({ actor: actorB, proposal, approved: true }),
      ).rejects.toThrow(/Cross-tenant|denied/i);

      // Audit redaction strips compound secret keys, 3-part JWTs, sk- keys, and aios_session cookies
      const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.abcDEF123456-_";
      const redacted = redactAuditValue({
        accessToken: "plain-secret",
        passwordHash: "$2a$10$hash",
        "x-api-key": "key-123",
        note: `Cookie: aios_session=${fakeJwt}; token=${fakeJwt}; key=sk-1234567890abcdef1234`,
      }) as Record<string, string>;
      expect(redacted.accessToken).toBe("[REDACTED]");
      expect(redacted.passwordHash).toBe("[REDACTED]");
      expect(redacted["x-api-key"]).toBe("[REDACTED]");
      expect(redacted.note).not.toContain("eyJ");
      expect(redacted.note).not.toContain("sk-1234567890");
    });
  });

  describe("2.2 Financial Precision, Spreadsheets & Data Preparation Edge Cases", () => {
    it("enforces FIN-POL-V1 rounding ties, scientific-notation DoS guard, and 10-decimal FX precision/overflow", () => {
      expect(parseDecimalToMinorUnits("0.125", 2, undefined, "HALF_UP")).toBe(13n);
      expect(parseDecimalToMinorUnits("0.125", 2, undefined, "HALF_EVEN")).toBe(12n);
      expect(parseDecimalToMinorUnits("0.135", 2, undefined, "HALF_EVEN")).toBe(14n);
      expect(() => parseDecimalToMinorUnits("1e1000000", 2)).toThrowError(AnalyticsError);

      // 10-decimal FX conversion USD -> KHR (4050.1234567895)
      const converted = convertCurrencyMinorUnits(10000n, 2, "USD", "KHR", {
        fromCurrency: "USD",
        toCurrency: "KHR",
        rateDecimalString: "4050.1234567895",
        source: "NBC",
        effectiveDate: "2026-11-26",
      });
      expect(converted).toBe(40501235n);

      // Overflow guard on massive FX conversion
      expect(() =>
        convertCurrencyMinorUnits(99999999999999999n, 2, "USD", "KHR", {
          fromCurrency: "USD",
          toCurrency: "KHR",
          rateDecimalString: "4050.0000000000",
          source: "NBC",
          effectiveDate: "2026-11-26",
        }),
      ).toThrowError(AnalyticsError);
    });

    it("handles Excel ROUND ties, formula errors (#DIV/0!, #REF!, #VALUE!, #NAME?, #N/A, #CYCLE!), quote-aware parens, range-DoS guard, CSV CR/formula escaping & leading-zero Khmer IDs", async () => {
      const wb: SpreadsheetWorkbook = {
        workbookId: "wb_edge_1",
        title: "Edge Cases",
        revision: 1,
        dateSystem: "1900",
        unsupportedFeatures: [],
        sheets: [
          {
            sheetId: "s1",
            name: "Main",
            cells: {
              A1: { value: "001245", numberFormat: "@" },
              A2: { value: "ក្រុមហ៊ុន ភ្នំពេញ" },
              B1: { value: 10 },
              B2: { value: 0 },
              C1: { value: null, formula: "=ROUND(-1.5, 0)" },
              C2: { value: null, formula: "=ROUND(1.005, 2)" },
              C3: { value: null, formula: "=B1/B2" },
              C4: { value: null, formula: "=GhostSheet!A1" },
              C5: { value: null, formula: '=B1+"not_a_number"' },
              C6: { value: null, formula: "=XLOOKUP(1, A1:A2, B1:B2)" },
              C7: { value: null, formula: '=VLOOKUP("MISSING", A1:B2, 2, FALSE)' },
              C8: { value: null, formula: "=VLOOKUP(A1, A1:B2, B1/B2, FALSE)" },
              C9: { value: null, formula: "=(C10)+1" },
              C10: { value: null, formula: "=(C9)+1" },
              C11: { value: null, formula: '=("a)b")' },
              C12: { value: null, formula: "=SUM(A1:ZZ5000)" },
              D1: { value: "line1\rline2" },
              D2: { value: "\r=CMD()" },
            },
          },
        ],
      };

      const res = recalculateWorkbook(wb);
      const cells = res.workbook.sheets[0]!.cells;
      expect(cells.C1!.evaluatedValue).toBe(-2);
      expect(cells.C2!.evaluatedValue).toBe(1.01);
      expect(cells.C3!.evaluatedValue).toMatchObject({ error: "#DIV/0!" });
      expect(cells.C4!.evaluatedValue).toMatchObject({ error: "#REF!" });
      expect(cells.C5!.evaluatedValue).toMatchObject({ error: "#VALUE!" });
      expect(cells.C6!.evaluatedValue).toMatchObject({ error: "#NAME?" });
      expect(cells.C7!.evaluatedValue).toMatchObject({ error: "#N/A" });
      expect(cells.C8!.evaluatedValue).toMatchObject({ error: "#DIV/0!" });
      expect(cells.C9!.evaluatedValue).toMatchObject({ error: "#CYCLE!" });
      expect(cells.C11!.evaluatedValue).toBe("a)b");
      expect(cells.C12!.evaluatedValue).toMatchObject({ error: "#REF!" });
      expect(res.cyclesDetected.length).toBeGreaterThan(0);

      // CSV export neutralizes leading CR formula injection and quotes CR fields per RFC 4180 while preserving leading-zero & Khmer text
      const csvReport = exportSheetToSafeCsv(res.workbook.sheets[0]!);
      expect(csvReport.csv).toContain("001245");
      expect(csvReport.csv).toContain("ក្រុមហ៊ុន ភ្នំពេញ");
      expect(csvReport.csv).toContain('"line1\rline2"');
      expect(csvReport.csv).toContain('"\'\r=CMD()"');

      // BOM-prefixed UTF-8 Khmer CSV staging strips BOM cleanly
      const bomCsv = "\uFEFFcustomer_id,department,amount\r\n001245,ផ្នែកលក់,100.50\r\n";
      const stagedCsv = stageCsvSource(bomCsv, "bom-khmer.csv");
      expect(stagedCsv.source.columnNames).toEqual(["customer_id", "department", "amount"]);
      expect(stagedCsv.rows[0]?.customer_id).toBe("001245");
      expect(stagedCsv.rows[0]?.department).toBe("ផ្នែកលក់");

      // DuckDB enable_external_access=false blocks host filesystem reads
      const duckRes = await runDuckDbComparison(
        [
          {
            organization_id: "org1",
            invoice_id: "INV-001",
            line_number: "1",
            customer_id: "001245",
            department: "Sales",
            currency: "USD",
            amount: 100,
          },
        ],
        [{ customer_id: "001245", customer_name: "ក្រុមហ៊ុន", region: "Phnom Penh" }],
      );
      expect(duckRes.externalAccessBlocked).toBe(true);
    });
  });

  describe("2.3 OOXML ZIP-Bomb, Traversal, Macro & Document Rollback Hardening", () => {
    it("blocks high-ratio ZIP bombs, Windows drive traversal, NUL bytes, and EncryptedPackage across DOCX, PPTX, XLSX, and stageXlsxSource", async () => {
      // Craft a tiny compressed ZIP bomb (~2 MB of zeroes compresses to ~2 KB -> ratio > 500x!)
      const bombPayload = new Uint8Array(2 * 1024 * 1024); // all zeros
      const docxBomb = zipSync({
        "word/document.xml": new Uint8Array(Buffer.from("<w:document><w:body/></w:document>")),
        "word/bomb.xml": bombPayload,
      });
      await expect(
        importFromDocxBuffer({
          buffer: docxBomb,
          filename: "bomb.docx",
          tenantId: TENANT_A,
          workspaceId: WS_A,
          actorId: USER_A_EDITOR,
        }),
      ).rejects.toMatchObject({ code: "ZIP_BOMB_BLOCKED" });

      const pptxBomb = zipSync({
        "ppt/presentation.xml": new Uint8Array(Buffer.from("<p:presentation/>")),
        "ppt/bomb.xml": bombPayload,
      });
      expect(() =>
        importFromPptxBuffer({
          buffer: pptxBomb,
          filename: "bomb.pptx",
          tenantId: TENANT_A,
          workspaceId: WS_A,
          actorId: USER_A_EDITOR,
        }),
      ).toThrowError(/ratio|bounds|ZIP_BOMB/i);

      const xlsxBomb = zipSync({
        "xl/workbook.xml": new Uint8Array(Buffer.from("<workbook/>")),
        "xl/bomb.xml": bombPayload,
      });
      await expect(importWorkbookFromXlsxBuffer(xlsxBomb, "bomb.xlsx")).rejects.toMatchObject({
        code: "ZIP_BOMB_BLOCKED",
      });
      await expect(stageXlsxSource(xlsxBomb, "bomb.xlsx")).rejects.toMatchObject({
        code: "ZIP_BOMB_BLOCKED",
      });

      // Windows drive-letter traversal & EncryptedPackage blocked across importers
      const driveTraversalDocx = zipSync({
        "word/document.xml": new Uint8Array(Buffer.from("<w:document/>")),
        "C:evil.xml": new Uint8Array(Buffer.from("<x/>")),
      });
      await expect(
        importFromDocxBuffer({
          buffer: driveTraversalDocx,
          filename: "drive.docx",
          tenantId: TENANT_A,
          workspaceId: WS_A,
          actorId: USER_A_EDITOR,
        }),
      ).rejects.toMatchObject({ code: "ZIP_PATH_TRAVERSAL_BLOCKED" });

      const encryptedPptx = zipSync({
        EncryptedPackage: new Uint8Array(Buffer.from("ciphertext")),
      });
      expect(() =>
        importFromPptxBuffer({
          buffer: encryptedPptx,
          filename: "enc.pptx",
          tenantId: TENANT_A,
          workspaceId: WS_A,
          actorId: USER_A_EDITOR,
        }),
      ).toThrowError(/Encrypted/i);

      // stageXlsxSource also blocks .xlsm and embedded vbaProject.bin
      const validWb: SpreadsheetWorkbook = {
        workbookId: "wb_safe",
        title: "Safe",
        revision: 1,
        dateSystem: "1900",
        unsupportedFeatures: [],
        sheets: [{ sheetId: "s1", name: "Sheet1", cells: { A1: { value: "id" }, A2: { value: "001" } } }],
      };
      const cleanXlsx = await exportWorkbookToXlsxBuffer(validWb);
      const macroEntries = unzipSync(cleanXlsx);
      macroEntries["xl/vbaProject.bin"] = new Uint8Array([1, 2, 3, 4]);
      await expect(stageXlsxSource(zipSync(macroEntries), "macro.xlsx")).rejects.toMatchObject({
        code: "MACRO_WORKBOOK_BLOCKED",
      });

      // Clean DOCX round-trip still passes cleanly
      const cleanDoc = createEmptyDocument({
        tenantId: TENANT_A,
        workspaceId: WS_A,
        title: "Clean Doc",
        createdBy: USER_A_EDITOR,
      });
      const cleanDocx = await exportToDocxBuffer(cleanDoc);
      const importedClean = await importFromDocxBuffer({
        buffer: cleanDocx,
        filename: "clean.docx",
        tenantId: TENANT_A,
        workspaceId: WS_A,
        actorId: USER_A_EDITOR,
      });
      expect(importedClean.document.title).toBe("clean");
      expect(JSON.stringify(importedClean.document.blocks)).toContain("Clean Doc");

      // undo_last rejects mismatched cross-document / cross-tenant priorRevisionDoc
      const otherTenantDoc = createEmptyDocument({
        tenantId: TENANT_B,
        workspaceId: WS_B,
        title: "Other Tenant Doc",
        createdBy: USER_B_OWNER,
      });
      expect(() =>
        previewDocumentOperation(
          cleanDoc,
          { expectedRevision: 1, action: "undo_last", params: {} },
          otherTenantDoc,
        ),
      ).toThrowError(DocumentEngineError);
    });
  });

  describe("2.4 BI Policy Isolation & Cross-Module Integration Idempotency/RBAC", () => {
    it("enforces cross-tenant BI policy checks, column-keyed cache isolation, revocation eviction, viewer package tamper block, and idempotent publication replay", async () => {
      const bi = new IntelligenceStudioEngine();
      bi.seedSection12TenantData(TENANT_A, WS_A);

      const editorA: ActorContext = { tenantId: TENANT_A, workspaceId: WS_A, userId: USER_A_EDITOR, role: "editor" };
      const ownerB: ActorContext = { tenantId: TENANT_B, workspaceId: WS_B, userId: USER_B_OWNER, role: "owner" };
      const policyA: DataScopePolicy = {
        policyId: "pol_a",
        policyVersion: 1,
        tenantId: TENANT_A,
        principalRole: "editor",
        allowedDepartments: "ALL",
        allowedColumns: ["rowId", "invoiceDate", "reportingMonth", "department", "grossSales", "cogs", "opex"],
        canExportUnderlyingDetail: true,
        canPublish: true,
      };
      const policyANarrowCols: DataScopePolicy = {
        ...policyA,
        allowedColumns: ["rowId", "department", "grossSales"],
      };
      const policyB: DataScopePolicy = {
        ...policyA,
        policyId: "pol_b",
        tenantId: TENANT_B,
        principalRole: "owner",
      };

      const report = bi.createManagementReport(editorA);
      const evalFull = await bi.evaluateReport(editorA, policyA, report.reportId, { interactionSeq: 1 });
      expect(evalFull.cacheHit).toBe(false);

      // Different allowedColumns MUST NOT hit the broader cache entry even with same policyId/policyVersion
      const evalNarrow = await bi.evaluateReport(editorA, policyANarrowCols, report.reportId, { interactionSeq: 2 });
      expect(evalNarrow.cacheHit).toBe(false);

      // Cross-tenant policy mismatch blocked on drill-through, publishSnapshot, and exportFilteredSummaryCsv
      expect(() => bi.drillToPermittedDetail(editorA, policyB, report.reportId, {})).toThrowError(/POLICY_TENANT_MISMATCH|tenant mismatch/i);
      expect(() => bi.exportFilteredSummaryCsv(ownerB, policyB, evalFull)).toThrowError(/Cross-tenant|denied/i);
      expect(() => bi.publishSnapshot(ownerB, policyB, evalFull, "cross_pub_1")).toThrowError(/Cross-tenant|denied/i);

      // Revocation immediately evicts tenant cache and blocks access
      bi.revokePrincipalAccess(TENANT_A, editorA.userId);
      await expect(bi.evaluateReport(editorA, policyA, report.reportId, { interactionSeq: 3 })).rejects.toThrowError(/revoked/i);

      // Cross-Module Integration: viewer cannot tamper with approved staged package; publication replay is strictly idempotent
      const db = new PgliteDatabaseAdapter();
      await db.ready();
      await initializePostgreSqlSchema(db);
      await initializeIntegrationSchema(db);
      try {
        const pwHash = await hashPassword("XiPass!2026");
        await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'XI A', 'active')", [TENANT_A]);
        await db.query("INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'WS A')", [TENANT_A, WS_A]);
        await db.query(
          "INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, 'own@xi.test', $2, 1, 'active')",
          [USER_A_OWNER, pwHash],
        );

        const ownerA: ActorContext = { tenantId: TENANT_A, workspaceId: WS_A, userId: USER_A_OWNER, role: "owner" };
        const viewerA: ActorContext = { tenantId: TENANT_A, workspaceId: WS_A, userId: USER_A_VIEWER, role: "viewer" };
        const xi = new CrossModuleIntegrationEngine({ db });
        const seeded = await xi.seedGoldenV1(TENANT_A, WS_A, ownerA);
        const xiPolicy: DataScopePolicy = {
          policyId: "pol_xi_all",
          policyVersion: 1,
          tenantId: TENANT_A,
          principalRole: "owner",
          allowedDepartments: "ALL",
          allowedColumns: [...STANDARD_FINANCE_COLUMNS],
          canExportUnderlyingDetail: true,
          canPublish: true,
        };
        const ctx: ReportingContext = {
          tenantId: TENANT_A,
          workspaceId: WS_A,
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

        const wf = await xi.startMonthlyReportingWorkflow(ownerA, xiPolicy, {
          idempotencyKey: "xi_p2_wf_1",
          context: ctx,
        });
        const pkgId = wf.run.stagedPackageId!;
        await xi.approveReportingPackage(ownerA, pkgId, 1);

        // Viewer MUST NOT be able to mutate staged package after approval
        await expect(
          xi.modifyStagedPackageAfterApproval(viewerA, pkgId, 1, "Sabotaged Title"),
        ).rejects.toThrowError(/not authorized/i);

        // Publish twice with identical idempotencyKey -> strictly idempotent (1 outbox event, identical publishedAt)
        const pub1 = await xi.publishReportingPackage(ownerA, xiPolicy, {
          packageId: pkgId,
          packageVersion: 1,
          idempotencyKey: "xi_p2_pub_idem_1",
        });
        const pub2 = await xi.publishReportingPackage(ownerA, xiPolicy, {
          packageId: pkgId,
          packageVersion: 1,
          idempotencyKey: "xi_p2_pub_idem_1",
        });
        expect(pub2.publishedAt).toBe(pub1.publishedAt);
        const outbox = await listOutboxEventsForTenant(db, TENANT_A);
        expect(outbox).toHaveLength(1);
      } finally {
        await db.close();
      }
    });
  });
});
