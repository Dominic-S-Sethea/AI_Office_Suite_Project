# Architecture Overview — AI Office Suite

**Phase:** Stage 1–3 Consolidated Modular Monolith Baseline (`FR-01`..`FR-13` / V1.4, aligned with ADR-001)

## 1. D0.01 Environment & Clean-Room Platform Baseline

- **Workspace status:** Standalone clean-room modular monorepo with strict TypeScript (`tsconfig.typecheck.json`), automated hygiene/license/SBOM/benchmark checks (`scripts/`), and live PostgreSQL 16 Docker RLS verification.
- **Preservation rule:** Per D0.01, zero legacy product naming or unrelated legacy subsystems were carried over.
- **Shared Platform Core (`platform/database`, `platform/identity`, `platform/authorization`, `platform/storage`, `platform/audit`):**
  - HttpOnly cookie (`aios_session`), fail-closed `JWT_SECRET`, HS256 JWT with live `token_version` epoch revocation, CSRF origin checks (`Sec-Fetch-Site` + `Origin`/`Referer`), PostgreSQL `ENABLE`/`FORCE ROW LEVEL SECURITY` under non-superuser `app_runtime`/`aios_pa00_app` roles + `REVOKE UPDATE, DELETE` on `audit_logs` & `pa_usage_ledger`, 8-role `PolicyDecisionEngine`, private versioned `LocalPrivateObjectStore`, fenced-lease `pa_jobs`, and isolated Core + XI + PA-00 logical backup/restore.
- **Non-Reusable Legacy Code (Never Extracted):** Legacy project/task/board/kanban/git/canvas/3D routes, shell-execution gateway, headless GUI automation, and legacy MCP packages.

## 2. Modular Monolith Architecture (ADR-001)

The repository implements a strict **modular monolith** with enforced package boundaries — zero duplicate tenant, auth, AI, speech, billing, or audit subsystems per studio:

```
apps/web (React 19 + Vite + Tiptap v3)  ──HTTP/JSON──▶  apps/api (Express 4 + Helmet + JWT/PG RLS)
                                                               │
                    ┌──────────────────────────────────────────┼──────────────────────────────────┐
                    ▼                                          ▼                                  ▼
           modules/documents                              modules/ai                        platform/*
      (CRUD, versions, restore,                      (AIC-00: AIProviderAdapter,         (identity JWT/CSRF,
       DOCX/PDF export, audit)                        ModelRoutingPolicyEngine,           database Pg/PGlite FORCE RLS
                    │                                 CorporateKnowledgeIndex RAG,        + 9 pa_* tables + backup,
                    │                                 ToolDefinitionRegistry,             authorization 8-role Policy,
                    │                                 AgentRun + verifyFinalState)        storage LocalPrivateObjectStore,
                    ▼                                          │                          audit append-only redacted)
      ┌─────────────┴─────────────┬────────────────────────────┼───────────────┐
      ▼                           ▼                            ▼               ▼
engines/document          engines/file-conversion       engines/speech   engines/data-processing
(Canonical AST,           (DOCX export/import +         (VI-00: Voice     (FR-04 DP-00 DuckDB
 Khmer Intl.Segmenter)     HarfBuzz PDF renderer)        Session, EN/KM    1M-row spill ETL &
                                                         CriticalFields,   Polars parity)
                                                         Terminology,
                                                         Mock + Faster-Whisper)

[FR-03 SS-00 Spike]:  engines/calculation  (Formula dependency graph, exceljs XLSX, OWASP CSV safety)
[FR-05 AN-00 Spike]:  engines/analytics    (BusinessMetricRegistry, BigInt FIN-POL-V1, descriptive stats, DuckDB exact analytics)
[FR-06 PS-00 Spike]:  engines/presentation (StudioPresentation, PptxGenJS native PPTX, fflate import, HarfBuzz PDF/PNG)
[FR-07 BI-00 Spike]:  engines/intelligence (Apache ECharts SSR SVG, Vega-Lite comparison, DataScopePolicy, FR-05 sync)
[FR-08 XI-00 Spike]:  engines/integration  (Artifact Registry, LinkedObjectBinding, Dependency/Impact, Workflow Orchestrator, Reporting Package Manifest + PG RLS outbox)
```

## 3. Architectural Invariants

1. **Deterministic Engines Own State & Math:** AI modules produce typed, validated operation proposals (`DocumentOperationProposal`, `SpreadsheetOperationProposal`, `ToolDefinitionRegistry`) — never direct SQL, filesystem, or numerical overrides — verified independently via `verifyFinalState()`.
2. **Grid ≠ Corporate Database (`FR-03` §13):** Spreadsheet cells are modeled separately from governed datasets (`LinkedMetricReference` carries `datasetId`, `datasetVersion`, `metricVersion`, and `mode: 'live_draft' | 'published_snapshot'`).
3. **Single Policy & Governance Plane (`FR-09`/`10`/`11`):** Every `manual`, `typed_ai`, `voice_command`, and `workflow` action passes through the same `PolicyDecisionEngine`, tenant `FORCE RLS` boundaries, atomic quota reservations, and append-only redacted audit trail.
4. **Adapter Replaceability & Fail-Closed External Gates:** Document editor, speech provider, AI provider, and object storage sit behind explicit TypeScript interfaces; external LLMs, cloud STT, and P1 `VOC-03` voice expansion features remain fail-closed (`423`) until explicit Founder approval (`APPROVAL-03`/`APPROVAL-07`).
5. **Heavy Worker Readiness:** DOCX/XLSX/PPTX parsing, DuckDB 1M-row spill processing, and Chromium PDF rendering are stateless/sandboxed functions ready for isolated worker deployment in production milestones (`S1 -> S2 -> S3`).
6. **One-Directional Linked Sync & Two-Stage Atomic Publication (`FR-08`):** Linked objects synchronize strictly `source -> target` unless explicitly detached, and multi-module Reporting Packages stage artifacts out-of-transaction before committing publication state, artifact revisions, `audit_logs`, and `xi_outbox_events` in one short PostgreSQL RLS transaction.
