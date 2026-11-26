import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
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

export interface DbPoolMetricInput {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface ApiObservabilityHandle {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  getMetrics: () => RequestMetricsSnapshot;
  formatPrometheusMetrics: (dbPool?: DbPoolMetricInput) => string;
  logEvent: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

type ObservedRequest = Request & {
  requestId?: string;
  actor?: ActorContext;
  authSource?: "bearer" | "cookie";
};

export function createApiObservability(
  options: { enableStructuredLogs?: boolean; sink?: (line: string) => void } = {},
): ApiObservabilityHandle {
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
    const observedReq = req as ObservedRequest;
    observedReq.requestId = requestId;

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

      const routeTemplate =
        req.route && typeof (req.route as { path?: unknown }).path === "string"
          ? `${req.baseUrl}${(req.route as { path: string }).path}`
          : req.path;

      logEvent(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http.request", {
        requestId,
        method: req.method,
        route: routeTemplate,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ...(observedReq.actor
          ? {
              tenantId: observedReq.actor.tenantId,
              role: observedReq.actor.role,
              authSource: observedReq.authSource ?? "provisional",
            }
          : {}),
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

  const formatPrometheusMetrics = (dbPool?: DbPoolMetricInput): string => {
    const m = getMetrics();
    const lines = [
      "# HELP aios_uptime_seconds Process uptime in seconds.",
      "# TYPE aios_uptime_seconds gauge",
      `aios_uptime_seconds ${m.uptimeSeconds}`,
      "# HELP aios_http_requests_total Total HTTP requests handled.",
      "# TYPE aios_http_requests_total counter",
      `aios_http_requests_total ${m.requestsTotal}`,
      "# HELP aios_http_responses_total HTTP responses grouped by status class.",
      "# TYPE aios_http_responses_total counter",
      `aios_http_responses_total{status_class="2xx"} ${m.statusClasses["2xx"]}`,
      `aios_http_responses_total{status_class="3xx"} ${m.statusClasses["3xx"]}`,
      `aios_http_responses_total{status_class="4xx"} ${m.statusClasses["4xx"]}`,
      `aios_http_responses_total{status_class="5xx"} ${m.statusClasses["5xx"]}`,
      "# HELP aios_rate_limited_total Total HTTP 429 rate-limited responses.",
      "# TYPE aios_rate_limited_total counter",
      `aios_rate_limited_total ${m.rateLimitedTotal}`,
      "# HELP aios_http_request_duration_ms Observed HTTP request latency quantiles in milliseconds.",
      "# TYPE aios_http_request_duration_ms gauge",
      `aios_http_request_duration_ms{quantile="0.5"} ${m.latencyMs.p50}`,
      `aios_http_request_duration_ms{quantile="0.95"} ${m.latencyMs.p95}`,
      `aios_http_request_duration_ms{quantile="max"} ${m.latencyMs.max}`,
      "# HELP aios_process_memory_rss_mb Resident set size memory in megabytes.",
      "# TYPE aios_process_memory_rss_mb gauge",
      `aios_process_memory_rss_mb ${m.memoryRssMb}`,
    ];
    if (dbPool) {
      lines.push(
        "# HELP aios_db_pool_connections PostgreSQL connection pool counts.",
        "# TYPE aios_db_pool_connections gauge",
        `aios_db_pool_connections{state="total"} ${dbPool.totalCount}`,
        `aios_db_pool_connections{state="idle"} ${dbPool.idleCount}`,
        `aios_db_pool_connections{state="waiting"} ${dbPool.waitingCount}`,
      );
    }
    return `${lines.join("\n")}\n`;
  };

  return { middleware, getMetrics, formatPrometheusMetrics, logEvent };
}
