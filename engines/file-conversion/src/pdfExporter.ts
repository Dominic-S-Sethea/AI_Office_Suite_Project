import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DocumentBlock, StudioDocument, TextRun } from "@ai-office-suite/shared-contracts";
import { escapeHtml } from "@ai-office-suite/validation";

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
  for (const envKey of ["CHROMIUM_PATH", "CHROMIUM_EXECUTABLE_PATH", "CHROME_PATH", "PUPPETEER_EXECUTABLE_PATH"] as const) {
    const envPath = process.env[envKey]?.trim();
    if (envPath && existsSync(envPath)) return envPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\EdgeCore\\Optimized\\msedge.exe",
          "C:\\Program Files\\Microsoft\\EdgeCore\\Optimized\\msedge.exe",
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

const SAFE_CSS_NAMED_COLORS = new Set([
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "gray",
  "grey",
  "navy",
  "teal",
  "orange",
  "purple",
  "silver",
  "maroon",
  "olive",
  "lime",
  "aqua",
  "fuchsia",
  "transparent",
  "inherit",
  "currentcolor",
]);

export const PDF_RENDER_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:;" />`;

export function buildHardenedChromiumArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-component-update",
    "--metrics-recording-only",
    "--proxy-server=http://127.0.0.1:0",
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND",
  ];
  if (env.CHROMIUM_NO_SANDBOX === "true") {
    args.splice(3, 0, "--no-sandbox");
  }
  return args;
}

export const HARDENED_CHROMIUM_BASE_ARGS: readonly string[] = buildHardenedChromiumArgs({
  CHROMIUM_NO_SANDBOX: "false",
});

/**
 * Builds a minimal, secret-free environment for untrusted-content child processes (Chromium, etc.)
 * so parent secrets (DATABASE_URL, JWT_SECRET, cloud keys) are never leaked into subprocess memory.
 */
export function buildSanitizedSubprocessEnv(tmpDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: tmpDir,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    XDG_CONFIG_HOME: tmpDir,
    XDG_CACHE_HOME: tmpDir,
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  if (process.platform === "win32") {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
    if (process.env.LOCALAPPDATA) env.LOCALAPPDATA = tmpDir;
  }
  return env;
}

export function cleanupTempDirBestEffort(dirPath: string): void {
  try {
    rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Sandboxed Chromium child helpers on Windows may briefly hold locks on user-data-dir files;
    // ignore transient cleanup errors so a valid PDF/PNG export is never discarded.
  }
}

export function sanitizeCssColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40) return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) {
    return trimmed;
  }
  if (
    /^rgba?\(\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\s*,\s*(?:0|1|0?\.\d{1,4}))?\s*\)$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  if (SAFE_CSS_NAMED_COLORS.has(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  return null;
}

export function sanitizeCssFontFamily(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 64) return null;
  if (!/^[A-Za-z0-9 _-]+$/.test(cleaned)) return null;
  return cleaned;
}

const MAX_SAFE_IMAGE_DATA_URI_LENGTH = 8 * 1024 * 1024;

export function sanitizeSafeImageDataUri(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SAFE_IMAGE_DATA_URI_LENGTH) {
    return null;
  }
  // Strictly permit single-line raster base64 data URIs only; reject whitespace, http(s), file, javascript, and svg+xml
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function sanitizeAlignment(raw: unknown): "left" | "center" | "right" | "justify" {
  if (raw === "center" || raw === "right" || raw === "justify") return raw;
  return "left";
}

function renderRunsHtml(runs: TextRun[]): string {
  return runs
    .map((run) => {
      let content = escapeHtml(run.text).replace(/\n/g, "<br/>");
      if (!content) return "";
      const styles: string[] = [];
      const safeFont = sanitizeCssFontFamily(run.marks?.fontFamily);
      if (safeFont) styles.push(`font-family: '${safeFont}', 'Noto Sans Khmer', 'Inter', sans-serif`);
      if (
        typeof run.marks?.fontSizePt === "number" &&
        Number.isFinite(run.marks.fontSizePt) &&
        run.marks.fontSizePt >= 6 &&
        run.marks.fontSizePt <= 144
      ) {
        styles.push(`font-size: ${run.marks.fontSizePt}pt`);
      }
      const safeColor = sanitizeCssColor(run.marks?.color);
      if (safeColor) styles.push(`color: ${safeColor}`);
      const safeHighlight = sanitizeCssColor(run.marks?.highlight);
      if (safeHighlight) styles.push(`background-color: ${safeHighlight}`);
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
      return `<p style="text-align:${sanitizeAlignment(block.alignment)};">${inner}</p>`;
    }
    case "heading": {
      const level = block.level === 1 || block.level === 2 || block.level === 3 ? block.level : 2;
      const inner = renderRunsHtml(block.runs) || "&nbsp;";
      return `<h${level} style="text-align:${sanitizeAlignment(block.alignment)};">${inner}</h${level}>`;
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
  const safeSize = size === "Letter" ? "Letter" : "A4";
  const safeOrientation = orientation === "landscape" ? "landscape" : "portrait";
  const clampMargin = (m: number) => (Number.isFinite(m) ? Math.min(100, Math.max(0, m)) : 20);

  return `<!DOCTYPE html>
<html lang="km">
<head>
  <meta charset="UTF-8" />
  ${PDF_RENDER_CSP_META}
  <title>${escapeHtml(doc.title)}</title>
  <style>
    ${fontCss}
    @page {
      size: ${safeSize} ${safeOrientation};
      margin: ${clampMargin(marginsMm.top)}mm ${clampMargin(marginsMm.right)}mm ${clampMargin(marginsMm.bottom)}mm ${clampMargin(marginsMm.left)}mm;
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
        ...buildHardenedChromiumArgs(),
        `--user-data-dir=${userDataDir}`,
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        fileUrl,
      ],
      { timeout: 25_000, windowsHide: true, env: buildSanitizedSubprocessEnv(tmpDir) },
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
    cleanupTempDirBestEffort(tmpDir);
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
        ...buildHardenedChromiumArgs(),
        `--user-data-dir=${userDataDir}`,
        "--window-size=960,1360",
        `--screenshot=${path.resolve(outputPngPath)}`,
        fileUrl,
      ],
      { timeout: 25_000, windowsHide: true, env: buildSanitizedSubprocessEnv(tmpDir) },
    );

    if (!existsSync(outputPngPath)) {
      throw new PdfExportError(500, "SCREENSHOT_FAILED", "Headless browser did not generate screenshot PNG.");
    }
    const buf = readFileSync(outputPngPath);
    return { pngPath: outputPngPath, byteLength: buf.byteLength, browserPath };
  } finally {
    cleanupTempDirBestEffort(tmpDir);
  }
}
