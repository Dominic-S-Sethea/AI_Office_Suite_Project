# Development Roadmap — AI Office Suite

**Status:** Phases **D0**, **D1**, and **SS-00 (FR-03 Feasibility)** executed for founder engineering review. Phases **D2–D9** and **SS-01–SS-12** remain gated pending review approval.

## 1. Core Workspace & Document Studio Sequence (Product Development Plan V1.0)

| Phase | Title | Status | Gate / Dependencies |
| :--- | :--- | :--- | :--- |
| **D0** | Engineering Foundation | Complete (Prototype Baseline) | Repo layout, TS strictness, license gate, CI, governance docs |
| **D1** | Technical Feasibility | Complete (Ready for Review) | Document engine, Khmer typography, DOCX/PDF round-trip, mock EN/KM speech, 7 AI ops |
| **D2** | Shared Platform Foundation | Complete (Verified Locally in G2) | PostgreSQL RLS (`platform/database`), HttpOnly `aios_session` + HS256 JWT + `token_version` + CSRF (`platform/identity`), reversible `.local-data/` migrator, and `jwt-pg` API mode |
| **D3** | Document Studio Core | Pending Commercial Outreach Review | Full formatting, images, hyperlinks, TOC, pagination strategy decision (`VENDOR_OUTREACH_BRIEFS.md`) |
| **D4** | AI Document Intelligence | Pending D3 | Live LLM adapter via ModelRouter, conflict resolution, budget enforcement |
| **D5** | Bilingual Voice Intelligence | Pending D1.02 Live Eval | Live `km-KH` + `en-US` STT benchmark & adapter wiring (Google STT v2 / Azure / Faster-Whisper) |
| **D6** | Corporate Automation | Pending D3–D5 | Official letters, memos, meeting minutes, reports, EN/KM terminology dictionary |
| **D7** | Cross-Module Integration | Pending FR-04/05/08 | Bind live & snapshot `LinkedMetricReference` blocks across studios |
| **D8** | QA & Security Hardening | Pending D3–D7 | Penetration/SSRF/prompt-injection/RBAC matrix, WCAG 2.2 AA, load tests |
| **D9** | Private Alpha & Pilot | Pending D8 | Invitation-only SME pilot; no public launch authorized yet |

## 2. Spreadsheet Studio Workstream (`SS-00` .. `SS-12`, FR-03 §27)

| Phase | Deliverable | Status | Notes |
| :--- | :--- | :--- | :--- |
| **SS-00** | Spreadsheet engine feasibility & licensing assessment | Complete (Ready for Review) | Compares Univer vs ONLYOFFICE vs Handsontable+HyperFormula + empirical `exceljs` spike |
| **SS-01** | Workbook model & persistence | Pending Founder Review | Requires engine + commercial licensing selection |
| **SS-02** | Interactive grid & cell editing | Pending SS-01 | Virtualized grid, keyboard nav |
| **SS-03** | Formula engine & dependency management | Pending SS-01 | Full MVP function matrix (`SHT-02.01..03`) |
| **SS-04** | XLSX / CSV interoperability | Pending SS-01 | Preserves date systems, formulas, OWASP CSV safety |
| **SS-05** | Khmer typography, locale & financial data | Pending SS-01 | USD/KHR separation, leading-zero IDs, Khmer collation |
| **SS-06 – SS-12** | Operation API, Formula Intelligence, Voice, Templates, Integration, QA, Alpha | Pending | Synchronized with FR-04, FR-05, FR-09, FR-10 |

## 3. Data Preparation Workstream (`DP-00` .. `DP-12`, Handover V1.1 §8)

| Phase | Deliverable | Status | Notes |
| :--- | :--- | :--- | :--- |
| **DP-00** | Data preparation feasibility & DuckDB vs. Polars spike | Complete (Ready for Review) | Verified `DAT-T01..T18` + DuckDB `v1.4.5` vs Polars `0.26.2` |
| **DP-01 – DP-12** | Ingestion, typed staging, profiling, op registry, joins, recipes, reconciliation, AI, voice, certification, integration, hardening | Pending Founder Review | Synchronized with AN-00 arithmetic policy; DP-01 gated |

## 4. Business Analysis Workstream (`AN-00` .. `AN-09`, FR-05 §28)

| Phase | Deliverable | Status | Notes |
| :--- | :--- | :--- | :--- |
| **AN-00** | Analytical engine feasibility, precision policy & reference fixtures | **Complete (Verified)** | Reuses DuckDB + BigInt minor units (`FIN-POL-V1`); `ANA-T01..T18` & cross-module reconciliation passing |
| **AN-01 – AN-09** | Production metric registry, statistical/forecasting models, Business Scenario Lab, cross-module BI, security hardening | **Gated Pending AN-00 Review** | P1 forecasting (`ANA-04.03`) and advanced stats (`ANA-04.04`) remain out of AN-00 scope |

## 5. Presentation Studio Workstream (`PS-00` .. `PS-12`, FR-06 / Handover V1.2 §13)

| Phase | Deliverable | Status | Notes |
| :--- | :--- | :--- | :--- |
| **PS-00** | Slide model, `pptxgenjs` native PPTX export, `fflate` safe import, Khmer HarfBuzz PDF/PNG | **Complete (Local Feasibility Verified)** | Reference PowerPoint desktop open (`PPT-T06`) pending host app availability; unpacked OOXML & PDF/PNG verified |
| **PS-01 – PS-12** | Production persistence, interactive React slide editor, full themes, PPTX interop, AI ops, voice, BI sync, QA, Alpha | **Gated Pending PS-00 Review & D3 Baseline** | Requires founder sign-off after reviewing `PRESENTATION_FEASIBILITY_REPORT.md` |

## 6. Intelligence Studio Workstream (`BI-00`, `ENG-BI-01` .. `ENG-BI-11`, FR-07 / Handover V1.2 §13)

*(Note: Engineering phases use `ENG-BI-*` to avoid colliding with parent requirement IDs `BI-01..BI-03`.)*

| Phase | Deliverable | Status | Notes |
| :--- | :--- | :--- | :--- |
| **BI-00** | `ChartSpec` adapter (`echarts@6.1.0` + Vega-Lite comparison), `DataScopePolicy` RLS/cache, Section 12 FR-05 sync, refresh/snapshot, deck bridge | **Complete (Local Feasibility Verified)** | Verified `BI-T01..T32` & `X-VIS-01..08`; `BI-T33..T34` pending P1 |
| **ENG-BI-01 – ENG-BI-10** | Report model & D2 persistence, visual builder, FR-04/05 queries, drill-through, snapshots, AI/voice, presentation bridge, QA, Alpha | **Gated Pending BI-00 Review** | Production BI authoring requires founder sign-off |
| **ENG-BI-11** | Expansion: governed alerts (`BI-T33`), scheduled refresh (`BI-T34`), advanced visuals | **Pending P1 Authorization** | Out of P0 MVP scope |

## 7. Cross-Module Integration Workstream (`XI-00` .. `XI-10`, FR-08 §34)

| Phase | Deliverable | Status | Notes |
| :--- | :--- | :--- | :--- |
| **XI-00** | Cross-module integration feasibility, PG RLS/outbox commit, shared `ArtifactReference`/`LinkedObjectBinding`/`ReportingPackageManifest`, EN/KM planner & `INT-T01..T24` | **Complete (Local Feasibility Verified)** | Verified `3/3` integration test blocks (`INT-T01..T24`) + `12/12` workspace suites |
| **XI-01 – XI-09** | Production Artifact Registry, Linked Object Intelligence UI, dependency/impact explorer, refresh previews, durable worker workflows, Reporting Package Manager, live EN/KM AI & voice workflows, full QA/security audit | **Gated Pending XI-00 Review & Module/FR-09/FR-10 Gates** | Requires production studios (`D3`, `SS-01`, `DP-01`, `AN-01`, `PS-01`, `ENG-BI-01`) + hosted PostgreSQL/object storage |
| **XI-10** | Advanced automation (`INT-04.01` scheduled refresh, `INT-04.02` visual builder, `INT-04.03` external connectors) | **Pending P1 Authorization** | Out of P0 MVP scope |

## 8. V1.4 Progressive Delivery Order (`CR-008` / `APPROVAL-01`) & Stage 4 Entry

Approved progressive delivery order preserves all **51 original parent requirements (`46 P0`, `5 P1`)** while sequencing production engineering cleanly after Stage 4 feasibility exits:

| Milestone Slice | Scope Focus | Status | Exit Gate |
| :--- | :--- | :--- | :--- |
| **Stage 4 Local Subset (`TF-01`, `TF-04`, `TF-11`)** | 51-parent / 313-test RTM, V1.4 1:1 test alignment, `RC-T01..08`, 1M-row DuckDB spill, CycloneDX 1.5 SBOM & UI coverage | **VERIFIED_LOCAL** (`APPROVAL-02`, `APPROVAL-03`) | Zero-cost local evidence complete |
| **Stage 4 External Investigations (`TF-02`, `TF-03`, `TF-05`, `TF-06`, `TF-09`, `TF-12`)** | Live EN/KM LLM benchmark, consented `km-KH` speech corpus, spreadsheet vendor RFP, desktop Office QA, staging HA/load, external pentest | **Gated Pending `APPROVAL-04..07`** | See `documentation/TECHNICAL_FEASIBILITY_PLAN.md` |
| **S1 — Document-First Vertical Slice** | Production Document Studio (`DOC-01..03`), contextual AI (`AI-01/02/04/06`), EN/KM voice (`VOC-01..02`), platform auth/RLS/files (`PLT-01..04`) | **Gated Pending Stage 4 & `APPROVAL-07`** | Production entry blocked until explicit sign-off |
| **S2 — Governed Numerical Intelligence** | Spreadsheet Studio (`SHT-01..05`), Data Prep (`DAT-01..06`), Business Analysis (`ANA-01..03`), linked docs (`DOC-04`), AI RAG/budgets (`AI-03/05/07`), jobs/billing (`PLT-05..06`) | **Gated Pending S1 & `TF-05`** | Exact `FIN-POL-V1` parity required |
| **S3 — Complete Integrated Reporting Workflow** | Presentation Studio (`PPT-01..03`), Intelligence Studio (`BI-01..03`), Cross-Module Integration (`INT-01..03`), full MVP release validation (`NFR-01..04`) | **Gated Pending S2** | All `313` defined tests & external release gates |

