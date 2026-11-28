import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ImportDiagnostics,
  SpreadsheetWorkbook,
  StudioDocument,
  StudioPresentation,
} from "@ai-office-suite/shared-contracts";
import {
  importWorkbookFromXlsxBuffer,
  WorkbookInteroperabilityError,
} from "@ai-office-suite/calculation-engine";
import { DataPrepError, type StagedDataset, type XlsxStageOptions } from "@ai-office-suite/data-processing";
import { DocxImportError, PdfExportError } from "@ai-office-suite/file-conversion";
import { PptxImportError } from "@ai-office-suite/presentation-engine";
import {
  buildSanitizedWorkerEnv,
  MAX_WORKER_IPC_BYTES,
  WorkerIsolationError,
  type SerializedWorkerError,
  type WorkerResponseEnvelope,
  type WorkerTaskRequest,
  type WorkerTaskResultMap,
} from "./protocol.ts";

export {
  buildSanitizedWorkerEnv,
  MAX_WORKER_IPC_BYTES,
  WorkerIsolationError,
  type SerializedWorkerError,
  type WorkerResponseEnvelope,
  type WorkerTaskRequest,
  type WorkerTaskResultMap,
};

export interface IsolatedParserWorkerOptions {
  timeoutMs?: number;
  maxOldSpaceMb?: number;
  maxPayloadBytes?: number;
  workerScriptPath?: string;
  workerUrl?: string;
  env?: Record<string, string | undefined>;
}

const DEFAULT_WORKER_SCRIPT_PATH = fileURLToPath(new URL("./parserWorkerProcess.ts", import.meta.url));

function reconstructDomainError(err: SerializedWorkerError): Error {
  const statusCode =
    typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode <= 599
      ? err.statusCode
      : 500;
  const code = err.code || "WORKER_TASK_FAILED";
  const message = err.message || "Isolated worker task failed.";
  switch (err.name) {
    case "DocxImportError":
      return new DocxImportError(statusCode, code, message);
    case "PdfExportError":
      return new PdfExportError(statusCode, code, message);
    case "WorkbookInteroperabilityError":
      return new WorkbookInteroperabilityError(statusCode, code, message);
    case "PptxImportError":
      return new PptxImportError(statusCode, code, message);
    case "DataPrepError":
      return new DataPrepError(statusCode, code, message);
    default:
      return new WorkerIsolationError(statusCode, code, message);
  }
}

/**
 * Process-isolated OOXML parser & Chromium PDF renderer client.
 * Executes untrusted DOCX/XLSX/PPTX parsing and headless Chromium PDF rendering inside an
 * ephemeral memory-bounded child process (or remote `workers` microservice) stripped of all
 * secrets, database credentials, and API privileges.
 */
export class IsolatedParserWorkerClient {
  private readonly timeoutMs: number;
  private readonly maxOldSpaceMb: number;
  private readonly maxPayloadBytes: number;
  private readonly workerScriptPath: string;
  private readonly workerUrl?: string;
  private readonly envSource?: Record<string, string | undefined>;

  constructor(options: IsolatedParserWorkerOptions = {}) {
    this.timeoutMs = Math.max(250, Math.min(120_000, Math.trunc(options.timeoutMs ?? 30_000)));
    this.maxOldSpaceMb = Math.max(64, Math.min(2_048, Math.trunc(options.maxOldSpaceMb ?? 256)));
    this.maxPayloadBytes = Math.max(64 * 1024, Math.trunc(options.maxPayloadBytes ?? MAX_WORKER_IPC_BYTES));
    this.workerScriptPath = options.workerScriptPath ?? DEFAULT_WORKER_SCRIPT_PATH;
    this.workerUrl = options.workerUrl?.trim() ? options.workerUrl.trim().replace(/\/+$/, "") : undefined;
    this.envSource = options.env;
  }

  private async executeOverHttp<K extends keyof WorkerTaskResultMap>(
    request: Extract<WorkerTaskRequest, { task: K }>,
  ): Promise<WorkerTaskResultMap[K]> {
    const endpoint = `${this.workerUrl!}/execute`;
    let response: globalThis.Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new WorkerIsolationError(
          504,
          "WORKER_TIMEOUT",
          `Isolated parser worker HTTP request exceeded ${this.timeoutMs}ms timeout.`,
        );
      }
      throw new WorkerIsolationError(502, "WORKER_UNAVAILABLE", `Isolated parser worker unreachable: ${msg}`);
    }

    let envelope: WorkerResponseEnvelope<K> | null = null;
    try {
      envelope = (await response.json()) as WorkerResponseEnvelope<K>;
    } catch {
      envelope = null;
    }

    if (envelope && envelope.ok === false) {
      throw reconstructDomainError(envelope.error);
    }
    if (!response.ok || !envelope || envelope.ok !== true) {
      throw new WorkerIsolationError(
        response.status >= 400 && response.status <= 599 ? response.status : 502,
        "WORKER_HTTP_ERROR",
        `Isolated parser worker returned HTTP ${response.status}.`,
      );
    }
    return envelope.result;
  }

  private executeInSubprocess<K extends keyof WorkerTaskResultMap>(
    request: Extract<WorkerTaskRequest, { task: K }>,
  ): Promise<WorkerTaskResultMap[K]> {
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload, "utf8") > this.maxPayloadBytes) {
      return Promise.reject(
        new WorkerIsolationError(
          413,
          "WORKER_PAYLOAD_TOO_LARGE",
          `Worker request payload exceeds limit (${this.maxPayloadBytes} bytes).`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${this.maxOldSpaceMb}`, this.workerScriptPath],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: buildSanitizedWorkerEnv(this.envSource ?? process.env),
          shell: false,
          windowsHide: true,
        },
      );

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;

      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        reject(err);
      };

      const finishResolve = (val: WorkerTaskResultMap[K]) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve(val);
      };

      const killChildHard = () => {
        try {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        } catch {
          try {
            child.kill();
          } catch {
            // ignore already-exited child
          }
        }
      };

      const killTimer = setTimeout(() => {
        timedOut = true;
        killChildHard();
        finishReject(
          new WorkerIsolationError(
            504,
            "WORKER_TIMEOUT",
            `Isolated parser worker timed out after ${this.timeoutMs}ms and was terminated.`,
          ),
        );
      }, this.timeoutMs);
      killTimer.unref?.();

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.maxPayloadBytes) {
          killChildHard();
          finishReject(
            new WorkerIsolationError(
              413,
              "WORKER_PAYLOAD_TOO_LARGE",
              `Isolated parser worker output exceeded limit (${this.maxPayloadBytes} bytes).`,
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes < 65_536) {
          const remaining = 65_536 - stderrBytes;
          const sliced = chunk.subarray(0, remaining);
          stderrBytes += sliced.byteLength;
          stderrChunks.push(sliced);
        }
      });

      child.on("error", (err) => {
        finishReject(
          new WorkerIsolationError(502, "WORKER_SPAWN_FAILED", `Failed to spawn parser worker: ${err.message}`),
        );
      });

      child.on("close", (code, signal) => {
        if (settled || timedOut) return;
        const rawOut = Buffer.concat(stdoutChunks).toString("utf8").trim();
        let envelope: WorkerResponseEnvelope<K> | null = null;
        if (rawOut.length > 0) {
          try {
            envelope = JSON.parse(rawOut) as WorkerResponseEnvelope<K>;
          } catch {
            envelope = null;
          }
        }
        if (envelope) {
          if (envelope.ok === true) {
            finishResolve(envelope.result);
            return;
          }
          finishReject(reconstructDomainError(envelope.error));
          return;
        }
        const stderrHint = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 300);
        finishReject(
          new WorkerIsolationError(
            502,
            "WORKER_CRASHED",
            `Isolated parser worker terminated unexpectedly (code=${String(code)}, signal=${String(signal)})${stderrHint ? `: ${stderrHint}` : ""}`,
          ),
        );
      });

      child.stdin.on("error", () => {
        // EPIPE can happen if child exits early; handled in close listener
      });
      child.stdin.end(payload, "utf8");
    });
  }

  async executeTask<K extends keyof WorkerTaskResultMap>(
    request: Extract<WorkerTaskRequest, { task: K }>,
  ): Promise<WorkerTaskResultMap[K]> {
    if (this.workerUrl) {
      return this.executeOverHttp(request);
    }
    return this.executeInSubprocess(request);
  }

  probeIsolation(): Promise<{ ok: true; pid: number; envKeys: string[] }> {
    return this.executeTask({ task: "health_probe" });
  }

  parseDocx(params: {
    buffer: Uint8Array;
    filename: string;
    tenantId: string;
    workspaceId: string;
    actorId: string;
    titleOverride?: string;
  }): Promise<{ document: StudioDocument; diagnostics: ImportDiagnostics }> {
    return this.executeTask({
      task: "parse_docx",
      filename: path.basename(params.filename) || "document.docx",
      contentBase64: Buffer.from(params.buffer).toString("base64"),
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      ...(params.titleOverride ? { titleOverride: params.titleOverride } : {}),
    });
  }

  async parseXlsx(buffer: Uint8Array, filename: string): Promise<SpreadsheetWorkbook> {
    const res = await this.executeTask({
      task: "parse_xlsx",
      filename: path.basename(filename) || "workbook.xlsx",
      contentBase64: Buffer.from(buffer).toString("base64"),
    });
    return res.workbook;
  }

  parsePptx(params: {
    buffer: Uint8Array;
    filename: string;
    tenantId: string;
    workspaceId: string;
    actorId: string;
  }): Promise<{ presentation: StudioPresentation; diagnostics: ImportDiagnostics }> {
    return this.executeTask({
      task: "parse_pptx",
      filename: path.basename(params.filename) || "presentation.pptx",
      contentBase64: Buffer.from(params.buffer).toString("base64"),
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      actorId: params.actorId,
    });
  }

  async stageXlsx(buffer: Uint8Array, filename: string, options?: XlsxStageOptions): Promise<StagedDataset> {
    const res = await this.executeTask({
      task: "stage_xlsx",
      filename: path.basename(filename) || "dataset.xlsx",
      contentBase64: Buffer.from(buffer).toString("base64"),
      ...(options ? { options } : {}),
    });
    return res.staged;
  }

  async renderPdf(
    document: StudioDocument,
  ): Promise<{ pdfBuffer: Buffer; pageCount: number; engine: string; warnings: string[] }> {
    const res = await this.executeTask({
      task: "render_pdf",
      document,
    });
    return {
      pdfBuffer: Buffer.from(res.pdfBase64, "base64"),
      pageCount: res.pageCount,
      engine: res.engine,
      warnings: res.warnings,
    };
  }
}

export { importWorkbookFromXlsxBuffer };
