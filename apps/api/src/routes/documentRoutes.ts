import type { Express, Request } from "express";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { computeDocumentRevisionDiff } from "@ai-office-suite/document-engine";
import {
  createDocumentSchema,
  importDocxRequestSchema,
  listDocumentsQuerySchema,
  updateDocumentSchema,
} from "@ai-office-suite/validation";
import type { DocumentGateway } from "../documentGateway.ts";

const MAX_PG_INT32 = 2_147_483_647;

export function parseStrictRevisionParam(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PG_INT32) return null;
  return n;
}

export function safeDownloadFilename(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "document";
}

export interface ConcurrencyGate {
  tryAcquire(): (() => void) | null;
  getActive(): number;
}

export interface DocumentRoutesDeps {
  gateway: DocumentGateway;
  getActor: (req: Request) => ActorContext;
  pdfExportGate: ConcurrencyGate;
}

export function registerDocumentRoutes(app: Express, deps: DocumentRoutesDeps): void {
  const { gateway, getActor, pdfExportGate } = deps;

  app.get("/api/documents", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const parsed = listDocumentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid document list query", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const page = await gateway.listDocuments(actor, parsed.data);
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
      const created = await gateway.createDocument(actor, parsed.data);
      res.status(201).json({ document: created });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/seed-bilingual-fixture", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const created = await gateway.seedBilingualFixture(actor);
      res.status(201).json({ document: created });
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
      const imported = await gateway.importDocx(actor, parsed.data.filename, buffer);
      res.status(201).json(imported);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const doc = await gateway.getDocument(actor, req.params.id);
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
      const updated = await gateway.updateDocument(actor, req.params.id, parsed.data);
      res.json({ document: updated });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id/versions", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const versions = await gateway.listVersions(actor, req.params.id);
      res.json({ versions });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/documents/:id/versions/:fromRev/diff/:toRev", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const fromRev = parseStrictRevisionParam(req.params.fromRev);
      const toRev = parseStrictRevisionParam(req.params.toRev);
      if (fromRev === null || toRev === null) {
        res.status(400).json({ error: "Invalid revision numbers (must be integers 1..2147483647)", code: "VALIDATION_ERROR" });
        return;
      }
      const { fromDoc, toDoc } = await gateway.getVersionsForDiff(actor, req.params.id, fromRev, toRev);
      if (!fromDoc || !toDoc) {
        res.status(404).json({ error: "Requested document revision not found", code: "VERSION_NOT_FOUND" });
        return;
      }
      const diff = computeDocumentRevisionDiff(fromDoc, toDoc);
      res.json({ diff });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/versions/:revision/restore", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const rev = parseStrictRevisionParam(req.params.revision);
      if (rev === null) {
        res.status(400).json({ error: "Invalid revision number (must be integer 1..2147483647)", code: "VALIDATION_ERROR" });
        return;
      }
      const restored = await gateway.restoreVersion(actor, req.params.id, rev);
      res.json({ document: restored });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/export/docx", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const { buffer, filename } = await gateway.exportDocx(actor, req.params.id);
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
    const release = pdfExportGate.tryAcquire();
    if (!release) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({
        error: "PDF export workers are currently at capacity. Please retry shortly.",
        code: "SERVICE_BUSY",
        retryAfterSeconds: 2,
      });
      return;
    }
    try {
      const actor = getActor(req);
      const result = await gateway.exportPdf(actor, req.params.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeDownloadFilename(result.filename)}"`);
      res.setHeader("X-Pdf-Engine", result.engine);
      res.send(result.pdfBuffer);
    } catch (err) {
      next(err);
    } finally {
      release();
    }
  });

  app.get("/api/documents/:id/audit", async (req, res, next) => {
    try {
      const actor = getActor(req);
      const events = await gateway.listAuditEvents(actor, req.params.id);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });
}
