# Intelligence Studio & Cross-Module Acceptance Matrix (`BI-T01` – `BI-T34`, `X-VIS-01` – `X-VIS-08`)

**Test Suite:** `tests/g1-bi00-intelligence-feasibility.test.ts`

## 1. Intelligence Studio Scenarios (`BI-T01` – `BI-T34`)

| Test ID | Scenario | BI-00 Status | Verification Notes |
| :--- | :--- | :---: | :--- |
| **BI-T01** | Create / save / reopen dashboard | **PASS** | Bilingual report persists revision & structure |
| **BI-T02** | Add KPI with certified metric | **PASS** | Matches FR-05 `$150,000.00`, `$40,000.00`, `26.67%`, `+20.00%` |
| **BI-T03** | Add bar & line charts | **PASS** | Real ECharts `v6.1.0` SVG + Edge PNG render (`yAxisStartsAtZero = true`) |
| **BI-T04** | Filter report / page / visual | **PASS** | Scoped queries reconcile to `Sales + Services` (`$125k / $35k / 28.00% / 19.05%`) |
| **BI-T05** | Cross-filter department | **PASS** | Recomputed server-side via FR-05 engine |
| **BI-T06** | Reset / All / empty selection | **PASS** | Reset restores `ALL` within policy (`$150k` for Editor; `$80k` for Sales Viewer) |
| **BI-T07** | Drill into permitted records | **PASS** | Paginated records stripped of disallowed columns + return context preserved |
| **BI-T08** | Overall profit margin aggregation | **PASS** | Combined `$40k / $150k = 26.67%` (no naive simple average) |
| **BI-T09** | Distinct customers across depts | **PASS** | `C1, C2` (Sales) + `C2, C3` (Services) -> `3`, not `4` |
| **BI-T10** | Budget vs actual at common grain | **PASS** | Pre-aggregates before join -> zero budget multiplication (`+$3,000` on Sales+Services) |
| **BI-T11** | Zero matches / unavailable state | **PASS** | Out-of-scope filter intersection returns explicit `state: "empty"`, no fake zero |
| **BI-T12** | Mixed currency / period guard | **PASS** | Delegated & enforced by FR-05 `BusinessAnalysisEngine` (`ANA-T08`) |
| **BI-T13** | Dashboard with Khmer labels | **PASS** | Mixed EN/KM title, series & SVG axis labels |
| **BI-T14** | Equivalent EN / KM BI instructions | **PASS (Mock)** | `planBiDashboardCommand` resolves identical `["Sales", "Services"]` scope |
| **BI-T15** | Change chart type (`column` -> `bar`) | **PASS** | Visual changes cleanly while `FIN-NET-SALES` remains `$125,000.00` |
| **BI-T16** | Unauthorized tenant ID | **PASS** | Cross-tenant read rejected (`403 AuthorizationError`) |
| **BI-T17** | Restricted Sales-only role view | **PASS** | Default `"All"` scoped to Sales (`$80,000.00`, `$20,000.00`, `25.00%`), `cogs`/`opex` hidden |
| **BI-T18** | Cache reused across roles | **PASS** | Policy-keyed cache isolates full vs Sales-only queries (`cacheHit: false` across roles) |
| **BI-T19** | Revoked access to historical snapshot | **PASS** | `revokePrincipalAccess()` blocks subsequent snapshot reads (`403 ACCESS_REVOKED`) |
| **BI-T20** | Refresh succeeded on draft only | **PASS** | Advances draft manifest to `v2`; historical `v1` snapshot untouched |
| **BI-T21** | Refresh failed / cancelled | **PASS** | Retains `previousGoodManifestVersion: 1` and exposes `STALE_MANIFEST_RETAINED` warning |
| **BI-T22** | Rapid out-of-order filter race guard | **PASS** | Older `interactionSeq` rejected (`409 STALE_INTERACTION_DISCARDED`) |
| **BI-T23** | Retry idempotency on refresh/publish | **PASS** | Duplicate `idempotencyKey` returns same snapshot & job without duplicates |
| **BI-T24** | Publish with invalid mandatory metric | **PASS** | Blocked (`422 INVALID_MANDATORY_METRIC`) |
| **BI-T25** | Reopen historical publication | **PASS** | Pinned `datasetVersion: 1` & `snapshotSha256` preserved after v2 refresh |
| **BI-T26** | Export filtered summary CSV | **PASS** | Scoped Sales CSV exports `$80,000.00` with provenance ID & OWASP CSV safety |
| **BI-T27** | Attempt unauthorized underlying detail export | **PASS** | Denied fail-closed (`403 UNDERLYING_EXPORT_DENIED`) |
| **BI-T28** | Malicious AI / XSS ChartSpec config | **PASS** | Blocks `read_csv_auto('http://...')` and `<script>` ChartSpec titles |
| **BI-T29** | Create linked management presentation | **PASS** | Generates 6-slide `StudioPresentation` + `.pptx` directly from dashboard scope |
| **BI-T30** | Manual mode when AI unavailable | **PASS** | Direct filter, chart, drill-through, export operate without AI |
| **BI-T31** | Accessible chart & table fallback | **PASS** | ECharts `aria.enabled = true` paired with semantic HTML `<table>` fallback |
| **BI-T32** | Bounded cancellable query | **PASS** | `AbortSignal` aborts cleanly (`499 QUERY_CANCELLED`) |
| **BI-T33** | Governed KPI threshold alert (P1) | **PENDING P1** | P1 expansion deferred per FR-07 §11 |
| **BI-T34** | Scheduled automated refresh (P1) | **PENDING P1** | P1 expansion deferred per FR-07 §11 |

## 2. Integrated Cross-Module Gate Scenarios (`X-VIS-01` – `X-VIS-08`)

| Test ID | Scenario | Outcome | Notes |
| :--- | :--- | :---: | :--- |
| **X-VIS-01** | Same metric across Sheet, Doc, BI & Deck | **PASS** | Reconciled in `tests/g1-bi00-intelligence-feasibility.test.ts` |
| **X-VIS-02** | Filtered `Sales + Services` propagation | **PASS** | `$125k / $35k / 28.00%` propagated into Sheet formula `28`, Doc, BI & `.pptx` (`scopeLabel`) |
| **X-VIS-03** | Restricted role denied outside scope | **PASS** | Sales-only viewer capped at `$80k` across BI, drill-through & CSV export |
| **X-VIS-04** | Refresh advances draft, not historical pub | **PASS** | Draft moves to `v2`, `v1` snapshot stays intact |
| **X-VIS-05** | Appearance swap preserves provenance | **PASS** | `column` -> `bar` / `line` keeps identical `FIN-NET-SALES` / `binding` |
| **X-VIS-06** | Translate narrative preserves numbers | **PASS** | `$40,000.00` unchanged under Khmer narrative translation (`PPT-T11`) |
| **X-VIS-07** | Malicious prompt / ChartSpec blocked | **PASS** | `<script>`, `http://`, `.pptm`, `vbaProject.bin`, and prompt injections blocked |
| **X-VIS-08** | Cancel / retry never duplicates pub | **PASS** | Idempotency keys & failure preservation verified |
