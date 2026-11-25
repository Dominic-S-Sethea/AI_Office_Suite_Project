import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { redactAuditValue } from "@ai-office-suite/audit";

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{4,128}$/;

export interface RequestMetricsSnapshot {
  uptimeSeconds: number;
  requestsTotal: number;
  statusClasses: {
    "2xx": number;
    "3xx": number;
    "4xx": number;
    "5xx": number;
  };
  rateLimitedTotal: number;
  latencyMs: {
    sampleCount: number;
    p50: number;
    p95: number;
    max: number;
  };
  memoryRssMb: number;
}

export interface ApiObservabilityHandle {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  getMetrics: () => RequestMetricsSnapshot;
  logEvent: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

export function createApiObservability(options: { enableStructuredLogs?: boolean; sink?: (line: string) => void } = {}): ApiObservabilityHandle {
  const startedAtMs = Date.now();
  const enableLogs = options.enableStructuredLogs ?? process.env.NODE_ENV !== "test";
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  let requestsTotal = 0;
  let rateLimitedTotal = 0;
  const statusClasses = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  const latencySamples: number[] = [];
  const MAX_LATENCY_SAMPLES = 1000;

  const logEvent = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void => {
    if (!enableLogs) return;
    const redacted = redactAuditValue({
      ts: new Date().toISOString(),
      level,
      service: "ai-office-suite-api",
      event,
      ...fields,
    });
    sink(JSON.stringify(redacted));
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const inboundId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].trim() : "";
    const requestId = SAFE_REQUEST_ID_PATTERN.test(inboundId) ? inboundId : randomUUID();
    res.setHeader("X-Request-Id", requestId);
    (req as Request & { requestId?: string }).requestId = requestId;

    const startNs = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      requestsTotal++;
      if (res.statusCode === 429) rateLimitedTotal++;
      if (res.statusCode >= 500) statusClasses["5xx"]++;
      else if (res.statusCode >= 400) statusClasses["4xx"]++;
      else if (res.statusCode >= 300) statusClasses["3xx"]++;
      else statusClasses["2xx"]++;

      if (latencySamples.length >= MAX_LATENCY_SAMPLES) {
        latencySamples.shift();
      }
      latencySamples.push(Math.round(durationMs * 100) / 100);

      logEvent(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http.request", {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });

    next();
  };

  const getMetrics = (): RequestMetricsSnapshot => {
    const sorted = [...latencySamples].sort((a, b) => a - b);
    const pick = (pct: number) => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct));
      return sorted[idx] ?? 0;
    };
    return {
      uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
      requestsTotal,
      statusClasses: { ...statusClasses },
      rateLimitedTotal,
      latencyMs: {
        sampleCount: sorted.length,
        p50: pick(0.5),
        p95: pick(0.95),
        max: sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0,
      },
      memoryRssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100,
    };
  };

  return { middleware, getMetrics, logEvent };
}
