import { createHash, randomUUID } from "node:crypto";
import type {
  ActorContext,
  AuditEvent,
  DocumentVersion,
  StudioDocument,
  WorkspaceRole,
} from "@ai-office-suite/shared-contracts";
import { assertCanPerform, assertTenantWorkspaceAccess, isWorkspaceRole } from "@ai-office-suite/authorization";
import type { PgDatabaseAdapter, PgQueryExecutor } from "./adapter.ts";
import { withTenantTransaction } from "./schema.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function parseSnapshot(raw: StudioDocument | string): StudioDocument {
  return typeof raw === "string" ? (JSON.parse(raw) as StudioDocument) : raw;
}

function assertValidDocumentUuid(documentId: string): void {
  if (!UUID_PATTERN.test(documentId)) {
    throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
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

  async recordAudit(actor: ActorContext, event: Omit<AuditEvent, "auditId" | "createdAt">): Promise<void> {
    assertTenantWorkspaceAccess(actor, event.tenantId, event.workspaceId);
    await withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      await this.insertAuditTx(tx, event);
    });
  }

  async createDocument(
    actor: ActorContext,
    doc: StudioDocument,
    auditOpts?: { source?: AuditEvent["source"]; action?: string; summary?: string },
  ): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "create");
    assertTenantWorkspaceAccess(actor, doc.tenantId, doc.workspaceId);
    assertValidDocumentUuid(doc.documentId);

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
        source: auditOpts?.source ?? "manual",
        action: auditOpts?.action ?? "document.create",
        outcome: "success",
        revisionAfter: 1,
        summary: auditOpts?.summary ?? `Created PostgreSQL document '${doc.title}'`,
      });

      return structuredClone(doc);
    });
  }

  async listDocuments(actor: ActorContext): Promise<StudioDocument[]> {
    const res = await this.listDocumentsFiltered(actor, { limit: 100, offset: 0 });
    return res.documents;
  }

  async listDocumentsFiltered(
    actor: ActorContext,
    filter: { q?: string; language?: "en" | "km" | "bilingual"; limit?: number; offset?: number } = {},
  ): Promise<{ documents: StudioDocument[]; total: number; limit: number; offset: number }> {
    assertCanPerform(actor, "document", "read");
    const limit = Math.max(1, Math.min(100, Math.trunc(filter.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
    const qTrim = filter.q?.trim();
    const escapedLike = qTrim
      ? `%${qTrim.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      : null;

    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const conditions: string[] = ["d.workspace_id = $1::uuid"];
      const params: unknown[] = [actor.workspaceId];

      if (filter.language) {
        params.push(filter.language);
        conditions.push(`d.language = $${params.length}`);
      }
      if (escapedLike) {
        params.push(escapedLike);
        conditions.push(`d.title ILIKE $${params.length} ESCAPE '\\'`);
      }

      const whereSql = conditions.join(" AND ");
      const countRes = await tx.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM documents d WHERE ${whereSql}`,
        params,
      );
      const total = Number(countRes.rows[0]?.total ?? 0);

      const pageParams = [...params, limit, offset];
      const res = await tx.query<{ snapshot_json: StudioDocument | string }>(
        `SELECT v.snapshot_json
         FROM documents d
         JOIN document_versions v
           ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = d.current_revision
         WHERE ${whereSql}
         ORDER BY d.updated_at DESC
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
      );
      return {
        documents: res.rows.map((r) => parseSnapshot(r.snapshot_json)),
        total,
        limit,
        offset,
      };
    });
  }

  async getDocument(actor: ActorContext, documentId: string): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "read");
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const res = await tx.query<{ snapshot_json: StudioDocument | string; workspace_id: string }>(
        `SELECT d.workspace_id::text, v.snapshot_json
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
      return parseSnapshot(row.snapshot_json);
    });
  }

  async listVersions(actor: ActorContext, documentId: string): Promise<DocumentVersion[]> {
    assertCanPerform(actor, "document", "read");
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const docRes = await tx.query<{ workspace_id: string }>(
        "SELECT workspace_id::text FROM documents WHERE document_id = $1::uuid",
        [documentId],
      );
      const docRow = docRes.rows[0];
      if (!docRow) {
        throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
      }
      assertTenantWorkspaceAccess(actor, actor.tenantId, docRow.workspace_id);

      const verRes = await tx.query<{
        revision: number;
        restored_from_revision: number | null;
        snapshot_json: StudioDocument | string;
        created_by: string;
        created_at: Date | string;
      }>(
        `SELECT revision, restored_from_revision, snapshot_json, created_by::text, created_at
         FROM document_versions
         WHERE document_id = $1::uuid
         ORDER BY revision ASC`,
        [documentId],
      );
      return verRes.rows.map((r) => ({
        versionId: `${documentId}:rev-${r.revision}`,
        documentId,
        revision: r.revision,
        snapshot: parseSnapshot(r.snapshot_json),
        summary:
          r.restored_from_revision !== null
            ? `Restored revision ${r.restored_from_revision} as revision ${r.revision}`
            : r.revision === 1
              ? "Initial document created"
              : `Saved revision ${r.revision}`,
        source: r.restored_from_revision !== null ? "restore" : "manual",
        actorId: r.created_by,
        ...(r.restored_from_revision !== null ? { restoredFromRevision: r.restored_from_revision } : {}),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
    });
  }

  async getVersion(actor: ActorContext, documentId: string, revision: number): Promise<DocumentVersion | null> {
    assertCanPerform(actor, "document", "read");
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const docRes = await tx.query<{ workspace_id: string }>(
        "SELECT workspace_id::text FROM documents WHERE document_id = $1::uuid",
        [documentId],
      );
      const docRow = docRes.rows[0];
      if (!docRow) {
        throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
      }
      assertTenantWorkspaceAccess(actor, actor.tenantId, docRow.workspace_id);

      const verRes = await tx.query<{
        revision: number;
        restored_from_revision: number | null;
        snapshot_json: StudioDocument | string;
        created_by: string;
        created_at: Date | string;
      }>(
        `SELECT revision, restored_from_revision, snapshot_json, created_by::text, created_at
         FROM document_versions
         WHERE document_id = $1::uuid AND revision = $2`,
        [documentId, revision],
      );
      const r = verRes.rows[0];
      if (!r) return null;
      return {
        versionId: `${documentId}:rev-${r.revision}`,
        documentId,
        revision: r.revision,
        snapshot: parseSnapshot(r.snapshot_json),
        summary:
          r.restored_from_revision !== null
            ? `Restored revision ${r.restored_from_revision} as revision ${r.revision}`
            : `Revision ${r.revision}`,
        source: r.restored_from_revision !== null ? "restore" : "manual",
        actorId: r.created_by,
        ...(r.restored_from_revision !== null ? { restoredFromRevision: r.restored_from_revision } : {}),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      };
    });
  }

  async restoreVersion(actor: ActorContext, documentId: string, targetRevision: number): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "restore");
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const curRes = await tx.query<{ workspace_id: string; current_revision: number }>(
        `SELECT workspace_id::text, current_revision
         FROM documents
         WHERE document_id = $1::uuid
         FOR UPDATE`,
        [documentId],
      );
      const curRow = curRes.rows[0];
      if (!curRow) {
        throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
      }
      assertTenantWorkspaceAccess(actor, actor.tenantId, curRow.workspace_id);

      const targetRes = await tx.query<{ snapshot_json: StudioDocument | string }>(
        `SELECT snapshot_json
         FROM document_versions
         WHERE document_id = $1::uuid AND revision = $2`,
        [documentId, targetRevision],
      );
      const targetRow = targetRes.rows[0];
      if (!targetRow) {
        throw new DatabaseConflictError(
          404,
          "VERSION_NOT_FOUND",
          `Revision ${targetRevision} was not found for document '${documentId}'.`,
        );
      }

      const now = new Date().toISOString();
      const nextRevision = curRow.current_revision + 1;
      const restoredDoc: StudioDocument = {
        ...structuredClone(parseSnapshot(targetRow.snapshot_json)),
        revision: nextRevision,
        updatedAt: now,
      };
      const contentSha = createHash("sha256").update(JSON.stringify(restoredDoc)).digest("hex");

      const updRes = await tx.query(
        `UPDATE documents
         SET title = $1, language = $2, current_revision = $3, status = $4, updated_at = $5::timestamptz
         WHERE tenant_id = $6::uuid AND document_id = $7::uuid AND current_revision = $8`,
        [
          restoredDoc.title,
          restoredDoc.language,
          nextRevision,
          restoredDoc.status,
          now,
          actor.tenantId,
          documentId,
          curRow.current_revision,
        ],
      );
      if (updRes.rowCount !== 1) {
        throw new DatabaseConflictError(409, "REVISION_CONFLICT", "Concurrent revision restore conflict.");
      }

      await tx.query(
        `INSERT INTO document_versions (
           tenant_id, document_id, revision, storage_object_key, content_sha256,
           restored_from_revision, snapshot_json, created_by
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::uuid)`,
        [
          actor.tenantId,
          documentId,
          nextRevision,
          `${actor.tenantId}/${actor.workspaceId}/documents/${documentId}/rev-${nextRevision}.json`,
          contentSha,
          targetRevision,
          JSON.stringify(restoredDoc),
          actor.userId,
        ],
      );

      await this.insertAuditTx(tx, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "restore",
        action: "document.version_restored",
        outcome: "success",
        revisionBefore: curRow.current_revision,
        revisionAfter: nextRevision,
        summary: `Restored revision ${targetRevision} as new PostgreSQL revision ${nextRevision}`,
      });

      return structuredClone(restoredDoc);
    });
  }

  async listAuditEvents(actor: ActorContext, documentId: string): Promise<AuditEvent[]> {
    assertCanPerform(actor, "audit", "read");
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      const docRes = await tx.query<{ workspace_id: string }>(
        "SELECT workspace_id::text FROM documents WHERE document_id = $1::uuid",
        [documentId],
      );
      const docRow = docRes.rows[0];
      if (!docRow) {
        throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
      }
      assertTenantWorkspaceAccess(actor, actor.tenantId, docRow.workspace_id);

      const res = await tx.query<{
        audit_id: string;
        tenant_id: string;
        workspace_id: string | null;
        actor_id: string;
        actor_role: string;
        source: string;
        action: string;
        outcome: "success" | "denied" | "failed";
        target_id: string;
        revision_before: number | null;
        revision_after: number | null;
        summary: string;
        created_at: Date | string;
      }>(
        `SELECT audit_id::text, tenant_id::text, workspace_id::text, actor_id::text, actor_role,
                source, action, outcome, target_id, revision_before, revision_after, summary, created_at
         FROM audit_logs
         WHERE target_id = $1
         ORDER BY created_at DESC`,
        [documentId],
      );
      return res.rows.map((r) => ({
        auditId: r.audit_id,
        tenantId: r.tenant_id,
        workspaceId: r.workspace_id ?? actor.workspaceId,
        documentId: r.target_id,
        actorId: r.actor_id,
        actorRole: (isWorkspaceRole(r.actor_role) ? r.actor_role : "viewer") as WorkspaceRole,
        source: r.source as AuditEvent["source"],
        action: r.action,
        outcome: r.outcome,
        ...(r.revision_before !== null ? { revisionBefore: r.revision_before } : {}),
        ...(r.revision_after !== null ? { revisionAfter: r.revision_after } : {}),
        summary: r.summary,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
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
    auditOpts?: { source?: AuditEvent["source"]; action?: string; summary?: string },
  ): Promise<StudioDocument> {
    assertCanPerform(actor, "document", "write");
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      // Lock ONLY the documents row first (avoiding READ COMMITTED EvalPlanQual join drops under concurrent updates)
      const curRes = await tx.query<{ workspace_id: string; current_revision: number }>(
        `SELECT workspace_id::text, current_revision
         FROM documents
         WHERE document_id = $1::uuid
         FOR UPDATE`,
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

      const snapRes = await tx.query<{ snapshot_json: StudioDocument | string }>(
        `SELECT snapshot_json
         FROM document_versions
         WHERE document_id = $1::uuid AND revision = $2`,
        [documentId, row.current_revision],
      );
      const snapRow = snapRes.rows[0];
      if (!snapRow) {
        throw new DatabaseConflictError(404, "VERSION_NOT_FOUND", `Revision ${row.current_revision} snapshot missing.`);
      }

      const currentDoc = parseSnapshot(snapRow.snapshot_json);
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
        source: auditOpts?.source ?? "manual",
        action: auditOpts?.action ?? "document.update",
        outcome: "success",
        revisionBefore: expectedRevision,
        revisionAfter: nextRevision,
        summary: auditOpts?.summary ?? `Updated PostgreSQL document to revision ${nextRevision}`,
      });

      return structuredClone(updatedDoc);
    });
  }

  /**
   * Atomically executes or deduplicates an approved AI/voice document operation inside
   * a single tenant-RLS transaction backed by the append-only `ai_applied_operations` ledger.
   * Safe across API restarts and multiple horizontal API replicas.
   */
  async applyAiOperationIdempotent(params: {
    actor: ActorContext;
    documentId: string;
    operationId: string;
    expectedRevision: number;
    buildNext: (current: StudioDocument, priorSnapshot: StudioDocument | null, nextRevision: number) => {
      updatedDoc: StudioDocument;
      summary: string;
    };
    source: "typed_ai" | "voice_command";
    loadPriorForUndo?: boolean;
  }): Promise<{ document: StudioDocument; deduplicated: boolean; appliedOperationId: string }> {
    const { actor, documentId, operationId, expectedRevision, buildNext, source, loadPriorForUndo } = params;
    assertCanPerform(actor, "ai_assistant", "apply_ai");
    assertCanPerform(actor, "document", "write");
    assertValidDocumentUuid(documentId);

    return withTenantTransaction(this.db, actor.tenantId, async (tx) => {
      // Lock ONLY the documents row first so concurrent identical operationIds serialize without EPQ join drops
      const curRes = await tx.query<{ workspace_id: string; current_revision: number }>(
        `SELECT workspace_id::text, current_revision
         FROM documents
         WHERE document_id = $1::uuid
         FOR UPDATE`,
        [documentId],
      );
      const row = curRes.rows[0];
      if (!row) {
        throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
      }
      assertTenantWorkspaceAccess(actor, actor.tenantId, row.workspace_id);

      const priorOp = await tx.query<{ result_revision: number }>(
        `SELECT result_revision
         FROM ai_applied_operations
         WHERE workspace_id = $1::uuid AND document_id = $2::uuid AND operation_id = $3`,
        [actor.workspaceId, documentId, operationId],
      );
      const existingRev = priorOp.rows[0]?.result_revision;
      if (typeof existingRev === "number") {
        const snapRes = await tx.query<{ snapshot_json: StudioDocument | string }>(
          `SELECT snapshot_json
           FROM document_versions
           WHERE document_id = $1::uuid AND revision = $2`,
          [documentId, existingRev],
        );
        const snap = snapRes.rows[0]?.snapshot_json;
        if (snap) {
          return {
            document: structuredClone(parseSnapshot(snap)),
            deduplicated: true,
            appliedOperationId: operationId,
          };
        }
      }

      if (row.current_revision !== expectedRevision) {
        throw new DatabaseConflictError(
          409,
          "REVISION_CONFLICT",
          `Expected revision ${expectedRevision}, but current PostgreSQL revision is ${row.current_revision}.`,
        );
      }

      const curSnapRes = await tx.query<{ snapshot_json: StudioDocument | string }>(
        `SELECT snapshot_json
         FROM document_versions
         WHERE document_id = $1::uuid AND revision = $2`,
        [documentId, row.current_revision],
      );
      const curSnapRow = curSnapRes.rows[0];
      if (!curSnapRow) {
        throw new DatabaseConflictError(404, "VERSION_NOT_FOUND", `Revision ${row.current_revision} snapshot missing.`);
      }
      const currentDoc = parseSnapshot(curSnapRow.snapshot_json);
      let priorSnapshot: StudioDocument | null = null;
      if (loadPriorForUndo && currentDoc.revision > 1) {
        const prevRes = await tx.query<{ snapshot_json: StudioDocument | string }>(
          `SELECT snapshot_json
           FROM document_versions
           WHERE document_id = $1::uuid AND revision = $2`,
          [documentId, currentDoc.revision - 1],
        );
        if (prevRes.rows[0]?.snapshot_json) {
          priorSnapshot = parseSnapshot(prevRes.rows[0].snapshot_json);
        }
      }

      const nextRevision = expectedRevision + 1;
      const { updatedDoc, summary } = buildNext(currentDoc, priorSnapshot, nextRevision);
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

      await tx.query(
        `INSERT INTO ai_applied_operations (
           tenant_id, workspace_id, document_id, operation_id, result_revision, actor_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)`,
        [actor.tenantId, actor.workspaceId, documentId, operationId, nextRevision, actor.userId],
      );

      await this.insertAuditTx(tx, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        documentId,
        actorId: actor.userId,
        actorRole: actor.role,
        source,
        action: "document.ai_applied",
        outcome: "success",
        revisionBefore: expectedRevision,
        revisionAfter: nextRevision,
        summary,
      });

      return {
        document: structuredClone(updatedDoc),
        deduplicated: false,
        appliedOperationId: operationId,
      };
    });
  }
}
