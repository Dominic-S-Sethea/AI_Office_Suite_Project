import { createHash, randomUUID } from "node:crypto";
import type { ActorContext, AuditEvent, StudioDocument } from "@ai-office-suite/shared-contracts";
import { assertCanPerform, assertTenantWorkspaceAccess } from "@ai-office-suite/authorization";
import type { PgDatabaseAdapter, PgQueryExecutor } from "./adapter.ts";
import { withTenantTransaction } from "./schema.ts";

export class DatabaseConflictError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "DatabaseConflictError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class PostgreSqlDocumentRepository {
  private readonly db: PgDatabaseAdapter;

  constructor(db: PgDatabaseAdapter) {
    this.db = db;
  }

  private async insertAuditTx(tx: PgQueryExecutor, event: Omit<AuditEvent, "auditId" | "createdAt">): Promise<void> {
    await tx.query(
      `INSERT INTO audit_logs (
         audit_id, tenant_id, workspace_id, actor_id, actor_role, source, action, outcome,
         target_type, target_id, revision_before, revision_after, summary
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        randomUUID(),
        event.tenantId,
        event.workspaceId,
        event.actorId,
        event.actorRole,
        event.source,
        event.action,
        event.outcome,
        "document",
        event.documentId ?? "none",
        event.revisionBefore ?? null,
        event.revisionAfter ?? null,
        event.summary,
      ],
    );
  }

  async createDocument(actor: ActorContext, doc: StudioDocument): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "create");
    assertTenantWorkspaceAccess(actor, doc.tenantId, doc.workspaceId);

    const contentSha = createHash("sha256").update(JSON.stringify(doc)).digest("hex");
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO documents (
           tenant_id, workspace_id, document_id, title, language, current_revision, status, created_by, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 1, $6, $7::uuid, $8::timestamptz, $9::timestamptz)`,
        [
          doc.tenantId,
          doc.workspaceId,
          doc.documentId,
          doc.title,
          doc.language,
          doc.status,
          doc.createdBy,
          doc.createdAt,
          doc.updatedAt,
        ],
      );

      await tx.query(
        `INSERT INTO document_versions (
           tenant_id, document_id, revision, storage_object_key, content_sha256,
           source_import_sha256, snapshot_json, created_by
         ) VALUES ($1::uuid, $2::uuid, 1, $3, $4, $5, $6::jsonb, $7::uuid)`,
        [
          doc.tenantId,
          doc.documentId,
          `${doc.tenantId}/${doc.workspaceId}/documents/${doc.documentId}/rev-1.json`,
          contentSha,
          doc.sourceImportSha256 ?? null,
          JSON.stringify(doc),
          actor.userId,
        ],
      );

      await this.insertAuditTx(tx, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId: doc.documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "manual",
        action: "document.create",
        outcome: "success",
        revisionAfter: 1,
        summary: `Created PostgreSQL document '${doc.title}'`,
      });

      return structuredClone(doc);
    });
  }

  async listDocuments(actor: ActorContext): Promise<StudioDocument[]> {
    assertCanPerform(actor, "document", "read");
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const res = await tx.query<{ snapshot_json: StudioDocument }>(
        `SELECT v.snapshot_json
         FROM documents d
         JOIN document_versions v
           ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = d.current_revision
         WHERE d.workspace_id = $1::uuid
         ORDER BY d.updated_at DESC`,
        [actor.workspaceId],
      );
      return res.rows.map((r) =>
        typeof r.snapshot_json === "string" ? (JSON.parse(r.snapshot_json) as StudioDocument) : r.snapshot_json,
      );
    });
  }

  async getDocument(actor: ActorContext, documentId: string): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "read");
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const res = await tx.query<{ snapshot_json: StudioDocument; workspace_id: string }>(
        `SELECT d.workspace_id, v.snapshot_json
         FROM documents d
         JOIN document_versions v
           ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = d.current_revision
         WHERE d.document_id = $1::uuid`,
        [documentId],
      );
      const row = res.rows[0];
      if (!row) {
        throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
      }
      assertTenantWorkspaceAccess(actor, actor.tenantId, row.workspace_id);
      return typeof row.snapshot_json === "string" ? (JSON.parse(row.snapshot_json) as StudioDocument) : row.snapshot_json;
    });
  }

  /**
   * Optimistic concurrency update inside one PostgreSQL RLS transaction:
   * inserts the next immutable version row, updates the version pointer ONLY if
   * `current_revision = expectedRevision` (`rowCount === 1`), else rolls back -> 409.
   */
  async updateDocument(
    actor: ActorContext,
    documentId: string,
    expectedRevision: number,
    buildNext: (current: StudioDocument, nextRevision: number) => StudioDocument,
  ): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "write");
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const curRes = await tx.query<{ workspace_id: string; current_revision: number; snapshot_json: StudioDocument }>(
        `SELECT d.workspace_id, d.current_revision, v.snapshot_json
         FROM documents d
         JOIN document_versions v
           ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = d.current_revision
         WHERE d.document_id = $1::uuid
         FOR UPDATE OF d`,
        [documentId],
      );
      const row = curRes.rows[0];
      if (!row) {
        throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
      }
      assertTenantWorkspaceAccess(actor, actor.tenantId, row.workspace_id);
      if (row.current_revision !== expectedRevision) {
        throw new DatabaseConflictError(
          409,
          "REVISION_CONFLICT",
          `Expected revision ${expectedRevision}, but current PostgreSQL revision is ${row.current_revision}.`,
        );
      }

      const currentDoc =
        typeof row.snapshot_json === "string" ? (JSON.parse(row.snapshot_json) as StudioDocument) : row.snapshot_json;
      const nextRevision = expectedRevision + 1;
      const updatedDoc = buildNext(currentDoc, nextRevision);
      const contentSha = createHash("sha256").update(JSON.stringify(updatedDoc)).digest("hex");

      const updateRes = await tx.query(
        `UPDATE documents
         SET title = $1, language = $2, current_revision = $3, status = $4, updated_at = $5::timestamptz
         WHERE tenant_id = $6::uuid AND document_id = $7::uuid AND current_revision = $8`,
        [
          updatedDoc.title,
          updatedDoc.language,
          nextRevision,
          updatedDoc.status,
          updatedDoc.updatedAt,
          actor.tenantId,
          documentId,
          expectedRevision,
        ],
      );
      if (updateRes.rowCount !== 1) {
        throw new DatabaseConflictError(409, "REVISION_CONFLICT", "Concurrent revision update conflict.");
      }

      await tx.query(
        `INSERT INTO document_versions (
           tenant_id, document_id, revision, storage_object_key, content_sha256, snapshot_json, created_by
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid)`,
        [
          actor.tenantId,
          documentId,
          nextRevision,
          `${actor.tenantId}/${actor.workspaceId}/documents/${documentId}/rev-${nextRevision}.json`,
          contentSha,
          JSON.stringify(updatedDoc),
          actor.userId,
        ],
      );

      await this.insertAuditTx(tx, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "manual",
        action: "document.update",
        outcome: "success",
        revisionBefore: expectedRevision,
        revisionAfter: nextRevision,
        summary: `Updated PostgreSQL document to revision ${nextRevision}`,
      });

      return structuredClone(updatedDoc);
    });
  }
}
