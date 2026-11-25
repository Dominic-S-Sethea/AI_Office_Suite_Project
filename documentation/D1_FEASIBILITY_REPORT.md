# Phase D1 Technical Feasibility Report — AI Office Suite

**Date:** 26 November 2026  
**Authorization Scope:** Phases **D0** (Engineering Foundation) and **D1** (Technical Feasibility Prototypes D1.01–D1.04)  
**Outcome:** Empirical prototypes built and verified locally. **No permanent production engine or live speech/AI vendor committed yet — ready for founder gate review before Phase D2.**

---

## 1. D1.01 — Document Editor Engine Evaluation

We compared two realistic architectural paths against our commercial SaaS + future self-hosted + English/Khmer requirements:

| Criterion | Candidate A: Tiptap / ProseMirror (MIT Core + Modular Conversion) | Candidate B: ONLYOFFICE Docs (Community Edition vs Developer Edition) |
| :--- | :--- | :--- |
| **License & Commercial Risk** | **MIT** (`@tiptap/react@3.35.0`, `@tiptap/starter-kit`, `@tiptap/extension-table`). Zero copyleft; commercial Pro extensions (`extension-pages`, `export-docx/pdf`) optional. | **Community Edition is AGPL v3** (Section 13 forces open-sourcing SaaS apps). Commercial embedding requires paid **Developer Edition** (per-concurrent-connection pricing). |
| **Khmer Unicode & Script Shaping** | Uses browser native DOM + **HarfBuzz + ICU**; zero broken coengs or split clusters observed in local `@fontsource/noto-sans-khmer` & `@fontsource/kantumruy-pro`. | Known historical limitations in canvas-based complex script shaping, cursor movement inside Khmer clusters, and server-side Linux font packaging (`fonts-khmeros`). |
| **Page Layout & Pagination** | CSS page-sheet framing (`A4`/`Letter`) in D1 prototype; true multi-page visual reflow inside editor requires either Tiptap Pro `@tiptap-pro/extension-pages` or custom ProseMirror pagination in D3. | Built-in Word-like paginated canvas out of the box. |
| **DOCX Round-Trip & PDF** | Implemented cleanly via `docx@9.5.1` (MIT) + `mammoth@1.9.0` (BSD-2-Clause) + `fflate@0.8.2` (MIT) + headless Chromium/Edge HarfBuzz PDF (`%PDF-`, tested real artifact). | Native OOXML engine; requires running Document Server containers & font generation scripts. |
| **AI Programmatic Control** | **Excellent:** Canonical `StudioDocument` JSON + bidirectional `toTiptapJson`/`fromTiptapJson` + `Intl.Segmenter` grapheme-safe selection offsets. | Constrained to ONLYOFFICE `DocsAPI` / Connector JS plugin sandbox. |
| **Cloud & Self-Hosted Fit** | Lightweight React SPA + Node worker (`apps/workers`) for PDF/DOCX. | Heavy multi-service Document Server container footprint. |

### D1.01 Empirical Recommendation
**Recommend Candidate A: Tiptap / ProseMirror (MIT Core)** paired with our canonical `StudioDocument` AST, `docx` (MIT) + `mammoth` (BSD-2-Clause) + `fflate` (MIT) for safe OOXML interoperability, and containerized Chromium HarfBuzz for searchable PDF export.  
**Open Founder Decision for Phase D3:** Whether to evaluate a commercial **Tiptap Pro** license for `@tiptap-pro/extension-pages` (native multi-page visual pagination, footnotes, and Word headers/footers) vs. investing engineering effort into a custom ProseMirror pagination layer.

---

## 2. D1.02 — English & Khmer Speech Recognition Evaluation

### Comparative Landscape (Verified Documentation — Live Audio Evaluation Pending Founder Authorization)

| Provider | Language Support | Strength | Risk / Limitation |
| :--- | :--- | :--- | :--- |
| **Google Cloud STT V2 (Chirp 2 / Chirp 3)** | Official `km-KH` & `en-US` | Foundation multilingual ASR, punctuation, model adaptation | Regional Chirp availability & code-switching (`km-KH` + EN business nouns) require empirical WER measurement |
| **Microsoft Azure AI Speech** | Official `km-KH` & `en-US` | Standard STT + Custom Speech adaptation | Fewer advanced add-on features for low-resource locales vs `en-US` |
| **Self-Hosted Faster-Whisper (CTranslate2)** | Native `km` (`large-v3` & fine-tuned Khmer CT2 models), **MIT** | Zero per-minute API fee; full data residency / self-hosting (`int8` CPU or `int8_float16` GPU) | Base Whisper WER on low-resource Khmer is elevated without Khmer-corpus fine-tuning |

### D1.02 Prototype Verification
- Built provider-independent `SpeechRecognitionAdapter` (`engines/speech/src/index.ts`).
- `MockSpeechAdapter` returns explicit `isMock: true` and disclaimer for synthetic `en-US` and `km-KH` fixtures.
- `google-cloud-stt-v2`, `azure-speech`, and `faster-whisper` adapters **fail closed** (`423 LIVE_SPEECH_PROVIDER_NOT_AUTHORIZED`) until `ALLOW_LIVE_SPEECH_PROVIDERS=true` and credentials are approved.
- **Live WER Status:** **PENDING FOUNDER AUTHORIZATION** (no live audio transmitted in D1).

---

## 3. D1.03 — Khmer Typography & Interoperability Evidence

Tested against synthetic bilingual fixture `tests/fixtures/bilingual-management-report.ts` (containing coeng subscript clusters `ក្រុមហ៊ុន ស្រ្តី ព្រះរាជាណាចក្រកម្ពុជា`, continuous zero-space Khmer paragraph, Khmer numerals `២០២៦`, Arabic numerals `2026`, bilingual table, and explicit page break):
- **Bundled Fonts (SIL OFL 1.1):** `@fontsource/noto-sans-khmer` (`5.3.0`), `@fontsource/kantumruy-pro` (`5.3.0`), `@fontsource/inter` (`5.3.0`) bundled cleanly into `apps/web/dist/assets/*.woff2` and embedded into PDF HTML.
- **Grapheme & Word Segmentation:** `Intl.Segmenter('km', { granularity: 'grapheme' | 'word' })` segmented continuous Khmer paragraphs cleanly and snapped programmatic insert/replace offsets so zero dangling `U+17D2` coengs occurred (`tests/d1-khmer-typography.test.ts`).
- **Real DOCX & PDF Artifacts Generated:**
  - `tests/artifacts/bilingual-management-report.docx`: Exported with explicit `w:cs="Noto Sans Khmer"` Complex Script font tags and re-imported via `mammoth` with exact Khmer Unicode preservation.
  - `tests/artifacts/bilingual-management-report.pdf`: Rendered via local headless Microsoft Edge (`158.0.4370.33`, Chromium HarfBuzz engine) producing valid `%PDF-` searchable output (`>20 KB`).
- **Visual Render Inspection (Verified via Image Read on Generated PNGs):**
  - `tests/artifacts/bilingual-management-report-render.png` and `tests/artifacts/formal-letter-render.png`: Inspected directly — Khmer `Kantumruy Pro` headings and `Noto Sans Khmer` body text show proper coeng subscript stacking (`ព្រះរាជាណាចក្រកម្ពុជា`, `ក្រុមហ៊ុន`, `ស្រ្តី`), zero tofu boxes, clean justified Khmer line breaks, and crisp table/placeholder rendering.
  - **Multi-Page PDF Counts Verified:** Formal letter = `1` page; multi-page management report = `>= 2` pages; landscape operations brief = `>= 2` pages.
  - **Limitation Observed:** `mammoth` normalizes paragraph alignment and headers/footers out on re-import, `<w:sdt>` / SmartArt / external `*.rels` are omitted with explicit `ImportDiagnostics.unsupportedFeatures` notices (original file bytes remain archived by SHA-256), and Tiptap MIT core renders a single continuous editor canvas rather than true automatic multi-page visual pagination (requiring Tiptap Pages vs. custom pagination evaluation in D3).

---

## 4. D1.04 — Controlled AI Document Operations & Vertical Slice

- Implemented all 7 D1.04 operations (`insert_text`, `replace_selection`, `set_heading`, `toggle_bold`, `set_alignment`, `insert_table` including Khmer numerals `៣x៣`, `undo_last`) for both English and Khmer instructions (`modules/ai/src/planner.ts`, `executor.ts`).
- Verified optimistic revision conflict rejection (`409`), selection-hash integrity, idempotency deduplication, prompt-injection rejection, `viewer` RBAC `403` denial, cross-tenant `403` denial, and append-only audit trail across both `typed_ai` and `voice_command` sources (`tests/d1-ai-operations.test.ts`, `tests/d1-vertical-slice-api.test.ts`).
