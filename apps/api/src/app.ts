import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import type { ActorContext, StudioDocument } from "@ai-office-suite/shared-contracts";
import { PLANNED_FUTURE_STUDIOS } from "@ai-office-suite/shared-contracts";
import {
  aiApplyRequestSchema,
  aiPlanRequestSchema,
  createDocumentSchema,
  dataPrepStageProfileSchema,
  importDocxRequestSchema,
  listDocumentsQuerySchema,
  loginRequestSchema,
  speechTranscribeRequestSchema,
  updateDocumentSchema,
} from "@ai-office-suite/validation";
import { AuthorizationError, assertCanPerform, isWorkspaceRole } from "@ai-office-suite/authorization";
import {
  DatabaseConflictError,
  PostgreSqlDocumentRepository,
  verifyDatabaseRlsReadiness,
  type PgDatabaseAdapter,
} from "@ai-office-suite/database";
import {
  AuthenticationError,
  authenticateUserWithPassword,
  clearSessionCookie,
  createJwtAuthMiddleware,
  parseCookie,
  revokeUserSessions,
  SESSION_COOKIE_NAME,
  setSessionCookie,
  verifyCookieCsrf,
  type AuthenticatedRequest,
} from "@ai-office-suite/identity";
import { InMemoryAuditStore, LocalJsonlAuditStore, type AuditStore } from "@ai-office-suite/audit";
import { InMemoryStorageAdapter, LocalFilesystemStorageAdapter, type DocumentStorageAdapter } from "@ai-office-suite/storage";
import {
  computeDocumentRevisionDiff,
  DocumentEngineError,
  createEmptyDocument,
  normalizeDocumentText,
  previewDocumentOperation,
} from "@ai-office-suite/document-engine";
import {
  DataPreparationPipeline,
  DataPrepError,
  profileDataset,
  stageCsvSource,
} from "@ai-office-suite/data-processing";
import {
  DocxImportError,
  exportToDocxBuffer,
  exportToPdfBuffer,
  importFromDocxBuffer,
  PdfExportError,
} from "@ai-office-suite/file-conversion";
import { getSpeechAdapter, SpeechProviderError } from "@ai-office-suite/speech-engine";
import { DocumentService } from "@ai-office-suite/documents-module";
import { AiDocumentExecutor, AiPlanningError, planDocumentOperation } from "@ai-office-suite/ai-module";
import { createSlidingWindowRateLimiter } from "./rateLimit.ts";
import { createApiObservability } from "./observability.ts";

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
  rateLimit?: {
    enabled?: boolean;
    windowMs?: number;
    loginMaxPerWindow?: number;
    apiMaxPerWindow?: number;
  };
}

function safeDownloadFilename(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "document";
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
  const pgRepo = options.db ? new PostgreSqlDocumentRepository(options.db) : null;

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

  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5174,http://127.0.0.1:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rateLimitEnabled = options.rateLimit?.enabled ?? process.env.NODE_ENV !== "test";
  const loginLimiter = createSlidingWindowRateLimiter({
    windowMs: options.rateLimit?.windowMs ?? 60_000,
    maxRequests: options.rateLimit?.loginMaxPerWindow ?? 15,
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      const email =
        typeof req.body === "object" && req.body !== null && typeof (req.body as { email?: unknown }).email === "string"
          ? (req.body as { email: string }).email.trim().toLowerCase().slice(0, 120)
          : "";
      return `login:${ip}:${email}`;
    },
  });
  const apiLimiter = createSlidingWindowRateLimiter({
    windowMs: options.rateLimit?.windowMs ?? 60_000,
    maxRequests: options.rateLimit?.apiMaxPerWindow ?? 300,
    keyGenerator: (req) => {
      const authReq = req as AuthenticatedRequest;
      if (authReq.actor) {
        return `actor:${authReq.actor.tenantId}:${authReq.actor.userId}`;
      }
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      return `ip:${String(ip).trim().slice(0, 128)}`;
    },
    onLimitExceeded: (req, key) => {
      observability.logEvent("warn", "security.rate_limit_exceeded", {
        requestId: (req as Request & { requestId?: string }).requestId,
        method: req.method,
        path: req.path,
        bucket: key.split(":")[0],
      });
    },
  });
  const observability = createApiObservability({
    enableStructuredLogs: options.enableStructuredLogs,
    sink: options.logSink,
  });

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
  app.use(express.json({ limit: "25mb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Auth-Mode", useJwtPg ? "jwt-postgresql-rls" : "provisional-local-prototype");
    if (
      req.path.startsWith("/api/auth") ||
      req.path.startsWith("/api/documents") ||
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
      res.status(503).json({
        status: "draining",
        authMode,
        requestId,
      });
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
      const report = await verifyDatabaseRlsReadiness(options.db, {
        requireNonSuperuserConnection: Boolean(options.requireNonSuperuserDb),
      });
      res.status(report.ready ? 200 : 503).json({
        status: report.ready ? "ready" : "degraded",
        authMode,
        engine: report.engine,
        checks: report.checks,
      });
    } catch (err) {
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

  if (useJwtPg && options.db) {
    const db = options.db;
    const jwtMiddleware = createJwtAuthMiddleware(db, allowedOrigins);

    if (rateLimitEnabled) {
      app.use("/api/auth/login", loginLimiter.middleware);
    }

    app.get("/api/metrics", jwtMiddleware, (req, res) => {
      const authReq = req as AuthenticatedRequest;
      if (authReq.actor?.role !== "owner" && authReq.actor?.role !== "administrator") {
        res.status(403).json({
          error: "Metrics endpoint requires owner or administrator role.",
          code: "FORBIDDEN_ROLE",
        });
        return;
      }
      res.json({
        service: "ai-office-suite-api",
        authMode,
        metrics: observability.getMetrics(),
        rateLimits: {
          enabled: rateLimitEnabled,
          login: loginLimiter.getStats(),
          api: apiLimiter.getStats(),
        },
        ...(db.getPoolStats ? { dbPool: db.getPoolStats() } : {}),
      });
    });

    app.post("/api/auth/login", async (req, res, next) => {
      try {
        const parsed = loginRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid login credentials payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
          return;
        }
        const session = await authenticateUserWithPassword({
          db,
          email: parsed.data.email,
          password: parsed.data.password,
          tenantId: parsed.data.tenantId,
          workspaceId: parsed.data.workspaceId,
        });
        setSessionCookie(req, res, session.token);
        res.json({ token: session.token, actor: session.actor });
      } catch (err) {
        next(err);
      }
    });

    app.post("/api/auth/logout", (req, res) => {
      const hasBearer = Boolean(req.headers.authorization?.startsWith("Bearer "));
      const hasCookie = Boolean(parseCookie(req.headers.cookie, SESSION_COOKIE_NAME));
      if (!hasBearer && hasCookie) {
        if (!verifyCookieCsrf(req, res, allowedOrigins)) return;
      }
      clearSessionCookie(req, res);
      res.json({ ok: true });
    });

    app.get("/api/auth/me", jwtMiddleware, (req, res) => {
      const authReq = req as AuthenticatedRequest;
      res.json({ actor: authReq.actor, authSource: authReq.authSource });
    });

    app.post("/api/auth/revoke-sessions", jwtMiddleware, async (req, res, next) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const nextVersion = await revokeUserSessions(db, authReq.actor!.userId);
        clearSessionCookie(req, res);
        res.json({ revoked: true, tokenVersion: nextVersion });
      } catch (err) {
        next(err);
      }
    });

    // Enforce JWT + PostgreSQL RLS live membership check on all document, speech & data-prep routes
    app.use("/api/documents", jwtMiddleware);
    app.use("/api/speech", jwtMiddleware);
    app.use("/api/data-prep", jwtMiddleware);
    if (rateLimitEnabled) {
      app.use("/api/documents", apiLimiter.middleware);
      app.use("/api/speech", apiLimiter.middleware);
      app.use("/api/data-prep", apiLimiter.middleware);
    }
  } else {
    if (rateLimitEnabled) {
      app.use("/api/documents", apiLimiter.middleware);
      app.use("/api/speech", apiLimiter.middleware);
      app.use("/api/data-prep", apiLimiter.middleware);
    }
    app.get("/api/metrics", (req, res) => {
      const actor = resolvePrototypeActor(req);
      if (actor.role !== "owner" && actor.role !== "administrator") {
        res.status(403).json({ error: "Metrics endpoint requires owner or administrator role.", code: "FORBIDDEN_ROLE" });
        return;
      }
      res.json({
        service: "ai-office-suite-api",
        authMode,
        metrics: observability.getMetrics(),
        rateLimits: {
          enabled: rateLimitEnabled,
          login: loginLimiter.getStats(),
          api: apiLimiter.getStats(),
        },
      });
    });
  }

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

  app.get("/api/documents", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const parsed = listDocumentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid document list query", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const page = pgRepo
        ? await pgRepo.listDocumentsFiltered(actor, parsed.data)
        : await documents.listDocumentsFiltered(actor, parsed.data);
      res.json(page);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const parsed = createDocumentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid document payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      if (pgRepo) {
        const doc = createEmptyDocument({
          documentId: randomUUID(),
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          title: parsed.data.title,
          language: parsed.data.language,
          createdBy: actor.userId,
        });
        if (parsed.data.layout) doc.layout = parsed.data.layout;
        if (parsed.data.blocks) doc.blocks = parsed.data.blocks;
        const created = await pgRepo.createDocument(actor, doc);
        res.status(201).json({ document: created });
        return;
      }
      const created = await documents.createDocument(actor, parsed.data);
      res.status(201).json({ document: created });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/seed-bilingual-fixture", async (req, res, next) => {
    try {
      const actor = getActor(req);
      if (pgRepo) {
        assertCanPerform(actor, "document", "create");
        const sample = await documents.seedBilingualSample(actor);
        const pgDoc: StudioDocument = {
          ...sample,
          documentId: randomUUID(),
        };
        const created = await pgRepo.createDocument(actor, pgDoc, {
          source: "manual",
          action: "document.created",
          summary: `Seeded bilingual fixture '${pgDoc.title}'.`,
        });
        res.status(201).json({ document: created });
        return;
      }
      const created = await documents.seedBilingualSample(actor);
      res.status(201).json({ document: created });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const doc = pgRepo ? await pgRepo.getDocument(actor, req.params.id) : await documents.getDocument(actor, req.params.id);
      res.json({ document: doc });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/documents/:id", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const parsed = updateDocumentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid update payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      if (pgRepo) {
        const updated = await pgRepo.updateDocument(
          actor,
          req.params.id,
          parsed.data.expectedRevision,
          (current, nextRevision): StudioDocument => ({
            ...current,
            title: parsed.data.title ? normalizeDocumentText(parsed.data.title) : current.title,
            language: parsed.data.language ?? current.language,
            layout: parsed.data.layout ?? current.layout,
            blocks: parsed.data.blocks,
            revision: nextRevision,
            updatedAt: new Date().toISOString(),
          }),
          {
            source: "manual",
            action: "document.update",
            summary: parsed.data.summary ?? undefined,
          },
        );
        res.json({ document: updated });
        return;
      }
      const updated = await documents.updateDocument(actor, req.params.id, parsed.data);
      res.json({ document: updated });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id/versions", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const versions = pgRepo
        ? await pgRepo.listVersions(actor, req.params.id)
        : await documents.listVersions(actor, req.params.id);
      res.json({ versions });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id/versions/:fromRev/diff/:toRev", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const fromRev = Number(req.params.fromRev);
      const toRev = Number(req.params.toRev);
      if (!Number.isInteger(fromRev) || fromRev < 1 || !Number.isInteger(toRev) || toRev < 1) {
        res.status(400).json({ error: "Invalid revision numbers", code: "VALIDATION_ERROR" });
        return;
      }
      const fromVer = pgRepo
        ? await pgRepo.getVersion(actor, req.params.id, fromRev)
        : await documents.getVersion(actor, req.params.id, fromRev);
      const toVer = pgRepo
        ? await pgRepo.getVersion(actor, req.params.id, toRev)
        : await documents.getVersion(actor, req.params.id, toRev);
      if (!fromVer || !toVer) {
        res.status(404).json({ error: "Requested document revision not found", code: "VERSION_NOT_FOUND" });
        return;
      }
      const diff = computeDocumentRevisionDiff(fromVer.snapshot, toVer.snapshot);
      res.json({ diff });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/versions/:revision/restore", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const rev = Number(req.params.revision);
      if (!Number.isInteger(rev) || rev < 1) {
        res.status(400).json({ error: "Invalid revision number", code: "VALIDATION_ERROR" });
        return;
      }
      const restored = pgRepo
        ? await pgRepo.restoreVersion(actor, req.params.id, rev)
        : await documents.restoreVersion(actor, req.params.id, rev);
      res.json({ document: restored });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/ai/plan", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const parsed = aiPlanRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI plan request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const doc = pgRepo
        ? await pgRepo.getDocument(actor, req.params.id)
        : await documents.getDocument(actor, req.params.id);
      const prior =
        doc.revision > 1
          ? pgRepo
            ? await pgRepo.getVersion(actor, doc.documentId, doc.revision - 1)
            : await documents.getVersion(actor, doc.documentId, doc.revision - 1)
          : null;
      const proposal = planDocumentOperation({
        actor,
        document: doc,
        priorRevisionDoc: prior?.snapshot ?? null,
        input: parsed.data,
        audit,
      });
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/ai/apply", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const parsed = aiApplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI apply request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      if (parsed.data.proposal.documentId !== req.params.id) {
        res.status(400).json({ error: "Proposal documentId mismatch", code: "DOCUMENT_MISMATCH" });
        return;
      }
      if (pgRepo) {
        assertCanPerform(actor, "ai_assistant", "apply_ai");
        assertCanPerform(actor, "document", "write");
        if (!parsed.data.approved) {
          throw new AiPlanningError(
            400,
            "APPROVAL_REQUIRED",
            "Explicit user approval is required before applying an AI or voice operation.",
          );
        }
        const result = await pgRepo.applyAiOperationIdempotent({
          actor,
          documentId: req.params.id,
          operationId: parsed.data.proposal.operationId,
          expectedRevision: parsed.data.proposal.expectedRevision,
          source: parsed.data.proposal.source === "voice_command" ? "voice_command" : "typed_ai",
          loadPriorForUndo: parsed.data.proposal.action === "undo_last",
          buildNext: (currentDoc, priorSnapshot, nextRevision) => {
            const { nextDoc, preview } = previewDocumentOperation(
              currentDoc,
              parsed.data.proposal,
              priorSnapshot,
            );
            return {
              updatedDoc: { ...nextDoc, revision: nextRevision },
              summary: `[${parsed.data.proposal.source}] ${parsed.data.proposal.action}: ${preview.summary}`,
            };
          },
        });
        res.json(result);
        return;
      }
      const result = await aiExecutor.applyProposal({
        actor,
        proposal: parsed.data.proposal,
        approved: parsed.data.approved,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/speech/transcribe", async (req, res, next) => {
    try {
      const parsed = speechTranscribeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid speech request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const adapter = getSpeechAdapter(parsed.data.provider);
      const result = await adapter.transcribe(parsed.data);
      res.json({ recognition: result });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/import/docx", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const parsed = importDocxRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid DOCX import payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const buffer = Buffer.from(parsed.data.contentBase64, "base64");
      if (pgRepo) {
        assertCanPerform(actor, "document", "create");
        const { document, diagnostics } = await importFromDocxBuffer({
          buffer,
          filename: parsed.data.filename,
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
        });
        const pgDoc: StudioDocument = { ...document, documentId: randomUUID() };
        const created = await pgRepo.createDocument(actor, pgDoc, {
          source: "import",
          action: "document.imported_docx",
          summary: `Imported DOCX '${parsed.data.filename}' (SHA-256 ${diagnostics.originalSha256.slice(0, 12)}).`,
        });
        res.status(201).json({ document: created, diagnostics });
        return;
      }
      const imported = await documents.importDocx(actor, parsed.data.filename, buffer);
      res.status(201).json(imported);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/export/docx", async (req, res, next) => {
    try {
      const actor = getActor(req);
      if (pgRepo) {
        assertCanPerform(actor, "export", "export");
        const doc = await pgRepo.getDocument(actor, req.params.id);
        const buffer = await exportToDocxBuffer(doc);
        await pgRepo.recordAudit(actor, {
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          documentId: doc.documentId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "export",
          action: "document.exported_docx",
          outcome: "success",
          revisionBefore: doc.revision,
          revisionAfter: doc.revision,
          summary: `Exported DOCX snapshot (${buffer.byteLength} bytes).`,
        });
        const filename = safeDownloadFilename(`${doc.documentId}-rev${doc.revision}.docx`);
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(buffer);
        return;
      }
      const { buffer, filename } = await documents.exportDocx(actor, req.params.id);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${safeDownloadFilename(filename)}"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/export/pdf", async (req, res, next) => {
    try {
      const actor = getActor(req);
      if (pgRepo) {
        assertCanPerform(actor, "export", "export");
        const doc = await pgRepo.getDocument(actor, req.params.id);
        const result = await exportToPdfBuffer(doc);
        await pgRepo.recordAudit(actor, {
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          documentId: doc.documentId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "export",
          action: "document.exported_pdf",
          outcome: "success",
          revisionBefore: doc.revision,
          revisionAfter: doc.revision,
          summary: `Exported searchable PDF via ${result.engine} (${result.pdfBuffer.byteLength} bytes).`,
        });
        const filename = safeDownloadFilename(`${doc.documentId}-rev${doc.revision}.pdf`);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("X-Pdf-Engine", result.engine);
        res.send(result.pdfBuffer);
        return;
      }
      const result = await documents.exportPdf(actor, req.params.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeDownloadFilename(result.filename)}"`);
      res.setHeader("X-Pdf-Engine", result.engine);
      res.send(result.pdfBuffer);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id/audit", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const events = pgRepo
        ? await pgRepo.listAuditEvents(actor, req.params.id)
        : await documents.listAuditEvents(actor, req.params.id);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/data-prep/stage-and-profile", async (req, res, next) => {
    try {
      const actor = getActor(req);
      assertCanPerform(actor, "document", "write");
      const parsed = dataPrepStageProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid data-prep staging payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }

      const staged = stageCsvSource(parsed.data.csvText, parsed.data.filename, {
        delimiter: parsed.data.delimiter ?? "auto",
        maxRows: 50_000,
      });
      const profile = profileDataset(staged.source.sourceId, staged.rows, {
        scope: parsed.data.profileScope,
        sampleSize: parsed.data.sampleSize,
      });

      let dryRunArtifact: {
        status: string;
        outputSha256: string;
        reconciliation: unknown;
        exceptionCount: number;
        sampleRows: Array<Record<string, unknown>>;
      } | null = null;

      if (parsed.data.steps && parsed.data.steps.length > 0) {
        const expectedColumns =
          parsed.data.expectedColumns && parsed.data.expectedColumns.length > 0
            ? parsed.data.expectedColumns
            : staged.source.columnNames;
        const sandboxPipeline = new DataPreparationPipeline();
        const artifact = sandboxPipeline.executeRecipe({
          actor,
          recipe: {
            recipeId: `sandbox_${randomUUID().slice(0, 8)}`,
            version: 1,
            tenantId: actor.tenantId,
            workspaceId: actor.workspaceId,
            pinnedInputSha256s: [staged.source.sha256],
            idempotencyKey: `idem_${randomUUID()}`,
            steps: parsed.data.steps,
          },
          salesSources: [staged],
          expectedColumns,
        });
        dryRunArtifact = {
          status: artifact.status,
          outputSha256: artifact.outputSha256,
          reconciliation: artifact.reconciliation,
          exceptionCount: artifact.exceptions.length,
          sampleRows: artifact.rows.slice(0, 50),
        };
      }

      if (pgRepo) {
        await pgRepo.recordAudit(actor, {
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "import",
          action: "data_prep.stage_and_profile",
          outcome: "success",
          summary: `Staged '${parsed.data.filename}' (${staged.source.acceptedRows} accepted, ${staged.source.rejectedRows} rejected).`,
        });
      } else {
        audit.append({
          auditId: `aud_${randomUUID()}`,
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "import",
          action: "data_prep.stage_and_profile",
          outcome: "success",
          summary: `Staged '${parsed.data.filename}' (${staged.source.acceptedRows} accepted, ${staged.source.rejectedRows} rejected).`,
          createdAt: new Date().toISOString(),
        });
      }

      res.json({
        source: staged.source,
        profile,
        rejects: staged.rejects.slice(0, 50),
        sampleRows: staged.rows.slice(0, 50),
        dryRun: dryRunArtifact,
      });
    } catch (err) {
      next(err);
    }
  });

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

    // Handle Express body-parser HTTP errors cleanly (400 malformed JSON, 413 oversized payload)
    const httpErr = err as { status?: number; statusCode?: number; type?: string; name?: string; message?: string };
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
