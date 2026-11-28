import path from "node:path";
import { fileURLToPath } from "node:url";
import { importWorkbookFromXlsxBuffer } from "@ai-office-suite/calculation-engine";
import { stageXlsxSource } from "@ai-office-suite/data-processing";
import { exportToPdfBuffer, importFromDocxBuffer } from "@ai-office-suite/file-conversion";
import { importFromPptxBuffer } from "@ai-office-suite/presentation-engine";
import {
  MAX_WORKER_IPC_BYTES,
  WorkerIsolationError,
  type SerializedWorkerError,
  type WorkerResponseEnvelope,
  type WorkerTaskRequest,
} from "./protocol.ts";

function readStdinUtf8Bounded(maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    process.stdin.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.byteLength;
      if (totalBytes > maxBytes) {
        settled = true;
        reject(
          new WorkerIsolationError(
            413,
            "WORKER_PAYLOAD_TOO_LARGE",
            `Worker stdin payload exceeded maximum limit (${maxBytes} bytes).`,
          ),
        );
        return;
      }
      chunks.push(buf);
    });

    process.stdin.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    process.stdin.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function serializeWorkerError(err: unknown): SerializedWorkerError {
  if (err instanceof Error) {
    const maybeDomain = err as Error & { statusCode?: unknown; code?: unknown };
    const statusCode =
      typeof maybeDomain.statusCode === "number" &&
      Number.isInteger(maybeDomain.statusCode) &&
      maybeDomain.statusCode >= 400 &&
      maybeDomain.statusCode <= 599
        ? maybeDomain.statusCode
        : 500;
    const code =
      typeof maybeDomain.code === "string" && maybeDomain.code.trim().length > 0
        ? maybeDomain.code.trim()
        : "WORKER_TASK_FAILED";
    return {
      name: err.name || "Error",
      statusCode,
      code,
      message: err.message || "Isolated worker task failed.",
    };
  }
  return {
    name: "WorkerIsolationError",
    statusCode: 500,
    code: "WORKER_TASK_FAILED",
    message: String(err ?? "Isolated worker task failed."),
  };
}

export async function dispatchWorkerTask(req: WorkerTaskRequest): Promise<WorkerResponseEnvelope> {
  try {
    switch (req.task) {
      case "health_probe": {
        return {
          ok: true,
          result: {
            ok: true,
            pid: process.pid,
            envKeys: Object.keys(process.env).sort(),
          },
        };
      }
      case "parse_docx": {
        const buffer = Buffer.from(req.contentBase64, "base64");
        const parsed = await importFromDocxBuffer({
          buffer,
          filename: req.filename,
          tenantId: req.tenantId,
          workspaceId: req.workspaceId,
          actorId: req.actorId,
          ...(req.titleOverride ? { titleOverride: req.titleOverride } : {}),
        });
        return { ok: true, result: parsed };
      }
      case "parse_xlsx": {
        const buffer = Buffer.from(req.contentBase64, "base64");
        const workbook = await importWorkbookFromXlsxBuffer(buffer, req.filename);
        return { ok: true, result: { workbook } };
      }
      case "parse_pptx": {
        const buffer = Buffer.from(req.contentBase64, "base64");
        const parsed = importFromPptxBuffer({
          buffer,
          filename: req.filename,
          tenantId: req.tenantId,
          workspaceId: req.workspaceId,
          actorId: req.actorId,
        });
        return { ok: true, result: parsed };
      }
      case "stage_xlsx": {
        const buffer = Buffer.from(req.contentBase64, "base64");
        const staged = await stageXlsxSource(buffer, req.filename, req.options ?? {});
        return { ok: true, result: { staged } };
      }
      case "render_pdf": {
        const rendered = await exportToPdfBuffer(req.document);
        return {
          ok: true,
          result: {
            pdfBase64: rendered.pdfBuffer.toString("base64"),
            pageCount: rendered.pageCount,
            engine: rendered.engine,
            warnings: rendered.warnings,
          },
        };
      }
      default: {
        return {
          ok: false,
          error: {
            name: "WorkerIsolationError",
            statusCode: 400,
            code: "UNSUPPORTED_WORKER_TASK",
            message: "Unsupported isolated worker task.",
          },
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: serializeWorkerError(err),
    };
  }
}

async function runWorkerMain(): Promise<void> {
  try {
    const raw = await readStdinUtf8Bounded(MAX_WORKER_IPC_BYTES);
    const parsed = JSON.parse(raw) as WorkerTaskRequest;
    const envelope = await dispatchWorkerTask(parsed);
    const out = JSON.stringify(envelope);
    process.stdout.write(out, () => {
      process.exitCode = 0;
    });
  } catch (err) {
    const serialized = serializeWorkerError(err);
    const out = JSON.stringify({ ok: false, error: serialized } satisfies WorkerResponseEnvelope);
    process.stdout.write(out, () => {
      process.exitCode = serialized.code === "WORKER_PAYLOAD_TOO_LARGE" ? 2 : 0;
    });
  }
}

function isEntrypointModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolvedEntry = path.resolve(entry);
  const currentFile = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? resolvedEntry.toLowerCase() === currentFile.toLowerCase()
    : resolvedEntry === currentFile;
}

if (isEntrypointModule()) {
  void runWorkerMain();
}
