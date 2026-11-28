export interface KhmerTextAnalysis {
  normalizedText: string;
  graphemeCount: number;
  wordCount: number;
  khmerCodePoints: number;
  latinCodePoints: number;
  coengSubscriptCount: number;
  dependentVowelCount: number;
  khmerNumeralCount: number;
  arabicNumeralCount: number;
  danglingCoengCount: number;
}

const graphemeSegmenter = new Intl.Segmenter("km", { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter("km", { granularity: "word" });

export function normalizeDocumentText(text: string): string {
  return text.normalize("NFC");
}

export function segmentKhmerGraphemes(text: string): Array<{ segment: string; index: number }> {
  const normalized = normalizeDocumentText(text);
  const out: Array<{ segment: string; index: number }> = [];
  for (const part of graphemeSegmenter.segment(normalized)) {
    out.push({ segment: part.segment, index: part.index });
  }
  return out;
}

export function segmentKhmerWords(text: string): string[] {
  const normalized = normalizeDocumentText(text);
  const words: string[] = [];
  for (const part of wordSegmenter.segment(normalized)) {
    if (part.isWordLike) {
      words.push(part.segment);
    }
  }
  return words;
}

/**
 * Prevents slicing inside a Khmer grapheme cluster (for example between a base
 * consonant and U+17D2 COENG + subscript consonant or combining vowels).
 */
export function snapRangeToGraphemeBoundaries(
  text: string,
  startOffset: number,
  endOffset: number,
): { start: number; end: number } {
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
    throw new RangeError("Selection offsets must be finite numbers.");
  }
  const normalized = normalizeDocumentText(text);
  const clampedStart = Math.max(0, Math.min(startOffset, normalized.length));
  const clampedEnd = Math.max(clampedStart, Math.min(endOffset, normalized.length));
  const boundaries: number[] = [0];
  for (const part of graphemeSegmenter.segment(normalized)) {
    boundaries.push(part.index + part.segment.length);
  }
  let snappedStart = 0;
  for (const b of boundaries) {
    if (b <= clampedStart) snappedStart = b;
    else break;
  }
  let snappedEnd = normalized.length;
  for (const b of boundaries) {
    if (b >= clampedEnd) {
      snappedEnd = b;
      break;
    }
  }
  return { start: snappedStart, end: snappedEnd };
}

export function khmerNumeralsToArabic(input: string): string {
  const map: Record<string, string> = {
    "០": "0",
    "១": "1",
    "២": "2",
    "៣": "3",
    "៤": "4",
    "៥": "5",
    "៦": "6",
    "៧": "7",
    "៨": "8",
    "៩": "9",
  };
  return input.replace(/[០-៩]/g, (ch) => map[ch] ?? ch);
}

export function analyzeKhmerText(text: string): KhmerTextAnalysis {
  const normalizedText = normalizeDocumentText(text);
  const graphemes = segmentKhmerGraphemes(normalizedText);
  const words = segmentKhmerWords(normalizedText);

  let khmerCodePoints = 0;
  let latinCodePoints = 0;
  let coengSubscriptCount = 0;
  let dependentVowelCount = 0;
  let khmerNumeralCount = 0;
  let arabicNumeralCount = 0;
  let danglingCoengCount = 0;

  const chars = Array.from(normalizedText);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1780 && cp <= 0x17ff) {
      khmerCodePoints++;
    } else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      latinCodePoints++;
    }
    if (cp === 0x17d2) {
      coengSubscriptCount++;
      const next = chars[i + 1]?.codePointAt(0) ?? 0;
      if (next < 0x1780 || next > 0x17b3) {
        danglingCoengCount++;
      }
    }
    if (cp >= 0x17b6 && cp <= 0x17d1) {
      dependentVowelCount++;
    }
    if (cp >= 0x17e0 && cp <= 0x17e9) {
      khmerNumeralCount++;
    }
    if (cp >= 0x30 && cp <= 0x39) {
      arabicNumeralCount++;
    }
  }

  return {
    normalizedText,
    graphemeCount: graphemes.length,
    wordCount: words.length,
    khmerCodePoints,
    latinCodePoints,
    coengSubscriptCount,
    dependentVowelCount,
    khmerNumeralCount,
    arabicNumeralCount,
    danglingCoengCount,
  };
}
