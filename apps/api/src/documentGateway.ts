import { createHash, randomUUID } from "node:crypto";
import type {
  ActorContext,
  AuditEvent,
  DocumentOperationProposal,
  DocumentVersion,
  ImportDiagnostics,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import type { AuditStore } from "@ai-office-suite/audit";
import { assertCanPerform, assertPolicyAllowed } from "@ai-office-suite/authorization";
import { PostgreSqlDocumentRepository } from "@ai-office-suite/database";
import type { DocumentStorageAdapter } from "@ai-office-suite/storage";
import {
  createEmptyDocument,
  normalizeDocumentText,
  previewDocumentOperation,
  resolveUndoTargetRevision,
} from "@ai-office-suite/document-engine";
import {
  DocxImportError,
  exportToDocxBuffer,
  exportToPdfBuffer,
  importFromDocxBuffer,
} from "@ai-office-suite/file-conversion";
import { buildBilingualSampleDocument, DocumentService } from "@ai-office-suite/documents-module";
import {
  AiDocumentExecutor,
  AiPlanningError,
  isUndoCommandIntent,
  planDocumentOperation,
  verifyDocumentProposalSignature,
  type ApplyProposalResult,
  type PlanCommandInput,
} from "@ai-office-suite/ai-module";
import type { IsolatedParserWorkerClient } from "@ai-office-suite/workers";

export type ListDocumentsFilter = Parameters<PostgreSqlDocumentRepository["listDocumentsFiltered"]>[1];
export type ListDocumentsPage = Awaited<ReturnType<PostgreSqlDocumentRepository["listDocumentsFiltered"]>>;
type PgAuditRecordInput = Parameters<PostgreSqlDocumentRepository["recordAudit"]>[1];

export interface DocumentGatewayAuditInput {
  tenantId: string;
  workspaceId: string;
  documentId?: string;
  actorId: string;
  actorRole: ActorContext["role"];
  source: AuditEvent["source"];
  action: string;
  outcome: AuditEvent["outcome"];
  targetType?: string;
  revisionBefore?: number;
  revisionAfter?: number;
  operationId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface CreateDocumentGatewayInput {
  title: string;
  language?: "en" | "km" | "bilingual";
  layout?: StudioDocument["layout"];
  blocks?: StudioDocument["blocks"];
}

export interface UpdateDocumentGatewayInput {
  expectedRevision: number;
  title?: string;
  language?: "en" | "km" | "bilingual";
  layout?: StudioDocument["layout"];
  blocks: StudioDocument["blocks"];
  summary?: string;
}

export interface DocumentGateway {
  listDocuments(actor: ActorContext, filter: ListDocumentsFilter): Promise<ListDocumentsPage>;
  createDocument(actor: ActorContext, input: CreateDocumentGatewayInput): Promise<StudioDocument>;
  seedBilingualFixture(actor: ActorContext): Promise<StudioDocument>;
  getDocument(actor: ActorContext, documentId: string): Promise<StudioDocument>;
  updateDocument(actor: ActorContext, documentId: string, input: UpdateDocumentGatewayInput): Promise<StudioDocument>;
  listVersions(actor: ActorContext, documentId: string, options?: { limit?: number; offset?: number; order?: "asc" | "desc" }): Promise<DocumentVersion[]>;
  listVersionsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
  ): Promise<{ versions: DocumentVersion[]; total: number; hasMore: boolean }>;
  getVersionsForDiff(
    actor: ActorContext,
    documentId: string,
    fromRev: number,
    toRev: number,
  ): Promise<{ fromDoc: StudioDocument | null; toDoc: StudioDocument | null }>;
  restoreVersion(
    actor: ActorContext,
    documentId: string,
    revision: number,
    options?: { expectedRevision?: number },
  ): Promise<StudioDocument>;
  planAiOperation(actor: ActorContext, documentId: string, input: PlanCommandInput): Promise<DocumentOperationProposal>;
  applyAiOperation(
    actor: ActorContext,
    documentId: string,
    proposal: DocumentOperationProposal,
    approved: boolean,
  ): Promise<ApplyProposalResult>;
  importDocx(
    actor: ActorContext,
    filename: string,
    buffer: Buffer,
  ): Promise<{ document: StudioDocument; diagnostics: ImportDiagnostics }>;
  exportDocx(actor: ActorContext, documentId: string): Promise<{ buffer: Buffer; filename: string }>;
  exportPdf(actor: ActorContext, documentId: string): Promise<{ pdfBuffer: Buffer; filename: string; engine: string }>;
  listAuditEvents(actor: ActorContext, documentId: string, options?: { limit?: number; offset?: number }): Promise<AuditEvent[]>;
  listAuditEventsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ events: AuditEvent[]; total: number; hasMore: boolean }>;
  recordAudit(actor: ActorContext, entry: DocumentGatewayAuditInput): Promise<void>;
}

export class PgDocumentGateway implements DocumentGateway {
  private readonly pgRepo: PostgreSqlDocumentRepository;
  private readonly parserWorker?: IsolatedParserWorkerClient;

  constructor(
    pgRepo: PostgreSqlDocumentRepository,
    options?: { parserWorker?: IsolatedParserWorkerClient },
  ) {
    this.pgRepo = pgRepo;
    this.parserWorker = options?.parserWorker;
  }

  listDocuments(actor: ActorContext, filter: ListDocumentsFilter): Promise<ListDocumentsPage> {
    return this.pgRepo.listDocumentsFiltered(actor, filter);
  }

  async createDocument(actor: ActorContext, input: CreateDocumentGatewayInput): Promise<StudioDocument> {
    const doc = createEmptyDocument({
      documentId: randomUUID(),
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      title: input.title,
      language: input.language,
      createdBy: actor.userId,
    });
    if (input.layout) doc.layout = input.layout;
    // Consistent blocks: [] handling across PG and local modes (M8)
    if (input.blocks && input.blocks.length > 0) doc.blocks = input.blocks;
    return this.pgRepo.createDocument(actor, doc);
  }

  async seedBilingualFixture(actor: ActorContext): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "create");
    // Build sample purely in-memory with zero ghost writes to local storage/audit (H13)
    const pgDoc = buildBilingualSampleDocument(actor, randomUUID());
    return this.pgRepo.createDocument(actor, pgDoc, {
      source: "manual",
      action: "document.created",
      summary: `Seeded bilingual fixture '${pgDoc.title}'.`,
    });
  }

  getDocument(actor: ActorContext, documentId: string): Promise<StudioDocument> {
    return this.pgRepo.getDocument(actor, documentId);
  }

  updateDocument(actor: ActorContext, documentId: string, input: UpdateDocumentGatewayInput): Promise<StudioDocument> {
    return this.pgRepo.updateDocument(
      actor,
      documentId,
      input.expectedRevision,
      (current, nextRevision): StudioDocument => ({
        ...current,
        title: input.title ? normalizeDocumentText(input.title) : current.title,
        language: input.language ?? current.language,
        layout: input.layout ?? current.layout,
        blocks: input.blocks,
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
      }),
      {
        source: "manual",
        action: "document.updated",
        summary: input.summary ?? undefined,
      },
    );
  }

  listVersions(actor: ActorContext, documentId: string, options?: { limit?: number; offset?: number; order?: "asc" | "desc" }): Promise<DocumentVersion[]> {
    return this.pgRepo.listVersions(actor, documentId, options);
  }

  listVersionsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
  ): Promise<{ versions: DocumentVersion[]; total: number; hasMore: boolean }> {
    return this.pgRepo.listVersionsPage(actor, documentId, options);
  }

  getVersionsForDiff(
    actor: ActorContext,
    documentId: string,
    fromRev: number,
    toRev: number,
  ): Promise<{ fromDoc: StudioDocument | null; toDoc: StudioDocument | null }> {
    return this.pgRepo.getVersionsForDiff(actor, documentId, fromRev, toRev);
  }

  restoreVersion(
    actor: ActorContext,
    documentId: string,
    revision: number,
    options?: { expectedRevision?: number },
  ): Promise<StudioDocument> {
    return this.pgRepo.restoreVersion(actor, documentId, revision, options);
  }

  async planAiOperation(
    actor: ActorContext,
    documentId: string,
    input: PlanCommandInput,
  ): Promise<DocumentOperationProposal> {
    assertCanPerform(actor, "document", "write");
    const doc = await this.pgRepo.getDocument(actor, documentId);
    let priorSnapshot: StudioDocument | null = null;
    if (doc.revision > 1 && isUndoCommandIntent(input.command)) {
      priorSnapshot = await this.pgRepo.getUndoTargetSnapshot(actor, doc.documentId);
    }

    // Capture planner audit events so jwt-pg mode persists EVERY plan & prompt-injection denial to PostgreSQL (H13)
    const capturedEvents: AuditEvent[] = [];
    const planAuditSink: AuditStore = {
      append: (ev) => capturedEvents.push(ev),
      listAll: () => [],
      listForDocument: () => [],
    };

    const flushCaptured = async (): Promise<void> => {
      for (const ev of capturedEvents) {
        await this.pgRepo.recordAudit(actor, {
          tenantId: ev.tenantId,
          workspaceId: ev.workspaceId,
          documentId: ev.documentId,
          actorId: ev.actorId,
          actorRole: ev.actorRole,
          source: ev.source,
          action: ev.action,
          outcome: ev.outcome,
          revisionBefore: ev.revisionBefore,
          revisionAfter: ev.revisionAfter,
          summary: ev.summary,
          metadata: ev.operationId ? { operationId: ev.operationId, ...(ev.metadata ?? {}) } : ev.metadata,
        });
      }
    };

    try {
      const proposal = planDocumentOperation({
        actor,
        document: doc,
        priorRevisionDoc: priorSnapshot,
        input,
        audit: planAuditSink,
      });
      await flushCaptured();
      return proposal;
    } catch (planErr) {
      await flushCaptured();
      throw planErr;
    }
  }

  async applyAiOperation(
    actor: ActorContext,
    documentId: string,
    proposal: DocumentOperationProposal,
    approved: boolean,
  ): Promise<ApplyProposalResult> {
    assertCanPerform(actor, "ai_assistant", "apply_ai");
    assertCanPerform(actor, "document", "write");
    if (!approved) {
      await this.pgRepo.recordAudit(actor, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: proposal.source,
        action: "ai.operation_unapproved",
        outcome: "denied",
        summary: `Rejected unapproved operation ${proposal.action}.`,
        metadata: { operationId: proposal.operationId },
      });
      throw new AiPlanningError(
        400,
        "APPROVAL_REQUIRED",
        "Explicit user approval is required before applying an AI or voice operation.",
      );
    }
    if (!verifyDocumentProposalSignature(actor, proposal)) {
      await this.pgRepo.recordAudit(actor, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: proposal.source,
        action: "ai.operation_tampered_signature",
        outcome: "denied",
        summary: `Rejected AI proposal '${proposal.operationId}' with missing or invalid server HMAC signature.`,
        metadata: { operationId: proposal.operationId },
      });
      throw new AiPlanningError(
        400,
        "INVALID_PROPOSAL_SIGNATURE",
        "Proposal signature verification denied: missing, tampered, or cross-tenant signature. Re-plan through /ai/plan before applying.",
      );
    }
    return this.pgRepo.applyAiOperationIdempotent({
      actor,
      documentId,
      operationId: proposal.operationId,
      expectedRevision: proposal.expectedRevision,
      source: proposal.source === "voice_command" ? "voice_command" : "typed_ai",
      loadPriorForUndo: proposal.action === "undo_last",
      buildNext: (currentDoc, priorSnapshot, nextRevision) => {
        const { nextDoc, preview } = previewDocumentOperation(currentDoc, proposal, priorSnapshot);
        return {
          updatedDoc: { ...nextDoc, revision: nextRevision },
          summary: `[${proposal.source}] ${proposal.action}: ${preview.summary}`,
        };
      },
    });
  }

  async importDocx(
    actor: ActorContext,
    filename: string,
    buffer: Buffer,
  ): Promise<{ document: StudioDocument; diagnostics: ImportDiagnostics }> {
    assertCanPerform(actor, "document", "create");
    let importedResult: Awaited<ReturnType<typeof importFromDocxBuffer>>;
    try {
      importedResult = this.parserWorker
        ? await this.parserWorker.parseDocx({
            buffer,
            filename,
            tenantId: actor.tenantId,
            workspaceId: actor.workspaceId,
            actorId: actor.userId,
          })
        : await importFromDocxBuffer({
            buffer,
            filename,
            tenantId: actor.tenantId,
            workspaceId: actor.workspaceId,
            actorId: actor.userId,
          });
    } catch (importErr) {
      if (importErr instanceof DocxImportError) {
        await this.pgRepo.recordAudit(actor, {
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          actorRole: actor.role,
          source: "import",
          action: "document.import_docx_rejected",
          outcome: "denied",
          targetType: "import",
          summary: `Rejected DOCX upload '${filename}' (${importErr.code}): ${importErr.message}`,
          metadata: { code: importErr.code, filename },
        });
      }
      throw importErr;
    }
    const { document, diagnostics } = importedResult;
    const pgDoc: StudioDocument = { ...document, documentId: randomUUID() };
    const created = await this.pgRepo.createDocument(actor, pgDoc, {
      source: "import",
      action: "document.imported_docx",
      summary: `Imported DOCX '${filename}' (SHA-256 ${diagnostics.originalSha256.slice(0, 12)}).`,
    });
    return { document: created, diagnostics };
  }

  async exportDocx(actor: ActorContext, documentId: string): Promise<{ buffer: Buffer; filename: string }> {
    assertCanPerform(actor, "export", "export");
    const doc = await this.pgRepo.getDocument(actor, documentId);
    const buffer = await exportToDocxBuffer(doc);
    await this.pgRepo.recordAudit(actor, {
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
    return { buffer, filename: `${doc.documentId}-rev${doc.revision}.docx` };
  }

  async exportPdf(
    actor: ActorContext,
    documentId: string,
  ): Promise<{ pdfBuffer: Buffer; filename: string; engine: string }> {
    assertCanPerform(actor, "export", "export");
    const doc = await this.pgRepo.getDocument(actor, documentId);
    const result = this.parserWorker
      ? await this.parserWorker.renderPdf(doc)
      : await exportToPdfBuffer(doc);
    await this.pgRepo.recordAudit(actor, {
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
    return {
      pdfBuffer: result.pdfBuffer,
      filename: `${doc.documentId}-rev${doc.revision}.pdf`,
      engine: result.engine,
    };
  }

  listAuditEvents(actor: ActorContext, documentId: string, options?: { limit?: number; offset?: number }): Promise<AuditEvent[]> {
    return this.pgRepo.listAuditEvents(actor, documentId, options);
  }

  listAuditEventsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ events: AuditEvent[]; total: number; hasMore: boolean }> {
    return this.pgRepo.listAuditEventsPage(actor, documentId, options);
  }

  async recordAudit(actor: ActorContext, entry: DocumentGatewayAuditInput): Promise<void> {
    const record: PgAuditRecordInput = {
      tenantId: entry.tenantId,
      workspaceId: entry.workspaceId,
      documentId: entry.documentId,
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      source: entry.source,
      action: entry.action,
      outcome: entry.outcome,
      targetType: entry.targetType,
      revisionBefore: entry.revisionBefore,
      revisionAfter: entry.revisionAfter,
      summary: entry.summary,
      metadata: entry.operationId ? { operationId: entry.operationId, ...(entry.metadata ?? {}) } : entry.metadata,
    };
    await this.pgRepo.recordAudit(actor, record);
  }
}

export class LocalDocumentGateway implements DocumentGateway {
  private readonly documents: DocumentService;
  private readonly aiExecutor: AiDocumentExecutor;
  private readonly audit: AuditStore;
  private readonly storage?: DocumentStorageAdapter;
  private readonly parserWorker?: IsolatedParserWorkerClient;

  constructor(
    documents: DocumentService,
    aiExecutor: AiDocumentExecutor,
    audit: AuditStore,
    options?: {
      storage?: DocumentStorageAdapter;
      parserWorker?: IsolatedParserWorkerClient;
    },
  ) {
    this.documents = documents;
    this.aiExecutor = aiExecutor;
    this.audit = audit;
    this.storage = options?.storage;
    this.parserWorker = options?.parserWorker;
  }

  listDocuments(actor: ActorContext, filter: ListDocumentsFilter): Promise<ListDocumentsPage> {
    return this.documents.listDocumentsFiltered(actor, filter);
  }

  createDocument(actor: ActorContext, input: CreateDocumentGatewayInput): Promise<StudioDocument> {
    return this.documents.createDocument(actor, input);
  }

  seedBilingualFixture(actor: ActorContext): Promise<StudioDocument> {
    return this.documents.seedBilingualSample(actor);
  }

  getDocument(actor: ActorContext, documentId: string): Promise<StudioDocument> {
    return this.documents.getDocument(actor, documentId);
  }

  updateDocument(actor: ActorContext, documentId: string, input: UpdateDocumentGatewayInput): Promise<StudioDocument> {
    return this.documents.updateDocument(actor, documentId, input);
  }

  listVersions(actor: ActorContext, documentId: string, options?: { limit?: number; offset?: number; order?: "asc" | "desc" }): Promise<DocumentVersion[]> {
    return this.documents.listVersions(actor, documentId, options);
  }

  listVersionsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
  ): Promise<{ versions: DocumentVersion[]; total: number; hasMore: boolean }> {
    return this.documents.listVersionsPage(actor, documentId, options);
  }

  async getVersionsForDiff(
    actor: ActorContext,
    documentId: string,
    fromRev: number,
    toRev: number,
  ): Promise<{ fromDoc: StudioDocument | null; toDoc: StudioDocument | null }> {
    const fromVer = await this.documents.getVersion(actor, documentId, fromRev);
    const toVer = await this.documents.getVersion(actor, documentId, toRev);
    return {
      fromDoc: fromVer?.snapshot ?? null,
      toDoc: toVer?.snapshot ?? null,
    };
  }

  restoreVersion(
    actor: ActorContext,
    documentId: string,
    revision: number,
    options?: { expectedRevision?: number },
  ): Promise<StudioDocument> {
    return this.documents.restoreVersion(actor, documentId, revision, options);
  }

  async planAiOperation(
    actor: ActorContext,
    documentId: string,
    input: PlanCommandInput,
  ): Promise<DocumentOperationProposal> {
    assertCanPerform(actor, "document", "write");
    const doc = await this.documents.getDocument(actor, documentId);
    let priorSnapshot: StudioDocument | null = null;
    if (doc.revision > 1 && isUndoCommandIntent(input.command)) {
      const versions = await this.documents.listVersions(actor, doc.documentId);
      const undoTarget = resolveUndoTargetRevision(versions);
      if (undoTarget !== null) {
        priorSnapshot = versions.find((v) => v.revision === undoTarget)?.snapshot ?? null;
      }
    }
    return planDocumentOperation({
      actor,
      document: doc,
      priorRevisionDoc: priorSnapshot,
      input,
      audit: this.audit,
    });
  }

  applyAiOperation(
    actor: ActorContext,
    _documentId: string,
    proposal: DocumentOperationProposal,
    approved: boolean,
  ): Promise<ApplyProposalResult> {
    return this.aiExecutor.applyProposal({ actor, proposal, approved });
  }

  async importDocx(
    actor: ActorContext,
    filename: string,
    buffer: Buffer,
  ): Promise<{ document: StudioDocument; diagnostics: ImportDiagnostics }> {
    if (!this.parserWorker || !this.storage) {
      return this.documents.importDocx(actor, filename, buffer);
    }
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "create",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    const rawSha256 = createHash("sha256").update(buffer).digest("hex");
    try {
      const { document, diagnostics } = await this.parserWorker.parseDocx({
        buffer,
        filename,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
      });
      const storedOriginal = await this.storage.saveOriginalBinary(buffer, "docx");
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
      await this.recordAudit(actor, {
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
      await this.recordAudit(actor, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "import",
        action: "document.import_rejected",
        outcome: "denied",
        summary: `Rejected DOCX import '${filename}': ${error instanceof Error ? error.message : "unknown error"}`,
        metadata: { originalSha256: rawSha256 },
      });
      throw error;
    }
  }

  exportDocx(actor: ActorContext, documentId: string): Promise<{ buffer: Buffer; filename: string }> {
    return this.documents.exportDocx(actor, documentId);
  }

  async exportPdf(
    actor: ActorContext,
    documentId: string,
  ): Promise<{ pdfBuffer: Buffer; filename: string; engine: string }> {
    if (!this.parserWorker) {
      return this.documents.exportPdf(actor, documentId);
    }
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "export",
      action: "export",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    const doc = await this.documents.getDocument(actor, documentId);
    const result = await this.parserWorker.renderPdf(doc);
    await this.recordAudit(actor, {
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
    return {
      pdfBuffer: result.pdfBuffer,
      filename: `${doc.documentId}-rev${doc.revision}.pdf`,
      engine: result.engine,
    };
  }

  listAuditEvents(actor: ActorContext, documentId: string, options?: { limit?: number; offset?: number }): Promise<AuditEvent[]> {
    return this.documents.listAuditEvents(actor, documentId, options);
  }

  listAuditEventsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ events: AuditEvent[]; total: number; hasMore: boolean }> {
    return this.documents.listAuditEventsPage(actor, documentId, options);
  }

  async recordAudit(_actor: ActorContext, entry: DocumentGatewayAuditInput): Promise<void> {
    this.audit.append({
      auditId: `aud_${randomUUID()}`,
      tenantId: entry.tenantId,
      workspaceId: entry.workspaceId,
      documentId: entry.documentId,
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      source: entry.source,
      action: entry.action,
      outcome: entry.outcome,
      revisionBefore: entry.revisionBefore,
      revisionAfter: entry.revisionAfter,
      operationId: entry.operationId,
      summary: entry.summary,
      metadata: entry.metadata,
      createdAt: new Date().toISOString(),
    });
  }
}
