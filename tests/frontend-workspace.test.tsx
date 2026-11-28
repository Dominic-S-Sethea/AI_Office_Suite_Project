// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import { fromTiptapJson, toTiptapJson, type TiptapNode } from "@ai-office-suite/document-engine/tiptap-codec";
import { DocumentEditor } from "../apps/web/src/components/DocumentEditor.tsx";
import { VersionAuditDrawer } from "../apps/web/src/components/VersionAuditDrawer.tsx";
import { AiVoicePanel } from "../apps/web/src/components/AiVoicePanel.tsx";
import { ErrorBoundary } from "../apps/web/src/components/ErrorBoundary.tsx";
import { NewDocumentModal } from "../apps/web/src/components/NewDocumentModal.tsx";
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

  it("Wave 5B (H25, H26, M14, M15, M16): verifies ErrorBoundary, NewDocumentModal Escape/inline error, aria-pressed, offline retry, pagination, and voice provenance/offsets", async () => {
    // H25: ErrorBoundary catches render crashes cleanly and provides recovery controls
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error("Simulated Tiptap render crash");
    }
    render(
      <ErrorBoundary scopeLabel="Document Editor">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Document Editor encountered an error");
    expect(screen.getByText(/Simulated Tiptap render crash/)).toBeTruthy();
    consoleErr.mockRestore();
    cleanup();

    // H26 & M14: NewDocumentModal closes on Escape and shows inline error message
    const onModalClose = vi.fn();
    render(
      <NewDocumentModal
        title="Q4 Report"
        language="bilingual"
        size="A4"
        orientation="portrait"
        isCreating={false}
        errorMessage="Title already exists"
        onTitleChange={() => {}}
        onLanguageChange={() => {}}
        onSizeChange={() => {}}
        onOrientationChange={() => {}}
        onSubmit={async () => {}}
        onClose={onModalClose}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Title already exists");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onModalClose).toHaveBeenCalledTimes(1);
    cleanup();

    // H26 & M15: DocumentEditor exposes aria-pressed on formatting buttons and honest scroll-view footer
    render(
      <DocumentEditor
        document={sampleBilingualDoc}
        tiptapContent={toTiptapJson(sampleBilingualDoc) as unknown as Record<string, unknown>}
        readOnly={false}
        onSelectionChange={() => {}}
      />,
    );
    await waitFor(() => {
      const boldBtn = screen.getByRole("button", { name: "Bold" });
      expect(boldBtn.getAttribute("aria-pressed")).toMatch(/^(true|false)$/);
    });
    expect(screen.getByText(/Scroll View \(Paginated on PDF Export\)/)).toBeTruthy();
    cleanup();

    // M16: AiVoicePanel forwards NFC startOffset/endOffset and preserves voice_command provenance on transcript edit
    let capturedPlanBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/speech/transcribe")) {
          return new Response(
            JSON.stringify({
              recognition: {
                provider: "mock",
                isMock: true,
                language: "en-US",
                transcript: "make bold",
                confidence: 0.99,
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/ai/plan")) {
          capturedPlanBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
            status: 429,
            headers: { "Retry-After": "12" },
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    render(
      <AiVoicePanel
        documentId={sampleBilingualDoc.documentId}
        revision={2}
        readOnly={false}
        selectionBlockId="blk_para_en"
        selectedText="Operational"
        selectionGraphemeCount={11}
        selectionStartOffset={0}
        selectionEndOffset={11}
        onDocumentUpdated={async () => {}}
        apiHeaders={{}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mock EN Voice" }));
    await waitFor(() => {
      expect(screen.getByText(/^Voice$/)).toBeTruthy();
    });
    // Edit transcript -> provenance MUST stay voice_command (not silently reset to typed_ai)
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "make bold please" } });
    expect(screen.getByText(/Voice \(edited\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Plan Operation" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("wait 12s");
    });
    const planBody = capturedPlanBody as Record<string, unknown> | null;
    expect(planBody?.source).toBe("voice_command");
    expect((planBody?.selection as Record<string, unknown>)?.startOffset).toBe(0);
    expect((planBody?.selection as Record<string, unknown>)?.endOffset).toBe(11);
    cleanup();

    // M14 & M15 & H26: App renders offline retry screen on API failure, then recovers on Retry + shows pagination & aria-current
    let healthAttempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          healthAttempt++;
          if (healthAttempt === 1) {
            throw new Error("ECONNREFUSED");
          }
          return new Response(JSON.stringify({ status: "ok", authMode: "provisional-local" }), { status: 200 });
        }
        if (url.includes("/api/documents")) {
          return new Response(JSON.stringify({ documents: [sampleBilingualDoc], total: 65 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Workspace API Unreachable/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry Connection" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "AI Office Suite" })).toBeTruthy();
      expect(screen.getByRole("navigation", { name: "Document pagination" })).toBeTruthy();
    });
    const activeDocBtn = screen.getByRole("button", { name: /Monthly Report/ });
    expect(activeDocBtn.getAttribute("aria-current")).toBe("true");
    expect(screen.getByLabelText("Import DOCX file")).toBeTruthy();
  });

  it("TF-11: covers apiClient.ts utilities (safeReadJson, formatApiErrorMessage 429/503/fallback, arrayBufferToBase64, focus trap)", async () => {
    const apiClient = await import("../apps/web/src/lib/apiClient.ts");

    expect(apiClient.MAX_DOCX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);

    // safeReadJson valid & malformed JSON fallback
    const okJson = await apiClient.safeReadJson(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(okJson.ok).toBe(true);
    const badJson = await apiClient.safeReadJson(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    expect(badJson.error).toBe("Request failed with HTTP 502");

    // formatApiErrorMessage: 429 with header, 429 without valid header, 503 SERVICE_BUSY, generic fallback
    expect(
      apiClient.formatApiErrorMessage(
        new Response("", { status: 429, headers: { "Retry-After": "15" } }),
        {},
        "Fallback",
      ),
    ).toContain("wait 15s");
    expect(
      apiClient.formatApiErrorMessage(new Response("", { status: 429 }), {}, "Fallback"),
    ).toContain("wait a moment");
    expect(
      apiClient.formatApiErrorMessage(
        new Response("", { status: 503, headers: { "Retry-After": "7" } }),
        { code: "SERVICE_BUSY" },
        "Fallback",
      ),
    ).toContain("retry in 7s");
    expect(
      apiClient.formatApiErrorMessage(new Response("", { status: 400 }), { error: "Custom error" }, "Fallback"),
    ).toBe("Custom error");
    expect(
      apiClient.formatApiErrorMessage(new Response("", { status: 500 }), {}, "Fallback message"),
    ).toBe("Fallback message");

    // arrayBufferToBase64 multi-byte roundtrip
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    expect(apiClient.arrayBufferToBase64(bytes.buffer)).toBe("SGVsbG8=");

    // Focus trap utility (Tab forward & Shift+Tab backward wrapping inside modal container)
    const modal = document.createElement("div");
    const btn1 = document.createElement("button");
    btn1.textContent = "First";
    const btn2 = document.createElement("button");
    btn2.textContent = "Last";
    modal.appendChild(btn1);
    modal.appendChild(btn2);
    document.body.appendChild(modal);
    Object.defineProperty(btn1, "offsetParent", { value: modal, configurable: true });
    Object.defineProperty(btn2, "offsetParent", { value: modal, configurable: true });

    expect(apiClient.getFocusableElements(modal)).toHaveLength(2);
    btn2.focus();
    const tabForward = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    apiClient.trapDialogTabKey(modal, tabForward);
    expect(tabForward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btn1);

    btn1.focus();
    const tabBack = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    apiClient.trapDialogTabKey(modal, tabBack);
    expect(tabBack.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btn2);

    // Non-Tab key or null container is a safe no-op
    const escEv = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    apiClient.trapDialogTabKey(modal, escEv);
    expect(escEv.defaultPrevented).toBe(false);
    document.body.removeChild(modal);
  });

  it("TF-11 / VOC-T27 / VOC-T28: exercises AiVoicePanel keyboard Ctrl+Enter, dictation mode, PTT mic lifecycle & unmount cleanup, approve/reject, undo, 401 & 409", async () => {
    const onDocumentUpdated = vi.fn(async () => {});
    const onRevisionConflict = vi.fn();
    const onUnauthorized = vi.fn();
    const stopTrackSpy = vi.fn();

    // 1. Mock getUserMedia -> start PTT -> unmount cleans up active microphone stream immediately (VOC-T27)
    const originalMediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopTrackSpy }],
        })),
      },
    });

    const mockProposal = {
      operationId: "op-ui-1",
      documentId: sampleBilingualDoc.documentId,
      expectedRevision: 2,
      action: "insert_text",
      params: { text: "Quarterly update" },
      requestedBy: "u1",
      riskLevel: "low",
      requiresApproval: true,
      source: "typed_ai",
      inputLanguage: "en",
      outputLanguage: "en",
      originalCommand: 'insert "Quarterly update"',
      explanation: "Insert dictated text into paragraph.",
      previewDiff: {
        targetBlockId: "blk_para_en",
        beforeText: "Operational summary",
        afterText: "Operational summary Quarterly update",
      },
      createdAt: "2026-11-26T00:00:00.000Z",
    };

    let applyStatus = 200;
    let planStatus = 200;
    let transcribeStatus = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/speech/transcribe")) {
          if (transcribeStatus === 401) return new Response(JSON.stringify({ error: "Expired" }), { status: 401 });
          return new Response(
            JSON.stringify({
              recognition: {
                provider: "mock",
                isMock: true,
                language: "km-KH",
                transcript: "បញ្ចូលតារាង ៣x៣",
                confidence: 0.99,
                disclaimer: "Mock adapter",
              },
            }),
            { status: transcribeStatus },
          );
        }
        if (url.includes("/ai/plan")) {
          if (planStatus === 401) return new Response(JSON.stringify({ error: "Expired" }), { status: 401 });
          if (planStatus === 409) return new Response(JSON.stringify({ error: "Stale rev" }), { status: 409 });
          return new Response(JSON.stringify({ proposal: mockProposal }), { status: 200 });
        }
        if (url.includes("/ai/apply")) {
          if (applyStatus === 401) return new Response(JSON.stringify({ error: "Expired" }), { status: 401 });
          if (applyStatus === 409) return new Response(JSON.stringify({ error: "Conflict on apply" }), { status: 409 });
          return new Response(JSON.stringify({ document: sampleBilingualDoc }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const { unmount } = render(
      <AiVoicePanel
        documentId={sampleBilingualDoc.documentId}
        revision={2}
        readOnly={false}
        selectionBlockId="blk_para_en"
        selectedText="Operational"
        onDocumentUpdated={onDocumentUpdated}
        onRevisionConflict={onRevisionConflict}
        onUnauthorized={onUnauthorized}
        apiHeaders={{ "x-test": "1" }}
      />,
    );

    // Start PTT mic -> verify active status -> unmount stops track (VOC-T27)
    fireEvent.click(screen.getByRole("button", { name: "Mic Test (Mock STT)" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Stop & Run Mock STT/ })).toBeTruthy();
    });
    unmount();
    expect(stopTrackSpy).toHaveBeenCalledTimes(1);

    // 2. Full interactive & keyboard flow (VOC-T28): language/mode selectors, Ctrl+Enter plan, Reject, Approve & Apply, Undo
    render(
      <AiVoicePanel
        documentId={sampleBilingualDoc.documentId}
        revision={2}
        readOnly={false}
        selectionBlockId="blk_para_en"
        selectedText="Operational"
        onDocumentUpdated={onDocumentUpdated}
        onRevisionConflict={onRevisionConflict}
        onUnauthorized={onUnauthorized}
        apiHeaders={{}}
      />,
    );

    // Switch input language to km, output to en, mode to dictation
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0]!, { target: { value: "km" } });
    fireEvent.change(selects[1]!, { target: { value: "en" } });
    fireEvent.change(selects[2]!, { target: { value: "dictation" } });

    // Start & Stop PTT runs Mock STT cleanly
    fireEvent.click(screen.getByRole("button", { name: "Mic Test (Mock STT)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Stop & Run Mock STT/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Stop & Run Mock STT/ }));
    await waitFor(() => expect(screen.getByText(/SIMULATED \(isMock: true\)/)).toBeTruthy());

    // Type text and trigger Ctrl+Enter keyboard shortcut (VOC-T28)
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "" } });
    fireEvent.change(textbox, { target: { value: "Quarterly update" } });
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByText(/Proposed Action: insert_text/)).toBeTruthy());

    // Reject clears proposal cleanly
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.queryByText(/Proposed Action: insert_text/)).toBeNull();

    // Plan again & Approve & Apply
    fireEvent.click(screen.getByRole("button", { name: "Plan Operation" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve & Apply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve & Apply" }));
    await waitFor(() => expect(onDocumentUpdated).toHaveBeenCalledTimes(1));

    // Apply 409 conflict & 401 unauthorized paths
    fireEvent.click(screen.getByRole("button", { name: "Undo Last Change" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve & Apply" })).toBeTruthy());
    applyStatus = 409;
    fireEvent.click(screen.getByRole("button", { name: "Approve & Apply" }));
    await waitFor(() => expect(onRevisionConflict).toHaveBeenCalled());

    planStatus = 401;
    fireEvent.click(screen.getByRole("button", { name: "Plan Operation" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());

    transcribeStatus = 401;
    fireEvent.click(screen.getByRole("button", { name: "Mock KM Voice" }));
    await waitFor(() => expect(onUnauthorized.mock.calls.length).toBeGreaterThanOrEqual(2));

    // Denied microphone permission shows safe status and preserves text controls (VOC-T01)
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new Error("PermissionDeniedError");
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mic Test (Mock STT)" }));
    await waitFor(() => {
      expect(screen.getByText(/Microphone permission denied or unavailable/)).toBeTruthy();
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("3-Zone UI/UX Rework: preserves Top Master Studio Headers, opens Left Fixed-Header animated vertical Sub-Header accordions with Escape dismissal, runs Data Prep subpanel, and renders Center Workspace AI Dock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "ok", authMode: "provisional-local" }), { status: 200 });
        }
        if (url.includes("/api/documents")) {
          return new Response(JSON.stringify({ documents: [sampleBilingualDoc], total: 1 }), { status: 200 });
        }
        if (url.includes("/api/data-prep/stage-and-profile")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          if (!parsedBody.filename || !parsedBody.csvText || parsedBody.profileScope !== "full") {
            return new Response(JSON.stringify({ error: "Invalid data-prep staging payload", code: "VALIDATION_ERROR" }), { status: 400 });
          }
          return new Response(
            JSON.stringify({ profile: { datasetId: "ds_workspace_preview", scope: "full", totalRows: 4 } }),
            { status: 200 },
          );
        }
        if (url.includes("/versions")) {
          return new Response(
            JSON.stringify({
              versions: [
                {
                  versionId: "ver_1",
                  documentId: sampleBilingualDoc.documentId,
                  revision: 1,
                  source: "seed",
                  summary: "Seeded bilingual fixture",
                  actorId: "user_editor",
                  createdAt: "2026-11-26T02:16:43Z",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/audit")) {
          return new Response(
            JSON.stringify({
              events: [
                {
                  auditId: "aud_1",
                  action: "document.seed_bilingual",
                  outcome: "success",
                  summary: "Seeded fixture",
                  actorId: "user_editor",
                  actorRole: "editor",
                  source: "manual",
                  createdAt: "2026-11-26T02:16:43Z",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "Workspace Studios" })).toBeTruthy();
      expect(screen.getByRole("navigation", { name: "Workspace Sections" })).toBeTruthy();
    });

    // 1. All 4 Master Studio Headers remain in the top bar
    expect(screen.getByRole("button", { name: "Document Studio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Spreadsheets" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Presentations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Intelligence BI" })).toBeTruthy();

    // 2. Clicking a Left Fixed-Header opens its vertical downward accordion; switching collapses previous; Escape closes it
    const filesHeader = screen.getByRole("menuitem", { name: /Files & Docs/ });
    const dataHeader = screen.getByRole("menuitem", { name: /Data & Analytics/ });
    expect(filesHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu", { name: "Files & Docs sub-headers" })).toBeNull();

    fireEvent.click(filesHeader);
    expect(filesHeader.getAttribute("aria-expanded")).toBe("true");
    const filesMenu = screen.getByRole("menu", { name: "Files & Docs sub-headers" });
    expect(filesMenu.className).toContain("vertical-dropdown-wrap");
    expect(filesMenu.className).toContain("is-open");
    expect(screen.getByRole("menuitem", { name: "+ New Blank" })).toBeTruthy();

    // Clicking another Fixed-Header collapses Files & Docs smoothly and opens Data & Analytics vertically
    fireEvent.click(dataHeader);
    expect(filesHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu", { name: "Files & Docs sub-headers" })).toBeNull();
    expect(dataHeader.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "Data & Analytics sub-headers" })).toBeTruthy();

    // Escape closes the open vertical accordion when no modal is open
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dataHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu", { name: "Data & Analytics sub-headers" })).toBeNull();

    // 3. Exclusive sub-header active states: Certified Metrics does not mark DuckDB 1M Spill active
    fireEvent.click(dataHeader);
    const certBtn = screen.getByRole("menuitem", { name: /Certified Metrics/ });
    const duckBtn = screen.getByRole("menuitem", { name: /DuckDB 1M Spill/ });
    fireEvent.click(certBtn);
    expect(certBtn.className).toContain("is-active");
    expect(duckBtn.className).not.toContain("is-active");

    // Open Stage & Profile -> keeps section open & runs live profile endpoint inside Center Workspace
    fireEvent.click(screen.getByRole("menuitem", { name: /Stage & Profile/ }));
    expect(dataHeader.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run Stage & Profile" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Run Stage & Profile" }));
    await waitFor(() => {
      expect(screen.getByText(/ds_workspace_preview/)).toBeTruthy();
    });

    // 4. Versions & Audit -> Audit Trail opens cleanly, Escape closes drawer first without sticking or collapsing sidebar
    const versionsHeader = screen.getByRole("menuitem", { name: /Versions & Audit/ });
    fireEvent.click(versionsHeader);
    const auditBtn = screen.getByRole("menuitem", { name: /Audit Trail/ }) as HTMLButtonElement;
    await waitFor(
      () => {
        expect(auditBtn.disabled).toBe(false);
      },
      { timeout: 5000 },
    );
    fireEvent.click(auditBtn);
    await waitFor(
      () => {
        expect(screen.getByRole("dialog", { name: "Version & Audit History" })).toBeTruthy();
      },
      { timeout: 5000 },
    );
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Version & Audit History" })).toBeNull();
    });
    // Left accordion stays open after Escape dismissed only the modal
    expect(versionsHeader.getAttribute("aria-expanded")).toBe("true");

    // 5. Center Workspace contains the integrated AI & Voice Assistant Dock (starts compact, expands on click)
    const workspaceMain = screen.getByRole("main", { name: "Center Workspace" });
    await waitFor(() => {
      expect(workspaceMain.querySelector('[aria-label="AI and Voice Assistant"]')).toBeTruthy();
    });
    const expandBtn = screen.getByRole("button", { name: "Expand AI Controls" });
    fireEvent.click(expandBtn);
    expect(screen.getByRole("button", { name: "Compact Dock" })).toBeTruthy();
    expect(screen.getByText(/Explicit Mock Disclosure \(isMock: true\)/)).toBeTruthy();
  });

  it("Impeccable UI Remediation: enforces 2-step restore guardrail, RBAC read-only explainability, bilingual lang, ARIA tabpanel, and LeftNavRail arrow keys", async () => {
    const onClose = vi.fn();
    const onRestore = vi.fn(async () => {});

    // 1. VersionAuditDrawer 2-step restore confirmation (clean + dirty) & WAI-ARIA tabpanel/ArrowRight
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
        hasUnsavedChanges={true}
        effectiveRole="editor"
        onRestore={onRestore}
        onClose={onClose}
      />,
    );

    const allTab = screen.getByRole("tab", { name: "All" });
    expect(allTab.getAttribute("aria-controls")).toBe("history-tabpanel");
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Versions" }).getAttribute("aria-selected")).toBe("true");

    // Clicking Restore opens inline confirmation instead of mutating immediately
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByText(/Unsaved edits on the current document will be discarded/)).toBeTruthy();

    // First Escape dismisses only the restore confirmation, keeping the drawer open
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm Restore" })).toBeNull();

    // Confirm Restore executes onRestore once
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Restore" }));
    await waitFor(() => {
      expect(onRestore).toHaveBeenCalledWith(1);
    });
    cleanup();

    // 2. VersionAuditDrawer read-only Viewer banner & aria-describedby
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
            summary: "Current",
            source: "manual",
            actorId: "u1",
            createdAt: "2026-11-25T01:00:00.000Z",
          },
        ]}
        auditEvents={[]}
        currentRevision={2}
        readOnly={true}
        canReadAudit={false}
        effectiveRole="viewer"
        onRestore={onRestore}
        onClose={onClose}
      />,
    );
    expect(
      screen.getByText(/Read-only role \(Viewer\): Restoring revisions, exporting, and reading the audit log \(audit:read\) are disabled/),
    ).toBeTruthy();
    expect(screen.getByText(/Audit log inspection requires Reviewer, Editor, Auditor, or Owner permission/)).toBeTruthy();
    const disabledRestore = screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(disabledRestore.disabled).toBe(true);
    expect(disabledRestore.getAttribute("aria-describedby")).toBe("drawer-readonly-notice");
    cleanup();

    // 3. DocumentEditor read-only Reviewer banner + bilingual lang scoping (en with data-doc-language="bilingual")
    const { container } = render(
      <DocumentEditor
        document={sampleBilingualDoc}
        tiptapContent={toTiptapJson(sampleBilingualDoc) as unknown as Record<string, unknown>}
        readOnly={true}
        effectiveRole="reviewer"
        onSelectionChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Read-Only Mode \(reviewer\):/)).toBeTruthy();
    });
    const boldBtn = screen.getByRole("button", { name: "Bold" }) as HTMLButtonElement;
    expect(boldBtn.disabled).toBe(true);
    expect(boldBtn.getAttribute("aria-describedby")).toBe("editor-readonly-notice");
    expect(boldBtn.getAttribute("title")).toContain("Reviewer");
    const sheet = container.querySelector(".page-sheet");
    expect(sheet?.getAttribute("lang")).toBe("en");
    expect(sheet?.getAttribute("data-doc-language")).toBe("bilingual");
    cleanup();

    // 4. App LeftNavRail ArrowDown/ArrowRight/ArrowLeft + Viewer Save tooltip & Read-Only badge + Viewer Version History
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "ok", authMode: "provisional-local" }), { status: 200 });
        }
        if (url.includes("/api/documents") && url.includes("/versions")) {
          return new Response(
            JSON.stringify({
              versions: [
                {
                  versionId: "v1",
                  documentId: sampleBilingualDoc.documentId,
                  revision: 1,
                  snapshot: sampleBilingualDoc,
                  summary: "Initial revision",
                  source: "manual",
                  actorId: "u1",
                  createdAt: "2026-11-25T00:00:00.000Z",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/documents") && url.includes("/audit")) {
          return new Response(JSON.stringify({ error: "Role viewer is not authorized for audit:read." }), {
            status: 403,
          });
        }
        if (url.includes("/api/documents")) {
          return new Response(JSON.stringify({ documents: [sampleBilingualDoc], total: 1 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /Files & Docs/ })).toBeTruthy();
      expect(screen.getByLabelText("Document title")).toBeTruthy();
    });

    const filesHeader = screen.getByRole("menuitem", { name: /Files & Docs/ });
    const layoutHeader = screen.getByRole("menuitem", { name: /Page & Style/ });
    filesHeader.focus();
    fireEvent.keyDown(filesHeader, { key: "ArrowDown" });
    expect(document.activeElement).toBe(layoutHeader);

    fireEvent.keyDown(layoutHeader, { key: "ArrowRight" });
    expect(layoutHeader.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => {
      const pageSizeItem = screen.getByRole("menuitem", { name: /Page Size/ });
      expect(document.activeElement).toBe(pageSizeItem);
    });
    const pageSizeItem = screen.getByRole("menuitem", { name: /Page Size/ });
    fireEvent.keyDown(pageSizeItem, { key: "ArrowLeft" });
    expect(layoutHeader.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(layoutHeader);

    // Switch role to Viewer and verify Save tooltip does not advertise Ctrl+S while disabled
    fireEvent.click(screen.getByRole("button", { name: /Role: editor/ }));
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Workspace role selector" })).toBeTruthy();
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace role selector" }), {
      target: { value: "viewer" },
    });
    await waitFor(() => {
      expect(screen.getByText("Read-Only (viewer)")).toBeTruthy();
    });
    const saveBtn = screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.getAttribute("title")).toContain("Viewer");
    expect(saveBtn.getAttribute("title")).not.toContain("Ctrl+S");

    // Viewer can open Version History without 403 failure, while Audit Trail explains audit:read restriction
    fireEvent.click(screen.getByRole("menuitem", { name: /Versions & Audit/ }));
    const auditBtn = screen.getByRole("menuitem", { name: /Audit Trail/ }) as HTMLButtonElement;
    expect(auditBtn.disabled).toBe(true);
    expect(auditBtn.getAttribute("title")).toContain("audit:read");

    fireEvent.click(screen.getByRole("menuitem", { name: /Version History/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Version & Audit History" })).toBeTruthy();
      expect(screen.getByText(/Initial revision/)).toBeTruthy();
    });
  });
});

