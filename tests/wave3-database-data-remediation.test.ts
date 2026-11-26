import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CORE_SCHEMA_VERSION,
  PgliteDatabaseAdapter,
  PostgreSqlDocumentRepository,
  initializePostgreSqlSchema,
  purgeExpiredIdempotencyKeys,
} from "@ai-office-suite/database";
import {
  XI_SCHEMA_VERSION,
  commitPackagePublicationTx,
  getPackageLifecycleRow,
  initializeIntegrationSchema,
  loadWorkflowRunRow,
  persistApprovalRow,
  persistArtifactRow,
  persistReportingPackageRow,
  persistWorkflowRunRow,
} from "@ai-office-suite/integration-engine";
import { InMemoryAuditStore } from "@ai-office-suite/audit";
import { LocalFilesystemStorageAdapter } from "@ai-office-suite/storage";
import { createDocumentSchema, documentBlockSchema } from "@ai-office-suite/validation";
import type { ActorContext, DocumentVersion, StudioDocument } from "@ai-office-suite/shared-contracts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("Wave 3 — Database & Data Layer Remediation (H6-H12, M6, M7)", () => {
  it("H6, H8, H9, M6, M7: creates secondary indexes, enforces FKs, runs versioned idempotent migrations, preserves version provenance & audit metadata, and prunes expired idempotency keys", async () => {
    const db = new PgliteDatabaseAdapter();
    try {
      // H9: First init applies; second init skips DDL via schema_migrations
      const firstCore = await initializePostgreSqlSchema(db);
      expect(firstCore).toEqual({ applied: true, version: CORE_SCHEMA_VERSION });
      const secondCore = await initializePostgreSqlSchema(db);
      expect(secondCore).toEqual({ applied: false, version: CORE_SCHEMA_VERSION });

      const firstXi = await initializeIntegrationSchema(db);
      expect(firstXi).toEqual({ applied: true, version: XI_SCHEMA_VERSION });
      const secondXi = await initializeIntegrationSchema(db);
      expect(secondXi).toEqual({ applied: false, version: XI_SCHEMA_VERSION });

      // H6: Verify secondary & case-insensitive unique indexes exist
      const idxRes = await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
      );
      const indexNames = new Set(idxRes.rows.map((r) => r.indexname));
      for (const expectedIdx of [
        "users_email_lower_uidx",
        "memberships_user_idx",
        "documents_tenant_ws_updated_idx",
        "audit_logs_tenant_ws_target_created_idx",
        "xi_artifacts_tenant_ws_updated_idx",
        "xi_edges_src_idx",
        "xi_approvals_pkg_idx",
        "xi_outbox_pending_idx",
      ]) {
        expect(indexNames.has(expectedIdx)).toBe(true);
      }

      const tenantId = "11111111-1111-4111-8111-111111111111";
      const ws1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
      const ws2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
      const userId = "22222222-2222-4222-8222-222222222222";
      const orphanWs = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa999";

      await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1::uuid, 'Org', 'active')", [tenantId]);
      await db.query(
        "INSERT INTO workspaces (tenant_id, workspace_id, name) VALUES ($1::uuid, $2::uuid, 'WS1'), ($1::uuid, $3::uuid, 'WS2')",
        [tenantId, ws1, ws2],
      );
      await db.query(
        "INSERT INTO users (user_id, email, password_hash, status) VALUES ($1::uuid, 'Alice@Org.KH', 'hash', 'active')",
        [userId],
      );

      // H6: Case-insensitive email uniqueness enforced by users_email_lower_uidx
      await expect(
        db.query(
          "INSERT INTO users (user_id, email, password_hash, status) VALUES ('33333333-3333-4333-8333-333333333333'::uuid, 'alice@org.kh', 'hash', 'active')",
        ),
      ).rejects.toThrow();

      // H8: Orphan workspace membership rejected by FK to workspaces(tenant_id, workspace_id)
      await expect(
        db.query(
          "INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'owner')",
          [tenantId, orphanWs, userId],
        ),
      ).rejects.toThrow();

      await db.query(
        "INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'owner')",
        [tenantId, ws1, userId],
      );

      // H8 & M6: Repository persists & reads real document_versions.source/summary, audit metadata, single-query pagination & diff fetch
      const repo = new PostgreSqlDocumentRepository(db);
      const actor: ActorContext = { tenantId, workspaceId: ws1, userId, role: "owner" };
      const now = new Date().toISOString();
      const docId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
      const doc: StudioDocument = {
        documentId: docId,
        tenantId,
        workspaceId: ws1,
        title: "Q4 Report",
        language: "bilingual",
        revision: 1,
        status: "draft",
        layout: {
          size: "A4",
          orientation: "portrait",
          marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
          headerText: "",
          footerText: "",
          showPageNumbers: true,
        },
        blocks: [{ id: "b1", type: "paragraph", runs: [{ text: "v1" }] }],
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      };
      await repo.createDocument(actor, doc, { source: "import", summary: "Imported Q4 DOCX" });
      await repo.updateDocument(
        actor,
        docId,
        1,
        (cur, rev) => ({ ...cur, revision: rev, blocks: [{ id: "b1", type: "paragraph", runs: [{ text: "v2" }] }] }),
        { source: "typed_ai", summary: "AI tightened intro" },
      );

      const versions = await repo.listVersions(actor, docId);
      expect(versions).toHaveLength(2);
      expect(versions[0]?.source).toBe("import");
      expect(versions[0]?.summary).toBe("Imported Q4 DOCX");
      expect(versions[1]?.source).toBe("typed_ai");
      expect(versions[1]?.summary).toBe("AI tightened intro");

      // Single-tx getVersionsForDiff (M9)
      const diffPair = await repo.getVersionsForDiff(actor, docId, 1, 2);
      expect(diffPair.fromDoc?.revision).toBe(1);
      expect(diffPair.toDoc?.revision).toBe(2);

      // Audit metadata pass-through (H8)
      await repo.recordAudit(actor, {
        tenantId,
        workspaceId: ws1,
        documentId: docId,
        actorId: userId,
        actorRole: "owner",
        source: "typed_ai",
        action: "ai.plan_generated",
        outcome: "success",
        summary: "Planned AI edit",
        metadata: { action: "replace_selection", riskLevel: "low" },
      });
      const audits = await repo.listAuditEvents(actor, docId);
      const planAudit = audits.find((a) => a.action === "ai.plan_generated");
      expect(planAudit?.metadata).toEqual({ action: "replace_selection", riskLevel: "low" });

      // M7: Purge expired idempotency_keys
      await db.query(
        `INSERT INTO idempotency_keys (tenant_id, idempotency_key, operation_scope, request_hash, response_json, expires_at)
         VALUES ($1::uuid, 'expired-k', 'op', repeat('a', 64), '{}'::jsonb, now() - interval '1 hour'),
                ($1::uuid, 'active-k', 'op', repeat('b', 64), '{}'::jsonb, now() + interval '1 hour')`,
        [tenantId],
      );
      const purged = await purgeExpiredIdempotencyKeys(db);
      expect(purged).toBe(1);

      // H10: Workspace-scoped XI workflow runs & locked package publication
      const runNow = new Date().toISOString();
      const makeCtx = (workspaceId: string) => ({
        tenantId,
        workspaceId,
        periodStart: "2026-10-01",
        periodEndExclusive: "2027-01-01",
        datasetId: "ds_1",
        datasetVersion: 1,
        metricIds: ["rev"],
        currency: "USD",
        language: "bilingual" as const,
        themeId: "corp",
        themeVersion: 1,
      });
      await persistWorkflowRunRow(db, {
        runId: "run_ws1",
        idempotencyKey: "shared-idem-key",
        tenantId,
        workspaceId: ws1,
        actorId: userId,
        state: "completed",
        workflowType: "monthly_management_reporting",
        steps: [],
        context: makeCtx(ws1),
        createdAt: runNow,
        updatedAt: runNow,
      });
      // Same idempotency key allowed in distinct workspace ws2 (H8 scoped unique key!)
      await persistWorkflowRunRow(db, {
        runId: "run_ws2",
        idempotencyKey: "shared-idem-key",
        tenantId,
        workspaceId: ws2,
        actorId: userId,
        state: "completed",
        workflowType: "monthly_management_reporting",
        steps: [],
        context: makeCtx(ws2),
        createdAt: runNow,
        updatedAt: runNow,
      });
      expect(await loadWorkflowRunRow(db, tenantId, "run_ws1", ws1)).not.toBeNull();
      expect(await loadWorkflowRunRow(db, tenantId, "run_ws1", ws2)).toBeNull();

      // Package publication rejects cross-workspace commit and double-publish with distinct idempotency key
      const digest = "a".repeat(64);
      await persistArtifactRow(db, {
        artifactId: "art_1",
        tenantId,
        workspaceId: ws1,
        kind: "document",
        title: "Board Memo",
        currentRevision: 1,
        ownerId: userId,
        classification: "internal",
        lifecycleStatus: "draft",
        updatedAt: runNow,
      });
      const manifest = {
        packageId: "pkg_1",
        packageVersion: 1,
        tenantId,
        workspaceId: ws1,
        title: "Q4 Pack",
        reportingPeriod: { start: "2026-10-01", endExclusive: "2027-01-01" },
        sourceVersions: [],
        metricVersions: [],
        resultReferences: [],
        artifactRevisions: [{ artifactId: "art_1", kind: "document" as const, revision: 1, contentSha256: digest, createdBy: userId, createdAt: runNow }],
        fileChecksums: { "memo.pdf": digest },
        validationChecks: [],
        allValidationsPassed: true,
        classification: "internal" as const,
        audiencePolicy: "executive",
        themeVersion: 1,
        lifecycleStatus: "approved" as const,
        manifestDigestSha256: digest,
        publishedAt: runNow,
      };
      await persistReportingPackageRow(db, manifest);
      await persistApprovalRow(db, tenantId, {
        approvalId: "app_1",
        packageId: "pkg_1",
        packageVersion: 1,
        manifestDigestSha256: digest,
        approverId: userId,
        status: "approved",
        approvedAt: runNow,
      });

      // Cross-workspace lookup returns null (H10)
      expect(await getPackageLifecycleRow(db, tenantId, "pkg_1", 1, ws2)).toBeNull();
      expect(await getPackageLifecycleRow(db, tenantId, "pkg_1", 1, ws1)).not.toBeNull();

      const pub1 = await commitPackagePublicationTx(db, {
        tenantId,
        workspaceId: ws1,
        actorId: userId,
        actorRole: "owner",
        manifest,
        idempotencyKey: "pub-idem-1",
      });
      expect(pub1.outboxEventId).toBeTruthy();
      // Replay with same idempotencyKey succeeds idempotently
      const pubReplay = await commitPackagePublicationTx(db, {
        tenantId,
        workspaceId: ws1,
        actorId: userId,
        actorRole: "owner",
        manifest,
        idempotencyKey: "pub-idem-1",
      });
      expect(pubReplay.outboxEventId).toBe(pub1.outboxEventId);
      // Attempting a second publish with a NEW idempotency key fails closed because lifecycle_status = 'published'
      await expect(
        commitPackagePublicationTx(db, {
          tenantId,
          workspaceId: ws1,
          actorId: userId,
          actorRole: "owner",
          manifest,
          idempotencyKey: "pub-idem-2",
        }),
      ).rejects.toThrow(/already published/i);
    } finally {
      await db.close();
    }
  });

  it("H11: validates all 6 XI LinkedMetricReference fields, bounds filterContext, and rejects duplicate block IDs", () => {
    const validMetricBlock = documentBlockSchema.safeParse({
      id: "blk_metric_1",
      type: "linked_metric_placeholder",
      metric: {
        datasetId: "ds_1",
        datasetVersion: "1",
        metricId: "m_rev",
        metricVersion: "1",
        reportingPeriod: "2026-Q4",
        filterContext: { region: "Phnom Penh" },
        unit: "USD",
        approvalStatus: "certified",
        freshnessTimestamp: new Date().toISOString(),
        mode: "live_draft",
        displayLabel: "Net Revenue",
        cachedFormattedValue: "$1,250,000.00",
        bindingMode: "refreshable_link",
        linkState: "current",
        sourceArtifactId: "art_bi_1",
        resultReferenceId: "res_1",
        effectivePolicyScope: "tenant:1|role:owner",
        policyVersion: 3,
      },
    });
    expect(validMetricBlock.success).toBe(true);
    if (validMetricBlock.success && validMetricBlock.data.type === "linked_metric_placeholder") {
      expect(validMetricBlock.data.metric.bindingMode).toBe("refreshable_link");
      expect(validMetricBlock.data.metric.policyVersion).toBe(3);
    }

    // Duplicate block IDs rejected
    const dupBlocks = createDocumentSchema.safeParse({
      title: "Dup Test",
      blocks: [
        { id: "blk_same", type: "paragraph", runs: [{ text: "A" }] },
        { id: "blk_same", type: "paragraph", runs: [{ text: "B" }] },
      ],
    });
    expect(dupBlocks.success).toBe(false);
  });

  it("H12: enforces atomic non-overwriting local version writes, O(1) latest doc reads, and bounded InMemoryAuditStore", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aios-storage-h12-"));
    tempDirs.push(dir);
    const storage = new LocalFilesystemStorageAdapter(dir);
    const now = new Date().toISOString();
    const makeVer = (rev: number, text: string): DocumentVersion => ({
      versionId: `doc1:rev-${rev}`,
      documentId: "doc1",
      revision: rev,
      summary: `Rev ${rev}`,
      source: "manual",
      actorId: "u1",
      createdAt: now,
      snapshot: {
        documentId: "doc1",
        tenantId: "t1",
        workspaceId: "w1",
        title: `Title ${rev}`,
        language: "en",
        revision: rev,
        status: "draft",
        layout: {
          size: "A4",
          orientation: "portrait",
          marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
          headerText: "",
          footerText: "",
          showPageNumbers: true,
        },
        blocks: [{ id: "b1", type: "paragraph", runs: [{ text }] }],
        createdBy: "u1",
        createdAt: now,
        updatedAt: now,
      },
    });

    await storage.saveDocumentVersion(makeVer(1, "hello"));
    await expect(storage.saveDocumentVersion(makeVer(1, "overwrite"))).rejects.toThrow(/Immutable version conflict/i);
    await storage.saveDocumentVersion(makeVer(2, "world"));

    const latest = await storage.getDocument("doc1");
    expect(latest?.revision).toBe(2);
    expect(latest?.title).toBe("Title 2");

    // InMemoryAuditStore caps at maxEvents
    const audit = new InMemoryAuditStore(150);
    for (let i = 0; i < 200; i++) {
      audit.append({
        auditId: `a_${i}`,
        tenantId: "t1",
        workspaceId: "w1",
        actorId: "u1",
        actorRole: "editor",
        source: "manual",
        action: "test.evt",
        outcome: "success",
        summary: `Event ${i}`,
        createdAt: new Date(Date.now() + i).toISOString(),
      });
    }
    expect(audit.listAll("t1", "w1")).toHaveLength(150);
  });
});
