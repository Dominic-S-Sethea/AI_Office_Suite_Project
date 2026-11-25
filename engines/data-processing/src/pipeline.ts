import { createHash, randomUUID } from "node:crypto";
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
import { scanForPromptInjection } from "@ai-office-suite/validation";
import { unzipSync } from "fflate";
import ExcelJS from "exceljs";

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

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export function stageCsvSource(csvText: string, filename: string): StagedDataset {
  const sha256 = createHash("sha256").update(csvText, "utf8").digest("hex");
  const normalizedText = csvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalizedText.split("\n").filter((l) => l.length > 0);
  if (rawLines.length === 0) {
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

  const headers = splitCsvLine(rawLines[0]!).map((h) => h.trim().normalize("NFC"));
  const rows: StagedRow[] = [];
  const rejects: DatasetExceptionRecord[] = [];

  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    const quoteCount = (line.match(/"/g) ?? []).length;
    const fields = splitCsvLine(line);
    if (quoteCount % 2 !== 0 || fields.length !== headers.length) {
      rejects.push({
        exceptionId: `exc_${randomUUID().slice(0, 8)}`,
        sourceFile: filename,
        sourceRowNumber: i + 1,
        severity: "critical",
        code: "MALFORMED_CSV_ROW",
        message: `Row ${i + 1} column count (${fields.length}) or quoting does not match header (${headers.length}).`,
        rawRecord: { rawLine: line },
        resolved: false,
      });
      continue;
    }

    const row: StagedRow = { __sourceFile: filename, __sourceRowNumber: i + 1 };
    for (let c = 0; c < headers.length; c++) {
      const val = (fields[c] ?? "").normalize("NFC");
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
      totalRowsRead: rawLines.length - 1,
      acceptedRows: rows.length,
      rejectedRows: rejects.length,
      columnNames: headers,
      importedAt: new Date().toISOString(),
    },
    rows,
    rejects,
  };
}

export async function stageXlsxSource(buffer: Uint8Array, filename: string): Promise<StagedDataset> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsm") || lower.endsWith(".xlsb")) {
    throw new DataPrepError(400, "MACRO_WORKBOOK_BLOCKED", `Macro-enabled workbook '${filename}' is blocked.`);
  }
  if (
    buffer.byteLength >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    throw new DataPrepError(400, "ENCRYPTED_WORKBOOK_UNSUPPORTED", "Encrypted or OLE2 binary Excel files are not supported.");
  }
  if (
    buffer.byteLength < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    throw new DataPrepError(400, "INVALID_XLSX_ZIP", "Uploaded XLSX is not a valid OOXML ZIP archive.");
  }
  let entryCount = 0;
  let totalBytes = 0;
  try {
    unzipSync(buffer, {
      filter: (f) => {
        entryCount++;
        if (entryCount > 600) {
          throw new DataPrepError(400, "TOO_MANY_ARCHIVE_ENTRIES", "XLSX exceeds entry safety limit.");
        }
        if (
          f.name.includes("..") ||
          f.name.startsWith("/") ||
          f.name.startsWith("\\") ||
          /^[A-Za-z]:/.test(f.name) ||
          f.name.includes("\0")
        ) {
          throw new DataPrepError(400, "ZIP_PATH_TRAVERSAL_BLOCKED", "XLSX archive contains unsafe path entries.");
        }
        if (/EncryptedPackage/i.test(f.name)) {
          throw new DataPrepError(400, "ENCRYPTED_WORKBOOK_UNSUPPORTED", "Encrypted Excel files are not supported.");
        }
        if (/vbaProject\.bin|vbaData\.xml|\.xlm$/i.test(f.name)) {
          throw new DataPrepError(400, "MACRO_WORKBOOK_BLOCKED", `Embedded macro part '${f.name}' blocked.`);
        }
        totalBytes += f.originalSize;
        if (
          f.originalSize > 25 * 1024 * 1024 ||
          totalBytes > 64 * 1024 * 1024 ||
          (f.originalSize > 1_048_576 && f.size > 0 && f.originalSize / f.size > 100)
        ) {
          throw new DataPrepError(400, "ZIP_BOMB_BLOCKED", "XLSX archive exceeds decompressed size or ratio bounds.");
        }
        return false;
      },
    });
  } catch (err) {
    if (err instanceof DataPrepError) throw err;
    throw new DataPrepError(400, "INVALID_XLSX_ZIP", "Unable to inspect XLSX archive safely.");
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buffer) as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
    throw new DataPrepError(400, "EMPTY_WORKBOOK", `Workbook '${filename}' contains no worksheets.`);
  }

  const headers: string[] = [];
  const rows: StagedRow[] = [];

  ws.eachRow((excelRow, rowNumber) => {
    const values = (excelRow.values as unknown[]).slice(1);
    if (rowNumber === 1) {
      for (const v of values) headers.push(String(v ?? "").trim().normalize("NFC"));
      return;
    }
    const row: StagedRow = { __sourceFile: filename, __sourceRowNumber: rowNumber };
    for (let c = 0; c < headers.length; c++) {
      const raw = values[c];
      if (raw === undefined || raw === null || raw === "") {
        row[headers[c]!] = null;
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

  getHistory(actor: ActorContext, datasetId: string): CertifiedDatasetArtifact[] {
    assertCanPerform(actor, "document", "read");
    const list = this.certifiedHistory.get(datasetId) ?? [];
    for (const item of list) {
      assertTenantWorkspaceAccess(actor, item.tenantId, item.workspaceId);
    }
    return structuredClone(list);
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

    const existingIdem = this.committedByIdempotencyKey.get(recipe.idempotencyKey);
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

    // Compute source currency control totals from accepted rows with valid numeric amounts
    const sourceCurrencyTotals = new Map<string, number>();
    const excludedCurrencyTotals = new Map<string, number>();

    for (const r of workingRows) {
      const curr = String(r.currency ?? "USD").trim().toUpperCase();
      const amt = r.amount === null || r.amount === undefined ? NaN : Number(r.amount);
      if (Number.isFinite(amt)) {
        sourceCurrencyTotals.set(curr, (sourceCurrencyTotals.get(curr) ?? 0) + amt);
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
            const curr = String(row.currency ?? "USD").trim().toUpperCase();
            const amt = Number(row.amount);
            if (Number.isFinite(amt)) {
              excludedCurrencyTotals.set(curr, (excludedCurrencyTotals.get(curr) ?? 0) + amt);
            }
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
          const num = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
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
            continue;
          }
          surviving.push({ ...row, [col]: num });
        }
        workingRows = surviving;
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
            const curr = String(row.currency ?? "USD").trim().toUpperCase();
            const amt = Number(row.amount);
            if (Number.isFinite(amt)) {
              excludedCurrencyTotals.set(curr, (excludedCurrencyTotals.get(curr) ?? 0) + amt);
            }
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

    // Final reconciliation by currency
    const preparedCurrencyTotals = new Map<string, number>();
    for (const r of workingRows) {
      const curr = String(r.currency ?? "USD").trim().toUpperCase();
      const amt = Number(r.amount);
      if (Number.isFinite(amt)) {
        preparedCurrencyTotals.set(curr, (preparedCurrencyTotals.get(curr) ?? 0) + amt);
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
        const src = Math.round((sourceCurrencyTotals.get(currency) ?? 0) * 100) / 100;
        const prep = Math.round((preparedCurrencyTotals.get(currency) ?? 0) * 100) / 100;
        const excl = Math.round((excludedCurrencyTotals.get(currency) ?? 0) * 100) / 100;
        const diff = Math.round((src - (prep + excl)) * 100) / 100;
        return {
          currency,
          sourceTotal: src,
          preparedTotal: prep,
          excludedOrQuarantinedTotal: excl,
          unexplainedDifference: diff,
        };
      });

    const criticalFailures = exceptions
      .filter((e) => e.severity === "critical" && !e.resolved)
      .map((e) => `${e.code}: ${e.message}`);
    for (const ct of currencyTotals) {
      if (Math.abs(ct.unexplainedDifference) > 0.01) {
        criticalFailures.push(
          `RECONCILIATION_MISMATCH (${ct.currency}): unexplained difference ${ct.unexplainedDifference}`,
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
    const existingVersions = this.certifiedHistory.get(datasetId) ?? [];
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
    this.certifiedHistory.set(datasetId, existingVersions);
    this.committedByIdempotencyKey.set(recipe.idempotencyKey, artifact);

    return structuredClone(artifact);
  }
}
