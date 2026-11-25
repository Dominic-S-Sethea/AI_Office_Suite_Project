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
