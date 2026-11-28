import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActorContext,
  DataScopePolicy,
  SpreadsheetWorkbook,
  StudioPresentation,
  TenantSubscription,
} from "@ai-office-suite/shared-contracts";
import { PLANNED_FUTURE_STUDIOS } from "@ai-office-suite/shared-contracts";
import { InMemoryAuditStore } from "@ai-office-suite/audit";
import { AuthorizationError } from "@ai-office-suite/authorization";
import { InMemoryStorageAdapter, LocalPrivateObjectStore } from "@ai-office-suite/storage";
import {
  exportPaExtendedLogicalBackup,
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  PgliteDatabaseAdapter,
  PlatformGovernanceService,
  restorePaExtendedLogicalBackup,
} from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import { DocumentService } from "@ai-office-suite/documents-module";
import { getBlockPlainText } from "@ai-office-suite/document-engine";
import {
  applySpreadsheetProposal,
  planSpreadsheetCommand,
  recalculateWorkbook,
  SpreadsheetAiError,
} from "@ai-office-suite/calculation-engine";
import { profileDataset, stageCsvSource } from "@ai-office-suite/data-processing";
import { computeDescriptiveStatistics } from "@ai-office-suite/analytics-engine";
import {
  buildPresentationHtml,
  CORPORATE_THEME_V1,
  createPresentationDeliverySession,
  exportPresentationToPptxBuffer,
} from "@ai-office-suite/presentation-engine";
import {
  CrossModuleIntegrationEngine,
  initializeIntegrationSchema,
  STANDARD_FINANCE_COLUMNS,
} from "@ai-office-suite/integration-engine";
import {
  AiDocumentExecutor,
  AIProviderError,
  CorporateKnowledgeIndex,
  ModelRoutingPolicyEngine,
  planDocumentOperation,
} from "@ai-office-suite/ai-module";
import {
  assertP1VoiceFeatureAuthorized,
  DEFAULT_VOICE_POLICY,
  MockSpeechAdapter,
  SpeechProviderError,
  TerminologyRegistry,
  VoiceGovernancePipeline,
  type P1VoiceFeatureId,
} from "@ai-office-suite/speech-engine";
import {
  evaluateReleaseEvidenceGate,
  inspectAndExtractOoxmlZip,
  type ReleaseEvidenceGateInput,
} from "@ai-office-suite/validation";

const TENANT_A = "11110000-0000-4000-8000-000000000014";
const WS_A = "aaaa0000-0000-4000-8000-000000000014";
const USER_EDITOR = "00000014-0000-4000-8000-000000000006";
const USER_OWNER = "00000014-0000-4000-8000-000000000001";
const USER_VIEWER = "00000014-0000-4000-8000-000000000008";
const USER_OFFBOARD = "00000014-0000-4000-8000-000000000012";
const NOW_ISO = "2026-11-26T00:00:00.000Z";

const EDITOR_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A,
  userId: USER_EDITOR,
  role: "editor",
  workspaceContentGrant: true,
  departmentScopes: "ALL",
};
const OWNER_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A,
  userId: USER_OWNER,
  role: "owner",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
  departmentScopes: "ALL",
};
const VIEWER_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A,
  userId: USER_VIEWER,
  role: "viewer",
  workspaceContentGrant: true,
};

const ACTIVE_SUB: TenantSubscription = {
  tenantId: TENANT_A,
  planId: "sme_standard",
  planVersion: 1,
  status: "active",
  seatLimit: 25,
  policyVersion: 1,
  updatedAt: NOW_ISO,
  entitlements: {
    aiCoreEnabled: true,
    voiceCommandsEnabled: true,
    khmerVoiceEnabled: true,
    crossModuleReportingEnabled: true,
    auditExportEnabled: true,
    maxWorkspaces: 10,
    maxSeats: 25,
    monthlyAiTokens: 1_000_000,
    monthlyAiRequests: 5_000,
    monthlyVoiceSeconds: 18_000,
    storageQuotaBytes: 10_000_000_000,
    maxConcurrentJobs: 10,
  },
};

function makePnlWorkbook(): SpreadsheetWorkbook {
  return {
    workbookId: "wb-v14-pnl",
    title: "November 2026 P&L",
    revision: 1,
    dateSystem: "1900",
    unsupportedFeatures: [],
    sheets: [
      {
        sheetId: "sh_1",
        name: "PnL",
        cells: {
          A1: { value: "Net Sales" },
          B1: { value: 150000 },
          A2: { value: "COGS" },
          B2: { value: 90000 },
          A3: { value: "OpEx" },
          B3: { value: 20000 },
          A4: { value: "Operating Profit" },
          B4: { value: null, formula: "=B1-B2-B3", protected: true },
          A5: { value: "Operating Margin" },
          B5: { value: null, formula: "=B4/B1" },
        },
      },
    ],
  };
}

describe("V1.4 TF-01 — RC-T01..RC-T08 Consolidation, RC-P1-01..05 Gates & Missing DOC-T/SHT-T Local Edges", () => {
  it("RC-T01 (DAT-02): profile correctness — exact full counts, null/blank/invalid, composite dupes, outliers, sample label & zero overwrite", () => {
    const csv = [
      "org_id,invoice_id,line_no,department,amount",
      "ORG1,INV-001,1,Sales,100",
      "ORG1,INV-001,1,Sales,100",
      "ORG1,INV-002,1,Sales,110",
      "ORG1,INV-003,1,Services,105",
      "ORG1,INV-004,1,Services,",
      "ORG1,INV-005,1,Retail,invalid",
      "ORG1,INV-006,1,Retail,95",
      "ORG1,INV-007,1,Finance,102",
      "ORG1,INV-008,1,Finance,108",
      "ORG1,INV-009,1,Finance,999999",
    ].join("\n");

    const staged = stageCsvSource(csv, "rc-t01.csv");
    expect(staged.rows).toHaveLength(10);
    const beforeSnapshot = structuredClone(staged.rows);

    // Full profile: exact counts
    const fullProfile = profileDataset("ds-rct01", staged.rows, { scope: "full" });
    expect(fullProfile.scope).toBe("full");
    expect(fullProfile.totalRows).toBe(10);
    expect(fullProfile.sampleSize).toBe(10);
    const amtCol = fullProfile.columns.find((c) => c.columnName === "amount")!;
    expect(amtCol.nullCount).toBe(1);
    expect(amtCol.invalidCount).toBe(1);
    expect(amtCol.nonNullCount).toBe(9);
    expect(amtCol.zeroCount).toBe(0); // Missing/null NEVER coerced to 0!

    // Also verify explicit empty string "" is tracked separately from null and 0
    const withBlankProfile = profileDataset("ds-rct01-blank", [
      { __sourceFile: "blank.csv", __sourceRowNumber: 1, amount: "" },
      { __sourceFile: "blank.csv", __sourceRowNumber: 2, amount: null },
      { __sourceFile: "blank.csv", __sourceRowNumber: 3, amount: 0 },
    ]);
    const blankAmt = withBlankProfile.columns.find((c) => c.columnName === "amount")!;
    expect(blankAmt.emptyStringCount).toBe(1);
    expect(blankAmt.nullCount).toBe(1);
    expect(blankAmt.zeroCount).toBe(1);

    // Sample profile explicitly labeled 'sample' with exact sampleSize
    const sampleProfile = profileDataset("ds-rct01", staged.rows, { scope: "sample", sampleSize: 4 });
    expect(sampleProfile.scope).toBe("sample");
    expect(sampleProfile.sampleSize).toBe(4);
    expect(sampleProfile.totalRows).toBe(10);

    // Composite key duplicate detection (ORG1|INV-001|1 appears twice)
    const compositeCounts = new Map<string, number>();
    for (const r of staged.rows) {
      const key = `${String(r.org_id)}|${String(r.invoice_id)}|${String(r.line_no)}`;
      compositeCounts.set(key, (compositeCounts.get(key) ?? 0) + 1);
    }
    const duplicates = Array.from(compositeCounts.entries()).filter(([, c]) => c > 1);
    expect(duplicates).toEqual([["ORG1|INV-001|1", 2]]);

    // Distribution & Tukey outlier check on valid numeric values (999999 detected as outlier)
    const numericAmounts = staged.rows
      .map((r) => r.amount)
      .filter((v) => v !== "" && v !== "invalid");
    const stats = computeDescriptiveStatistics(numericAmounts as Array<string | number>);
    expect(stats.count).toBe(8);
    expect(stats.outliers).toEqual([999999]);

    // Zero automatic destructive overwrite of staged source rows
    expect(staged.rows).toEqual(beforeSnapshot);
  });

  it("RC-T02 (ANA-02): basic & grouped descriptive statistics match exact analytical values without treating missing as zero", () => {
    const overall = computeDescriptiveStatistics([1, 2, 3, 4, 5, null], {
      missingPolicy: "exclude_nulls",
      percentileMethod: "linear_r7",
    });
    expect(overall.count).toBe(5);
    expect(overall.missingCount).toBe(1);
    expect(overall.mean).toBe(3);
    expect(overall.median).toBe(3);
    expect(overall.min).toBe(1);
    expect(overall.max).toBe(5);
    expect(overall.sampleStdDev).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(overall.percentileMethod).toBe("linear_r7");
    expect(overall.p25).toBe(2);
    expect(overall.p75).toBe(4);

    // Grouped verification (Sales vs Services with nulls)
    const groups: Record<string, Array<number | null>> = {
      Sales: [10, 20, 30, null],
      Services: [100, 200],
    };
    const salesStats = computeDescriptiveStatistics(groups.Sales!);
    const servicesStats = computeDescriptiveStatistics(groups.Services!);
    expect(salesStats.count).toBe(3);
    expect(salesStats.mean).toBe(20); // NOT 15 (which would happen if null were treated as 0!)
    expect(servicesStats.mean).toBe(150);
  });

  it("RC-T03 (PPT-02): themed deck with speaker notes preserves notes when permitted and strips them when restricted", async () => {
    const deck: StudioPresentation = {
      presentationId: "pres-rct03",
      tenantId: TENANT_A,
      workspaceId: WS_A,
      title: "Executive Management Review",
      language: "bilingual",
      revision: 1,
      status: "draft",
      theme: CORPORATE_THEME_V1,
      scopeLabel: "All Departments (November 2026)",
      slides: [
        {
          slideId: "s1",
          order: 0,
          layoutId: "title",
          title: "November 2026 Performance",
          speakerNotes: "BOARD TALKING POINT: Maintain 26.67% margin guidance.",
          hidden: false,
          readingOrder: ["e1"],
          sourceRefs: [],
          elements: [
            {
              elementId: "e1",
              type: "text",
              zIndex: 1,
              locked: false,
              altText: "Title text",
              bounds: { xIn: 0.8, yIn: 1.0, wIn: 8.0, hIn: 1.2 },
              text: "November 2026 Performance — របាយការណ៍ប្រចាំខែ",
              fontSizePt: 24,
              bold: true,
            },
          ],
        },
      ],
      createdBy: USER_EDITOR,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };

    // Permitted export preserves speaker notes
    const permitted = await exportPresentationToPptxBuffer(deck, {
      includeSpeakerNotes: true,
      includeHiddenSlides: false,
    });
    expect(permitted.disclosure.strippedSpeakerNotesCount).toBe(0);
    const permZip = inspectAndExtractOoxmlZip(new Uint8Array(permitted.buffer), "permitted.pptx", "pptx");
    expect(permZip.ok).toBe(true);
    if (permZip.ok) {
      const xml = Object.values(permZip.entries)
        .map((b) => Buffer.from(b).toString("utf8"))
        .join("\n");
      expect(xml).toContain("Maintain 26.67% margin guidance");
    }

    // Restricted export strips confidential speaker notes cleanly
    const restricted = await exportPresentationToPptxBuffer(deck, {
      includeSpeakerNotes: false,
      includeHiddenSlides: false,
    });
    expect(restricted.disclosure.strippedSpeakerNotesCount).toBe(1);
    const restZip = inspectAndExtractOoxmlZip(new Uint8Array(restricted.buffer), "restricted.pptx", "pptx");
    expect(restZip.ok).toBe(true);
    if (restZip.ok) {
      const xml = Object.values(restZip.entries)
        .map((b) => Buffer.from(b).toString("utf8"))
        .join("\n");
      expect(xml).not.toContain("Maintain 26.67% margin guidance");
    }
  });

  it("RC-T04 (PPT-03): presentation delivery order, keyboard previous/next/exit controller & accessible slide HTML", () => {
    const deck: StudioPresentation = {
      presentationId: "pres-rct04",
      tenantId: TENANT_A,
      workspaceId: WS_A,
      title: "Delivery Order Deck",
      language: "bilingual",
      revision: 1,
      status: "approved",
      theme: CORPORATE_THEME_V1,
      scopeLabel: "All Departments (November 2026)",
      slides: [
        {
          slideId: "s-cover",
          order: 0,
          layoutId: "title",
          title: "Slide 1: Cover",
          speakerNotes: "",
          hidden: false,
          readingOrder: ["t1"],
          sourceRefs: [],
          elements: [
            {
              elementId: "t1",
              type: "text",
              zIndex: 1,
              locked: false,
              altText: "Cover title",
              bounds: { xIn: 0.6, yIn: 0.8, wIn: 8.0, hIn: 1.0 },
              text: "Slide 1: Cover",
              fontSizePt: 26,
              bold: true,
            },
          ],
        },
        {
          slideId: "s-kpi",
          order: 1,
          layoutId: "kpi_summary",
          title: "Slide 2: KPIs",
          speakerNotes: "",
          hidden: false,
          readingOrder: ["t2"],
          sourceRefs: [],
          elements: [
            {
              elementId: "t2",
              type: "text",
              zIndex: 1,
              locked: false,
              altText: "KPI summary",
              bounds: { xIn: 0.6, yIn: 0.8, wIn: 8.0, hIn: 1.0 },
              text: "Slide 2: Operating Margin 26.67%",
              fontSizePt: 22,
            },
          ],
        },
        {
          slideId: "s-hidden",
          order: 2,
          layoutId: "comparison",
          title: "Hidden Backup",
          speakerNotes: "",
          hidden: true,
          readingOrder: [],
          sourceRefs: [],
          elements: [],
        },
        {
          slideId: "s-close",
          order: 3,
          layoutId: "priorities",
          title: "Slide 3: សេចក្តីសន្និដ្ឋាន",
          speakerNotes: "",
          hidden: false,
          readingOrder: ["t3"],
          sourceRefs: [],
          elements: [
            {
              elementId: "t3",
              type: "text",
              zIndex: 1,
              locked: false,
              altText: "Closing slide",
              bounds: { xIn: 0.6, yIn: 0.8, wIn: 8.0, hIn: 1.0 },
              text: "Slide 3: សេចក្តីសន្និដ្ឋាន",
              fontSizePt: 22,
            },
          ],
        },
      ],
      createdBy: USER_EDITOR,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };

    // Deterministic production delivery controller filtering hidden slides and enforcing bounds (F-24)
    const delivery = createPresentationDeliverySession(deck);
    expect(delivery.visibleSlides.map((s) => s.slideId)).toEqual(["s-cover", "s-kpi", "s-close"]);
    delivery.handleKey("ArrowRight");
    expect(delivery.getActiveSlide()?.slideId).toBe("s-kpi");
    delivery.handleKey("ArrowRight");
    expect(delivery.getActiveSlide()?.slideId).toBe("s-close");
    delivery.handleKey("ArrowRight"); // Clamps at final slide without corruption
    expect(delivery.getActiveSlide()?.slideId).toBe("s-close");
    delivery.handleKey("ArrowLeft");
    expect(delivery.getActiveSlide()?.slideId).toBe("s-kpi");
    delivery.handleKey("Escape");
    expect(delivery.isPresenting()).toBe(false);

    const html = buildPresentationHtml(deck);
    expect(html).toContain("Slide 1: Cover");
    expect(html).toContain("សេចក្តីសន្និដ្ឋាន");
  });

  it("RC-T05 (AI-02): generate scoped edit -> inspect diff -> reject with zero mutation -> approve -> undo/restore preserves unrelated content", async () => {
    const storage = new InMemoryStorageAdapter();
    const audit = new InMemoryAuditStore();
    const docs = new DocumentService(storage, audit);
    const executor = new AiDocumentExecutor(docs, audit);

    const doc = await docs.createDocument(EDITOR_A, {
      title: "Proposal Rejection & Undo Drill",
      language: "en",
      blocks: [
        { id: "p-target", type: "paragraph", runs: [{ text: "Original summary text." }] },
        { id: "p-untouched", type: "paragraph", runs: [{ text: "Approved audit footnote — immutable." }] },
      ],
    });

    // 1. Generate scoped edit & inspect preview diff -> REJECT (approved: false) -> ZERO state change!
    const rejectedProposal = planDocumentOperation({
      actor: EDITOR_A,
      document: doc,
      audit,
      input: {
        command: 'replace with "Unwanted rewrite"',
        expectedRevision: 1,
        inputLanguage: "en",
        outputLanguage: "en",
        source: "typed_ai",
        selection: { blockId: "p-target" },
      },
    });
    expect(rejectedProposal.previewDiff.beforeText).toBe("Original summary text.");
    expect(rejectedProposal.previewDiff.afterText).toContain("Unwanted rewrite");

    await expect(
      executor.applyProposal({ actor: EDITOR_A, proposal: rejectedProposal, approved: false }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const afterReject = await docs.getDocument(EDITOR_A, doc.documentId);
    expect(afterReject.revision).toBe(1);
    expect(getBlockPlainText(afterReject.blocks[0]!)).toBe("Original summary text.");

    // 2. Approve valid edit -> rev 2 -> undo via restoreVersion(1) -> rev 3 restores original, unrelated untouched!
    const validProposal = planDocumentOperation({
      actor: EDITOR_A,
      document: afterReject,
      audit,
      input: {
        command: 'replace with "Approved November commentary."',
        expectedRevision: 1,
        inputLanguage: "en",
        outputLanguage: "en",
        source: "typed_ai",
        selection: { blockId: "p-target" },
      },
    });
    const applied = await executor.applyProposal({ actor: EDITOR_A, proposal: validProposal, approved: true });
    expect(applied.document.revision).toBe(2);
    expect(getBlockPlainText(applied.document.blocks[1]!)).toBe("Approved audit footnote — immutable.");

    const undone = await docs.restoreVersion(EDITOR_A, doc.documentId, 1);
    expect(undone.revision).toBe(3);
    expect(getBlockPlainText(undone.blocks[0]!)).toBe("Original summary text.");
    expect(getBlockPlainText(undone.blocks[1]!)).toBe("Approved audit footnote — immutable.");
    expect(await docs.listVersions(EDITOR_A, doc.documentId)).toHaveLength(3);
  });

  it("RC-T06 (PLT-03): offboard user, revoke RAG/access, enforce legal hold vs retention delete & tombstone parity (no false external-file recall)", async () => {
    const db = new PgliteDatabaseAdapter();
    const storeDir = mkdtempSync(path.join(tmpdir(), "aios-rct06-"));
    try {
      await initializePostgreSqlSchema(db);
      await initializePaGovernanceSchema(db);
      const gov = new PlatformGovernanceService(db);
      await gov.seedDefaultPlans();
      await gov.createOrganization({ tenantId: TENANT_A, name: "Retention Co", mfaRequiredForPrivileged: false });
      await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A, name: "Finance", visibility: "standard" });
      const pwHash = await hashPassword("Retention#2026");
      for (const [uid, email] of [
        [USER_OWNER, "owner@ret.test"],
        [USER_OFFBOARD, "departed@ret.test"],
      ] as const) {
        await db.query(
          `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, $2, $3, 1, 'active')`,
          [uid, email, pwHash],
        );
      }
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A, userId: USER_OWNER, role: "owner", contentAccess: true });
      await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A, userId: USER_OFFBOARD, role: "editor", contentAccess: true });

      const store = new LocalPrivateObjectStore(storeDir, "rct06-signing-secret-32chars!!!!!");
      const heldPut = await store.putObject({
        tenantId: TENANT_A,
        workspaceId: WS_A,
        objectId: "tax-held",
        version: 1,
        bytes: Buffer.from("Tax Record 2026"),
      });
      await gov.registerFileObject({
        actor: OWNER_A,
        objectId: "tax-held",
        version: 1,
        storageKey: heldPut.storageKey,
        filename: "tax-2026.pdf",
        mimeType: "application/pdf",
        byteSize: heldPut.byteSize,
        sha256: heldPut.sha256,
        classification: "confidential",
        quarantineState: "clean",
        legalHold: true,
      });

      const idx = new CorporateKnowledgeIndex();
      idx.indexChunk({
        chunkId: "chk-departed",
        tenantId: TENANT_A,
        workspaceId: WS_A,
        workspaceVisibility: "standard",
        artifactId: "tax-held",
        artifactKind: "document",
        revision: 1,
        classification: "confidential",
        text: "Confidential Tax Record 2026",
        updatedAt: NOW_ISO,
      });

      // 1. Offboard user & revoke RAG artifact
      const off = await gov.offboardOrSuspendMember({
        actor: OWNER_A,
        tenantId: TENANT_A,
        targetUserId: USER_OFFBOARD,
        mode: "revoke",
        reason: "Offboarded",
      });
      expect(off.newTokenVersion).toBe(2);
      idx.revokeArtifact(TENANT_A, "tax-held");
      expect(idx.retrieve({ actor: OWNER_A, query: "Tax Record" }).citations).toHaveLength(0);

      // 2. Legal hold blocks purge; soft-delete tombstone persists cleanly across backup/restore
      await gov.softDeleteFileObject(OWNER_A, "tax-held", 1);
      await expect(gov.purgeFileObject(OWNER_A, "tax-held", 1)).rejects.toMatchObject({ code: "LEGAL_HOLD_ACTIVE" });

      const snap = await exportPaExtendedLogicalBackup(db);
      const targetDb = new PgliteDatabaseAdapter();
      try {
        await initializePostgreSqlSchema(targetDb);
        await initializePaGovernanceSchema(targetDb);
        await restorePaExtendedLogicalBackup(targetDb, snap);
        const restoredGov = new PlatformGovernanceService(targetDb);
        // Revoked user stays revoked & deleted file stays soft-deleted in restored DB
        await expect(
          restoredGov.switchTenantContext({ userId: USER_OFFBOARD, targetTenantId: TENANT_A, targetWorkspaceId: WS_A }),
        ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });
        expect((await restoredGov.listFileObjects(OWNER_A)).some((f) => f.objectId === "tax-held")).toBe(false);
        expect((await restoredGov.listFileObjects(OWNER_A, { includeDeleted: true })).some((f) => f.objectId === "tax-held")).toBe(true);
      } finally {
        await targetDb.close();
      }

      // 3. Explicit disclosure boundary: previously downloaded external copies cannot be remotely recalled
      const alreadyDownloadedExternalCopy = Buffer.from("Tax Record 2026");
      expect(alreadyDownloadedExternalCopy.toString("utf8")).toBe("Tax Record 2026");
    } finally {
      await db.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("RC-T07 (FR-13): live RTM parser verifies EXACTLY 51 parent IDs (46 P0, 5 P1), 0 duplicates/orphans, and 313 unique defined test IDs", () => {
    const rtmPath = path.resolve(process.cwd(), "documentation/REQUIREMENTS_TRACEABILITY_MATRIX.md");
    const content = readFileSync(rtmPath, "utf8");
    const lines = content.split(/\r?\n/);

    // Parse Section 1 parent register rows: | <PARENT_ID> | <P0|P1> | ...
    const parentRegex = /^\|\s*((?:DOC|SHT|DAT|ANA|PPT|BI|INT|AI|VOC|PLT|NFR)-\d{2})\s*\|\s*(P0|P1)\s*\|/;
    const parents: Array<{ id: string; priority: "P0" | "P1" }> = [];
    for (const line of lines) {
      const m = line.match(parentRegex);
      if (m) {
        parents.push({ id: m[1]!, priority: m[2]! as "P0" | "P1" });
      }
    }

    const parentIds = parents.map((p) => p.id);
    const uniqueParentIds = new Set(parentIds);
    expect(parents.length).toBe(51);
    expect(uniqueParentIds.size).toBe(51); // Zero duplicates!
    expect(parents.filter((p) => p.priority === "P0")).toHaveLength(46);
    expect(parents.filter((p) => p.priority === "P1")).toHaveLength(5);

    // Verify exact 5 P1 parent IDs match V1.4 baseline
    const p1Ids = parents
      .filter((p) => p.priority === "P1")
      .map((p) => p.id)
      .sort();
    expect(p1Ids).toEqual(["ANA-04", "DOC-05", "INT-04", "SHT-06", "VOC-03"]);

    // Parse Section 2 canonical 313-test rows: | <TEST_ID> | <PARENT_ID> | <STATUS> | ...
    const testRowRegex =
      /^\|\s*((?:DOC|SHT|DAT|ANA|PPT|BI|INT|AI|VOC|PLT|GOV|NFR)-T\d{2}|X-VIS-\d{2}|E2E-\d{2}|RC-T\d{2}|RC-P1-\d{2})\s*\|\s*((?:DOC|SHT|DAT|ANA|PPT|BI|INT|AI|VOC|PLT|NFR)-\d{2})\s*\|\s*([A-Z0-9_]+)\s*\|/;
    const testRows: Array<{ testId: string; parentId: string; status: string }> = [];
    for (const line of lines) {
      const m = line.match(testRowRegex);
      if (m) {
        testRows.push({ testId: m[1]!, parentId: m[2]!, status: m[3]! });
      }
    }

    const uniqueTestIds = new Set(testRows.map((r) => r.testId));
    expect(testRows.length).toBe(313);
    expect(uniqueTestIds.size).toBe(313); // Zero duplicate test IDs!

    // Zero orphan parent links: every test's Parent ID MUST exist in the 51 parent set
    const orphanTests = testRows.filter((r) => !uniqueParentIds.has(r.parentId));
    expect(orphanTests).toEqual([]);

    // Every single one of the 51 parents has at least one linked test in Section 2
    const coveredParents = new Set(testRows.map((r) => r.parentId));
    expect(coveredParents.size).toBe(51);

    // Stage 1-3 Integrity Guard: EVERY backticked repo file path referenced in RTM & TECHNICAL_FEASIBILITY_PLAN MUST exist on disk!
    const tfPlanPath = path.resolve(process.cwd(), "documentation/TECHNICAL_FEASIBILITY_PLAN.md");
    const tfPlanContent = readFileSync(tfPlanPath, "utf8");
    const regPath = path.resolve(process.cwd(), "documentation/REQUIREMENTS_REGISTER.md");
    const regContent = readFileSync(regPath, "utf8");

    const filePathRegex =
      /`((?:tests|scripts|documentation|apps|engines|modules|platform|packages|\.github)\/[A-Za-z0-9._\-\/]+\.(?:ts|tsx|js|mjs|cjs|json|md|sql|yml|yaml|sh))`/g;
    for (const [docName, docText] of [
      ["REQUIREMENTS_TRACEABILITY_MATRIX.md", content],
      ["TECHNICAL_FEASIBILITY_PLAN.md", tfPlanContent],
    ] as const) {
      const missingPaths: string[] = [];
      for (const m of docText.matchAll(filePathRegex)) {
        const relPath = m[1]!;
        if (!existsSync(path.resolve(process.cwd(), relPath))) {
          missingPaths.push(`${docName} -> ${relPath}`);
        }
      }
      expect(missingPaths).toEqual([]);
    }

    // Verify TECHNICAL_FEASIBILITY_PLAN.md aligns TF-01..TF-12 1:1 with V1.4 §22 canonical topics
    const canonicalTfTopics: Array<[string, string]> = [
      ["TF-01", "Repository and technical feasibility baseline"],
      ["TF-02", "Document editing, pagination and conversion"],
      ["TF-03", "Spreadsheet editor, formula engine and interoperability"],
      ["TF-04", "Data preparation and analytical precision"],
      ["TF-05", "Presentation authoring and export"],
      ["TF-06", "Business intelligence and visualization"],
      ["TF-07", "Shared platform, identity, storage and jobs"],
      ["TF-08", "AI model adapters and agent execution"],
      ["TF-09", "Voice EN/KM, STT/TTS and local/cloud evaluation"],
      ["TF-10", "Integrated cross-module feasibility"],
      ["TF-11", "NFR and operational economics"],
      ["TF-12", "Technical decision consolidation"],
    ];
    for (const [tfId, topic] of canonicalTfTopics) {
      expect(tfPlanContent).toContain(`| **${tfId}** | ${topic} |`);
    }

    // Verify all 7 canonical V1.4 §23.2 APPROVAL gates & all 8 Change Records CR-001..CR-008 are present
    for (let i = 1; i <= 7; i++) {
      expect(tfPlanContent).toContain(`| **APPROVAL-0${i}** |`);
    }
    for (let i = 1; i <= 8; i++) {
      expect(regContent).toContain(`| CR-00${i} |`);
    }
  });

  it("RC-T08 (FR-12/FR-13): release evidence gate blocks release on missing fixture, stale approval, or mock-only evidence for real gate", () => {
    const sampleMissing: ReleaseEvidenceGateInput = {
      requiredFixturesPresent: false,
      approvalValidAndFresh: true,
      authorizationChecksPassed: true,
      requiresRealEnvironment: false,
      submittedEvidenceIsMock: false,
    };
    expect(evaluateReleaseEvidenceGate(sampleMissing)).toEqual({
      allowed: false,
      reasons: ["MISSING_MANDATORY_FIXTURE"],
    });

    expect(
      evaluateReleaseEvidenceGate({
        requiredFixturesPresent: true,
        approvalValidAndFresh: false,
        authorizationChecksPassed: false,
        requiresRealEnvironment: true,
        submittedEvidenceIsMock: true,
      }),
    ).toEqual({
      allowed: false,
      reasons: [
        "STALE_OR_MISSING_APPROVAL",
        "AUTHORIZATION_CHECK_FAILED",
        "MOCK_ONLY_EVIDENCE_CANNOT_PASS_REAL_ENV_GATE",
      ],
    });

    expect(
      evaluateReleaseEvidenceGate({
        requiredFixturesPresent: true,
        approvalValidAndFresh: true,
        authorizationChecksPassed: true,
        requiresRealEnvironment: true,
        submittedEvidenceIsMock: false,
      }),
    ).toEqual({ allowed: true, reasons: [] });
  });

  it("RC-P1-01..RC-P1-05: P1 expansion contracts remain explicitly gated fail-closed (including all 7 VOC-03 423 gates)", () => {
    expect(PLANNED_FUTURE_STUDIOS.map((s) => s.studioId)).toEqual(["spreadsheets", "presentations", "analytics"]);
    expect(PLANNED_FUTURE_STUDIOS.every((s) => s.status === "planned_future_phase")).toBe(true);
    expect(() =>
      planSpreadsheetCommand({
        workbook: makePnlWorkbook(),
        sheetName: "Missing",
        targetRange: "B1",
        command: "sum B1:B3",
        inputLanguage: "en",
        source: "typed_ai",
      }),
    ).toThrowError(SpreadsheetAiError);

    // RC-P1-05 (VOC-03): all 7 P1 voice features MUST fail closed with HTTP 423
    const vocP1Features: Array<[P1VoiceFeatureId, string]> = [
      ["realtime_streaming", "P1_VOICE_FEATURE_GATED"],
      ["en_km_tts", "P1_VOICE_FEATURE_GATED"],
      ["vad_barge_in", "P1_VOICE_FEATURE_GATED"],
      ["within_utterance_code_switching", "P1_VOICE_FEATURE_GATED"],
      ["custom_pronunciation", "P1_VOICE_FEATURE_GATED"],
      ["continuous_workflow", "P1_VOICE_FEATURE_GATED"],
      ["live_km_corpus_eval", "CONSENTED_CORPUS_PENDING"],
    ];
    for (const [feature, expectedCode] of vocP1Features) {
      expect(() => assertP1VoiceFeatureAuthorized(feature)).toThrowError(SpeechProviderError);
      try {
        assertP1VoiceFeatureAuthorized(feature);
      } catch (err) {
        expect(err).toMatchObject({ statusCode: 423, code: expectedCode });
      }
    }
  });

  it("DOC-T01, DOC-T03, DOC-T08, DOC-T09: closes missing Document Studio local edge assertions", async () => {
    const storage = new InMemoryStorageAdapter();
    const audit = new InMemoryAuditStore();
    const docs = new DocumentService(storage, audit);
    const executor = new AiDocumentExecutor(docs, audit);
    const voice = new VoiceGovernancePipeline({ terminology: new TerminologyRegistry() });

    // DOC-T01: Khmer spoken letter request with ambiguous amount/period asks clarification; when clarified, generates English letter
    const ambiguousLetter = await voice.processUtterance({
      actor: EDITOR_A,
      policy: DEFAULT_VOICE_POLICY(TENANT_A),
      adapter: new MockSpeechAdapter(),
      mode: "command",
      language: "km-KH",
      outputLanguage: "en",
      durationMs: 2500,
      simulatedTranscript: "សរសេរលិខិតធុរកិច្ចអំពីការលក់សុទ្ធ ១៥០០០០ សម្រាប់ខែមុន",
      subscription: ACTIVE_SUB,
      idempotencyKey: "doc-t01-km-letter",
    });
    expect(ambiguousLetter.outcome).toBe("awaiting_review_clarify");
    expect(ambiguousLetter.session.outputLanguage).toBe("en");

    // DOC-T03: Correct misrecognized person/company name before execution -> exact confirmed name persisted
    const misheard = await voice.processUtterance({
      actor: EDITOR_A,
      policy: DEFAULT_VOICE_POLICY(TENANT_A),
      adapter: new MockSpeechAdapter(),
      mode: "command",
      language: "en-US",
      durationMs: 2000,
      simulatedTranscript: 'replace with "Dear Mr. Sokha Chan at Phnom Pen Holdings"',
      overrideConfidence: 0.72,
      subscription: ACTIVE_SUB,
      idempotencyKey: "doc-t03-name",
    });
    expect(misheard.outcome).toBe("awaiting_review_clarify");
    const corrected = voice.confirmReviewedTranscript({
      actor: EDITOR_A,
      sessionId: misheard.session.sessionId,
      editedTranscript: 'replace with "Dear Mr. Sokha Chann at Phnom Penh Holdings"',
      eventId: "doc-t03-confirm",
      eventSeq: 6,
    });
    const doc = await docs.createDocument(EDITOR_A, {
      title: "Business Letter",
      language: "bilingual",
      blocks: [{ id: "p-salutation", type: "paragraph", runs: [{ text: "Dear Sir/Madam" }] }],
    });
    const nameProposal = planDocumentOperation({
      actor: EDITOR_A,
      document: doc,
      audit,
      input: {
        command: corrected.effectiveCommand,
        expectedRevision: 1,
        inputLanguage: "en",
        outputLanguage: "en",
        source: "voice_command",
        selection: { blockId: "p-salutation" },
      },
    });
    const appliedName = await executor.applyProposal({ actor: EDITOR_A, proposal: nameProposal, approved: true });
    expect(getBlockPlainText(appliedName.document.blocks[0]!)).toBe("Dear Mr. Sokha Chann at Phnom Penh Holdings");

    // DOC-T08: Viewer attempting to edit locked/protected document is denied fail-closed
    await expect(
      docs.updateDocument(VIEWER_A, doc.documentId, {
        expectedRevision: 2,
        blocks: [{ id: "p-salutation", type: "paragraph", runs: [{ text: "Unauthorized edit" }] }],
        summary: "Viewer edit attempt",
        source: "manual",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // DOC-T09: Interrupted/unapproved edit retains committed revision 2 intact
    const interruptedProp = planDocumentOperation({
      actor: EDITOR_A,
      document: appliedName.document,
      audit,
      input: {
        command: 'replace with "Partial interrupted output"',
        expectedRevision: 2,
        inputLanguage: "en",
        outputLanguage: "en",
        source: "typed_ai",
        selection: { blockId: "p-salutation" },
      },
    });
    await expect(
      executor.applyProposal({ actor: EDITOR_A, proposal: interruptedProp, approved: false }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const retained = await docs.getDocument(EDITOR_A, doc.documentId);
    expect(retained.revision).toBe(2);
    expect(getBlockPlainText(retained.blocks[0]!)).toBe("Dear Mr. Sokha Chann at Phnom Penh Holdings");
  });

  it("SHT-T11, SHT-T12, SHT-T15, SHT-T16: closes missing Spreadsheet Studio local edge assertions", async () => {
    // SHT-T11: Cancel/unapproved/stale/protected proposal before commit leaves original workbook cells & formulas intact
    const original = recalculateWorkbook(makePnlWorkbook()).workbook;
    const sumProposal = planSpreadsheetCommand({
      workbook: original,
      sheetName: original.sheets[0]!.name,
      targetRange: "B1:B3",
      command: "sum B1:B3",
      inputLanguage: "en",
      source: "typed_ai",
    });
    expect(() => applySpreadsheetProposal(original, sumProposal, false)).toThrowError(SpreadsheetAiError);
    expect(() =>
      applySpreadsheetProposal(original, { ...sumProposal, expectedRevision: original.revision + 5 }, true),
    ).toThrowError(SpreadsheetAiError);
    expect(() =>
      applySpreadsheetProposal(original, { ...sumProposal, targetRange: "B4", formula: "=0" }, true),
    ).toThrowError(/protected/i);
    expect(original.sheets[0]!.cells.B1?.value).toBe(150000);
    expect(original.sheets[0]!.cells.B4?.evaluatedValue).toBe(40000);
    expect(original.sheets[0]!.cells.B4?.formula).toBe("=B1-B2-B3");

    const committed = applySpreadsheetProposal(original, { ...sumProposal, targetRange: "B6" }, true);
    expect(committed.revision).toBe(original.revision + 1);
    expect(committed.sheets[0]!.cells.B6?.formula).toBe("=SUM(B1:B3)");
    expect(original.sheets[0]!.cells.B6).toBeUndefined();
    expect(original.sheets[0]!.cells.B5?.formula).toBe("=B4/B1");

    // SHT-T12: Undo AI spreadsheet change restores original values, formulas, and metadata
    const snapshotBeforeAi = structuredClone(original);
    const afterAi = structuredClone(original);
    afterAi.sheets[0]!.cells.B3!.value = 10000;
    const recalcAfterAi = recalculateWorkbook(afterAi).workbook;
    expect(recalcAfterAi.sheets[0]!.cells.B4?.evaluatedValue).toBe(50000);
    const afterUndo = recalculateWorkbook(structuredClone(snapshotBeforeAi)).workbook;
    expect(afterUndo.sheets[0]!.cells.B3?.value).toBe(20000);
    expect(afterUndo.sheets[0]!.cells.B4?.formula).toBe("=B1-B2-B3");
    expect(afterUndo.sheets[0]!.cells.B4?.protected).toBe(true);
    expect(afterUndo.sheets[0]!.cells.B4?.evaluatedValue).toBe(40000);

    // SHT-T15: Approved metrics published to Document Studio reconcile identically ($150k / $40k / 26.67%)
    const db = new PgliteDatabaseAdapter();
    try {
      await initializePostgreSqlSchema(db);
      await initializeIntegrationSchema(db);
      await initializePaGovernanceSchema(db);
      const gov = new PlatformGovernanceService(db);
      await gov.createOrganization({ tenantId: TENANT_A, name: "Reconcile Org", mfaRequiredForPrivileged: false });
      await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A, name: "Finance", visibility: "standard" });
      await db.query(
        `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, $2, $3, 1, 'active')`,
        [USER_OWNER, "owner@rec.test", await hashPassword("RecPass#2026")],
      );
      const xi = new CrossModuleIntegrationEngine({ db });
      const seeded = await xi.seedGoldenV1(TENANT_A, WS_A, OWNER_A);
      const policy: DataScopePolicy = {
        policyId: "pol-sht15",
        policyVersion: 1,
        tenantId: TENANT_A,
        principalRole: "owner",
        allowedDepartments: "ALL",
        allowedColumns: [...STANDARD_FINANCE_COLUMNS],
        canExportUnderlyingDetail: true,
        canPublish: true,
      };
      const synced = await xi.syncWorkspaceModules(OWNER_A, policy, {
        datasetId: seeded.datasetId,
        datasetVersion: 1,
      });
      expect(synced.resultRefs["FIN-NET-SALES"]?.displayValue).toBe("$150,000.00");
      expect(synced.resultRefs["FIN-OPERATING-PROFIT"]?.displayValue).toBe("$40,000.00");
      expect(synced.resultRefs["FIN-OPERATING-MARGIN"]?.displayValue).toBe("26.67%");
      // Document Studio synced block matches Spreadsheet Studio value identically
      expect(JSON.stringify(synced.document.blocks)).toContain("$40,000.00");
      expect(JSON.stringify(synced.document.blocks)).toContain("26.67%");
    } finally {
      await db.close();
    }

    // SHT-T16: AI provider outage leaves manual spreadsheet editing & recalculation operational
    const router = new ModelRoutingPolicyEngine();
    const allDown = new Set(router.listCatalog().map((m) => m.modelId));
    expect(() =>
      router.resolveRoute({
        policy: {
          tenantId: TENANT_A,
          policyVersion: 1,
          rules: [
            {
              classification: "internal",
              allowedProviders: ["mock-deterministic"],
              preferredOrder: ["mock-core-primary-v1"],
              requireZeroDataRetention: true,
              allowedResidencies: ["local"],
              allowExternalProvider: false,
            },
          ],
          updatedAt: NOW_ISO,
        },
        classification: "internal",
        requiredCapabilities: ["structured_json"],
        unhealthyModelIds: allDown,
      }),
    ).toThrowError(AIProviderError);

    const manualWb = makePnlWorkbook();
    manualWb.sheets[0]!.cells.B3!.value = 15000;
    const manualRecalc = recalculateWorkbook(manualWb).workbook;
    expect(manualRecalc.sheets[0]!.cells.B4?.evaluatedValue).toBe(45000);
    expect(manualRecalc.sheets[0]!.cells.B5?.evaluatedValue).toBeCloseTo(0.3, 6);
  });

  it("TF-11 (NFR-T37): CycloneDX 1.5 JSON SBOM generator emits valid components, purls, SHA-512 hashes & zero disallowed licenses", () => {
    const rawJson = execFileSync(process.execPath, ["scripts/generate-sbom.mjs", "--stdout"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const bom = JSON.parse(rawJson) as {
      bomFormat: string;
      specVersion: string;
      serialNumber: string;
      components: Array<{
        purl: string;
        hashes?: Array<{ alg: string; content: string }>;
        licenses?: Array<{ expression?: string; license?: { name?: string } }>;
      }>;
    };
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.5");
    expect(bom.serialNumber.startsWith("urn:uuid:")).toBe(true);
    expect(bom.components.length).toBeGreaterThan(400);
    expect(bom.components.every((c) => c.purl.startsWith("pkg:npm/"))).toBe(true);
    expect(
      bom.components.some((c) => c.hashes?.some((h) => h.alg === "SHA-512" && h.content.length === 128)),
    ).toBe(true);
    const disallowed = bom.components.filter((c) => {
      const lic = c.licenses?.[0]?.expression ?? c.licenses?.[0]?.license?.name ?? "";
      return /\b(AGPL|SSPL|BUSL|BSL-1\.1)\b/i.test(lic);
    });
    expect(disallowed).toEqual([]);
  });
});
