import { randomUUID } from "node:crypto";
import type {
  DocumentBlock,
  ImportDiagnostics,
  StudioDocument,
  TableCell,
  TextRun,
} from "@ai-office-suite/shared-contracts";
import { normalizeDocumentText } from "@ai-office-suite/document-engine";
import { inspectAndExtractOoxmlZip } from "@ai-office-suite/validation";
import mammoth from "mammoth";

export class DocxImportError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "DocxImportError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(input: string): string {
  // Single-pass decoder prevents `&amp;lt;` -> `<` double-unescaping and decodes valid numeric code points
  return input.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/g, (full, hex, dec, named) => {
    if (named) {
      return NAMED_HTML_ENTITIES[named] ?? full;
    }
    const cp = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (!Number.isSafeInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return full;
    }
    return String.fromCodePoint(cp);
  });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
}

function parseInlineRuns(htmlFragment: string): TextRun[] {
  const runs: TextRun[] = [];
  // Simple deterministic inline scanner for <strong>, <em>, <u>
  const tokenRegex = /(<\/?(?:strong|b|em|i|u)\b[^>]*>)/gi;
  const parts = htmlFragment.split(tokenRegex);
  let bold = false;
  let italic = false;
  let underline = false;

  for (const part of parts) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (lower.startsWith("<strong") || lower.startsWith("<b")) {
      bold = true;
    } else if (lower === "</strong>" || lower === "</b>") {
      bold = false;
    } else if (lower.startsWith("<em") || lower.startsWith("<i")) {
      italic = true;
    } else if (lower === "</em>" || lower === "</i>") {
      italic = false;
    } else if (lower.startsWith("<u")) {
      underline = true;
    } else if (lower === "</u>") {
      underline = false;
    } else {
      const clean = normalizeDocumentText(stripTags(part));
      if (clean.length > 0) {
        const marks: TextRun["marks"] = {};
        if (bold) marks.bold = true;
        if (italic) marks.italic = true;
        if (underline) marks.underline = true;
        runs.push({
          text: clean,
          ...(Object.keys(marks).length > 0 ? { marks } : {}),
        });
      }
    }
  }
  return runs.length > 0 ? runs : [{ text: "" }];
}

function extractBalancedElements(
  html: string,
  tagFilter: Set<string>,
): Array<{ tag: string; inner: string; attrs: string }> {
  const results: Array<{ tag: string; inner: string; attrs: string }> = [];
  const tagRe = /<\/?(h[1-6]|p|ul|ol|table|li|tr|td|th)\b([^>]*)>/gi;
  const stack: Array<{ tag: string; attrs: string; innerStart: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    const raw = match[0];
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";
    const isClosing = raw.startsWith("</");
    const isSelfClosing = raw.endsWith("/>");

    if (!isClosing && !isSelfClosing) {
      if (stack.length === 0) {
        if (tagFilter.has(tag)) {
          stack.push({ tag, attrs, innerStart: match.index + raw.length });
        }
      } else {
        stack.push({ tag, attrs, innerStart: match.index + raw.length });
      }
      continue;
    }

    if (isClosing && stack.length > 0) {
      // Unwind back to matching open tag
      let matchIdx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === tag) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx === 0) {
        const popped = stack[0]!;
        stack.length = 0;
        results.push({
          tag: popped.tag,
          attrs: popped.attrs,
          inner: html.slice(popped.innerStart, match.index),
        });
      } else if (matchIdx > 0) {
        stack.length = matchIdx;
      }
    }
  }
  return results;
}

function parsePositiveSpanAttr(attrs: string, attrName: "colspan" | "rowspan"): number | undefined {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"(\\d+)"|'(\\d+)'|(\\d+))`, "i");
  const m = attrs.match(re);
  if (!m) return undefined;
  const parsed = Number.parseInt(m[1] ?? m[2] ?? m[3] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined;
}

export function htmlToStudioBlocks(html: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const topBlocks = extractBalancedElements(
    html,
    new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table"]),
  );

  for (const el of topBlocks) {
    const { tag, inner } = el;
    if (tag.startsWith("h")) {
      const parsedLevel = Number.parseInt(tag.slice(1), 10);
      const level = (parsedLevel >= 1 && parsedLevel <= 3 ? parsedLevel : 3) as 1 | 2 | 3;
      blocks.push({
        id: `blk_${randomUUID().slice(0, 8)}`,
        type: "heading",
        level,
        alignment: "left",
        runs: parseInlineRuns(inner),
      });
    } else if (tag === "p") {
      const runs = parseInlineRuns(inner);
      if (runs.some((r) => r.text.trim().length > 0)) {
        blocks.push({
          id: `blk_${randomUUID().slice(0, 8)}`,
          type: "paragraph",
          alignment: "left",
          runs,
        });
      }
    } else if (tag === "ul" || tag === "ol") {
      const items: TextRun[][] = [];
      for (const li of extractBalancedElements(inner, new Set(["li"]))) {
        items.push(parseInlineRuns(li.inner));
      }
      if (items.length > 0) {
        blocks.push({
          id: `blk_${randomUUID().slice(0, 8)}`,
          type: tag === "ul" ? "bullet_list" : "ordered_list",
          items,
        });
      }
    } else if (tag === "table") {
      const rows: TableCell[][] = [];
      for (const tr of extractBalancedElements(inner, new Set(["tr"]))) {
        const rowCells: TableCell[] = [];
        for (const cellEl of extractBalancedElements(tr.inner, new Set(["td", "th"]))) {
          const colspan = parsePositiveSpanAttr(cellEl.attrs, "colspan");
          const rowspan = parsePositiveSpanAttr(cellEl.attrs, "rowspan");
          rowCells.push({
            runs: parseInlineRuns(cellEl.inner),
            ...(colspan !== undefined ? { colspan } : {}),
            ...(rowspan !== undefined ? { rowspan } : {}),
          });
        }
        if (rowCells.length > 0) rows.push(rowCells);
      }
      if (rows.length > 0) {
        blocks.push({
          id: `tbl_${randomUUID().slice(0, 8)}`,
          type: "table",
          hasHeaderRow: true,
          rows,
        });
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      id: `blk_${randomUUID().slice(0, 8)}`,
      type: "paragraph",
      alignment: "left",
      runs: [{ text: "" }],
    });
  }
  return blocks;
}

export async function importFromDocxBuffer(params: {
  buffer: Uint8Array;
  filename: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
  titleOverride?: string;
}): Promise<{ document: StudioDocument; diagnostics: ImportDiagnostics }> {
  const inspected = inspectAndExtractOoxmlZip(params.buffer, params.filename, "docx");
  if (!inspected.ok) {
    throw new DocxImportError(400, inspected.code, inspected.message);
  }

  const { originalSha256, entries: zipEntries, repackedBuffer } = inspected;
  const entryNames = Object.keys(zipEntries);

  if (!zipEntries["word/document.xml"]) {
    throw new DocxImportError(400, "MISSING_DOCUMENT_XML", "Archive does not contain word/document.xml.");
  }

  const documentXml = Buffer.from(zipEntries["word/document.xml"]).toString("utf8");
  const unsupportedFeatures: string[] = [];
  const warnings: string[] = [];

  if (entryNames.some((n) => n.startsWith("word/diagrams/"))) {
    unsupportedFeatures.push("SmartArt diagrams (word/diagrams/*)");
  }
  if (entryNames.some((n) => n === "word/footnotes.xml" || n === "word/endnotes.xml")) {
    unsupportedFeatures.push("Footnotes / Endnotes (deferred beyond D1)");
  }
  if (entryNames.some((n) => n === "word/comments.xml")) {
    unsupportedFeatures.push("Word review comments (word/comments.xml)");
  }
  if (/<w:sdt\b/i.test(documentXml)) {
    unsupportedFeatures.push("Structured content controls (<w:sdt>)");
  }
  if (/<w:drawing\b|<v:shape\b/i.test(documentXml)) {
    unsupportedFeatures.push("Floating shapes or embedded drawings");
  }
  const relEntries = entryNames.filter((n) => n.endsWith(".rels"));
  for (const relName of relEntries) {
    const relXml = Buffer.from(zipEntries[relName]!).toString("utf8");
    if (/TargetMode\s*=\s*["']External["']/i.test(relXml)) {
      unsupportedFeatures.push(`External relationship reference in ${relName} (not fetched)`);
    }
  }
  if (unsupportedFeatures.length > 0) {
    warnings.push(
      "Some advanced Word features were detected and omitted from editable view; the original file bytes remain preserved.",
    );
  }

  // Pass canonical repacked ZIP buffer into mammoth to prevent ZIP parser-differential attacks
  const mammothResult = await mammoth.convertToHtml({ buffer: Buffer.from(repackedBuffer) });
  for (const msg of mammothResult.messages) {
    warnings.push(`${msg.type}: ${msg.message}`);
  }

  const blocks = htmlToStudioBlocks(mammothResult.value);
  const title =
    params.titleOverride?.trim() ||
    params.filename.replace(/\.docx$/i, "") ||
    "Imported Document";

  const now = new Date().toISOString();
  const document: StudioDocument = {
    documentId: `doc_${randomUUID()}`,
    tenantId: params.tenantId,
    workspaceId: params.workspaceId,
    title: normalizeDocumentText(title),
    language: "bilingual",
    revision: 1,
    status: "draft",
    layout: {
      size: "A4",
      orientation: "portrait",
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      headerText: normalizeDocumentText(title),
      footerText: "Imported via AI Office Suite",
      showPageNumbers: true,
    },
    blocks,
    createdBy: params.actorId,
    createdAt: now,
    updatedAt: now,
    sourceImportSha256: originalSha256,
  };

  return {
    document,
    diagnostics: {
      originalSha256,
      filename: params.filename,
      byteLength: params.buffer.byteLength,
      macrosBlocked: false,
      warnings,
      unsupportedFeatures,
    },
  };
}
