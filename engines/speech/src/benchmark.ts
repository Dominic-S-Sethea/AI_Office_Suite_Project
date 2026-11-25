import type { SpeechLanguageCode, SpeechProviderId } from "@ai-office-suite/shared-contracts";

export interface BenchmarkUtteranceRecord {
  utteranceId: string;
  language: SpeechLanguageCode;
  speakerCohort: string;
  fixtureVersion: string;
  expectedTranscript: string;
  expectedIntent: string;
  provider: SpeechProviderId;
  modelVersion: string;
  region: string;
  isMock: boolean;
  actualTranscript: string;
  latencyMs: number;
  actualOperation: string;
  verifiedOutput: boolean;
  corrected: boolean;
  abstained: boolean;
  costUsd: number;
  noiseCondition: "quiet" | "office_noise";
}

export interface BenchmarkSummary {
  totalAttempts: number;
  isMockOnly: boolean;
  firstPassTaskSuccessRate: number;
  afterConfirmationTaskSuccessRate: number;
  meanWerOrCer: number;
  correctionRate: number;
  abstentionRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

function levenshteinDistance<T>(a: T[], b: T[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}

/** Standard Word Error Rate (WER) for English reference vs hypothesis. */
export function computeEnglishWer(reference: string, hypothesis: string): number {
  const refWords = reference.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const hypWords = hypothesis.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;
  return levenshteinDistance(refWords, hypWords) / refWords.length;
}

const khmerGraphemeSegmenter = new Intl.Segmenter("km", { granularity: "grapheme" });
const khmerWordSegmenter = new Intl.Segmenter("km", { granularity: "word" });

/**
 * Khmer Character/Grapheme Error Rate (CER) on NFC-normalized text.
 * Uses Intl.Segmenter('km', { granularity: 'grapheme' }) so stacked coeng clusters
 * are counted as atomic orthographic clusters.
 */
export function computeKhmerCer(reference: string, hypothesis: string): number {
  const refGraphemes = Array.from(
    khmerGraphemeSegmenter.segment(reference.normalize("NFC").replace(/\s+/g, "")),
    (s) => s.segment,
  );
  const hypGraphemes = Array.from(
    khmerGraphemeSegmenter.segment(hypothesis.normalize("NFC").replace(/\s+/g, "")),
    (s) => s.segment,
  );
  if (refGraphemes.length === 0) return hypGraphemes.length === 0 ? 0 : 1;
  return levenshteinDistance(refGraphemes, hypGraphemes) / refGraphemes.length;
}

/** Khmer Segmented Word Error Rate using Intl.Segmenter('km', { granularity: 'word' }). */
export function computeKhmerSegmentedWer(reference: string, hypothesis: string): number {
  const refWords = Array.from(
    khmerWordSegmenter.segment(reference.normalize("NFC")),
  )
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
  const hypWords = Array.from(
    khmerWordSegmenter.segment(hypothesis.normalize("NFC")),
  )
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;
  return levenshteinDistance(refWords, hypWords) / refWords.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarizeVoiceBenchmark(records: BenchmarkUtteranceRecord[]): BenchmarkSummary {
  const total = records.length;
  if (total === 0) {
    return {
      totalAttempts: 0,
      isMockOnly: true,
      firstPassTaskSuccessRate: 0,
      afterConfirmationTaskSuccessRate: 0,
      meanWerOrCer: 0,
      correctionRate: 0,
      abstentionRate: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  const firstPassSuccess = records.filter((r) => r.verifiedOutput && !r.corrected && !r.abstained).length;
  const afterConfirmSuccess = records.filter((r) => r.verifiedOutput && !r.abstained).length;
  const corrections = records.filter((r) => r.corrected).length;
  const abstentions = records.filter((r) => r.abstained).length;

  const errors = records.map((r) =>
    r.language === "km-KH"
      ? computeKhmerCer(r.expectedTranscript, r.actualTranscript)
      : computeEnglishWer(r.expectedTranscript, r.actualTranscript),
  );
  const latencies = [...records.map((r) => r.latencyMs)].sort((a, b) => a - b);

  return {
    totalAttempts: total,
    isMockOnly: records.every((r) => r.isMock),
    firstPassTaskSuccessRate: firstPassSuccess / total,
    afterConfirmationTaskSuccessRate: afterConfirmSuccess / total,
    meanWerOrCer: errors.reduce((a, b) => a + b, 0) / total,
    correctionRate: corrections / total,
    abstentionRate: abstentions / total,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  };
}
