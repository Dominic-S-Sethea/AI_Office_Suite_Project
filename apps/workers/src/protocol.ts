import type {
  ImportDiagnostics,
  SpreadsheetWorkbook,
  StudioDocument,
  StudioPresentation,
} from "@ai-office-suite/shared-contracts";
import type { StagedDataset, XlsxStageOptions } from "@ai-office-suite/data-processing";

export const MAX_WORKER_IPC_BYTES = 28 * 1024 * 1024;

export class WorkerIsolationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "WorkerIsolationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type WorkerTaskRequest =
  | {
      task: "parse_docx";
      filename: string;
      contentBase64: string;
      tenantId: string;
      workspaceId: string;
      actorId: string;
      titleOverride?: string;
    }
  | {
      task: "parse_xlsx";
      filename: string;
      contentBase64: string;
    }
  | {
      task: "parse_pptx";
      filename: string;
      contentBase64: string;
      tenantId: string;
      workspaceId: string;
      actorId: string;
    }
  | {
      task: "stage_xlsx";
      filename: string;
      contentBase64: string;
      options?: XlsxStageOptions;
    }
  | {
      task: "render_pdf";
      document: StudioDocument;
    }
  | {
      task: "health_probe";
    };

export interface WorkerTaskResultMap {
  parse_docx: { document: StudioDocument; diagnostics: ImportDiagnostics };
  parse_xlsx: { workbook: SpreadsheetWorkbook };
  parse_pptx: { presentation: StudioPresentation; diagnostics: ImportDiagnostics };
  stage_xlsx: { staged: StagedDataset };
  render_pdf: { pdfBase64: string; pageCount: number; engine: string; warnings: string[] };
  health_probe: { ok: true; pid: number; envKeys: string[] };
}

export interface SerializedWorkerError {
  name: string;
  statusCode: number;
  code: string;
  message: string;
}

export type WorkerResponseEnvelope<K extends keyof WorkerTaskResultMap = keyof WorkerTaskResultMap> =
  | { ok: true; result: WorkerTaskResultMap[K] }
  | { ok: false; error: SerializedWorkerError };

const ALLOWED_WORKER_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "NODE_ENV",
  "CHROMIUM_PATH",
  "CHROMIUM_EXECUTABLE_PATH",
  "CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROMIUM_NO_SANDBOX",
  "LANG",
  "LC_ALL",
] as const;

/**
 * Strips all database URLs, JWT secrets, HMAC signing keys, cloud keys, and arbitrary env vars
 * before spawning untrusted OOXML parser or Chromium renderer subprocesses.
 */
export function buildSanitizedWorkerEnv(
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of ALLOWED_WORKER_ENV_KEYS) {
    const val = sourceEnv[key];
    if (typeof val === "string" && val.length > 0) {
      sanitized[key] = val;
    }
  }
  return sanitized;
}
