// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import { analyzeKhmerText, snapRangeToGraphemeBoundaries } from "@ai-office-suite/document-engine";
import { validateDocxUploadBytes, validateOoxmlUploadHeader } from "@ai-office-suite/validation";
import {
  decodeHtmlEntities,
  exportToDocxBuffer,
  htmlToStudioBlocks,
  importFromDocxBuffer,
  normalizeDocxHexColor,
} from "@ai-office-suite/file-conversion";
import { App } from "../apps/web/src/App.tsx";
import { AiVoicePanel } from "../apps/web/src/components/AiVoicePanel.tsx";
import { VersionAuditDrawer } from "../apps/web/src/components/VersionAuditDrawer.tsx";
import { WorkspaceSubPanel } from "../apps/web/src/components/WorkspaceSubPanel.tsx";

const DOC_A: StudioDocument = {
  documentId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  title: "Document Alpha",
  language: "bilingual",
  revision: 2,
  status: "draft",
  layout: {
    size: "A4",
    orientation: "portrait",
    marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
    headerText: "Header",
    footerText: "Footer",
    showPageNumbers: true,
  },
  blocks: [
    {
      id: "blk_1",
      type: "paragraph",
      alignment: "left",
      runs: [{ text: "Alpha content", marks: { color: "#f0a" } }],
    },
  ],
  createdBy: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-11-28T00:00:00.000Z",
  updatedAt: "2026-11-28T00:00:00.000Z",
};

describe("WP-4 Frontend, Accessibility, DOCX Fidelity & Khmer Hardening", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("F-17 & F-18: restricts governance roles, cancels stale async responses, resets diff on revision change, enforces maxLength & accessible Planned tab descriptions", async () => {
    // 1. F-17: billing_admin role renders Read-Only and does NOT call /api/documents
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchCalls.push(url);
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "ok", authMode: "jwt-pg" }), { status: 200 });
        }
        if (url.includes("/api/auth/me")) {
          return new Response(
            JSON.stringify({
              actor: {
                tenantId: DOC_A.tenantId,
                workspaceId: DOC_A.workspaceId,
                userId: "user-billing",
                role: "billing_admin",
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Role: billing_admin/)).toBeTruthy();
    });
    expect(fetchCalls.some((u) => u.includes("/api/documents"))).toBe(false);

    // F-18: Planned studio buttons retain exact names while exposing Planned description
    for (const label of ["Spreadsheets", "Presentations", "Intelligence BI"]) {
      const btn = screen.getByRole("button", { name: label });
      expect(btn.getAttribute("aria-describedby")).toBeTruthy();
      expect(btn.getAttribute("aria-description")).toContain("Planned");
      const descId = btn.getAttribute("aria-describedby")!;
      expect(document.getElementById(descId)?.textContent).toContain("Planned");
    }

    cleanup();

    // Verify auditor role cannot create/save/export when clicking Files & Docs rail
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "ok", authMode: "jwt-pg" }), { status: 200 });
        }
        if (url.includes("/api/auth/me")) {
          return new Response(
            JSON.stringify({
              actor: {
                tenantId: DOC_A.tenantId,
                workspaceId: DOC_A.workspaceId,
                userId: "user-auditor",
                role: "auditor",
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Role: auditor/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Files & Docs/i }));
    const exportPdfBtn = screen.getByRole("menuitem", { name: /Export PDF/i }) as HTMLButtonElement;
    expect(exportPdfBtn.disabled).toBe(true);

    cleanup();

    // 2. F-17: AiVoicePanel aborts stale plan when documentId changes & enforces maxLength=2000
    let resolvePendingPlan!: (val: Response) => void;
    let planAborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          resolvePendingPlan = resolve;
          init?.signal?.addEventListener("abort", () => {
            planAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }),
    );

    const { rerender } = render(
      <AiVoicePanel
        documentId={DOC_A.documentId}
        revision={2}
        readOnly={false}
        selectedText="Alpha content"
        onDocumentUpdated={async () => {}}
        apiHeaders={{}}
      />,
    );
    const cmdBox = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(cmdBox.maxLength).toBe(2000);
    fireEvent.change(cmdBox, { target: { value: "make bold" } });
    fireEvent.click(screen.getByRole("button", { name: "Plan Operation" }));

    // Switch document mid-flight -> aborts prior request and discards response
    rerender(
      <AiVoicePanel
        documentId="99999999-9999-4999-8999-999999999999"
        revision={1}
        readOnly={false}
        selectedText="Beta content"
        onDocumentUpdated={async () => {}}
        apiHeaders={{}}
      />,
    );
    resolvePendingPlan(
      new Response(
        JSON.stringify({
          proposal: {
            operationId: "op_stale",
            documentId: DOC_A.documentId,
            expectedRevision: 2,
            action: "bold",
            params: {},
            requestedBy: "u1",
            riskLevel: "low",
            requiresApproval: true,
            source: "typed_ai",
            inputLanguage: "en",
            outputLanguage: "en",
            originalCommand: "make bold",
            explanation: "Stale explanation",
            previewDiff: { beforeText: "a", afterText: "b", summary: "s" },
            createdAt: "2026-11-28T00:00:00.000Z",
          },
        }),
        { status: 200 },
      ),
    );
    await waitFor(() => {
      expect(planAborted).toBe(true);
    });
    expect(screen.queryByText(/Stale explanation/)).toBeNull();

    cleanup();

    // 3. F-17: VersionAuditDrawer resets diffResult when currentRevision changes
    const onCompare = vi.fn(async () => ({
      documentId: DOC_A.documentId,
      fromRevision: 1,
      toRevision: 2,
      metadataChanged: { titleChanged: false, languageChanged: false, layoutChanged: false },
      summary: { added: 1, removed: 0, modified: 0, unchanged: 0 },
      blocks: [{ blockId: "b1", blockType: "paragraph", changeType: "added" as const, afterText: "Old diff line" }],
    }));
    const v1 = {
      versionId: "v1",
      documentId: DOC_A.documentId,
      revision: 1,
      snapshot: DOC_A,
      summary: "Rev 1",
      source: "manual" as const,
      actorId: "u1",
      createdAt: "2026-11-28T00:00:00.000Z",
    };
    const v2 = { ...v1, versionId: "v2", revision: 2, summary: "Rev 2" };
    const drawerRender = render(
      <VersionAuditDrawer
        versions={[v1, v2]}
        auditEvents={[]}
        currentRevision={2}
        readOnly={false}
        onRestore={async () => {}}
        onCompareRevision={onCompare}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    await waitFor(() => {
      expect(screen.getByText(/Diff: Rev 1 → Rev 2/)).toBeTruthy();
    });
    drawerRender.rerender(
      <VersionAuditDrawer
        versions={[v1, v2, { ...v1, versionId: "v3", revision: 3, summary: "Rev 3" }]}
        auditEvents={[]}
        currentRevision={3}
        readOnly={false}
        onRestore={async () => {}}
        onCompareRevision={onCompare}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Diff: Rev 1 → Rev 2/)).toBeNull();

    cleanup();

    // 4. F-17: WorkspaceSubPanel header/footer maxLength=300
    render(
      <WorkspaceSubPanel
        panelId="page_fonts"
        onClose={() => {}}
        authMode="provisional-local"
        sessionActor={null}
        prototypeRole="editor"
        readOnly={false}
        activeDoc={DOC_A}
        apiHeaders={{}}
        onRoleChange={() => {}}
        onLogout={async () => {}}
        onLayoutChange={() => {}}
        onLanguageChange={() => {}}
      />,
    );
    expect((screen.getByDisplayValue("Header") as HTMLInputElement).maxLength).toBe(300);
    expect((screen.getByDisplayValue("Footer") as HTMLInputElement).maxLength).toBe(300);

    // 5. F-18: CSS coarse-pointer touch target rule includes fixed-header-btn, vertical-subheader-btn, doc-item
    const css = readFileSync(path.resolve("apps/web/src/styles.css"), "utf8");
    const coarseMatch = css.match(/@media \(max-width: 640px\), \(pointer: coarse\)\s*\{[\s\S]*?\}\s*\}/);
    expect(coarseMatch?.[0]).toContain(".fixed-header-btn");
    expect(coarseMatch?.[0]).toContain(".vertical-subheader-btn");
    expect(coarseMatch?.[0]).toContain(".doc-item");
  });

  it("F-28: unifies OOXML validation, fixes DOCX entity/nested/span fidelity, accepts Khmer subscript independent vowels & guards NaN offsets", async () => {
    // 1. Single-source OOXML header validation parity
    const invalidBytes = Buffer.from("NOT_ZIP");
    expect(validateDocxUploadBytes("test.docx", invalidBytes)).toEqual(
      validateOoxmlUploadHeader("test.docx", invalidBytes, "docx"),
    );

    // 2. Single-pass HTML entity decoder (no double-unescaping) + numeric code points
    expect(decodeHtmlEntities("&amp;lt;script&amp;gt; &#6114; &#x1780;")).toBe("&lt;script&gt; ២ ក");

    // 3. Nested HTML structures, h4 headings, colspan & rowspan preservation
    const blocks = htmlToStudioBlocks(
      `<h4>Subheading Four</h4><table><tr><th colspan="2">Merged Header</th><th rowspan="2">Tall</th></tr><tr><td>A</td><td>B</td></tr></table><ul><li>Outer<ul><li>Nested</li></ul></li></ul>`,
    );
    expect(blocks[0]).toMatchObject({ type: "heading", level: 3 });
    expect(blocks[1]).toMatchObject({ type: "table" });
    if (blocks[1]?.type === "table") {
      expect(blocks[1].rows[0]?.[0]?.colspan).toBe(2);
      expect(blocks[1].rows[0]?.[1]?.rowspan).toBe(2);
    }
    expect(blocks[2]).toMatchObject({ type: "bullet_list" });

    // 4. DOCX CSS color normalization + table colspan/rowspan export round-trip
    expect(normalizeDocxHexColor("#f0a")).toBe("FF00AA");
    expect(normalizeDocxHexColor("rgb(15, 23, 42)")).toBe("0F172A");
    expect(normalizeDocxHexColor("navy")).toBe("000080");
    expect(normalizeDocxHexColor("invalid()")).toBeUndefined();

    const spanDoc: StudioDocument = {
      ...DOC_A,
      blocks: [
        {
          id: "tbl_span",
          type: "table",
          hasHeaderRow: true,
          rows: [
            [{ runs: [{ text: "Wide Header", marks: { color: "#f0a" } }], colspan: 2 }],
            [{ runs: [{ text: "L" }] }, { runs: [{ text: "R" }] }],
          ],
        },
      ],
    };
    const docxBuf = await exportToDocxBuffer(spanDoc);
    const reimported = await importFromDocxBuffer({
      buffer: docxBuf,
      filename: "span.docx",
      tenantId: DOC_A.tenantId,
      workspaceId: DOC_A.workspaceId,
      actorId: DOC_A.createdBy,
    });
    expect(reimported.document.blocks.some((b) => b.type === "table")).toBe(true);

    // 5. Khmer COENG subscript independent vowel (U+17D2 + U+17AA / U+17B1) + NaN snap guard
    const khmerSubscriptVowel = "ឩ\u17D2\u17AA និង ក\u17D2\u17A5";
    const analysis = analyzeKhmerText(khmerSubscriptVowel);
    expect(analysis.coengSubscriptCount).toBe(2);
    expect(analysis.danglingCoengCount).toBe(0);

    expect(() => snapRangeToGraphemeBoundaries("ខ្មែរ", Number.NaN, 2)).toThrowError(RangeError);
    expect(() => snapRangeToGraphemeBoundaries("ខ្មែរ", 0, Number.POSITIVE_INFINITY)).toThrowError(RangeError);
  });
});
