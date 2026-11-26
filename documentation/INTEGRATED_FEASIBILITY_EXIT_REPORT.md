# Consolidated Feasibility Exit Report — V1.3 (`PA-00`, `AIC-00`, `VI-00` & Integrated Golden Slice)

**Date:** 26 November 2026  
**Branch:** `feasibility/v1.3-pa00-aic00-vi00` (stacked on `audit/remediation-64-findings`)  
**Change Control Record:** `CR-007` (preserves 51-parent baseline without double-counting refinements)  
**Gate Status:** **BOUNDED LOCAL FEASIBILITY COMPLETE — STOPPED AT EXIT GATE FOR FOUNDER / CTO REVIEW.**  
**Authorization Reminder:** This report evidences local bounded feasibility only. It does **not** authorize `PA-01+`, `AIC-01+`, `VI-01+` production buildout, external LLM/cloud STT API calls, commercial software purchases, live Stripe/billing activation, or public deployment.

---

## 1. Executive Summary

Following Founder authorization of bounded local feasibility for **V1.3 (`FR-09`, `FR-10`, `FR-11`)**, we extended the existing platform and studio engines cleanly without introducing competing tenant, authorization, storage, AI, speech, or billing subsystems:

1. **`PA-00` — Shared Platform Administration (`FR-11`, `PLT-01..PLT-06`):**
   - Expanded [`platform/authorization/src/index.ts`](../platform/authorization/src/index.ts) from 5 to 8 roles (`owner`, `administrator`, `workspace_manager`, `billing_admin`, `auditor`, `editor`, `reviewer`, `viewer`) and added centralized **`PolicyDecisionEngine`** (`evaluatePolicyDecision` / `assertPolicyAllowed`), strictly separating tenant/workspace isolation, MFA step-up assurance, restricted-workspace content grants (`workspaceContentGrant`), role capabilities (`billing_admin` and `auditor` excluded from confidential business content), and commercial entitlements while **always preserving authorized read access to existing user work** even during `past_due` or quota lockout.
   - Added additive PostgreSQL 16 + PGlite schema [`platform/database/src/paSchema.ts`](../platform/database/src/paSchema.ts) (`PA_SCHEMA_VERSION = "2026.11.v3-pa00"`) with **`FORCE ROW LEVEL SECURITY`** on 9 new tenant-scoped tables (`pa_invitations`, `pa_tenant_subscriptions`, `pa_usage_reservations`, `pa_usage_ledger`, `pa_billing_webhooks`, `pa_file_objects`, `pa_jobs`, `pa_ai_policies`, `pa_voice_policies`), plus `REVOKE UPDATE, DELETE ON pa_usage_ledger FROM app_runtime`.
   - Implemented [`PlatformGovernanceService`](../platform/database/src/governanceRepository.ts) covering org suspension, hashed single-use expiring invitations with `FOR UPDATE` transactional seat-limit enforcement, sole-owner removal protection, MFA-gated ownership transfer, offboarding (`token_version` bump), atomic `reserve -> settle / release` usage accounting, HMAC-signed idempotent mock billing webhooks, durable fenced-lease background jobs (`fencing_generation` + `lease_token` blocking split-brain commits), filtered tenant-scoped audit queries with secret redaction, operational health reporting, and full Core + XI + PA-00 isolated logical backup/restore.
   - Added private versioned object storage [`LocalPrivateObjectStore`](../platform/storage/src/objectStore.ts) with tenant/workspace key isolation, path-containment guards, SHA-256 verification on read, short-lived HMAC-signed download tokens, quarantine blocking (`423`), soft delete/recovery + legal-hold protection, orphan blob sweep, and isolated snapshot backup/restore.

2. **`AIC-00` — AI Intelligence Core (`FR-09`, `AI-01..AI-07`):**
   - Built app-owned **`AIProviderAdapter`**, `DEFAULT_AI_MODEL_CATALOG`, fail-closed **`ModelRoutingPolicyEngine`** (`MISSING_MODEL_ROUTING_POLICY`, `PRIVACY_UNSAFE_FAILOVER_BLOCKED`), `DeterministicMockAIProviderAdapter` (`isMock: true`), and `423` fail-closed external LLM adapters (`openai`, `anthropic`, `google-gemini`) in [`modules/ai/src/providers.ts`](../modules/ai/src/providers.ts).
   - Built two-stage permission-aware **`CorporateKnowledgeIndex`** in [`modules/ai/src/knowledgeRetrieval.ts`](../modules/ai/src/knowledgeRetrieval.ts) (ACL pre-filter before prompt assembly, indirect prompt-injection sanitization, metric conflict detection, honest `insufficient_evidence`, and response-time `recheckCitations()` against live revocation tombstones).
   - Built versioned **`ToolDefinitionRegistry`** ([`modules/ai/src/toolRegistry.ts`](../modules/ai/src/toolRegistry.ts)) with unknown-param rejection, prompt-injection scanning, deterministic studio execution (`DocumentService`, `recalculateWorkbook`, `BusinessAnalysisEngine`, `CrossModuleIntegrationEngine`), and independent exact `verifyFinalState()` checks catching `#DIV/0!`, cycles, and stale revisions.
   - Built durable **`AiIntelligenceCore`** (`AgentRun` orchestrator in [`modules/ai/src/agentRuntime.ts`](../modules/ai/src/agentRuntime.ts)) enforcing policy authorization BEFORE provider calls, explicit approval gates, atomic quota reserve/settle/release, idempotency by `idempotencyKey`, safe mid-run cancellation, bilingual EN/KM output control, and explicit separation of `verifiedFacts` from non-authoritative `aiInterpretation` (`isAuthoritative: false`).

3. **`VI-00` — Advanced Voice Intelligence (`FR-10`, `VOC-01..VOC-03`):**
   - Extended `engines/speech` with strict **`VoiceSessionManager`** ([`engines/speech/src/voiceSession.ts`](../engines/speech/src/voiceSession.ts)) state machine, `eventId` deduplication, late/out-of-order partial drops, inactivity expiry, ephemeral zero-retention audio wiping, and explicit fail-closed P1/corpus gates (`423 P1_VOICE_FEATURE_GATED` / `CONSENTED_CORPUS_PENDING`).
   - Built bilingual EN/KM **`validateVoiceCriticalFields`** ([`engines/speech/src/criticalFields.ts`](../engines/speech/src/criticalFields.ts)) covering Khmer Unicode numeral normalization (`០–៩`), USD/KHR ambiguity detection (`AMBIGUOUS_CURRENCY`), format-only vs FX-conversion rate gating (`FX_RATE_REQUIRED`), relative-date/target ambiguity, and cell/range parsing.
   - Built tenant-isolated, versioned EN/KM **`TerminologyRegistry`** ([`engines/speech/src/terminology.ts`](../engines/speech/src/terminology.ts)) and end-to-end **`VoiceGovernancePipeline`** ([`engines/speech/src/voiceGovernance.ts`](../engines/speech/src/voiceGovernance.ts)) enforcing strict dictation-vs-command isolation and typed-vs-voice authorization parity while preserving `MockSpeechAdapter` (`isMock: true`) and fail-closed `423` cloud STT adapters.

4. **Section 5.1 Integrated Golden Vertical Slice (`GOV-T01..GOV-T08`):**
   - Verified end-to-end across two synthetic tenants with colliding IDs and approved finance figures (`Net Sales $150,000.00`, `COGS $90,000.00`, `OpEx $20,000.00`, `Operating Profit $40,000.00`, `Operating Margin 26.67%`, `Prior Revenue $125,000.00`, `Growth +20.00%`) spanning mocked voice + terminology + `PolicyDecisionEngine` + `AiIntelligenceCore` + FR-08 `CrossModuleIntegrationEngine` (`ReportingPackageManifest` + atomic PostgreSQL outbox publication) + `pa_usage_ledger` + `LocalPrivateObjectStore` + isolated restore parity.

---

## 2. Architectural Comparisons & Recommendations

### 2.1 AI Provider Layer: App-Owned `AIProviderAdapter` vs. Vercel AI SDK (`AI-T28`)
- **Decision (`TD-AIC-01`):** Retain an **app-owned `AIProviderAdapter`** at the domain boundary rather than coupling business logic directly to Vercel AI SDK or vendor SDK types.
- **Evidence:** Microbenchmark (`benchmarkDirectAdapterVsSdkWrapper`) confirms zero extra serialization/envelope overhead, zero additional third-party dependency or license footprint, and clean isolation of classification ceilings, ZDR policies, and privacy-safe failover (`PRIVACY_UNSAFE_FAILOVER_BLOCKED`). If streaming chat UI ergonomics are needed in `AIC-01+`, Vercel AI SDK can optionally sit *behind* `AIProviderAdapter` without leaking into routing or authorization code.

### 2.2 Speech Recognition Providers: Paper Comparison (`VI-00`, Zero External Audio Sent)
| Provider | `en-US` | `km-KH` | Privacy / Residency | Feasibility Status |
| :--- | :--- | :--- | :--- | :--- |
| **Faster-Whisper (Self-Hosted, MIT)** | Local synthetic EN bench `2.1–2.4 s` CPU `int8` | Base Whisper requires Khmer fine-tuning / corpus test | Full local/self-hosted sovereignty | Wired locally behind `ALLOW_LOCAL_FASTER_WHISPER=true`; native `km-KH` WER/CER pending |
| **Azure AI Speech** | Mature STT + Neural TTS | Official `km-KH` STT + `km-KH-SreymomNeural` / `PisethNeural` + Custom Speech | Regional cloud / container options | **Locked (`423`)** — requires consent & credentials |
| **Google Cloud STT V2** | Mature STT | Official `km-KH` (`asia-southeast1` Chirp/Chirp 2; `eu`/multi-region Chirp 3 availability differs) | Regional cloud endpoints | **Locked (`423`)** — requires consent & credentials |
| **OpenAI / Gemini Audio** | Strong EN | Corporate `km-KH` accuracy & ZDR residency require live validation | Cloud SaaS | **Locked (`423`)** — requires consent & contractual ZDR |

---

## 3. Complete 102-ID Acceptance Matrix (Honest Evidence Classification)

> **Honesty Legend:**
> - **PASS (Real Engine / PG RLS):** Executed against real PostgreSQL/PGlite RLS, real `LocalPrivateObjectStore`, real `DocumentService`, `recalculateWorkbook`, `BusinessAnalysisEngine`, or `CrossModuleIntegrationEngine`.
> - **PASS (Mock Provider / Fixture):** Deterministic pipeline/policy/state-machine verification using explicitly labeled `isMock: true` AI, speech, or billing webhook fixtures — **not** evidence of live LLM quality, live Khmer acoustic WER/CER, or live payment-gateway integration.
> - **GATED / NOT-RUN (P1 / Corpus Pending):** Verified that feature fails closed (`423`) until P1 authorization or consented native Khmer speaker corpus is approved.

### 3.1 `PA-00` Shared Platform Administration (`PLT-T01..PLT-T36` — `tests/v13-pa00-platform-admin.test.ts`)

| Test ID | Scenario | Status | Evidence Classification |
| :--- | :--- | :--- | :--- |
| `PLT-T01` | Multi-tenant org/workspace provisioning with colliding names | **PASS** | Real PG/PGlite RLS |
| `PLT-T02` | Org suspension blocks active mutations & login until reactivated | **PASS** | Real PG/PGlite + Identity |
| `PLT-T03` | Invitation stores SHA-256 hash only; raw token redacted in audit | **PASS** | Real PG/PGlite + Audit |
| `PLT-T04` | Consumed, revoked, and expired invitation tokens rejected | **PASS** | Real PG/PGlite RLS |
| `PLT-T05` | Transactional `seat_limit` enforced under `FOR UPDATE` lock | **PASS** | Real PG/PGlite RLS |
| `PLT-T06` | Sole-owner removal blocked; MFA-verified ownership transfer works | **PASS** | Real PG/PGlite + Policy |
| `PLT-T07` | Offboarding revokes membership & bumps `token_version` immediately | **PASS** | Real PG/PGlite + Identity |
| `PLT-T08` | `FORCE ROW LEVEL SECURITY` via non-superuser `NOBYPASSRLS` role (`aios_pa00_app` on PG16 Docker + `app_runtime`) | **PASS** | **Live PostgreSQL 16 + PGlite** |
| `PLT-T09` | `billing_admin` allowed billing/usage; denied finance docs, AI & voice | **PASS** | Real PolicyDecisionEngine |
| `PLT-T10` | `auditor` read-only on audit/metrics/usage; denied mutations | **PASS** | Real PolicyDecisionEngine |
| `PLT-T11` | `workspace_manager` scoped to workspace; denied billing & cross-workspace | **PASS** | Real PolicyDecisionEngine |
| `PLT-T12` | Restricted Payroll workspace denies ungranted org admin; allows member | **PASS** | Real PolicyDecisionEngine |
| `PLT-T13` | Explicit tenant context switch verified against live active membership | **PASS** | Real PG/PGlite |
| `PLT-T14` | Privileged actions require fresh MFA step-up when org policy enabled | **PASS** | Real PolicyDecisionEngine |
| `PLT-T15` | Identical RBAC decisions across manual, typed AI, voice & workflow | **PASS** | Real PolicyDecisionEngine |
| `PLT-T16` | Private versioned object storage tenant keys, SHA-256 & traversal block | **PASS** | Real `LocalPrivateObjectStore` |
| `PLT-T17` | Signed ephemeral object download tokens reject expired/tampered/cross-tenant | **PASS** | Real `LocalPrivateObjectStore` |
| `PLT-T18` | Quarantined/unscanned files blocked (`423`) until marked `clean` | **PASS** | Real PG + Object Store |
| `PLT-T19` | File versioning, soft delete, recovery & legal-hold purge protection | **PASS** | Real PG + Object Store |
| `PLT-T20` | Orphan staging blob sweep preserves all committed versions | **PASS** | Real `LocalPrivateObjectStore` |
| `PLT-T21` | Org AI routing policy persisted & versioned per tenant | **PASS** | Real PG/PGlite RLS |
| `PLT-T22` | Org voice governance policy persisted & versioned per tenant | **PASS** | Real PG/PGlite RLS |
| `PLT-T23` | Missing plan entitlement fails distinctly (`PLAN_ENTITLEMENT_REQUIRED`) | **PASS** | Real PG + Policy |
| `PLT-T24` | Concurrent `reserveQuota` prevents overspend via `FOR UPDATE` | **PASS** | Real PG/PGlite RLS |
| `PLT-T25` | `releaseQuota` restores budget cleanly on failure/cancellation | **PASS** | Real PG/PGlite RLS |
| `PLT-T26` | Settlement writes append-only `pa_usage_ledger` (`REVOKE UPDATE, DELETE`) | **PASS** | Real PG/PGlite RLS |
| `PLT-T27` | `past_due` blocks metered AI/voice while preserving read of existing work | **PASS** | Real PG + Policy |
| `PLT-T28` | Mock billing webhook HMAC verification & replay deduplication | **PASS (Mock Fixture)** | Signed Mock Webhook (`isMock: true`) |
| `PLT-T29` | Durable job enqueue idempotency & `concurrent_jobs` quota cap | **PASS** | Real PG/PGlite RLS |
| `PLT-T30` | Job lease heartbeat & `fencing_generation` block stale worker commits | **PASS** | Real PG/PGlite RLS |
| `PLT-T31` | Safe job cancellation releases reserved `concurrent_jobs` quota | **PASS** | Real PG/PGlite RLS |
| `PLT-T32` | Exhausted expired leases route cleanly to `dead_letter` & release quota | **PASS** | Real PG/PGlite RLS |
| `PLT-T33` | `audit_logs` append-only (`REVOKE UPDATE, DELETE`) + secret redaction | **PASS** | Real PG/PGlite RLS |
| `PLT-T34` | Filtered tenant-scoped audit query enforces strict tenant boundary | **PASS** | Real PG/PGlite RLS |
| `PLT-T35` | Isolated DB (Core+XI+PA-00) + Private Object-Store backup & restore drill | **PASS** | Real PG/PGlite + Object Store |
| `PLT-T36` | Operational health snapshot reports DB/RLS/queue/dead-letter/storage state | **PASS** | Real PG/PGlite |

### 3.2 `AIC-00` AI Intelligence Core (`AI-T01..AI-T28` — `tests/v13-aic00-ai-intelligence-core.test.ts`)

| Test ID | Scenario | Status | Evidence Classification |
| :--- | :--- | :--- | :--- |
| `AI-T01` | Model capability registry metadata, ceilings, ZDR & mock flags | **PASS** | Real Registry |
| `AI-T02` | Fail-closed routing on missing/empty `ModelRoutingPolicy` | **PASS** | Real Router |
| `AI-T03` | Classification-aware routing picks approved ZDR local model | **PASS (Mock Provider)** | Real Router + Mock Adapter |
| `AI-T04` | Privacy-safe failover to approved secondary ZDR model | **PASS (Mock Provider)** | Real Router + Mock Adapter |
| `AI-T05` | Privacy-unsafe failover blocked (`PRIVACY_UNSAFE_FAILOVER_BLOCKED`) | **PASS** | Real Router |
| `AI-T06` | External LLM providers (`openai`, `anthropic`, `google-gemini`) locked `423` | **PASS** | Fail-Closed Security Gate |
| `AI-T07` | Versioned `ToolDefinitionRegistry` rejects unknown tools/versions/params | **PASS** | Real Registry |
| `AI-T08` | Medium/high-risk tool operations enforce explicit `APPROVAL_REQUIRED` | **PASS** | Real `AiIntelligenceCore` |
| `AI-T09` | Document paragraph edit via `DocumentService` + exact `verifyFinalState` | **PASS (Mock Provider + Real Doc Engine)** | Real `DocumentService` |
| `AI-T10` | Spreadsheet cell edit via `recalculateWorkbook` + protected-cell guard | **PASS (Mock Provider + Real Calc Engine)** | Real `recalculateWorkbook` |
| `AI-T11` | Financial calculation tool delegates to FR-05 `BusinessAnalysisEngine` | **PASS (Mock Provider + Real Analytics)** | Real `FIN-POL-V1` Engine |
| `AI-T12` | Post-execution verifier catches `#DIV/0!` spreadsheet formula error | **PASS** | Real `recalculateWorkbook` + Verifier |
| `AI-T13` | Direct prompt injection blocked & audited before provider call | **PASS** | Real Scanner + Audit |
| `AI-T14` | Indirect prompt injection in retrieved corporate chunk neutralized | **PASS** | Real `CorporateKnowledgeIndex` |
| `AI-T15` | Knowledge retrieval tenant isolation with colliding artifact IDs | **PASS** | Real `CorporateKnowledgeIndex` |
| `AI-T16` | Knowledge retrieval ACL pre-filter blocks restricted Payroll workspace | **PASS** | Real `CorporateKnowledgeIndex` |
| `AI-T17` | Mid-flight revocation strips revoked citation at `recheckCitations()` | **PASS** | Real `CorporateKnowledgeIndex` |
| `AI-T18` | Grounded retrieval returns verifiable artifactId, revision & SHA-256 hash | **PASS** | Real `CorporateKnowledgeIndex` |
| `AI-T19` | Insufficient evidence returns explicit `insufficient_evidence` | **PASS** | Real `CorporateKnowledgeIndex` |
| `AI-T20` | Contradictory figures across authorized docs surfaced in `conflicts` | **PASS** | Real `CorporateKnowledgeIndex` |
| `AI-T21` | `verifiedFacts` separated from non-authoritative `aiInterpretation` | **PASS (Mock Provider)** | Real Orchestrator |
| `AI-T22` | Bilingual EN/KM input with independent output language routing | **PASS (Mock Provider)** | Real Orchestrator + Mock Adapter |
| `AI-T23` | Multi-step `AgentRun` step lineage & idempotency replay | **PASS (Mock Provider)** | Real Orchestrator |
| `AI-T24` | Mid-run cancellation halts remaining steps & releases unspent quota | **PASS (Mock Provider)** | Real Orchestrator + Quota Hook |
| `AI-T25` | Stale document revision conflict aborts safely without overwrite | **PASS** | Real `DocumentService` (`409`) |
| `AI-T26` | Mid-run tool failure records failing step & settles actual usage | **PASS (Mock Provider)** | Real Orchestrator |
| `AI-T27` | Unauthorized roles (`viewer`, `billing_admin`) denied BEFORE provider call | **PASS** | Real Policy + Orchestrator |
| `AI-T28` | Direct app-owned adapter vs SDK wrapper architecture benchmark | **PASS** | Local Microbenchmark |

### 3.3 `VI-00` Advanced Voice Intelligence (`VOC-T01..VOC-T30` — `tests/v13-vi00-voice-intelligence.test.ts`)

| Test ID | Scenario | Status | Evidence Classification |
| :--- | :--- | :--- | :--- |
| `VOC-T01` | Full `VoiceSession` happy-path state transitions | **PASS** | Real State Machine |
| `VOC-T02` | Illegal state transition rejection (`409`) | **PASS** | Real State Machine |
| `VOC-T03` | Duplicate `eventId` idempotent deduplication | **PASS** | Real State Machine |
| `VOC-T04` | Late/out-of-order partial transcripts dropped safely | **PASS** | Real State Machine |
| `VOC-T05` | Microphone permission denial transitions cleanly to `error` | **PASS** | Real State Machine |
| `VOC-T06` | Mid-session cancellation wipes audio buffer & releases voice quota | **PASS** | Real Pipeline + Quota Hook |
| `VOC-T07` | Inactivity timeout transitions to `expired` & blocks execution (`410`) | **PASS** | Real State Machine |
| `VOC-T08` | English dictation mode isolates imperatives as literal text only | **PASS (Mock ASR)** | Real Pipeline (`isMock: true`) |
| `VOC-T09` | Khmer dictation mode isolates imperatives as literal text only | **PASS (Mock ASR)** | Real Pipeline (`isMock: true`) |
| `VOC-T10` | English financial `CriticalField` validation (`USD 150,000`, `2026-11`, `B2`) | **PASS** | Real Validator |
| `VOC-T11` | Khmer financial `CriticalField` validation with Khmer digits (`១៥០០០០ ដុល្លារ`) | **PASS** | Real Validator |
| `VOC-T12` | Bare financial amounts (EN & KM) trigger `AMBIGUOUS_CURRENCY` | **PASS** | Real Validator |
| `VOC-T13` | Display format-only vs FX conversion rate requirement (`FX_RATE_REQUIRED`) | **PASS** | Real Validator |
| `VOC-T14` | Ambiguous relative period & vague target trigger clarification | **PASS** | Real Validator |
| `VOC-T15` | Low ASR confidence (`< 0.85`) forces `review_clarify` confirmation gate | **PASS (Mock ASR)** | Real Pipeline |
| `VOC-T16` | User edit during `review_clarify` preserves raw + advances edited command | **PASS (Mock ASR)** | Real Pipeline |
| `VOC-T17` | Tenant-isolated org-versioned EN/KM terminology normalization | **PASS** | Real `TerminologyRegistry` |
| `VOC-T18` | English typed AI vs mocked voice produces identical Document mutation | **PASS (Mock ASR + Real Doc Engine)** | Real `DocumentService` |
| `VOC-T19` | Khmer typed AI vs mocked Khmer voice produces identical Document mutation | **PASS (Mock ASR + Real Doc Engine)** | Real `DocumentService` |
| `VOC-T20` | Voice RBAC non-bypass (`viewer` & `billing_admin` denied identically) | **PASS** | Real `PolicyDecisionEngine` |
| `VOC-T21` | Spoken prompt injection blocked & reserved quota released | **PASS (Mock ASR)** | Real Scanner + Pipeline |
| `VOC-T22` | Ephemeral zero-retention wipes audio immediately; max clip duration enforced | **PASS (Mock ASR)** | Real Pipeline |
| `VOC-T23` | Cloud STT (`423`), `MockSpeechAdapter` (`isMock: true`), local Faster-Whisper gate | **PASS** | Fail-Closed Security Gate |
| `VOC-T24` | Streaming partial transcription (`VOC-03.01` P1) | **GATED / NOT-RUN (P1)** | Verified fail-closed `423 P1_VOICE_FEATURE_GATED` |
| `VOC-T25` | Bilingual EN/KM TTS synthesis (`VOC-03.02` P1) | **GATED / NOT-RUN (P1)** | Verified fail-closed `423 P1_VOICE_FEATURE_GATED` |
| `VOC-T26` | VAD & barge-in (`VOC-03.03` P1) | **GATED / NOT-RUN (P1)** | Verified fail-closed `423 P1_VOICE_FEATURE_GATED` |
| `VOC-T27` | Within-utterance EN/KM code-switching (`VOC-03.04` P1) | **GATED / NOT-RUN (P1)** | Verified fail-closed `423 P1_VOICE_FEATURE_GATED` |
| `VOC-T28` | Custom pronunciation lexicon (`VOC-03.05` P1) | **GATED / NOT-RUN (P1)** | Verified fail-closed `423 P1_VOICE_FEATURE_GATED` |
| `VOC-T29` | Continuous multi-turn hands-free workflow (`VOC-03.06` P1) | **GATED / NOT-RUN (P1)** | Verified fail-closed `423 P1_VOICE_FEATURE_GATED` |
| `VOC-T30` | Live consented native Khmer (`km-KH`) WER/CER corpus evaluation | **PENDING CORPUS** | Verified fail-closed `423 CONSENTED_CORPUS_PENDING` |

### 3.4 Cross-Cutting Governance Integrated Slice (`GOV-T01..GOV-T08` — `tests/v13-integrated-golden-governance.test.ts`)

| Test ID | Scenario | Status | Evidence Classification |
| :--- | :--- | :--- | :--- |
| `GOV-T01` | Full EN/KM mocked voice → AI Core → FR-08 `ReportingPackageManifest` (`$150k/$40k/26.67%/+20%`) → Approval → Atomic PG Outbox + Usage Ledger | **PASS (Real Engines + Mock AI/ASR)** | End-to-End Integrated Slice |
| `GOV-T02` | Cross-tenant colliding-ID isolation across PG RLS, RAG, Private Object Store & Terminology | **PASS** | Real PG RLS + Engines |
| `GOV-T03` | Restricted Payroll workspace non-leakage across Manual, AI RAG & Voice | **PASS** | Real Policy + RAG + Voice |
| `GOV-T04` | Role separation (`billing_admin` vs `viewer`) across Usage, Finance, AI & Voice | **PASS** | Real Policy + PG + AI |
| `GOV-T05` | Privacy-unsafe failover blocked; external LLM & cloud STT stay `423` | **PASS** | Fail-Closed Security Gate |
| `GOV-T06` | Mid-workflow citation revocation, job cancellation quota release & user offboarding | **PASS** | Real PG + RAG + Jobs |
| `GOV-T07` | `past_due` subscription blocks new metered AI while preserving read of published package | **PASS** | Real PG + Policy + XI-00 |
| `GOV-T08` | Crash lease fencing + isolated DB (Core+XI+PA-00) & Private Object-Store restore parity | **PASS** | Real PG + Object Store |

---

## 4. Open Gates Before `PA-01+`, `AIC-01+`, or `VI-01+` Production Authorization

1. **Founder / CTO Exit Gate Review:** Review this report and Draft PR before authorizing any production milestone (`PA-01+`, `AIC-01+`, `VI-01+`).
2. **Consented Native Khmer (`km-KH`) Speech Corpus (`VOC-T30`):** Required before live cloud/self-hosted Khmer ASR accuracy claims or `VI-01` launch.
3. **External Provider Consent & ZDR Agreements:** Required before unlocking `ALLOW_LIVE_AI_PROVIDERS=true` or `ALLOW_LIVE_SPEECH_PROVIDERS=true` (`423` remains enforced).
4. **Live Billing / Payment Processor & OIDC IdP (`PLT-01.10`, `PLT-06.07`):** Deferred to `PA-01+`; only signed mock webhook fixtures were used locally.
5. **Verbatim V1.3 Research Report Archival Note:** Because conversation context compacted before file-write authorization was granted, no synthetic copy of `AI_Office_Suite_FR09_FR10_FR11_Main_Research_Report_V1.3.md` was fabricated; attach or drop the original `.md` into `documentation/` to archive it verbatim.
