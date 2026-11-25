# Development Status & Engineering Checkpoint Report (§20)

**Date:** 26 November 2026  
**Active Phases:** Gates **G0** (Reproducible Baseline) and **G1** (D1-R Document/Speech Closure, SS-00 Controlled Benchmarks, and FR-04 DP-00 Data Preparation Feasibility) + **G2 Design Only** (`D2_POSTGRESQL_DESIGN.md`).

## 4. Verification Results (Verified After Final Code Edit — Run `task-355`)

- `node scripts/check-licenses.mjs`: **PASS** — scanned `430` installed third-party package versions (`39` direct dependencies); `0` disallowed licenses detected.
- `npm.cmd audit --omit=dev --audit-level=high`: **PASS (high+)**; **2 moderate** advisories reported (`uuid <11.1.1` via `exceljs@4.4.0`, `GHSA-w5hq-g745-h8pq`).
- `npm.cmd run typecheck`: **PASS** — `tsc -p tsconfig.typecheck.json --noEmit` exited `0` (`0` errors).
- `npm.cmd run build`: **PASS** — `build:api` (`tsc -p apps/api/tsconfig.build.json`) and `build:web` (`107` modules transformed including `@fontsource/noto-sans-khmer`, `@fontsource/kantumruy-pro`, and `@fontsource/inter` `.woff2` bundles).
- `npm.cmd test`: **PASS** — Vitest `v3.2.7` ran **7 test files, 19/19 tests passed** in `28.74s`:
  - `tests/d1-speech-adapter.test.ts` (3/3 passed)
  - `tests/d1-khmer-typography.test.ts` (3/3 passed)
  - `tests/d1-ai-operations.test.ts` (2/2 passed)
  - `tests/g1-dp00-data-preparation.test.ts` (3/3 passed)
  - `tests/d1-vertical-slice-api.test.ts` (1/1 passed)
  - `tests/d1-spreadsheet-feasibility.test.ts` (4/4 passed)
  - `tests/d1-docx-pdf-roundtrip.test.ts` (3/3 passed)
- **Generated Inspection Artifacts & SHA-256 Checksums:** See `documentation/G0_G1_EVIDENCE_PACKET.md`.
- **Legacy Naming Hygiene Scan:** `0` legacy project name matches across `ai-office-suite/`.

## 5. Known Limitations, Security Findings & Technical Debt

- **Provisional D1 Auth:** `apps/api` uses prototype header roles (`x-workspace-role`, `x-tenant-id`) — safe ONLY on `127.0.0.1`; **must** be replaced in D2 with HttpOnly JWT/cookie auth + `token_version` revocation extracted from the preserved parent repository.
- **Live Speech Recognition:** `MockSpeechAdapter` verified the pipeline; live `km-KH` and `en-US` acoustic WER benchmarks remain **PENDING founder authorization**.
- **Document Studio Pagination:** Tiptap MIT core shows a single A4/Letter page frame; true automatic multi-page visual pagination requires evaluating Tiptap Pro vs. custom ProseMirror pagination in D3.
- **Git Not Installed:** `git` CLI is absent on this workstation; initialize a clean Git repository before Phase D2.

## 6. Decisions Requiring Founder Approval Before Phase D2 / SS-01

1. **Document Engine Gate (D1.01):** Confirm Tiptap/ProseMirror MIT core as baseline, and decide whether to license **Tiptap Pro** (`@tiptap-pro/extension-pages`) for multi-page visual pagination or invest in custom ProseMirror pagination in D3.
2. **Bilingual Speech Gate (D1.02):** Authorize live benchmark testing of **Google Cloud STT V2 (`km-KH`)**, **Azure AI Speech (`km-KH`)**, and/or self-hosted **Faster-Whisper (Khmer CT2)** with consented EN/KM audio samples.
3. **Spreadsheet Engine Gate (SS-00):** Review commercial licensing terms for **Univer Pro** vs. **Handsontable + HyperFormula** before starting SS-01.
4. **D2 Database Selection:** Approve **PostgreSQL** (recommended for multi-tenant SaaS + workers) vs. SQLite for Phase D2 platform extraction.
