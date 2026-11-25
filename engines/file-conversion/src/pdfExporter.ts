import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DocumentBlock, StudioDocument, TextRun } from "@ai-office-suite/shared-contracts";

const execFileAsync = promisify(execFile);

export class PdfExportError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "PdfExportError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function findInSystemPath(binaryNames: string[]): string | null {
  const rawPath = process.env.PATH ?? "";
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of binaryNames) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function detectChromiumBinary(): string | null {
  for (const envKey of ["CHROMIUM_PATH", "CHROME_PATH", "PUPPETEER_EXECUTABLE_PATH"] as const) {
    const envPath = process.env[envKey]?.trim();
    if (envPath && existsSync(envPath)) return envPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/snap/bin/chromium",
          ];

  const fixedMatch = candidates.find((p) => existsSync(p));
  if (fixedMatch) return fixedMatch;

  const pathNames =
    process.platform === "win32"
      ? ["msedge.exe", "chrome.exe", "chromium.exe"]
      : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"];
  return findInSystemPath(pathNames);
}

export function detectLibreOfficeBinary(): string | null {
  const envPath = process.env.LIBREOFFICE_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
          "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
        : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice"];

  const fixedMatch = candidates.find((p) => existsSync(p));
  if (fixedMatch) return fixedMatch;

  return findInSystemPath(process.platform === "win32" ? ["soffice.exe"] : ["soffice", "libreoffice"]);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRunsHtml(runs: TextRun[]): string {
  return runs
    .map((run) => {
      let content = escapeHtml(run.text).replace(/\n/g, "<br/>");
      if (!content) return "";
      const styles: string[] = [];
      if (run.marks?.fontFamily) styles.push(`font-family: '${escapeHtml(run.marks.fontFamily)}', 'Noto Sans Khmer', 'Inter', sans-serif`);
      if (run.marks?.fontSizePt) styles.push(`font-size: ${run.marks.fontSizePt}pt`);
      if (run.marks?.color) styles.push(`color: ${escapeHtml(run.marks.color)}`);
      if (run.marks?.highlight) styles.push(`background-color: ${escapeHtml(run.marks.highlight)}`);
      if (run.marks?.underline) styles.push("text-decoration: underline");
      if (run.marks?.bold) content = `<strong>${content}</strong>`;
      if (run.marks?.italic) content = `<em>${content}</em>`;
      return styles.length > 0 ? `<span style="${styles.join("; ")}">${content}</span>` : content;
    })
    .join("");
}

function renderBlockHtml(block: DocumentBlock): string {
  switch (block.type) {
    case "paragraph": {
      const inner = renderRunsHtml(block.runs) || "&nbsp;";
      return `<p style="text-align:${block.alignment ?? "left"};">${inner}</p>`;
    }
    case "heading": {
      const inner = renderRunsHtml(block.runs) || "&nbsp;";
      return `<h${block.level} style="text-align:${block.alignment ?? "left"};">${inner}</h${block.level}>`;
    }
    case "bullet_list":
    case "ordered_list": {
      const tag = block.type === "bullet_list" ? "ul" : "ol";
      const items = block.items.map((runs) => `<li>${renderRunsHtml(runs)}</li>`).join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "table": {
      const rows = block.rows
        .map((row, idx) => {
          const cellTag = block.hasHeaderRow && idx === 0 ? "th" : "td";
          const cells = row
            .map((cell) => `<${cellTag}>${renderRunsHtml(cell.runs) || "&nbsp;"}</${cellTag}>`)
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<table><tbody>${rows}</tbody></table>`;
    }
    case "page_break":
      return `<div class="page-break"></div>`;
    case "linked_metric_placeholder":
      return `<div class="metric-pill"><strong>${escapeHtml(block.metric.displayLabel)}:</strong> ${escapeHtml(block.metric.cachedFormattedValue)} <span>(${escapeHtml(block.metric.reportingPeriod)} · ${escapeHtml(block.metric.mode)})</span></div>`;
  }
}

export function resolveLocalFontFacesCss(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
  const fontCandidates = [
    {
      family: "Noto Sans Khmer",
      weight: 400,
      file: path.join(workspaceRoot, "node_modules", "@fontsource", "noto-sans-khmer", "files", "noto-sans-khmer-khmer-400-normal.woff2"),
    },
    {
      family: "Noto Sans Khmer",
      weight: 700,
      file: path.join(workspaceRoot, "node_modules", "@fontsource", "noto-sans-khmer", "files", "noto-sans-khmer-khmer-700-normal.woff2"),
    },
    {
      family: "Kantumruy Pro",
      weight: 700,
      file: path.join(workspaceRoot, "node_modules", "@fontsource", "kantumruy-pro", "files", "kantumruy-pro-khmer-700-normal.woff2"),
    },
    {
      family: "Inter",
      weight: 400,
      file: path.join(workspaceRoot, "node_modules", "@fontsource", "inter", "files", "inter-latin-400-normal.woff2"),
    },
  ];

  const rules: string[] = [];
  for (const font of fontCandidates) {
    if (existsSync(font.file)) {
      const b64 = readFileSync(font.file).toString("base64");
      rules.push(`@font-face {
        font-family: '${font.family}';
        font-weight: ${font.weight};
        font-style: normal;
        src: url('data:font/woff2;base64,${b64}') format('woff2');
      }`);
    }
  }
  return rules.join("\n");
}

export function buildPrintableHtml(doc: StudioDocument): string {
  const fontCss = resolveLocalFontFacesCss();
  const bodyHtml = doc.blocks.map(renderBlockHtml).join("\n");
  const { size, orientation, marginsMm, headerText, footerText } = doc.layout;

  return `<!DOCTYPE html>
<html lang="km">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(doc.title)}</title>
  <style>
    ${fontCss}
    @page {
      size: ${size} ${orientation};
      margin: ${marginsMm.top}mm ${marginsMm.right}mm ${marginsMm.bottom}mm ${marginsMm.left}mm;
    }
    body {
      font-family: 'Inter', 'Noto Sans Khmer', 'Khmer OS Battambang', 'Leelawadee UI', sans-serif;
      font-size: 11pt;
      line-height: 1.65;
      color: #0f172a;
      overflow-wrap: break-word;
      word-break: normal;
    }
    .doc-header {
      font-size: 9pt;
      color: #64748b;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 6px;
      margin-bottom: 16px;
      text-align: right;
    }
    .doc-footer {
      font-size: 9pt;
      color: #64748b;
      border-top: 1px solid #e2e8f0;
      padding-top: 6px;
      margin-top: 24px;
      text-align: right;
    }
    h1, h2, h3 {
      font-family: 'Kantumruy Pro', 'Inter', 'Noto Sans Khmer', sans-serif;
      color: #0f172a;
      margin-top: 16px;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    h1 { font-size: 18pt; }
    h2 { font-size: 14pt; }
    h3 { font-size: 12pt; }
    p { margin: 0 0 10px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background-color: #f1f5f9; font-weight: 600; }
    .page-break { break-after: page; page-break-after: always; height: 0; }
    .metric-pill {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 6px;
      padding: 8px 12px;
      margin: 10px 0;
      font-size: 10pt;
    }
  </style>
</head>
<body>
  <div class="doc-header">${escapeHtml(headerText)}</div>
  <main>${bodyHtml}</main>
  <div class="doc-footer">${escapeHtml(footerText)} · Revision ${doc.revision}</div>
</body>
</html>`;
}

export interface PdfExportResult {
  pdfBuffer: Buffer;
  pageCount: number;
  engine: "chromium-harfbuzz";
  browserPath: string;
  warnings: string[];
}

export function countPdfPages(pdfBuffer: Buffer): number {
  const ascii = pdfBuffer.toString("latin1");
  const matches = ascii.match(/\/Type\s*\/Page\b(?!s)/g);
  return matches ? matches.length : 1;
}

export async function exportToPdfBuffer(doc: StudioDocument): Promise<PdfExportResult> {
  const browserPath = detectChromiumBinary();
  if (!browserPath) {
    throw new PdfExportError(
      503,
      "PDF_RENDERER_UNAVAILABLE",
      "No Chromium or Edge binary detected. Set CHROMIUM_PATH to enable HarfBuzz PDF export.",
    );
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ai-office-pdf-"));
  const userDataDir = path.join(tmpDir, "profile");
  const htmlPath = path.join(tmpDir, "document.html");
  const pdfPath = path.join(tmpDir, "output.pdf");

  try {
    writeFileSync(htmlPath, buildPrintableHtml(doc), "utf8");
    const fileUrl = pathToFileURL(htmlPath).href;

    await execFileAsync(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        "--disable-extensions",
        `--user-data-dir=${userDataDir}`,
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        fileUrl,
      ],
      { timeout: 25_000, windowsHide: true },
    );

    if (!existsSync(pdfPath)) {
      throw new PdfExportError(500, "PDF_GENERATION_FAILED", "Headless browser exited without creating PDF output.");
    }

    const pdfBuffer = readFileSync(pdfPath);
    if (!pdfBuffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new PdfExportError(500, "INVALID_PDF_OUTPUT", "Generated output did not begin with %PDF- signature.");
    }

    return {
      pdfBuffer,
      pageCount: countPdfPages(pdfBuffer),
      engine: "chromium-harfbuzz",
      browserPath,
      warnings: [],
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function renderDocumentScreenshot(
  doc: StudioDocument,
  outputPngPath: string,
): Promise<{ pngPath: string; byteLength: number; browserPath: string }> {
  const browserPath = detectChromiumBinary();
  if (!browserPath) {
    throw new PdfExportError(
      503,
      "PDF_RENDERER_UNAVAILABLE",
      "No Chromium or Edge binary detected for visual screenshot rendering.",
    );
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ai-office-shot-"));
  const userDataDir = path.join(tmpDir, "profile");
  const htmlPath = path.join(tmpDir, "document.html");

  try {
    writeFileSync(htmlPath, buildPrintableHtml(doc), "utf8");
    const fileUrl = pathToFileURL(htmlPath).href;
    await execFileAsync(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        "--disable-extensions",
        `--user-data-dir=${userDataDir}`,
        "--window-size=960,1360",
        `--screenshot=${path.resolve(outputPngPath)}`,
        fileUrl,
      ],
      { timeout: 25_000, windowsHide: true },
    );

    if (!existsSync(outputPngPath)) {
      throw new PdfExportError(500, "SCREENSHOT_FAILED", "Headless browser did not generate screenshot PNG.");
    }
    const buf = readFileSync(outputPngPath);
    return { pngPath: outputPngPath, byteLength: buf.byteLength, browserPath };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
