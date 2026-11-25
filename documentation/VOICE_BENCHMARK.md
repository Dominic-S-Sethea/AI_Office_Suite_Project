# Bilingual Voice Benchmark & Provider Evaluation — AI Office Suite

**Phase:** D1.02 Baseline + Local Faster-Whisper Bench (Approval #4)  
**Live Audio Testing Status:** **LOCAL ENGLISH SYNTHETIC BENCHMARK COMPLETED; NATIVE KHMER (`km-KH`) & CLOUD STT BENCHMARKS PENDING.** External cloud providers (`google-cloud-stt-v2`, `azure-speech`) remain fail-closed (`423`) with zero audio transmitted externally.

## 1.5 Local Faster-Whisper Bench Observations (`faster-whisper==1.2.1`, Python `3.12.10`, CPU `int8`, `tiny` model)

- **Compatibility finding fixed:** `faster-whisper==1.2.1` invokes `av.open(..., metadata_errors="ignore")` when given a file path, which raised `TypeError` against the installed PyAV wheel in `.venv-speech`. Updating `scripts/faster_whisper_worker.py` to decode PCM WAV via Python stdlib `wave` + `numpy` (mono `float32`, resampled to `16 kHz`) bypassed `av.open` cleanly.
- **Measured Synthetic English TTS (`Windows System.Speech`) Results (offline, zero external network audio):**
  - `"make bold"` -> `"Make bold."` (`2242.30 ms`)
  - `"make heading 1"` -> `"Make heading one."` (`2138.29 ms` — confirms Whisper spells small digits as words and appends punctuation, requiring spoken-number normalization before intent matching)
  - `"calculate total revenue for this month"` -> `"Calculate Total Revenue for this month."` (`2262.04 ms`)
  - `"show operating profit by department"` -> `"Show operating profit by department."` (`2403.47 ms`)
- **Disclosure:** Synthetic TTS audio does **not** represent live human corporate speakers, accented English, or Khmer (`km-KH`) acoustic WER/CER. `km-KH` evaluation requires consented native Khmer speakers per §3.

## 1. Candidate Speech Recognition Providers (English `en-US` & Khmer `km-KH`)

| Criterion | Google Cloud Speech-to-Text V2 (Chirp 2 / Chirp 3) | Microsoft Azure AI Speech | Self-Hosted Faster-Whisper (CTranslate2) |
| :--- | :--- | :--- | :--- |
| **Khmer (`km-KH`) Support** | Official (`km-KH` under Chirp 2 / Chirp 3) | Official (`km-KH` standard STT + neural TTS) | Native (`km` in Whisper `large-v3` + community fine-tuned Khmer CT2 weights) |
| **Streaming / Low Latency** | Supported (regional Chirp availability check required) | Supported (REST + WebSocket SDK) | Chunked streaming via VAD (Silero VAD) |
| **Custom Vocabulary / Adaptation** | Model adaptation / phrase hints supported | Custom Speech training datasets supported | Fine-tuning or initial prompt biasing |
| **Data Privacy / Self-Hosting** | Cloud SaaS (regional data residency options) | Cloud SaaS (containerized disconnected/connected options) | **Full self-hosting** on CPU (`int8`) or GPU (`int8_float16`) |
| **License / Cost Model** | Metered per-minute cloud API | Metered per-hour cloud API | **MIT** (Whisper + Faster-Whisper + CTranslate2); infra cost only |
| **Known Khmer Hazard** | Code-switching (`km-KH` + English business nouns) & Khmer numeral vs Arabic numeral formatting | Limited advanced add-ons for low-resource locales compared to `en-US` | Base Whisper WER is elevated on low-resource Khmer without Khmer fine-tuning |

## 2. Provider-Independent Contract (`engines/speech/src/index.ts`)

All providers implement `SpeechRecognitionAdapter`:
- Returns `{ transcript, language, confidence, provider, isMock, disclaimer, durationMs, warnings }`.
- Unconfigured live providers (`google-cloud-stt-v2`, `azure-speech`, `faster-whisper`) **fail closed** with `423 LIVE_SPEECH_PROVIDER_NOT_AUTHORIZED` unless `ALLOW_LIVE_SPEECH_PROVIDERS=true`.
- Voice transcripts **never bypass** the editable transcript review step, RBAC (`assertCanPerform`), revision checks, or explicit approval gate.

## 3. Phase D5 Live Benchmark Protocol (To Run After Founder Authorization)

Before enabling production voice in D5, run consented/synthetic audio fixtures covering 8 test categories across `en-US` and `km-KH`:
1. Clean English commands (`en-US`)
2. Clean Khmer commands (`km-KH`)
3. Khmer commands containing English corporate/technical terms (e.g., `"Revenue"`, `"PDF"`, `"USD"`)
4. Cambodian personal and organization names
5. Numbers, dates, quantities, percentages, and USD/KHR currencies
6. Office background noise (~50–60 dBA)
7. Short formatting commands (`make bold` / `ធ្វើឱ្យដិត`)
8. Multi-step document & spreadsheet instructions

**Target Exit Gate (§17 & FR-03 §25):** ≥ 95% routine-command end-to-end task success for English and ≥ 95% for Khmer evaluated separately, with statistical sample sizes reviewed at the D1/D5 gate.
