import { randomUUID } from "node:crypto";
import type {
  ImportDiagnostics,
  PresentationSlide,
  SlideElement,
  StudioPresentation,
} from "@ai-office-suite/shared-contracts";
import { normalizeDocumentText } from "@ai-office-suite/document-engine";
import { inspectAndExtractOoxmlZip } from "@ai-office-suite/validation";
import { CORPORATE_THEME_V1 } from "./presentationEngine.ts";

export class PptxImportError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "PptxImportError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTextRunsFromXml(xml: string): string[] {
  const shapes: string[] = [];
  const spMatches = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? [];
  for (const sp of spMatches) {
    const tMatches = sp.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g) ?? [];
    const text = tMatches
      .map((tag) => decodeXmlEntities(tag.replace(/<[^>]+>/g, "")))
      .join(" ")
      .trim();
    if (text) shapes.push(normalizeDocumentText(text));
  }
  return shapes;
}

export function importFromPptxBuffer(params: {
  buffer: Uint8Array;
  filename: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
}): { presentation: StudioPresentation; diagnostics: ImportDiagnostics } {
  const inspected = inspectAndExtractOoxmlZip(params.buffer, params.filename, "pptx");
  if (!inspected.ok) {
    throw new PptxImportError(400, inspected.code, inspected.message);
  }

  const { originalSha256, entries } = inspected;
  const names = Object.keys(entries);
  if (!entries["ppt/presentation.xml"]) {
    throw new PptxImportError(400, "MISSING_PRESENTATION_XML", "Archive missing ppt/presentation.xml.");
  }

  const unsupportedFeatures: string[] = [];
  const warnings: string[] = [];

  if (names.some((n) => n.startsWith("ppt/diagrams/"))) {
    unsupportedFeatures.push("SmartArt diagrams (ppt/diagrams/*)");
  }
  for (const relName of names.filter((n) => n.endsWith(".rels"))) {
    const relXml = Buffer.from(entries[relName]!).toString("utf8");
    if (/TargetMode\s*=\s*["']External["']/i.test(relXml)) {
      unsupportedFeatures.push(`External relationship reference in ${relName} (not fetched)`);
    }
  }

  const slideNames = names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number.parseInt(a.replace(/\D+/g, ""), 10);
      const nb = Number.parseInt(b.replace(/\D+/g, ""), 10);
      return na - nb;
    });

  const slides: PresentationSlide[] = slideNames.map((slideName, index) => {
    const slideXml = Buffer.from(entries[slideName]!).toString("utf8");
    const slideNum = index + 1;
    const textBoxes = extractTextRunsFromXml(slideXml);
    const title = textBoxes[0] ?? `Slide ${slideNum}`;

    if (/<p:timing\b/i.test(slideXml)) {
      unsupportedFeatures.push(`Slide ${slideNum} transitions/animations`);
    }

    const elements: SlideElement[] = textBoxes.map((txt, idx) => ({
      elementId: `imp_s${slideNum}_t${idx + 1}`,
      type: "text",
      text: txt,
      fontSizePt: idx === 0 ? 22 : 14,
      bold: idx === 0,
      bounds: { xIn: 0.7, yIn: 0.6 + idx * 0.95, wIn: 11.5, hIn: 0.8 },
      zIndex: idx + 1,
      locked: false,
      altText: idx === 0 ? "Imported slide title" : "Imported text box",
    }));

    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    let speakerNotes = "";
    if (entries[notesPath]) {
      const nXml = Buffer.from(entries[notesPath]!).toString("utf8");
      speakerNotes = extractTextRunsFromXml(nXml).join(" ");
    }

    return {
      slideId: `imp_slide_${slideNum}`,
      order: slideNum,
      layoutId: "title",
      title,
      elements,
      speakerNotes,
      readingOrder: elements.map((e) => e.elementId),
      sourceRefs: [],
    };
  });

  if (unsupportedFeatures.length > 0) {
    warnings.push("Unsupported or complex OOXML constructs flagged; original bytes SHA-256 preserved.");
  }

  const now = new Date().toISOString();
  const presentation: StudioPresentation = {
    presentationId: `pres_imp_${randomUUID().slice(0, 8)}`,
    tenantId: params.tenantId,
    workspaceId: params.workspaceId,
    title: params.filename.replace(/\.pptx$/i, ""),
    language: "bilingual",
    revision: 1,
    status: "draft",
    theme: structuredClone(CORPORATE_THEME_V1),
    slides,
    scopeLabel: "Imported Unapproved Draft",
    createdBy: params.actorId,
    createdAt: now,
    updatedAt: now,
  };

  return {
    presentation,
    diagnostics: {
      originalSha256,
      filename: params.filename,
      byteLength: params.buffer.byteLength,
      macrosBlocked: false,
      warnings: Array.from(new Set(warnings)),
      unsupportedFeatures: Array.from(new Set(unsupportedFeatures)),
    },
  };
}
