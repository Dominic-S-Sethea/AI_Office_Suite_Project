import type {
  ExchangeRateSpecification,
  FinancialPrecisionPolicy,
  RoundingMode,
} from "@ai-office-suite/shared-contracts";

export class AnalyticsError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AnalyticsError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const DEFAULT_FINANCIAL_PRECISION_POLICY: FinancialPrecisionPolicy = {
  policyId: "FIN-POL-V1",
  name: "Corporate Management Reporting Exact Minor-Unit Policy V1",
  monetaryScale: 2,
  ratioDisplayScale: 2,
  intermediateScale: 6,
  roundingMode: "HALF_UP",
  zeroDenominatorPolicy: "return_unavailable",
  currencyCode: "USD",
  currencyConversionRule: "require_explicit_rate_source_date",
  overflowSafeMaxMinorUnits: "999999999999999999",
};

const MAX_ABS_MINOR = BigInt(DEFAULT_FINANCIAL_PRECISION_POLICY.overflowSafeMaxMinorUnits);

function pow10BigInt(exp: number): bigint {
  if (exp <= 0) return 1n;
  return 10n ** BigInt(exp);
}

/**
 * Parses an exact decimal string or finite number into scaled BigInt minor units
 * without floating-point binary multiplication errors (e.g. 0.1 + 0.2 = 0.30).
 */
export function parseDecimalToMinorUnits(
  raw: string | number,
  scale = 2,
  maxAbs: bigint = MAX_ABS_MINOR,
): bigint {
  let str: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new AnalyticsError(422, "INVALID_NUMERIC_VALUE", "Non-finite number cannot be parsed for financial arithmetic.");
    }
    str = raw.toString();
  } else {
    str = raw.trim();
  }

  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(str)) {
    throw new AnalyticsError(422, "INVALID_DECIMAL_FORMAT", `Invalid decimal string '${raw}'.`);
  }

  // Normalize scientific notation into fixed decimal digits first if present
  let sign = 1n;
  if (str.startsWith("-")) {
    sign = -1n;
    str = str.slice(1);
  } else if (str.startsWith("+")) {
    str = str.slice(1);
  }

  const [mantissa, expPart] = str.toLowerCase().split("e");
  const expShift = expPart !== undefined ? Number.parseInt(expPart, 10) : 0;
  const [intRaw = "0", fracRaw = ""] = (mantissa ?? "0").split(".");
  const digits = `${intRaw}${fracRaw}`.replace(/^0+(?=\d)/, "") || "0";
  const decimalPlacesAfterShift = fracRaw.length - expShift;

  let result: bigint;
  const targetShift = scale - decimalPlacesAfterShift;
  if (targetShift >= 0) {
    result = BigInt(digits) * pow10BigInt(targetShift);
  } else {
    const dropDigits = -targetShift;
    const divisor = pow10BigInt(dropDigits);
    const num = BigInt(digits);
    const quot = num / divisor;
    const rem = num % divisor;
    const twiceRem = rem * 2n;
    result = twiceRem >= divisor ? quot + 1n : quot;
  }

  const signed = sign * result;
  if (signed > maxAbs || signed < -maxAbs) {
    throw new AnalyticsError(
      422,
      "NUMERIC_OVERFLOW",
      `Financial amount '${raw}' exceeds overflow guard of ±${maxAbs.toString()} minor units.`,
    );
  }
  return signed;
}

export function addMinorUnits(a: bigint, b: bigint, maxAbs: bigint = MAX_ABS_MINOR): bigint {
  const sum = a + b;
  if (sum > maxAbs || sum < -maxAbs) {
    throw new AnalyticsError(422, "NUMERIC_OVERFLOW", "Financial addition overflowed configured limit.");
  }
  return sum;
}

export function subMinorUnits(a: bigint, b: bigint, maxAbs: bigint = MAX_ABS_MINOR): bigint {
  const diff = a - b;
  if (diff > maxAbs || diff < -maxAbs) {
    throw new AnalyticsError(422, "NUMERIC_OVERFLOW", "Financial subtraction overflowed configured limit.");
  }
  return diff;
}

export function roundQuotientExact(
  numerator: bigint,
  denominator: bigint,
  roundingMode: RoundingMode,
): bigint {
  if (denominator === 0n) {
    throw new AnalyticsError(422, "ZERO_DENOMINATOR", "Division by zero is undefined.");
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
      // Commercial financial half-up rounds ties away from zero (for both positive and negative amounts)
      roundedAbs = quot + 1n;
    } else {
      // HALF_EVEN (Banker's rounding): tie goes to nearest even integer
      if (quot % 2n !== 0n) {
        roundedAbs = quot + 1n;
      }
    }
  }
  return sign * roundedAbs;
}

export function formatScaledBigInt(value: bigint, scale: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const factor = pow10BigInt(scale);
  const whole = abs / factor;
  if (scale <= 0) {
    return `${neg ? "-" : ""}${whole.toString()}`;
  }
  const frac = (abs % factor).toString().padStart(scale, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

export type ExactDivisionResult =
  | {
      status: "available";
      scaledValue: bigint;
      decimalString: string;
    }
  | {
      status: "unavailable";
      reason: "ZERO_DENOMINATOR";
    };

/**
 * Divides numerator by denominator returning a result scaled to `outScale` decimals.
 * Example: operating profit 4000000 cents / net sales 15000000 cents with multiplier=100n and outScale=2 -> 2667 -> "26.67" (%).
 */
export function divideExactScaled(
  numerator: bigint,
  denominator: bigint,
  outScale: number,
  roundingMode: RoundingMode = "HALF_UP",
  multiplier = 1n,
): ExactDivisionResult {
  if (denominator === 0n) {
    return { status: "unavailable", reason: "ZERO_DENOMINATOR" };
  }
  const scaledNum = numerator * multiplier * pow10BigInt(outScale);
  const rounded = roundQuotientExact(scaledNum, denominator, roundingMode);
  return {
    status: "available",
    scaledValue: rounded,
    decimalString: formatScaledBigInt(rounded, outScale),
  };
}

export function convertCurrencyMinorUnits(
  amountMinor: bigint,
  targetScale: number,
  sourceCurrency: string,
  targetCurrency: string,
  rateSpec?: ExchangeRateSpecification,
  roundingMode: RoundingMode = "HALF_UP",
): bigint {
  const fromNorm = sourceCurrency.trim().toUpperCase();
  const toNorm = targetCurrency.trim().toUpperCase();
  if (fromNorm === toNorm) return amountMinor;

  if (
    !rateSpec ||
    rateSpec.fromCurrency.trim().toUpperCase() !== fromNorm ||
    rateSpec.toCurrency.trim().toUpperCase() !== toNorm ||
    !rateSpec.source.trim() ||
    !rateSpec.effectiveDate.trim()
  ) {
    throw new AnalyticsError(
      422,
      "CURRENCY_CONVERSION_UNDEFINED",
      `Cannot convert '${fromNorm}' to '${toNorm}' without an explicit approved exchange rate, source, and effective date.`,
    );
  }

  const rateScale = 10;
  const scaledRate = parseDecimalToMinorUnits(rateSpec.rateDecimalString, rateScale);
  if (scaledRate <= 0n) {
    throw new AnalyticsError(422, "INVALID_EXCHANGE_RATE", "Exchange rate must be strictly positive.");
  }

  // amountMinor is already in 10^targetScale minor units assuming monetary scale match, scale by rate/10^rateScale
  void targetScale;
  return roundQuotientExact(amountMinor * scaledRate, pow10BigInt(rateScale), roundingMode);
}

export function formatCurrencyOrRatioDisplay(
  valueMinor: bigint,
  scale: number,
  opts: { currency?: string; suffix?: string } = {},
): string {
  const neg = valueMinor < 0n;
  const absStr = formatScaledBigInt(neg ? -valueMinor : valueMinor, scale);
  const [wholePart = "0", fracPart] = absStr.split(".");
  const groupedWhole = wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formattedNum = fracPart !== undefined ? `${groupedWhole}.${fracPart}` : groupedWhole;
  const signPrefix = neg ? "-" : "";
  if (opts.currency === "USD") {
    return `${signPrefix}$${formattedNum}`;
  }
  if (opts.currency === "KHR") {
    return `${signPrefix}៛${formattedNum}`;
  }
  if (opts.currency) {
    return `${signPrefix}${formattedNum} ${opts.currency}`;
  }
  if (opts.suffix) {
    return `${signPrefix}${formattedNum}${opts.suffix}`;
  }
  return `${signPrefix}${formattedNum}`;
}

export interface PrecisionBenchmarkComparison {
  ieee754AdditionExample: number;
  exactMinorAdditionDisplay: string;
  duckdbDecimalDivSampleNote: string;
  exactRatioHalfUp: string;
  exactRatioHalfEven: string;
}

export function evaluatePrecisionApproaches(): PrecisionBenchmarkComparison {
  const ieee754AdditionExample = 0.1 + 0.2;
  const exactSum = addMinorUnits(
    parseDecimalToMinorUnits("0.10", 2),
    parseDecimalToMinorUnits("0.20", 2),
  );
  const halfUp = divideExactScaled(25n, 2n, 2, "HALF_UP", 1n);
  const halfEven = divideExactScaled(25n, 2n, 2, "HALF_EVEN", 1n);

  return {
    ieee754AdditionExample,
    exactMinorAdditionDisplay: formatScaledBigInt(exactSum, 2),
    duckdbDecimalDivSampleNote:
      "DuckDB DECIMAL(18,2)/DECIMAL(18,2) yields double-precision float ~333.3333333333333; governed metrics use BigInt minor-unit division.",
    exactRatioHalfUp: halfUp.status === "available" ? halfUp.decimalString : "unavailable",
    exactRatioHalfEven: halfEven.status === "available" ? halfEven.decimalString : "unavailable",
  };
}
