import { randomUUID } from "node:crypto";
import type {
  CsvExportSafetyReport,
  SpreadsheetCellRecord,
  SpreadsheetWorkbook,
  SpreadsheetWorksheet,
} from "@ai-office-suite/shared-contracts";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import {
  colIndexToLetters,
  colLettersToIndex,
  parseCellRef,
  recalculateWorkbook,
} from "./formulaEngine.ts";

export class WorkbookInteroperabilityError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "WorkbookInteroperabilityError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function exportWorkbookToXlsxBuffer(workbook: SpreadsheetWorkbook): Promise<Buffer> {
  const recalculated = recalculateWorkbook(workbook).workbook;
  const wb = new ExcelJS.Workbook();
  wb.creator = "AI Office Suite (SS-00 Feasibility Prototype)";
  wb.properties.date1904 = recalculated.dateSystem === "1904";

  for (const sheet of recalculated.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const [addr, cell] of Object.entries(sheet.cells)) {
      const parsed = parseCellRef(addr);
      if (!parsed) continue;
      const excelCell = ws.getCell(parsed.row, parsed.col);
      if (cell.formula) {
        const cleanFormula = cell.formula.startsWith("=") ? cell.formula.slice(1) : cell.formula;
        const resultVal =
          cell.evaluatedValue && typeof cell.evaluatedValue === "object" && "error" in cell.evaluatedValue
            ? { error: cell.evaluatedValue.error }
            : (cell.evaluatedValue ?? undefined);
        excelCell.value = {
          formula: cleanFormula,
          ...(resultVal !== undefined ? { result: resultVal as ExcelJS.CellFormulaValue["result"] } : {}),
        };
      } else {
        excelCell.value = cell.value;
      }
      if (cell.numberFormat) {
        excelCell.numFmt = cell.numberFormat;
      } else if (typeof cell.value === "string") {
        // Explicitly preserve leading-zero IDs (e.g. "001245") as text format
        excelCell.numFmt = "@";
      }
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export async function importWorkbookFromXlsxBuffer(
  buffer: Uint8Array,
  filename: string,
): Promise<SpreadsheetWorkbook> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsm") || lower.endsWith(".xlsb")) {
    throw new WorkbookInteroperabilityError(
      400,
      "MACRO_WORKBOOK_BLOCKED",
      `Macro-enabled workbook format '${filename}' is blocked.`,
    );
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
    throw new WorkbookInteroperabilityError(
      400,
      "ENCRYPTED_WORKBOOK_UNSUPPORTED",
      "Encrypted or legacy OLE2 binary Excel files are not supported.",
    );
  }

  if (
    buffer.byteLength < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    throw new WorkbookInteroperabilityError(400, "INVALID_XLSX_ZIP", "Uploaded XLSX is not a valid ZIP archive.");
  }

  let zipEntries: Record<string, Uint8Array>;
  let entryCount = 0;
  let totalUncompressedBytes = 0;
  const MAX_ENTRIES = 600;
  const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  try {
    zipEntries = unzipSync(buffer, {
      filter: (f) => {
        entryCount++;
        if (entryCount > MAX_ENTRIES) {
          throw new WorkbookInteroperabilityError(400, "TOO_MANY_ARCHIVE_ENTRIES", "XLSX exceeds archive entry safety limit.");
        }
        if (
          f.name.includes("..") ||
          f.name.startsWith("/") ||
          f.name.startsWith("\\") ||
          /^[A-Za-z]:/.test(f.name) ||
          f.name.includes("\0")
        ) {
          throw new WorkbookInteroperabilityError(
            400,
            "ZIP_PATH_TRAVERSAL_BLOCKED",
            "XLSX archive contains unsafe path-traversal entries.",
          );
        }
        if (/EncryptedPackage/i.test(f.name)) {
          throw new WorkbookInteroperabilityError(
            400,
            "ENCRYPTED_WORKBOOK_UNSUPPORTED",
            "Encrypted Excel files are not supported.",
          );
        }
        if (/vbaProject\.bin|vbaData\.xml|\.xlm$/i.test(f.name)) {
          throw new WorkbookInteroperabilityError(
            400,
            "MACRO_WORKBOOK_BLOCKED",
            `Embedded macro part '${f.name}' detected and blocked.`,
          );
        }
        totalUncompressedBytes += f.originalSize;
        if (
          f.originalSize > MAX_ENTRY_BYTES ||
          totalUncompressedBytes > MAX_TOTAL_BYTES ||
          (f.originalSize > 1_048_576 && f.size > 0 && f.originalSize / f.size > 100)
        ) {
          throw new WorkbookInteroperabilityError(
            400,
            "ZIP_BOMB_BLOCKED",
            "XLSX archive exceeds safe decompressed size or compression ratio bounds.",
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof WorkbookInteroperabilityError) throw err;
    throw new WorkbookInteroperabilityError(400, "INVALID_XLSX_ZIP", "Uploaded XLSX is not a valid ZIP archive.");
  }

  const entryNames = Object.keys(zipEntries);
  if (!entryNames.some((n) => n === "xl/workbook.xml")) {
    throw new WorkbookInteroperabilityError(400, "INVALID_XLSX_STRUCTURE", "Archive is missing xl/workbook.xml.");
  }

  const unsupportedFeatures: string[] = [];
  if (entryNames.some((n) => n.startsWith("xl/pivotTables/"))) {
    unsupportedFeatures.push("PivotTables (xl/pivotTables/*)");
  }
  if (entryNames.some((n) => n.startsWith("xl/externalLinks/"))) {
    unsupportedFeatures.push("External workbook links (blocked for security)");
  }
  for (const relName of entryNames.filter((n) => n.endsWith(".rels"))) {
    const relXml = Buffer.from(zipEntries[relName]!).toString("utf8");
    if (/TargetMode\s*=\s*["']External["']/i.test(relXml)) {
      unsupportedFeatures.push(`External relationship reference in ${relName} (blocked)`);
    }
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buffer) as unknown as ExcelJS.Buffer);

  const sheets: SpreadsheetWorksheet[] = [];
  wb.eachSheet((ws) => {
    const cells: Record<string, SpreadsheetCellRecord> = {};
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const addr = cell.address.toUpperCase();
        const val = cell.value;
        let record: SpreadsheetCellRecord;
        if (val && typeof val === "object" && "formula" in val) {
          const formulaObj = val as ExcelJS.CellFormulaValue;
          record = {
            value: null,
            formula: `=${formulaObj.formula}`,
            numberFormat: cell.numFmt || undefined,
          };
        } else if (val && typeof val === "object" && "richText" in val) {
          const rt = (val as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("").normalize("NFC");
          record = { value: rt, numberFormat: cell.numFmt || undefined };
        } else if (val instanceof Date) {
          record = { value: val.toISOString(), numberFormat: cell.numFmt || undefined };
        } else if (typeof val === "string") {
          record = { value: val.normalize("NFC"), numberFormat: cell.numFmt || undefined };
        } else if (typeof val === "number" || typeof val === "boolean") {
          record = { value: val, numberFormat: cell.numFmt || undefined };
        } else {
          record = { value: null };
        }

        if (record.numberFormat?.includes("$")) record.currency = "USD";
        else if (record.numberFormat?.includes("៛") || record.numberFormat?.includes("KHR")) record.currency = "KHR";

        cells[addr] = record;
      });
    });

    sheets.push({
      sheetId: `sh_${ws.id}`,
      name: ws.name,
      cells,
    });
  });

  const initial: SpreadsheetWorkbook = {
    workbookId: `wb_${randomUUID()}`,
    title: filename.replace(/\.xlsx$/i, ""),
    revision: 1,
    dateSystem: wb.properties.date1904 ? "1904" : "1900",
    sheets,
    unsupportedFeatures,
  };

  const recalc = recalculateWorkbook(initial);
  for (const unsup of recalc.unsupportedCells) {
    recalc.workbook.unsupportedFeatures.push(
      `Unsupported formula function '${unsup.functionName}' at ${unsup.sheet}!${unsup.cell}`,
    );
  }
  return recalc.workbook;
}

const FORMULA_INJECTION_PREFIX = /^[\s\x00-\x1f]*[=+\-@]|^[\t\r]/;

/**
 * Exports a worksheet to CSV with OWASP CSV formula-injection neutralization
 * (prefixes untrusted text values starting with =, +, -, @, tab, or CR with a single quote).
 */
export function exportSheetToSafeCsv(sheet: SpreadsheetWorksheet): CsvExportSafetyReport {
  let maxRow = 0;
  let maxCol = 0;
  for (const addr of Object.keys(sheet.cells)) {
    const parsed = parseCellRef(addr);
    if (!parsed) continue;
    maxRow = Math.max(maxRow, parsed.row);
    maxCol = Math.max(maxCol, parsed.col);
  }

  let neutralizedFormulaCells = 0;
  const warnings: string[] = [];
  const lines: string[] = [];

  for (let r = 1; r <= maxRow; r++) {
    const rowValues: string[] = [];
    for (let c = 1; c <= maxCol; c++) {
      const addr = `${colIndexToLetters(c)}${r}`;
      const cell = sheet.cells[addr];
      if (!cell) {
        rowValues.push("");
        continue;
      }
      const rawVal = cell.formula
        ? cell.evaluatedValue && typeof cell.evaluatedValue === "object" && "error" in cell.evaluatedValue
          ? cell.evaluatedValue.error
          : (cell.evaluatedValue ?? "")
        : (cell.value ?? "");

      let text = String(rawVal);
      if (typeof rawVal === "string" && FORMULA_INJECTION_PREFIX.test(text)) {
        text = `'${text}`;
        neutralizedFormulaCells++;
      }
      if (text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r")) {
        text = `"${text.replace(/"/g, '""')}"`;
      }
      rowValues.push(text);
    }
    lines.push(rowValues.join(","));
  }

  if (neutralizedFormulaCells > 0) {
    warnings.push(
      `Neutralized ${neutralizedFormulaCells} cell(s) starting with formula trigger characters (=, +, -, @) per OWASP CSV injection defense.`,
    );
  }

  return {
    csv: lines.join("\n"),
    neutralizedFormulaCells,
    warnings,
  };
}

export function sortWorksheetTableByColumn(
  sheet: SpreadsheetWorksheet,
  startCol: string,
  endCol: string,
  startRow: number,
  endRow: number,
  sortCol: string,
  ascending = true,
): SpreadsheetWorksheet {
  const c1 = colLettersToIndex(startCol);
  const c2 = colLettersToIndex(endCol);
  const sCol = colLettersToIndex(sortCol);
  const next = structuredClone(sheet);

  const rows: Array<Record<number, SpreadsheetCellRecord>> = [];
  for (let r = startRow; r <= endRow; r++) {
    const rowObj: Record<number, SpreadsheetCellRecord> = {};
    for (let c = c1; c <= c2; c++) {
      const existing = next.cells[`${colIndexToLetters(c)}${r}`];
      if (existing) rowObj[c] = existing;
    }
    rows.push(rowObj);
  }

  rows.sort((a, b) => {
    const va = a[sCol]?.value ?? "";
    const vb = b[sCol]?.value ?? "";
    if (typeof va === "number" && typeof vb === "number") {
      return ascending ? va - vb : vb - va;
    }
    return ascending
      ? String(va).localeCompare(String(vb))
      : String(vb).localeCompare(String(va));
  });

  for (let idx = 0; idx < rows.length; idx++) {
    const targetRow = startRow + idx;
    const rowObj = rows[idx]!;
    for (let c = c1; c <= c2; c++) {
      const addr = `${colIndexToLetters(c)}${targetRow}`;
      if (rowObj[c]) next.cells[addr] = rowObj[c]!;
      else delete next.cells[addr];
    }
  }
  return next;
}
