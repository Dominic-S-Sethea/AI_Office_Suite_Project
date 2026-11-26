import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from "react";
import { Extension, mergeAttributes, Node as TiptapCustomNode } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import { Color, FontFamily, TextStyle } from "@tiptap/extension-text-style";
import Placeholder from "@tiptap/extension-placeholder";
import type { DocumentBlock, LinkedMetricReference, StudioDocument } from "@ai-office-suite/shared-contracts";

const BlockIdAndFontSizeExtension = Extension.create({
  name: "blockIdAndFontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "bulletList", "orderedList", "table", "horizontalRule"],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-block-id"),
            renderHTML: (attributes) => {
              if (!attributes.blockId) return {};
              return { "data-block-id": String(attributes.blockId) };
            },
          },
        },
      },
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${String(attributes.fontSize)}` };
            },
          },
        },
      },
    ];
  },
});

const LinkedMetricPlaceholderNode = TiptapCustomNode.create({
  name: "linkedMetricPlaceholder",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      blockId: { default: null },
      metric: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="linked-metric-placeholder"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const metric = node.attrs.metric as LinkedMetricReference | null;
    const label = metric
      ? `[Linked Metric · ${metric.displayLabel}: ${metric.cachedFormattedValue} (${metric.mode})]`
      : "[Linked Metric Placeholder]";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "linked-metric-placeholder",
        "data-block-id": node.attrs.blockId ?? "",
        contenteditable: "false",
        class: "metric-pill-node",
      }),
      label,
    ];
  },
});

export interface EditorSelectionState {
  blockId?: string;
  selectedText: string;
  graphemeCount?: number;
  startOffset?: number;
  endOffset?: number;
}

export interface DocumentEditorHandle {
  getCurrentTiptapJson: () => Record<string, unknown> | null;
}

interface DocumentEditorProps {
  document: StudioDocument;
  tiptapContent: Record<string, unknown>;
  readOnly: boolean;
  onDocChange?: (tiptapJson: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSelectionChange: (sel: EditorSelectionState) => void;
}

const khmerGraphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("km", { granularity: "grapheme" })
    : null;

function countGraphemes(text: string): number {
  const normalized = text.normalize("NFC");
  if (!normalized) return 0;
  if (!khmerGraphemeSegmenter) return Array.from(normalized).length;
  let count = 0;
  for (const _seg of khmerGraphemeSegmenter.segment(normalized)) {
    count++;
  }
  return count;
}

function findCurrentBlockId(
  blocks: DocumentBlock[],
  selectedText: string,
  anchorIndex: number,
  nodeAttrBlockId?: string | null,
): string | undefined {
  if (typeof nodeAttrBlockId === "string" && nodeAttrBlockId.trim()) {
    return nodeAttrBlockId.trim();
  }
  const trimmed = selectedText.normalize("NFC").trim();
  if (trimmed) {
    const matched = blocks.find((b) => {
      if (b.type === "paragraph" || b.type === "heading") {
        return b.runs
          .map((r) => r.text)
          .join("")
          .normalize("NFC")
          .includes(trimmed);
      }
      return false;
    });
    if (matched) return matched.id;
  }
  const candidate = blocks[Math.max(0, Math.min(anchorIndex, blocks.length - 1))];
  return candidate?.id ?? blocks[0]?.id;
}

const DocumentEditorInner = forwardRef<DocumentEditorHandle, DocumentEditorProps>(function DocumentEditorInner(
  { document, tiptapContent, readOnly, onDocChange, onDirtyChange, onSelectionChange },
  ref,
) {
  const blocksRef = useRef<DocumentBlock[]>(document.blocks);
  const onDocChangeRef = useRef(onDocChange);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const isDirtyRef = useRef(false);
  const lastSyncedKeyRef = useRef<string>(`${document.documentId}:${document.revision}`);

  useEffect(() => {
    blocksRef.current = document.blocks;
  }, [document.blocks]);

  useEffect(() => {
    onDocChangeRef.current = onDocChange;
  }, [onDocChange]);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      BlockIdAndFontSizeExtension,
      LinkedMetricPlaceholderNode,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      FontFamily,
      Color,
      Placeholder.configure({
        placeholder: "Start typing in English or ភាសាខ្មែរ...",
      }),
    ],
    content: tiptapContent,
    onUpdate({ editor: ed }) {
      // Notify parent once on clean -> dirty transition to avoid per-keystroke tree serialization (H24)
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        onDirtyChangeRef.current?.(true);
      }
      if (onDocChangeRef.current) {
        onDocChangeRef.current(ed.getJSON() as Record<string, unknown>);
      }
    },
    onSelectionUpdate({ editor: ed }) {
      const { from, to } = ed.state.selection;
      const selectedText = ed.state.doc.textBetween(from, to, " ").normalize("NFC");
      const resolvedFrom = ed.state.doc.resolve(from);
      const topIndex = resolvedFrom.index(0);
      const topNode = topIndex >= 0 && topIndex < ed.state.doc.childCount ? ed.state.doc.child(topIndex) : null;
      const attrBlockId = typeof topNode?.attrs?.blockId === "string" ? topNode.attrs.blockId : null;

      let startOffset: number | undefined;
      let endOffset: number | undefined;
      if (to > from && resolvedFrom.depth >= 1) {
        const blockStartPos = resolvedFrom.start(1);
        const blockEndPos = resolvedFrom.end(1);
        if (to <= blockEndPos) {
          startOffset = ed.state.doc.textBetween(blockStartPos, from, "\n").normalize("NFC").length;
          endOffset = ed.state.doc.textBetween(blockStartPos, to, "\n").normalize("NFC").length;
        }
      }

      onSelectionChangeRef.current({
        blockId: findCurrentBlockId(blocksRef.current, selectedText, topIndex, attrBlockId),
        selectedText,
        graphemeCount: countGraphemes(selectedText),
        ...(startOffset !== undefined && endOffset !== undefined ? { startOffset, endOffset } : {}),
      });
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      getCurrentTiptapJson: () => (editor ? (editor.getJSON() as Record<string, unknown>) : null),
    }),
    [editor],
  );

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor) return;
    const nextKey = `${document.documentId}:${document.revision}`;
    if (lastSyncedKeyRef.current !== nextKey) {
      editor.commands.setContent(tiptapContent, { emitUpdate: false });
      lastSyncedKeyRef.current = nextKey;
      isDirtyRef.current = false;
    }
  }, [editor, document.revision, document.documentId, tiptapContent]);

  const activeFont = (editor?.getAttributes("textStyle")?.fontFamily as string | undefined) ?? "";
  const sheetClasses = [
    "page-sheet",
    document.layout.size === "Letter" ? "letter" : "",
    document.layout.orientation === "landscape" ? "landscape" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const isParagraph = editor?.isActive("paragraph") ?? false;
  const isH1 = editor?.isActive("heading", { level: 1 }) ?? false;
  const isH2 = editor?.isActive("heading", { level: 2 }) ?? false;
  const isH3 = editor?.isActive("heading", { level: 3 }) ?? false;
  const isBold = editor?.isActive("bold") ?? false;
  const isItalic = editor?.isActive("italic") ?? false;
  const isUnderline = editor?.isActive("underline") ?? false;
  const isAlignLeft = editor?.isActive({ textAlign: "left" }) ?? false;
  const isAlignCenter = editor?.isActive({ textAlign: "center" }) ?? false;
  const isAlignRight = editor?.isActive({ textAlign: "right" }) ?? false;
  const isAlignJustify = editor?.isActive({ textAlign: "justify" }) ?? false;
  const isBulletList = editor?.isActive("bulletList") ?? false;
  const isOrderedList = editor?.isActive("orderedList") ?? false;

  return (
    <div className="editor-container">
      {editor && (
        <div
          className="toolbar editor-formatting-toolbar"
          role="toolbar"
          aria-label="Document formatting toolbar"
        >
          <button
            type="button"
            className="btn"
            disabled={readOnly || !editor.can().undo()}
            onClick={() => editor.chain().focus().undo().run()}
          >
            Undo
          </button>
          <button
            type="button"
            className="btn"
            disabled={readOnly || !editor.can().redo()}
            onClick={() => editor.chain().focus().redo().run()}
          >
            Redo
          </button>
          <button
            type="button"
            className={`btn ${isParagraph ? "active" : ""}`}
            aria-pressed={isParagraph}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setParagraph().run()}
          >
            Normal
          </button>
          <button
            type="button"
            className={`btn ${isH1 ? "active" : ""}`}
            aria-pressed={isH1}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            H1
          </button>
          <button
            type="button"
            className={`btn ${isH2 ? "active" : ""}`}
            aria-pressed={isH2}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </button>
          <button
            type="button"
            className={`btn ${isH3 ? "active" : ""}`}
            aria-pressed={isH3}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            H3
          </button>
          <button
            type="button"
            className={`btn ${isBold ? "active" : ""}`}
            aria-pressed={isBold}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            Bold
          </button>
          <button
            type="button"
            className={`btn ${isItalic ? "active" : ""}`}
            aria-pressed={isItalic}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            Italic
          </button>
          <button
            type="button"
            className={`btn ${isUnderline ? "active" : ""}`}
            aria-pressed={isUnderline}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            Underline
          </button>
          <button
            type="button"
            className={`btn ${isAlignLeft ? "active" : ""}`}
            aria-pressed={isAlignLeft}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("left").run()}
          >
            Left
          </button>
          <button
            type="button"
            className={`btn ${isAlignCenter ? "active" : ""}`}
            aria-pressed={isAlignCenter}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("center").run()}
          >
            Center
          </button>
          <button
            type="button"
            className={`btn ${isAlignRight ? "active" : ""}`}
            aria-pressed={isAlignRight}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("right").run()}
          >
            Right
          </button>
          <button
            type="button"
            className={`btn ${isAlignJustify ? "active" : ""}`}
            aria-pressed={isAlignJustify}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("justify").run()}
          >
            Justify
          </button>
          <button
            type="button"
            className={`btn ${isBulletList ? "active" : ""}`}
            aria-pressed={isBulletList}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            Bullets
          </button>
          <button
            type="button"
            className={`btn ${isOrderedList ? "active" : ""}`}
            aria-pressed={isOrderedList}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            Numbered
          </button>
          <button
            type="button"
            className="btn"
            disabled={readOnly}
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            + Table 3×3
          </button>
          <select
            className="btn"
            disabled={readOnly}
            aria-label="Font family"
            value={activeFont}
            onChange={(e) => {
              if (e.target.value) {
                editor.chain().focus().setFontFamily(e.target.value).run();
              } else {
                editor.chain().focus().unsetFontFamily().run();
              }
            }}
          >
            <option value="">Font (EN/KM Default)</option>
            <option value="Noto Sans Khmer">Noto Sans Khmer</option>
            <option value="Kantumruy Pro">Kantumruy Pro</option>
            <option value="Inter">Inter</option>
          </select>
        </div>
      )}

      <div className={sheetClasses} lang={document.language === "en" ? "en" : "km"}>
        <div className="page-header-footer top">
          <span>{document.layout.headerText}</span>
          <span>
            {document.layout.size} · {document.layout.orientation}
          </span>
        </div>
        <EditorContent editor={editor} />
        <div className="page-header-footer bottom">
          <span>{document.layout.footerText}</span>
          <span>
            Rev {document.revision}
            {document.layout.showPageNumbers ? " · Scroll View (Paginated on PDF Export)" : ""}
          </span>
        </div>
      </div>
    </div>
  );
});

export const DocumentEditor = memo(DocumentEditorInner);
