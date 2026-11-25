import type {
  DocumentBlock,
  StudioDocument,
  TextAlignment,
  TextRun,
} from "@ai-office-suite/shared-contracts";

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

function browserSafeId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function runsToTiptapNodes(runs: TextRun[]): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [];
    if (run.marks?.bold) marks.push({ type: "bold" });
    if (run.marks?.italic) marks.push({ type: "italic" });
    if (run.marks?.underline) marks.push({ type: "underline" });
    if (run.marks?.highlight) marks.push({ type: "highlight", attrs: { color: run.marks.highlight } });
    if (run.marks?.fontFamily || run.marks?.color) {
      marks.push({
        type: "textStyle",
        attrs: {
          ...(run.marks.fontFamily ? { fontFamily: run.marks.fontFamily } : {}),
          ...(run.marks.color ? { color: run.marks.color } : {}),
        },
      });
    }
    nodes.push({
      type: "text",
      text: run.text,
      ...(marks.length > 0 ? { marks } : {}),
    });
  }
  return nodes;
}

export function toTiptapJson(doc: StudioDocument): TiptapNode {
  const content: TiptapNode[] = [];
  for (const block of doc.blocks) {
    if (block.type === "paragraph") {
      const inner = runsToTiptapNodes(block.runs);
      content.push({
        type: "paragraph",
        attrs: { textAlign: block.alignment ?? "left", blockId: block.id },
        ...(inner.length > 0 ? { content: inner } : {}),
      });
    } else if (block.type === "heading") {
      const inner = runsToTiptapNodes(block.runs);
      content.push({
        type: "heading",
        attrs: { level: block.level, textAlign: block.alignment ?? "left", blockId: block.id },
        ...(inner.length > 0 ? { content: inner } : {}),
      });
    } else if (block.type === "bullet_list" || block.type === "ordered_list") {
      content.push({
        type: block.type === "bullet_list" ? "bulletList" : "orderedList",
        content: block.items.map((runs) => {
          const inner = runsToTiptapNodes(runs);
          return {
            type: "listItem",
            content: [{ type: "paragraph", ...(inner.length > 0 ? { content: inner } : {}) }],
          };
        }),
      });
    } else if (block.type === "table") {
      content.push({
        type: "table",
        content: block.rows.map((row, rowIdx) => ({
          type: "tableRow",
          content: row.map((cell) => {
            const inner = runsToTiptapNodes(cell.runs);
            return {
              type: block.hasHeaderRow && rowIdx === 0 ? "tableHeader" : "tableCell",
              content: [{ type: "paragraph", ...(inner.length > 0 ? { content: inner } : {}) }],
            };
          }),
        })),
      });
    } else if (block.type === "page_break") {
      content.push({ type: "horizontalRule" });
    } else if (block.type === "linked_metric_placeholder") {
      content.push({
        type: "paragraph",
        attrs: { textAlign: "left", blockId: block.id },
        content: [
          {
            type: "text",
            marks: [{ type: "highlight", attrs: { color: "#fef3c7" } }],
            text: `[Planned Metric · ${block.metric.displayLabel}: ${block.metric.cachedFormattedValue} (${block.metric.mode})]`,
          },
        ],
      });
    }
  }
  return { type: "doc", content };
}

function tiptapInlineToRuns(nodes?: TiptapNode[]): TextRun[] {
  if (!nodes || nodes.length === 0) return [{ text: "" }];
  const runs: TextRun[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      runs.push({ text: "\n" });
      continue;
    }
    if (node.type !== "text" || typeof node.text !== "string") continue;
    const marks: TextRun["marks"] = {};
    for (const m of node.marks ?? []) {
      if (m.type === "bold") marks.bold = true;
      if (m.type === "italic") marks.italic = true;
      if (m.type === "underline") marks.underline = true;
      if (m.type === "highlight") marks.highlight = String(m.attrs?.color ?? "#fef08a");
      if (m.type === "textStyle") {
        if (typeof m.attrs?.fontFamily === "string") marks.fontFamily = m.attrs.fontFamily;
        if (typeof m.attrs?.color === "string") marks.color = m.attrs.color;
      }
    }
    runs.push({
      text: node.text.normalize("NFC"),
      ...(Object.keys(marks).length > 0 ? { marks } : {}),
    });
  }
  return runs.length > 0 ? runs : [{ text: "" }];
}

export function fromTiptapJson(
  tiptapDoc: TiptapNode,
  existingBlocks: DocumentBlock[] = [],
): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const usedIds = new Set<string>();
  const existingIds = existingBlocks.map((b) => b.id);
  const content = tiptapDoc.content ?? [];

  for (let i = 0; i < content.length; i++) {
    const node = content[i]!;
    const attrId = typeof node.attrs?.blockId === "string" ? node.attrs.blockId : undefined;
    const fallbackId = existingIds[i];
    const candidateId =
      attrId && !usedIds.has(attrId)
        ? attrId
        : fallbackId && !usedIds.has(fallbackId)
          ? fallbackId
          : browserSafeId("blk");
    usedIds.add(candidateId);

    const existingBlock = existingBlocks.find((b) => b.id === candidateId);
    if (existingBlock?.type === "linked_metric_placeholder") {
      blocks.push(existingBlock);
      continue;
    }

    if (node.type === "paragraph") {
      blocks.push({
        id: candidateId,
        type: "paragraph",
        alignment: (node.attrs?.textAlign as TextAlignment | undefined) ?? "left",
        runs: tiptapInlineToRuns(node.content),
      });
    } else if (node.type === "heading") {
      const lvl = Number(node.attrs?.level ?? 1);
      blocks.push({
        id: candidateId,
        type: "heading",
        level: lvl === 2 ? 2 : lvl === 3 ? 3 : 1,
        alignment: (node.attrs?.textAlign as TextAlignment | undefined) ?? "left",
        runs: tiptapInlineToRuns(node.content),
      });
    } else if (node.type === "bulletList" || node.type === "orderedList") {
      const items = (node.content ?? []).map((li) => {
        const firstPara = li.content?.[0];
        return tiptapInlineToRuns(firstPara?.content);
      });
      blocks.push({
        id: candidateId,
        type: node.type === "bulletList" ? "bullet_list" : "ordered_list",
        items,
      });
    } else if (node.type === "table") {
      const rows = (node.content ?? []).map((tr) =>
        (tr.content ?? []).map((cell) => {
          const firstPara = cell.content?.[0];
          return { runs: tiptapInlineToRuns(firstPara?.content) };
        }),
      );
      const hasHeaderRow = (node.content?.[0]?.content ?? []).some((c) => c.type === "tableHeader");
      blocks.push({
        id: candidateId,
        type: "table",
        hasHeaderRow,
        rows,
      });
    } else if (node.type === "horizontalRule") {
      blocks.push({ id: candidateId, type: "page_break" });
    }
  }
  return blocks;
}
