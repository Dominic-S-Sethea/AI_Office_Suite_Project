import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  ActorContext,
  CertifiedDatasetArtifact,
  ColumnQualityProfile,
  CurrencyControlTotal,
  DataPreparationRecipe,
  DatasetExceptionRecord,
  DatasetProfile,
  DatasetSourceRecord,
  JoinCardinalityReport,
  ReconciliationReport,
} from "@ai-office-suite/shared-contracts";
import { assertCanPerform, assertTenantWorkspaceAccess } from "@ai-office-suite/authorization";
import {
  escapeSafeCsvCell,
  inspectAndExtractOoxmlZip,
  parseExactDecimalToMinorUnits,
  scanForPromptInjection,
} from "@ai-office-suite/validation";
import ExcelJS from "exceljs";

const EPHEMERAL_DEV_PII_KEY = randomBytes(32).toString("hex");
const RESERVED_CSV_HEADERS = new Set(["__proto__", "constructor", "prototype", "tostring", "valueof"]);

function resolvePiiPseudonymizationKey(): string {
  const configured = process.env.PII_PSEUDONYMIZATION_KEY?.trim();
  if (configured && configured.length >= 32) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new DataPrepError(
      500,
      "MISSING_PII_HMAC_KEY",
      "PII_PSEUDONYMIZATION_KEY (>= 32 chars) must be configured in production for hash_token pseudonymization.",
    );
  }
  return EPHEMERAL_DEV_PII_KEY;
}

export class DataPrepError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "DataPrepError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface StagedRow {
  __sourceFile: string;
  __sourceRowNumber: number;
  [col: string]: unknown;
}

export interface StagedDataset {
  source: DatasetSourceRecord;
  rows: StagedRow[];
  rejects: DatasetExceptionRecord[];
}

const BILINGUAL_DEPARTMENT_DICTIONARY: Record<string, string> = {
  admin: "Administration",
  "admin dept": "Administration",
  administration: "Administration",
  "ផ្នែករដ្ឋបាល": "Administration",
  "នាយកដ្ឋានរដ្ឋបាល": "Administration",
  finance: "Finance",
  "finance dept": "Finance",
  "ផ្នែកហិរញ្ញវត្ថុ": "Finance",
  sales: "Sales",
  "ផ្នែកលក់": "Sales",
};

export interface CsvStageOptions {
  delimiter?: "," | ";" | "\t" | "auto";
  maxRows?: number;
  maxCellLength?: number;
}

export interface XlsxStageOptions {
  sheetName?: string;
}

export type SchemaPatternPreset =
  | "iso_date"
  | "email"
  | "khmer_phone"
  | "uuid"
  | "alphanumeric"
  | "currency_code"
  | "digits";

export interface SchemaColumnRule {
  column: string;
  required?: boolean;
  type?: "string" | "number" | "date" | "enum";
  min?: number;
  max?: number;
  preset?: SchemaPatternPreset;
  pattern?: string;
  allowedValues?: string[];
}

const NAMED_CONTRACT_PRESETS: Record<SchemaPatternPreset, RegExp> = {
  iso_date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,24}$/,
  khmer_phone: /^(?:\+855|0)[1-9]\d{7,8}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  alphanumeric: /^[A-Za-z0-9_-]{1,128}$/,
  currency_code: /^[A-Z]{3}$/,
  digits: /^\d{1,32}$/,
};

const MAX_CONTRACT_PATTERN_LENGTH = 128;
const MAX_CONTRACT_QUANTIFIER_BOUND = 64;
const MAX_CONTRACT_REGEX_CELL_LENGTH = 1024;

/**
 * Compiles a user-supplied schema-contract regex only after verifying structural ReDoS safety:
 * rejects backreferences, lookarounds, large bounded quantifiers, nested quantifiers on
 * quantified/alternated groups, and ambiguous consecutive unbounded quantifiers.
 */
export function compileSafeContractPattern(rawPattern: string): RegExp {
  if (typeof rawPattern !== "string" || rawPattern.length === 0 || rawPattern.length > MAX_CONTRACT_PATTERN_LENGTH) {
    throw new DataPrepError(
      400,
      "INVALID_CONTRACT_PATTERN",
      `Contract pattern must be a non-empty string <= ${MAX_CONTRACT_PATTERN_LENGTH} characters.`,
    );
  }

  let inCharClass = false;
  let prevWasUnboundedQuantifier = false;
  let consecutiveUnboundedTokens = 0;
  const groupStack: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = [];

  for (let i = 0; i < rawPattern.length; i++) {
    const ch = rawPattern[i]!;
    if (ch === "\\") {
      const next = rawPattern[i + 1];
      if (!next) {
        throw new DataPrepError(400, "INVALID_CONTRACT_PATTERN", "Trailing escape in contract pattern.");
      }
      if (!inCharClass && (/[1-9]/.test(next) || next === "k")) {
        throw new DataPrepError(
          400,
          "UNSAFE_CONTRACT_PATTERN",
          "Backreferences are prohibited in schema contract patterns (ReDoS protection).",
        );
      }
      i++;
      prevWasUnboundedQuantifier = false;
      continue;
    }

    if (inCharClass) {
      if (ch === "]") {
        inCharClass = false;
      }
      continue;
    }

    if (ch === "[") {
      inCharClass = true;
      prevWasUnboundedQuantifier = false;
      continue;
    }

    if (ch === "(") {
      const next = rawPattern[i + 1];
      if (next === "?") {
        const afterQ = rawPattern[i + 2];
        // Allow only non-capturing (?:...) groups; forbid lookarounds (?=, ?!, ?<=, ?<!) and named groups
        if (afterQ !== ":") {
          throw new DataPrepError(
            400,
            "UNSAFE_CONTRACT_PATTERN",
            "Lookarounds and special regex group assertions are prohibited in schema contract patterns.",
          );
        }
        i += 2;
      }
      if (groupStack.length >= 6) {
        throw new DataPrepError(400, "UNSAFE_CONTRACT_PATTERN", "Regex group nesting exceeds safe limit.");
      }
      groupStack.push({ hasQuantifier: false, hasAlternation: false });
      prevWasUnboundedQuantifier = false;
      continue;
    }

    if (ch === "|") {
      const top = groupStack[groupStack.length - 1];
      if (top) top.hasAlternation = true;
      prevWasUnboundedQuantifier = false;
      consecutiveUnboundedTokens = 0;
      continue;
    }

    if (ch === ")") {
      const closed = groupStack.pop();
      if (!closed) {
        throw new DataPrepError(400, "INVALID_CONTRACT_PATTERN", "Unmatched ')' in schema contract pattern.");
      }
      const next = rawPattern[i + 1];
      const groupFollowedByQuantifier = next === "+" || next === "*" || next === "?" || next === "{";
      if (groupFollowedByQuantifier && (closed.hasQuantifier || closed.hasAlternation)) {
        throw new DataPrepError(
          400,
          "UNSAFE_CONTRACT_PATTERN",
          "Nested quantifiers or quantified alternations are prohibited (ReDoS protection).",
        );
      }
      const parent = groupStack[groupStack.length - 1];
      if (parent) {
        if (closed.hasQuantifier || groupFollowedByQuantifier) parent.hasQuantifier = true;
        if (closed.hasAlternation) parent.hasAlternation = true;
      }
      prevWasUnboundedQuantifier = false;
      continue;
    }

    if (ch === "+" || ch === "*" || ch === "?") {
      if (prevWasUnboundedQuantifier && ch !== "?") {
        throw new DataPrepError(400, "UNSAFE_CONTRACT_PATTERN", "Stacked quantifiers are prohibited (ReDoS protection).");
      }
      const top = groupStack[groupStack.length - 1];
      if (top && ch !== "?") top.hasQuantifier = true;
      if (ch === "+" || ch === "*") {
        consecutiveUnboundedTokens++;
        if (consecutiveUnboundedTokens > 2) {
          throw new DataPrepError(
            400,
            "UNSAFE_CONTRACT_PATTERN",
            "Too many unbounded quantifiers in a single branch (ReDoS protection).",
          );
        }
        prevWasUnboundedQuantifier = true;
      }
      continue;
    }

    if (ch === "{") {
      const closeIdx = rawPattern.indexOf("}", i + 1);
      if (closeIdx === -1) {
        throw new DataPrepError(400, "INVALID_CONTRACT_PATTERN", "Unclosed '{' quantifier in schema contract pattern.");
      }
      const body = rawPattern.slice(i + 1, closeIdx);
      const qMatch = body.match(/^(\d+)(?:,(\d*))?$/);
      if (!qMatch) {
        throw new DataPrepError(400, "INVALID_CONTRACT_PATTERN", `Invalid quantifier '{${body}}' in schema contract pattern.`);
      }
      const minBound = Number(qMatch[1]);
      const hasComma = body.includes(",");
      const maxBound = qMatch[2] ? Number(qMatch[2]) : hasComma ? Infinity : minBound;
      if (minBound > MAX_CONTRACT_QUANTIFIER_BOUND || (Number.isFinite(maxBound) && maxBound > MAX_CONTRACT_QUANTIFIER_BOUND)) {
        throw new DataPrepError(
          400,
          "UNSAFE_CONTRACT_PATTERN",
          `Quantifier bound exceeds safe limit (${MAX_CONTRACT_QUANTIFIER_BOUND}).`,
        );
      }
      if (hasComma && !qMatch[2]) {
        consecutiveUnboundedTokens++;
        if (consecutiveUnboundedTokens > 2) {
          throw new DataPrepError(
            400,
            "UNSAFE_CONTRACT_PATTERN",
            "Too many unbounded quantifiers in a single branch (ReDoS protection).",
          );
        }
      }
      const top = groupStack[groupStack.length - 1];
      if (top && (hasComma || minBound > 1)) top.hasQuantifier = true;
      i = closeIdx;
      prevWasUnboundedQuantifier = true;
      continue;
    }

    prevWasUnboundedQuantifier = false;
  }

  if (inCharClass || groupStack.length > 0) {
    throw new DataPrepError(400, "INVALID_CONTRACT_PATTERN", "Unclosed character class or group in schema contract pattern.");
  }

  try {
    return new RegExp(rawPattern);
  } catch (err) {
    throw new DataPrepError(
      400,
      "INVALID_CONTRACT_PATTERN",
      `Invalid schema contract regex: ${err instanceof Error ? err.message : "syntax error"}.`,
    );
  }
}

export interface CertifiedCsvExportResult {
  csv: string;
  csvSha256: string;
  datasetId: string;
  version: number;
  outputSha256: string;
  rowCount: number;
  status: CertifiedDatasetArtifact["status"];
}

const ZERO_DECIMAL_CURRENCIES = new Set(["KHR", "JPY", "KRW", "VND"]);

export function currencyScaleFor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) ? 0 : 2;
}

export function normalizeKhmerDigitsText(raw: string, stripCurrencySymbols = false): string {
  let out = raw.normalize("NFC").replace(/[\u17E0-\u17E9]/g, (ch) => String(ch.charCodeAt(0) - 0x17e0));
  out = out.replace(/[\uFF10-\uFF19]/g, (ch) => String(ch.charCodeAt(0) - 0xff10));
  if (stripCurrencySymbols) {
    out = out
      .replace(/,/g, "")
      .replace(/(?:\$|៛|រៀល|\bUSD\b|\bKHR\b)/gi, "")
      .trim();
  }
  return out;
}

export function parseAmountToMinorUnitsBigInt(raw: unknown, scale: number): bigint | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    try {
      return parseExactDecimalToMinorUnits(raw, scale);
    } catch {
      return null;
    }
  }
  const cleaned = String(raw).trim().replace(/,/g, "");
  if (!cleaned) return null;
  try {
    return parseExactDecimalToMinorUnits(cleaned, scale);
  } catch {
    return null;
  }
}

function minorUnitsToNumber(minor: bigint, scale: number): number {
  if (scale === 0) return Number(minor);
  const divisor = 10 ** scale;
  return Number(minor) / divisor;
}

function detectCsvDelimiter(headerLine: string): "," | ";" | "\t" {
  const counts: Record<"," | ";" | "\t", number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && (ch === "," || ch === ";" || ch === "\t")) {
      counts[ch]++;
    }
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

interface ParsedCsvRecord {
  fields: string[];
  startLine: number;
  rawLine: string;
  malformedQuote: boolean;
}

function parseRfc4180Records(
  text: string,
  delimiter: "," | ";" | "\t",
  maxRows: number,
  maxCellLength: number,
): ParsedCsvRecord[] {
  const records: ParsedCsvRecord[] = [];
  let fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  let fieldStart = true;
  let lineNum = 1;
  let recordStartLine = 1;
  let recordStartOffset = 0;

  const pushRecord = (endOffset: number, malformedQuote: boolean) => {
    fields.push(cur);
    // Skip trailing blank line
    if (fields.length === 1 && fields[0] === "" && !malformedQuote) {
      fields = [];
      cur = "";
      fieldStart = true;
      return;
    }
    if (records.length > maxRows) {
      throw new DataPrepError(413, "CSV_ROW_LIMIT_EXCEEDED", `CSV exceeds maximum supported row limit (${maxRows}).`);
    }
    records.push({
      fields,
      startLine: recordStartLine,
      rawLine: text.slice(recordStartOffset, endOffset),
      malformedQuote,
    });
    fields = [];
    cur = "";
    fieldStart = true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") lineNum++;
        cur += ch;
      }
      if (cur.length > maxCellLength) {
        throw new DataPrepError(413, "CSV_CELL_LIMIT_EXCEEDED", `CSV cell exceeds safety bound (${maxCellLength} chars).`);
      }
      continue;
    }

    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      fields.push(cur);
      cur = "";
      fieldStart = true;
    } else if (ch === "\n") {
      pushRecord(i, false);
      lineNum++;
      recordStartLine = lineNum;
      recordStartOffset = i + 1;
    } else {
      cur += ch;
      fieldStart = false;
      if (cur.length > maxCellLength) {
        throw new DataPrepError(413, "CSV_CELL_LIMIT_EXCEEDED", `CSV cell exceeds safety bound (${maxCellLength} chars).`);
      }
    }
  }

  if (cur.length > 0 || fields.length > 0 || inQuotes) {
    pushRecord(text.length, inQuotes);
  }

  return records;
}

function validateUniqueHeaders(headers: string[], filename: string): void {
  const seen = new Set<string>();
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (!h) {
      throw new DataPrepError(400, "EMPTY_HEADER_COLUMN", `Source '${filename}' has an empty header at column ${i + 1}.`);
    }
    if (h.startsWith("__") || RESERVED_CSV_HEADERS.has(h.toLowerCase())) {
      throw new DataPrepError(
        400,
        "RESERVED_HEADER_COLUMN",
        `Source '${filename}' contains reserved or unsafe header column '${h}'.`,
      );
    }
    if (seen.has(h)) {
      throw new DataPrepError(400, "DUPLICATE_HEADER_COLUMN", `Source '${filename}' has duplicate header column '${h}'.`);
    }
    seen.add(h);
  }
}

export function stageCsvSource(
  csvText: string,
  filename: string,
  options: CsvStageOptions = {},
): StagedDataset {
  const sha256 = createHash("sha256").update(csvText, "utf8").digest("hex");
  const normalizedText = csvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const maxRows = Math.max(1, Math.min(1_000_000, Math.trunc(options.maxRows ?? 500_000)));
  const maxCellLength = Math.max(128, Math.min(500_000, Math.trunc(options.maxCellLength ?? 65_536)));

  const firstNewline = normalizedText.indexOf("\n");
  const firstLine = firstNewline === -1 ? normalizedText : normalizedText.slice(0, firstNewline);
  if (!normalizedText.trim()) {
    return {
      source: {
        sourceId: `src_${randomUUID().slice(0, 8)}`,
        filename,
        format: "csv",
        sha256,
        totalRowsRead: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        columnNames: [],
        importedAt: new Date().toISOString(),
      },
      rows: [],
      rejects: [],
    };
  }

  const delimiter: "," | ";" | "\t" =
    options.delimiter && options.delimiter !== "auto" ? options.delimiter : detectCsvDelimiter(firstLine);

  const records = parseRfc4180Records(normalizedText, delimiter, maxRows, maxCellLength);
  if (records.length === 0) {
    return {
      source: {
        sourceId: `src_${randomUUID().slice(0, 8)}`,
        filename,
        format: "csv",
        sha256,
        totalRowsRead: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        columnNames: [],
        importedAt: new Date().toISOString(),
      },
      rows: [],
      rejects: [],
    };
  }

  const headerRecord = records[0]!;
  if (headerRecord.malformedQuote) {
    throw new DataPrepError(400, "MALFORMED_CSV_HEADER", `Header row in '${filename}' contains an unclosed quote.`);
  }
  const headers = headerRecord.fields.map((h) => h.trim().normalize("NFC"));
  validateUniqueHeaders(headers, filename);

  const rows: StagedRow[] = [];
  const rejects: DatasetExceptionRecord[] = [];

  for (let i = 1; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.malformedQuote || rec.fields.length !== headers.length) {
      rejects.push({
        exceptionId: `exc_${randomUUID().slice(0, 8)}`,
        sourceFile: filename,
        sourceRowNumber: rec.startLine,
        severity: "critical",
        code: "MALFORMED_CSV_ROW",
        message: `Row ${rec.startLine} column count (${rec.fields.length}) or quoting does not match header (${headers.length}).`,
        rawRecord: { rawLine: rec.rawLine },
        resolved: false,
      });
      continue;
    }

    const row: StagedRow = { __sourceFile: filename, __sourceRowNumber: rec.startLine };
    for (let c = 0; c < headers.length; c++) {
      const val = (rec.fields[c] ?? "").normalize("NFC");
      row[headers[c]!] = val === "" ? null : val;
    }
    rows.push(row);
  }

  return {
    source: {
      sourceId: `src_${randomUUID().slice(0, 8)}`,
      filename,
      format: "csv",
      sha256,
      totalRowsRead: records.length - 1,
      acceptedRows: rows.length,
      rejectedRows: rejects.length,
      columnNames: headers,
      importedAt: new Date().toISOString(),
    },
    rows,
    rejects,
  };
}

export async function stageXlsxSource(
  buffer: Uint8Array,
  filename: string,
  options: XlsxStageOptions = {},
): Promise<StagedDataset> {
  const inspected = inspectAndExtractOoxmlZip(buffer, filename, "xlsx");
  if (!inspected.ok) {
    throw new DataPrepError(400, inspected.code, inspected.message);
  }

  const sha256 = inspected.originalSha256;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(inspected.repackedBuffer) as unknown as ExcelJS.Buffer);
  const ws = options.sheetName ? wb.getWorksheet(options.sheetName) : wb.worksheets[0];
  if (!ws) {
    throw new DataPrepError(
      400,
      "EMPTY_WORKBOOK",
      options.sheetName
        ? `Workbook '${filename}' does not contain worksheet '${options.sheetName}'.`
        : `Workbook '${filename}' contains no worksheets.`,
    );
  }

  const headers: string[] = [];
  const rows: StagedRow[] = [];

  ws.eachRow((excelRow, rowNumber) => {
    const values = (excelRow.values as unknown[]).slice(1);
    if (rowNumber === 1) {
      for (const v of values) headers.push(String(v ?? "").trim().normalize("NFC"));
      validateUniqueHeaders(headers, filename);
      return;
    }
    const row: StagedRow = { __sourceFile: filename, __sourceRowNumber: rowNumber };
    for (let c = 0; c < headers.length; c++) {
      const raw = values[c];
      if (raw === undefined || raw === null || raw === "") {
        row[headers[c]!] = null;
      } else if (raw instanceof Date) {
        row[headers[c]!] = raw.toISOString().slice(0, 10);
      } else if (typeof raw === "object" && raw !== null && "result" in raw) {
        const res = (raw as { result: unknown }).result;
        row[headers[c]!] =
          res === undefined || res === null || res === ""
            ? null
            : typeof res === "string"
              ? res.normalize("NFC")
              : res;
      } else if (typeof raw === "object" && raw !== null && "text" in raw) {
        row[headers[c]!] = String((raw as { text: unknown }).text).normalize("NFC");
      } else if (typeof raw === "string") {
        row[headers[c]!] = raw.normalize("NFC");
      } else {
        row[headers[c]!] = raw;
      }
    }
    rows.push(row);
  });

  return {
    source: {
      sourceId: `src_${randomUUID().slice(0, 8)}`,
      filename,
      format: "xlsx",
      sha256,
      totalRowsRead: rows.length,
      acceptedRows: rows.length,
      rejectedRows: 0,
      columnNames: headers,
      importedAt: new Date().toISOString(),
    },
    rows,
    rejects: [],
  };
}

export function profileDataset(
  datasetId: string,
  rows: StagedRow[],
  options: { scope: "sample" | "full"; sampleSize?: number } = { scope: "full" },
): DatasetProfile {
  const subset =
    options.scope === "sample" ? rows.slice(0, options.sampleSize ?? 50) : rows;
  const colNames = Array.from(
    new Set(subset.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith("__")))),
  );

  const columns: ColumnQualityProfile[] = colNames.map((colName) => {
    let nonNullCount = 0;
    let nullCount = 0;
    let emptyStringCount = 0;
    let zeroCount = 0;
    let invalidCount = 0;
    const distinct = new Set<string>();
    const types = new Set<string>();

    for (const r of subset) {
      const v = r[colName];
      if (v === null || v === undefined) {
        nullCount++;
      } else if (v === "") {
        emptyStringCount++;
      } else {
        nonNullCount++;
        distinct.add(String(v));
        if (typeof v === "number") {
          types.add("number");
          if (v === 0) zeroCount++;
        } else if (typeof v === "string") {
          if (/^-?\d+(\.\d+)?$/.test(v.trim())) {
            types.add("number");
            if (Number(v.trim()) === 0) zeroCount++;
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
            types.add("date");
          } else {
            types.add("string");
          }
          if (/^(invalid|error|n\/a)$/i.test(v.trim())) invalidCount++;
        }
      }
    }

    const inferredType: ColumnQualityProfile["inferredType"] =
      types.size > 1 ? "mixed" : types.has("number") ? "number" : types.has("date") ? "date" : "string";

    return {
      columnName: colName,
      inferredType,
      nonNullCount,
      nullCount,
      emptyStringCount,
      zeroCount,
      distinctCount: distinct.size,
      invalidCount,
    };
  });

  return {
    datasetId,
    scope: options.scope,
    sampleSize: subset.length,
    totalRows: rows.length,
    columns,
  };
}

function parseExplicitDate(
  raw: string,
  locale: "ISO" | "DMY" | "MDY" | "UNSPECIFIED",
): { ok: true; isoDate: string } | { ok: false; reason: string } {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: true, isoDate: s };
  const slash = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!slash) return { ok: false, reason: `Unrecognized date format '${s}'.` };
  const p1 = Number(slash[1]);
  const p2 = Number(slash[2]);
  const year = slash[3]!;
  if (p1 <= 12 && p2 <= 12 && locale === "UNSPECIFIED") {
    return {
      ok: false,
      reason: `Ambiguous date '${s}': requires explicit DMY or MDY policy rather than silent guessing.`,
    };
  }
  const day = locale === "MDY" ? p2 : p1;
  const month = locale === "MDY" ? p1 : p2;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: `Calendar out-of-range date '${s}' under locale '${locale}'.` };
  }
  return { ok: true, isoDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

export interface DataPrepExecutionParams {
  actor: ActorContext;
  recipe: DataPreparationRecipe;
  salesSources: StagedDataset[];
  customerMaster?: StagedDataset;
  expectedColumns: string[];
  allowCertificationWithWarnings?: boolean;
  signal?: AbortSignal;
}

export class DataPreparationPipeline {
  private readonly committedByIdempotencyKey = new Map<string, CertifiedDatasetArtifact>();
  private readonly certifiedHistory = new Map<string, CertifiedDatasetArtifact[]>();
  private static readonly MAX_IDEMPOTENCY_CACHE = 1000;

  private scopeKey(tenantId: string, workspaceId: string, key: string): string {
    return `${tenantId}::${workspaceId}::${key}`;
  }

  getHistory(actor: ActorContext, datasetId: string): CertifiedDatasetArtifact[] {
    assertCanPerform(actor, "document", "read");
    const ownKey = this.scopeKey(actor.tenantId, actor.workspaceId, datasetId);
    const list = this.certifiedHistory.get(ownKey);
    if (list) {
      return structuredClone(list);
    }
    // Check if another tenant owns this datasetId to preserve explicit 403 TENANT_ISOLATION_DENIED
    for (const items of this.certifiedHistory.values()) {
      const sample = items[0];
      if (sample && sample.datasetId === datasetId) {
        assertTenantWorkspaceAccess(actor, sample.tenantId, sample.workspaceId);
      }
    }
    return [];
  }

  planDataPrepCommand(params: {
    actor: ActorContext;
    command: string;
    sampleRows?: StagedRow[];
  }): { intent: string; ambiguous?: boolean; clarificationQuestion?: string; inputLanguage: "en" | "km" } {
    assertCanPerform(params.actor, "document", "write");
    const cellBlob = (params.sampleRows ?? [])
      .map((r) => Object.values(r).map((v) => String(v ?? "")).join(" "))
      .join(" ");
    const safety = scanForPromptInjection(params.command, cellBlob);
    if (!safety.safe) {
      throw new DataPrepError(400, "PROMPT_INJECTION_BLOCKED", `Blocked unsafe instruction: ${safety.reasons[0]}`);
    }

    const lower = params.command.toLowerCase();
    if (/\bfind duplicate/i.test(lower) || params.command.includes("រកទិន្នន័យស្ទួន")) {
      return { intent: "deduplicate_composite_key", inputLanguage: params.command.includes("រក") ? "km" : "en" };
    }
    if (/\bstandardize date/i.test(lower) || params.command.includes("ប្តូរទម្រង់កាលបរិច្ឆេទ")) {
      return { intent: "parse_date_locale", inputLanguage: params.command.includes("ប្តូរ") ? "km" : "en" };
    }
    if (/\bkhmer numeral|normalize numeral|convert khmer digit/i.test(lower) || params.command.includes("បម្លែងលេខខ្មែរ")) {
      return { intent: "normalize_khmer_numerals", inputLanguage: params.command.includes("បម្លែង") ? "km" : "en" };
    }
    if (/\bmask pii|redact pii|anonymize/i.test(lower) || params.command.includes("លាក់ព័ត៌មានផ្ទាល់ខ្លួន")) {
      return { intent: "mask_pii_columns", inputLanguage: params.command.includes("លាក់") ? "km" : "en" };
    }
    if (/\bcombine\b/i.test(lower) || params.command.includes("បញ្ចូលឯកសារ")) {
      return {
        intent: "combine_files",
        ambiguous: true,
        clarificationQuestion: "Clarify whether to append rows (union) or merge by customer business key (join).",
        inputLanguage: params.command.includes("បញ្ចូល") ? "km" : "en",
      };
    }
    throw new DataPrepError(400, "UNSUPPORTED_DATA_PREP_COMMAND", "Unrecognized data preparation command.");
  }

  executeRecipe(params: DataPrepExecutionParams): CertifiedDatasetArtifact {
    const { actor, recipe, salesSources, customerMaster, expectedColumns, signal } = params;
    assertCanPerform(actor, "document", "write");
    assertTenantWorkspaceAccess(actor, recipe.tenantId, recipe.workspaceId);

    const idemCacheKey = this.scopeKey(actor.tenantId, actor.workspaceId, recipe.idempotencyKey);
    const existingIdem = this.committedByIdempotencyKey.get(idemCacheKey);
    if (existingIdem) {
      return structuredClone(existingIdem);
    }

    // Schema drift / pinned input checksum verification
    const actualShas = salesSources.map((s) => s.source.sha256);
    for (const pinned of recipe.pinnedInputSha256s) {
      if (!actualShas.includes(pinned) && customerMaster?.source.sha256 !== pinned) {
        throw new DataPrepError(
          409,
          "PINNED_INPUT_MISMATCH",
          `Pinned input checksum '${pinned.slice(0, 12)}' does not match supplied sources.`,
        );
      }
    }

    for (const src of salesSources) {
      for (const col of expectedColumns) {
        if (!src.source.columnNames.includes(col)) {
          throw new DataPrepError(
            409,
            "SCHEMA_DRIFT_DETECTED",
            `Source '${src.source.filename}' is missing expected column '${col}'.`,
          );
        }
      }
    }

    const exceptions: DatasetExceptionRecord[] = [];
    let workingRows: StagedRow[] = [];

    // Step 1: Semantic schema alignment (by column name, independent of column order!) + ingest rejects
    for (const src of salesSources) {
      exceptions.push(...src.rejects);
      for (const row of src.rows) {
        const aligned: StagedRow = {
          __sourceFile: row.__sourceFile,
          __sourceRowNumber: row.__sourceRowNumber,
        };
        for (const col of expectedColumns) {
          aligned[col] = row[col] ?? null;
        }
        workingRows.push(aligned);
      }
    }

    // Check cancellation before transformations (DAT-T08)
    if (signal?.aborted) {
      throw new DataPrepError(499, "JOB_CANCELLED", "Data preparation cancelled cleanly before commit.");
    }

    const normalizesAmountKhmer = recipe.steps.some((st) => {
      if (st.op !== "normalize_khmer_numerals") return false;
      const cols = Array.isArray(st.params.columns) ? (st.params.columns as string[]) : ["amount"];
      return cols.includes("amount");
    });

    const extractRowAmountMinor = (row: StagedRow, allowKhmerNormalize: boolean): { curr: string; minor: bigint } | null => {
      const curr = String(row.currency ?? "USD").trim().toUpperCase();
      const scale = currencyScaleFor(curr);
      let rawAmt: unknown = row.amount;
      if (allowKhmerNormalize && typeof rawAmt === "string") {
        rawAmt = normalizeKhmerDigitsText(rawAmt, true);
      }
      const minor = parseAmountToMinorUnitsBigInt(rawAmt, scale);
      return minor === null ? null : { curr, minor };
    };

    // Compute exact BigInt minor-unit source control totals (FIN-POL-V1 alignment)
    const sourceCurrencyTotals = new Map<string, bigint>();
    const excludedCurrencyTotals = new Map<string, bigint>();

    const recordExcluded = (row: StagedRow) => {
      const parsed = extractRowAmountMinor(row, normalizesAmountKhmer);
      if (parsed) {
        excludedCurrencyTotals.set(parsed.curr, (excludedCurrencyTotals.get(parsed.curr) ?? 0n) + parsed.minor);
      }
    };

    for (const r of workingRows) {
      const parsed = extractRowAmountMinor(r, normalizesAmountKhmer);
      if (parsed) {
        sourceCurrencyTotals.set(parsed.curr, (sourceCurrencyTotals.get(parsed.curr) ?? 0n) + parsed.minor);
      }
    }

    let deduplicatedRows = 0;
    let joinReport: JoinCardinalityReport | undefined;

    for (const step of recipe.steps) {
      if (signal?.aborted) {
        throw new DataPrepError(499, "JOB_CANCELLED", "Data preparation cancelled safely; historical versions unchanged.");
      }

      if (step.op === "trim_normalize") {
        workingRows = workingRows.map((row) => {
          const next = { ...row };
          for (const [k, v] of Object.entries(next)) {
            if (!k.startsWith("__") && typeof v === "string") {
              next[k] = v.trim().normalize("NFC");
            }
          }
          return next;
        });
      } else if (step.op === "normalize_khmer_numerals") {
        const columns = Array.isArray(step.params.columns)
          ? (step.params.columns as string[])
          : ["amount"];
        const stripCurrencySymbols = step.params.stripCurrencySymbols !== false;
        workingRows = workingRows.map((row) => {
          const next = { ...row };
          for (const col of columns) {
            const val = next[col];
            if (typeof val === "string") {
              next[col] = normalizeKhmerDigitsText(val, stripCurrencySymbols);
            }
          }
          return next;
        });
      } else if (step.op === "map_bilingual_dictionary") {
        const col = String(step.params.column ?? "department");
        workingRows = workingRows.map((row) => {
          const val = row[col];
          if (typeof val !== "string") return row;
          const mapped = BILINGUAL_DEPARTMENT_DICTIONARY[val.trim().toLowerCase()];
          return mapped ? { ...row, [col]: mapped } : row;
        });
      } else if (step.op === "parse_date_locale") {
        const col = String(step.params.column ?? "invoice_date");
        const locale = (String(step.params.locale ?? "UNSPECIFIED") as "ISO" | "DMY" | "MDY" | "UNSPECIFIED");
        const surviving: StagedRow[] = [];
        for (const row of workingRows) {
          const raw = row[col];
          if (raw === null || raw === undefined || raw === "") {
            exceptions.push({
              exceptionId: `exc_${randomUUID().slice(0, 8)}`,
              sourceFile: row.__sourceFile,
              sourceRowNumber: row.__sourceRowNumber,
              severity: "critical",
              code: "MISSING_REQUIRED_DATE",
              message: `Missing date in column '${col}'.`,
              rawRecord: { ...row },
              resolved: false,
            });
            recordExcluded(row);
            continue;
          }
          const parsed = parseExplicitDate(String(raw), locale);
          if (!parsed.ok) {
            exceptions.push({
              exceptionId: `exc_${randomUUID().slice(0, 8)}`,
              sourceFile: row.__sourceFile,
              sourceRowNumber: row.__sourceRowNumber,
              severity: "critical",
              code: "AMBIGUOUS_OR_INVALID_DATE",
              message: parsed.reason,
              rawRecord: { ...row },
              resolved: false,
            });
            recordExcluded(row);
            continue;
          }
          surviving.push({ ...row, [col]: parsed.isoDate });
        }
        workingRows = surviving;
      } else if (step.op === "quarantine_missing_required") {
        const col = String(step.params.column ?? "amount");
        const surviving: StagedRow[] = [];
        for (const row of workingRows) {
          const raw = row[col];
          const strVal = typeof raw === "string" ? raw.replace(/,/g, "").trim() : raw;
          const num = strVal === null || strVal === undefined || strVal === "" ? NaN : Number(strVal);
          if (!Number.isFinite(num)) {
            exceptions.push({
              exceptionId: `exc_${randomUUID().slice(0, 8)}`,
              sourceFile: row.__sourceFile,
              sourceRowNumber: row.__sourceRowNumber,
              severity: "critical",
              code: "MISSING_REQUIRED_AMOUNT",
              message: `Missing or non-numeric '${col}' quarantined (never substituted with 0).`,
              rawRecord: { ...row },
              resolved: false,
            });
            if (col !== "amount") recordExcluded(row);
            continue;
          }
          surviving.push({ ...row, [col]: num });
        }
        workingRows = surviving;
      } else if (step.op === "validate_schema_contract") {
        const rules = Array.isArray(step.params.rules) ? (step.params.rules as SchemaColumnRule[]) : [];
        const compiledRulePatterns: Array<RegExp | null> = rules.map((rule) => {
          if (rule.preset) {
            const presetRe = NAMED_CONTRACT_PRESETS[rule.preset];
            if (!presetRe) {
              throw new DataPrepError(400, "INVALID_CONTRACT_PRESET", `Unknown schema contract preset '${String(rule.preset)}'.`);
            }
            return presetRe;
          }
          if (rule.pattern !== undefined) {
            return compileSafeContractPattern(rule.pattern);
          }
          return null;
        });
        const surviving: StagedRow[] = [];
        for (const row of workingRows) {
          let violation: string | null = null;
          for (let rIdx = 0; rIdx < rules.length; rIdx++) {
            const rule = rules[rIdx]!;
            const val = row[rule.column];
            const isEmpty = val === null || val === undefined || val === "";
            if (rule.required && isEmpty) {
              violation = `Column '${rule.column}' is required.`;
              break;
            }
            if (isEmpty) continue;

            if (rule.type === "number") {
              const num = typeof val === "number" ? val : Number(String(val).replace(/,/g, ""));
              if (!Number.isFinite(num)) {
                violation = `Column '${rule.column}' expected finite number, got '${String(val)}'.`;
                break;
              }
              if (typeof rule.min === "number" && num < rule.min) {
                violation = `Column '${rule.column}' value ${num} is below min ${rule.min}.`;
                break;
              }
              if (typeof rule.max === "number" && num > rule.max) {
                violation = `Column '${rule.column}' value ${num} exceeds max ${rule.max}.`;
                break;
              }
            } else if (rule.type === "date") {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(String(val).trim())) {
                violation = `Column '${rule.column}' expected ISO YYYY-MM-DD date, got '${String(val)}'.`;
                break;
              }
            } else if (rule.type === "enum" && Array.isArray(rule.allowedValues)) {
              if (!rule.allowedValues.includes(String(val))) {
                violation = `Column '${rule.column}' value '${String(val)}' not in allowed enum [${rule.allowedValues.join(", ")}].`;
                break;
              }
            }

            const regex = compiledRulePatterns[rIdx];
            if (regex) {
              const strVal = String(val);
              if (strVal.length > MAX_CONTRACT_REGEX_CELL_LENGTH) {
                violation = `Column '${rule.column}' value exceeds safe regex evaluation length (${MAX_CONTRACT_REGEX_CELL_LENGTH}).`;
                break;
              }
              if (!regex.test(strVal)) {
                violation = `Column '${rule.column}' value '${strVal.slice(0, 64)}' failed contract pattern.`;
                break;
              }
            }
          }

          if (violation) {
            exceptions.push({
              exceptionId: `exc_${randomUUID().slice(0, 8)}`,
              sourceFile: row.__sourceFile,
              sourceRowNumber: row.__sourceRowNumber,
              severity: "critical",
              code: "SCHEMA_CONTRACT_VIOLATION",
              message: violation,
              rawRecord: { ...row },
              resolved: false,
            });
            recordExcluded(row);
            continue;
          }
          surviving.push(row);
        }
        workingRows = surviving;
      } else if (step.op === "mask_pii_columns") {
        const columns = Array.isArray(step.params.columns) ? (step.params.columns as string[]) : [];
        const mode = step.params.mode === "hash_token" ? "hash_token" : "redact";
        const salt = typeof step.params.salt === "string" ? step.params.salt : `${actor.tenantId}:${recipe.recipeId}`;
        const hmacKey = mode === "hash_token" ? resolvePiiPseudonymizationKey() : "";
        workingRows = workingRows.map((row) => {
          const next = { ...row };
          for (const col of columns) {
            const raw = next[col];
            if (raw === null || raw === undefined || raw === "") continue;
            const s = String(raw).trim();
            if (mode === "hash_token") {
              const digest = createHmac("sha256", hmacKey)
                .update(`${actor.tenantId}::${salt}::${col}::${s}`)
                .digest("hex")
                .slice(0, 16);
              next[col] = `pii_${digest}`;
            } else {
              next[col] = maskPiiStringValue(s);
            }
          }
          return next;
        });
      } else if (step.op === "deduplicate_composite_key") {
        const keys = Array.isArray(step.params.keys)
          ? (step.params.keys as string[])
          : ["organization_id", "invoice_id", "line_number"];
        const seen = new Set<string>();
        const deduped: StagedRow[] = [];
        for (const row of workingRows) {
          const composite = keys.map((k) => String(row[k] ?? "")).join("|");
          if (seen.has(composite)) {
            deduplicatedRows++;
            exceptions.push({
              exceptionId: `exc_${randomUUID().slice(0, 8)}`,
              sourceFile: row.__sourceFile,
              sourceRowNumber: row.__sourceRowNumber,
              severity: "warning",
              code: "DUPLICATE_COMPOSITE_KEY",
              message: `Duplicate composite key [${keys.join(", ")}] = (${composite}) quarantined.`,
              rawRecord: { ...row },
              resolved: true,
            });
            recordExcluded(row);
            continue;
          }
          seen.add(composite);
          deduped.push(row);
        }
        workingRows = deduped;
      } else if (step.op === "validated_join") {
        if (!customerMaster) {
          throw new DataPrepError(400, "MISSING_JOIN_TABLE", "Customer master reference table is required for validated_join.");
        }
        const leftKey = String(step.params.leftKey ?? "customer_id");
        const rightKey = String(step.params.rightKey ?? "customer_id");
        const unmatchedPolicy = String(step.params.unmatchedPolicy ?? "retain_and_report");

        // Check right-side uniqueness for many-to-one join (§5.4 golden negative test!)
        const rightIndex = new Map<string, StagedRow>();
        const duplicateRightKeys = new Set<string>();
        for (const rRow of customerMaster.rows) {
          const k = String(rRow[rightKey] ?? "").trim();
          if (rightIndex.has(k)) {
            duplicateRightKeys.add(k);
          } else {
            rightIndex.set(k, rRow);
          }
        }

        if (duplicateRightKeys.size > 0) {
          joinReport = {
            expectedCardinality: "many_to_one",
            leftRows: workingRows.length,
            rightRows: customerMaster.rows.length,
            duplicateRightKeys: Array.from(duplicateRightKeys),
            unmatchedLeftKeys: [],
            outputRows: workingRows.length + duplicateRightKeys.size,
            blocked: true,
            reason: `Many-to-one join blocked: duplicate right key(s) [${Array.from(duplicateRightKeys).join(", ")}] would multiply rows and inflate financial totals.`,
          };
          exceptions.push({
            exceptionId: `exc_${randomUUID().slice(0, 8)}`,
            sourceFile: customerMaster.source.filename,
            sourceRowNumber: 0,
            severity: "critical",
            code: "JOIN_CARDINALITY_VIOLATION",
            message: joinReport.reason!,
            rawRecord: { duplicateRightKeys: Array.from(duplicateRightKeys) },
            resolved: false,
          });
          continue;
        }

        const unmatchedLeftKeys: string[] = [];
        const joinedRows: StagedRow[] = [];
        for (const lRow of workingRows) {
          const k = String(lRow[leftKey] ?? "").trim();
          const match = rightIndex.get(k);
          if (!match) {
            unmatchedLeftKeys.push(k);
            exceptions.push({
              exceptionId: `exc_${randomUUID().slice(0, 8)}`,
              sourceFile: lRow.__sourceFile,
              sourceRowNumber: lRow.__sourceRowNumber,
              severity: "warning",
              code: "UNMATCHED_JOIN_KEY",
              message: `Left key '${k}' had no match in '${customerMaster.source.filename}'.`,
              rawRecord: { ...lRow },
              resolved: unmatchedPolicy === "retain_and_report",
            });
            if (unmatchedPolicy === "retain_and_report") {
              joinedRows.push({ ...lRow, customer_name: null, customer_matched: false });
            } else {
              recordExcluded(lRow);
            }
          } else {
            joinedRows.push({
              ...lRow,
              customer_name: match.customer_name ?? null,
              customer_region: match.region ?? null,
              customer_matched: true,
            });
          }
        }
        workingRows = joinedRows;
        joinReport = {
          expectedCardinality: "many_to_one",
          leftRows: joinedRows.length,
          rightRows: customerMaster.rows.length,
          duplicateRightKeys: [],
          unmatchedLeftKeys,
          outputRows: joinedRows.length,
          blocked: false,
        };
      }
    }

    // Final exact BigInt minor-unit reconciliation by currency (FIN-POL-V1)
    const preparedCurrencyTotals = new Map<string, bigint>();
    for (const r of workingRows) {
      const parsed = extractRowAmountMinor(r, normalizesAmountKhmer);
      if (parsed) {
        preparedCurrencyTotals.set(parsed.curr, (preparedCurrencyTotals.get(parsed.curr) ?? 0n) + parsed.minor);
      }
    }

    const allCurrencies = new Set([
      ...sourceCurrencyTotals.keys(),
      ...preparedCurrencyTotals.keys(),
      ...excludedCurrencyTotals.keys(),
    ]);
    const currencyTotals: CurrencyControlTotal[] = Array.from(allCurrencies)
      .sort()
      .map((currency) => {
        const scale = currencyScaleFor(currency);
        const srcMinor = sourceCurrencyTotals.get(currency) ?? 0n;
        const prepMinor = preparedCurrencyTotals.get(currency) ?? 0n;
        const exclMinor = excludedCurrencyTotals.get(currency) ?? 0n;
        const diffMinor = srcMinor - (prepMinor + exclMinor);
        return {
          currency,
          scale,
          sourceTotal: minorUnitsToNumber(srcMinor, scale),
          preparedTotal: minorUnitsToNumber(prepMinor, scale),
          excludedOrQuarantinedTotal: minorUnitsToNumber(exclMinor, scale),
          unexplainedDifference: minorUnitsToNumber(diffMinor, scale),
          sourceMinorUnits: srcMinor.toString(),
          preparedMinorUnits: prepMinor.toString(),
          excludedMinorUnits: exclMinor.toString(),
          unexplainedMinorUnits: diffMinor.toString(),
        };
      });

    const criticalFailures = exceptions
      .filter((e) => e.severity === "critical" && !e.resolved)
      .map((e) => `${e.code}: ${e.message}`);
    for (const ct of currencyTotals) {
      if (ct.unexplainedMinorUnits && BigInt(ct.unexplainedMinorUnits) !== 0n) {
        criticalFailures.push(
          `RECONCILIATION_MISMATCH (${ct.currency}): unexplained minor-unit difference ${ct.unexplainedMinorUnits}`,
        );
      }
    }

    const reconciliation: ReconciliationReport = {
      sourceAcceptedRows: salesSources.reduce((acc, s) => acc + s.source.acceptedRows, 0),
      preparedRows: workingRows.length,
      quarantinedRows: exceptions.filter((e) => e.code !== "UNMATCHED_JOIN_KEY").length,
      deduplicatedRows,
      currencyTotals,
      criticalFailures,
      passed: criticalFailures.length === 0,
    };

    const datasetId = `ds_${recipe.recipeId}`;
    const historyKey = this.scopeKey(actor.tenantId, actor.workspaceId, datasetId);
    const existingVersions = this.certifiedHistory.get(historyKey) ?? [];
    const nextVersion = existingVersions.length + 1;

    // Canonical semantic sort for reproducible output SHA-256 across reruns
    const canonicalRows = [...workingRows].sort((a, b) =>
      `${a.organization_id}|${a.invoice_id}|${a.line_number}`.localeCompare(
        `${b.organization_id}|${b.invoice_id}|${b.line_number}`,
      ),
    );
    const semanticPayload = canonicalRows.map((r) => {
      const clean: Record<string, unknown> = {};
      for (const k of Object.keys(r).filter((k) => !k.startsWith("__")).sort()) {
        clean[k] = r[k];
      }
      return clean;
    });
    const outputSha256 = createHash("sha256")
      .update(JSON.stringify(semanticPayload))
      .digest("hex");

    const artifact: CertifiedDatasetArtifact = {
      datasetId,
      version: nextVersion,
      tenantId: recipe.tenantId,
      workspaceId: recipe.workspaceId,
      status: reconciliation.passed ? "certified" : "blocked",
      outputSha256,
      rows: semanticPayload,
      exceptions,
      reconciliation,
      ...(joinReport ? { joinReport } : {}),
      lineage: {
        sourceSha256s: salesSources.map((s) => s.source.sha256),
        recipeId: recipe.recipeId,
        recipeVersion: recipe.version,
        engine: "pipeline-ts",
        createdAt: new Date().toISOString(),
      },
    };

    // Atomic commit only on non-cancelled runs
    existingVersions.push(artifact);
    this.certifiedHistory.set(historyKey, existingVersions);
    if (this.committedByIdempotencyKey.size >= DataPreparationPipeline.MAX_IDEMPOTENCY_CACHE) {
      const oldest = this.committedByIdempotencyKey.keys().next().value;
      if (oldest !== undefined) this.committedByIdempotencyKey.delete(oldest);
    }
    this.committedByIdempotencyKey.set(idemCacheKey, artifact);

    return structuredClone(artifact);
  }
}

function maskPiiStringValue(raw: string): string {
  // Email masking: keep first char + domain
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    const [local, domain] = raw.split("@");
    return `${local![0] ?? "*"}***@${domain}`;
  }
  // Cambodian phone numbers (+855 / 0xx) or generic phone/account numbers
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 6) {
    return `***-***-${digits.slice(-4)}`;
  }
  return "***REDACTED***";
}

export function exportCertifiedDatasetToSafeCsv(
  artifact: CertifiedDatasetArtifact,
  columns?: string[],
): CertifiedCsvExportResult {
  const colNames =
    columns && columns.length > 0
      ? columns
      : Array.from(new Set(artifact.rows.flatMap((r) => Object.keys(r)))).sort();

  const lines: string[] = [colNames.map((c) => escapeSafeCsvCell(c).cell).join(",")];
  for (const row of artifact.rows) {
    lines.push(colNames.map((c) => escapeSafeCsvCell(row[c]).cell).join(","));
  }
  const csv = `${lines.join("\r\n")}\r\n`;
  const csvSha256 = createHash("sha256").update(csv, "utf8").digest("hex");
  return {
    csv,
    csvSha256,
    datasetId: artifact.datasetId,
    version: artifact.version,
    outputSha256: artifact.outputSha256,
    rowCount: artifact.rows.length,
    status: artifact.status,
  };
}
