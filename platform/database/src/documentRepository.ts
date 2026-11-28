import { createHash, randomUUID } from "node:crypto";
import type {
  ActorContext,
  AuditEvent,
  DocumentVersion,
  PolicyAction,
  PolicyDecisionRequest,
  PolicyResourceType,
  StudioDocument,
  WorkspaceRole,
} from "@ai-office-suite/shared-contracts";
import { redactAuditEvent, redactAuditString } from "@ai-office-suite/audit";
import {
  assertPolicyAllowed,
  assertTenantWorkspaceAccess,
  isWorkspaceRole,
} from "@ai-office-suite/authorization";
import type { PgDatabaseAdapter, PgQueryExecutor } from "./adapter.ts";
import { withTenantTransaction } from "./schema.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampListPagination(options?: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const rawLimit = options?.limit ?? 100;
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 100;
  const rawOffset = options?.offset ?? 0;
  const offset = Number.isFinite(rawOffset) ? Math.min(100_000, Math.max(0, Math.trunc(rawOffset))) : 0;
  return { limit, offset };
}

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

function toPolicySource(source?: AuditEvent["source"]): PolicyDecisionRequest["source"] {
  if (source === "typed_ai" || source === "voice_command" || source === "system") {
    return source;
  }
  return "manual";
}

export class PostgreSqlDocumentRepository {
  private readonly db: PgDatabaseAdapter;

  constructor(db: PgDatabaseAdapter) {
    this.db = db;
  }

  private async insertAuditTx(
    tx: PgQueryExecutor,
    event: Omit<AuditEvent, "auditId" | "createdAt"> & { targetType?: string },
  ): Promise<void> {
    const safeSummary = redactAuditString(event.summary);
    const safeMeta = event.metadata ? redactAuditEvent(event.metadata) : undefined;
    await tx.query(
      `INSERT INTO audit_logs (
         audit_id, tenant_id, workspace_id, actor_id, actor_role, source, action, outcome,
         target_type, target_id, revision_before, revision_after, summary, metadata
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [
        randomUUID(),
        event.tenantId,
        event.workspaceId,
        event.actorId,
        event.actorRole,
        event.source,
        event.action,
        event.outcome,
        event.targetType ?? (event.documentId ? "document" : "workspace"),
        event.documentId ?? "none",
        event.revisionBefore ?? null,
        event.revisionAfter ?? null,
        safeSummary,
        safeMeta ? JSON.stringify(safeMeta) : null,
      ],
    );
  }

  async recordAudit(
    actor: ActorContext,
    event: Omit<AuditEvent, "auditId" | "createdAt"> & { targetType?: string },
  ): Promise<void> {
    assertTenantWorkspaceAccess(actor, event.tenantId, event.workspaceId);
    await withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.insertAuditTx(tx, event);
      },
      actor.workspaceId,
    );
  }

  private async enforceWorkspacePolicyTx(
    tx: PgQueryExecutor,
    actor: ActorContext,
    resource: PolicyResourceType,
    action: PolicyAction,
    source: AuditEvent["source"] = "manual",
  ): Promise<void> {
    const wsRes = await tx.query<{ visibility: "standard" | "restricted" }>(
      `SELECT visibility FROM workspaces WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid`,
      [actor.tenantId, actor.workspaceId],
    );
    const workspaceVisibility = wsRes.rows[0]?.visibility ?? actor.workspaceVisibility;
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource,
      action,
      source: toPolicySource(source),
      ...(workspaceVisibility ? { workspaceVisibility } : {}),
    });
  }

  async createDocument(
    actor: ActorContext,
    doc: StudioDocument,
    auditOpts?: { source?: AuditEvent["source"]; action?: string; summary?: string },
  ): Promise<StudioDocument> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: doc.tenantId,
      resourceWorkspaceId: doc.workspaceId,
      resource: "document",
      action: "create",
      source: toPolicySource(auditOpts?.source),
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(doc.documentId);

    const source = auditOpts?.source ?? "manual";
    const summary = auditOpts?.summary ?? `Created document '${doc.title}'`;
    const contentSha = createHash("sha256").update(JSON.stringify(doc)).digest("hex");
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "create", source);
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
             source_import_sha256, source, summary, snapshot_json, created_by
           ) VALUES ($1::uuid, $2::uuid, 1, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid)`,
          [
            doc.tenantId,
            doc.documentId,
            `${doc.tenantId}/${doc.workspaceId}/documents/${doc.documentId}/rev-1.json`,
            contentSha,
            doc.sourceImportSha256 ?? null,
            source,
            summary,
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
          source,
          action: auditOpts?.action ?? "document.created",
          outcome: "success",
          revisionAfter: 1,
          summary,
        });

        return structuredClone(doc);
      },
      actor.workspaceId,
    );
  }

  async listDocuments(actor: ActorContext): Promise<StudioDocument[]> {
    const res = await this.listDocumentsFiltered(actor, { limit: 100, offset: 0 });
    return res.documents;
  }

  async listDocumentsFiltered(
    actor: ActorContext,
    filter: { q?: string; language?: "en" | "km" | "bilingual"; limit?: number; offset?: number } = {},
  ): Promise<{ documents: StudioDocument[]; total: number; limit: number; offset: number }> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    const limit = Math.max(1, Math.min(100, Math.trunc(filter.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
    const qTrim = filter.q?.trim();
    const escapedLike = qTrim
      ? `%${qTrim.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      : null;

    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
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

        await this.enforceWorkspacePolicyTx(tx, actor, "document", "read", "manual");
        const whereSql = conditions.join(" AND ");
        const pageParams = [...params, limit, offset];
        // Single-query pagination using COUNT(*) OVER() (M6)
        const res = await tx.query<{ snapshot_json: StudioDocument | string; total_count: string }>(
          `SELECT v.snapshot_json, COUNT(*) OVER()::text AS total_count
           FROM documents d
           JOIN document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = d.current_revision
           WHERE ${whereSql}
           ORDER BY d.updated_at DESC, d.document_id ASC
           LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
          pageParams,
        );

        let total = res.rows.length > 0 ? Number(res.rows[0]!.total_count) : 0;
        if (res.rows.length === 0 && offset > 0) {
          const countRes = await tx.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM documents d WHERE ${whereSql}`,
            params,
          );
          total = Number(countRes.rows[0]?.total ?? 0);
        }

        return {
          documents: res.rows.map((r) => parseSnapshot(r.snapshot_json)),
          total,
          limit,
          offset,
        };
      },
      actor.workspaceId,
    );
  }

  async getDocument(actor: ActorContext, documentId: string): Promise<StudioDocument> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "read", "manual");
        const res = await tx.query<{ snapshot_json: StudioDocument | string; workspace_id: string }>(
          `SELECT d.workspace_id::text, v.snapshot_json
           FROM documents d
           JOIN document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = d.current_revision
           WHERE d.document_id = $1::uuid AND d.workspace_id = $2::uuid`,
          [documentId, actor.workspaceId],
        );
        const row = res.rows[0];
        if (!row) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }
        return parseSnapshot(row.snapshot_json);
      },
      actor.workspaceId,
    );
  }

  async listVersionsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
  ): Promise<{ versions: DocumentVersion[]; total: number; hasMore: boolean }> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    const { limit, offset } = clampListPagination(options);
    const sortDir = options?.order === "desc" ? "DESC" : "ASC";
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "read", "manual");
        const verRes = await tx.query<{
          revision: number;
          restored_from_revision: number | null;
          source: string | null;
          summary: string | null;
          snapshot_json: StudioDocument | string;
          created_by: string;
          created_at: Date | string;
          total_count: string;
        }>(
          `SELECT v.revision, v.restored_from_revision, v.source, v.summary, v.snapshot_json,
                  v.created_by::text, v.created_at, COUNT(*) OVER()::text AS total_count
           FROM documents d
           JOIN document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id
           WHERE d.document_id = $1::uuid AND d.workspace_id = $2::uuid
           ORDER BY v.revision ${sortDir}
           LIMIT $3 OFFSET $4`,
          [documentId, actor.workspaceId, limit, offset],
        );
        if (verRes.rows.length === 0) {
          const existsRes = await tx.query<{ document_id: string }>(
            `SELECT document_id::text
             FROM documents
             WHERE document_id = $1::uuid AND workspace_id = $2::uuid`,
            [documentId, actor.workspaceId],
          );
          if (existsRes.rows.length === 0) {
            throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
          }
          let total = 0;
          if (offset > 0) {
            const countRes = await tx.query<{ total: string }>(
              `SELECT COUNT(*)::text AS total FROM document_versions WHERE tenant_id = $1::uuid AND document_id = $2::uuid`,
              [actor.tenantId, documentId],
            );
            total = Number(countRes.rows[0]?.total ?? 0);
          }
          return { versions: [], total, hasMore: false };
        }
        const total = Number(verRes.rows[0]!.total_count);
        const versions = verRes.rows.map((r) => {
          const fallbackSummary =
            r.restored_from_revision !== null
              ? `Restored revision ${r.restored_from_revision} as revision ${r.revision}`
              : r.revision === 1
                ? "Initial document created"
                : `Saved revision ${r.revision}`;
          const fallbackSource: DocumentVersion["source"] = r.restored_from_revision !== null ? "restore" : "manual";
          return {
            versionId: `${documentId}:rev-${r.revision}`,
            documentId,
            revision: r.revision,
            snapshot: parseSnapshot(r.snapshot_json),
            summary: r.summary && r.summary.length > 0 ? r.summary : fallbackSummary,
            source: (r.source || fallbackSource) as DocumentVersion["source"],
            actorId: r.created_by,
            ...(r.restored_from_revision !== null ? { restoredFromRevision: r.restored_from_revision } : {}),
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          };
        });
        return { versions, total, hasMore: offset + versions.length < total };
      },
      actor.workspaceId,
    );
  }

  async listVersions(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
  ): Promise<DocumentVersion[]> {
    const page = await this.listVersionsPage(actor, documentId, options);
    return page.versions;
  }

  async listVersionMetadata(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
  ): Promise<Array<Omit<DocumentVersion, "snapshot">>> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    const { limit, offset } = clampListPagination(options);
    const sortDir = options?.order === "desc" ? "DESC" : "ASC";
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "read", "manual");
        const verRes = await tx.query<{
          revision: number;
          restored_from_revision: number | null;
          source: string | null;
          summary: string | null;
          created_by: string;
          created_at: Date | string;
        }>(
          `SELECT v.revision, v.restored_from_revision, v.source, v.summary, v.created_by::text, v.created_at
           FROM documents d
           JOIN document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id
           WHERE d.document_id = $1::uuid AND d.workspace_id = $2::uuid
           ORDER BY v.revision ${sortDir}
           LIMIT $3 OFFSET $4`,
          [documentId, actor.workspaceId, limit, offset],
        );
        if (verRes.rows.length === 0) {
          const existsRes = await tx.query<{ document_id: string }>(
            `SELECT document_id::text
             FROM documents
             WHERE document_id = $1::uuid AND workspace_id = $2::uuid`,
            [documentId, actor.workspaceId],
          );
          if (existsRes.rows.length === 0) {
            throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
          }
          return [];
        }
        return verRes.rows.map((r) => {
          const fallbackSummary =
            r.restored_from_revision !== null
              ? `Restored revision ${r.restored_from_revision} as revision ${r.revision}`
              : r.revision === 1
                ? "Initial document created"
                : `Saved revision ${r.revision}`;
          const fallbackSource: DocumentVersion["source"] = r.restored_from_revision !== null ? "restore" : "manual";
          return {
            versionId: `${documentId}:rev-${r.revision}`,
            documentId,
            revision: r.revision,
            summary: r.summary && r.summary.length > 0 ? r.summary : fallbackSummary,
            source: (r.source || fallbackSource) as DocumentVersion["source"],
            actorId: r.created_by,
            ...(r.restored_from_revision !== null ? { restoredFromRevision: r.restored_from_revision } : {}),
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          };
        });
      },
      actor.workspaceId,
    );
  }

  async getUndoTargetSnapshot(actor: ActorContext, documentId: string): Promise<StudioDocument | null> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "read", "manual");
        const curRes = await tx.query<{
          current_revision: number;
          restored_from_revision: number | null;
        }>(
          `SELECT d.current_revision, v.restored_from_revision
           FROM documents d
           LEFT JOIN document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = d.current_revision
           WHERE d.document_id = $1::uuid AND d.workspace_id = $2::uuid`,
          [documentId, actor.workspaceId],
        );
        const curRow = curRes.rows[0];
        if (!curRow) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }
        if (curRow.current_revision <= 1) {
          return null;
        }
        const targetUpper =
          curRow.restored_from_revision !== null
            ? curRow.restored_from_revision - 1
            : curRow.current_revision - 1;
        if (targetUpper < 1) {
          return null;
        }
        const prevRes = await tx.query<{ snapshot_json: StudioDocument | string }>(
          `SELECT snapshot_json
           FROM document_versions
           WHERE document_id = $1::uuid AND revision <= $2
           ORDER BY revision DESC
           LIMIT 1`,
          [documentId, targetUpper],
        );
        const prevRow = prevRes.rows[0];
        return prevRow?.snapshot_json ? parseSnapshot(prevRow.snapshot_json) : null;
      },
      actor.workspaceId,
    );
  }

  async getVersion(actor: ActorContext, documentId: string, revision: number): Promise<DocumentVersion | null> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "read", "manual");
        // Single LEFT JOIN distinguishes missing document (404) from missing revision (null) (M6)
        const res = await tx.query<{
          doc_exists: string;
          revision: number | null;
          restored_from_revision: number | null;
          source: string | null;
          summary: string | null;
          snapshot_json: StudioDocument | string | null;
          created_by: string | null;
          created_at: Date | string | null;
        }>(
          `SELECT d.document_id::text AS doc_exists,
                  v.revision, v.restored_from_revision, v.source, v.summary,
                  v.snapshot_json, v.created_by::text, v.created_at
           FROM documents d
           LEFT JOIN document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.revision = $3
           WHERE d.document_id = $1::uuid AND d.workspace_id = $2::uuid`,
          [documentId, actor.workspaceId, revision],
        );
        const r = res.rows[0];
        if (!r) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }
        if (r.revision === null || r.snapshot_json === null || r.created_by === null) {
          return null;
        }
        const fallbackSummary =
          r.restored_from_revision !== null
            ? `Restored revision ${r.restored_from_revision} as revision ${r.revision}`
            : `Revision ${r.revision}`;
        const fallbackSource: DocumentVersion["source"] = r.restored_from_revision !== null ? "restore" : "manual";
        return {
          versionId: `${documentId}:rev-${r.revision}`,
          documentId,
          revision: r.revision,
          snapshot: parseSnapshot(r.snapshot_json),
          summary: r.summary && r.summary.length > 0 ? r.summary : fallbackSummary,
          source: (r.source || fallbackSource) as DocumentVersion["source"],
          actorId: r.created_by,
          ...(r.restored_from_revision !== null ? { restoredFromRevision: r.restored_from_revision } : {}),
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        };
      },
      actor.workspaceId,
    );
  }

  /**
   * Fetches two document revision snapshots atomically inside a single RLS transaction for diffing (M9).
   */
  async getVersionsForDiff(
    actor: ActorContext,
    documentId: string,
    fromRevision: number,
    toRevision: number,
  ): Promise<{ fromDoc: StudioDocument | null; toDoc: StudioDocument | null }> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "read", "manual");
        const res = await tx.query<{
          revision: number | null;
          snapshot_json: StudioDocument | string | null;
        }>(
          `SELECT v.revision, v.snapshot_json
           FROM documents d
           LEFT JOIN document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id
             AND v.revision IN ($3, $4)
           WHERE d.document_id = $1::uuid AND d.workspace_id = $2::uuid`,
          [documentId, actor.workspaceId, fromRevision, toRevision],
        );
        if (res.rows.length === 0) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }
        let fromDoc: StudioDocument | null = null;
        let toDoc: StudioDocument | null = null;
        for (const r of res.rows) {
          if (r.revision === fromRevision && r.snapshot_json) fromDoc = parseSnapshot(r.snapshot_json);
          if (r.revision === toRevision && r.snapshot_json) toDoc = parseSnapshot(r.snapshot_json);
        }
        return { fromDoc, toDoc };
      },
      actor.workspaceId,
    );
  }

  async restoreVersion(
    actor: ActorContext,
    documentId: string,
    targetRevision: number,
    options?: { expectedRevision?: number },
  ): Promise<StudioDocument> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "restore",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "restore", "restore");
        const curRes = await tx.query<{ workspace_id: string; current_revision: number }>(
          `SELECT workspace_id::text, current_revision
           FROM documents
           WHERE document_id = $1::uuid AND workspace_id = $2::uuid
           FOR UPDATE`,
          [documentId, actor.workspaceId],
        );
        const curRow = curRes.rows[0];
        if (!curRow) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }
        if (
          typeof options?.expectedRevision === "number" &&
          curRow.current_revision !== options.expectedRevision
        ) {
          throw new DatabaseConflictError(
            409,
            "REVISION_CONFLICT",
            `Expected revision ${options.expectedRevision}, but current PostgreSQL revision is ${curRow.current_revision}.`,
          );
        }

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
        const summary = `Restored revision ${targetRevision} as revision ${nextRevision}`;
        const contentSha = createHash("sha256").update(JSON.stringify(restoredDoc)).digest("hex");

        const updRes = await tx.query(
          `UPDATE documents
           SET title = $1, language = $2, current_revision = $3, status = $4, updated_at = $5::timestamptz
           WHERE tenant_id = $6::uuid AND workspace_id = $7::uuid AND document_id = $8::uuid AND current_revision = $9`,
          [
            restoredDoc.title,
            restoredDoc.language,
            nextRevision,
            restoredDoc.status,
            now,
            actor.tenantId,
            actor.workspaceId,
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
             restored_from_revision, source, summary, snapshot_json, created_by
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'restore', $7, $8::jsonb, $9::uuid)`,
          [
            actor.tenantId,
            documentId,
            nextRevision,
            `${actor.tenantId}/${actor.workspaceId}/documents/${documentId}/rev-${nextRevision}.json`,
            contentSha,
            targetRevision,
            summary,
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
          summary,
        });

        return structuredClone(restoredDoc);
      },
      actor.workspaceId,
    );
  }

  async listAuditEventsPage(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ events: AuditEvent[]; total: number; hasMore: boolean }> {
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "audit",
      action: "read",
      source: "manual",
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    const { limit, offset } = clampListPagination(options);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "audit", "read", "manual");
        const existsRes = await tx.query<{ document_id: string }>(
          `SELECT document_id::text
           FROM documents
           WHERE document_id = $1::uuid AND workspace_id = $2::uuid`,
          [documentId, actor.workspaceId],
        );
        if (existsRes.rows.length === 0) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }
        const res = await tx.query<{
          audit_id: string;
          tenant_id: string;
          workspace_id: string | null;
          actor_id: string;
          actor_role: string;
          source: string;
          action: string;
          outcome: "success" | "denied" | "failed";
          target_id: string | null;
          revision_before: number | null;
          revision_after: number | null;
          summary: string;
          metadata: Record<string, unknown> | string | null;
          created_at: Date | string;
          total_count: string;
        }>(
          `SELECT a.audit_id::text, a.tenant_id::text, a.workspace_id::text, a.actor_id::text, a.actor_role,
                  a.source, a.action, a.outcome, a.target_id, a.revision_before, a.revision_after,
                  a.summary, a.metadata, a.created_at, COUNT(*) OVER()::text AS total_count
           FROM audit_logs a
           WHERE a.tenant_id = $1::uuid AND a.workspace_id = $2::uuid AND a.target_id = $3
           ORDER BY a.created_at DESC, a.audit_id DESC
           LIMIT $4 OFFSET $5`,
          [actor.tenantId, actor.workspaceId, documentId, limit, offset],
        );
        let total = res.rows.length > 0 ? Number(res.rows[0]!.total_count) : 0;
        if (res.rows.length === 0 && offset > 0) {
          const countRes = await tx.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM audit_logs WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND target_id = $3`,
            [actor.tenantId, actor.workspaceId, documentId],
          );
          total = Number(countRes.rows[0]?.total ?? 0);
        }
        const events = res.rows.map((r) => ({
          auditId: r.audit_id,
          tenantId: r.tenant_id,
          workspaceId: r.workspace_id ?? actor.workspaceId,
          documentId: r.target_id ?? documentId,
          actorId: r.actor_id,
          actorRole: (r.actor_role && isWorkspaceRole(r.actor_role) ? r.actor_role : "viewer") as WorkspaceRole,
          source: (r.source ?? "system") as AuditEvent["source"],
          action: r.action,
          outcome: r.outcome,
          ...(r.revision_before !== null ? { revisionBefore: r.revision_before } : {}),
          ...(r.revision_after !== null ? { revisionAfter: r.revision_after } : {}),
          summary: r.summary,
          ...(r.metadata
            ? { metadata: typeof r.metadata === "string" ? (JSON.parse(r.metadata) as Record<string, unknown>) : r.metadata }
            : {}),
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        }));
        return { events, total, hasMore: offset + events.length < total };
      },
      actor.workspaceId,
    );
  }

  async listAuditEvents(
    actor: ActorContext,
    documentId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<AuditEvent[]> {
    const page = await this.listAuditEventsPage(actor, documentId, options);
    return page.events;
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
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "write",
      source: toPolicySource(auditOpts?.source),
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);
    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(
          tx,
          actor,
          "document",
          "write",
          auditOpts?.source ?? "manual",
        );
        // Lock ONLY the documents row first (avoiding READ COMMITTED EvalPlanQual join drops under concurrent updates)
        const curRes = await tx.query<{ workspace_id: string; current_revision: number }>(
          `SELECT workspace_id::text, current_revision
           FROM documents
           WHERE document_id = $1::uuid AND workspace_id = $2::uuid
           FOR UPDATE`,
          [documentId, actor.workspaceId],
        );
        const row = curRes.rows[0];
        if (!row) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }
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
        const source = auditOpts?.source ?? "manual";
        const summary = auditOpts?.summary ?? `Updated document to revision ${nextRevision}`;
        const contentSha = createHash("sha256").update(JSON.stringify(updatedDoc)).digest("hex");

        const updateRes = await tx.query(
          `UPDATE documents
           SET title = $1, language = $2, current_revision = $3, status = $4, updated_at = $5::timestamptz
           WHERE tenant_id = $6::uuid AND workspace_id = $7::uuid AND document_id = $8::uuid AND current_revision = $9`,
          [
            updatedDoc.title,
            updatedDoc.language,
            nextRevision,
            updatedDoc.status,
            updatedDoc.updatedAt,
            actor.tenantId,
            actor.workspaceId,
            documentId,
            expectedRevision,
          ],
        );
        if (updateRes.rowCount !== 1) {
          throw new DatabaseConflictError(409, "REVISION_CONFLICT", "Concurrent revision update conflict.");
        }

        await tx.query(
          `INSERT INTO document_versions (
             tenant_id, document_id, revision, storage_object_key, content_sha256, source, summary, snapshot_json, created_by
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid)`,
          [
            actor.tenantId,
            documentId,
            nextRevision,
            `${actor.tenantId}/${actor.workspaceId}/documents/${documentId}/rev-${nextRevision}.json`,
            contentSha,
            source,
            summary,
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
          source,
          action: auditOpts?.action ?? "document.updated",
          outcome: "success",
          revisionBefore: expectedRevision,
          revisionAfter: nextRevision,
          summary,
        });

        return structuredClone(updatedDoc);
      },
      actor.workspaceId,
    );
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
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "ai_assistant",
      action: "apply_ai",
      source,
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertPolicyAllowed({
      actor,
      resourceTenantId: actor.tenantId,
      resourceWorkspaceId: actor.workspaceId,
      resource: "document",
      action: "write",
      source,
      ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
    });
    assertValidDocumentUuid(documentId);

    return withTenantTransaction(
      this.db,
      actor.tenantId,
      async (tx) => {
        await this.enforceWorkspacePolicyTx(tx, actor, "ai_assistant", "apply_ai", source);
        await this.enforceWorkspacePolicyTx(tx, actor, "document", "write", source);
        // Lock ONLY the documents row first so concurrent identical operationIds serialize without EPQ join drops
        const curRes = await tx.query<{ workspace_id: string; current_revision: number }>(
          `SELECT workspace_id::text, current_revision
           FROM documents
           WHERE document_id = $1::uuid AND workspace_id = $2::uuid
           FOR UPDATE`,
          [documentId, actor.workspaceId],
        );
        const row = curRes.rows[0];
        if (!row) {
          throw new DatabaseConflictError(404, "DOCUMENT_NOT_FOUND", `Document '${documentId}' not found.`);
        }

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

        const curSnapRes = await tx.query<{
          snapshot_json: StudioDocument | string;
          restored_from_revision: number | null;
        }>(
          `SELECT snapshot_json, restored_from_revision
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
        let undoTargetRevision: number | null = null;
        if (loadPriorForUndo && currentDoc.revision > 1) {
          // Walk back past prior restored_from_revision to eliminate consecutive undo flip-flop (H18)
          const targetUpper =
            curSnapRow.restored_from_revision !== null
              ? curSnapRow.restored_from_revision - 1
              : currentDoc.revision - 1;
          if (targetUpper >= 1) {
            const prevRes = await tx.query<{ revision: number; snapshot_json: StudioDocument | string }>(
              `SELECT revision, snapshot_json
               FROM document_versions
               WHERE document_id = $1::uuid AND revision <= $2
               ORDER BY revision DESC
               LIMIT 1`,
              [documentId, targetUpper],
            );
            const prevRow = prevRes.rows[0];
            if (prevRow?.snapshot_json) {
              priorSnapshot = parseSnapshot(prevRow.snapshot_json);
              undoTargetRevision = prevRow.revision;
            }
          }
        }

        const nextRevision = expectedRevision + 1;
        const { updatedDoc, summary } = buildNext(currentDoc, priorSnapshot, nextRevision);
        const contentSha = createHash("sha256").update(JSON.stringify(updatedDoc)).digest("hex");

        const updateRes = await tx.query(
          `UPDATE documents
           SET title = $1, language = $2, current_revision = $3, status = $4, updated_at = $5::timestamptz
           WHERE tenant_id = $6::uuid AND workspace_id = $7::uuid AND document_id = $8::uuid AND current_revision = $9`,
          [
            updatedDoc.title,
            updatedDoc.language,
            nextRevision,
            updatedDoc.status,
            updatedDoc.updatedAt,
            actor.tenantId,
            actor.workspaceId,
            documentId,
            expectedRevision,
          ],
        );
        if (updateRes.rowCount !== 1) {
          throw new DatabaseConflictError(409, "REVISION_CONFLICT", "Concurrent revision update conflict.");
        }

        await tx.query(
          `INSERT INTO document_versions (
             tenant_id, document_id, revision, storage_object_key, content_sha256,
             restored_from_revision, source, summary, snapshot_json, created_by
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::uuid)`,
          [
            actor.tenantId,
            documentId,
            nextRevision,
            `${actor.tenantId}/${actor.workspaceId}/documents/${documentId}/rev-${nextRevision}.json`,
            contentSha,
            undoTargetRevision,
            source,
            summary,
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
      },
      actor.workspaceId,
    );
  }
}
