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

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
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

function htmlToStudioBlocks(html: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const blockPattern = /<(h[1-3]|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(html)) !== null) {
    const tag = (match[1] ?? "p").toLowerCase();
    const inner = match[2] ?? "";

    if (tag === "h1" || tag === "h2" || tag === "h3") {
      const level = (tag === "h1" ? 1 : tag === "h2" ? 2 : 3) as 1 | 2 | 3;
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
      const liRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch: RegExpExecArray | null;
      while ((liMatch = liRegex.exec(inner)) !== null) {
        items.push(parseInlineRuns(liMatch[1] ?? ""));
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
      const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch: RegExpExecArray | null;
      while ((trMatch = trRegex.exec(inner)) !== null) {
        const rowCells: TableCell[] = [];
        const cellRegex = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellRegex.exec(trMatch[1] ?? "")) !== null) {
          rowCells.push({ runs: parseInlineRuns(cellMatch[1] ?? "") });
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
