import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { PLANNED_FUTURE_STUDIOS } from "@ai-office-suite/shared-contracts";
import { AuthorizationError, isWorkspaceRole } from "@ai-office-suite/authorization";
import {
  DatabaseConflictError,
  PostgreSqlDocumentRepository,
  verifyDatabaseRlsReadiness,
  type DatabaseReadinessReport,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";
import { AuthenticationError } from "@ai-office-suite/identity";
import type { AuthenticatedRequest } from "@ai-office-suite/identity/express";
import {
  InMemoryStorageAdapter,
  LocalFilesystemStorageAdapter,
  type DocumentStorageAdapter,
} from "@ai-office-suite/storage";
import { InMemoryAuditStore, LocalJsonlAuditStore, type AuditStore } from "@ai-office-suite/audit";
import { DocumentEngineError } from "@ai-office-suite/document-engine";
import { DataPrepError } from "@ai-office-suite/data-processing";
import { DocxImportError, PdfExportError } from "@ai-office-suite/file-conversion";
import { SpeechProviderError } from "@ai-office-suite/speech-engine";
import { DocumentService } from "@ai-office-suite/documents-module";
import { AiDocumentExecutor, AiPlanningError } from "@ai-office-suite/ai-module";
import { createSlidingWindowRateLimiter } from "./rateLimit.ts";
import { createApiObservability } from "./observability.ts";
import { LocalDocumentGateway, PgDocumentGateway, type DocumentGateway } from "./documentGateway.ts";
import { registerAuthAndMetricsRoutes } from "./routes/authRoutes.ts";
import { registerDocumentRoutes, type ConcurrencyGate } from "./routes/documentRoutes.ts";
import { registerAiAndSpeechRoutes } from "./routes/aiAndSpeechRoutes.ts";
import { registerDataPrepRoutes } from "./routes/dataPrepRoutes.ts";

export interface CreateApiAppOptions {
  storageDir?: string;
  inMemory?: boolean;
  authMode?: "provisional-local" | "jwt-pg";
  db?: PgDatabaseAdapter;
  trustProxy?: number | string | boolean;
  requireNonSuperuserDb?: boolean;
  isShuttingDown?: () => boolean;
  enableStructuredLogs?: boolean;
  logSink?: (line: string) => void;
  readyCacheTtlMs?: number;
  maxConcurrentPdfExports?: number;
  maxConcurrentDataPrep?: number;
  rateLimit?: {
    enabled?: boolean;
    windowMs?: number;
    loginMaxPerWindow?: number;
    loginIpMaxPerWindow?: number;
    apiMaxPerWindow?: number;
  };
}

function createConcurrencyGate(maxConcurrent: number): ConcurrencyGate {
  let active = 0;
  const limit = Math.max(1, Math.trunc(maxConcurrent));
  return {
    tryAcquire(): (() => void) | null {
      if (active >= limit) return null;
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active = Math.max(0, active - 1);
        }
      };
    },
    getActive: () => active,
  };
}

function resolvePrototypeActor(req: Request): ActorContext {
  const roleHeader = String(req.header("x-workspace-role") ?? "editor").toLowerCase();
  const role = isWorkspaceRole(roleHeader) ? roleHeader : "editor";
  const userId = String(req.header("x-user-id") ?? "user_demo_editor").trim() || "user_demo_editor";
  const tenantId = String(req.header("x-tenant-id") ?? "tenant_demo_sme").trim() || "tenant_demo_sme";
  const workspaceId =
    String(req.header("x-workspace-id") ?? "ws_corporate_hq").trim() || "ws_corporate_hq";
  return { tenantId, workspaceId, userId, role };
}

export function createApiApp(options: CreateApiAppOptions = {}): Express {
  const authMode = options.authMode ?? "provisional-local";
  if (authMode === "jwt-pg" && !options.db) {
    throw new Error("CreateApiAppOptions.db is required when authMode is 'jwt-pg'.");
  }
  const useJwtPg = authMode === "jwt-pg";

  const useInMemoryLocalFallback = options.inMemory || (useJwtPg && !options.storageDir);
  const storageDir = options.storageDir ?? path.resolve(process.cwd(), process.env.LOCAL_STORAGE_DIR ?? ".local-data");
  const storage: DocumentStorageAdapter = useInMemoryLocalFallback
    ? new InMemoryStorageAdapter()
    : new LocalFilesystemStorageAdapter(storageDir);
  const audit: AuditStore = useInMemoryLocalFallback
    ? new InMemoryAuditStore()
    : new LocalJsonlAuditStore(storageDir);

  const documents = new DocumentService(storage, audit);
  const aiExecutor = new AiDocumentExecutor(documents, audit);

  // Unified DocumentGateway removes all dual `if (pgRepo)` orchestration branching in routes (H21)
  const gateway: DocumentGateway = options.db
    ? new PgDocumentGateway(new PostgreSqlDocumentRepository(options.db))
    : new LocalDocumentGateway(documents, aiExecutor, audit);

  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5174,http://127.0.0.1:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const observability = createApiObservability({
    enableStructuredLogs: options.enableStructuredLogs,
    sink: options.logSink,
  });

  const logRateLimitExceeded = (req: Request, key: string): void => {
    observability.logEvent("warn", "security.rate_limit_exceeded", {
      requestId: (req as Request & { requestId?: string }).requestId,
      method: req.method,
      path: req.path,
      bucket: key.split(":")[0],
    });
  };

  const rateLimitEnabled = options.rateLimit?.enabled ?? process.env.NODE_ENV !== "test";
  const windowMs = options.rateLimit?.windowMs ?? 60_000;
  const loginMax = options.rateLimit?.loginMaxPerWindow ?? 15;
  const apiMax = options.rateLimit?.apiMaxPerWindow ?? 300;

  // Pre-parse IP flood shield (H14 — executes BEFORE express.json body parsing)
  const preParseIpLimiter = createSlidingWindowRateLimiter({
    windowMs,
    maxRequests: Math.max(apiMax * 5, 1_000),
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      return `preip:${String(ip).trim().slice(0, 128)}`;
    },
    onLimitExceeded: logRateLimitExceeded,
  });

  // Per-IP aggregate login limiter prevents cross-account credential stuffing (H15)
  const loginIpLimiter = createSlidingWindowRateLimiter({
    windowMs,
    maxRequests: options.rateLimit?.loginIpMaxPerWindow ?? Math.max(loginMax * 4, 20),
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      return `login_ip:${String(ip).trim().slice(0, 128)}`;
    },
    onLimitExceeded: logRateLimitExceeded,
  });

  // Per-(IP, email) login limiter isolates brute-force attempts on a single account
  const loginLimiter = createSlidingWindowRateLimiter({
    windowMs,
    maxRequests: loginMax,
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      const email =
        typeof req.body === "object" && req.body !== null && typeof (req.body as { email?: unknown }).email === "string"
          ? (req.body as { email: string }).email.trim().toLowerCase().slice(0, 120)
          : "";
      return `login:${ip}:${email}`;
    },
    onLimitExceeded: logRateLimitExceeded,
  });

  const apiLimiter = createSlidingWindowRateLimiter({
    windowMs,
    maxRequests: apiMax,
    keyGenerator: (req) => {
      const authReq = req as AuthenticatedRequest;
      if (authReq.actor) {
        return `actor:${authReq.actor.tenantId}:${authReq.actor.userId}`;
      }
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      return `ip:${String(ip).trim().slice(0, 128)}`;
    },
    onLimitExceeded: logRateLimitExceeded,
  });

  // Dedicated readiness probe rate limiter & 2s TTL cache prevents unauthenticated DB-probe floods (H15)
  const readyLimiter = createSlidingWindowRateLimiter({
    windowMs: 10_000,
    maxRequests: 60,
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      return `ready:${String(ip).trim().slice(0, 128)}`;
    },
    onLimitExceeded: logRateLimitExceeded,
  });
  const readyCacheTtlMs = Math.max(0, options.readyCacheTtlMs ?? 2_000);
  let readyCache: { expiresAt: number; report: DatabaseReadinessReport } | null = null;

  // Bounded concurrency gates for CPU/Chromium-heavy endpoints (H17)
  const pdfExportGate = createConcurrencyGate(options.maxConcurrentPdfExports ?? 2);
  const dataPrepGate = createConcurrencyGate(options.maxConcurrentDataPrep ?? 2);

  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy !== undefined && options.trustProxy !== false) {
    app.set("trust proxy", options.trustProxy);
  }
  app.use(observability.middleware);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: useJwtPg,
    }),
  );

  // Outer IP flood shield + login IP shield run BEFORE JSON body allocation (H14, H15)
  if (rateLimitEnabled) {
    app.use("/api", preParseIpLimiter.middleware);
    app.use("/api/auth/login", loginIpLimiter.middleware);
    app.use("/api/auth/token", loginIpLimiter.middleware);
    app.use("/api/ready", readyLimiter.middleware);
  }

  // Route-specific JSON body size limits (H14 — no blanket 25mb parser on auth/read endpoints)
  const authJsonParser = express.json({ limit: "16kb" });
  const largeUploadJsonParser = express.json({ limit: "16mb" });
  const dataPrepJsonParser = express.json({ limit: "6mb" });
  const defaultJsonParser = express.json({ limit: "2mb" });

  app.use("/api/auth", authJsonParser);
  app.use("/api/documents/import/docx", largeUploadJsonParser);
  app.use("/api/speech/transcribe", largeUploadJsonParser);
  app.use("/api/data-prep", dataPrepJsonParser);
  app.use(defaultJsonParser);

  app.use((req, res, next) => {
    res.setHeader("X-Auth-Mode", useJwtPg ? "jwt-postgresql-rls" : "provisional-local-prototype");
    if (
      req.path.startsWith("/api/auth") ||
      req.path.startsWith("/api/documents") ||
      req.path.startsWith("/api/speech") ||
      req.path.startsWith("/api/data-prep") ||
      req.path.startsWith("/api/metrics")
    ) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "ai-office-suite-api",
      phase: useJwtPg ? "D2-platform-foundation" : "D0/D1-feasibility-prototype",
      authMode,
      plannedStudios: PLANNED_FUTURE_STUDIOS,
    });
  });

  app.get("/api/ready", async (req, res) => {
    const requestId = (req as Request & { requestId?: string }).requestId;
    if (options.isShuttingDown?.()) {
      res.status(503).json({ status: "draining", authMode, requestId });
      return;
    }
    if (!useJwtPg || !options.db) {
      res.json({
        status: "ready",
        authMode,
        checks: { storage: options.inMemory ? "in-memory" : "local-fs" },
      });
      return;
    }
    try {
      const now = Date.now();
      let report: DatabaseReadinessReport;
      if (readyCache && readyCache.expiresAt > now && readyCache.report.ready) {
        report = readyCache.report;
      } else {
        report = await verifyDatabaseRlsReadiness(options.db, {
          requireNonSuperuserConnection: Boolean(options.requireNonSuperuserDb),
        });
        if (readyCacheTtlMs > 0 && report.ready) {
          readyCache = { expiresAt: now + readyCacheTtlMs, report };
        }
      }
      res.status(report.ready ? 200 : 503).json({
        status: report.ready ? "ready" : "degraded",
        authMode,
        engine: report.engine,
        checks: report.checks,
      });
    } catch (err) {
      readyCache = null;
      observability.logEvent("error", "readiness.probe_failed", {
        requestId,
        error: err instanceof Error ? err.message : "UnknownError",
      });
      res.status(503).json({
        status: "degraded",
        authMode,
        error: "Readiness probe failed",
        code: "READINESS_ERROR",
        requestId,
      });
    }
  });

  registerAuthAndMetricsRoutes(app, {
    useJwtPg,
    authMode,
    db: options.db,
    allowedOrigins,
    rateLimitEnabled,
    loginLimiter,
    loginIpLimiter,
    apiLimiter,
    observability,
    resolvePrototypeActor,
  });

  const getActor = (req: Request): ActorContext => {
    if (useJwtPg) {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.actor) {
        throw new AuthenticationError(401, "MISSING_TOKEN", "Authentication required.");
      }
      return authReq.actor;
    }
    return resolvePrototypeActor(req);
  };

  registerDocumentRoutes(app, { gateway, getActor, pdfExportGate });
  registerAiAndSpeechRoutes(app, { gateway, getActor });
  registerDataPrepRoutes(app, { gateway, getActor, dataPrepGate });

  app.use((req: Request, res: Response) => {
    const requestId = (req as Request & { requestId?: string }).requestId;
    res.status(404).json({
      error: "Endpoint not found",
      code: "NOT_FOUND",
      ...(requestId ? { requestId } : {}),
    });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as Request & { requestId?: string }).requestId;
    if (
      err instanceof AuthenticationError ||
      err instanceof AuthorizationError ||
      err instanceof DatabaseConflictError ||
      err instanceof DocumentEngineError ||
      err instanceof DataPrepError ||
      err instanceof DocxImportError ||
      err instanceof PdfExportError ||
      err instanceof SpeechProviderError ||
      err instanceof AiPlanningError
    ) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        ...(requestId ? { requestId } : {}),
      });
      return;
    }

    const httpErr = err as { status?: number; statusCode?: number; type?: string };
    const status = httpErr?.status ?? httpErr?.statusCode;
    if (httpErr?.type === "entity.parse.failed" || (err instanceof SyntaxError && status === 400)) {
      res.status(400).json({
        error: "Malformed JSON request body.",
        code: "INVALID_JSON",
        ...(requestId ? { requestId } : {}),
      });
      return;
    }
    if (httpErr?.type === "entity.too.large" || status === 413) {
      res.status(413).json({
        error: "Request body exceeds maximum allowed size.",
        code: "PAYLOAD_TOO_LARGE",
        ...(requestId ? { requestId } : {}),
      });
      return;
    }

    const authReq = req as AuthenticatedRequest;
    observability.logEvent("error", "http.unhandled_error", {
      requestId,
      method: req.method,
      path: req.path,
      tenantId: authReq.actor?.tenantId,
      errName: err instanceof Error ? err.name : "UnknownError",
      errMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 1500) : undefined,
    });
    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      ...(requestId ? { requestId } : {}),
    });
  });

  return app;
}
