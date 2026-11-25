import { useEffect } from "react";
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
}

interface DocumentEditorProps {
  document: StudioDocument;
  tiptapContent: Record<string, unknown>;
  readOnly: boolean;
  onDocChange: (tiptapJson: Record<string, unknown>) => void;
  onSelectionChange: (sel: EditorSelectionState) => void;
}

function findCurrentBlockId(blocks: DocumentBlock[], selectedText: string, anchorIndex: number): string | undefined {
  if (selectedText.trim()) {
    const matched = blocks.find((b) => {
      if (b.type === "paragraph" || b.type === "heading") {
        return b.runs.map((r) => r.text).join("").includes(selectedText.trim());
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
      onDocChange(ed.getJSON() as Record<string, unknown>);
    },
    onSelectionUpdate({ editor: ed }) {
      const { from, to } = ed.state.selection;
      const selectedText = ed.state.doc.textBetween(from, to, " ");
      const parentPos = ed.state.doc.resolve(from);
      const topIndex = parentPos.index(0);
      onSelectionChange({
        blockId: findCurrentBlockId(document.blocks, selectedText, topIndex),
        selectedText,
      });
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor) return;
    const currentJson = JSON.stringify(editor.getJSON());
    const nextJson = JSON.stringify(tiptapContent);
    if (currentJson !== nextJson) {
      editor.commands.setContent(tiptapContent, { emitUpdate: false });
    }
  }, [editor, document.revision, document.documentId, tiptapContent]);

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      {editor && (
        <div className="toolbar" style={{ width: "100%", justifyContent: "center", borderRadius: 8, border: "1px solid #cbd5e1" }}>
          <button type="button" className="btn" disabled={readOnly} onClick={() => editor.chain().focus().undo().run()}>
            Undo
          </button>
          <button type="button" className="btn" disabled={readOnly} onClick={() => editor.chain().focus().redo().run()}>
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
            className="btn"
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("left").run()}
          >
            Left
          </button>
          <button
            type="button"
            className="btn"
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("center").run()}
          >
            Center
          </button>
          <button
            type="button"
            className="btn"
            disabled={readOnly}
            onClick={() => editor.chain().focus().setTextAlign("right").run()}
          >
            Right
          </button>
          <button
            type="button"
            className="btn"
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            Bullets
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
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) editor.chain().focus().setFontFamily(e.target.value).run();
            }}
          >
            <option value="">Font (EN/KM)</option>
            <option value="Noto Sans Khmer">Noto Sans Khmer</option>
            <option value="Kantumruy Pro">Kantumruy Pro</option>
            <option value="Inter">Inter</option>
          </select>
        </div>
      )}

      <div className={`page-sheet ${document.layout.size === "Letter" ? "letter" : ""}`}>
        <div className="page-header-footer top">
          <span>{document.layout.headerText}</span>
          <span>{document.layout.size} · {document.layout.orientation}</span>
        </div>
        <EditorContent editor={editor} />
        <div className="page-header-footer bottom">
          <span>{document.layout.footerText}</span>
          <span>Rev {document.revision} · Page 1</span>
        </div>
      </div>
    </div>
  );
}
