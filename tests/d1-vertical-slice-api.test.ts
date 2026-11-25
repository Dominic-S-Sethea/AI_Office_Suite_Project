import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "../apps/api/src/app.ts";

describe("§16 Vertical Slice — End-to-End Document Studio, Bilingual Voice & Audit Flow", () => {
  let server: http.Server;
  let baseUrl = "";

  beforeAll(async () => {
    const app = createApiApp({ inMemory: true });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("executes full §16 vertical slice and enforces viewer RBAC and tenant isolation", async () => {
    const editorHeaders = {
      "Content-Type": "application/json",
      "x-workspace-role": "editor",
      "x-user-id": "user_editor_1",
      "x-tenant-id": "tenant_a",
      "x-workspace-id": "ws_1",
    };

    // 1. Seed bilingual EN/KM document
    const seedRes = await fetch(`${baseUrl}/api/documents/seed-bilingual-fixture`, {
      method: "POST",
      headers: editorHeaders,
    });
    expect(seedRes.status).toBe(201);
    const seedBody = (await seedRes.json()) as { document: { documentId: string; revision: number; blocks: Array<{ id: string }> } };
    const docId = seedBody.document.documentId;
    let rev = seedBody.document.revision;
    const targetBlockId = seedBody.document.blocks[2]!.id;

    // 2. Typed AI edit -> preview -> apply -> undo
    const typedPlanRes = await fetch(`${baseUrl}/api/documents/${docId}/ai/plan`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({
        command: "make bold",
        expectedRevision: rev,
        inputLanguage: "en",
        outputLanguage: "match",
        source: "typed_ai",
        selection: { blockId: targetBlockId },
      }),
    });
    expect(typedPlanRes.status).toBe(200);
    const { proposal: typedProposal } = (await typedPlanRes.json()) as { proposal: Record<string, unknown> };

    const applyTypedRes = await fetch(`${baseUrl}/api/documents/${docId}/ai/apply`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({ proposal: typedProposal, approved: true }),
    });
    expect(applyTypedRes.status).toBe(200);
    rev = ((await applyTypedRes.json()) as { document: { revision: number } }).document.revision;
    expect(rev).toBe(2);

    // 3. English voice command via mock speech adapter -> same auth/plan/apply path
    const enSpeechRes = await fetch(`${baseUrl}/api/speech/transcribe`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({ provider: "mock", language: "en-US", mode: "contextual", fixtureId: "en-translate-khmer" }),
    });
    const { recognition: enRec } = (await enSpeechRes.json()) as { recognition: { transcript: string; isMock: boolean } };
    expect(enRec.isMock).toBe(true);

    const enVoicePlanRes = await fetch(`${baseUrl}/api/documents/${docId}/ai/plan`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({
        command: enRec.transcript,
        expectedRevision: rev,
        inputLanguage: "en",
        outputLanguage: "km",
        source: "voice_command",
        selection: { blockId: targetBlockId },
      }),
    });
    const { proposal: enVoiceProposal } = (await enVoicePlanRes.json()) as { proposal: Record<string, unknown> };
    const enVoiceApplyRes = await fetch(`${baseUrl}/api/documents/${docId}/ai/apply`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({ proposal: enVoiceProposal, approved: true }),
    });
    rev = ((await enVoiceApplyRes.json()) as { document: { revision: number } }).document.revision;
    expect(rev).toBe(3);

    // 4. Khmer voice command via mock speech adapter -> apply
    const kmSpeechRes = await fetch(`${baseUrl}/api/speech/transcribe`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({ provider: "mock", language: "km-KH", mode: "command", fixtureId: "km-insert-table" }),
    });
    const { recognition: kmRec } = (await kmSpeechRes.json()) as { recognition: { transcript: string } };
    const kmPlanRes = await fetch(`${baseUrl}/api/documents/${docId}/ai/plan`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({
        command: kmRec.transcript,
        expectedRevision: rev,
        inputLanguage: "km",
        outputLanguage: "km",
        source: "voice_command",
        selection: { blockId: targetBlockId },
      }),
    });
    const { proposal: kmProposal } = (await kmPlanRes.json()) as { proposal: Record<string, unknown> };
    const kmApplyRes = await fetch(`${baseUrl}/api/documents/${docId}/ai/apply`, {
      method: "POST",
      headers: editorHeaders,
      body: JSON.stringify({ proposal: kmProposal, approved: true }),
    });
    expect(kmApplyRes.status).toBe(200);
    rev = ((await kmApplyRes.json()) as { document: { revision: number } }).document.revision;
    expect(rev).toBe(4);

    // 5. Viewer RBAC denial and cross-tenant isolation
    const viewerPlanRes = await fetch(`${baseUrl}/api/documents/${docId}/ai/plan`, {
      method: "POST",
      headers: { ...editorHeaders, "x-workspace-role": "viewer" },
      body: JSON.stringify({
        command: "make bold",
        expectedRevision: rev,
        inputLanguage: "en",
        outputLanguage: "match",
        source: "voice_command",
      }),
    });
    expect(viewerPlanRes.status).toBe(403);

    const otherTenantRes = await fetch(`${baseUrl}/api/documents/${docId}`, {
      headers: { ...editorHeaders, "x-tenant-id": "tenant_b" },
    });
    expect(otherTenantRes.status).toBe(403);

    // 6. Export DOCX & PDF + verify version & audit trail
    const docxRes = await fetch(`${baseUrl}/api/documents/${docId}/export/docx`, {
      method: "POST",
      headers: editorHeaders,
    });
    expect(docxRes.status).toBe(200);
    expect((await docxRes.arrayBuffer()).byteLength).toBeGreaterThan(2000);

    const pdfRes = await fetch(`${baseUrl}/api/documents/${docId}/export/pdf`, {
      method: "POST",
      headers: editorHeaders,
    });
    expect(pdfRes.status).toBe(200);
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    expect(pdfBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    const auditRes = await fetch(`${baseUrl}/api/documents/${docId}/audit`, { headers: editorHeaders });
    const auditBody = (await auditRes.json()) as { events: Array<{ source: string }> };
    expect(auditBody.events.some((e) => e.source === "voice_command")).toBe(true);
    expect(auditBody.events.some((e) => e.source === "typed_ai")).toBe(true);
  });
});
