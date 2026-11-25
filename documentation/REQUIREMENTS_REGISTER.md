# Requirements Traceability Register — AI Office Suite

**Baseline Sources:**
- Master Research & Project Context V1.0 (V0.1 Register: 51 grouped entries — 46 P0, 5 P1; plus 15 WS refinements)
- Product Development Master Plan V1.0 (Bilingual English + Khmer voice update)
- Stage 3 — FR-03: Spreadsheet Studio Detailed Baseline (`SHT-01.01`..`SHT-06.03`, `SHT-AI-01`..`10`, `SHT-VOICE-01`..`08`, `SHT-T01`..`T18`)

> All original requirement IDs are preserved verbatim for full traceability. No requirement is silently deleted or altered.

## Change Control Record

| Change ID | Source | Summary of Change | Impact |
| :--- | :--- | :--- | :--- |
| CR-001 | Product Development Plan V1.0 (§2, §11) | Supersedes English-only MVP voice assumption (`VOC-01/02`) to require **English (`en-US`) and Khmer (`km-KH`)** voice capture, transcript review, and independent input/UI/output language routing. | Extends `VOC-01`, `VOC-02`, and `DOC-01..04` with Khmer typography, `Intl.Segmenter` grapheme safety, and `km-KH` speech benchmarks. |
| CR-002 | Stage 3 — FR-03 (§23, §24) | Expands `SHT-01..06` into detailed testable requirements (`SHT-01.01..SHT-06.03`, `SHT-AI-01..10`, `SHT-VOICE-01..08`) and adds `SHT-T01..T18`. | Extends D1 feasibility scope with isolated SS-00 spreadsheet engine & licensing evaluation without authorizing full production buildout. |
| CR-003 | Handover V1.1 — FR-04 (§5) | Expands `DAT-01..06` into 30 detailed requirements (`DAT-01.01..DAT-06.05`), `DAT-AI-01..07`, `DAT-VOICE-01..04`, and `DAT-T01..T18`. | Authorizes bounded local `DP-00` feasibility spike comparing DuckDB vs. Polars without starting DP-01 production buildout. |

## 1. Shared Workspace Refinements (`WS-01` .. `WS-15`)

| ID | Priority | Requirement | Phase Target | Status in D1 |
| :--- | :--- | :--- | :--- | :--- |
| WS-01 | P0 | Unified organization workspace (`PLT-01`) | D2 | Provisional shell + tenant/workspace headers |
| WS-02 | P0 | Single sign-in across modules (`PLT-01`) | D2 | Deferred to D2 auth extraction |
| WS-03 | P0 | Common user and role management (`PLT-01`, `NFR-01`) | D2 | Provisional RBAC matrix (`owner..viewer`) tested |
| WS-04 | P0 | Central artifact and file catalog (`PLT-03`) | D2 | Local document list implemented |
| WS-05 | P0 | Shared dataset catalog (`DAT-01`, `ANA-01`) | D7 / FR-04 | Interface placeholder only |
| WS-06 | P0 | Cross-module navigation and context (`AI-01`) | D2 | Shell routes + planned studio badges |
| WS-07 | P0 | Linked reports, sheets, slides, dashboards (`INT-01`) | D7 | `LinkedMetricPlaceholderBlock` contract defined |
| WS-08 | P0 | Version history and recovery (`PLT-02`) | D2/D3 | Append-only revisions + restore-as-new-rev verified |
| WS-09 | P0 | Central AI assistant and voice (`AI-01`, `VOC-01/02`) | D4/D5 | Prototype EN/KM panel + mock speech verified |
| WS-10 | P0 | Shared permissions and audit history (`AI-05/06`, `NFR-01`) | D2 | Append-only JSONL audit + redaction verified |
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
- **Analytics (`ANA-01`..`03` P0, `ANA-04` P1):** Pending FR-05 research.
- **Presentations (`PPT-01`..`03` P0):** Pending FR-06 research; route placeholder `/presentations` registered.
- **Business Intelligence (`BI-01`..`03` P0):** Pending FR-07 research; route placeholder `/analytics` registered.
- **Integration (`INT-01`..`03` P0, `INT-04` P1):** Forward contract `LinkedMetricReference` implemented.
- **AI & Voice (`AI-01`..`07` P0, `VOC-01`..`02` P0, `VOC-03` P1):** Typed proposals, preview diff, idempotency, RBAC, prompt-injection defense, mock EN/KM speech verified.
- **Platform & NFRs (`PLT-01`..`06` P0, `NFR-01`..`04` P0):** RBAC, version restore, macro blocking, audit trail, license audit implemented; production auth/DB/backup deferred to D2.
- **End-to-End Scenarios (`E2E-01`..`06` + `SHT-T01`..`T18`):** `d1-vertical-slice-api.test.ts` covers Document §16 slice; `d1-spreadsheet-feasibility.test.ts` covers `SHT-T01..T07`, `T09`, `T10`, `T13`, `T14`, `T17`, `T18`.
