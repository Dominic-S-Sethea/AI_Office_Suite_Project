import { randomUUID } from "node:crypto";
import type {
  ActorContext,
  DocumentOperationProposal,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import { assertCanPerform } from "@ai-office-suite/authorization";
import type { AuditStore } from "@ai-office-suite/audit";
import { previewDocumentOperation, resolveUndoTargetRevision } from "@ai-office-suite/document-engine";
import type { DocumentService } from "@ai-office-suite/documents-module";
import { AiPlanningError, verifyDocumentProposalSignature } from "./planner.ts";

export interface ApplyProposalResult {
  document: StudioDocument;
  deduplicated: boolean;
  appliedOperationId: string;
}

export class AiDocumentExecutor {
  private readonly documents: DocumentService;
  private readonly audit: AuditStore;
  private readonly appliedOperations = new Map<string, StudioDocument>();

  constructor(documents: DocumentService, audit: AuditStore) {
    this.documents = documents;
    this.audit = audit;
  }

  async applyProposal(params: {
    actor: ActorContext;
    proposal: DocumentOperationProposal;
    approved: boolean;
  }): Promise<ApplyProposalResult> {
    const { actor, proposal, approved } = params;

    // Voice commands and typed AI commands pass through the exact same backend authorization gate.
    assertCanPerform(actor, "ai_assistant", "apply_ai");
    assertCanPerform(actor, "document", "write");

    if (!approved) {
      this.audit.append({
        auditId: `aud_${randomUUID()}`,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId: proposal.documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: proposal.source,
        action: "ai.operation_unapproved",
        outcome: "denied",
        operationId: proposal.operationId,
        summary: `Rejected unapproved operation ${proposal.action}.`,
        createdAt: new Date().toISOString(),
      });
      throw new AiPlanningError(
        400,
        "APPROVAL_REQUIRED",
        "Explicit user approval is required before applying an AI or voice operation.",
      );
    }

    // Verify HMAC signature issued by server planner (H16 — blocks forged/tampered proposals)
    if (!verifyDocumentProposalSignature(actor, proposal)) {
      this.audit.append({
        auditId: `aud_${randomUUID()}`,
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId: proposal.documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: proposal.source,
        action: "ai.operation_tampered_signature",
        outcome: "denied",
        operationId: proposal.operationId,
        summary: `Rejected AI proposal '${proposal.operationId}' with missing or invalid server HMAC signature.`,
        createdAt: new Date().toISOString(),
      });
      throw new AiPlanningError(
        400,
        "INVALID_PROPOSAL_SIGNATURE",
        "Proposal signature verification denied: missing, tampered, or cross-tenant signature. Re-plan through /ai/plan before applying.",
      );
    }

    // Tenant/workspace/document-scoped idempotency guard preventing cross-tenant BOLA leaks (D4.05 / AI-07)
    const idempotencyCacheKey = `${actor.tenantId}::${actor.workspaceId}::${proposal.documentId}::${proposal.operationId}`;
    const cached = this.appliedOperations.get(idempotencyCacheKey);
    if (cached) {
      return {
        document: structuredClone(cached),
        deduplicated: true,
        appliedOperationId: proposal.operationId,
      };
    }

    const currentDoc = await this.documents.getDocument(actor, proposal.documentId);
    let priorVersion = null;
    if (proposal.action === "undo_last" && currentDoc.revision > 1) {
      const versions = await this.documents.listVersions(actor, proposal.documentId);
      const targetRev = resolveUndoTargetRevision(versions);
      if (targetRev !== null) {
        priorVersion = versions.find((v) => v.revision === targetRev) ?? null;
      }
    }

    const { nextDoc, preview } = previewDocumentOperation(
      currentDoc,
      proposal,
      priorVersion?.snapshot ?? null,
    );

    const saved = await this.documents.updateDocument(actor, proposal.documentId, {
      expectedRevision: proposal.expectedRevision,
      title: nextDoc.title,
      language: nextDoc.language,
      layout: nextDoc.layout,
      blocks: nextDoc.blocks,
      summary: `[${proposal.source}] ${proposal.action}: ${preview.summary}`,
      source: proposal.source === "voice_command" ? "voice_command" : "typed_ai",
      operationId: proposal.operationId,
      ...(proposal.action === "undo_last" && priorVersion
        ? { undoneRevision: currentDoc.revision, restoredFromRevision: priorVersion.revision }
        : {}),
    });

    if (this.appliedOperations.size >= 1000) {
      const oldest = this.appliedOperations.keys().next().value;
      if (oldest !== undefined) this.appliedOperations.delete(oldest);
    }
    this.appliedOperations.set(idempotencyCacheKey, structuredClone(saved));
    return {
      document: saved,
      deduplicated: false,
      appliedOperationId: proposal.operationId,
    };
  }
}
