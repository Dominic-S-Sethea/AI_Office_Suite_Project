import { describe, expect, it } from "vitest";
import {
  computeEnglishWer,
  computeKhmerCer,
  computeKhmerSegmentedWer,
  getSpeechAdapter,
  SpeechProviderError,
  summarizeVoiceBenchmark,
  type BenchmarkUtteranceRecord,
} from "@ai-office-suite/speech-engine";

describe("D1.02 & TD-VOICE-01 — Bilingual Speech Adapter & WER/CER Benchmark Harness", () => {
  it("returns transparent mock flags and disclaimers for English and Khmer fixtures", async () => {
    const adapter = getSpeechAdapter("mock");
    expect(adapter.isMock).toBe(true);

    const enRes = await adapter.transcribe({
      language: "en-US",
      mode: "contextual",
      fixtureId: "en-translate-khmer",
    });
    expect(enRes.isMock).toBe(true);
    expect(enRes.provider).toBe("mock");
    expect(enRes.transcript).toBe("translate selection to khmer");
    expect(enRes.disclaimer).toMatch(/not evidence of live acoustic WER/i);

    const kmRes = await adapter.transcribe({
      language: "km-KH",
      mode: "command",
      fixtureId: "km-insert-table",
    });
    expect(kmRes.isMock).toBe(true);
    expect(kmRes.language).toBe("km-KH");
    expect(kmRes.transcript).toBe("បញ្ចូលតារាង ៣x៣");
  });

  it("fails closed for unauthorized live speech providers in Phase D1/G1", async () => {
    for (const provider of ["google-cloud-stt-v2", "azure-speech", "faster-whisper"] as const) {
      const adapter = getSpeechAdapter(provider);
      expect(adapter.isMock).toBe(false);
      await expect(
        adapter.transcribe({ language: "km-KH", mode: "command" }),
      ).rejects.toMatchObject({
        code: "LIVE_SPEECH_PROVIDER_NOT_AUTHORIZED",
      } satisfies Partial<SpeechProviderError>);
    }
  });

  it("computes English WER, Khmer grapheme CER, Khmer segmented WER, and mock-flagged benchmark summaries", () => {
    expect(computeEnglishWer("insert 3x3 table", "insert 3x3 table")).toBe(0);
    expect(computeEnglishWer("make heading 1", "make heading 2")).toBeCloseTo(1 / 3, 5);

    expect(computeKhmerCer("ធ្វើឱ្យដិត", "ធ្វើឱ្យដិត")).toBe(0);
    expect(computeKhmerCer("ក្រុមហ៊ុន", "ក្រុមហ៊ុ")).toBeGreaterThan(0);
    expect(computeKhmerSegmentedWer("បញ្ចូលតារាង ៣x៣", "បញ្ចូលតារាង ៣x៣")).toBe(0);

    const mockRecords: BenchmarkUtteranceRecord[] = [
      {
        utteranceId: "utt_en_01",
        language: "en-US",
        speakerCohort: "synthetic-pilot",
        fixtureVersion: "v1.0",
        expectedTranscript: "make bold",
        expectedIntent: "toggle_bold",
        provider: "mock",
        modelVersion: "mock-v1",
        region: "local",
        isMock: true,
        actualTranscript: "make bold",
        latencyMs: 4,
        actualOperation: "toggle_bold",
        verifiedOutput: true,
        corrected: false,
        abstained: false,
        costUsd: 0,
        noiseCondition: "quiet",
      },
      {
        utteranceId: "utt_km_01",
        language: "km-KH",
        speakerCohort: "synthetic-pilot",
        fixtureVersion: "v1.0",
        expectedTranscript: "តម្រឹមកណ្តាល",
        expectedIntent: "set_alignment",
        provider: "mock",
        modelVersion: "mock-v1",
        region: "local",
        isMock: true,
        actualTranscript: "តម្រឹមកណ្តាល",
        latencyMs: 6,
        actualOperation: "set_alignment",
        verifiedOutput: true,
        corrected: false,
        abstained: false,
        costUsd: 0,
        noiseCondition: "quiet",
      },
    ];
    const summary = summarizeVoiceBenchmark(mockRecords);
    expect(summary.isMockOnly).toBe(true);
    expect(summary.firstPassTaskSuccessRate).toBe(1);
    expect(summary.meanWerOrCer).toBe(0);
    expect(summary.p95LatencyMs).toBe(6);
  });
});
