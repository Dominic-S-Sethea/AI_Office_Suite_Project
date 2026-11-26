# Project Context — AI Office Suite (AI Corporate Workspace)

**Document Version:** 1.4 (Stage 1–3 Complete Requirements Consolidation — `FR-01`..`FR-13` / `CR-008`)  
**Date:** 26 November 2026  
**Stage & Authorization Status:** All **13 Stage 3 research workstreams (`FR-01`..`FR-13`)** drafted and consolidated locally alongside bounded local feasibility baselines (`D0`, `D1`, `D2`, `SS-00`, `DP-00`, `AN-00`, `PS-00`, `BI-00`, `XI-00`, `PA-00`, `AIC-00`, `VI-00`, `RC-00`/`QE-00`/`TF-01`) and zero-cost local `TF-04` (1M-row DuckDB spill) & `TF-11` (CycloneDX 1.5 SBOM + UI coverage). Stage 3 exit is **conditionally complete** for planning; formal production baseline freeze, external Stage 4 investigations (`TF-02`/`TF-03`/`TF-05`/`TF-08`/`TF-09`/`TF-10`/`TF-11` cloud/`TF-12`), commercial licensing purchases, live external LLM/speech/billing activation, and production buildout (**`S1 -> S2 -> S3`**, `D3+`/`PA-01+`/`AIC-01+`/`VI-01+`) remain strictly gated pending explicit Founder approval (`APPROVAL-03..07`).

## 1. Product Vision

AI Office Suite is a commercial, AI-native corporate productivity and business intelligence platform for small and medium-sized businesses (SMEs, ~10–250 staff), focused on administration, finance, and management.

The platform connects four professional studios over one unified modular core backed by shared **Data Preparation (`FR-04`)**, **Business Analysis (`FR-05`)**, **Cross-Module Integration (`FR-08`)**, **AI Intelligence (`FR-09`)**, **Bilingual Voice (`FR-10`)**, and **Shared Platform Administration (`FR-11`)** layers:
1. **Document Studio (`FR-02`, `DOC-01..05`)** — Word-inspired structured document authoring, bilingual EN/KM typography, templates, review, DOCX/PDF export.
2. **Spreadsheet Studio (`FR-03`, `SHT-01..06`)** — Excel-inspired calculation, financial modeling, XLSX/CSV interoperability, and Formula Intelligence.
3. **Presentation Studio (`FR-06`, `PPT-01..03`)** — PowerPoint-inspired editable 16:9 slide decks (`pptxgenjs` PPTX + HarfBuzz PDF) bound to certified metrics.
4. **Intelligence Studio (`FR-07`, `BI-01..03`)** — Power BI-inspired semantic dashboards, cross-filters, `DataScopePolicy` row/column governance, Apache ECharts SSR visuals, and scoped drill-through/exports.
5. **Unified AI Core, EN/KM Voice & Shared Platform Governance (`FR-08`..`FR-12`)** — Contextual AI assistance, controlled tool execution, English + Khmer voice-to-action, multi-tenant PostgreSQL `FORCE RLS`, private versioned object storage, quotas, durable fenced jobs, and append-only audit.

## 2. Core Engineering & Delivery Principles (`CR-008`)

> **AI interprets user intent; application policy authorizes; deterministic software engines compute, validate, and mutate authoritative state; independent checks verify; users approve high-impact results.**  
> The system must never substitute unverified AI-generated numbers for deterministic, traceable calculations, and voice is never an authentication or permission bypass.

- **Master Baseline Preservation:** All **`51` original parent requirements (`46 P0`, `5 P1`)** and **`313` canonical acceptance test IDs** are preserved verbatim (`documentation/REQUIREMENTS_TRACEABILITY_MATRIX.md`).
- **Progressive Production Delivery Order (`APPROVAL-01` / `CR-008`):** **`S1` (Document-first vertical slice) -> `S2` (Governed numerical intelligence) -> `S3` (Complete integrated reporting workflow)** without silently dropping any P0 MVP release requirement.

## 3. Bilingual Language Update (`CR-001`, Superseding Research V1.0)

While Master Research V1.0 assumed an English-only initial voice launch, **Product Development Master Plan V1.0** and **FR-03..FR-13** establish **both English (`en-US`) and Khmer (`km-KH`)** text and voice command support from the initial vertical-slice target (`S1`), with independent input/UI/output language routing and HarfBuzz/Grapheme-safe Khmer rendering.

## 4. Repository Isolation & Clean-Room Heritage

Per D0.01 ("Preserve existing files and uncommitted work; do not perform destructive reconstruction"), the project was initialized cleanly as a standalone modular monorepo with zero legacy product naming and strict license hygiene (`scripts/check-licenses.mjs`, `scripts/check-hygiene.mjs`, `scripts/generate-sbom.mjs`).
