# Requirements Traceability Register — AI Office Suite

**Baseline Sources:**
- Master Research & Project Context V1.0 (V0.1 Register: 51 grouped entries — 46 P0, 5 P1; plus 15 WS refinements)
- Product Development Master Plan V1.0 (Bilingual English + Khmer voice update)
- Stage 3 Research Reports V1.1–V1.4 (`FR-02`..`FR-13`: Spreadsheet, Data Prep, Analytics, Presentations, BI, Cross-Module Integration, AI Intelligence Core, Voice Intelligence, Shared Platform Admin, Non-Functional Requirements & Complete Requirements Consolidation)

> All original requirement IDs are preserved verbatim for full traceability. No requirement is silently deleted or altered.

## Change Control Record

| Change ID | Source | Summary of Change | Impact |
| :--- | :--- | :--- | :--- |
| CR-001 | Product Development Plan V1.0 (§2, §11) | Supersedes English-only MVP voice assumption (`VOC-01/02`) to require **English (`en-US`) and Khmer (`km-KH`)** voice capture, transcript review, and independent input/UI/output language routing. | Extends `VOC-01`, `VOC-02`, and `DOC-01..04` with Khmer typography, `Intl.Segmenter` grapheme safety, and `km-KH` speech benchmarks. |
| CR-002 | Stage 3 — FR-03 (§23, §24) | Expands `SHT-01..06` into detailed testable requirements (`SHT-01.01..SHT-06.03`, `SHT-AI-01..10`, `SHT-VOICE-01..08`) and adds `SHT-T01..T18`. | Extends D1 feasibility scope with isolated SS-00 spreadsheet engine & licensing evaluation without authorizing full production buildout. |
| CR-003 | Handover V1.1 — FR-04 (§5) | Expands `DAT-01..06` into 30 detailed requirements (`DAT-01.01..DAT-06.05`), `DAT-AI-01..07`, `DAT-VOICE-01..04`, and `DAT-T01..T18`. | Authorizes bounded local `DP-00` feasibility spike comparing DuckDB vs. Polars without starting DP-01 production buildout. |
| CR-004 | Stage 3 — FR-05 (§23–§29) & Founder Approvals #1–#4 | Expands `ANA-01..04` into 24 detailed requirements (`ANA-01.01..ANA-04.05`), `ANA-AI-01..08`, `ANA-VOICE-01..05`, and `ANA-T01..T18`; approves Git baseline, Phase D2 PostgreSQL/auth extraction, vendor RFP outreach, and Faster-Whisper setup. | Authorizes isolated `AN-00` analytical feasibility prototype (`engines/analytics`) + Phase D2 PostgreSQL/JWT RLS foundation (`platform/database`, `platform/identity`) while gating `AN-01` production and P1 forecasting/stats. |
| CR-005 | Handover V1.2 — FR-06 & FR-07 (§3.8, §10, §11, §14) | Retains **24 PPT details + 10 PPT-AI + 7 PPT-VOICE + `PPT-T01..T20`** and introduces **34 BI details (`BI-01.01..03.12`) + 10 BI-AI + 6 BI-VOICE + `BI-T01..T34` + `X-VIS-01..08`**, preserving the 51-parent baseline (`PPT-01..03`, `BI-01..03`). | Authorizes bounded local `PS-00` & `BI-00` feasibility experiments (`engines/presentation`, `engines/intelligence`) using `pptxgenjs`, `fflate`, `echarts`, and FR-05 analytics without starting `PS-01`/`ENG-BI-01` production buildout. |
| CR-006 | Stage 3 — FR-08 (§29–§36) | Refines existing parent entries `INT-01..04` into **24 subrequirements (`INT-01.01..08`, `INT-02.01..07`, `INT-03.01..06`, `INT-04.01..03`)**, **8 `INT-AI` (`01..08`)**, **5 `INT-VOICE` (`01..05`)**, and **`INT-T01..T24`**, preserving the 51-parent baseline register without adding unrelated entries. | Authorizes bounded local `XI-00` integration feasibility (`engines/integration`, `tests/g1-xi00-cross-module-integration.test.ts`) with PostgreSQL RLS/outbox transactions while gating `XI-01..XI-10` production rollout & P1 `INT-04.01..03`. |
| CR-007 | Main Research & Engineering Report V1.3 (FR-09, FR-10, FR-11) & Founder Authorization | Consolidates and refines existing parent IDs **`AI-01..07`** (39 subrequirements), **`VOC-01..03`** (30 subrequirements, preserving `CR-001` English + Khmer first-class voice), and **`PLT-01..06`** (40 subrequirements) — **109 total refinements** without inflating the 51-parent baseline — plus **102 acceptance IDs** (`AI-T01..T28`, `VOC-T01..T30`, `PLT-T01..T36`, `GOV-T01..T08`). | Authorizes bounded local feasibility spikes **`PA-00`**, **`AIC-00`**, **`VI-00`**, and the Section 5.1 integrated golden slice while keeping external LLMs/cloud STT fail-closed (`423`), live billing/subscriptions mock-only, P1 features (`AI-04.06`, `AI-05.06`, `VOC-03.01..07`, `PLT-01.10`, `PLT-02.06`, `PLT-06.07`) gated, and `PA-01+`/`AIC-01+`/`VI-01+` production buildout blocked pending CTO/Founder exit review. |
| CR-008 | Main Research & Engineering Report V1.4 (`FR-12` + `FR-13`) & Founder `APPROVAL-01..03` | Consolidates all `13` Stage 3 workstreams, `40` NFR subrequirements (`NFR-01.01..04.12`, `NFR-T01..T40`), and **`313` canonical acceptance tests** while adopting progressive delivery order **`S1 -> S2 -> S3`** without removing any of the **`51` original parent requirements (`46 P0`, `5 P1`)**; realigns V1.3 suites 1:1 to V1.4 Appendix A and aligns `TF-01..TF-12` / `APPROVAL-01..07` 1:1 with V1.4 §22 & §23.2. | Authorizes local `RC-00`/`QE-00`/`TF-01` consolidation and zero-cost local `TF-04` (1M-row DuckDB spill) & `TF-11` (CycloneDX 1.5 SBOM + UI coverage/a11y) while keeping external Stage 4 experiments (`TF-02`/`TF-03`/`TF-05`/`TF-08`/`TF-09`/`TF-10`/`TF-11` external/`TF-12`) and production `S1 -> S2 -> S3` rollout strictly gated pending explicit approval. |

## 1. Shared Workspace Refinements (`WS-01` .. `WS-15`)

| ID | Priority | Requirement | Phase Target | Status in D1 |
| :--- | :--- | :--- | :--- | :--- |
| WS-01 | P0 | Unified organization workspace (`PLT-01`) | D2 | PostgreSQL RLS + `apps/api` `jwt-pg` tenant scoping implemented |
| WS-02 | P0 | Single sign-in across modules (`PLT-01`) | D2 | Extracted HttpOnly `aios_session` + HS256 JWT + `token_version` epoch revocation (`platform/identity`) |
| WS-03 | P0 | Common user and role management (`PLT-01`, `NFR-01`) | D2 | PostgreSQL `memberships` RBAC + live role re-read tested (`tests/d2-platform-pg-auth.test.ts`) |
| WS-04 | P0 | Central artifact and file catalog (`PLT-03`) | D2 | PostgreSQL `documents`/`document_versions` atomic pointers + reversible `.local-data/` migrator |
| WS-05 | P0 | Shared dataset catalog (`DAT-01`, `ANA-01`) | D7 / FR-04 | Interface placeholder only |
| WS-06 | P0 | Cross-module navigation and context (`AI-01`) | D2 | Shell routes + planned studio badges |
| WS-07 | P0 | Linked reports, sheets, slides, dashboards (`INT-01`) | D7 | `LinkedMetricPlaceholderBlock` contract defined |
| WS-08 | P0 | Version history and recovery (`PLT-02`) | D2/D3 | Append-only revisions + restore-as-new-rev verified |
| WS-09 | P0 | Central AI assistant and voice (`AI-01`, `VOC-01/02`) | D4/D5 | Prototype EN/KM panel + mock speech verified |
| WS-10 | P0 | Shared permissions and audit history (`AI-05/06`, `NFR-01`) | D2 | Append-only JSONL + PostgreSQL `audit_logs` with `REVOKE UPDATE, DELETE` verified |
| WS-11 | P0 | Multi-step workflow execution (`AI-04/07`, `PLT-05`) | D4+ | Single-step preview/apply/idempotency verified |
| WS-12 | P0 | Corporate templates and branding (`DOC-02`, `PPT-02`) | D6 | Bilingual report fixture implemented |
| WS-13 | P1 | Advanced real-time collaboration | Expansion | Deferred |
| WS-14 | P1 | Scheduled recurring workflows | Expansion | Deferred |
| WS-15 | P1 | Desktop and self-hosted support | Expansion | Preserved via adapter architecture |

## 2. Document Studio (`DOC-01` .. `DOC-05`)

| ID | Priority | Requirement | D1 Prototype Status |
| :--- | :--- | :--- | :--- |
| DOC-01 | P0 | Create, edit, save rich-text corporate reports (headings, lists, tables, images) + EN/KM text | Tiptap v3 + canonical `StudioDocument` verified (images deferred to D3) |
| DOC-02 | P0 | Reusable styles, page layout (A4/Letter), header/footer, templates | A4/Letter layout + header/footer in editor, DOCX, and PDF |
| DOC-03 | P0 | Insert linked tables, charts, metrics with source & freshness | `LinkedMetricPlaceholderBlock` contract & rendering verified |
| DOC-04 | P0 | Review draft versions, import/export supported DOCX, export searchable PDF | Tested round-trip DOCX + Chromium/HarfBuzz PDF |
| DOC-05 | P1 | Advanced track changes, mail merge, content controls | Deferred (`<w:sdt>` detected & flagged on import) |

## 3. Spreadsheet Studio (`SHT-01` .. `SHT-06` + FR-03 Refinements)

| ID | Priority | Refined Sub-IDs | SS-00 Feasibility Status |
| :--- | :--- | :--- | :--- |
| SHT-01 | P0 | `SHT-01.01`..`SHT-01.06` (Workbooks, cells, virtualization, formatting, tables/sort/filter, validation) | Core sparse model, display-vs-value separation, intact-row sort verified |
| SHT-02 | P0 | `SHT-02.01`..`SHT-02.03` (Core math, conditional/lookup, date/text/financial) | 19-function prototype evaluator + relative/absolute/cross-sheet refs verified |
| SHT-03 | P0 | `SHT-03.01`..`SHT-03.04` (Dependency graph, recalc, error semantics, formula audit) | Dependency recalc, `#CYCLE!`, `#DIV/0!`, `#NAME?` unsupported warning verified |
| SHT-04 | P0 | `SHT-04.01`..`SHT-04.03` (EN/KM Unicode, leading-zero ID preservation, USD/KHR & date/locale) | Khmer cells, `"001245"` text preservation, USD vs KHR currency tags verified |
| SHT-05 | P0 | `SHT-05.01`..`SHT-05.03` (XLSX/CSV import/export, unsupported-feature reporting) | Real `exceljs` XLSX round-trip, macro blocking, OWASP CSV escaping verified |
| SHT-06 | P1 | `SHT-06.01`..`SHT-06.03` (PivotTables, scenarios, extended formulas) | Deferred; PivotTables detected & flagged on import |
| SHT-AI | P0/P1 | `SHT-AI-01`..`09` (P0), `SHT-AI-10` (P1) | EN/KM Formula Intelligence spike + protected cell & prompt-injection guards verified |
| SHT-VOICE | P0/P1 | `SHT-VOICE-01`..`07` (P0), `SHT-VOICE-08` (P1) | Reuses shared speech adapter; format-only vs conversion rule verified |

## 4. Remaining V0.1 Register Families (Preserved for Stages 3–13)

- **Data Preparation (`DAT-01`..`06` P0/P1, refined into 30 details `DAT-01.01..DAT-06.05` + `DAT-AI-01..07` + `DAT-VOICE-01..04`):** `DP-00` feasibility spike (`engines/data-processing`) verified all 18 scenarios `DAT-T01..DAT-T18` against synthetic CSV/XLSX fixtures and DuckDB vs. Polars parity (`tests/g1-dp00-data-preparation.test.ts`). Production `DP-01` gated pending G1 review.
- **Analytics (`ANA-01`..`04` P0/P1, refined into `ANA-01.01..ANA-01.06`, `ANA-02.01..ANA-02.07`, `ANA-03.01..ANA-03.06`, `ANA-04.01..ANA-04.05`, `ANA-AI-01..08`, `ANA-VOICE-01..05`):**
  - *P0 Core Registry, Execution & Traceability (`AN-00` verified):* `ANA-01.01` (metric registry versions), `ANA-01.02` (reusable financial defs), `ANA-01.03` (units/currency/periods), `ANA-01.04` (aggregation & missing-value policies), `ANA-01.05` (exact minor-unit precision `FIN-POL-V1`), `ANA-01.06` (ownership/approval), `ANA-02.01..07` (grouped summaries, period/fiscal comparisons, granularity-safe budget vs actual, ranking, descriptive stats, historical trends, IQR anomaly checks), `ANA-03.01..06` (provenance, inspectable assumptions, reconciliation validation, observed facts vs AI interpretation separation, cross-module sync, warning/exception reporting), `ANA-AI-01..07` (EN/KM analytical planning, ambiguity clarification, safe validated execution), `ANA-VOICE-01..04`. All 18 acceptance scenarios `ANA-T01..ANA-T18` verified in `tests/g1-an00-analytics-feasibility.test.ts`.
  - *P1 Expansion (Gated):* `ANA-04.01..05`, `ANA-AI-08`, `ANA-VOICE-05` (advanced semantic models, Business Scenario Lab, forecasting & backtesting, multiple regression/hypothesis tests, real-time conversational voice).
- **Presentations (`PPT-01`..`03` P0/P1 -> `PPT-01.01..01.11`, `PPT-02.01..02.06`, `PPT-03.01..03.07`, `PPT-AI-01..10`, `PPT-VOICE-01..07`):** Bounded **`PS-00`** prototype (`engines/presentation`) implemented and tested against `PPT-T01..T20` (`tests/g1-ps00-presentation-feasibility.test.ts`); `PPT-T06` reference desktop viewer open remains **PENDING reference PowerPoint/Impress**, while unpacked OOXML native objects & Khmer PDF/PNG visuals passed. `PPT-01.11`, `PPT-02.06`, `PPT-03.07`, `PPT-AI-10`, `PPT-VOICE-06..07` remain P1 deferred.
- **Business Intelligence (`BI-01`..`03` P0/P1 -> `BI-01.01..01.12`, `BI-02.01..02.10`, `BI-03.01..03.12`, `BI-AI-01..10`, `BI-VOICE-01..06`):** Bounded **`BI-00`** prototype (`engines/intelligence`) using `echarts@6.1.0` + FR-05 `BusinessAnalysisEngine` verified `BI-T01..T32` and `X-VIS-01..08` (`tests/g1-bi00-intelligence-feasibility.test.ts`). P1 tests `BI-T33` (alerts) & `BI-T34` (scheduled refresh) and `BI-01.12`, `BI-02.09..10`, `BI-03.10..12` remain **PENDING P1 authorization**.
- **Integration (`INT-01`..`03` P0, `INT-04` P1 -> `INT-01.01..01.08`, `INT-02.01..02.07`, `INT-03.01..03.06`, `INT-04.01..04.03`, `INT-AI-01..08`, `INT-VOICE-01..05`):** Extended `LinkedMetricReference` + added `ArtifactReference`, `LinkedObjectBinding`, `DependencyEdge`, `WorkflowRun`, `ReportingPackageManifest`, `PublicationApproval`, PostgreSQL RLS/outbox persistence (`engines/integration`), and verified all 24 mandatory scenarios **`INT-T01..INT-T24`** against V1/V2/V3 fixtures (`tests/g1-xi00-cross-module-integration.test.ts`). P1 `INT-04.01..04.03`, `INT-AI-08`, and `INT-VOICE-05` remain deferred pending `XI-10`.
- **AI Intelligence Core (`AI-01`..`07` P0/P1 -> 39 subrequirements `AI-01.01..07.07`):** Bounded **`AIC-00`** feasibility (`modules/ai`: `AIProviderAdapter`, `ModelRoutingPolicyEngine`, `ToolDefinitionRegistry` + exact final-state verifier, `CorporateKnowledgeIndex` with ACL pre-filter + live citation recheck, `AiIntelligenceCore` `AgentRun`) verified across all 28 acceptance IDs **`AI-T01..AI-T28`** (`tests/v13-aic00-ai-intelligence-core.test.ts`). External live LLMs remain fail-closed (`423`); all local mock providers carry `isMock: true`. P1 `AI-04.06` & `AI-05.06` remain deferred pending `AIC-01+`.
- **Advanced Voice Intelligence (`VOC-01`..`02` P0, `VOC-03` P1 -> 30 subrequirements `VOC-01.01..03.07`):** Bounded **`VI-00`** feasibility (`engines/speech`: `VoiceSessionManager`, `validateVoiceCriticalFields` EN/KM numerals/USD-vs-KHR/format-vs-FX, org-versioned `TerminologyRegistry`, `VoiceGovernancePipeline` dictation isolation, silence/noise no-op, interruption recovery & ephemeral audio wiping) verified across all 30 P0 acceptance scenarios **`VOC-T01..VOC-T30`** (`tests/v13-vi00-voice-intelligence.test.ts`, mocked ASR `isMock: true` + fail-closed `423` cloud STT) plus fail-closed P1 gate **`RC-P1-05`** blocking all 7 `VOC-03` expansion features with HTTP `423` (`tests/v14-rc00-consolidation-and-tf01.test.ts`). Live native Khmer (`km-KH`) acoustic WER/CER (`NFR-T31`, `TF-09`) remains **PENDING consented human corpus**.
- **Shared Platform Administration & NFRs (`PLT-01`..`06` P0/P1 -> 40 subrequirements `PLT-01.01..06.07`, `NFR-01`..`04` P0):** Bounded **`PA-00`** feasibility (`platform/authorization` 8-role `PolicyDecisionEngine`, `platform/database` 9 new `FORCE RLS` `pa_*` tables + `PlatformGovernanceService`, `platform/storage` `LocalPrivateObjectStore`) verified across all 36 acceptance IDs **`PLT-T01..PLT-T36`** (`tests/v13-pa00-platform-admin.test.ts`) and 8 cross-cutting scenarios **`GOV-T01..GOV-T08`** (`tests/v13-integrated-golden-governance.test.ts`). Live billing/Stripe (`PLT-06.07`), external OIDC/SCIM (`PLT-01.10`), and production `PA-01+` remain gated.
- **End-to-End Scenarios (`E2E-01`..`06`, `SHT-T01`..`T18`, `GOV-T01`..`T08`):** `d1-vertical-slice-api.test.ts` covers Document §16 slice; `d1-spreadsheet-feasibility.test.ts` covers `SHT-T01..T18`; `v13-integrated-golden-governance.test.ts` verifies the V1.3 §5.1 two-tenant golden workflow (`GOV-T01..T08`).

## 5. V1.4 Complete Consolidation (`CR-008` / `FR-12` + `FR-13` + `TF-01`)

- **Change Record `CR-008` (`APPROVAL-01` & `APPROVAL-02`, 2026-11-26):** Adopted progressive delivery ordering **`S1 -> S2 -> S3`** while preserving **100% of all 51 original parent requirements (`46 P0`, `5 P1`)** and **all 313 defined acceptance test IDs** without silent scope deletion.
- **Canonical Traceability Artifacts:**
  - Verbatim V1.4 archive: `documentation/AI_Office_Suite_FR12_FR13_Main_Research_Report_V1.4.md`
  - Master 51-parent + 313-test matrix (verified live by automated parser `RC-T07`): `documentation/REQUIREMENTS_TRACEABILITY_MATRIX.md`
  - Consolidated `FR-12` quality acceptance matrix (`NFR-01..04`, `NFR-T01..T40`): `documentation/QUALITY_ACCEPTANCE_MATRIX.md`
  - Stage 4 Technical Feasibility Plan (`TF-01..TF-12`, `APPROVAL-01..07`): `documentation/TECHNICAL_FEASIBILITY_PLAN.md`

