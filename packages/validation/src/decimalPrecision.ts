import type { RoundingMode } from "@ai-office-suite/shared-contracts";

export const DEFAULT_MAX_ABS_MINOR_UNITS = 999_999_999_999_999_999n;

export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["KHR", "JPY", "KRW", "VND"]);

export function currencyScaleFor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) ? 0 : 2;
}

export class ExactDecimalError extends Error {
  readonly code: "INVALID_NUMERIC_VALUE" | "INVALID_DECIMAL_FORMAT" | "NUMERIC_OVERFLOW" | "ZERO_DENOMINATOR";

  constructor(
    code: "INVALID_NUMERIC_VALUE" | "INVALID_DECIMAL_FORMAT" | "NUMERIC_OVERFLOW" | "ZERO_DENOMINATOR",
    message: string,
  ) {
    super(message);
    this.name = "ExactDecimalError";
    this.code = code;
  }
}

function pow10BigInt(exp: number): bigint {
  if (exp <= 0) return 1n;
  return 10n ** BigInt(exp);
}

/**
 * Exact BigInt division with FIN-POL-V1 rounding semantics (HALF_UP away from zero or HALF_EVEN banker's rounding).
 */
export function roundExactQuotient(
  numerator: bigint,
  denominator: bigint,
  roundingMode: RoundingMode = "HALF_UP",
): bigint {
  if (denominator === 0n) {
    throw new ExactDecimalError("ZERO_DENOMINATOR", "Division by zero is undefined.");
  }
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const quot = absNum / absDen;
  const rem = absNum % absDen;
  const twiceRem = rem * 2n;

  let roundedAbs = quot;
  if (twiceRem > absDen) {
    roundedAbs = quot + 1n;
  } else if (twiceRem === absDen) {
    if (roundingMode === "HALF_UP") {
      roundedAbs = quot + 1n;
    } else if (quot % 2n !== 0n) {
      roundedAbs = quot + 1n;
    }
  }
  return sign * roundedAbs;
}

/**
 * Single canonical FIN-POL-V1 exact decimal parser (M2):
 * Parses decimal strings (including bounded scientific notation) or finite numbers
 * directly into scaled BigInt minor units without IEEE-754 intermediate float precision loss.
 */
export function parseExactDecimalToMinorUnits(
  raw: string | number,
  scale = 2,
  maxAbs: bigint = DEFAULT_MAX_ABS_MINOR_UNITS,
  roundingMode: RoundingMode = "HALF_UP",
): bigint {
  let str: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new ExactDecimalError(
        "INVALID_NUMERIC_VALUE",
        "Non-finite number cannot be parsed for financial arithmetic.",
      );
    }
    str = raw.toString();
  } else {
    str = raw.trim();
  }

  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(str)) {
    throw new ExactDecimalError("INVALID_DECIMAL_FORMAT", `Invalid decimal string '${raw}'.`);
  }

  let sign = 1n;
  if (str.startsWith("-")) {
    sign = -1n;
    str = str.slice(1);
  } else if (str.startsWith("+")) {
    str = str.slice(1);
  }

  const [mantissa, expPart] = str.toLowerCase().split("e");
  const expShift = expPart !== undefined ? Number.parseInt(expPart, 10) : 0;
  if (!Number.isSafeInteger(expShift) || Math.abs(expShift) > 100) {
    throw new ExactDecimalError("NUMERIC_OVERFLOW", `Exponent in '${raw}' exceeds safe financial bounds.`);
  }
  const [intRaw = "0", fracRaw = ""] = (mantissa ?? "0").split(".");
  const digits = `${intRaw}${fracRaw}`.replace(/^0+(?=\d)/, "") || "0";
  const decimalPlacesAfterShift = fracRaw.length - expShift;

  if (digits === "0") {
    return 0n;
  }

  const targetShift = scale - decimalPlacesAfterShift;
  if (targetShift > 36) {
    throw new ExactDecimalError(
      "NUMERIC_OVERFLOW",
      `Financial amount '${raw}' exceeds overflow guard of ±${maxAbs.toString()} minor units.`,
    );
  }

  let result: bigint;
  if (targetShift >= 0) {
    result = BigInt(digits) * pow10BigInt(targetShift);
  } else {
    const dropDigits = -targetShift;
    if (dropDigits > digits.length + 1) {
      result = 0n;
    } else {
      const divisor = pow10BigInt(dropDigits);
      const num = BigInt(digits);
      result = roundExactQuotient(num, divisor, roundingMode);
    }
  }

  const signed = sign * result;
  if (signed > maxAbs || signed < -maxAbs) {
    throw new ExactDecimalError(
      "NUMERIC_OVERFLOW",
      `Financial amount '${raw}' exceeds overflow guard of ±${maxAbs.toString()} minor units.`,
    );
  }
  return signed;
}

/**
 * Shared HTML entity escaper used across PDF/slide/chart renderers (L2 / M1).
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
