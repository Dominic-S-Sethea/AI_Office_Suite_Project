// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import { fromTiptapJson, toTiptapJson, type TiptapNode } from "@ai-office-suite/document-engine/tiptap-codec";
import { DocumentEditor } from "../apps/web/src/components/DocumentEditor.tsx";
import { VersionAuditDrawer } from "../apps/web/src/components/VersionAuditDrawer.tsx";
import { AiVoicePanel } from "../apps/web/src/components/AiVoicePanel.tsx";
import { App } from "../apps/web/src/App.tsx";

const sampleBilingualDoc: StudioDocument = {
  documentId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  title: "របាយការណ៍ប្រចាំខែ · Monthly Report",
  language: "bilingual",
  revision: 2,
  status: "draft",
  layout: {
    size: "A4",
    orientation: "portrait",
    marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
    headerText: "AI Office Suite",
    footerText: "Confidential",
    showPageNumbers: true,
  },
  blocks: [
    {
      id: "blk_h1",
      type: "heading",
      level: 1,
      alignment: "left",
      runs: [{ text: "របាយការណ៍គ្រប់គ្រង", marks: { bold: true, fontFamily: "Kantumruy Pro", fontSizePt: 18 } }],
    },
    {
      id: "blk_para_en",
      type: "paragraph",
      alignment: "left",
      runs: [{ text: "Operational summary for Phnom Penh branch." }],
    },
    {
      id: "blk_para_km",
      type: "paragraph",
      alignment: "left",
      runs: [{ text: "នាយកដ្ឋានហិរញ្ញវត្ថុបានបញ្ចប់ការផ្ទៀងផ្ទាត់។", marks: { fontFamily: "Noto Sans Khmer" } }],
    },
    {
      id: "blk_metric_1",
      type: "linked_metric_placeholder",
      metric: {
        datasetId: "ds_fin",
        datasetVersion: "v1",
        metricId: "net_profit",
        metricVersion: "v1",
        reportingPeriod: "2026-11",
        filterContext: { region: "All" },
        unit: "USD",
        currency: "USD",
        approvalStatus: "certified",
        freshnessTimestamp: "2026-11-25T00:00:00.000Z",
        mode: "published_snapshot",
        displayLabel: "Net Profit",
        cachedFormattedValue: "$38,500.00",
      },
    },
    {
      id: "blk_tbl_1",
      type: "table",
      hasHeaderRow: true,
      rows: [
        [
          { runs: [{ text: "Dept" }], colspan: 2 },
          { runs: [{ text: "Actual" }] },
        ],
        [
          { runs: [{ text: "Finance" }] },
          { runs: [{ text: "HQ" }] },
          { runs: [{ text: "$10,000.00" }] },
        ],
      ],
    },
  ],
  createdBy: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
};

describe("Wave 1 Frontend & Tiptap Codec Verification (C8 & C9)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("C8: preserves blockId, atomic linkedMetricPlaceholder, fontSizePt, and colspan even when a new paragraph is inserted above a metric", () => {
    const tiptap = toTiptapJson(sampleBilingualDoc);
    // Verify linked_metric_placeholder uses dedicated atomic node type (not plain paragraph)
    expect(tiptap.content?.[3]?.type).toBe("linkedMetricPlaceholder");
    expect(tiptap.content?.[3]?.attrs?.blockId).toBe("blk_metric_1");

    // Simulate user pressing Enter above blk_para_km, shifting blk_para_km into index 3 (old index of blk_metric_1!)
    const mutatedTiptap: TiptapNode = {
      type: "doc",
      content: [
        tiptap.content![0]!,
        tiptap.content![1]!,
        { type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "Inserted line above Khmer" }] },
        tiptap.content![2]!, // blk_para_km is now at index 3!
        tiptap.content![3]!, // blk_metric_1 is now at index 4!
        tiptap.content![4]!, // blk_tbl_1 is now at index 5!
      ],
    };

    const roundTripped = fromTiptapJson(mutatedTiptap, sampleBilingualDoc.blocks);
    expect(roundTripped).toHaveLength(6);

    // Critically: index 3 must remain the user's Khmer paragraph (NOT overwritten by linked_metric_placeholder!)
    expect(roundTripped[3]?.type).toBe("paragraph");
    expect(roundTripped[3]?.id).toBe("blk_para_km");
    if (roundTripped[3]?.type === "paragraph") {
      expect(roundTripped[3].runs[0]?.text).toContain("នាយកដ្ឋានហិរញ្ញវត្ថុ");
    }

    // Index 4 must preserve the atomic linked_metric_placeholder intact
    expect(roundTripped[4]?.type).toBe("linked_metric_placeholder");
    expect(roundTripped[4]?.id).toBe("blk_metric_1");
    if (roundTripped[4]?.type === "linked_metric_placeholder") {
      expect(roundTripped[4].metric.cachedFormattedValue).toBe("$38,500.00");
    }

    // Heading fontSizePt & table colspan preserved
    if (roundTripped[0]?.type === "heading") {
      expect(roundTripped[0].runs[0]?.marks?.fontSizePt).toBe(18);
    }
    if (roundTripped[5]?.type === "table") {
      expect(roundTripped[5].rows[0]?.[0]?.colspan).toBe(2);
    }
  });

  it("C8 & C9: mounts DocumentEditor with real Tiptap/ProseMirror, renders atomic metric pill & formatting toolbar", async () => {
    const onDocChange = vi.fn();
    const onSelectionChange = vi.fn();
    const tiptapContent = toTiptapJson(sampleBilingualDoc) as unknown as Record<string, unknown>;

    const { container } = render(
      <DocumentEditor
        document={sampleBilingualDoc}
        tiptapContent={tiptapContent}
        readOnly={false}
        onDocChange={onDocChange}
        onSelectionChange={onSelectionChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("toolbar", { name: "Document formatting toolbar" })).toBeTruthy();
    });
    // Atomic linkedMetricPlaceholder renders non-editable metric pill node with preserved data-block-id
    const metricEl = container.querySelector('[data-type="linked-metric-placeholder"]');
    expect(metricEl).toBeTruthy();
    expect(metricEl?.getAttribute("data-block-id")).toBe("blk_metric_1");
    expect(metricEl?.textContent).toContain("Net Profit");
    expect(metricEl?.textContent).toContain("$38,500.00");
  });

  it("C9: renders VersionAuditDrawer with diff trigger and Escape dismissal, plus AiVoicePanel mock disclosure & read-only guard", async () => {
    const onClose = vi.fn();
    const onRestore = vi.fn(async () => {});
    const onCompare = vi.fn(async () => ({
      documentId: sampleBilingualDoc.documentId,
      fromRevision: 1,
      toRevision: 2,
      metadataChanged: { titleChanged: false, languageChanged: false, layoutChanged: false },
      summary: { added: 1, removed: 0, modified: 0, unchanged: 4 },
      blocks: [{ blockId: "blk_new", blockType: "paragraph", changeType: "added" as const, afterText: "Added line" }],
    }));

    render(
      <VersionAuditDrawer
        versions={[
          {
            versionId: "v1",
            documentId: sampleBilingualDoc.documentId,
            revision: 1,
            snapshot: sampleBilingualDoc,
            summary: "Initial",
            source: "manual",
            actorId: "u1",
            createdAt: "2026-11-25T00:00:00.000Z",
          },
          {
            versionId: "v2",
            documentId: sampleBilingualDoc.documentId,
            revision: 2,
            snapshot: sampleBilingualDoc,
            summary: "Second",
            source: "manual",
            actorId: "u1",
            createdAt: "2026-11-25T01:00:00.000Z",
          },
        ]}
        auditEvents={[]}
        currentRevision={2}
        readOnly={false}
        onRestore={onRestore}
        onCompareRevision={onCompare}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    await waitFor(() => {
      expect(screen.getByText(/Diff: Rev 1 → Rev 2/)).toBeTruthy();
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();

    render(
      <AiVoicePanel
        documentId={sampleBilingualDoc.documentId}
        revision={2}
        readOnly={true}
        selectedText="Test"
        onDocumentUpdated={async () => {}}
        apiHeaders={{}}
      />,
    );
    expect(screen.getByText(/Explicit Mock Disclosure \(isMock: true\)/)).toBeTruthy();
    expect(screen.getByText(/Read-only role active/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Plan Operation" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("C9: App detects jwt-pg auth mode, renders sign-in form, and handles unauthenticated boot cleanly", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/health")) {
        return new Response(JSON.stringify({ status: "ok", authMode: "jwt-pg" }), { status: 200 });
      }
      if (url.includes("/api/auth/me")) {
        return new Response(JSON.stringify({ error: "Missing token" }), { status: 401 });
      }
      return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Sign In \(PostgreSQL RLS Session\)/)).toBeTruthy();
    });
    expect(screen.getByPlaceholderText("editor@company.example")).toBeTruthy();
  });
});
