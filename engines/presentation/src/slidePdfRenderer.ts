import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  ChartSpec,
  PresentationSlide,
  StudioPresentation,
} from "@ai-office-suite/shared-contracts";
import {
  countPdfPages,
  detectChromiumBinary,
  HARDENED_CHROMIUM_BASE_ARGS,
  PDF_RENDER_CSP_META,
  PdfExportError,
  resolveLocalFontFacesCss,
  sanitizeCssColor,
  sanitizeSafeImageDataUri,
} from "@ai-office-suite/file-conversion";

const execFileAsync = promisify(execFile);

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeColor(raw: unknown, fallback: string): string {
  return sanitizeCssColor(raw) ?? fallback;
}

function renderSimpleChartSvg(spec: ChartSpec, widthPx: number, heightPx: number, lang: "en" | "km" | "bilingual"): string {
  const cats = spec.categories;
  const maxVal = Math.max(
    1,
    ...spec.series.flatMap((s) => s.values.map((v) => Math.abs(v.value ?? 0))),
  );
  const padL = 70;
  const padB = 45;
  const padT = 56;
  const plotW = Math.max(120, widthPx - padL - 30);
  const plotH = Math.max(100, heightPx - padT - padB);
  const colors = ["#2563EB", "#94A3B8", "#0EA5E9"];

  const groupW = cats.length > 0 ? plotW / cats.length : plotW;
  const seriesCount = Math.max(1, spec.series.length);
  const barW = Math.max(12, Math.min(44, (groupW * 0.72) / seriesCount));

  const bars: string[] = [];
  cats.forEach((cat, ci) => {
    const gx = padL + ci * groupW + (groupW - barW * seriesCount) / 2;
    spec.series.forEach((ser, si) => {
      const pt = ser.values[ci];
      const val = pt?.value ?? 0;
      const h = (Math.abs(val) / maxVal) * plotH;
      const bx = gx + si * (barW + 4);
      const by = padT + plotH - h;
      const color = colors[si % colors.length]!;
      bars.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="3" />`);
      bars.push(`<text x="${(bx + barW / 2).toFixed(1)}" y="${(by - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="#0F172A">${esc(pt?.formatted ?? "")}</text>`);
    });
    bars.push(`<text x="${(padL + ci * groupW + groupW / 2).toFixed(1)}" y="${(padT + plotH + 22).toFixed(1)}" text-anchor="middle" font-size="13" fill="#334155">${esc(cat)}</text>`);
  });

  const title = lang === "km" ? spec.titleKm : spec.titleEn;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">
    <rect width="100%" height="100%" fill="#FFFFFF" stroke="#E2E8F0" rx="8" />
    <text x="${padL}" y="24" font-size="15" font-weight="700" fill="#0F172A">${esc(title)}</text>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#94A3B8" stroke-width="1.5" />
    ${bars.join("\n")}
  </svg>`;
}

function renderSlideHtml(slide: PresentationSlide, deck: StudioPresentation): string {
  const primaryColor = safeColor(deck.theme.primaryColor, "#2563EB");
  const textColor = safeColor(deck.theme.textColor, "#0F172A");
  const bgColor = safeColor(deck.theme.backgroundColor, "#FFFFFF");

  const items = slide.elements
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((el) => {
      const leftPx = Math.round(el.bounds.xIn * 96);
      const topPx = Math.round(el.bounds.yIn * 96);
      const wPx = Math.round(el.bounds.wIn * 96);
      const hPx = Math.round(el.bounds.hIn * 96);
      const baseStyle = `position:absolute;left:${leftPx}px;top:${topPx}px;width:${wPx}px;height:${hPx}px;box-sizing:border-box;`;

      if (el.type === "shape") {
        const fill = safeColor(el.fillColor, "#E2E8F0");
        return `<div style="${baseStyle}background:${fill};border-radius:${el.shapeKind === "round_rect" ? "8px" : "0"};"></div>`;
      }
      if (el.type === "connector") {
        const lineColor = safeColor(el.lineColor, "#64748B");
        const stroke = Number.isFinite(el.strokeWidthPt) ? Math.min(24, Math.max(0.5, el.strokeWidthPt)) : 1;
        return `<div style="${baseStyle}border-top:${stroke}px solid ${lineColor};"></div>`;
      }
      if (el.type === "image") {
        const safeUri = sanitizeSafeImageDataUri(el.dataUriBase64);
        if (!safeUri) {
          return `<div style="${baseStyle}background:#F1F5F9;border:1px dashed #94A3B8;display:flex;align-items:center;justify-content:center;font-size:11pt;color:#64748B;">Blocked unsafe image URI</div>`;
        }
        return `<img src="${safeUri}" alt="${esc(el.altText)}" style="${baseStyle}object-fit:contain;" />`;
      }
      if (el.type === "text") {
        const elColor = safeColor(el.color, textColor);
        const fontSize = Number.isFinite(el.fontSizePt) ? Math.min(144, Math.max(6, el.fontSizePt)) : 14;
        return `<div style="${baseStyle}font-size:${fontSize}pt;font-weight:${el.bold ? 700 : 400};color:${elColor};line-height:1.45;white-space:pre-wrap;overflow-wrap:break-word;">${esc(el.text)}</div>`;
      }
      if (el.type === "metric") {
        const label = deck.language === "km" ? el.labelKm : el.labelEn;
        return `<div style="${baseStyle}background:#F8FAFC;border:1px solid #CBD5E1;border-radius:10px;padding:16px;">
          <div style="font-size:12pt;color:#475569;margin-bottom:8px;">${esc(label)}</div>
          <div style="font-size:24pt;font-weight:700;color:${primaryColor};">${esc(el.metricRef.cachedFormattedValue)}</div>
          <div style="font-size:10pt;color:#64748B;margin-top:8px;">${esc(el.metricRef.reportingPeriod)}</div>
        </div>`;
      }
      if (el.type === "table") {
        const head = `<tr>${el.headers.map((h) => `<th style="background:${primaryColor};color:#fff;padding:8px 12px;text-align:left;border:1px solid #CBD5E1;">${esc(h)}</th>`).join("")}</tr>`;
        const rows = el.rows
          .map(
            (r) =>
              `<tr>${r.map((c) => `<td style="padding:8px 12px;border:1px solid #CBD5E1;color:#0F172A;">${esc(c)}</td>`).join("")}</tr>`,
          )
          .join("");
        return `<div style="${baseStyle}"><table style="width:100%;border-collapse:collapse;font-size:12pt;"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
      }
      return `<div style="${baseStyle}">${renderSimpleChartSvg(el.chartSpec, wPx, hPx, deck.language)}</div>`;
    })
    .join("\n");

  return `<section class="slide" style="position:relative;width:1280px;height:720px;background:${bgColor};overflow:hidden;page-break-after:always;break-after:page;">${items}</section>`;
}

export function buildPresentationHtml(deck: StudioPresentation, slideIndex?: number): string {
  const fontCss = resolveLocalFontFacesCss();
  const targetSlides =
    slideIndex !== undefined && deck.slides[slideIndex] ? [deck.slides[slideIndex]!] : deck.slides;
  return `<!DOCTYPE html>
<html lang="km">
<head>
  <meta charset="UTF-8" />
  ${PDF_RENDER_CSP_META}
  <title>${esc(deck.title)}</title>
  <style>
    ${fontCss}
    @page { size: 1280px 720px; margin: 0; }
    html, body { margin: 0; padding: 0; font-family: 'Inter', 'Noto Sans Khmer', 'Kantumruy Pro', sans-serif; }
  </style>
</head>
<body>${targetSlides.map((s) => renderSlideHtml(s, deck)).join("\n")}</body>
</html>`;
}

export async function exportPresentationPdf(deck: StudioPresentation): Promise<{
  pdfBuffer: Buffer;
  pageCount: number;
  engine: "chromium-harfbuzz";
}> {
  const browserPath = detectChromiumBinary();
  if (!browserPath) {
    throw new PdfExportError(503, "PDF_RENDERER_UNAVAILABLE", "No Chromium or Edge binary detected.");
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ai-office-pptx-pdf-"));
  const userDataDir = path.join(tmpDir, "profile");
  const htmlPath = path.join(tmpDir, "deck.html");
  const pdfPath = path.join(tmpDir, "deck.pdf");
  try {
    writeFileSync(htmlPath, buildPresentationHtml(deck), "utf8");
    const fileUrl = pathToFileURL(htmlPath).href;
    await execFileAsync(
      browserPath,
      [
        ...HARDENED_CHROMIUM_BASE_ARGS,
        `--user-data-dir=${userDataDir}`,
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        fileUrl,
      ],
      { timeout: 25_000, windowsHide: true },
    );
    const pdfBuffer = readFileSync(pdfPath);
    return { pdfBuffer, pageCount: countPdfPages(pdfBuffer), engine: "chromium-harfbuzz" };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function renderPresentationSlideScreenshot(
  deck: StudioPresentation,
  slideIndex: number,
  outputPngPath: string,
): Promise<{ pngPath: string; byteLength: number }> {
  const browserPath = detectChromiumBinary();
  if (!browserPath) {
    throw new PdfExportError(503, "PDF_RENDERER_UNAVAILABLE", "No Chromium or Edge binary detected.");
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ai-office-slide-shot-"));
  const userDataDir = path.join(tmpDir, "profile");
  const htmlPath = path.join(tmpDir, "slide.html");
  try {
    writeFileSync(htmlPath, buildPresentationHtml(deck, slideIndex), "utf8");
    const fileUrl = pathToFileURL(htmlPath).href;
    await execFileAsync(
      browserPath,
      [
        ...HARDENED_CHROMIUM_BASE_ARGS,
        `--user-data-dir=${userDataDir}`,
        "--window-size=1280,720",
        `--screenshot=${path.resolve(outputPngPath)}`,
        fileUrl,
      ],
      { timeout: 25_000, windowsHide: true },
    );
    return { pngPath: outputPngPath, byteLength: readFileSync(outputPngPath).byteLength };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
