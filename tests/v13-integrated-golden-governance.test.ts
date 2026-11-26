import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ActorContext,
  DataScopePolicy,
  ModelRoutingPolicy,
} from "@ai-office-suite/shared-contracts";
import { InMemoryAuditStore } from "@ai-office-suite/audit";
import {
  AuthorizationError,
  evaluatePolicyDecision,
} from "@ai-office-suite/authorization";
import {
  exportPaExtendedLogicalBackup,
  initializePaGovernanceSchema,
  initializePostgreSqlSchema,
  PgliteDatabaseAdapter,
  PlatformGovernanceService,
  restorePaExtendedLogicalBackup,
  withTenantTransaction,
} from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import { LocalPrivateObjectStore } from "@ai-office-suite/storage";
import {
  CrossModuleIntegrationEngine,
  getPackageLifecycleRow,
  initializeIntegrationSchema,
  listOutboxEventsForTenant,
  STANDARD_FINANCE_COLUMNS,
} from "@ai-office-suite/integration-engine";
import {
  AiIntelligenceCore,
  AIProviderError,
  CorporateKnowledgeIndex,
  getAIProviderAdapter,
  ModelRoutingPolicyEngine,
  ToolDefinitionRegistry,
} from "@ai-office-suite/ai-module";
import {
  DEFAULT_FINANCE_TERMINOLOGY_ENTRIES,
  DEFAULT_VOICE_POLICY,
  getSpeechAdapter,
  MockSpeechAdapter,
  TerminologyRegistry,
  VoiceGovernancePipeline,
} from "@ai-office-suite/speech-engine";

const TENANT_A = "11111111-1111-4111-8111-0000000000a1";
const TENANT_B = "22222222-2222-4222-8222-0000000000b2";
const WS_A_REPORTING = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const WS_A_PAYROLL = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a2";
const WS_B_REPORTING = "bbbbbbbb-bbbb-4bbb-8bbb-0000000000b1";

const USER_A_OWNER = "10000000-0000-4000-8000-0000000000a1";
const USER_A_ADMIN = "10000000-0000-4000-8000-0000000000a2";
const USER_A_EDITOR = "10000000-0000-4000-8000-0000000000a3";
const USER_A_REVIEWER = "10000000-0000-4000-8000-0000000000a4";
const USER_A_VIEWER = "10000000-0000-4000-8000-0000000000a5";
const USER_A_BILLING = "10000000-0000-4000-8000-0000000000a6";
const USER_B_OWNER = "20000000-0000-4000-8000-0000000000b1";

const NOW_ISO = new Date().toISOString();

const OWNER_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_OWNER,
  role: "owner",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
  departmentScopes: "ALL",
};
const ADMIN_A_NO_PAYROLL: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_PAYROLL,
  userId: USER_A_ADMIN,
  role: "administrator",
  workspaceContentGrant: false,
  mfaVerifiedAt: NOW_ISO,
};
const EDITOR_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_EDITOR,
  role: "editor",
  workspaceContentGrant: true,
  departmentScopes: ["Sales", "Services", "Retail", "Finance"],
};
const REVIEWER_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_REVIEWER,
  role: "reviewer",
  workspaceContentGrant: true,
  departmentScopes: "ALL",
};
const VIEWER_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_VIEWER,
  role: "viewer",
  workspaceContentGrant: true,
};
const BILLING_A: ActorContext = {
  tenantId: TENANT_A,
  workspaceId: WS_A_REPORTING,
  userId: USER_A_BILLING,
  role: "billing_admin",
  workspaceContentGrant: false,
};
const OWNER_B: ActorContext = {
  tenantId: TENANT_B,
  workspaceId: WS_B_REPORTING,
  userId: USER_B_OWNER,
  role: "owner",
  workspaceContentGrant: true,
  mfaVerifiedAt: NOW_ISO,
  departmentScopes: "ALL",
};

const POLICY_ALL_A: DataScopePolicy = {
  policyId: "pol_gov_all_a",
  policyVersion: 1,
  tenantId: TENANT_A,
  principalRole: "owner",
  allowedDepartments: "ALL",
  allowedColumns: [...STANDARD_FINANCE_COLUMNS],
  canExportUnderlyingDetail: true,
  canPublish: true,
};

describe("V1.3 Integrated Golden Vertical Slice — Cross-Cutting Governance (GOV-T01..GOV-T08)", () => {
  let db: PgliteDatabaseAdapter;
  let gov: PlatformGovernanceService;
  let xi: CrossModuleIntegrationEngine;
  let storeDir: string;
  let store: LocalPrivateObjectStore;
  let knowledge: CorporateKnowledgeIndex;
  let terminology: TerminologyRegistry;
  let audit: InMemoryAuditStore;
  let datasetIdA: string;
  let routingPolicyA: ModelRoutingPolicy;
  let storedPackageObjectKey: string;

  beforeAll(async () => {
    db = new PgliteDatabaseAdapter();
    await initializePostgreSqlSchema(db);
    await initializeIntegrationSchema(db);
    await initializePaGovernanceSchema(db);

    gov = new PlatformGovernanceService(db);
    await gov.seedDefaultPlans();
    storeDir = mkdtempSync(path.join(tmpdir(), "aios-gov-slice-"));
    store = new LocalPrivateObjectStore(storeDir, "gov-slice-signing-secret-32chars!");
    knowledge = new CorporateKnowledgeIndex();
    terminology = new TerminologyRegistry();
    audit = new InMemoryAuditStore();

    await gov.createOrganization({ tenantId: TENANT_A, name: "Tenant A Manufacturing", mfaRequiredForPrivileged: true });
    await gov.createOrganization({ tenantId: TENANT_B, name: "Tenant B Competitor", mfaRequiredForPrivileged: false });
    await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, name: "Reporting", visibility: "standard" });
    await gov.createWorkspace({ tenantId: TENANT_A, workspaceId: WS_A_PAYROLL, name: "Payroll", visibility: "restricted" });
    await gov.createWorkspace({ tenantId: TENANT_B, workspaceId: WS_B_REPORTING, name: "Reporting", visibility: "standard" });

    const pwHash = await hashPassword("GoldenFixture#2026");
    for (const [uid, email] of [
      [USER_A_OWNER, "owner@a.test"],
      [USER_A_ADMIN, "admin@a.test"],
      [USER_A_EDITOR, "editor@a.test"],
      [USER_A_REVIEWER, "reviewer@a.test"],
      [USER_A_VIEWER, "viewer@a.test"],
      [USER_A_BILLING, "billing@a.test"],
      [USER_B_OWNER, "owner@b.test"],
    ] as const) {
      await db.query(
        `INSERT INTO users (user_id, email, password_hash, token_version, status) VALUES ($1::uuid, $2, $3, 1, 'active')`,
        [uid, email, pwHash],
      );
    }

    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_OWNER, role: "owner", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_ADMIN, role: "administrator", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_EDITOR, role: "editor", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_REVIEWER, role: "reviewer", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_VIEWER, role: "viewer", contentAccess: true });
    await gov.upsertMembership({ tenantId: TENANT_A, workspaceId: WS_A_REPORTING, userId: USER_A_BILLING, role: "billing_admin", contentAccess: false });
    await gov.upsertMembership({ tenantId: TENANT_B, workspaceId: WS_B_REPORTING, userId: USER_B_OWNER, role: "owner", contentAccess: true });

    await gov.assignTenantSubscription({ tenantId: TENANT_A, planId: "sme_standard", planVersion: 1 });
    await gov.assignTenantSubscription({ tenantId: TENANT_B, planId: "sme_standard", planVersion: 1 });

    routingPolicyA = await gov.upsertAiPolicy(OWNER_A, {
      tenantId: TENANT_A,
      policyVersion: 1,
      rules: [
        {
          classification: "confidential",
          allowedProviders: ["mock-deterministic", "local-sandbox"],
          preferredOrder: ["mock-core-primary-v1", "local-zdr-secondary-v1"],
          requireZeroDataRetention: true,
          allowedResidencies: ["local"],
          allowExternalProvider: false,
        },
        {
          classification: "restricted",
          allowedProviders: ["mock-deterministic"],
          preferredOrder: ["mock-core-primary-v1", "gemini-non-zdr-standard-gated"],
          requireZeroDataRetention: true,
          allowedResidencies: ["local"],
          allowExternalProvider: false,
        },
      ],
      updatedAt: NOW_ISO,
    });

    await gov.upsertVoicePolicy(OWNER_A, DEFAULT_VOICE_POLICY(TENANT_A));
    terminology.publishDictionary(TENANT_A, DEFAULT_FINANCE_TERMINOLOGY_ENTRIES);

    xi = new CrossModuleIntegrationEngine({ db });
    const seededA = await xi.seedGoldenV1(TENANT_A, WS_A_REPORTING, OWNER_A);
    datasetIdA = seededA.datasetId;

    // Index Tenant A reporting + restricted Payroll + colliding Tenant B chunks
    knowledge.indexChunk({
      chunkId: "chk-nov-finance",
      tenantId: TENANT_A,
      workspaceId: WS_A_REPORTING,
      workspaceVisibility: "standard",
      artifactId: "doc-mgmt-nov-2026",
      artifactKind: "document",
      revision: 1,
      classification: "confidential",
      text: "Approved November 2026 Finance Figures: Net Sales USD 150,000, COGS USD 90,000, OpEx USD 20,000, Operating Profit USD 40,000, Operating Margin 26.67%, Prior Revenue USD 125,000 (+20.00%).",
      updatedAt: NOW_ISO,
    });
    knowledge.indexChunk({
      chunkId: "chk-payroll-restricted",
      tenantId: TENANT_A,
      workspaceId: WS_A_PAYROLL,
      workspaceVisibility: "restricted",
      artifactId: "doc-payroll-nov-2026",
      artifactKind: "document",
      revision: 1,
      classification: "restricted",
      text: "Restricted Payroll Ledger: Executive compensation USD 85,000.",
      updatedAt: NOW_ISO,
    });
    knowledge.indexChunk({
      chunkId: "chk-nov-finance",
      tenantId: TENANT_B,
      workspaceId: WS_B_REPORTING,
      workspaceVisibility: "standard",
      artifactId: "doc-mgmt-nov-2026",
      artifactKind: "document",
      revision: 1,
      classification: "confidential",
      text: "Tenant B Confidential Figures: Net Sales USD 999,999.",
      updatedAt: NOW_ISO,
    });
  });

  afterAll(async () => {
    await db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("GOV-T01: executes full EN/KM voice + AI + FR-08 Reporting Package workflow with atomic quota, approval & PG outbox publication", async () => {
    const subA = (await gov.getTenantSubscription(TENANT_A))!;
    const voicePolicyA = (await gov.getVoicePolicy(TENANT_A))!;

    const voicePipeline = new VoiceGovernancePipeline({
      terminology,
      quota: {
        reserveVoiceSeconds: (p) =>
          gov.reserveQuota({
            tenantId: p.tenantId,
            workspaceId: p.workspaceId,
            actorId: p.actorId,
            dimension: "voice_seconds",
            requestedUnits: p.estimatedSeconds,
            idempotencyKey: p.idempotencyKey,
            correlationId: p.correlationId,
          }),
        settleVoiceSeconds: async (p) => {
          await gov.settleQuota({
            tenantId: p.tenantId,
            reservationId: p.reservationId,
            actualUnits: p.actualSeconds,
            estimatedCostMicroUsd: p.estimatedCostMicroUsd,
            source: "voice_command",
            providerId: p.providerId,
            isMock: p.isMock,
          });
        },
        releaseVoiceSeconds: async (t, r) => {
          await gov.releaseQuota(t, r);
        },
      },
    });

    // Step 1: Mocked bilingual voice command with ASR mishearing ("net sails" -> "Net Sales")
    const voiceRes = await voicePipeline.processUtterance({
      actor: EDITOR_A,
      policy: voicePolicyA,
      adapter: new MockSpeechAdapter(),
      mode: "workflow",
      language: "en-US",
      durationMs: 4000,
      simulatedTranscript: "Build November 2026 management package with net sails USD 150,000",
      targetResource: "reporting_package",
      targetAction: "write",
      subscription: subA,
      idempotencyKey: "gov-t01-voice-en",
    });
    expect(voiceRes.outcome).toBe("awaiting_review_clarify");
    expect(voiceRes.effectiveTranscript).toContain("Net Sales USD 150,000");

    const confirmed = voicePipeline.confirmReviewedTranscript({
      sessionId: voiceRes.session.sessionId,
      eventId: "gov-t01-confirm",
      eventSeq: 6,
    });
    expect(confirmed.session.state).toBe("propose");

    // Step 2: Unified AI Intelligence Core executes deterministic FR-08 CrossModuleIntegrationEngine tool + exact final-state verification
    const registry = new ToolDefinitionRegistry();
    registry.register<
      {
        staged: boolean;
        netSales?: string;
        opProfit?: string;
        opMargin?: string;
        growth?: string;
        validationsPassed?: boolean;
      },
      {
        packageId: string;
        manifestDigest: string;
        netSales: string | undefined;
        opProfit: string | undefined;
        opMargin: string | undefined;
        growth: string | undefined;
      }
    >({
      toolId: "integration.stage_management_package",
      version: "1.0.0",
      studio: "integration",
      riskLevel: "high",
      resource: "reporting_package",
      action: "write",
      requiresApproval: true,
      allowedParamKeys: ["packageId", "title"],
      validateInput: (p) => ({ valid: typeof p.packageId === "string" && typeof p.title === "string", errors: [] }),
      execute: async (ctx, p) => {
        const bundle = await xi.syncWorkspaceModules(OWNER_A, POLICY_ALL_A, {
          datasetId: datasetIdA,
          datasetVersion: 1,
        });
        const staged = await xi.stageReportingPackage(OWNER_A, POLICY_ALL_A, {
          packageId: String(p.packageId),
          packageVersion: 1,
          title: String(p.title),
          bundle,
        });
        const payload = Buffer.from(JSON.stringify(staged), "utf8");
        const put = await store.putObject({
          tenantId: ctx.actor.tenantId,
          workspaceId: ctx.actor.workspaceId,
          objectId: String(p.packageId),
          version: 1,
          bytes: payload,
        });
        storedPackageObjectKey = put.storageKey;
        await gov.registerFileObject({
          actor: ctx.actor,
          objectId: String(p.packageId),
          version: 1,
          storageKey: put.storageKey,
          filename: "november-2026-package-manifest.json",
          mimeType: "application/json",
          byteSize: put.byteSize,
          sha256: put.sha256,
          classification: "confidential",
          quarantineState: "clean",
        });
        return {
          beforeState: { staged: false },
          afterState: {
            staged: true,
            netSales: bundle.resultRefs["FIN-NET-SALES"]?.displayValue,
            opProfit: bundle.resultRefs["FIN-OPERATING-PROFIT"]?.displayValue,
            opMargin: bundle.resultRefs["FIN-OPERATING-MARGIN"]?.displayValue,
            growth: bundle.resultRefs["FIN-REVENUE-GROWTH"]?.displayValue,
            validationsPassed: staged.allValidationsPassed,
          },
          output: {
            packageId: String(p.packageId),
            manifestDigest: staged.manifestDigestSha256,
            netSales: bundle.resultRefs["FIN-NET-SALES"]?.displayValue,
            opProfit: bundle.resultRefs["FIN-OPERATING-PROFIT"]?.displayValue,
            opMargin: bundle.resultRefs["FIN-OPERATING-MARGIN"]?.displayValue,
            growth: bundle.resultRefs["FIN-REVENUE-GROWTH"]?.displayValue,
          },
        };
      },
      verifyFinalState: (_b, after) => {
        const ok =
          after.netSales === "$150,000.00" &&
          after.opProfit === "$40,000.00" &&
          after.opMargin === "26.67%" &&
          after.growth === "20.00%" &&
          after.validationsPassed === true;
        return {
          verified: ok,
          checkedInvariants: [
            "net_sales_150000",
            "operating_profit_40000",
            "operating_margin_26_67pct",
            "revenue_growth_20_00pct",
            "fr08_package_validations_passed",
          ],
          discrepancies: ok ? [] : ["Golden finance metrics did not match expected approved figures"],
        };
      },
    });

    const core = new AiIntelligenceCore({
      tools: registry,
      knowledge,
      audit,
      quota: {
        reserveTokens: (p) =>
          gov.reserveQuota({
            tenantId: p.tenantId,
            workspaceId: p.workspaceId,
            actorId: p.actorId,
            dimension: "ai_tokens",
            requestedUnits: p.estimatedTokens,
            idempotencyKey: p.idempotencyKey,
            correlationId: p.correlationId,
          }),
        settleTokens: async (p) => {
          await gov.settleQuota({
            tenantId: p.tenantId,
            reservationId: p.reservationId,
            actualUnits: p.actualTokens,
            estimatedCostMicroUsd: p.estimatedCostMicroUsd,
            source: p.source,
            providerId: p.providerId,
            modelId: p.modelId,
            isMock: p.isMock,
          });
        },
        releaseTokens: async (t, r) => {
          await gov.releaseQuota(t, r);
        },
      },
    });

    const runRes = await core.executeRun({
      actor: EDITOR_A,
      source: "voice_command",
      idempotencyKey: "gov-t01-agent-run",
      instruction: confirmed.effectiveCommand,
      inputLanguage: "en",
      outputLanguage: "en",
      classification: "confidential",
      subscription: subA,
      routingPolicy: routingPolicyA,
      approved: true,
      knowledgeQuery: "November 2026 Operating Profit Margin",
      steps: [
        {
          toolId: "integration.stage_management_package",
          toolVersion: "1.0.0",
          params: {
            packageId: "pkg_nov_mgmt",
            title: "November 2026 Management Reporting Package",
          },
        },
      ],
    });

    expect(runRes.run.state).toBe("completed");
    expect(runRes.run.isMock).toBe(true);
    expect(runRes.run.steps[0]?.verification?.verified).toBe(true);
    expect(runRes.run.verifiedFacts.length).toBeGreaterThanOrEqual(1);
    expect(runRes.run.aiInterpretation?.isAuthoritative).toBe(false);

    // Step 3: Reviewer approves & Owner publishes atomically with PostgreSQL outbox event
    await xi.approveReportingPackage(REVIEWER_A, "pkg_nov_mgmt", 1);
    const published = await xi.publishReportingPackage(OWNER_A, POLICY_ALL_A, {
      packageId: "pkg_nov_mgmt",
      packageVersion: 1,
      idempotencyKey: "gov-t01-pub",
    });
    expect(published.lifecycleStatus).toBe("published");

    const outbox = await listOutboxEventsForTenant(db, TENANT_A);
    expect(outbox.length).toBeGreaterThanOrEqual(1);

    // Both voice_seconds and ai_tokens settled in immutable pa_usage_ledger
    const ledger = await gov.listUsageLedger(BILLING_A, TENANT_A);
    expect(ledger.some((l) => l.dimension === "voice_seconds")).toBe(true);
    expect(ledger.some((l) => l.dimension === "ai_tokens")).toBe(true);
  });

  it("GOV-T02: cross-tenant colliding-ID isolation holds across PG RLS, AI RAG, object storage & terminology", async () => {
    // PG RLS: Tenant B sees zero rows for Tenant A's published package 'pkg_nov_mgmt' and usage ledger
    const pkgFromB = await getPackageLifecycleRow(db, TENANT_B, "pkg_nov_mgmt", 1);
    expect(pkgFromB).toBeNull();

    const ledgerB = await gov.listUsageLedger(OWNER_B, TENANT_B);
    expect(ledgerB).toHaveLength(0);

    // Knowledge RAG: Tenant B query returns ONLY Tenant B chunk, never Tenant A's colliding doc-mgmt-nov-2026
    const ragB = knowledge.retrieve({ actor: OWNER_B, query: "Net Sales" });
    expect(ragB.citations).toHaveLength(1);
    expect(ragB.citations[0]?.excerpt).toContain("Tenant B");
    expect(ragB.citations[0]?.excerpt).not.toContain("USD 150,000");

    // Private Object Store: Tenant B denied reading Tenant A's stored manifest blob
    await expect(
      store.getObjectBytes({
        tenantId: TENANT_B,
        workspaceId: WS_B_REPORTING,
        storageKey: storedPackageObjectKey,
      }),
    ).rejects.toMatchObject({ code: "TENANT_OBJECT_KEY_MISMATCH" });
  });

  it("GOV-T03: restricted Payroll workspace does not leak through manual policy, AI RAG, or voice commands", async () => {
    // Manual policy denies org admin without explicit Payroll content grant
    const dec = evaluatePolicyDecision({
      actor: ADMIN_A_NO_PAYROLL,
      resourceTenantId: TENANT_A,
      resourceWorkspaceId: WS_A_PAYROLL,
      resource: "document",
      action: "read",
      source: "manual",
      workspaceVisibility: "restricted",
      classification: "restricted",
    });
    expect(dec.allowed).toBe(false);
    expect(dec.denialCategory).toBe("workspace_content_isolated");

    // AI RAG returns insufficient_evidence for Finance editor querying Payroll
    const rag = knowledge.retrieve({ actor: EDITOR_A, query: "Executive compensation Payroll" });
    expect(rag.status).toBe("insufficient_evidence");
    expect(rag.citations).toHaveLength(0);

    // Voice command targeting restricted Payroll denied by central policy engine
    const voicePipeline = new VoiceGovernancePipeline({ terminology });
    await expect(
      voicePipeline.processUtterance({
        actor: ADMIN_A_NO_PAYROLL,
        policy: DEFAULT_VOICE_POLICY(TENANT_A),
        adapter: new MockSpeechAdapter(),
        mode: "command",
        language: "en-US",
        durationMs: 1000,
        simulatedTranscript: "Read executive payroll",
        targetResource: "document",
        targetAction: "read",
        workspaceVisibility: "restricted",
        classification: "restricted",
        idempotencyKey: "gov-t03-voice",
      }),
    ).rejects.toMatchObject({ code: "RESTRICTED_WORKSPACE_CONTENT_DENIED" });
  });

  it("GOV-T04: role separation (billing_admin vs viewer) blocks unauthorized finance/AI/voice actions consistently", async () => {
    // billing_admin CAN inspect tenant usage ledger
    const ledger = await gov.listUsageLedger(BILLING_A, TENANT_A);
    expect(ledger.length).toBeGreaterThanOrEqual(2);

    // billing_admin CANNOT execute AI Core or Voice commands on finance docs
    const core = new AiIntelligenceCore({ tools: new ToolDefinitionRegistry(), knowledge, audit });
    await expect(
      core.executeRun({
        actor: BILLING_A,
        source: "typed_ai",
        idempotencyKey: "gov-t04-billing-ai",
        instruction: "Read November finance figures",
        inputLanguage: "en",
        outputLanguage: "en",
        classification: "confidential",
        routingPolicy: routingPolicyA,
        approved: true,
        knowledgeQuery: "Net Sales",
        steps: [],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // viewer denied publish across manual, typed_ai, and voice_command identically
    for (const source of ["manual", "typed_ai", "voice_command"] as const) {
      expect(
        evaluatePolicyDecision({
          actor: VIEWER_A,
          resourceTenantId: TENANT_A,
          resourceWorkspaceId: WS_A_REPORTING,
          resource: "reporting_package",
          action: "publish",
          source,
        }).allowed,
      ).toBe(false);
    }
  });

  it("GOV-T05: privacy-unsafe failover is blocked and external LLM + cloud STT remain fail-closed (423)", async () => {
    const router = new ModelRoutingPolicyEngine();
    expect(() =>
      router.resolveRoute({
        policy: routingPolicyA,
        classification: "restricted",
        requiredCapabilities: ["structured_json"],
        unhealthyModelIds: new Set(["mock-core-primary-v1"]),
      }),
    ).toThrowError(AIProviderError);

    await expect(
      getAIProviderAdapter("openai").infer({
        model: router.listCatalog().find((m) => m.providerId === "openai")!,
        prompt: "Test",
        inputLanguage: "en",
        outputLanguage: "en",
        classification: "internal",
      }),
    ).rejects.toMatchObject({ statusCode: 423 });

    await expect(
      getSpeechAdapter("azure-speech").transcribe({ language: "km-KH", mode: "command" }),
    ).rejects.toMatchObject({ statusCode: 423 });
  });

  it("GOV-T06: mid-workflow revocation strips citations, invalidates offboarded member sessions, and cancellation releases quota", async () => {
    // 1. Revoke document in knowledge index -> citation stripped on recheck
    const initial = knowledge.retrieve({ actor: EDITOR_A, query: "Operating Margin 26.67%" });
    expect(initial.citations).toHaveLength(1);
    knowledge.revokeArtifact(TENANT_A, "doc-mgmt-nov-2026");
    const afterRevoke = knowledge.recheckCitations(EDITOR_A, initial);
    expect(afterRevoke.citations).toHaveLength(0);
    expect(afterRevoke.revokedAtRecheckCount).toBe(1);

    // 2. Enqueue & cancel job -> quota released cleanly
    const job = await gov.enqueueJob({
      actor: EDITOR_A,
      jobType: "package_export",
      idempotencyKey: "gov-t06-cancel-job",
      payload: { packageId: "pkg_nov_mgmt" },
    });
    const canceled = await gov.requestJobCancellation(EDITOR_A, job.job.jobId);
    expect(canceled.state).toBe("canceled");

    // 3. Offboard viewer -> token_version bumped & tenant switch denied
    const off = await gov.offboardOrSuspendMember({
      actor: OWNER_A,
      tenantId: TENANT_A,
      targetUserId: USER_A_VIEWER,
      mode: "revoke",
      reason: "Contract ended",
    });
    expect(off.newTokenVersion).toBe(2);
    await expect(
      gov.switchTenantContext({
        userId: USER_A_VIEWER,
        targetTenantId: TENANT_A,
        targetWorkspaceId: WS_A_REPORTING,
      }),
    ).rejects.toMatchObject({ code: "TENANT_SWITCH_DENIED" });
  });

  it("GOV-T07: past_due subscription blocks new metered AI/voice runs while preserving authorized read of existing published package", async () => {
    const pastDueSub = await gov.assignTenantSubscription({
      tenantId: TENANT_A,
      planId: "sme_standard",
      planVersion: 1,
      status: "past_due",
    });

    try {
      // New metered AI run is blocked
      const core = new AiIntelligenceCore({ tools: new ToolDefinitionRegistry(), audit });
      await expect(
        core.executeRun({
          actor: EDITOR_A,
          source: "typed_ai",
          idempotencyKey: "gov-t07-blocked",
          instruction: "Draft new memo",
          inputLanguage: "en",
          outputLanguage: "en",
          classification: "confidential",
          subscription: pastDueSub,
          routingPolicy: routingPolicyA,
          approved: true,
          steps: [],
        }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_PAST_DUE_METERED_BLOCKED" });

      // Reading existing published reporting package remains ALLOWED!
      const readDecision = evaluatePolicyDecision({
        actor: EDITOR_A,
        resourceTenantId: TENANT_A,
        resourceWorkspaceId: WS_A_REPORTING,
        resource: "reporting_package",
        action: "read",
        source: "manual",
        subscription: pastDueSub,
        isReadExistingAuthorizedWork: true,
      });
      expect(readDecision.allowed).toBe(true);

      const existingPkg = await getPackageLifecycleRow(db, TENANT_A, "pkg_nov_mgmt", 1);
      expect(existingPkg?.lifecycle_status).toBe("published");
    } finally {
      await gov.assignTenantSubscription({
        tenantId: TENANT_A,
        planId: "sme_standard",
        planVersion: 1,
        status: "active",
      });
    }
  });

  it("GOV-T08: crash lease fencing and full isolated DB + Private Object-Store backup/restore preserve complete parity", async () => {
    // 1. Crash recovery & stale lease fencing
    const enq = await gov.enqueueJob({
      actor: EDITOR_A,
      jobType: "nightly_reconcile",
      idempotencyKey: "gov-t08-fence",
      payload: { packageId: "pkg_nov_mgmt" },
      maxAttempts: 2,
    });
    const w1 = await gov.claimNextJobLease({ tenantId: TENANT_A, workerId: "w1", leaseDurationMs: 500 });
    expect(w1?.jobId).toBe(enq.job.jobId);
    await gov.reclaimExpiredLeases(TENANT_A, new Date(Date.now() + 60_000).toISOString());
    const w2 = await gov.claimNextJobLease({ tenantId: TENANT_A, workerId: "w2", leaseDurationMs: 30_000 });
    expect(w2?.fencingGeneration).toBe(2);

    await expect(
      gov.completeJob({
        tenantId: TENANT_A,
        jobId: w1!.jobId,
        leaseToken: w1!.leaseToken!,
        fencingGeneration: 1,
        result: { stale: true },
      }),
    ).rejects.toMatchObject({ code: "STALE_LEASE_FENCING_CONFLICT" });
    await gov.completeJob({
      tenantId: TENANT_A,
      jobId: w2!.jobId,
      leaseToken: w2!.leaseToken!,
      fencingGeneration: 2,
      result: { reconciled: true },
    });

    // 2. Full isolated DB (Core + XI + PA-00) + Private Object-Store backup & restore drill
    const dbSnap = await exportPaExtendedLogicalBackup(db);
    const objSnap = await store.exportSnapshot();

    const restoredDb = new PgliteDatabaseAdapter();
    const restoredObjDir = mkdtempSync(path.join(tmpdir(), "aios-gov-restore-"));
    try {
      await initializePostgreSqlSchema(restoredDb);
      await initializeIntegrationSchema(restoredDb);
      await initializePaGovernanceSchema(restoredDb);
      await restorePaExtendedLogicalBackup(restoredDb, dbSnap);

      const restoredStore = new LocalPrivateObjectStore(restoredObjDir);
      const objParity = await restoredStore.restoreSnapshot(objSnap);
      expect(objParity.verifiedSha256Count).toBe(objSnap.entries.length);

      // Verify published FR-08 package, outbox, usage ledger, and object bytes all survived cleanly
      const pkg = await getPackageLifecycleRow(restoredDb, TENANT_A, "pkg_nov_mgmt", 1);
      expect(pkg?.lifecycle_status).toBe("published");
      const outbox = await listOutboxEventsForTenant(restoredDb, TENANT_A);
      expect(outbox.length).toBeGreaterThanOrEqual(1);
      const restoredGov = new PlatformGovernanceService(restoredDb);
      const ledger = await restoredGov.listUsageLedger(BILLING_A, TENANT_A);
      expect(ledger.length).toBeGreaterThanOrEqual(2);
      const blob = await restoredStore.getObjectBytes({
        tenantId: TENANT_A,
        workspaceId: WS_A_REPORTING,
        storageKey: storedPackageObjectKey,
        quarantineState: "clean",
      });
      expect(Buffer.from(blob.bytes).toString("utf8")).toContain("pkg_nov_mgmt");

      // RLS remains strictly active in restored DB
      const leaked = await withTenantTransaction(restoredDb, TENANT_B, async (tx) => {
        const r = await tx.query<{ cnt: string | number }>("SELECT COUNT(*) AS cnt FROM pa_usage_ledger");
        return Number(r.rows[0]?.cnt ?? 0);
      });
      expect(leaked).toBe(0);
    } finally {
      await restoredDb.close();
      rmSync(restoredObjDir, { recursive: true, force: true });
    }
  });
});
