import { randomUUID } from "node:crypto";
import type {
  ActorContext,
  AuditEvent,
  DocumentBlock,
  DocumentVersion,
  ImportDiagnostics,
  PageLayoutConfig,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import { assertCanPerform, assertTenantWorkspaceAccess } from "@ai-office-suite/authorization";
import type { AuditStore } from "@ai-office-suite/audit";
import type { DocumentStorageAdapter } from "@ai-office-suite/storage";
import {
  createEmptyDocument,
  DocumentEngineError,
  normalizeDocumentText,
} from "@ai-office-suite/document-engine";
import {
  exportToDocxBuffer,
  exportToPdfBuffer,
  importFromDocxBuffer,
  type PdfExportResult,
} from "@ai-office-suite/file-conversion";

export class DocumentService {
  private readonly storage: DocumentStorageAdapter;
  private readonly audit: AuditStore;

  constructor(storage: DocumentStorageAdapter, audit: AuditStore) {
    this.storage = storage;
    this.audit = audit;
  }

  private recordAudit(event: Omit<AuditEvent, "auditId" | "createdAt">): AuditEvent {
    const full: AuditEvent = {
      ...event,
      auditId: `aud_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.audit.append(full);
    return full;
  }

  async createDocument(
    actor: ActorContext,
    input: {
      title: string;
      language?: "en" | "km" | "bilingual";
      layout?: PageLayoutConfig;
      blocks?: DocumentBlock[];
    },
  ): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "create");
    const doc = createEmptyDocument({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      title: input.title,
      language: input.language,
      createdBy: actor.userId,
    });
    if (input.layout) doc.layout = input.layout;
    if (input.blocks && input.blocks.length > 0) doc.blocks = input.blocks;

    const version: DocumentVersion = {
      versionId: `ver_${randomUUID()}`,
      documentId: doc.documentId,
      revision: 1,
      snapshot: doc,
      summary: "Initial document created",
      source: "manual",
      actorId: actor.userId,
      createdAt: doc.createdAt,
    };
    await this.storage.saveDocumentVersion(version);
    this.recordAudit({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      documentId: doc.documentId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: "manual",
      action: "document.created",
      outcome: "success",
      revisionAfter: 1,
      summary: `Created document '${doc.title}'.`,
    });
    return doc;
  }

  async seedBilingualSample(actor: ActorContext): Promise<StudioDocument> {
    return this.createDocument(actor, {
      title: "របាយការណ៍ប្រចាំខែ · Monthly Management Report 2026",
      language: "bilingual",
      blocks: [
        {
          id: "blk_title_km",
          type: "heading",
          level: 1,
          alignment: "left",
          runs: [
            {
              text: "របាយការណ៍គ្រប់គ្រងប្រចាំខែវិច្ឆិកា ឆ្នាំ២០២៦",
              marks: { bold: true, fontFamily: "Kantumruy Pro" },
            },
          ],
        },
        {
          id: "blk_subtitle_en",
          type: "heading",
          level: 2,
          alignment: "left",
          runs: [
            {
              text: "Monthly Management Report — November 2026",
              marks: { bold: true, fontFamily: "Inter" },
            },
          ],
        },
        {
          id: "blk_exec_summary",
          type: "paragraph",
          alignment: "left",
          runs: [
            {
              text: "The administration and finance departments completed operational reconciliation for November 2026 across all Phnom Penh and regional branches.",
            },
          ],
        },
        {
          id: "blk_khmer_para",
          type: "paragraph",
          alignment: "left",
          runs: [
            {
              text: "នាយកដ្ឋានរដ្ឋបាល និងហិរញ្ញវត្ថុបានបញ្ចប់ការត្រួតពិនិត្យផ្ទៀងផ្ទាត់ទិន្នន័យចំណូល និងចំណាយប្រចាំខែវិច្ឆិកា ឆ្នាំ២០២៦ ដោយជោគជ័យ ជាមួយនឹងតម្លាភាព និងសុក្រឹតភាពខ្ពស់។",
              marks: { fontFamily: "Noto Sans Khmer" },
            },
          ],
        },
        {
          id: "blk_metric_placeholder",
          type: "linked_metric_placeholder",
          metric: {
            datasetId: "ds_demo_finance_2026_11",
            datasetVersion: "v1.0",
            metricId: "metric_net_operating_profit",
            metricVersion: "v1.0",
            reportingPeriod: "2026-11",
            filterContext: { region: "All Cambodia", currency: "USD" },
            unit: "USD",
            currency: "USD",
            approvalStatus: "certified",
            freshnessTimestamp: "2026-11-26T00:00:00.000Z",
            mode: "published_snapshot",
            displayLabel: "Net Operating Profit (Synthetic D7 Placeholder)",
            cachedFormattedValue: "$38,500.00",
          },
        },
        {
          id: "blk_table_summary",
          type: "table",
          hasHeaderRow: true,
          rows: [
            [
              { runs: [{ text: "Department / នាយកដ្ឋាន", marks: { bold: true } }] },
              { runs: [{ text: "Budget (USD)", marks: { bold: true } }] },
              { runs: [{ text: "Actual (USD)", marks: { bold: true } }] },
            ],
            [
              { runs: [{ text: "Administration / រដ្ឋបាល" }] },
              { runs: [{ text: "$15,000.00" }] },
              { runs: [{ text: "$14,250.00" }] },
            ],
            [
              { runs: [{ text: "Operations / ប្រតិបត្តិការ" }] },
              { runs: [{ text: "$42,000.00" }] },
              { runs: [{ text: "$40,800.00" }] },
            ],
          ],
        },
      ],
    });
  }

  async listDocuments(actor: ActorContext): Promise<StudioDocument[]> {
    assertCanPerform(actor, "document", "read");
    return this.storage.listDocuments(actor.tenantId, actor.workspaceId);
  }

  async listDocumentsFiltered(
    actor: ActorContext,
    filter: { q?: string; language?: "en" | "km" | "bilingual"; limit?: number; offset?: number } = {},
  ): Promise<{ documents: StudioDocument[]; total: number; limit: number; offset: number }> {
    assertCanPerform(actor, "document", "read");
    const limit = Math.max(1, Math.min(100, Math.trunc(filter.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
    const qLower = filter.q?.trim().toLowerCase() ?? "";

    const all = await this.storage.listDocuments(actor.tenantId, actor.workspaceId);
    const filtered = all.filter((doc) => {
      if (filter.language && doc.language !== filter.language) return false;
      if (qLower && !doc.title.toLowerCase().includes(qLower)) return false;
      return true;
    });
    return {
      documents: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }

  async getDocument(actor: ActorContext, documentId: string): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "read");
    const doc = await this.storage.getDocument(documentId);
    if (!doc) {
      throw new DocumentEngineError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' was not found.`);
    }
    assertTenantWorkspaceAccess(actor, doc.tenantId, doc.workspaceId);
    return doc;
  }

  async updateDocument(
    actor: ActorContext,
    documentId: string,
    input: {
      title?: string;
      language?: "en" | "km" | "bilingual";
      expectedRevision: number;
      layout?: PageLayoutConfig;
      blocks: DocumentBlock[];
      summary?: string;
      source?: "manual" | "typed_ai" | "voice_command";
      operationId?: string;
      undoneRevision?: number;
    },
  ): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "write");
    const current = await this.getDocument(actor, documentId);
    if (current.revision !== input.expectedRevision) {
      throw new DocumentEngineError(
        409,
        "REVISION_CONFLICT",
        `Expected revision ${input.expectedRevision}, but current revision is ${current.revision}.`,
      );
    }

    const now = new Date().toISOString();
    const updated: StudioDocument = {
      ...current,
      title: input.title ? normalizeDocumentText(input.title) : current.title,
      language: input.language ?? current.language,
      layout: input.layout ?? current.layout,
      blocks: input.blocks,
      revision: current.revision + 1,
      updatedAt: now,
    };

    const version: DocumentVersion = {
      versionId: `ver_${randomUUID()}`,
      documentId: updated.documentId,
      revision: updated.revision,
      snapshot: updated,
      summary: input.summary ?? "Manual document update",
      source: input.source ?? "manual",
      actorId: actor.userId,
      ...(typeof input.undoneRevision === "number" ? { undoneRevision: input.undoneRevision } : {}),
      createdAt: now,
    };

    await this.storage.saveDocumentVersion(version);
    this.recordAudit({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      documentId: updated.documentId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: input.source ?? "manual",
      action: input.source === "manual" || !input.source ? "document.updated" : "document.ai_applied",
      outcome: "success",
      revisionBefore: current.revision,
      revisionAfter: updated.revision,
      operationId: input.operationId,
      summary: version.summary,
    });

    return updated;
  }

  async listVersions(actor: ActorContext, documentId: string): Promise<DocumentVersion[]> {
    await this.getDocument(actor, documentId);
    return this.storage.listVersions(documentId);
  }

  async getVersion(actor: ActorContext, documentId: string, revision: number): Promise<DocumentVersion | null> {
    await this.getDocument(actor, documentId);
    return this.storage.getVersion(documentId, revision);
  }

  async restoreVersion(
    actor: ActorContext,
    documentId: string,
    targetRevision: number,
  ): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "restore");
    const current = await this.getDocument(actor, documentId);
    const target = await this.storage.getVersion(documentId, targetRevision);
    if (!target) {
      throw new DocumentEngineError(
        404,
        "VERSION_NOT_FOUND",
        `Revision ${targetRevision} was not found for document '${documentId}'.`,
      );
    }

    const now = new Date().toISOString();
    const restoredSnapshot: StudioDocument = {
      ...structuredClone(target.snapshot),
      revision: current.revision + 1,
      updatedAt: now,
    };

    const newVersion: DocumentVersion = {
      versionId: `ver_${randomUUID()}`,
      documentId,
      revision: restoredSnapshot.revision,
      snapshot: restoredSnapshot,
      summary: `Restored content from revision ${targetRevision} as new revision ${restoredSnapshot.revision}`,
      source: "restore",
      actorId: actor.userId,
      restoredFromRevision: targetRevision,
      createdAt: now,
    };

    await this.storage.saveDocumentVersion(newVersion);
    this.recordAudit({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      documentId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: "restore",
      action: "document.version_restored",
      outcome: "success",
      revisionBefore: current.revision,
      revisionAfter: restoredSnapshot.revision,
      summary: newVersion.summary,
    });
    return restoredSnapshot;
  }

  async exportDocx(actor: ActorContext, documentId: string): Promise<{ buffer: Buffer; filename: string }> {
    assertCanPerform(actor, "export", "export");
    const doc = await this.getDocument(actor, documentId);
    const buffer = await exportToDocxBuffer(doc);
    this.recordAudit({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      documentId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: "export",
      action: "document.exported_docx",
      outcome: "success",
      revisionBefore: doc.revision,
      revisionAfter: doc.revision,
      summary: `Exported DOCX snapshot (${buffer.byteLength} bytes).`,
    });
    return { buffer, filename: `${doc.documentId}-rev${doc.revision}.docx` };
  }

  async importDocx(
    actor: ActorContext,
    filename: string,
    buffer: Uint8Array,
  ): Promise<{ document: StudioDocument; diagnostics: ImportDiagnostics }> {
    assertCanPerform(actor, "document", "create");
    const storedOriginal = await this.storage.saveOriginalBinary(buffer, "docx");

    try {
      const { document, diagnostics } = await importFromDocxBuffer({
        buffer,
        filename,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
      });

      const version: DocumentVersion = {
        versionId: `ver_${randomUUID()}`,
        documentId: document.documentId,
        revision: 1,
        snapshot: document,
        summary: `Imported DOCX '${filename}' (SHA-256 ${storedOriginal.sha256.slice(0, 12)})`,
        source: "import",
        actorId: actor.userId,
        createdAt: document.createdAt,
      };
      await this.storage.saveDocumentVersion(version);

      this.recordAudit({
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId: document.documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "import",
        action: "document.imported_docx",
        outcome: "success",
        revisionAfter: 1,
        summary: `Imported DOCX '${filename}' with ${diagnostics.unsupportedFeatures.length} unsupported-feature notices.`,
        metadata: {
          originalSha256: storedOriginal.sha256,
          unsupportedFeatures: diagnostics.unsupportedFeatures,
        },
      });
      return { document, diagnostics };
    } catch (error) {
      this.recordAudit({
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "import",
        action: "document.import_rejected",
        outcome: "denied",
        summary: `Rejected DOCX import '${filename}': ${error instanceof Error ? error.message : "unknown error"}`,
        metadata: { originalSha256: storedOriginal.sha256 },
      });
      throw error;
    }
  }

  async exportPdf(actor: ActorContext, documentId: string): Promise<PdfExportResult & { filename: string }> {
    assertCanPerform(actor, "export", "export");
    const doc = await this.getDocument(actor, documentId);
    const result = await exportToPdfBuffer(doc);
    this.recordAudit({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      documentId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: "export",
      action: "document.exported_pdf",
      outcome: "success",
      revisionBefore: doc.revision,
      revisionAfter: doc.revision,
      summary: `Exported searchable PDF via ${result.engine} (${result.pdfBuffer.byteLength} bytes).`,
    });
    return { ...result, filename: `${doc.documentId}-rev${doc.revision}.pdf` };
  }

  async listAuditEvents(actor: ActorContext, documentId: string): Promise<AuditEvent[]> {
    await this.getDocument(actor, documentId);
    assertCanPerform(actor, "audit", "read");
    return this.audit.listForDocument(actor.tenantId, actor.workspaceId, documentId);
  }
}
