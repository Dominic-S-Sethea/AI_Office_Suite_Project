# Architecture Overview — AI Office Suite

**Phase:** D0/D1 Baseline (Aligned with ADR-001 Unified Modular Platform)

## 1. D0.01 Environment & Preserved Parent Codebase Assessment

- **Workspace status:** The parent directory preserves the earlier unrelated application unmodified. Inside `ai-office-suite/`, official portable Git (`Git.MinGit v2.56.1`) is initialized with local commits/tags (`v0.2.0-g1-baseline`), and Node.js `v24.22.3` with `npm 11.19.1` is active.
- **Preservation rule:** Per D0.01, zero existing files outside `ai-office-suite/` were altered or deleted.
- **Extracted Phase D2 Platform Assets (`platform/database` + `platform/identity`):**
  - Cleanly extracted & modernized HttpOnly cookie (`aios_session`), fail-closed `JWT_SECRET`, HS256 JWT with live `token_version` epoch revocation, CSRF origin check (`Sec-Fetch-Site` + `Origin`/`Referer`), PostgreSQL RLS schema with `app_runtime` non-superuser role + `REVOKE UPDATE, DELETE ON audit_logs`, atomic version-pointer commits, and reversible `.local-data/` migration (zero legacy naming carried over).
- **Non-Reusable Legacy Code (Never Extracted):** Legacy project/task/board/kanban/git/canvas/3D routes, shell-execution gateway, headless GUI automation, and legacy MCP packages.

## 2. Modular Monolith Architecture (ADR-001)

`ai-office-suite/` implements a strict **modular monolith** with enforced package boundaries:

```
apps/web (React 19 + Vite + Tiptap v3)  ──HTTP/JSON──▶  apps/api (Express 4 + Helmet + JWT/PG RLS)
                                                               │
                    ┌──────────────────────────────────────────┼──────────────────────────────────┐
                    ▼                                          ▼                                  ▼
           modules/documents                              modules/ai                        platform/*
      (CRUD, versions, restore,                      (EN/KM NL -> validated              (identity JWT/CSRF,
       DOCX/PDF export, audit)                        DocumentOperationProposal,          database Pg/PGlite RLS,
                    │                                 idempotency, prompt safety)         authorization, storage, audit)
                    ▼                                          │
      ┌─────────────┴─────────────┬────────────────────────────┼───────────────┐
      ▼                           ▼                            ▼               ▼
engines/document          engines/file-conversion       engines/speech   engines/data-processing
(Canonical AST,           (DOCX export/import +         (Mock + local    (FR-04 DP-00 DuckDB
 Khmer Intl.Segmenter)     HarfBuzz PDF renderer)        Faster-Whisper)  ETL & Polars parity)

[FR-03 SS-00 Spike]:  engines/calculation  (Formula dependency graph, exceljs XLSX, OWASP CSV safety)
[FR-05 AN-00 Spike]:  engines/analytics    (BusinessMetricRegistry, BigInt FIN-POL-V1, DuckDB exact analytics)
[FR-06 PS-00 Spike]:  engines/presentation (StudioPresentation, PptxGenJS native PPTX, fflate import, HarfBuzz PDF/PNG)
[FR-07 BI-00 Spike]:  engines/intelligence (Apache ECharts SSR SVG, Vega-Lite comparison, DataScopePolicy, FR-05 sync)
```

## 3. Architectural Invariants

1. **Deterministic Engines Own State & Math:** AI modules produce typed `DocumentOperationProposal` or `SpreadsheetOperationProposal` objects — never direct SQL, filesystem, or numerical overrides.
2. **Grid ≠ Corporate Database (FR-03 §13):** Spreadsheet cells are modeled separately from governed datasets (`LinkedMetricReference` carries `datasetId`, `datasetVersion`, `metricVersion`, and `mode: 'live_draft' | 'published_snapshot'`).
3. **Adapter Replaceability:** Document editor, speech provider, AI planner, and storage backend sit behind explicit TypeScript interfaces so Phase D2+ infrastructure choices (e.g., PostgreSQL + S3 + live STT/LLM) swap cleanly without rewriting domain logic.
4. **Heavy Worker Readiness:** DOCX/XLSX parsing and Chromium PDF rendering are stateless buffer-in/buffer-out functions in `engines/file-conversion` and `engines/calculation`, ready to move into `apps/workers` in D2.
