import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import { Color, FontFamily, TextStyle } from "@tiptap/extension-text-style";
import Placeholder from "@tiptap/extension-placeholder";
import type { DocumentBlock, StudioDocument } from "@ai-office-suite/shared-contracts";

export interface EditorSelectionState {
  blockId?: string;
  selectedText: string;
  graphemeCount?: number;
}

interface DocumentEditorProps {
  document: StudioDocument;
  tiptapContent: Record<string, unknown>;
  readOnly: boolean;
  onDocChange: (tiptapJson: Record<string, unknown>) => void;
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

function findCurrentBlockId(blocks: DocumentBlock[], selectedText: string, anchorIndex: number): string | undefined {
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

export function DocumentEditor({
  document,
  tiptapContent,
  readOnly,
  onDocChange,
  onSelectionChange,
}: DocumentEditorProps) {
  // Keep latest blocks and callbacks in refs so ProseMirror listeners never capture stale closures
  const blocksRef = useRef<DocumentBlock[]>(document.blocks);
  const onDocChangeRef = useRef(onDocChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const lastSyncedKeyRef = useRef<string>(`${document.documentId}:${document.revision}`);

  useEffect(() => {
    blocksRef.current = document.blocks;
  }, [document.blocks]);

  useEffect(() => {
    onDocChangeRef.current = onDocChange;
  }, [onDocChange]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
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
      onDocChangeRef.current(ed.getJSON() as Record<string, unknown>);
    },
    onSelectionUpdate({ editor: ed }) {
      const { from, to } = ed.state.selection;
      const selectedText = ed.state.doc.textBetween(from, to, " ").normalize("NFC");
      const parentPos = ed.state.doc.resolve(from);
      const topIndex = parentPos.index(0);
      onSelectionChangeRef.current({
        blockId: findCurrentBlockId(blocksRef.current, selectedText, topIndex),
        selectedText,
        graphemeCount: countGraphemes(selectedText),
      });
    },
  });

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

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      {editor && (
        <div
          className="toolbar"
          role="toolbar"
          aria-label="Document formatting toolbar"
          style={{ width: "100%", justifyContent: "center", borderRadius: 8, border: "1px solid #cbd5e1" }}
        >
          <button type="button" className="btn" disabled={readOnly || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
            Undo
          </button>
          <button type="button" className="btn" disabled={readOnly || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
            Redo
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("paragraph") ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setParagraph().run()}
          >
            Normal
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("heading", { level: 1 }) ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            H1
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("heading", { level: 2 }) ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("heading", { level: 3 }) ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            H3
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("bold") ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            Bold
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("italic") ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            Italic
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("underline") ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            Underline
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive({ textAlign: "left" }) ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("left").run()}
          >
            Left
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive({ textAlign: "center" }) ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("center").run()}
          >
            Center
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive({ textAlign: "right" }) ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("right").run()}
          >
            Right
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive({ textAlign: "justify" }) ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("justify").run()}
          >
            Justify
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("bulletList") ? "active" : ""}`}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            Bullets
          </button>
          <button
            type="button"
            className={`btn ${editor.isActive("orderedList") ? "active" : ""}`}
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
            {document.layout.showPageNumbers ? " · Page 1" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
