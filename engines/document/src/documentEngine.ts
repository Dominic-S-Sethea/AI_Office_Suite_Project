import { createHash, randomUUID } from "node:crypto";
import type {
  DocumentBlock,
  DocumentOperationPreview,
  DocumentOperationProposal,
  HeadingBlock,
  ParagraphBlock,
  StudioDocument,
  TableBlock,
  TextAlignment,
  TextRun,
} from "@ai-office-suite/shared-contracts";
import { normalizeDocumentText, snapRangeToGraphemeBoundaries } from "./khmer.ts";

export class DocumentEngineError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "DocumentEngineError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function hashTextSelection(text: string): string {
  return createHash("sha256").update(normalizeDocumentText(text)).digest("hex").slice(0, 16);
}

export function getBlockPlainText(block: DocumentBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.runs.map((r) => r.text).join("");
    case "bullet_list":
    case "ordered_list":
      return block.items.map((runs) => runs.map((r) => r.text).join("")).join("\n");
    case "table":
      return block.rows
        .map((row) => row.map((cell) => cell.runs.map((r) => r.text).join("")).join(" | "))
        .join("\n");
    case "page_break":
      return "--- PAGE BREAK ---";
    case "linked_metric_placeholder":
      return `[Linked Metric: ${block.metric.displayLabel} = ${block.metric.cachedFormattedValue}]`;
  }
}

export function createEmptyDocument(params: {
  documentId?: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  language?: "en" | "km" | "bilingual";
  createdBy: string;
}): StudioDocument {
  const now = new Date().toISOString();
  return {
    documentId: params.documentId ?? `doc_${randomUUID()}`,
    tenantId: params.tenantId,
    workspaceId: params.workspaceId,
    title: normalizeDocumentText(params.title),
    language: params.language ?? "bilingual",
    revision: 1,
    status: "draft",
    layout: {
      size: "A4",
      orientation: "portrait",
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      headerText: "AI Office Suite · Corporate Workspace",
      footerText: "Confidential · Draft",
      showPageNumbers: true,
    },
    blocks: [
      {
        id: `blk_${randomUUID().slice(0, 8)}`,
        type: "heading",
        level: 1,
        alignment: "left",
        runs: [{ text: normalizeDocumentText(params.title), marks: { bold: true, fontFamily: "Kantumruy Pro" } }],
      },
      {
        id: `blk_${randomUUID().slice(0, 8)}`,
        type: "paragraph",
        alignment: "left",
        runs: [{ text: "" }],
      },
    ],
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

function findTargetBlockIndex(doc: StudioDocument, blockId?: string): number {
  if (blockId) {
    const idx = doc.blocks.findIndex((b) => b.id === blockId);
    if (idx === -1) {
      throw new DocumentEngineError(404, "BLOCK_NOT_FOUND", `Target block '${blockId}' no longer exists.`);
    }
    return idx;
  }
  const lastTextIdx = doc.blocks.findLastIndex((b) => b.type === "paragraph" || b.type === "heading");
  return lastTextIdx >= 0 ? lastTextIdx : 0;
}

function mutateBlockRunsText(
  runs: TextRun[],
  startOffset: number,
  endOffset: number,
  replacement: string,
): TextRun[] {
  const full = normalizeDocumentText(runs.map((r) => r.text).join(""));
  const safeRange = snapRangeToGraphemeBoundaries(full, startOffset, endOffset);
  const nextText =
    full.slice(0, safeRange.start) +
    normalizeDocumentText(replacement) +
    full.slice(safeRange.end);
  const inheritedMarks = runs[0]?.marks ? { ...runs[0].marks } : undefined;
  return [{ text: nextText, ...(inheritedMarks ? { marks: inheritedMarks } : {}) }];
}

export function previewDocumentOperation(
  doc: StudioDocument,
  proposal: Pick<DocumentOperationProposal, "expectedRevision" | "selection" | "action" | "params">,
  priorRevisionDoc?: StudioDocument | null,
): { nextDoc: StudioDocument; preview: DocumentOperationPreview } {
  if (doc.revision !== proposal.expectedRevision) {
    throw new DocumentEngineError(
      409,
      "REVISION_CONFLICT",
      `Document revision changed (expected ${proposal.expectedRevision}, actual ${doc.revision}). Refresh and re-plan before applying.`,
    );
  }

  const nextDoc = structuredClone(doc);
  nextDoc.revision = doc.revision + 1;
  nextDoc.updatedAt = new Date().toISOString();

  if (proposal.action === "undo_last") {
    if (!priorRevisionDoc) {
      throw new DocumentEngineError(400, "NOTHING_TO_UNDO", "No prior document revision is available to undo.");
    }
    const restored = structuredClone(priorRevisionDoc);
    restored.revision = doc.revision + 1;
    restored.updatedAt = nextDoc.updatedAt;
    return {
      nextDoc: restored,
      preview: {
        beforeText: doc.blocks.slice(0, 3).map(getBlockPlainText).join("\n"),
        afterText: restored.blocks.slice(0, 3).map(getBlockPlainText).join("\n"),
        summary: `Undo revision ${doc.revision} by restoring content from revision ${priorRevisionDoc.revision} as new revision ${restored.revision}.`,
      },
    };
  }

  const targetIdx = findTargetBlockIndex(nextDoc, proposal.selection?.blockId);
  const currentBlock = nextDoc.blocks[targetIdx];
  if (!currentBlock) {
    throw new DocumentEngineError(400, "EMPTY_DOCUMENT", "Document has no target block.");
  }

  // Selection integrity check when caller specifies a selectionHash
  if (proposal.selection?.selectionHash) {
    const actualText = getBlockPlainText(currentBlock);
    const slice =
      typeof proposal.selection.startOffset === "number" && typeof proposal.selection.endOffset === "number"
        ? actualText.slice(proposal.selection.startOffset, proposal.selection.endOffset)
        : actualText;
    const actualHash = hashTextSelection(slice);
    if (actualHash !== proposal.selection.selectionHash) {
      throw new DocumentEngineError(
        409,
        "SELECTION_MISMATCH",
        "The selected document content changed before execution. Re-select and re-plan.",
      );
    }
  }

  const beforeText = getBlockPlainText(currentBlock);

  switch (proposal.action) {
    case "insert_text": {
      const textToInsert = normalizeDocumentText(String(proposal.params.text ?? ""));
      if (!textToInsert) {
        throw new DocumentEngineError(400, "INVALID_PARAMS", "insert_text requires non-empty text.");
      }
      const asNewParagraph = proposal.params.asNewParagraph === true;
      if (asNewParagraph || (currentBlock.type !== "paragraph" && currentBlock.type !== "heading")) {
        const newBlock: ParagraphBlock = {
          id: `blk_${randomUUID().slice(0, 8)}`,
          type: "paragraph",
          alignment: "left",
          runs: [{ text: textToInsert }],
        };
        nextDoc.blocks.splice(targetIdx + 1, 0, newBlock);
        return {
          nextDoc,
          preview: {
            blockId: newBlock.id,
            beforeText,
            afterText: `${beforeText}\n${textToInsert}`.trim(),
            summary: `Insert new paragraph (${textToInsert.length} chars).`,
          },
        };
      }
      const offset =
        typeof proposal.selection?.endOffset === "number"
          ? proposal.selection.endOffset
          : beforeText.length;
      currentBlock.runs = mutateBlockRunsText(currentBlock.runs, offset, offset, textToInsert);
      const afterText = getBlockPlainText(currentBlock);
      return {
        nextDoc,
        preview: {
          blockId: currentBlock.id,
          beforeText,
          afterText,
          summary: `Insert text at safe grapheme boundary in block ${currentBlock.id}.`,
        },
      };
    }

    case "replace_selection": {
      if (currentBlock.type !== "paragraph" && currentBlock.type !== "heading") {
        throw new DocumentEngineError(400, "UNSUPPORTED_TARGET", "replace_selection requires a paragraph or heading block.");
      }
      const replacement = normalizeDocumentText(String(proposal.params.replacement ?? ""));
      if (!replacement) {
        throw new DocumentEngineError(400, "INVALID_PARAMS", "replace_selection requires replacement text.");
      }
      const start = typeof proposal.selection?.startOffset === "number" ? proposal.selection.startOffset : 0;
      const end =
        typeof proposal.selection?.endOffset === "number"
          ? proposal.selection.endOffset
          : beforeText.length;
      currentBlock.runs = mutateBlockRunsText(currentBlock.runs, start, end, replacement);
      const afterText = getBlockPlainText(currentBlock);
      return {
        nextDoc,
        preview: {
          blockId: currentBlock.id,
          beforeText,
          afterText,
          summary: `Replace selected content in block ${currentBlock.id}.`,
        },
      };
    }

    case "set_heading": {
      if (currentBlock.type !== "paragraph" && currentBlock.type !== "heading") {
        throw new DocumentEngineError(400, "UNSUPPORTED_TARGET", "set_heading requires a paragraph or heading block.");
      }
      const rawLevel = Number(proposal.params.level ?? 1);
      if (rawLevel === 0) {
        const converted: ParagraphBlock = {
          id: currentBlock.id,
          type: "paragraph",
          alignment: currentBlock.alignment ?? "left",
          runs: currentBlock.runs,
        };
        nextDoc.blocks[targetIdx] = converted;
        return {
          nextDoc,
          preview: {
            blockId: currentBlock.id,
            beforeText: `[${currentBlock.type}] ${beforeText}`,
            afterText: `[paragraph] ${beforeText}`,
            summary: "Convert block to normal paragraph.",
          },
        };
      }
      const level = (rawLevel === 2 ? 2 : rawLevel === 3 ? 3 : 1) as 1 | 2 | 3;
      const heading: HeadingBlock = {
        id: currentBlock.id,
        type: "heading",
        level,
        alignment: currentBlock.alignment ?? "left",
        runs: currentBlock.runs,
      };
      nextDoc.blocks[targetIdx] = heading;
      return {
        nextDoc,
        preview: {
          blockId: currentBlock.id,
          beforeText: `[${currentBlock.type}] ${beforeText}`,
          afterText: `[heading H${level}] ${beforeText}`,
          summary: `Change block style to Heading ${level}.`,
        },
      };
    }

    case "toggle_bold": {
      if (currentBlock.type !== "paragraph" && currentBlock.type !== "heading") {
        throw new DocumentEngineError(400, "UNSUPPORTED_TARGET", "toggle_bold requires a paragraph or heading block.");
      }
      const forceBold =
        typeof proposal.params.bold === "boolean"
          ? proposal.params.bold
          : !currentBlock.runs.every((r) => r.marks?.bold === true);
      currentBlock.runs = currentBlock.runs.map((run) => ({
        text: run.text,
        marks: { ...(run.marks ?? {}), bold: forceBold },
      }));
      return {
        nextDoc,
        preview: {
          blockId: currentBlock.id,
          beforeText,
          afterText: `${forceBold ? "**" : ""}${beforeText}${forceBold ? "**" : ""}`,
          summary: `${forceBold ? "Apply" : "Remove"} bold formatting on block ${currentBlock.id}.`,
        },
      };
    }

    case "set_alignment": {
      if (currentBlock.type !== "paragraph" && currentBlock.type !== "heading") {
        throw new DocumentEngineError(400, "UNSUPPORTED_TARGET", "set_alignment requires a paragraph or heading block.");
      }
      const alignment = (String(proposal.params.alignment ?? "left") as TextAlignment);
      if (!["left", "center", "right", "justify"].includes(alignment)) {
        throw new DocumentEngineError(400, "INVALID_PARAMS", `Invalid alignment '${alignment}'.`);
      }
      const prevAlign = currentBlock.alignment ?? "left";
      currentBlock.alignment = alignment;
      return {
        nextDoc,
        preview: {
          blockId: currentBlock.id,
          beforeText: `[align:${prevAlign}] ${beforeText}`,
          afterText: `[align:${alignment}] ${beforeText}`,
          summary: `Set paragraph alignment to '${alignment}'.`,
        },
      };
    }

    case "insert_table": {
      const rows = Math.max(1, Math.min(20, Number(proposal.params.rows ?? 3)));
      const cols = Math.max(1, Math.min(10, Number(proposal.params.cols ?? 3)));
      const customHeaders = Array.isArray(proposal.params.headers) ? (proposal.params.headers as string[]) : null;
      const tableRows = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => ({
          runs: [
            {
              text:
                r === 0 && customHeaders?.[c]
                  ? normalizeDocumentText(String(customHeaders[c]))
                  : r === 0
                    ? `Column ${c + 1}`
                    : "",
              marks: r === 0 ? { bold: true } : undefined,
            },
          ],
        })),
      );
      const tableBlock: TableBlock = {
        id: `tbl_${randomUUID().slice(0, 8)}`,
        type: "table",
        hasHeaderRow: true,
        rows: tableRows,
      };
      nextDoc.blocks.splice(targetIdx + 1, 0, tableBlock);
      return {
        nextDoc,
        preview: {
          blockId: tableBlock.id,
          beforeText,
          afterText: `${beforeText}\n[Inserted ${rows}x${cols} table]`,
          summary: `Insert ${rows}×${cols} table after block ${currentBlock.id}.`,
        },
      };
    }
  }
}
