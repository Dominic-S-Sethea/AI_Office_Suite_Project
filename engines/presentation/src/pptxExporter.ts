import PptxGenJS from "pptxgenjs";
import type { StudioPresentation } from "@ai-office-suite/shared-contracts";
import type { ExportDisclosurePolicy, ExportDisclosureReport } from "./presentationEngine.ts";

function cleanHex(hex: string | undefined, fallback = "0F172A"): string {
  return (hex ?? fallback).replace(/^#/, "").slice(0, 6).toUpperCase();
}

function hasKhmer(text: string): boolean {
  return /[\u1780-\u17FF]/.test(text);
}

export async function exportPresentationToPptxBuffer(
  deck: StudioPresentation,
  policy: ExportDisclosurePolicy = { includeSpeakerNotes: true, includeHiddenSlides: false },
): Promise<{ buffer: Buffer; filename: string; disclosure: ExportDisclosureReport }> {
  const PptxCtor =
    (PptxGenJS as unknown as { default?: typeof PptxGenJS.default }).default ??
    (PptxGenJS as unknown as typeof PptxGenJS.default);
  const pptx = new PptxCtor();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  pptx.company = "AI Office Suite";
  pptx.revision = String(deck.revision);

  let strippedSpeakerNotesCount = 0;
  let strippedHiddenSlidesCount = 0;
  let embeddedChartSeriesCount = 0;

  for (const slideModel of deck.slides) {
    if (slideModel.hidden && !policy.includeHiddenSlides) {
      strippedHiddenSlidesCount += 1;
      continue;
    }

    const slide = pptx.addSlide();
    slide.background = { color: cleanHex(deck.theme.backgroundColor, "FFFFFF") };

    const sortedElements = [...slideModel.elements].sort((a, b) => a.zIndex - b.zIndex);
    for (const el of sortedElements) {
      const { xIn, yIn, wIn, hIn } = el.bounds;
      if (el.type === "shape") {
        slide.addShape(pptx.ShapeType.rect, {
          x: xIn,
          y: yIn,
          w: wIn,
          h: hIn,
          fill: { color: cleanHex(el.fillColor, "0F172A") },
          line: { color: cleanHex(el.borderColor ?? el.fillColor, "0F172A"), pt: 0 },
        });
      } else if (el.type === "connector") {
        slide.addShape(pptx.ShapeType.line, {
          x: xIn,
          y: yIn,
          w: wIn,
          h: 0,
          line: { color: cleanHex(el.lineColor, "2563EB"), pt: el.strokeWidthPt },
        });
      } else if (el.type === "text") {
        slide.addText(el.text, {
          x: xIn,
          y: yIn,
          w: wIn,
          h: hIn,
          fontSize: el.fontSizePt,
          bold: Boolean(el.bold),
          color: cleanHex(el.color ?? deck.theme.textColor, "0F172A"),
          fontFace: hasKhmer(el.text) ? deck.theme.fontKhmer : deck.theme.fontLatin,
          align: el.align ?? "left",
          valign: "top",
        });
      } else if (el.type === "image") {
        slide.addImage({
          data: el.dataUriBase64,
          x: xIn,
          y: yIn,
          w: wIn,
          h: hIn,
          altText: el.altText,
        });
      } else if (el.type === "metric") {
        slide.addShape(pptx.ShapeType.roundRect, {
          x: xIn,
          y: yIn,
          w: wIn,
          h: hIn,
          fill: { color: "F8FAFC" },
          line: { color: "CBD5E1", pt: 1 },
        });
        const label = deck.language === "km" ? el.labelKm : el.labelEn;
        slide.addText(
          [
            { text: `${label}\n`, options: { fontSize: 12, color: "475569", fontFace: hasKhmer(label) ? deck.theme.fontKhmer : deck.theme.fontLatin } },
            { text: `${el.metricRef.cachedFormattedValue}\n`, options: { fontSize: 22, bold: true, color: cleanHex(deck.theme.primaryColor) } },
            { text: el.metricRef.reportingPeriod, options: { fontSize: 10, color: "64748B" } },
          ],
          { x: xIn + 0.15, y: yIn + 0.15, w: Math.max(0.5, wIn - 0.3), h: Math.max(0.5, hIn - 0.3), valign: "top" },
        );
      } else if (el.type === "table") {
        const rows: PptxGenJS.default.TableRow[] = [
          el.headers.map((h) => ({
            text: h,
            options: { bold: true, fill: { color: cleanHex(deck.theme.primaryColor) }, color: "FFFFFF", fontFace: hasKhmer(h) ? deck.theme.fontKhmer : deck.theme.fontLatin },
          })),
          ...el.rows.map((r) =>
            r.map((cell) => ({
              text: cell,
              options: { color: "0F172A", fill: { color: "FFFFFF" }, fontFace: hasKhmer(cell) ? deck.theme.fontKhmer : deck.theme.fontLatin },
            })),
          ),
        ];
        slide.addTable(rows, {
          x: xIn,
          y: yIn,
          w: wIn,
          border: { type: "solid", color: "CBD5E1", pt: 1 },
          fontSize: 11,
        });
      } else if (el.type === "chart") {
        const spec = el.chartSpec;
        embeddedChartSeriesCount += spec.series.length;
        const chartType =
          spec.kind === "line"
            ? pptx.ChartType.line
            : spec.kind === "pie"
              ? pptx.ChartType.pie
              : pptx.ChartType.bar;
        const data = spec.series.map((s) => ({
          name: deck.language === "km" ? s.labelKm : s.labelEn,
          labels: spec.categories,
          values: s.values.map((v) => v.value ?? 0),
        }));
        slide.addChart(chartType, data, {
          x: xIn,
          y: yIn,
          w: wIn,
          h: hIn,
          showLegend: spec.series.length > 1,
          showTitle: true,
          title: deck.language === "km" ? spec.titleKm : spec.titleEn,
          barGrouping: spec.kind === "stacked_bar" ? "stacked" : "clustered",
          chartColors: ["2563EB", "94A3B8", "0EA5E9"],
        });
      }
    }

    if (policy.includeSpeakerNotes && slideModel.speakerNotes.trim().length > 0) {
      slide.addNotes(slideModel.speakerNotes);
    } else if (!policy.includeSpeakerNotes && slideModel.speakerNotes.trim().length > 0) {
      strippedSpeakerNotesCount += 1;
    }
  }

  const rawOut = await pptx.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(rawOut) ? rawOut : Buffer.from(rawOut as ArrayBuffer);
  const safeBase = deck.title.replace(/[^\w\u1780-\u17FF-]+/g, "_").slice(0, 60) || "presentation";

  return {
    buffer,
    filename: `${safeBase}.pptx`,
    disclosure: {
      strippedSpeakerNotesCount,
      strippedHiddenSlidesCount,
      embeddedChartSeriesCount,
      includedScopeLabel: deck.scopeLabel,
    },
  };
}
