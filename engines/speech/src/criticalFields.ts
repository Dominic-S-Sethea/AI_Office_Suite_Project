import type {
  CriticalFieldValidationResult,
  ExtractedCriticalField,
  SpeechLanguageCode,
  VoiceInputMode,
} from "@ai-office-suite/shared-contracts";

const KHMER_DIGITS = "០១២៣៤៥៦៧៨៩";

export function normalizeKhmerDigits(text: string): string {
  return text.replace(/[០-៩]/g, (ch) => String(KHMER_DIGITS.indexOf(ch)));
}

const FINANCIAL_INTENT_RE =
  /\b(sales|revenue|cogs|opex|profit|margin|budget|actual|cost|expense|amount|price|salary|payroll|total|update|set|change)\b|(ការលក់|ចំណូល|ចំណាយ|ប្រាក់ចំណេញ|ថ្លៃដើម|តួលេខ|ថវិកា|ដូរ|កែប្រែ)/i;

const FORMAT_ONLY_CURRENCY_RE =
  /\b(format|display|show)\b.*\b(as|in)\s+(usd|khr|riel|riels|dollar|dollars)\b|(បង្ហាញ|ទម្រង់).*(ជា)\s*(ដុល្លារ|រៀល|usd|khr)/i;

const FX_CONVERSION_RE =
  /\bconvert\b.*\b(to|into)\s*(usd|khr|riel|riels|dollar|dollars)\b|(បម្លែង|ប្តូររូបិយប័ណ្ណ).*(រៀល|ដុល្លារ|usd|khr)/i;

const EXPLICIT_FX_RATE_RE = /\b(rate|fx|exchange\s*rate)\s*[:=]?\s*\d+(?:[.,]\d+)?\b|(អត្រាប្តូរប្រាក់|អត្រា)\s*\d+/i;

const EXPLICIT_CURRENCY_AMOUNT_RE =
  /(?:(?:\$|usd)\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?))|(?:(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(usd|dollars?|khr|riels?|៛|ដុល្លារ|រៀល))/gi;

const PERCENTAGE_RE = /(\d+(?:\.\d+)?)\s*(%|percent|ភាគរយ)/gi;
const CELL_RANGE_RE = /\b([A-Z]{1,3}[1-9]\d{0,4}(?::[A-Z]{1,3}[1-9]\d{0,4})?)\b/g;
const EXPLICIT_PERIOD_RE =
  /\b(20\d{2}-(?:0[1-9]|1[0-2])|Q[1-4]\s*20\d{2}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2})\b|(?:ខែ)?(?:មករា|កុម្ភៈ|មីនា|មេសា|ឧសភា|មិថុនា|កក្កដា|សីហា|កញ្ញា|តុលា|វិច្ឆិកា|ធ្នូ)\s*(?:ឆ្នាំ)?\s*20\d{2}/gi;

const AMBIGUOUS_RELATIVE_DATE_RE =
  /\b(last\s+month|previous\s+month|previous\s+period|last\s+quarter|yesterday|recently)\b|(ខែមុន|រយៈពេលមុន|ត្រីមាសមុន|ម្សិលមិញ)/i;

const SPECIFIC_METRIC_RE =
  /\b(net\s+sales|cogs|cost\s+of\s+goods\s+sold|opex|operating\s+expenses?|operating\s+profit|operating\s+margin|revenue\s+growth|gross\s+profit)\b|(ការលក់សុទ្ធ|ថ្លៃដើមទំនិញលក់|ចំណាយប្រតិបត្តិការ|ប្រាក់ចំណេញប្រតិបត្តិការ|អត្រាប្រាក់ចំណេញប្រតិបត្តិការ)/i;

const AMBIGUOUS_TARGET_RE =
  /\b(the\s+margin|that\s+number|this\s+figure|that\s+cell|the\s+report|the\s+total)\b|(តួលេខនោះ|អត្រានោះ|របាយការណ៍នោះ)/i;

/**
 * Extracts and validates critical financial/operational fields from English and Khmer
 * voice transcripts (VI-00 / VOC-02 / VOC-T10..T14).
 * Dictation mode bypasses command extraction strictly (dictation stays literal text).
 */
export function validateVoiceCriticalFields(
  transcript: string,
  options: { language?: SpeechLanguageCode; mode?: VoiceInputMode } = {},
): CriticalFieldValidationResult {
  if (options.mode === "dictation") {
    return {
      fields: [],
      requiresClarification: false,
      ambiguityCodes: [],
      clarificationPrompts: [],
      currencyActionKind: "none",
    };
  }

  const normalized = normalizeKhmerDigits(transcript).trim();
  const fields: ExtractedCriticalField[] = [];
  const ambiguityCodes: string[] = [];
  const clarificationPrompts: string[] = [];

  // 1. Format-only vs FX conversion check (VOC-T13)
  const fxRateSpans: Array<[number, number]> = [];
  const fxSpanRe = new RegExp(EXPLICIT_FX_RATE_RE.source, "gi");
  let fxSpanMatch: RegExpExecArray | null;
  while ((fxSpanMatch = fxSpanRe.exec(normalized)) !== null) {
    fxRateSpans.push([fxSpanMatch.index, fxSpanMatch.index + fxSpanMatch[0].length]);
  }
  let currencyActionKind: CriticalFieldValidationResult["currencyActionKind"] = "none";
  if (FX_CONVERSION_RE.test(normalized)) {
    currencyActionKind = "fx_conversion_requires_rate";
    const hasExplicitRate = fxRateSpans.length > 0;
    fields.push({
      kind: "currency_intent",
      rawText: normalized.match(FX_CONVERSION_RE)?.[0] ?? "convert currency",
      normalizedValue: "fx_conversion",
      ambiguous: !hasExplicitRate,
      ...(!hasExplicitRate
        ? {
            ambiguityCode: "FX_RATE_REQUIRED",
            clarificationPrompt:
              "Currency conversion requires an explicit approved FX rate and conversion date; silent conversion is blocked.",
          }
        : {}),
    });
    if (!hasExplicitRate) {
      ambiguityCodes.push("FX_RATE_REQUIRED");
      clarificationPrompts.push(
        "Currency conversion requires an explicit approved FX rate and conversion date; silent conversion is blocked.",
      );
    }
  } else if (FORMAT_ONLY_CURRENCY_RE.test(normalized)) {
    currencyActionKind = "format_only";
    fields.push({
      kind: "currency_intent",
      rawText: normalized.match(FORMAT_ONLY_CURRENCY_RE)?.[0] ?? "format currency",
      normalizedValue: "format_only",
      ambiguous: false,
    });
  }

  // 2. Explicit currency-tagged monetary amounts (VOC-T10, VOC-T11)
  const matchedNumericSpans: Array<[number, number]> = [];
  EXPLICIT_CURRENCY_AMOUNT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_CURRENCY_AMOUNT_RE.exec(normalized)) !== null) {
    matchedNumericSpans.push([match.index, match.index + match[0].length]);
    const rawNum = (match[1] ?? match[2] ?? "").replace(/,/g, "");
    const unitToken = (match[3] ?? (match[0].includes("$") || /usd/i.test(match[0]) ? "USD" : "")).toLowerCase();
    const currency: "USD" | "KHR" =
      unitToken.includes("khr") || unitToken.includes("riel") || unitToken.includes("៛") || unitToken.includes("រៀល")
        ? "KHR"
        : "USD";
    fields.push({
      kind: "amount",
      rawText: match[0].trim(),
      normalizedValue: `${currency} ${rawNum}`,
      currency,
      ambiguous: false,
    });
  }

  // 3. Percentages (exclude from bare currency check)
  PERCENTAGE_RE.lastIndex = 0;
  while ((match = PERCENTAGE_RE.exec(normalized)) !== null) {
    matchedNumericSpans.push([match.index, match.index + match[0].length]);
    fields.push({
      kind: "percentage",
      rawText: match[0].trim(),
      normalizedValue: `${match[1]}%`,
      ambiguous: false,
    });
  }

  // 4. Explicit reporting periods
  EXPLICIT_PERIOD_RE.lastIndex = 0;
  while ((match = EXPLICIT_PERIOD_RE.exec(normalized)) !== null) {
    matchedNumericSpans.push([match.index, match.index + match[0].length]);
    fields.push({
      kind: "date_period",
      rawText: match[0].trim(),
      normalizedValue: match[0].trim(),
      ambiguous: false,
    });
  }

  // 5. Cell/Range references
  CELL_RANGE_RE.lastIndex = 0;
  while ((match = CELL_RANGE_RE.exec(normalized)) !== null) {
    // Ignore quarter tokens like Q4
    if (/^Q[1-4]$/.test(match[1]!)) continue;
    matchedNumericSpans.push([match.index, match.index + match[0].length]);
    fields.push({
      kind: "cell_range",
      rawText: match[1]!,
      normalizedValue: match[1]!,
      ambiguous: false,
    });
  }

  // 6. Bare financial numbers without currency -> AMBIGUOUS_CURRENCY (VOC-T12)
  matchedNumericSpans.push(...fxRateSpans);
  if (FINANCIAL_INTENT_RE.test(normalized)) {
    const bareNumberRe = /(?<!\.)\b(\d{1,3}(?:,\d{3})+|\d{2,}(?:\.\d+)?|\d+\.\d+)\b/g;
    while ((match = bareNumberRe.exec(normalized)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const overlapsKnown = matchedNumericSpans.some(([s, e]) => start < e && end > s);
      if (overlapsKnown) continue;
      // Ignore 4-digit years 2020-2035
      if (/^20[2-3]\d$/.test(match[1]!)) continue;
      const cleanVal = match[1]!.replace(/,/g, "");
      fields.push({
        kind: "amount",
        rawText: match[0],
        normalizedValue: cleanVal,
        ambiguous: true,
        ambiguityCode: "AMBIGUOUS_CURRENCY",
        clarificationPrompt: `Specify currency (USD or KHR) for financial amount '${match[0]}'.`,
      });
      if (!ambiguityCodes.includes("AMBIGUOUS_CURRENCY")) {
        ambiguityCodes.push("AMBIGUOUS_CURRENCY");
        clarificationPrompts.push(`Specify currency (USD or KHR) for financial amount '${match[0]}'.`);
      }
    }
  }

  // 7. Ambiguous relative date/period (VOC-T14)
  if (AMBIGUOUS_RELATIVE_DATE_RE.test(normalized) && !fields.some((f) => f.kind === "date_period" && !f.ambiguous)) {
    const raw = normalized.match(AMBIGUOUS_RELATIVE_DATE_RE)?.[0] ?? "relative period";
    fields.push({
      kind: "date_period",
      rawText: raw,
      normalizedValue: raw,
      ambiguous: true,
      ambiguityCode: "AMBIGUOUS_DATE_PERIOD",
      clarificationPrompt: `Confirm exact reporting period (e.g., 2026-11) for relative phrase '${raw}'.`,
    });
    ambiguityCodes.push("AMBIGUOUS_DATE_PERIOD");
    clarificationPrompts.push(`Confirm exact reporting period (e.g., 2026-11) for relative phrase '${raw}'.`);
  }

  // 8. Metric target extraction & vague-reference check (VOC-T14)
  const specificMetric = normalized.match(SPECIFIC_METRIC_RE);
  if (specificMetric) {
    fields.push({
      kind: "metric_target",
      rawText: specificMetric[0],
      normalizedValue: specificMetric[0],
      ambiguous: false,
    });
  } else if (AMBIGUOUS_TARGET_RE.test(normalized)) {
    const raw = normalized.match(AMBIGUOUS_TARGET_RE)?.[0] ?? "ambiguous target";
    fields.push({
      kind: "metric_target",
      rawText: raw,
      normalizedValue: raw,
      ambiguous: true,
      ambiguityCode: "AMBIGUOUS_TARGET_REFERENCE",
      clarificationPrompt: `Clarify which specific metric or document section '${raw}' refers to.`,
    });
    ambiguityCodes.push("AMBIGUOUS_TARGET_REFERENCE");
    clarificationPrompts.push(`Clarify which specific metric or document section '${raw}' refers to.`);
  }

  return {
    fields,
    requiresClarification: ambiguityCodes.length > 0,
    ambiguityCodes,
    clarificationPrompts,
    currencyActionKind,
  };
}
