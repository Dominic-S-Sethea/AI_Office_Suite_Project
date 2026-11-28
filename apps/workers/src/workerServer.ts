import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IsolatedParserWorkerClient } from "./index.ts";
import {
  MAX_WORKER_IPC_BYTES,
  WorkerIsolationError,
  type SerializedWorkerError,
  type WorkerResponseEnvelope,
  type WorkerTaskRequest,
} from "./protocol.ts";

export interface WorkerServerConfig {
  host: string;
  port: number;
  timeoutMs: number;
  maxOldSpaceMb: number;
  maxConcurrentJobs: number;
}

export function loadWorkerServerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerServerConfig {
  const parseBoundedInt = (raw: string | undefined, min: number, max: number, fallback: number): number => {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return fallback;
    if (!/^\d+$/.test(trimmed)) return fallback;
    const parsed = Number.parseInt(trimmed, 10);
    return Math.max(min, Math.min(max, parsed));
  };
  return {
    host: (env.HOST ?? "0.0.0.0").trim() || "0.0.0.0",
    port: parseBoundedInt(env.PORT, 1, 65_535, 4200),
    timeoutMs: parseBoundedInt(env.WORKER_TIMEOUT_MS, 1_000, 120_000, 30_000),
    maxOldSpaceMb: parseBoundedInt(env.WORKER_MAX_OLD_SPACE_MB, 64, 2_048, 256),
    maxConcurrentJobs: parseBoundedInt(env.MAX_CONCURRENT_WORKER_JOBS, 1, 16, 4),
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
}

function readJsonBodyBounded(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buf.byteLength;
      if (total > maxBytes) {
        settled = true;
        reject(new WorkerIsolationError(413, "PAYLOAD_TOO_LARGE", `Worker HTTP body exceeded ${maxBytes} bytes.`));
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function toSerializedError(err: unknown): SerializedWorkerError {
  if (err instanceof Error) {
    const domain = err as Error & { statusCode?: unknown; code?: unknown };
    const statusCode =
      typeof domain.statusCode === "number" &&
      Number.isInteger(domain.statusCode) &&
      domain.statusCode >= 400 &&
      domain.statusCode <= 599
        ? domain.statusCode
        : 500;
    const code = typeof domain.code === "string" && domain.code ? domain.code : "WORKER_TASK_FAILED";
    return { name: err.name || "Error", statusCode, code, message: err.message || "Worker execution failed." };
  }
  return {
    name: "WorkerIsolationError",
    statusCode: 500,
    code: "WORKER_TASK_FAILED",
    message: String(err ?? "Worker execution failed."),
  };
}

export function createWorkerHttpServer(config: Partial<WorkerServerConfig> = {}): Server {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxOldSpaceMb = config.maxOldSpaceMb ?? 256;
  const maxConcurrentJobs = Math.max(1, config.maxConcurrentJobs ?? 4);
  let activeJobs = 0;

  const client = new IsolatedParserWorkerClient({ timeoutMs, maxOldSpaceMb });

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const reqUrl = req.url ?? "/";

    if (method === "GET" && reqUrl === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "ai-office-suite-workers",
        isolation: "subprocess",
        activeJobs,
        maxConcurrentJobs,
      });
      return;
    }

    if (method === "POST" && reqUrl === "/execute") {
      if (activeJobs >= maxConcurrentJobs) {
        res.setHeader("Retry-After", "2");
        sendJson(res, 503, {
          ok: false,
          error: {
            name: "WorkerIsolationError",
            statusCode: 503,
            code: "WORKER_BUSY",
            message: "Isolated parser workers are currently at capacity. Please retry shortly.",
          },
        } satisfies WorkerResponseEnvelope);
        return;
      }

      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        sendJson(res, 415, {
          ok: false,
          error: {
            name: "WorkerIsolationError",
            statusCode: 415,
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Content-Type application/json is required.",
          },
        } satisfies WorkerResponseEnvelope);
        return;
      }

      activeJobs++;
      try {
        const raw = await readJsonBodyBounded(req, MAX_WORKER_IPC_BYTES);
        let parsed: WorkerTaskRequest;
        try {
          parsed = JSON.parse(raw) as WorkerTaskRequest;
        } catch {
          sendJson(res, 400, {
            ok: false,
            error: {
              name: "WorkerIsolationError",
              statusCode: 400,
              code: "INVALID_JSON",
              message: "Malformed JSON request body.",
            },
          } satisfies WorkerResponseEnvelope);
          return;
        }

        const result = await client.executeTask(parsed);
        sendJson(res, 200, { ok: true, result } as WorkerResponseEnvelope);
      } catch (err) {
        const serialized = toSerializedError(err);
        sendJson(res, serialized.statusCode, { ok: false, error: serialized } satisfies WorkerResponseEnvelope);
      } finally {
        activeJobs = Math.max(0, activeJobs - 1);
      }
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: {
        name: "WorkerIsolationError",
        statusCode: 404,
        code: "NOT_FOUND",
        message: "Endpoint not found.",
      },
    } satisfies WorkerResponseEnvelope);
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = timeoutMs + 5_000;
  return server;
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
  const cfg = loadWorkerServerConfig(process.env);
  const server = createWorkerHttpServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service: "ai-office-suite-workers",
        event: "worker_server.started",
        host: cfg.host,
        port: cfg.port,
        timeoutMs: cfg.timeoutMs,
        maxOldSpaceMb: cfg.maxOldSpaceMb,
      })}\n`,
    );
  });

  const shutdown = (signal: string) => {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service: "ai-office-suite-workers",
        event: "worker_server.shutdown",
        signal,
      })}\n`,
    );
    server.close(() => process.exit(0));
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    setTimeout(() => process.exit(1), 5_000).unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
