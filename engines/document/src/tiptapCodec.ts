import type {
  DocumentBlock,
  LinkedMetricReference,
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
    if (run.marks?.fontFamily || run.marks?.color || typeof run.marks?.fontSizePt === "number") {
      marks.push({
        type: "textStyle",
        attrs: {
          ...(run.marks.fontFamily ? { fontFamily: run.marks.fontFamily } : {}),
          ...(run.marks.color ? { color: run.marks.color } : {}),
          ...(typeof run.marks.fontSizePt === "number" ? { fontSize: `${run.marks.fontSizePt}pt` } : {}),
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
        attrs: { blockId: block.id },
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
        attrs: { blockId: block.id },
        content: block.rows.map((row, rowIdx) => ({
          type: "tableRow",
          content: row.map((cell) => {
            const inner = runsToTiptapNodes(cell.runs);
            return {
              type: block.hasHeaderRow && rowIdx === 0 ? "tableHeader" : "tableCell",
              attrs: {
                colspan: cell.colspan ?? 1,
                rowspan: cell.rowspan ?? 1,
              },
              content: [{ type: "paragraph", ...(inner.length > 0 ? { content: inner } : {}) }],
            };
          }),
        })),
      });
    } else if (block.type === "page_break") {
      content.push({ type: "horizontalRule", attrs: { blockId: block.id } });
    } else if (block.type === "linked_metric_placeholder") {
      // Dedicated atomic custom node so pressing Enter above never corrupts or shifts linked metrics
      content.push({
        type: "linkedMetricPlaceholder",
        attrs: {
          blockId: block.id,
          metric: structuredClone(block.metric),
        },
      });
    }
  }
  return { type: "doc", content };
}

function parseFontSizePt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 6 && raw <= 96) return raw;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(?:pt)?$/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 6 && n <= 96) return n;
    }
  }
  return undefined;
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
        const pt = parseFontSizePt(m.attrs?.fontSize);
        if (pt !== undefined) marks.fontSizePt = pt;
      }
    }
    runs.push({
      text: node.text.normalize("NFC"),
      ...(Object.keys(marks).length > 0 ? { marks } : {}),
    });
  }
  return runs.length > 0 ? runs : [{ text: "" }];
}

function tiptapBlockChildrenToRuns(children?: TiptapNode[]): TextRun[] {
  if (!children || children.length === 0) return [{ text: "" }];
  const combined: TextRun[] = [];
  children.forEach((child, idx) => {
    if (idx > 0) combined.push({ text: "\n" });
    if (child.type === "paragraph" || child.type === "heading") {
      combined.push(...tiptapInlineToRuns(child.content));
    } else if (child.content) {
      combined.push(...tiptapBlockChildrenToRuns(child.content));
    }
  });
  return combined.length > 0 ? combined : [{ text: "" }];
}

function mapTiptapNodeTypeToBlockType(nodeType: string): DocumentBlock["type"] | null {
  switch (nodeType) {
    case "paragraph":
      return "paragraph";
    case "heading":
      return "heading";
    case "bulletList":
      return "bullet_list";
    case "orderedList":
      return "ordered_list";
    case "table":
      return "table";
    case "horizontalRule":
      return "page_break";
    case "linkedMetricPlaceholder":
      return "linked_metric_placeholder";
    default:
      return null;
  }
}

export function fromTiptapJson(
  tiptapDoc: TiptapNode,
  existingBlocks: DocumentBlock[] = [],
): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const usedIds = new Set<string>();
  const existingById = new Map<string, DocumentBlock>(existingBlocks.map((b) => [b.id, b]));
  const content = tiptapDoc.content ?? [];

  // Pass 1: Reserve every explicit blockId present on any node so newly inserted nodes never steal shifted IDs
  const explicitBlockIds = new Set<string>();
  for (const node of content) {
    if (typeof node.attrs?.blockId === "string" && node.attrs.blockId.trim()) {
      explicitBlockIds.add(node.attrs.blockId.trim());
    }
  }

  for (let i = 0; i < content.length; i++) {
    const node = content[i]!;
    const mappedType = mapTiptapNodeTypeToBlockType(node.type);
    if (!mappedType) continue;

    const attrId = typeof node.attrs?.blockId === "string" && node.attrs.blockId.trim() ? node.attrs.blockId.trim() : undefined;
    // Only fall back to positional existing block ID if type matches AND that ID is not explicitly owned by another node
    const positionalBlock = existingBlocks[i];
    const fallbackId =
      positionalBlock &&
      positionalBlock.type === mappedType &&
      !usedIds.has(positionalBlock.id) &&
      !explicitBlockIds.has(positionalBlock.id)
        ? positionalBlock.id
        : undefined;

    const candidateId =
      attrId && !usedIds.has(attrId)
        ? attrId
        : fallbackId
          ? fallbackId
          : browserSafeId(mappedType === "table" ? "tbl" : "blk");
    usedIds.add(candidateId);

    if (node.type === "linkedMetricPlaceholder") {
      const attrMetric = node.attrs?.metric as LinkedMetricReference | undefined;
      const existingMetricBlock = attrId ? existingById.get(attrId) : undefined;
      const metric =
        attrMetric && typeof attrMetric.metricId === "string"
          ? structuredClone(attrMetric)
          : existingMetricBlock?.type === "linked_metric_placeholder"
            ? structuredClone(existingMetricBlock.metric)
            : null;
      if (metric) {
        blocks.push({
          id: candidateId,
          type: "linked_metric_placeholder",
          metric,
        });
      }
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
      const items = (node.content ?? []).map((li) => tiptapBlockChildrenToRuns(li.content));
      blocks.push({
        id: candidateId,
        type: node.type === "bulletList" ? "bullet_list" : "ordered_list",
        items,
      });
    } else if (node.type === "table") {
      const rows = (node.content ?? []).map((tr) =>
        (tr.content ?? []).map((cell) => {
          const colspan = Number(cell.attrs?.colspan ?? 1);
          const rowspan = Number(cell.attrs?.rowspan ?? 1);
          return {
            runs: tiptapBlockChildrenToRuns(cell.content),
            ...(Number.isInteger(colspan) && colspan > 1 ? { colspan } : {}),
            ...(Number.isInteger(rowspan) && rowspan > 1 ? { rowspan } : {}),
          };
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
