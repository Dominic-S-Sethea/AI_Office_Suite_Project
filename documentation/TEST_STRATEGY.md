# Test Strategy — AI Office Suite

**Phase:** D1 & SS-00 Verification Framework  
**Runner:** Vitest (`vitest@3.2.4`) + TypeScript (`tsc --noEmit`) + Automated License Gate (`scripts/check-licenses.mjs`)

## 1. Test Layers

| Suite | File | Scope & Requirements Covered |
| :--- | :--- | :--- |
| **License Compliance** | `scripts/check-licenses.mjs` | Blocks AGPL, GPL-only, SSPL, BUSL, and unknown direct dependencies across root and `apps/web` |
| **Khmer Typography** | `tests/d1-khmer-typography.test.ts` | D1.03 coeng subscripts, dependent vowels, Khmer/Arabic numerals, `Intl.Segmenter` word segmentation, grapheme-safe edit snapping |
| **DOCX & PDF Round-Trip** | `tests/d1-docx-pdf-roundtrip.test.ts` | D1.01/D1.03 DOCX export (`w:cs` Khmer font), `mammoth` re-import Unicode retention, VBA macro blocking, unsupported feature warnings, real Chromium/Edge HarfBuzz `%PDF-` rendering |
| **Controlled AI Operations** | `tests/d1-ai-operations.test.ts` | D1.04 all 7 ops in English & Khmer (with Khmer numerals `៣x៣`), stale revision `409`, idempotency, unapproved rejection, viewer RBAC `403`, prompt-injection rejection |
| **Speech Adapter Contract** | `tests/d1-speech-adapter.test.ts` | D1.02 `MockSpeechAdapter` (`isMock: true` + disclaimer), fail-closed unconfigured live STT providers (`423`) |
| **Vertical Slice API** | `tests/d1-vertical-slice-api.test.ts` | §16 complete workflow: seed EN/KM doc -> typed AI plan/apply -> EN mock voice -> KM mock voice -> viewer `403` -> cross-tenant `403` -> DOCX/PDF export -> audit verification |
| **FR-03 Spreadsheet Spike** | `tests/d1-spreadsheet-feasibility.test.ts` | SS-00 / `SHT-T01..T18` subset: multi-sheet calc recalc, `$G$1` absolute refs, leading-zero `"001245"`, USD/KHR separation, `#CYCLE!` / `#DIV/0!` / `#NAME?`, macro block, EN/KM Formula Intelligence, multi-input invariance, protected cell `403`, cell prompt-injection block, intact-row sort, OWASP CSV escaping, 20k/200k cell benchmark |

| **FR-04 Data Preparation** | `tests/g1-dp00-data-preparation.test.ts` | DP-00 / `DAT-T01..T18`: reordered XLSX+CSV, Khmer/IDs, ambiguous date refusal, null≠0, composite dedupe, §5.4 golden duplicate-key join block & reconciliation, unmatched `C999`, cancel/rerun/drift/EN-KM/injection/cross-tenant/idempotency + DuckDB vs Polars parity & 10k/100k benchmarks |

## 2. Pending Test Suites (Future Phases)

- Live acoustic English + Khmer WER benchmark (`D1.02` live audio / `D5`).
- Playwright browser UI E2E & WCAG 2.2 AA accessibility audit (`D3` / `D8`).
- Full PostgreSQL RLS & backup/restore RPO/RTO drills (`D2` / `D8`).
