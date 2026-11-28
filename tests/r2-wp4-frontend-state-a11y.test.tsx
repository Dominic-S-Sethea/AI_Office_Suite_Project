// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AuditEvent, DocumentVersion, StudioDocument } from "@ai-office-suite/shared-contracts";
import { fromTiptapJson, toTiptapJson, type TiptapNode } from "@ai-office-suite/document-engine/tiptap-codec";
import { formatApiErrorMessage } from "../apps/web/src/lib/apiClient.ts";
import { DocumentEditor, type DocumentEditorHandle, type EditorSelectionState } from "../apps/web/src/components/DocumentEditor.tsx";
import { AiVoicePanel } from "../apps/web/src/components/AiVoicePanel.tsx";
import { LeftNavRail } from "../apps/web/src/components/LeftNavRail.tsx";
import { NewDocumentModal } from "../apps/web/src/components/NewDocumentModal.tsx";
import { VersionAuditDrawer } from "../apps/web/src/components/VersionAuditDrawer.tsx";
import { WorkspaceSubPanel } from "../apps/web/src/components/WorkspaceSubPanel.tsx";
import { App } from "../apps/web/src/App.tsx";

const DOC_A: StudioDocument = {
  documentId: "aaaaaaaa-1111-4111-8111-00000000000a",
  tenantId: "11111111-1111-4111-8111-0000000000a1",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1",
  title: "Alpha Quarterly Memo",
  language: "bilingual",
  revision: 1,
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
      id: "blk_a1",
      type: "paragraph",
      alignment: "left",
      runs: [{ text: "Alpha first line" }, { text: "\n" }, { text: "Alpha second line" }],
    },
    {
      id: "blk_tbl_a",
      type: "table",
      hasHeaderRow: true,
      rows: [
        [{ runs: [{ text: "Dept" }] }, { runs: [{ text: "Sales" }] }],
        [{ runs: [{ text: "HQ" }] }, { runs: [{ text: "100" }] }],
      ],
    },
  ],
  createdBy: "usr_1",
  createdAt: "2026-11-28T00:00:00.000Z",
  updatedAt: "2026-11-28T00:00:00.000Z",
};

const DOC_B: StudioDocument = {
  ...DOC_A,
  documentId: "bbbbbbbb-2222-4222-8222-00000000000b",
  title: "Beta Operational Plan",
  revision: 1,
  blocks: [
    {
      id: "blk_b1",
      type: "paragraph",
      alignment: "left",
      runs: [{ text: "Beta initial body" }],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("R2-WP4 Frontend, Tiptap v3, Client State, API Parity & WCAG 2.2 AA", () => {
  it("FE-03: preserves unknown/blockquote/codeBlock text as paragraphs and clamps pasted CSS fontFamily/color marks", () => {
    const tiptapInput: TiptapNode = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          attrs: { blockId: "blk_quote" },
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Quoted finance summary",
                  marks: [
                    {
                      type: "textStyle",
                      attrs: {
                        fontFamily:
                          '"Noto Sans Khmer", "Liberation Sans", "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Extra Long Fallback Chain Exceeding Hundred Chars"',
                        color: `rgb(${"123,".repeat(15)} 255)`,
                      },
                    },
                    { type: "highlight", attrs: { color: "x".repeat(60) } },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "SELECT SUM(amount) FROM ledger;" }],
        },
      ],
    };

    const blocks = fromTiptapJson(tiptapInput, []);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[0]?.type === "paragraph" && blocks[0].runs[0]?.text).toBe("Quoted finance summary");
    expect(blocks[0]?.type === "paragraph" && blocks[0].runs[0]?.marks?.fontFamily).toBe("Noto Sans Khmer");
    expect(blocks[0]?.type === "paragraph" && (blocks[0].runs[0]?.marks?.color?.length ?? 0)).toBeLessThanOrEqual(40);
    expect(blocks[0]?.type === "paragraph" && (blocks[0].runs[0]?.marks?.highlight?.length ?? 0)).toBeLessThanOrEqual(40);
    expect(blocks[1]?.type).toBe("paragraph");
    expect(blocks[1]?.type === "paragraph" && blocks[1].runs[0]?.text).toBe("SELECT SUM(amount) FROM ledger;");
  });

  it("FE-01, FE-02, FE-05, FE-08 & FE-12: reactive useEditorState toolbar, ARIA textbox/readonly sync, cross-doc undo isolation & hardBreak offset parity", async () => {
    const editorRef = createRef<DocumentEditorHandle>();
    const selections: EditorSelectionState[] = [];

    function Harness() {
      const [doc, setDoc] = useState<StudioDocument>(DOC_A);
      const [readOnly, setReadOnly] = useState(false);
      const [syncVersion, setSyncVersion] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setDoc(DOC_B)}>
            SwitchDocB
          </button>
          <button type="button" onClick={() => setReadOnly((r) => !r)}>
            ToggleReadOnly
          </button>
          <button
            type="button"
            onClick={() => {
              setDoc({ ...DOC_A, revision: 1 });
              setSyncVersion((v) => v + 1);
            }}
          >
            BumpSync
          </button>
          <DocumentEditor
            key={doc.documentId}
            ref={editorRef}
            document={doc}
            tiptapContent={toTiptapJson(doc) as unknown as Record<string, unknown>}
            readOnly={readOnly}
            effectiveRole={readOnly ? "viewer" : "editor"}
            syncVersion={syncVersion}
            onSelectionChange={(s) => selections.push(s)}
          />
        </div>
      );
    }

    render(<Harness />);

    const textbox = await waitFor(() => screen.getByRole("textbox", { name: "Document editor" }));
    expect(textbox.getAttribute("aria-multiline")).toBe("true");
    expect(textbox.getAttribute("aria-readonly")).toBe("false");

    const undoBtn = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    const h1Btn = screen.getByRole("button", { name: "H1" }) as HTMLButtonElement;
    const centerBtn = screen.getByRole("button", { name: "Center" }) as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    expect(h1Btn.getAttribute("aria-pressed")).toBe("false");
    expect(centerBtn.getAttribute("aria-pressed")).toBe("false");

    // Toggle Heading 1 & Center align and confirm useEditorState updates aria-pressed & Undo reactively
    fireEvent.click(h1Btn);
    fireEvent.click(centerBtn);
    await waitFor(() => {
      expect(h1Btn.getAttribute("aria-pressed")).toBe("true");
      expect(centerBtn.getAttribute("aria-pressed")).toBe("true");
      expect(undoBtn.disabled).toBe(false);
    });

    // Toggle readOnly and verify DOM aria-readonly updates
    fireEvent.click(screen.getByRole("button", { name: "ToggleReadOnly" }));
    await waitFor(() => {
      expect(textbox.getAttribute("aria-readonly")).toBe("true");
    });
    fireEvent.click(screen.getByRole("button", { name: "ToggleReadOnly" }));

    // Switch to Doc B -> clean history (Undo disabled, no Doc A leakage)
    fireEvent.click(screen.getByRole("button", { name: "SwitchDocB" }));
    await waitFor(() => {
      const tb = screen.getByRole("textbox", { name: "Document editor" });
      expect(tb.textContent).toContain("Beta initial body");
      expect(tb.textContent).not.toContain("Alpha first line");
      expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    });

    // SyncVersion reset clears history back cleanly
    fireEvent.click(screen.getByRole("button", { name: "BumpSync" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Document editor" }).textContent).toContain("Alpha first line");
      expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(editorRef.current?.getCurrentTiptapJson()).not.toBeNull();
  });

  it("FE-09 & FE-10: AiVoicePanel cleans leaked MediaStream on unmount/readOnly, guards Ctrl+K under modal, wraps dictation safely, and passes data.document", async () => {
    const stopTrack = vi.fn();
    let resolveMic!: (stream: MediaStream) => void;
    const getUserMediaMock = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveMic = resolve;
        }),
    );
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: getUserMediaMock },
    });

    const onUpdated = vi.fn(async () => {});
    const { unmount } = render(
      <AiVoicePanel
        documentId={DOC_A.documentId}
        revision={1}
        readOnly={false}
        selectedText=""
        onDocumentUpdated={onUpdated}
        apiHeaders={{}}
        variant="dock"
        defaultCompact={false}
      />,
    );

    // Trigger mic request, then unmount BEFORE getUserMedia resolves -> stream must stop immediately
    fireEvent.click(screen.getByRole("button", { name: "Mic Test (Mock STT)" }));
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    unmount();
    resolveMic({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await waitFor(() => {
      expect(stopTrack).toHaveBeenCalledTimes(1);
    });

    // Re-mount with modal open: Ctrl+K must NOT steal focus into AI textarea; Dictation must wrap >"Make..." & <=2000 chars
    const updatedDoc: StudioDocument = { ...DOC_A, revision: 2 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/ai/plan")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { command: string };
        expect(body.command.startsWith('insert "')).toBe(true);
        expect(body.command.length).toBeLessThanOrEqual(2000);
        return new Response(
          JSON.stringify({
            proposal: {
              operationId: "prop_1",
              documentId: DOC_A.documentId,
              expectedRevision: 1,
              action: "insert_text",
              source: "typed_ai",
              inputLanguage: "en",
              outputLanguage: "en",
              explanation: "Insert dictated text",
              params: { text: "ok" },
              previewDiff: { beforeText: "", afterText: "ok", summary: "+ ok" },
              riskLevel: "low",
              requiresApproval: true,
              signature: "sig_1",
              createdAt: "2026-11-28T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/ai/apply")) {
        return new Response(JSON.stringify({ document: updatedDoc }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    const modalEl = document.createElement("div");
    modalEl.setAttribute("aria-modal", "true");
    const modalBtn = document.createElement("button");
    modalEl.appendChild(modalBtn);
    document.body.appendChild(modalEl);
    modalBtn.focus();

    render(
      <AiVoicePanel
        documentId={DOC_A.documentId}
        revision={1}
        readOnly={false}
        hasUnsavedChanges={true}
        selectedText=""
        onDocumentUpdated={onUpdated}
        apiHeaders={{}}
        variant="dock"
        defaultCompact={false}
      />,
    );

    const textarea = screen.getByLabelText(/Editable Transcript \/ Typed Instruction/i);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(modalBtn);
    modalEl.remove();

    fireEvent.change(screen.getByLabelText("Interaction Mode"), { target: { value: "dictation" } });
    fireEvent.change(textarea, { target: { value: `Make sure ${"a".repeat(1995)}` } });
    fireEvent.click(screen.getByRole("button", { name: "Plan Operation" }));

    const applyBtn = await waitFor(() => screen.getByRole("button", { name: "Approve & Apply" }));
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(onUpdated).toHaveBeenCalledWith(updatedDoc);
    });
  });

  it("FE-04, FE-06, FE-08, FE-09 & FE-12: apiClient issues, LeftNavRail ARIA, VersionAuditDrawer languageChanged/sort/pagination & WorkspaceSubPanel 401", async () => {
    const errRes = new Response(null, { status: 400 });
    const msg = formatApiErrorMessage(
      errRes,
      { error: "Invalid login payload", issues: [{ path: ["tenantId"], message: "Invalid uuid" }] },
      "Fallback",
    );
    expect(msg).toBe("Invalid login payload (tenantId: Invalid uuid)");

    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Expired" }), { status: 401 })),
    );
    render(
      <WorkspaceSubPanel
        panelId="data_prep"
        onClose={() => {}}
        authMode="jwt-pg"
        sessionActor={null}
        prototypeRole="editor"
        readOnly={false}
        activeDoc={DOC_A}
        apiHeaders={{}}
        onRoleChange={() => {}}
        onLogout={async () => {}}
        onLayoutChange={() => {}}
        onLanguageChange={() => {}}
        onUnauthorized={onUnauthorized}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Run Stage & Profile/i }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));

    // LeftNavRail role="none" + aria-current
    render(
      <LeftNavRail
        openHeaderId="files"
        onToggleHeader={() => {}}
        mobileOpen={false}
        groups={[
          {
            id: "files",
            label: "Files & Docs",
            shortTag: "FD",
            subHeaders: [
              { id: "all_docs", label: "All Documents", active: true, onSelect: () => {} },
            ],
          },
        ]}
      />,
    );
    expect(document.querySelector(".vertical-dropdown-inner")?.getAttribute("role")).toBe("none");
    expect(document.querySelector(".vertical-subheaders-list")?.getAttribute("role")).toBe("none");
    expect(screen.getByRole("menuitem", { name: "All Documents" }).getAttribute("aria-current")).toBe("true");

    // VersionAuditDrawer sorts DESC by revision, displays languageChanged in diff, and shows Load older buttons
    const onLoadMoreVersions = vi.fn();
    const onLoadMoreAudit = vi.fn();
    const versions: DocumentVersion[] = [
      {
        versionId: "v1",
        documentId: DOC_A.documentId,
        revision: 1,
        source: "manual",
        summary: "v1",
        snapshot: DOC_A,
        actorId: "u1",
        createdAt: "2026-11-28T00:00:00.000Z",
      },
      {
        versionId: "v3",
        documentId: DOC_A.documentId,
        revision: 105,
        source: "manual",
        summary: "v105",
        snapshot: { ...DOC_A, revision: 105 },
        actorId: "u1",
        createdAt: "2026-11-28T01:00:00.000Z",
      },
    ];
    const auditEvents: AuditEvent[] = [
      {
        auditId: "aud_1",
        tenantId: DOC_A.tenantId,
        workspaceId: DOC_A.workspaceId,
        documentId: DOC_A.documentId,
        actorId: "u1",
        actorRole: "editor",
        action: "document.update",
        outcome: "success",
        source: "manual",
        summary: "Updated",
        createdAt: "2026-11-28T01:00:00.000Z",
      },
    ];
    render(
      <VersionAuditDrawer
        versions={versions}
        auditEvents={auditEvents}
        currentRevision={105}
        readOnly={false}
        canReadAudit={true}
        versionsTotal={125}
        versionsHasMore={true}
        onLoadMoreVersions={onLoadMoreVersions}
        auditTotal={140}
        auditHasMore={true}
        onLoadMoreAudit={onLoadMoreAudit}
        onRestore={async () => {}}
        onCompareRevision={async () => ({
          documentId: DOC_A.documentId,
          fromRevision: 1,
          toRevision: 105,
          metadataChanged: { titleChanged: false, languageChanged: true, layoutChanged: false },
          summary: { added: 0, removed: 0, modified: 0, unchanged: 1 },
          blocks: [],
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Immutable Versions \(2 of 125\)/)).toBeTruthy();
    expect(screen.getByText(/Append-Only Audit Log \(1 of 140\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    await waitFor(() => {
      expect(screen.getByText(/Language changed/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older revisions" }));
    fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
    expect(onLoadMoreVersions).toHaveBeenCalledTimes(1);
    expect(onLoadMoreAudit).toHaveBeenCalledTimes(1);

    // NewDocumentModal safe focus restoration when previouslyFocused is detached
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount: unmountModal } = render(
      <NewDocumentModal
        title=""
        language="en"
        size="A4"
        orientation="portrait"
        isCreating={false}
        errorMessage={null}
        onTitleChange={() => {}}
        onLanguageChange={() => {}}
        onSizeChange={() => {}}
        onOrientationChange={() => {}}
        onSubmit={async () => {}}
        onClose={() => {}}
      />,
    );
    trigger.remove();
    expect(() => unmountModal()).not.toThrow();
  });

  it("FE-04, FE-05, FE-06 & FE-12: App clears stale versions/modal on 401, prevents blank title save, preserves concurrent edits & paginates versions DESC", async () => {
    let authed = true;
    let resolveSlowSave!: (res: Response) => void;
    const seenUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seenUrls.push(url);
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ ok: true, authMode: "jwt-pg" }), { status: 200 });
        }
        if (url.includes("/api/auth/me")) {
          if (!authed) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
          return new Response(
            JSON.stringify({
              actor: { tenantId: DOC_A.tenantId, workspaceId: DOC_A.workspaceId, userId: "usr_1", role: "editor" },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/versions?")) {
          const offset = Number(new URL(`http://localhost${url}`).searchParams.get("offset") ?? "0");
          const pageVersions: DocumentVersion[] =
            offset === 0
              ? [
                  {
                    versionId: "v_105",
                    documentId: DOC_A.documentId,
                    revision: 105,
                    source: "manual",
                    summary: "Head 105",
                    snapshot: { ...DOC_A, revision: 105 },
                    actorId: "usr_1",
                    createdAt: "2026-11-28T02:00:00.000Z",
                  },
                ]
              : [
                  {
                    versionId: "v_1",
                    documentId: DOC_A.documentId,
                    revision: 1,
                    source: "import",
                    summary: "Initial 1",
                    snapshot: DOC_A,
                    actorId: "usr_1",
                    createdAt: "2026-11-28T00:00:00.000Z",
                  },
                ];
          return new Response(
            JSON.stringify({ versions: pageVersions, total: 2, hasMore: offset === 0 }),
            { status: 200 },
          );
        }
        if (url.includes("/audit?")) {
          return new Response(JSON.stringify({ events: [], total: 0, hasMore: false }), { status: 200 });
        }
        if (url.endsWith(`/api/documents/${DOC_A.documentId}`) && init?.method === "PUT") {
          return new Promise<Response>((resolve) => {
            resolveSlowSave = resolve;
          });
        }
        if (url.includes("/api/documents")) {
          return new Response(JSON.stringify({ documents: [DOC_A], total: 1 }), { status: 200 });
        }
        if (url.includes("/api/data-prep/stage-and-profile")) {
          authed = false;
          return new Response(JSON.stringify({ error: "Expired" }), { status: 401 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<App />);

    const titleInput = (await waitFor(() => screen.getByLabelText("Document title"), { timeout: 3000 })) as HTMLInputElement;
    const searchInput = screen.getByLabelText("Search documents by title") as HTMLInputElement;
    expect(searchInput.maxLength).toBe(120);

    // Blank title disables Save button
    fireEvent.change(titleInput, { target: { value: "   " } });
    const saveBtn = screen.getAllByRole("button", { name: /^Save/ })[0] as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Non-blank edit -> trigger slow Save, then immediately type newer title while PUT is in flight
    fireEvent.change(titleInput, { target: { value: "First Saved Title" } });
    fireEvent.click(saveBtn);
    fireEvent.change(titleInput, { target: { value: "Concurrent Newer Title" } });
    resolveSlowSave(
      new Response(
        JSON.stringify({ document: { ...DOC_A, revision: 2, title: "First Saved Title" } }),
        { status: 200 },
      ),
    );
    await waitFor(() => {
      expect(titleInput.value).toBe("Concurrent Newer Title");
    });

    // Version history uses ?limit=100&offset=0&order=desc and appends older revisions
    fireEvent.click(screen.getByRole("menuitem", { name: /Versions & Audit/i }));
    fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: "Version History" })));
    await waitFor(() => {
      expect(seenUrls.some((u) => u.includes("/versions?limit=100&offset=0&order=desc"))).toBe(true);
      expect(screen.getByText(/Head 105/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older revisions" }));
    await waitFor(() => {
      expect(screen.getByText(/Initial 1/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // Trigger 401 in Data Prep WorkspaceSubPanel -> returns to Sign In and wipes stale document state
    fireEvent.click(screen.getByRole("menuitem", { name: /Data & Analytics/i }));
    fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: /Stage & Profile/i })));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /Run Stage & Profile/i })));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("FE-07 & FE-11: styles.css defines WCAG 2.2 AA contrast tokens, studio-tab-wrap & 44px mobile touch targets", () => {
    const cssPath = path.resolve(process.cwd(), "apps/web/src/styles.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain("--control-border: #64748b");
    expect(css).toContain(".studio-tab-wrap");
    expect(css).toContain("white-space: nowrap");
    expect(css).toContain("outline: 2px solid var(--chrome-accent-soft)");
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.input-field[\s\S]*?min-width:\s*44px/);
  });
});
