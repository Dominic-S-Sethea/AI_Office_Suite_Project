# Architecture Overview — AI Office Suite

**Phase:** D0/D1 Baseline (Aligned with ADR-001 Unified Modular Platform)

## 1. D0.01 Environment & Preserved Parent Codebase Assessment

- **Workspace status:** The parent directory contains an earlier, unrelated application built with Express + TypeScript + React 19 + Vite + `node:sqlite`. Git CLI is not installed on this host (`git` unavailable; no `.git` directory present inside the workspace root), and Node.js `v24.22.3` with `npm 11.19.1` is active.
- **Preservation rule:** Per D0.01, zero existing files outside `ai-office-suite/` were altered or deleted.
- **Reusable Platform Assets Identified for Phase D2 Selective Extraction:**
  - *Security & Auth Middleware:* Strict Helmet CSP, fail-closed `TRUST_PROXY`, CSRF origin validation, SSE-safe compression filter, HttpOnly cookie + HS256 JWT with `token_version` epoch revocation.
  - *Governance & AI Control Plane:* Multi-provider `ModelRouter` with failover, `modelTelemetry` cost tracking, `projectAiBudget` CAS reservation/kill-switch, append-only `audit_logs` triggers, `redaction.service.ts` (note: finance key redaction rules must be tailored so corporate financial numbers are not stripped from legitimate reports), and `urlSecurity.service.ts` SSRF + DNS-rebinding defense.
- **Non-Reusable Legacy Code (Not Extracted):** Legacy project/task/board/kanban/git/canvas/3D routes, shell-execution gateway (`shellGateway`), headless browser GUI automation (`guiAudit`), and legacy MCP server packages.

## 2. Modular Monolith Architecture (ADR-001)

`ai-office-suite/` implements a strict **modular monolith** with enforced package boundaries:

```
apps/web (React 19 + Vite + Tiptap v3)  ──HTTP/JSON──▶  apps/api (Express 4 + Helmet)
                                                               │
                    ┌──────────────────────────────────────────┼──────────────────────────────────┐
                    ▼                                          ▼                                  ▼
           modules/documents                              modules/ai                        platform/*
      (CRUD, versions, restore,                      (EN/KM NL -> validated              (authorization,
       DOCX/PDF export, audit)                        DocumentOperationProposal,          immutable storage,
                    │                                 idempotency, prompt safety)         redacted audit)
                    ▼                                          │
      ┌─────────────┴─────────────┐                            │
      ▼                           ▼                            ▼
engines/document          engines/file-conversion       engines/speech
(Canonical AST,           (DOCX export/import +         (Provider-independent
 Khmer Intl.Segmenter,     macro block, Chromium         SpeechRecognitionAdapter)
 deterministic ops)        HarfBuzz PDF renderer)

[Isolated FR-03 SS-00 Spike]: engines/calculation (Formula dependency graph, exceljs XLSX, OWASP CSV safety)
```

## 3. Architectural Invariants

1. **Deterministic Engines Own State & Math:** AI modules produce typed `DocumentOperationProposal` or `SpreadsheetOperationProposal` objects — never direct SQL, filesystem, or numerical overrides.
2. **Grid ≠ Corporate Database (FR-03 §13):** Spreadsheet cells are modeled separately from governed datasets (`LinkedMetricReference` carries `datasetId`, `datasetVersion`, `metricVersion`, and `mode: 'live_draft' | 'published_snapshot'`).
3. **Adapter Replaceability:** Document editor, speech provider, AI planner, and storage backend sit behind explicit TypeScript interfaces so Phase D2+ infrastructure choices (e.g., PostgreSQL + S3 + live STT/LLM) swap cleanly without rewriting domain logic.
4. **Heavy Worker Readiness:** DOCX/XLSX parsing and Chromium PDF rendering are stateless buffer-in/buffer-out functions in `engines/file-conversion` and `engines/calculation`, ready to move into `apps/workers` in D2.
