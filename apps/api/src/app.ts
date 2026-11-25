import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { PLANNED_FUTURE_STUDIOS } from "@ai-office-suite/shared-contracts";
import {
  aiApplyRequestSchema,
  aiPlanRequestSchema,
  createDocumentSchema,
  importDocxRequestSchema,
  speechTranscribeRequestSchema,
  updateDocumentSchema,
} from "@ai-office-suite/validation";
import { AuthorizationError, isWorkspaceRole } from "@ai-office-suite/authorization";
import { InMemoryAuditStore, LocalJsonlAuditStore, type AuditStore } from "@ai-office-suite/audit";
import { InMemoryStorageAdapter, LocalFilesystemStorageAdapter, type DocumentStorageAdapter } from "@ai-office-suite/storage";
import { DocumentEngineError } from "@ai-office-suite/document-engine";
import { DocxImportError, PdfExportError } from "@ai-office-suite/file-conversion";
import { getSpeechAdapter, SpeechProviderError } from "@ai-office-suite/speech-engine";
import { DocumentService } from "@ai-office-suite/documents-module";
import { AiDocumentExecutor, AiPlanningError, planDocumentOperation } from "@ai-office-suite/ai-module";

export interface CreateApiAppOptions {
  storageDir?: string;
  inMemory?: boolean;
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
  const storageDir = options.storageDir ?? path.resolve(process.cwd(), process.env.LOCAL_STORAGE_DIR ?? ".local-data");
  const storage: DocumentStorageAdapter = options.inMemory
    ? new InMemoryStorageAdapter()
    : new LocalFilesystemStorageAdapter(storageDir);
  const audit: AuditStore = options.inMemory
    ? new InMemoryAuditStore()
    : new LocalJsonlAuditStore(storageDir);

  const documents = new DocumentService(storage, audit);
  const aiExecutor = new AiDocumentExecutor(documents, audit);

  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: (process.env.CORS_ORIGIN ?? "http://localhost:5174,http://127.0.0.1:5174")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "25mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Auth-Mode", "provisional-local-prototype");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "ai-office-suite-api",
      phase: "D0/D1-feasibility-prototype",
      plannedStudios: PLANNED_FUTURE_STUDIOS,
    });
  });

  app.get("/api/documents", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const list = await documents.listDocuments(actor);
      res.json({ documents: list });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const parsed = createDocumentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid document payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
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
      const actor = resolvePrototypeActor(req);
      const created = await documents.seedBilingualSample(actor);
      res.status(201).json({ document: created });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const doc = await documents.getDocument(actor, req.params.id);
      res.json({ document: doc });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/documents/:id", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const parsed = updateDocumentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid update payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
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
      const actor = resolvePrototypeActor(req);
      const versions = await documents.listVersions(actor, req.params.id);
      res.json({ versions });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/versions/:revision/restore", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const rev = Number(req.params.revision);
      if (!Number.isInteger(rev) || rev < 1) {
        res.status(400).json({ error: "Invalid revision number", code: "VALIDATION_ERROR" });
        return;
      }
      const restored = await documents.restoreVersion(actor, req.params.id, rev);
      res.json({ document: restored });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/ai/plan", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const parsed = aiPlanRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI plan request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const doc = await documents.getDocument(actor, req.params.id);
      const prior = doc.revision > 1 ? await documents.getVersion(actor, doc.documentId, doc.revision - 1) : null;
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
      const actor = resolvePrototypeActor(req);
      const parsed = aiApplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI apply request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      if (parsed.data.proposal.documentId !== req.params.id) {
        res.status(400).json({ error: "Proposal documentId mismatch", code: "DOCUMENT_MISMATCH" });
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
      const actor = resolvePrototypeActor(req);
      const parsed = importDocxRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid DOCX import payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const buffer = Buffer.from(parsed.data.contentBase64, "base64");
      const imported = await documents.importDocx(actor, parsed.data.filename, buffer);
      res.status(201).json(imported);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/export/docx", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const { buffer, filename } = await documents.exportDocx(actor, req.params.id);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/export/pdf", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const result = await documents.exportPdf(actor, req.params.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.setHeader("X-Pdf-Engine", result.engine);
      res.send(result.pdfBuffer);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id/audit", async (req, res, next) => {
    try {
      const actor = resolvePrototypeActor(req);
      const events = await documents.listAuditEvents(actor, req.params.id);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (
      err instanceof AuthorizationError ||
      err instanceof DocumentEngineError ||
      err instanceof DocxImportError ||
      err instanceof PdfExportError ||
      err instanceof SpeechProviderError ||
      err instanceof AiPlanningError
    ) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
      });
      return;
    }
    console.error("Unhandled API error:", err instanceof Error ? err.name : "UnknownError");
    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  });

  return app;
}
