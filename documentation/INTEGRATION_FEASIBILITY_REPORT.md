# Cross-Module Integration Feasibility Report (`FR-08` / `XI-00`)

**Phase:** `XI-00` Bounded Local Feasibility (FR-08 Addendum V0.1)  
**Primary Architectural Recommendation (`TD-INT-01`):** Implement FR-08 as an **internal Integration & Workflow Layer inside the existing modular monolith (`engines/integration`)**, extending `LinkedMetricReference` and `ChartSpec` in place and persisting durable workflow state, approvals, artifact revisions, dependency edges, and transactional outbox records inside **PostgreSQL RLS (`platform/database`)** — without introducing a separate graph database, external workflow engine, or distributed microservice bus in P0.

---

## 1. Architecture & Pattern Comparison

| Integration Approach | Strengths | Tradeoffs & Risks | `XI-00` Decision |
| :--- | :--- | :--- | :--- |
| **In-process modular monolith orchestrator + PostgreSQL RLS & outbox (`engines/integration`)** | Zero duplicate databases or math engines; reuses FR-05 `BusinessAnalysisEngine` (`BigInt` + DuckDB), D2 `withTenantTransaction` + `audit_logs`, one short DB tx at package publication | Requires discipline to enforce async boundaries for long AI/render work before short commit tx | **Adopted (`TD-INT-01`)** — implemented and verified across all 24 scenarios `INT-T01..T24` |
| **Bidirectional silent sync across PPTX/Sheet/Doc -> Certified Datasets** | Perceived convenience for quick edits | Corrupts source truth, causes circular recalculation loops, and bypasses governance approval | **Rejected (§8)** — restricted to one-directional `source -> target` unless explicitly detached |
| **External ESB / Standalone Graph DB / Dedicated Workflow Cluster (Temporal/Neo4j)** | High-scale distributed orchestration | Heavy operational overhead, separate auth/RLS boundary to secure, unjustified for 10–250 staff SME MVP | **Deferred** — relational `xi_dependency_edges`, `xi_workflow_runs`, `xi_outbox_events` suffice |

---

## 2. Empirical `XI-00` Verification Results (`task-1032`)

- **Cross-Module Golden Fixture Reconciliation:** Synchronized workbook (`recalculateWorkbook`), document (`DocumentService`), dashboard (`IntelligenceStudioEngine`), and 6-slide presentation (`PresentationWorkspaceStore`) identically against FR-05:
  - **V1 Baseline (`SECTION_12_FINANCE_ROWS`):** Net Sales `$150,000.00`, COGS `$90,000.00`, OpEx `$20,000.00`, Operating Profit `$40,000.00`, Operating Margin `26.67%`, Prior Revenue `$125,000.00`, Revenue Growth `20.00%`.
  - **V2 Updated Dataset (`XI00_FINANCE_ROWS_V2`):** Net Sales `$160,000.00`, COGS `$96,000.00`, OpEx `$20,000.00`, Operating Profit `$44,000.00`, Operating Margin `27.50%`, Revenue Growth `28.00%` — updating drafts to revision 2 while keeping published V1 archive immutable at `$150,000.00` / `$40,000.00`.
- **PostgreSQL Atomic Commit & Outbox (`@electric-sql/pglite` under `SET LOCAL ROLE app_runtime`):**
  - Verified full transaction rollback on `simulateFailureBeforeCommit: true` (`INT-T22`: `0` partial status updates, `0` stray outbox events), followed by atomic retry writing `xi_reporting_packages`, `xi_artifacts.published_revision`, `audit_logs`, and `xi_outbox_events` together.
- **Measured `tests/g1-xi00-cross-module-integration.test.ts` Suite:**
  - `INT-T01..T09, INT-T23` sync/versioning/restore: `3,230 ms`
  - `INT-T12..T17, INT-T22` durable workflow, crash/rehydrate recovery, cancel, 409 conflicts, approval invalidation & atomic commit: `1,433 ms`
  - `INT-T10..T11, INT-T18..T21, INT-T24` security, revocation, dependency redaction, disclosure PPTX, policy cache invalidation & EN/KM parity: `660 ms` (`securityAndSyncTestMs: 655.76 ms`)

---

## 3. Unresolved Risks & Prerequisites Before `XI-01+`

1. **Hosted PostgreSQL `16/17` Connection Pool Testing:** `XI-00` executed real SQL/RLS transactions on embedded `@electric-sql/pglite@0.6.0`; production `XI-05/XI-06` must validate serialization retry behavior under `NodePgDatabaseAdapter` and real worker queues.
2. **Object Storage Orphan Reclamation:** Staging binaries before short DB commit avoids holding DB locks during conversion, requiring a scheduled orphan-cleanup sweep in production (`XI-06`).
3. **Production Studio Gates:** `D3`, `SS-01`, `DP-01`, `AN-01`, `PS-01`, `ENG-BI-01`, `FR-09`, and `FR-10` remain prerequisite gates before full cross-module UI orchestration (`XI-01..XI-10`).
