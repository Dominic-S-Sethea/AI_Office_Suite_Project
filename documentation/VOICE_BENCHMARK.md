# Bilingual Voice Benchmark & Provider Evaluation — AI Office Suite

**Phase:** Stage 1–3 Bilingual Voice Baseline (`D1.02` + Local Faster-Whisper Bench + `VI-00` + V1.4 Alignment)  
**Live Audio Testing Status:** **LOCAL ENGLISH SYNTHETIC BENCHMARK COMPLETED; NATIVE KHMER (`km-KH`) & CLOUD STT BENCHMARKS PENDING (`NFR-T31` / `TF-09`).** External cloud providers (`google-cloud-stt-v2`, `azure-speech`) remain fail-closed (`423`) with zero audio transmitted externally.

## 1. Local Faster-Whisper Bench Observations (`faster-whisper==1.2.1`, Python `3.12.10`, CPU `int8`, `tiny` model)

- **Compatibility finding fixed:** `faster-whisper==1.2.1` invokes `av.open(..., metadata_errors="ignore")` when given a file path, which raised `TypeError` against the installed PyAV wheel in `.venv-speech`. Updating `scripts/faster_whisper_worker.py` to decode PCM WAV via Python stdlib `wave` + `numpy` (mono `float32`, resampled to `16 kHz`) bypassed `av.open` cleanly.
- **Measured Synthetic English TTS (`Windows System.Speech`) Results (offline, zero external network audio):**
  - `"make bold"` -> `"Make bold."` (`2242.30 ms`)
  - `"make heading 1"` -> `"Make heading one."` (`2138.29 ms` — confirms Whisper spells small digits as words and appends punctuation, requiring spoken-number normalization before intent matching)
  - `"calculate total revenue for this month"` -> `"Calculate Total Revenue for this month."` (`2262.04 ms`)
  - `"show operating profit by department"` -> `"Show operating profit by department."` (`2403.47 ms`)
- **Disclosure:** Synthetic TTS audio does **not** represent live human corporate speakers, accented English, or Khmer (`km-KH`) acoustic WER/CER. `km-KH` evaluation requires consented native Khmer speakers per §4 (`NFR-T31`, `TF-09`).

## 2. Candidate Speech Recognition Providers (English `en-US` & Khmer `km-KH`)

| Criterion | Google Cloud Speech-to-Text V2 (Chirp 2 / Chirp 3) | Microsoft Azure AI Speech | Self-Hosted Faster-Whisper (CTranslate2) |
| :--- | :--- | :--- | :--- |
| **Khmer (`km-KH`) Support** | Official (`km-KH` under Chirp 2 / Chirp 3) | Official (`km-KH` standard STT + neural TTS) | Native (`km` in Whisper `large-v3` + community fine-tuned Khmer CT2 weights) |
| **Streaming / Low Latency** | Supported (regional Chirp availability check required) | Supported (REST + WebSocket SDK) | Chunked streaming via VAD (Silero VAD) |
| **Custom Vocabulary / Adaptation** | Model adaptation / phrase hints supported | Custom Speech training datasets supported | Fine-tuning or initial prompt biasing |
| **Data Privacy / Self-Hosting** | Cloud SaaS (regional data residency options) | Cloud SaaS (containerized disconnected/connected options) | **Full self-hosting** on CPU (`int8`) or GPU (`int8_float16`) |
| **License / Cost Model** | Metered per-minute cloud API | Metered per-hour cloud API | **MIT** (Whisper + Faster-Whisper + CTranslate2); infra cost only |
| **Known Khmer Hazard** | Code-switching (`km-KH` + English business nouns) & Khmer numeral vs Arabic numeral formatting | Limited advanced add-ons for low-resource locales compared to `en-US` | Base Whisper WER is elevated on low-resource Khmer without Khmer fine-tuning |

## 3. Provider-Independent Contract (`engines/speech/src/index.ts`)

All providers implement `SpeechRecognitionAdapter`:
- Returns `{ transcript, language, confidence, provider, isMock, disclaimer, durationMs, warnings }`.
- Unconfigured live providers (`google-cloud-stt-v2`, `azure-speech`, `faster-whisper`) **fail closed** with `423 LIVE_SPEECH_PROVIDER_NOT_AUTHORIZED` unless `ALLOW_LIVE_SPEECH_PROVIDERS=true`.
- Voice transcripts **never bypass** the editable transcript review step, RBAC (`assertCanPerform`), revision checks, or explicit approval gate.

## 4. Live Benchmark Protocol (`TF-09` / Phase D5 — To Run After Founder Authorization `APPROVAL-03` & `APPROVAL-07`)

Before enabling production voice in D5, run consented/synthetic audio fixtures covering 9 test categories across `en-US` and `km-KH`:
1. Clean English commands (`en-US`)
2. Clean Khmer commands (`km-KH`)
3. Khmer commands containing English corporate/technical terms (e.g., `"Revenue"`, `"PDF"`, `"USD"`)
4. Cambodian personal and organization names
5. Numbers, dates, quantities, percentages, and USD/KHR currencies
6. Office background noise (~50–60 dBA)
7. Short formatting commands (`make bold` / `ធ្វើឱ្យដិត`)
8. Multi-step document & spreadsheet instructions
9. Presentation & dashboard analytical voice instructions (e.g., `"កែចំណងជើងនេះឱ្យខ្លីជាងមុន"`, `"បង្ហាញផ្នែកលក់ និងសេវាកម្ម"`, `"បង្កើតបទបង្ហាញពីផ្ទាំងព័ត៌មាននេះ"` — currently verified via deterministic mock planners `planPresentationOperation` and `planBiDashboardCommand`, native-speaker review pending)

**Target Exit Gate (§17 & FR-03 §25 & Handover V1.2 §7.3 & V1.3/V1.4 FR-10):** ≥ 95% routine-command end-to-end task success for English and ≥ 95% for Khmer evaluated separately, with statistical sample sizes reviewed at the `TF-09` / `VI-00` gate.

## 5. `VI-00` Voice Governance Extensions & V1.4 Appendix A Alignment (`FR-10`)

Implemented in `engines/speech/src/` (`voiceSession.ts`, `criticalFields.ts`, `terminology.ts`, `voiceGovernance.ts`) and verified 1:1 against V1.4 Appendix A (`VOC-T01..VOC-T30` in `tests/v13-vi00-voice-intelligence.test.ts` + `RC-P1-05` in `tests/v14-rc00-consolidation-and-tf01.test.ts`):
- **Deterministic State Machine (`VoiceSessionManager`):** Strict transitions (`idle → requesting_permission → recording → finalizing → transcribing → review_clarify → propose → authorize → execute_verify → completed | canceled | error | expired`), mic permission denial (`VOC-T01`), deliberate PTT activation (`VOC-T02..T03`), cancel & expiry (`VOC-T04`), late-partial dropping (`VOC-T13`), silence/noise no-op (`VOC-T16`), hardware/network interruption recovery (`VOC-T17..T18`), event deduplication (`VOC-T21`), ephemeral zero-retention wiping (`VOC-T26`), actor sign-out/UI-close termination (`VOC-T27`), and keyboard PTT (`VOC-T28`).
- **Dictation vs. Command Isolation (`VOC-T07`):** Imperative utterances in `mode: "dictation"` (English and Khmer) stay strictly literal text and never execute commands.
- **Bilingual EN/KM `CriticalField` Validation (`VOC-T08..T11`):** Normalizes Khmer numerals (`០–៩`), extracts amounts/periods/percentages/cell ranges, flags bare financial figures (`AMBIGUOUS_CURRENCY`), separates format-only (`display in KHR`) from FX conversion (`FX_RATE_REQUIRED`), catches ambiguous relative periods/targets, and forces `review_clarify` when ASR confidence `< 0.85`.
- **Org-Versioned Terminology Registry & Cross-Lingual Routing (`VOC-T14..T15`):** Tenant-isolated EN/KM dictionary corrects corporate ASR mishearings (`"net sails" → "Net Sales"`, `"op ex" → "OpEx"`, Khmer metric aliases) transparently without cross-tenant leakage, preserving independent input vs output language routing.
- **Typed-vs-Voice Parity, Quotas & Offline Resilience (`VOC-T05..T06`, `VOC-T19..T20`, `VOC-T22..T25`, `VOC-T29..T30`):** Voice commands pass through the exact same `PolicyDecisionEngine`, prompt-injection scanner, quota accounting, and deterministic studio planners as typed AI commands while manual editing & typed AI stay available if speech providers disconnect.
- **Provider Evaluation Matrix (Paper Comparison — Zero External Audio Sent in `VI-00`):**
  - **Self-Hosted Faster-Whisper (CTranslate2, MIT):** Best data sovereignty / self-hosting baseline; local EN synthetic bench `2.1–2.4 s` CPU `int8`; requires Khmer fine-tuning / consented corpus before `km-KH` accuracy commitment.
  - **Microsoft Azure AI Speech (`km-KH` STT + `km-KH-SreymomNeural` / `km-KH-PisethNeural`):** Official Khmer STT + neural TTS + Custom Speech; requires cloud consent & regional privacy review (`423` locked).
  - **Google Cloud STT V2 (`asia-southeast1` Chirp/Chirp 2 vs `eu`/multi-region Chirp 3):** Official `km-KH` support with regional residency considerations; requires cloud consent & live benchmark (`423` locked).
  - **OpenAI / Gemini Multimodal Audio:** Strong EN general reasoning; `km-KH` corporate accuracy, data residency, and ZDR contractual terms must be validated separately before any production routing (`423` locked).
- **Honest P1 & Corpus Disclosure (`RC-P1-05`, `NFR-T31`, `TF-09`):** All 7 `VOC-03` P1 features (streaming partials, EN/KM TTS, VAD/barge-in, within-utterance code-switching, custom pronunciation, continuous workflows, and live native Khmer `km-KH` WER/CER corpus evaluation) remain **fail-closed (`423`) and GATED / PENDING**.
