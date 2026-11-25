import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as echarts from "echarts";
import type { ChartSpec } from "@ai-office-suite/shared-contracts";
import { validateChartSpecSafety } from "@ai-office-suite/validation";
import {
  detectChromiumBinary,
  HARDENED_CHROMIUM_BASE_ARGS,
  PDF_RENDER_CSP_META,
  PdfExportError,
  resolveLocalFontFacesCss,
} from "@ai-office-suite/file-conversion";

const execFileAsync = promisify(execFile);

export class ChartAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ChartAdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function compileChartSpecToEChartsOption(
  spec: ChartSpec,
  language: "en" | "km" = "en",
): Record<string, unknown> {
  const safety = validateChartSpecSafety(spec);
  if (!safety.safe) {
    throw new ChartAdapterError(400, "UNSAFE_CHART_SPEC", safety.reasons.join(" "));
  }

  const title = language === "km" ? spec.titleKm : spec.titleEn;
  const altSummary = language === "km" ? spec.altSummaryKm : spec.altSummaryEn;
  const palette = ["#2563EB", "#64748B", "#0EA5E9", "#10B981"];

  if (spec.kind === "pie") {
    const firstSeries = spec.series[0];
    return {
      animation: false,
      color: palette,
      aria: { enabled: true, description: altSummary },
      title: {
        text: title,
        left: 16,
        top: 12,
        textStyle: { fontFamily: "Inter, Noto Sans Khmer, sans-serif", fontSize: 15, color: "#0F172A" },
      },
      tooltip: { trigger: "item", renderMode: "richText" },
      legend: { bottom: 8, textStyle: { fontFamily: "Inter, Noto Sans Khmer, sans-serif" } },
      series: [
        {
          name: firstSeries ? (language === "km" ? firstSeries.labelKm : firstSeries.labelEn) : title,
          type: "pie",
          radius: ["35%", "65%"],
          data: spec.categories.map((cat, idx) => ({
            name: cat,
            value: firstSeries?.values[idx]?.value ?? 0,
          })),
        },
      ],
    };
  }

  const echartsSeries = spec.series.map((ser, sIdx) => ({
    name: language === "km" ? ser.labelKm : ser.labelEn,
    type: spec.kind === "line" ? "line" : "bar",
    stack: spec.kind === "stacked_bar" ? "total" : undefined,
    smooth: false,
    itemStyle: { color: palette[sIdx % palette.length] },
    label: { show: spec.categories.length <= 6, position: "top" },
    data: ser.values.map((v) => v.value),
  }));

  const isHorizontal = spec.kind === "bar";
  const categoryAxis = {
    type: "category",
    data: spec.categories,
    axisLabel: { fontFamily: "Inter, Noto Sans Khmer, sans-serif", color: "#334155" },
  };
  const valueAxis = {
    type: "value",
    min: spec.yAxisStartsAtZero ? 0 : undefined,
    axisLabel: { color: "#334155" },
  };

  return {
    animation: false,
    color: palette,
    aria: { enabled: true, description: altSummary },
    title: {
      text: title,
      left: 16,
      top: 10,
      textStyle: { fontFamily: "Inter, Noto Sans Khmer, sans-serif", fontSize: 15, color: "#0F172A" },
    },
    tooltip: { trigger: "axis", renderMode: "richText" },
    legend: {
      show: spec.series.length > 1,
      top: 10,
      right: 16,
      textStyle: { fontFamily: "Inter, Noto Sans Khmer, sans-serif" },
    },
    grid: { left: 72, right: 28, top: 54, bottom: 44 },
    xAxis: isHorizontal ? valueAxis : categoryAxis,
    yAxis: isHorizontal ? categoryAxis : valueAxis,
    series: echartsSeries,
  };
}

export function renderChartSpecToAccessibleTable(spec: ChartSpec, language: "en" | "km" = "en"): string {
  const title = language === "km" ? spec.titleKm : spec.titleEn;
  const headers = [
    language === "km" ? "ប្រភេទ" : "Category",
    ...spec.series.map((s) => (language === "km" ? s.labelKm : s.labelEn)),
  ];
  const rows = spec.categories.map((cat, ci) => {
    const cells = spec.series.map((s) => {
      const pt = s.values[ci];
      return `<td>${escapeHtml(pt?.formatted ?? String(pt?.value ?? "N/A"))}</td>`;
    });
    return `<tr><th scope="row">${escapeHtml(cat)}</th>${cells.join("")}</tr>`;
  });
  return `<table aria-label="${escapeHtml(title)}"><thead><tr>${headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export function renderChartSpecToSvg(
  spec: ChartSpec,
  width = 680,
  height = 360,
  language: "en" | "km" = "en",
): { svg: string; accessibleTableHtml: string } {
  const option = compileChartSpecToEChartsOption(spec, language);
  const chart = echarts.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width,
    height,
  });
  try {
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    return {
      svg,
      accessibleTableHtml: renderChartSpecToAccessibleTable(spec, language),
    };
  } finally {
    chart.dispose();
  }
}

/**
 * Constrained declarative Vega-Lite JSON compiler sharing the exact same ChartSpec
 * (benchmark comparison alternative without installing a second runtime).
 */
export function compileChartSpecToVegaLiteJson(
  spec: ChartSpec,
  language: "en" | "km" = "en",
): Record<string, unknown> {
  const safety = validateChartSpecSafety(spec);
  if (!safety.safe) {
    throw new ChartAdapterError(400, "UNSAFE_CHART_SPEC", safety.reasons.join(" "));
  }
  const values: Array<{ category: string; series: string; value: number | null; state: string }> = [];
  spec.categories.forEach((cat, ci) => {
    spec.series.forEach((s) => {
      const pt = s.values[ci];
      values.push({
        category: cat,
        series: language === "km" ? s.labelKm : s.labelEn,
        value: pt?.value ?? null,
        state: pt?.state ?? "missing",
      });
    });
  });

  const mark = spec.kind === "line" ? "line" : spec.kind === "pie" ? "arc" : "bar";
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: language === "km" ? spec.titleKm : spec.titleEn,
    description: language === "km" ? spec.altSummaryKm : spec.altSummaryEn,
    params: [{ name: "category_select", select: { type: "point", fields: ["category"] } }],
    data: { values },
    mark,
    encoding: {
      x: { field: "category", type: "nominal", title: null },
      y: {
        field: "value",
        type: "quantitative",
        scale: { zero: spec.yAxisStartsAtZero },
        title: spec.currency ?? spec.unit,
      },
      color: { field: "series", type: "nominal" },
      xOffset: spec.series.length > 1 && mark === "bar" ? { field: "series" } : undefined,
      opacity: {
        condition: { param: "category_select", value: 1 },
        value: 0.35,
      },
    },
  };
}

export async function renderChartSpecPngViaEdge(
  spec: ChartSpec,
  outputPngPath: string,
  width = 760,
  height = 420,
  language: "en" | "km" = "en",
): Promise<{ pngPath: string; byteLength: number }> {
  const browserPath = detectChromiumBinary();
  if (!browserPath) {
    throw new PdfExportError(503, "PDF_RENDERER_UNAVAILABLE", "No Chromium/Edge binary detected.");
  }
  const { svg } = renderChartSpecToSvg(spec, width, height, language);
  const fontCss = resolveLocalFontFacesCss();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ai-office-bi-chart-"));
  const userDataDir = path.join(tmpDir, "profile");
  const htmlPath = path.join(tmpDir, "chart.html");
  try {
    writeFileSync(
      htmlPath,
      `<!DOCTYPE html><html lang="km"><head><meta charset="UTF-8"/>${PDF_RENDER_CSP_META}<style>${fontCss} body{margin:16px;background:#fff;font-family:'Inter','Noto Sans Khmer',sans-serif;}</style></head><body>${svg}</body></html>`,
      "utf8",
    );
    await execFileAsync(
      browserPath,
      [
        ...HARDENED_CHROMIUM_BASE_ARGS,
        `--user-data-dir=${userDataDir}`,
        `--window-size=${width + 40},${height + 40}`,
        `--screenshot=${path.resolve(outputPngPath)}`,
        pathToFileURL(htmlPath).href,
      ],
      { timeout: 25_000, windowsHide: true },
    );
    return { pngPath: outputPngPath, byteLength: readFileSync(outputPngPath).byteLength };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
