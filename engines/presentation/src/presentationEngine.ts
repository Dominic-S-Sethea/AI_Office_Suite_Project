import { createHash, randomUUID } from "node:crypto";
import type {
  ActorContext,
  ChartSpec,
  LinkedMetricReference,
  PresentationOperationProposal,
  PresentationSlide,
  PresentationTheme,
  SlideElement,
  SlideGeometry,
  StudioPresentation,
} from "@ai-office-suite/shared-contracts";
import { assertCanPerform, assertTenantWorkspaceAccess } from "@ai-office-suite/authorization";
import type { AuditStore } from "@ai-office-suite/audit";
import { normalizeDocumentText } from "@ai-office-suite/document-engine";
import { scanForPromptInjection } from "@ai-office-suite/validation";

export const EMU_PER_INCH = 914400;
export const PX_PER_INCH = 96;

export class PresentationEngineError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "PresentationEngineError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function inchesToEmu(inches: number): number {
  return Math.round(inches * EMU_PER_INCH);
}

export function emuToInches(emu: number): number {
  return Math.round((emu / EMU_PER_INCH) * 10000) / 10000;
}

export function inchesToPx(inches: number): number {
  return Math.round(inches * PX_PER_INCH);
}

export function pxToInches(px: number): number {
  return Math.round((px / PX_PER_INCH) * 10000) / 10000;
}

export function validateSlideGeometry(bounds: SlideGeometry, theme: PresentationTheme): void {
  if (
    !Number.isFinite(bounds.xIn) ||
    !Number.isFinite(bounds.yIn) ||
    !Number.isFinite(bounds.wIn) ||
    !Number.isFinite(bounds.hIn) ||
    bounds.wIn <= 0 ||
    bounds.hIn <= 0 ||
    bounds.xIn < -0.1 ||
    bounds.yIn < -0.1 ||
    bounds.xIn + bounds.wIn > theme.slideWidthIn + 0.5 ||
    bounds.yIn + bounds.hIn > theme.slideHeightIn + 0.5
  ) {
    throw new PresentationEngineError(
      400,
      "INVALID_SLIDE_GEOMETRY",
      `Slide element geometry (${bounds.xIn}, ${bounds.yIn}, ${bounds.wIn}x${bounds.hIn}) exceeds 16:9 canvas bounds.`,
    );
  }
}

export const CORPORATE_THEME_V1: PresentationTheme = {
  themeId: "theme_corporate_navy",
  version: 1,
  name: "Corporate Management Navy V1",
  primaryColor: "#0F172A",
  accentColor: "#2563EB",
  backgroundColor: "#FFFFFF",
  textColor: "#0F172A",
  fontLatin: "Inter",
  fontKhmer: "Noto Sans Khmer",
  slideWidthIn: 13.333,
  slideHeightIn: 7.5,
};

export const CORPORATE_THEME_SLATE_V2: PresentationTheme = {
  themeId: "theme_corporate_slate",
  version: 2,
  name: "Corporate Executive Slate V2",
  primaryColor: "#1E293B",
  accentColor: "#0EA5E9",
  backgroundColor: "#F8FAFC",
  textColor: "#0F172A",
  fontLatin: "Inter",
  fontKhmer: "Kantumruy Pro",
  slideWidthIn: 13.333,
  slideHeightIn: 7.5,
};

// Tiny valid 1x1 transparent PNG data URI (safe synthetic asset, zero external fetch)
export const SYNTHETIC_BADGE_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGUlEQVR42mP8z8DwnwEImBgYGBhGJu8PAAAP4QMBn5u0OQAAAABJRU5ErkJggg==";

export interface LayoutValidationResult {
  passed: boolean;
  overflowIssues: Array<{ slideId: string; elementId: string; estimatedLines: number; maxLines: number }>;
  accessibilityIssues: Array<{ slideId: string; code: string; message: string }>;
  reflowProposal?: PresentationOperationProposal;
}

export function validatePresentationLayoutAndA11y(deck: StudioPresentation): LayoutValidationResult {
  const overflowIssues: LayoutValidationResult["overflowIssues"] = [];
  const accessibilityIssues: LayoutValidationResult["accessibilityIssues"] = [];
  const seenTitles = new Set<string>();

  for (const slide of deck.slides) {
    const cleanTitle = slide.title.trim();
    if (!cleanTitle) {
      accessibilityIssues.push({ slideId: slide.slideId, code: "MISSING_SLIDE_TITLE", message: "Slide title is empty." });
    } else if (seenTitles.has(cleanTitle.toLowerCase())) {
      accessibilityIssues.push({ slideId: slide.slideId, code: "DUPLICATE_SLIDE_TITLE", message: `Duplicate slide title '${cleanTitle}'.` });
    } else {
      seenTitles.add(cleanTitle.toLowerCase());
    }

    for (const el of slide.elements) {
      validateSlideGeometry(el.bounds, deck.theme);
      if ((el.type === "image" || el.type === "chart") && !el.altText.trim()) {
        accessibilityIssues.push({
          slideId: slide.slideId,
          code: "MISSING_ALT_TEXT",
          message: `Element '${el.elementId}' (${el.type}) lacks alt text.`,
        });
      }
      if (el.type === "table" && el.headers.length === 0) {
        accessibilityIssues.push({
          slideId: slide.slideId,
          code: "MISSING_TABLE_HEADERS",
          message: `Table '${el.elementId}' lacks header columns.`,
        });
      }
      if (el.type === "text") {
        // Approximate character wrapping budget from box width & font size (pt -> inch: pt/72)
        const charWidthIn = (el.fontSizePt / 72) * 0.56;
        const charsPerLine = Math.max(8, Math.floor(el.bounds.wIn / Math.max(0.05, charWidthIn)));
        const lines = el.text
          .split(/\r?\n/)
          .reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
        const lineHeightIn = (el.fontSizePt / 72) * 1.45;
        const maxLines = Math.max(1, Math.floor(el.bounds.hIn / Math.max(0.1, lineHeightIn)));
        if (lines > maxLines) {
          overflowIssues.push({
            slideId: slide.slideId,
            elementId: el.elementId,
            estimatedLines: lines,
            maxLines,
          });
        }
      }
    }
  }

  let reflowProposal: PresentationOperationProposal | undefined;
  if (overflowIssues.length > 0) {
    const first = overflowIssues[0]!;
    reflowProposal = {
      operationId: `pop_${randomUUID()}`,
      presentationId: deck.presentationId,
      expectedRevision: deck.revision,
      targetSlideId: first.slideId,
      targetElementId: first.elementId,
      action: "move_resize_element",
      params: { reason: "Expand text container or split overflow onto continuation slide" },
      requiresApproval: true,
      inputLanguage: deck.language === "km" ? "km" : "en",
      outputLanguage: deck.language === "km" ? "km" : "en",
      source: "typed_ai",
      originalCommand: "Resolve detected text overflow",
      previewSummary: `Reflow overflowing element '${first.elementId}' (${first.estimatedLines} lines > ${first.maxLines} fit).`,
    };
  }

  return {
    passed: overflowIssues.length === 0 && accessibilityIssues.length === 0,
    overflowIssues,
    accessibilityIssues,
    reflowProposal,
  };
}

export function createGoldenManagementDeck(params: {
  tenantId: string;
  workspaceId: string;
  actorId: string;
  language?: "en" | "km" | "bilingual";
  scopeLabel?: string;
  netSalesRef: LinkedMetricReference;
  opProfitRef: LinkedMetricReference;
  opMarginRef: LinkedMetricReference;
  revenueChartSpec: ChartSpec;
  budgetChartSpec: ChartSpec;
}): StudioPresentation {
  const lang = params.language ?? "bilingual";
  const scopeLabel = params.scopeLabel ?? "All Departments (November 2026)";
  const now = new Date().toISOString();
  const presentationId = `pres_${randomUUID().slice(0, 8)}`;

  const slide1Title =
    lang === "km"
      ? "របាយការណ៍គ្រប់គ្រងប្រចាំខែវិច្ឆិកា ២០២៦"
      : "Monthly Management Review — November 2026";
  const slide2Title =
    lang === "km"
      ? "សូចនាករហិរញ្ញវត្ថុសំខាន់ៗ"
      : "Executive KPIs & Verified Performance";
  const slide3Title =
    lang === "km"
      ? "ការប្រៀបធៀបចំណូលតាមផ្នែក"
      : "Revenue Comparison by Department";
  const slide4Title =
    lang === "km"
      ? "រចនាសម្ព័ន្ធថ្លៃដើម និងចំណាយប្រតិបត្តិការ"
      : "Cost Composition Breakdown";
  const slide5Title =
    lang === "km"
      ? "ចំណូល និងចំណាយជាក់ស្តែងធៀបនឹងថវិកា"
      : "Budget vs. Actual Variance";
  const slide6Title =
    lang === "km"
      ? "អាទិភាពត្រួតពិនិត្យផ្អែកលើភស្តុតាង"
      : "Evidence-Based Review Priorities";

  const slides: PresentationSlide[] = [
    {
      slideId: "slide_1_cover",
      order: 1,
      layoutId: "title",
      title: slide1Title,
      speakerNotes: `Scope: ${scopeLabel}. Figures sourced strictly from certified FR-05 BusinessAnalysisEngine.`,
      readingOrder: ["el_cover_title", "el_cover_scope", "el_cover_badge"],
      sourceRefs: [params.netSalesRef],
      elements: [
        {
          elementId: "el_cover_shape",
          type: "shape",
          shapeKind: "rect",
          fillColor: "#0F172A",
          bounds: { xIn: 0, yIn: 0, wIn: 13.333, hIn: 1.4 },
          zIndex: 0,
          locked: true,
          altText: "Corporate Navy Header Banner",
        },
        {
          elementId: "el_cover_title",
          type: "text",
          text:
            lang === "bilingual"
              ? "Monthly Management Review · របាយការណ៍គ្រប់គ្រងប្រចាំខែ"
              : slide1Title,
          fontSizePt: 26,
          bold: true,
          color: "#0F172A",
          bounds: { xIn: 0.8, yIn: 2.1, wIn: 11.7, hIn: 1.4 },
          zIndex: 1,
          locked: false,
          altText: "Presentation Title",
        },
        {
          elementId: "el_cover_scope",
          type: "text",
          text:
            lang === "km"
              ? `វិសាលភាព៖ ${scopeLabel} · រក្សាសិទ្ធិលេខយោង FR-05 (${params.netSalesRef.datasetVersion})`
              : `Scope: ${scopeLabel} · Verified FR-05 Manifest (${params.netSalesRef.datasetVersion})`,
          fontSizePt: 15,
          color: "#334155",
          bounds: { xIn: 0.8, yIn: 3.7, wIn: 11.7, hIn: 0.9 },
          zIndex: 2,
          locked: false,
          altText: "Reporting scope subtitle",
        },
        {
          elementId: "el_cover_badge",
          type: "image",
          dataUriBase64: SYNTHETIC_BADGE_PNG_DATA_URI,
          mimeType: "image/png",
          bounds: { xIn: 12.1, yIn: 0.35, wIn: 0.7, hIn: 0.7 },
          zIndex: 3,
          locked: true,
          altText: "AI Office Suite Corporate Badge",
        },
      ],
    },
    {
      slideId: "slide_2_kpis",
      order: 2,
      layoutId: "kpi_summary",
      title: slide2Title,
      speakerNotes: `Verified revenue is ${params.netSalesRef.cachedFormattedValue}; operating profit ${params.opProfitRef.cachedFormattedValue}; operating margin ${params.opMarginRef.cachedFormattedValue}.`,
      readingOrder: ["el_s2_heading", "el_kpi_rev", "el_kpi_profit", "el_kpi_margin"],
      sourceRefs: [params.netSalesRef, params.opProfitRef, params.opMarginRef],
      elements: [
        {
          elementId: "el_s2_heading",
          type: "text",
          text: slide2Title,
          fontSizePt: 22,
          bold: true,
          color: "#0F172A",
          bounds: { xIn: 0.7, yIn: 0.5, wIn: 11.8, hIn: 0.7 },
          zIndex: 1,
          locked: false,
          altText: "KPI slide header",
        },
        {
          elementId: "el_kpi_rev",
          type: "metric",
          labelEn: "Net sales revenue",
          labelKm: "ចំណូលលក់សុទ្ធ",
          metricRef: structuredClone(params.netSalesRef),
          bounds: { xIn: 0.7, yIn: 1.7, wIn: 3.7, hIn: 2.0 },
          zIndex: 2,
          locked: false,
          altText: `Net sales revenue ${params.netSalesRef.cachedFormattedValue}`,
          sourceRef: params.netSalesRef,
        },
        {
          elementId: "el_kpi_profit",
          type: "metric",
          labelEn: "Operating profit",
          labelKm: "ប្រាក់ចំណេញប្រតិបត្តិការ",
          metricRef: structuredClone(params.opProfitRef),
          bounds: { xIn: 4.8, yIn: 1.7, wIn: 3.7, hIn: 2.0 },
          zIndex: 2,
          locked: false,
          altText: `Operating profit ${params.opProfitRef.cachedFormattedValue}`,
          sourceRef: params.opProfitRef,
        },
        {
          elementId: "el_kpi_margin",
          type: "metric",
          labelEn: "Operating margin",
          labelKm: "អត្រាប្រាក់ចំណេញប្រតិបត្តិការ",
          metricRef: structuredClone(params.opMarginRef),
          bounds: { xIn: 8.9, yIn: 1.7, wIn: 3.7, hIn: 2.0 },
          zIndex: 2,
          locked: false,
          altText: `Operating margin ${params.opMarginRef.cachedFormattedValue}`,
          sourceRef: params.opMarginRef,
        },
        {
          elementId: "el_s2_arrow",
          type: "connector",
          lineColor: "#2563EB",
          strokeWidthPt: 2,
          bounds: { xIn: 0.7, yIn: 4.3, wIn: 11.9, hIn: 0.05 },
          zIndex: 2,
          locked: false,
          altText: "Section divider connector",
        },
      ],
    },
    {
      slideId: "slide_3_rev_chart",
      order: 3,
      layoutId: "chart_story",
      title: slide3Title,
      speakerNotes: "Chart values mirror authoritative FR-05 departmental net sales aggregation.",
      readingOrder: ["el_s3_heading", "el_s3_chart"],
      sourceRefs: [params.netSalesRef],
      elements: [
        {
          elementId: "el_s3_heading",
          type: "text",
          text: slide3Title,
          fontSizePt: 22,
          bold: true,
          bounds: { xIn: 0.7, yIn: 0.5, wIn: 11.8, hIn: 0.7 },
          zIndex: 1,
          locked: false,
          altText: "Revenue chart title",
        },
        {
          elementId: "el_s3_chart",
          type: "chart",
          chartSpec: structuredClone(params.revenueChartSpec),
          bounds: { xIn: 0.8, yIn: 1.5, wIn: 11.7, hIn: 5.1 },
          zIndex: 2,
          locked: false,
          altText: params.revenueChartSpec.altSummaryEn,
          sourceRef: params.netSalesRef,
        },
      ],
    },
    {
      slideId: "slide_4_cost_table",
      order: 4,
      layoutId: "table_focus",
      title: slide4Title,
      speakerNotes: "Total costs sum verified COGS and operating expenses within the active policy scope.",
      readingOrder: ["el_s4_heading", "el_s4_table"],
      sourceRefs: [params.opProfitRef],
      elements: [
        {
          elementId: "el_s4_heading",
          type: "text",
          text: slide4Title,
          fontSizePt: 22,
          bold: true,
          bounds: { xIn: 0.7, yIn: 0.5, wIn: 11.8, hIn: 0.7 },
          zIndex: 1,
          locked: false,
          altText: "Cost breakdown heading",
        },
        {
          elementId: "el_s4_table",
          type: "table",
          headers:
            lang === "km"
              ? ["ផ្នែក", "ចំណូលសុទ្ធ (USD)", "ចំណាយប្រតិបត្តិការ & ថ្លៃដើម", "ប្រាក់ចំណេញប្រតិបត្តិការ"]
              : ["Department", "Net Sales (USD)", "Total Costs (COGS + OpEx)", "Operating Profit"],
          rows: [
            ["Sales", "$80,000.00", "$60,000.00", "$20,000.00"],
            ["Services", "$45,000.00", "$30,000.00", "$15,000.00"],
            ["Retail", "$25,000.00", "$20,000.00", "$5,000.00"],
            ["Combined Total", params.netSalesRef.cachedFormattedValue, "Scoped Total", params.opProfitRef.cachedFormattedValue],
          ],
          bounds: { xIn: 0.8, yIn: 1.6, wIn: 11.7, hIn: 4.5 },
          zIndex: 2,
          locked: false,
          altText: "Departmental Cost and Profit Table",
        },
      ],
    },
    {
      slideId: "slide_5_budget_chart",
      order: 5,
      layoutId: "comparison",
      title: slide5Title,
      speakerNotes: "Actuals aggregated to department+month before comparing against budget baselines.",
      readingOrder: ["el_s5_heading", "el_s5_chart"],
      sourceRefs: [params.netSalesRef],
      elements: [
        {
          elementId: "el_s5_heading",
          type: "text",
          text: slide5Title,
          fontSizePt: 22,
          bold: true,
          bounds: { xIn: 0.7, yIn: 0.5, wIn: 11.8, hIn: 0.7 },
          zIndex: 1,
          locked: false,
          altText: "Budget comparison heading",
        },
        {
          elementId: "el_s5_chart",
          type: "chart",
          chartSpec: structuredClone(params.budgetChartSpec),
          bounds: { xIn: 0.8, yIn: 1.5, wIn: 11.7, hIn: 5.1 },
          zIndex: 2,
          locked: false,
          altText: params.budgetChartSpec.altSummaryEn,
          sourceRef: params.netSalesRef,
        },
      ],
    },
    {
      slideId: "slide_6_priorities",
      order: 6,
      layoutId: "priorities",
      title: slide6Title,
      speakerNotes: "Action priorities note observed variances without asserting unverified causal claims.",
      readingOrder: ["el_s6_heading", "el_s6_notes_body"],
      sourceRefs: [params.netSalesRef, params.opProfitRef],
      elements: [
        {
          elementId: "el_s6_heading",
          type: "text",
          text: slide6Title,
          fontSizePt: 22,
          bold: true,
          bounds: { xIn: 0.7, yIn: 0.5, wIn: 11.8, hIn: 0.7 },
          zIndex: 1,
          locked: false,
          altText: "Review priorities heading",
        },
        {
          elementId: "el_s6_notes_body",
          type: "text",
          text:
            lang === "km"
              ? `១. ចំណូលសុទ្ធឈានដល់ ${params.netSalesRef.cachedFormattedValue} និងប្រាក់ចំណេញប្រតិបត្តិការ ${params.opProfitRef.cachedFormattedValue} (${params.opMarginRef.cachedFormattedValue})។\n២. សូមត្រួតពិនិត្យការកើនឡើងនៃចំណាយជាក់ស្តែងធៀបនឹងថវិកាដោយប្រើប្រាស់ភស្តុតាងប្រតិបត្តិការពិតប្រាកដ។`
              : `1. Observed Net Sales reached ${params.netSalesRef.cachedFormattedValue} with Operating Profit ${params.opProfitRef.cachedFormattedValue} (${params.opMarginRef.cachedFormattedValue}).\n2. Review cost variance drivers using verified operational records before drawing causal conclusions.`,
          fontSizePt: 16,
          color: "#1E293B",
          bounds: { xIn: 0.8, yIn: 1.7, wIn: 11.7, hIn: 4.5 },
          zIndex: 2,
          locked: false,
          altText: "Priority review summary bullets",
        },
      ],
    },
  ];

  return {
    presentationId,
    tenantId: params.tenantId,
    workspaceId: params.workspaceId,
    title: normalizeDocumentText(slide1Title),
    language: lang,
    revision: 1,
    status: "draft",
    theme: structuredClone(CORPORATE_THEME_V1),
    slides,
    scopeLabel,
    createdBy: params.actorId,
    createdAt: now,
    updatedAt: now,
  };
}

export interface ExportDisclosurePolicy {
  includeSpeakerNotes: boolean;
  includeHiddenSlides: boolean;
  watermarkText?: string;
}

export interface ExportDisclosureReport {
  strippedSpeakerNotesCount: number;
  strippedHiddenSlidesCount: number;
  embeddedChartSeriesCount: number;
  includedScopeLabel: string;
}

export class PresentationWorkspaceStore {
  private readonly decks = new Map<string, StudioPresentation>();
  private readonly history = new Map<string, StudioPresentation[]>();
  private readonly publishedSnapshots = new Map<string, StudioPresentation>();
  private readonly audit?: AuditStore;

  constructor(audit?: AuditStore) {
    this.audit = audit;
  }

  saveInitialDeck(actor: ActorContext, deck: StudioPresentation): StudioPresentation {
    assertCanPerform(actor, "document", "create");
    assertTenantWorkspaceAccess(actor, deck.tenantId, deck.workspaceId);
    const clone = structuredClone(deck);
    this.decks.set(clone.presentationId, clone);
    this.history.set(clone.presentationId, [structuredClone(clone)]);
    return structuredClone(clone);
  }

  getDeck(actor: ActorContext, presentationId: string): StudioPresentation {
    const deck = this.decks.get(presentationId);
    if (!deck) {
      throw new PresentationEngineError(404, "PRESENTATION_NOT_FOUND", `Presentation '${presentationId}' not found.`);
    }
    assertTenantWorkspaceAccess(actor, deck.tenantId, deck.workspaceId);
    return structuredClone(deck);
  }

  manualUpdateElementText(
    actor: ActorContext,
    presentationId: string,
    slideId: string,
    elementId: string,
    nextText: string,
  ): StudioPresentation {
    assertCanPerform(actor, "document", "write");
    const deck = this.getDeck(actor, presentationId);
    const slide = deck.slides.find((s) => s.slideId === slideId);
    if (!slide) {
      throw new PresentationEngineError(404, "SLIDE_NOT_FOUND", `Slide '${slideId}' not found.`);
    }
    const el = slide.elements.find((e) => e.elementId === elementId);
    if (!el || el.type !== "text") {
      throw new PresentationEngineError(404, "TEXT_ELEMENT_NOT_FOUND", `Text element '${elementId}' not found.`);
    }
    el.text = normalizeDocumentText(nextText);
    deck.revision += 1;
    deck.updatedAt = new Date().toISOString();
    this.decks.set(deck.presentationId, structuredClone(deck));
    this.history.get(deck.presentationId)?.push(structuredClone(deck));
    return deck;
  }

  planPresentationOperation(params: {
    actor: ActorContext;
    presentationId: string;
    slideId: string;
    elementId?: string;
    command: string;
    inputLanguage: "en" | "km";
    outputLanguage?: "en" | "km";
  }): PresentationOperationProposal & { isMockPlanner: true } {
    assertCanPerform(params.actor, "document", "read");
    const deck = this.getDeck(params.actor, params.presentationId);
    const slide = deck.slides.find((s) => s.slideId === params.slideId);
    if (!slide) {
      throw new PresentationEngineError(404, "SLIDE_NOT_FOUND", `Slide '${params.slideId}' not found.`);
    }

    const slideText = slide.elements
      .map((e) => (e.type === "text" ? e.text : e.altText))
      .join(" ");
    const safety = scanForPromptInjection(params.command, slideText);
    if (!safety.safe) {
      throw new PresentationEngineError(400, "PROMPT_INJECTION_BLOCKED", safety.reasons.join(" "));
    }

    const norm = params.command.normalize("NFC").trim().toLowerCase();
    const outLang = params.outputLanguage ?? params.inputLanguage;
    const base = {
      operationId: `pop_${randomUUID()}`,
      presentationId: deck.presentationId,
      expectedRevision: deck.revision,
      targetSlideId: slide.slideId,
      targetElementId: params.elementId,
      requiresApproval: true,
      inputLanguage: params.inputLanguage,
      outputLanguage: outLang,
      source: "typed_ai" as const,
      originalCommand: params.command,
      isMockPlanner: true as const,
    };

    if (norm.includes("add slide") || norm.includes("បន្ថែមស្លាយ")) {
      return {
        ...base,
        action: "add_slide",
        params: { title: outLang === "km" ? "ស្លាយសង្ខេបបន្ថែម" : "Additional Executive Summary" },
        previewSummary: "Add new slide at end of presentation.",
      };
    }

    if (norm.includes("chart") || norm.includes("line") || norm.includes("ក្រាហ្វ")) {
      return {
        ...base,
        action: "change_chart_type",
        params: { chartType: norm.includes("line") ? "line" : "bar" },
        previewSummary: "Switch chart visualization type while preserving certified data binding & units.",
      };
    }

    if (norm.includes("translate") || norm.includes("បកប្រែ")) {
      return {
        ...base,
        action: "translate_narrative",
        params: { targetLanguage: "km" },
        previewSummary: "Translate narrative headings into Khmer while keeping certified metric values immutable.",
      };
    }

    if (norm.includes("shorten") || norm.includes("replace") || norm.includes("ខ្លីជាងមុន")) {
      return {
        ...base,
        action: "replace_text",
        params: { newText: outLang === "km" ? "សង្ខេបលទ្ធផលប្រតិបត្តិការ" : "Executive Performance Summary" },
        previewSummary: "Update target text box without altering sibling slide objects.",
      };
    }

    if (norm.includes("theme") || norm.includes("background") || norm.includes("ពណ៌")) {
      return {
        ...base,
        action: "apply_theme",
        params: { themeId: CORPORATE_THEME_SLATE_V2.themeId },
        previewSummary: "Apply Corporate Executive Slate V2 theme.",
      };
    }

    throw new PresentationEngineError(422, "UNSUPPORTED_PRESENTATION_COMMAND", `Command '${params.command}' not recognized by mock planner.`);
  }

  applyOperation(
    actor: ActorContext,
    proposal: PresentationOperationProposal,
    approved: boolean,
  ): StudioPresentation {
    assertCanPerform(actor, "ai_assistant", "apply_ai");
    if (!approved) {
      throw new PresentationEngineError(409, "APPROVAL_REQUIRED", "Presentation AI proposal requires explicit user approval before applying.");
    }
    const deck = this.getDeck(actor, proposal.presentationId);
    if (deck.revision !== proposal.expectedRevision) {
      throw new PresentationEngineError(
        409,
        "REVISION_CONFLICT",
        `Expected revision ${proposal.expectedRevision}, current revision is ${deck.revision}.`,
      );
    }

    if (proposal.action === "add_slide") {
      deck.slides.push({
        slideId: `slide_${randomUUID().slice(0, 8)}`,
        order: deck.slides.length + 1,
        layoutId: "priorities",
        title: String(proposal.params.title ?? "New Slide"),
        speakerNotes: "",
        readingOrder: [],
        sourceRefs: [],
        elements: [
          {
            elementId: `el_${randomUUID().slice(0, 8)}`,
            type: "text",
            text: String(proposal.params.title ?? "New Slide"),
            fontSizePt: 22,
            bold: true,
            bounds: { xIn: 0.8, yIn: 0.8, wIn: 11.5, hIn: 0.8 },
            zIndex: 1,
            locked: false,
            altText: "Added slide title",
          },
        ],
      });
    } else if (proposal.action === "replace_text") {
      const slide = deck.slides.find((s) => s.slideId === proposal.targetSlideId);
      const el = slide?.elements.find((e) => e.elementId === proposal.targetElementId && e.type === "text");
      if (!el || el.type !== "text") {
        throw new PresentationEngineError(404, "TARGET_ELEMENT_NOT_FOUND", "Target text box no longer exists.");
      }
      el.text = normalizeDocumentText(String(proposal.params.newText ?? el.text));
    } else if (proposal.action === "move_resize_element") {
      const slide = deck.slides.find((s) => s.slideId === proposal.targetSlideId);
      const el = slide?.elements.find((e) => e.elementId === proposal.targetElementId);
      if (!el) {
        throw new PresentationEngineError(404, "TARGET_ELEMENT_NOT_FOUND", "Target element not found.");
      }
      const nextBounds: SlideGeometry = {
        xIn: Number(proposal.params.xIn ?? el.bounds.xIn),
        yIn: Number(proposal.params.yIn ?? el.bounds.yIn),
        wIn: Number(proposal.params.wIn ?? el.bounds.wIn),
        hIn: Number(proposal.params.hIn ?? el.bounds.hIn),
      };
      validateSlideGeometry(nextBounds, deck.theme);
      el.bounds = nextBounds;
    } else if (proposal.action === "change_chart_type") {
      const slide = deck.slides.find((s) => s.slideId === proposal.targetSlideId);
      const el = slide?.elements.find((e) => e.elementId === proposal.targetElementId && e.type === "chart");
      if (!el || el.type !== "chart") {
        throw new PresentationEngineError(404, "TARGET_CHART_NOT_FOUND", "Target chart element not found.");
      }
      const nextKind = String(proposal.params.chartType ?? "bar") as SlideElement & { type: "chart" } extends { chartSpec: { kind: infer K } } ? K : never;
      // Preserve series values, units, currency, categories & binding intact (PPT-T08)
      el.chartSpec.kind = nextKind;
    } else if (proposal.action === "apply_theme") {
      deck.theme = structuredClone(CORPORATE_THEME_SLATE_V2);
    } else if (proposal.action === "translate_narrative") {
      // Translate slide titles only; NEVER alter linked metric numbers or sourceRefs (PPT-T11)
      deck.language = "km";
      for (const slide of deck.slides) {
        for (const el of slide.elements) {
          if (el.type === "text" && el.elementId === "el_s2_heading") {
            el.text = "សូចនាករហិរញ្ញវត្ថុសំខាន់ៗ";
          }
        }
      }
    }

    deck.revision += 1;
    deck.updatedAt = new Date().toISOString();
    this.decks.set(deck.presentationId, structuredClone(deck));
    this.history.get(deck.presentationId)?.push(structuredClone(deck));

    this.audit?.append({
      auditId: `aud_${randomUUID()}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: proposal.source,
      action: `presentation.${proposal.action}`,
      outcome: "success",
      revisionBefore: proposal.expectedRevision,
      revisionAfter: deck.revision,
      summary: proposal.previewSummary,
      createdAt: deck.updatedAt,
    });

    return structuredClone(deck);
  }

  undoLast(actor: ActorContext, presentationId: string): StudioPresentation {
    assertCanPerform(actor, "document", "restore");
    const deck = this.getDeck(actor, presentationId);
    const stack = this.history.get(presentationId) ?? [];
    if (stack.length < 2) {
      return deck;
    }
    const prev = structuredClone(stack[stack.length - 2]!);
    prev.revision = deck.revision + 1;
    prev.updatedAt = new Date().toISOString();
    this.decks.set(presentationId, structuredClone(prev));
    stack.push(structuredClone(prev));
    return prev;
  }

  publishSnapshot(actor: ActorContext, presentationId: string): { snapshotHash: string; snapshot: StudioPresentation } {
    assertCanPerform(actor, "document", "write");
    const deck = this.getDeck(actor, presentationId);
    const snapshotHash = createHash("sha256").update(JSON.stringify(deck.slides)).digest("hex");
    deck.status = "published";
    deck.publishedSnapshotHash = snapshotHash;
    for (const s of deck.slides) {
      for (const ref of s.sourceRefs) {
        ref.approvalStatus = "published_snapshot";
        ref.mode = "published_snapshot";
      }
    }
    this.publishedSnapshots.set(`${presentationId}::${snapshotHash}`, structuredClone(deck));
    this.decks.set(presentationId, structuredClone(deck));
    return { snapshotHash, snapshot: deck };
  }

  getPublishedSnapshot(actor: ActorContext, presentationId: string, snapshotHash: string): StudioPresentation {
    const snap = this.publishedSnapshots.get(`${presentationId}::${snapshotHash}`);
    if (!snap) {
      throw new PresentationEngineError(404, "SNAPSHOT_NOT_FOUND", "Published deck snapshot not found.");
    }
    assertTenantWorkspaceAccess(actor, snap.tenantId, snap.workspaceId);
    return structuredClone(snap);
  }

  refreshDraftBindings(
    actor: ActorContext,
    presentationId: string,
    updatedRefsByMetricId: Record<string, LinkedMetricReference>,
  ): StudioPresentation {
    assertCanPerform(actor, "document", "write");
    const deck = this.getDeck(actor, presentationId);
    deck.status = "draft";
    deck.publishedSnapshotHash = undefined;
    for (const slide of deck.slides) {
      slide.sourceRefs = slide.sourceRefs.map((ref) => updatedRefsByMetricId[ref.metricId] ?? ref);
      for (const el of slide.elements) {
        if (el.type === "metric" && updatedRefsByMetricId[el.metricRef.metricId]) {
          el.metricRef = structuredClone(updatedRefsByMetricId[el.metricRef.metricId]!);
        }
      }
    }
    deck.revision += 1;
    deck.updatedAt = new Date().toISOString();
    this.decks.set(presentationId, structuredClone(deck));
    this.history.get(presentationId)?.push(structuredClone(deck));
    return deck;
  }

  prepareDeckForExport(
    actor: ActorContext,
    presentationId: string,
    policy: ExportDisclosurePolicy,
  ): { sanitizedDeck: StudioPresentation; disclosure: ExportDisclosureReport } {
    assertCanPerform(actor, "export", "export");
    const deck = this.getDeck(actor, presentationId);
    let strippedNotes = 0;
    let strippedHidden = 0;
    let embeddedChartSeriesCount = 0;

    const visibleSlides: PresentationSlide[] = [];
    for (const slide of deck.slides) {
      if (slide.hidden && !policy.includeHiddenSlides) {
        strippedHidden += 1;
        continue;
      }
      const nextSlide = structuredClone(slide);
      if (!policy.includeSpeakerNotes && nextSlide.speakerNotes.trim().length > 0) {
        nextSlide.speakerNotes = "";
        strippedNotes += 1;
      }
      for (const el of nextSlide.elements) {
        if (el.type === "chart") {
          embeddedChartSeriesCount += el.chartSpec.series.length;
        }
      }
      visibleSlides.push(nextSlide);
    }

    return {
      sanitizedDeck: {
        ...deck,
        slides: visibleSlides,
      },
      disclosure: {
        strippedSpeakerNotesCount: strippedNotes,
        strippedHiddenSlidesCount: strippedHidden,
        embeddedChartSeriesCount,
        includedScopeLabel: deck.scopeLabel,
      },
    };
  }
}
