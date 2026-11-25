# Phase D2 (`G2`) & FR-05 `AN-00` Consolidated Engineering Evidence Packet

**Date:** 26 November 2026  
**Prepared For:** Founder & CTO Review (Handover V1.1 §10 `(a)`–`(j)`)

---

## (a) Exact Authorized Scope Executed
- **Executed:**
  1. Founder Approval #1: Installed portable **Git.MinGit (`v2.56.1`)** inside `ai-office-suite/` only; committed G0/G1 baseline (`87f9508`, tag `v0.2.0-g1-baseline`).
  2. Founder Approval #2: Implemented **Phase D2 (`G2`)** PostgreSQL RLS control plane (`platform/database` with `pg@8.23.1` MIT + `@electric-sql/pglite@0.6.0` Apache-2.0) and extracted hardened Auth/RBAC (`platform/identity` with `bcryptjs@3.0.3`, `jsonwebtoken@9.0.3`, `aios_session` HttpOnly cookies, CSRF checks, live `token_version` epoch revocation — zero legacy naming) + `authMode: "jwt-pg"` in `apps/api`.
  3. Founder Approval #3: Authored commercial vendor RFP/outreach briefs (`documentation/VENDOR_OUTREACH_BRIEFS.md`).
  4. Founder Approval #4: Wired local `FasterWhisperLocalAdapter` (`engines/speech/src/fasterWhisper.ts`), Python 3.12.10 `.venv-speech`, and ran offline English TTS verification.
  5. **FR-05 `AN-00`** analytical feasibility spike (`engines/analytics`: `BusinessMetricRegistry`, `FIN-POL-V1` BigInt minor-unit arithmetic + 10-decimal FX scaling, hardened DuckDB execution, bilingual mock planner, `ANA-T01..T18`, `4` new FR-05 docs + `7+` doc updates).
- **Not Executed (Remaining Gated):** Commercial software purchases, external cloud speech/LLM uploads, public deployments, Git remote pushes, forecasting (`ANA-04.03`), advanced statistics (`ANA-04.04`), and `AN-01` / `SS-01` / `DP-01` / `D3` production rollouts.

## (b) Completed, Incomplete & Blocked Tasks
- **Completed:** Git baseline tag; `platform/database` + `platform/identity` + HTTP/RLS/migration/backup tests (`d2-platform-pg-auth.test.ts`); `engines/analytics` + `ANA-T01..T18` golden dataset & stress benchmarks (`g1-an00-analytics-feasibility.test.ts`); `VENDOR_OUTREACH_BRIEFS.md`; offline English Faster-Whisper `tiny` CPU test; full license/build/typecheck/test pass (`9/9` files, `24/24` tests).
- **Blocked / Pending External Action:** Live native Khmer (`km-KH`) & multi-speaker acoustic WER corpus; cloud STT API credentials/region sign-off; commercial vendor pricing replies.

## (c) Source Changes & Version-Control Status
- **Git Repo:** Cleanly isolated at `c:\Users\Reinh\OneDrive\Desktop\AI Office Project\ai-office-suite\.git` (`PARENT_HAS_GIT=False`).
- **Baseline Tag:** `v0.2.0-g1-baseline` (`87f9508`) · **Phase D2 + AN-00 Tag:** `v0.3.0-d2-an00`.
- **Parent Legacy Preservation:** Zero files outside `ai-office-suite/` modified, renamed, or deleted.

## (d) Observed Command Results (`task-594` + `task-622` + Final Doc Check)
| Command | Exit | Observed Output |
| :--- | :---: | :--- |
| `node scripts/check-licenses.mjs` | `0` | `460` installed third-party package versions (`45` direct deps), `0` disallowed licenses |
| `npm.cmd audit --omit=dev --audit-level=high` | `0` | `0` high/critical production advisories; `2` moderate `uuid <11.1.1` via `exceljs@4.4.0` |
| `npm.cmd run typecheck` | `0` | `0` TypeScript errors across all workspaces & tests |
| `npm.cmd run build` | `0` | `build:api` (`tsc`) + `build:web` (`107` modules incl. Khmer `.woff2`) |
| `npm.cmd test` | `0` | **9/9 test files, 24/24 tests passed** in `24.38s` |
| Legacy naming hygiene scan | `0` | `LEGACY_MATCH_COUNT=0` across `ai-office-suite/` |
| Local `.venv-speech` Faster-Whisper (`tiny` CPU `int8`, synthetic EN SAPI WAVs) | `0` | `4/4` WAVs transcribed locally in `2138–2403 ms` (`"Make bold."`, `"Make heading one."`, `"Calculate Total Revenue for this month."`, `"Show operating profit by department."`) |

## (e) Measured Benchmarks & Artifact Integrity
- **AN-00 DuckDB Analytical Stress (`benchmarkAnalyticsDuckDb`):**
  - `10,000` rows: `p50 = 18.92 ms`, `p95 = 27.58 ms`, `rssDelta = -0.10 MB` (preceding isolated run `24.09 ms / 27.31 ms`).
  - `50,000` rows: `p50 = 28.74 ms`, `p95 = 47.96 ms`, `rssDelta = +1.07 MB` (preceding isolated run `20.02 ms / 23.02 ms`).
- **Precision Comparison:** JS `0.1 + 0.2 = 0.30000000000000004` vs. BigInt exact minor units `0.30`; `divideExactScaled(25n, 2n, 0, ...)` yields `13` (`HALF_UP`) and `12` (`HALF_EVEN`).
- **`package-lock.json` SHA-256:** `0BDD0931F648642CB7C10A1A40FB94E9B9DF59CC50C548563DCF55E4E3EBBEAD`.

## (f) Mock vs. Live Distinctions
- **PostgreSQL & RLS (`PgliteDatabaseAdapter`):** Executed against real embedded PostgreSQL SQL (`@electric-sql/pglite@0.6.0`) enforcing `SET LOCAL ROLE app_runtime`, `ENABLE`/`FORCE ROW LEVEL SECURITY`, `REVOKE UPDATE, DELETE ON audit_logs`, composite tenant FKs, and rollback transactions. `NodePgDatabaseAdapter` is implemented and typechecked for external PostgreSQL `16/17` servers via `DATABASE_URL`, not exercised against a hosted PostgreSQL daemon yet.
- **DuckDB Analytics (`@duckdb/node-api@1.4.5-r.1`):** Real native engine executing parameterized queries with `SET enable_external_access = false`.
- **Speech (`MockSpeechAdapter` vs. `FasterWhisperLocalAdapter`):** Pipeline tests in Vitest use `MockSpeechAdapter` (`isMock: true`) plus fail-closed `423`/`400` checks; standalone `.venv-speech` benchmark used offline `System.Speech` English WAVs (`isMock: false` CPU inference), NOT native human speakers or `km-KH`.
- **Analytical AI Planner (`planAnalyticalCommand`):** Deterministic bilingual mock (`isMockPlanner: true`, `aiInterpretation.isObservedFact: false`).

## (g) Dependency & License Audit
- Added direct runtime deps: `pg@8.23.1` (`MIT`), `@electric-sql/pglite@0.6.0` (`Apache-2.0`), `bcryptjs@3.0.3` (`BSD-3-Clause`), `jsonwebtoken@9.0.3` (`MIT`).
- Added Python `.venv-speech` (gitignored, local-only): `faster-whisper==1.2.1` (`MIT`), `ctranslate2==4.9.1` (`MIT`).

## (h) Security Findings & Remediations Applied During Execution
- Observed `DECIMAL/DECIMAL` floating coercion & `rateScale=6` FX rounding (`0.0002439024` rounding to `0.000244`, giving `$10,004.00` instead of `$10,000.00` on `41M KHR`); remediated immediately in `engines/analytics/src/precision.ts` by upgrading FX `rateScale` to `10`.
- Observed `faster-whisper==1.2.1` `av.open(..., metadata_errors="ignore")` PyAV `TypeError`; fixed in `scripts/faster_whisper_worker.py` via stdlib `wave` + `numpy`.
- Disclosed `exceljs@4.4.0` moderate `uuid <11.1.1` advisory (`--omit=dev`) and dev-only `vitest/tinypool <=2.1.1` critical/moderate advisories (`npm audit`).

## (i) Key Architectural Decisions Added/Updated
- **`TD-ANA-01`:** DuckDB SQL grouping + BigInt minor-unit arithmetic (`FIN-POL-V1`) + versioned `BusinessMetricRegistry`.
- **`TD-PLAT-01` & `TD-GIT-01`:** Implemented locally and verified (`D2` PostgreSQL/JWT RLS + portable `Git.MinGit`).

## (j) Recommended Next Actions Pending Founder Review
1. Send `documentation/VENDOR_OUTREACH_BRIEFS.md` to Tiptap, Univer, Handsontable/HyperFormula, and optionally ONLYOFFICE Developer to collect written OEM quotes before D3 / SS-01.
2. Provide consented native `km-KH` & corporate `en-US` audio samples to run live bilingual WER/CER evaluation (`TD-VOICE-01`).
3. Authorize Phase **FR-06 (Presentation Studio research)** and/or **D3 / AN-01** production transition review.
