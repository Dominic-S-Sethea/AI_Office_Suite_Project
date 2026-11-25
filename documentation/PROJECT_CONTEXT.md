# Project Context — AI Office Suite (AI Corporate Workspace)

**Document Version:** 1.2 (Consolidated FR-03..FR-07 Feasibility + Phase D2 Foundation)  
**Date:** 26 November 2026  
**Authorization Status:** Local **D0/D1** baseline, **D2 (`G2`)** PostgreSQL RLS/auth foundation, **FR-03 `SS-00`**, **FR-04 `DP-00`**, **FR-05 `AN-00`**, and **FR-06 `PS-00` / FR-07 `BI-00`** local feasibility prototypes executed. Commercial licensing purchases, public deployments, and `D3` / `SS-01` / `DP-01` / `AN-01` / `PS-01` / `ENG-BI-01` production buildouts remain gated.

## 1. Product Vision

AI Office Suite is a commercial, AI-native corporate productivity and business intelligence platform for small and medium-sized businesses (SMEs, ~10–250 staff), focused on administration, finance, and management.

The platform connects five functional pillars inside one unified modular workspace backed by **FR-04/05** shared data & analytics engines:
1. **Document Studio (`FR-02`)** — Word-inspired structured document authoring, templates, review, DOCX/PDF export.
2. **Spreadsheet Studio (`FR-03`)** — Excel-inspired calculation, financial modeling, XLSX/CSV interoperability, and Formula Intelligence.
3. **Presentation Studio (`FR-06`)** — PowerPoint-inspired editable 16:9 slide decks (`pptxgenjs` PPTX + HarfBuzz PDF) bound to certified metrics.
4. **Intelligence Studio (`FR-07`)** — Power BI-inspired semantic dashboards, cross-filters, `DataScopePolicy` row/column governance, Apache ECharts SSR visuals, and scoped drill-through/exports.
5. **AI Intelligence Core (`FR-09/10`)** — Contextual AI assistance, controlled tool execution, and English + Khmer voice-to-action.

## 2. Core Engineering Principle

> **AI interprets user intent; deterministic software engines compute, validate, and mutate authoritative state.**  
> The system must never substitute unverified AI-generated numbers for deterministic, traceable calculations.

## 3. Bilingual Language Update (Superseding Research V1.0)

While Master Research V1.0 assumed an English-only initial voice launch, **Product Development Master Plan V1.0** and **FR-03** establish **both English (`en-US`) and Khmer (`km-KH`)** text and voice command support from the initial vertical-slice target.

## 4. Relationship to Preserved Parent Repository

Per D0.01 ("Preserve existing files and uncommitted work; do not perform destructive reconstruction"), `ai-office-suite/` is initialized as an isolated, cleanly branded workspace inside the parent repository. No files outside `ai-office-suite/` were modified or deleted, and zero legacy product naming appears inside `ai-office-suite/`.
