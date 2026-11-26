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

function marksEqual(a?: TextRun["marks"], b?: TextRun["marks"]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    (a.highlight ?? "") === (b.highlight ?? "") &&
    (a.fontFamily ?? "") === (b.fontFamily ?? "") &&
    (a.fontSizePt ?? 0) === (b.fontSizePt ?? 0) &&
    (a.color ?? "") === (b.color ?? "")
  );
}

/**
 * Replaces `[startOffset, endOffset)` at safe grapheme cluster boundaries while preserving
 * inline formatting (`marks`) of all untouched runs before and after the edited slice (H18).
 */
function mutateBlockRunsText(
  runs: TextRun[],
  startOffset: number,
  endOffset: number,
  replacement: string,
): TextRun[] {
  const normalizedRuns = runs.map((r) => ({
    text: normalizeDocumentText(r.text),
    ...(r.marks ? { marks: { ...r.marks } } : {}),
  }));
  const full = normalizedRuns.map((r) => r.text).join("");
  const safeRange = snapRangeToGraphemeBoundaries(full, startOffset, endOffset);
  const normReplacement = normalizeDocumentText(replacement);

  const out: TextRun[] = [];
  let cursor = 0;
  let inserted = false;
  let replacementMarks: TextRun["marks"] | undefined = normalizedRuns[0]?.marks
    ? { ...normalizedRuns[0].marks }
    : undefined;

  const pushRun = (text: string, marks?: TextRun["marks"]) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && marksEqual(prev.marks, marks)) {
      prev.text += text;
    } else {
      out.push({ text, ...(marks ? { marks: { ...marks } } : {}) });
    }
  };

  for (const run of normalizedRuns) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;

    if (runEnd <= safeRange.start) {
      pushRun(run.text, run.marks);
      if (runEnd === safeRange.start) {
        replacementMarks = run.marks ? { ...run.marks } : undefined;
      }
      continue;
    }

    if (runStart >= safeRange.end) {
      if (!inserted) {
        pushRun(normReplacement, replacementMarks);
        inserted = true;
      }
      pushRun(run.text, run.marks);
      continue;
    }

    // Run overlaps [safeRange.start, safeRange.end)
    if (runStart < safeRange.start) {
      pushRun(run.text.slice(0, safeRange.start - runStart), run.marks);
    }
    if (!inserted) {
      replacementMarks = run.marks ? { ...run.marks } : replacementMarks;
      pushRun(normReplacement, replacementMarks);
      inserted = true;
    }
    if (runEnd > safeRange.end) {
      pushRun(run.text.slice(safeRange.end - runStart), run.marks);
    }
  }

  if (!inserted) {
    pushRun(normReplacement, replacementMarks);
  }

  return out.length > 0 ? out : [{ text: "" }];
}

/**
 * Resolves the prior target revision for `undo_last` without flip-flopping between two revisions
 * on consecutive undo commands (H18). Walks back past previously restored revisions cleanly.
 */
export function resolveUndoTargetRevision(
  versions: ReadonlyArray<{ revision: number; restoredFromRevision?: number | null }>,
): number | null {
  if (versions.length < 2) return null;
  const sorted = [...versions].sort((a, b) => a.revision - b.revision);
  const latest = sorted[sorted.length - 1]!;
  if (typeof latest.restoredFromRevision === "number" && latest.restoredFromRevision >= 1) {
    const targetRev = latest.restoredFromRevision - 1;
    if (targetRev < 1) return null;
    const exact = sorted.find((v) => v.revision === targetRev);
    if (exact) return exact.revision;
    const earlier = [...sorted].reverse().find((v) => v.revision < latest.restoredFromRevision!);
    return earlier ? earlier.revision : null;
  }
  return sorted[sorted.length - 2]?.revision ?? null;
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
    if (
      priorRevisionDoc.documentId !== doc.documentId ||
      priorRevisionDoc.tenantId !== doc.tenantId ||
      priorRevisionDoc.workspaceId !== doc.workspaceId
    ) {
      throw new DocumentEngineError(
        409,
        "UNDO_SNAPSHOT_MISMATCH",
        "Prior revision snapshot does not belong to the target document or tenant workspace.",
      );
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

  // Selection integrity check with consistent NFC normalization + grapheme-boundary snapping (H18)
  if (proposal.selection?.selectionHash) {
    const actualText = normalizeDocumentText(getBlockPlainText(currentBlock));
    let slice = actualText;
    if (
      typeof proposal.selection.startOffset === "number" &&
      typeof proposal.selection.endOffset === "number"
    ) {
      const snapped = snapRangeToGraphemeBoundaries(
        actualText,
        proposal.selection.startOffset,
        proposal.selection.endOffset,
      );
      slice = actualText.slice(snapped.start, snapped.end);
    }
    const actualHash = hashTextSelection(slice);
    if (actualHash !== proposal.selection.selectionHash) {
      throw new DocumentEngineError(
        409,
        "SELECTION_MISMATCH",
        "The selected document content changed before execution. Re-select and re-plan.",
      );
    }
  }

  const beforeText = normalizeDocumentText(getBlockPlainText(currentBlock));

  switch (proposal.action) {
    case "insert_text": {
      if (typeof proposal.params.text !== "string") {
        throw new DocumentEngineError(400, "INVALID_PARAMS", "insert_text requires string text parameter.");
      }
      const textToInsert = normalizeDocumentText(proposal.params.text);
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
      if (typeof proposal.params.replacement !== "string") {
        throw new DocumentEngineError(400, "INVALID_PARAMS", "replace_selection requires string replacement parameter.");
      }
      const replacement = normalizeDocumentText(proposal.params.replacement);
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
      const rawLevel = proposal.params.level === undefined ? 1 : Number(proposal.params.level);
      if (!Number.isInteger(rawLevel) || rawLevel < 0 || rawLevel > 3) {
        throw new DocumentEngineError(400, "INVALID_PARAMS", "set_heading level must be an integer between 0 and 3.");
      }
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
      const level = rawLevel as 1 | 2 | 3;
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
      if (proposal.params.bold !== undefined && typeof proposal.params.bold !== "boolean") {
        throw new DocumentEngineError(400, "INVALID_PARAMS", "toggle_bold bold parameter must be a boolean.");
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
      const rawRows = proposal.params.rows === undefined ? 3 : Number(proposal.params.rows);
      const rawCols = proposal.params.cols === undefined ? 3 : Number(proposal.params.cols);
      if (!Number.isFinite(rawRows) || !Number.isFinite(rawCols)) {
        throw new DocumentEngineError(400, "INVALID_PARAMS", "insert_table rows and cols must be finite numbers.");
      }
      const rows = Math.max(1, Math.min(20, Math.trunc(rawRows)));
      const cols = Math.max(1, Math.min(10, Math.trunc(rawCols)));
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

export interface DocumentBlockDiffEntry {
  blockId: string;
  blockType: DocumentBlock["type"];
  changeType: "added" | "removed" | "modified" | "moved";
  beforeText?: string;
  afterText?: string;
  fromIndex?: number;
  toIndex?: number;
}

export interface DocumentRevisionDiff {
  documentId: string;
  fromRevision: number;
  toRevision: number;
  metadataChanged: {
    titleChanged: boolean;
    languageChanged: boolean;
    layoutChanged: boolean;
  };
  summary: {
    added: number;
    removed: number;
    modified: number;
    moved?: number;
    unchanged: number;
  };
  blocks: DocumentBlockDiffEntry[];
}

export function computeDocumentRevisionDiff(
  fromDoc: StudioDocument,
  toDoc: StudioDocument,
): DocumentRevisionDiff {
  const fromMap = new Map<string, { block: DocumentBlock; index: number }>();
  for (let i = 0; i < fromDoc.blocks.length; i++) {
    const b = fromDoc.blocks[i]!;
    if (!fromMap.has(b.id)) fromMap.set(b.id, { block: b, index: i });
  }
  const toMap = new Map<string, { block: DocumentBlock; index: number }>();
  for (let i = 0; i < toDoc.blocks.length; i++) {
    const b = toDoc.blocks[i]!;
    if (!toMap.has(b.id)) toMap.set(b.id, { block: b, index: i });
  }

  // Compute relative order among shared blocks so pure insertions/deletions do not trigger false move flags (H18)
  const sharedFromOrder = fromDoc.blocks.filter((b) => toMap.has(b.id)).map((b) => b.id);
  const sharedToOrder = toDoc.blocks.filter((b) => fromMap.has(b.id)).map((b) => b.id);
  const sharedFromPos = new Map(sharedFromOrder.map((id, idx) => [id, idx]));
  const sharedToPos = new Map(sharedToOrder.map((id, idx) => [id, idx]));

  const diffs: DocumentBlockDiffEntry[] = [];
  let added = 0;
  let removed = 0;
  let modified = 0;
  let moved = 0;
  let unchanged = 0;

  for (let i = 0; i < fromDoc.blocks.length; i++) {
    const oldBlock = fromDoc.blocks[i]!;
    const nextEntry = toMap.get(oldBlock.id);
    if (!nextEntry) {
      removed++;
      diffs.push({
        blockId: oldBlock.id,
        blockType: oldBlock.type,
        changeType: "removed",
        beforeText: normalizeDocumentText(getBlockPlainText(oldBlock)),
        fromIndex: i,
      });
    } else {
      const nextBlock = nextEntry.block;
      const beforeJson = JSON.stringify(oldBlock);
      const afterJson = JSON.stringify(nextBlock);
      if (beforeJson !== afterJson) {
        modified++;
        diffs.push({
          blockId: nextBlock.id,
          blockType: nextBlock.type,
          changeType: "modified",
          beforeText: normalizeDocumentText(getBlockPlainText(oldBlock)),
          afterText: normalizeDocumentText(getBlockPlainText(nextBlock)),
          fromIndex: i,
          toIndex: nextEntry.index,
        });
      } else if (sharedFromPos.get(oldBlock.id) !== sharedToPos.get(oldBlock.id)) {
        moved++;
        const text = normalizeDocumentText(getBlockPlainText(nextBlock));
        diffs.push({
          blockId: nextBlock.id,
          blockType: nextBlock.type,
          changeType: "moved",
          beforeText: text,
          afterText: text,
          fromIndex: i,
          toIndex: nextEntry.index,
        });
      } else {
        unchanged++;
      }
    }
  }

  for (let i = 0; i < toDoc.blocks.length; i++) {
    const nextBlock = toDoc.blocks[i]!;
    if (!fromMap.has(nextBlock.id)) {
      added++;
      diffs.push({
        blockId: nextBlock.id,
        blockType: nextBlock.type,
        changeType: "added",
        afterText: normalizeDocumentText(getBlockPlainText(nextBlock)),
        toIndex: i,
      });
    }
  }

  return {
    documentId: toDoc.documentId,
    fromRevision: fromDoc.revision,
    toRevision: toDoc.revision,
    metadataChanged: {
      titleChanged: fromDoc.title !== toDoc.title,
      languageChanged: fromDoc.language !== toDoc.language,
      layoutChanged: JSON.stringify(fromDoc.layout) !== JSON.stringify(toDoc.layout),
    },
    summary: { added, removed, modified, moved, unchanged },
    blocks: diffs,
  };
}

