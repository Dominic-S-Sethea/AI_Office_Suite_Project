import type {
  CellStoredValue,
  ExcelErrorValue,
  SpreadsheetCellRecord,
  SpreadsheetWorkbook,
} from "@ai-office-suite/shared-contracts";
import { ExactDecimalError, parseExactDecimalToMinorUnits } from "@ai-office-suite/validation";

export interface CellEvalResult {
  value: CellStoredValue | { error: ExcelErrorValue; detail?: string };
}

const SUPPORTED_FUNCTIONS = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTA",
  "IF",
  "AND",
  "OR",
  "NOT",
  "IFERROR",
  "SUMIF",
  "COUNTIF",
  "VLOOKUP",
  "ROUND",
  "ABS",
  "LEN",
  "TRIM",
  "CONCAT",
]);

function isExcelError(val: unknown): val is { error: ExcelErrorValue; detail?: string } {
  return Boolean(val && typeof val === "object" && "error" in (val as Record<string, unknown>));
}

export function colLettersToIndex(col: string): number {
  let idx = 0;
  for (const ch of col.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx;
}

export function colIndexToLetters(idx: number): string {
  let n = idx;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseCellRef(ref: string): { sheet?: string; col: number; row: number; absCol: boolean; absRow: boolean } | null {
  const bangIdx = ref.indexOf("!");
  const sheet = bangIdx >= 0 ? ref.slice(0, bangIdx).replace(/^'|'$/g, "") : undefined;
  const addr = bangIdx >= 0 ? ref.slice(bangIdx + 1) : ref;
  const m = addr.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/);
  if (!m) return null;
  return {
    sheet,
    absCol: m[1] === "$",
    col: colLettersToIndex(m[2]!),
    absRow: m[3] === "$",
    row: Number(m[4]!),
  };
}

export function formatCellAddr(col: number, row: number): string {
  return `${colIndexToLetters(col)}${row}`;
}

const MAX_EXPANDED_RANGE_CELLS = 250_000;
const MAX_EXPR_DEPTH = 64;
const MAX_CELL_STACK_DEPTH = 256;
const MAX_WORKBOOK_EVAL_STEPS = 2_000_000;

function roundNumberHalfUp(n: number, digits: number): number | { error: ExcelErrorValue } {
  if (!Number.isFinite(n)) return { error: "#NUM!" };
  if (n === 0) return 0;
  const safeDigits = Math.trunc(digits);
  if (safeDigits > 15) return n;
  if (safeDigits < -308) return 0;
  try {
    const scaled = parseExactDecimalToMinorUnits(n, safeDigits, 10n ** 40n, "HALF_UP");
    if (scaled === 0n) return 0;
    if (safeDigits === 0) return Number(scaled);
    if (safeDigits > 0) {
      const neg = scaled < 0n;
      const absStr = (neg ? -scaled : scaled).toString().padStart(safeDigits + 1, "0");
      const splitIdx = absStr.length - safeDigits;
      return Number(`${neg ? "-" : ""}${absStr.slice(0, splitIdx)}.${absStr.slice(splitIdx)}`);
    }
    return Number(scaled) * 10 ** (-safeDigits);
  } catch (err) {
    if (err instanceof ExactDecimalError && err.code === "NUMERIC_OVERFLOW") {
      if (Math.abs(n) < 10 ** (-safeDigits - 1)) return 0;
      return n;
    }
    return { error: "#NUM!" };
  }
}

export function expandRange(rangeStr: string, defaultSheet: string): Array<{ sheet: string; addr: string }> | null {
  const parts = rangeStr.split(":");
  if (parts.length !== 2) return null;
  const start = parseCellRef(parts[0]!.trim());
  const end = parseCellRef(parts[1]!.trim());
  if (!start || !end) return null;
  const sheet = start.sheet ?? end.sheet ?? defaultSheet;
  const r1 = Math.min(start.row, end.row);
  const r2 = Math.max(start.row, end.row);
  const c1 = Math.min(start.col, end.col);
  const c2 = Math.max(start.col, end.col);
  const totalCells = (r2 - r1 + 1) * (c2 - c1 + 1);
  if (totalCells > MAX_EXPANDED_RANGE_CELLS) return null;
  const list: Array<{ sheet: string; addr: string }> = [];
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      list.push({ sheet, addr: formatCellAddr(c, r) });
    }
  }
  return list;
}

/**
 * Translates a base formula (e.g. =B2-C2+$B$1) by (deltaCol, deltaRow),
 * preserving $ absolute references while shifting relative references.
 */
export function shiftFormulaReferences(formula: string, deltaCol: number, deltaRow: number): string {
  if (!formula.startsWith("=")) return formula;
  let result = "";
  let i = 0;
  while (i < formula.length) {
    if (formula[i] === '"') {
      const start = i;
      i++;
      while (i < formula.length) {
        if (formula[i] === '"') {
          if (formula[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      result += formula.slice(start, i);
      continue;
    }

    const nextQuote = formula.indexOf('"', i);
    const end = nextQuote === -1 ? formula.length : nextQuote;
    const segment = formula.slice(i, end);
    result += segment.replace(
      /('[^']+'!|[A-Za-z0-9_]+!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g,
      (full, sheetPrefix: string | undefined, absCol: string, colStr: string, absRow: string, rowStr: string, offset: number, str: string) => {
        if (!sheetPrefix && offset > 0 && /[A-Za-z0-9_.]/.test(str[offset - 1]!)) {
          return full;
        }
        const afterIdx = offset + full.length;
        if (afterIdx < str.length && /[A-Za-z0-9_(]/.test(str[afterIdx]!)) {
          return full;
        }
        const colIdx = colLettersToIndex(colStr.toUpperCase());
        const nextCol = absCol === "$" ? colIdx : Math.max(1, colIdx + deltaCol);
        const nextRow = absRow === "$" ? Number(rowStr) : Math.max(1, Number(rowStr) + deltaRow);
        return `${sheetPrefix ?? ""}${absCol}${colIndexToLetters(nextCol)}${absRow}${nextRow}`;
      },
    );
    i = end;
  }
  return result;
}

function splitTopLevelArgs(argStr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i]!;
    if (ch === '"' && argStr[i - 1] !== "\\") {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && ch === "(") {
      depth++;
      current += ch;
    } else if (!inQuote && ch === ")") {
      depth--;
      current += ch;
    } else if (!inQuote && depth === 0 && ch === ",") {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

function toNumber(val: CellStoredValue | { error: ExcelErrorValue }): number | { error: ExcelErrorValue } {
  if (isExcelError(val)) return val;
  if (val === null || val === "") return 0;
  if (typeof val === "number") return val;
  if (typeof val === "boolean") return val ? 1 : 0;
  const parsed = Number(val);
  if (Number.isFinite(parsed)) return parsed;
  return { error: "#VALUE!" };
}

function evaluateCriteria(
  val: CellStoredValue | { error: ExcelErrorValue },
  criteriaRaw: string,
  unquote = true,
): boolean {
  if (isExcelError(val)) return false;
  const cleaned = unquote ? criteriaRaw.replace(/^"|"$/g, "") : criteriaRaw;
    const cmp = cleaned.match(/^(<=|>=|<>|<|>|=)(.*)$/);
  if (cmp) {
    const op = cmp[1]!;
    const rhsRaw = cmp[2]!.trim();
    const rhsNum = Number(rhsRaw);
    const lhsNum = typeof val === "number" ? val : Number(val);
    if (rhsRaw.length > 0 && Number.isFinite(rhsNum) && val !== null && val !== "" && Number.isFinite(lhsNum)) {
      if (op === "<") return lhsNum < rhsNum;
      if (op === "<=") return lhsNum <= rhsNum;
      if (op === ">") return lhsNum > rhsNum;
      if (op === ">=") return lhsNum >= rhsNum;
      if (op === "<>") return lhsNum !== rhsNum;
      if (op === "=") return lhsNum === rhsNum;
    }
    const lhsStr = String(val ?? "");
    if (op === "<>") return lhsStr !== rhsRaw;
    if (op === "=") return lhsStr === rhsRaw;
    return false;
  }
  if (val === null) return cleaned === "";
  return String(val).toLowerCase() === cleaned.toLowerCase();
}

export function recalculateWorkbook(workbook: SpreadsheetWorkbook): {
  workbook: SpreadsheetWorkbook;
  cyclesDetected: string[][];
  unsupportedCells: Array<{ sheet: string; cell: string; functionName: string }>;
} {
  const next = structuredClone(workbook);
  const sheetMap = new Map(next.sheets.map((s) => [s.name, s]));
  const memo = new Map<string, CellStoredValue | { error: ExcelErrorValue; detail?: string }>();
  const sheetColIndexCache = new Map<string, Map<number, Array<{ row: number; addr: string }>>>();
  const cyclesDetected: string[][] = [];
  const unsupportedCells: Array<{ sheet: string; cell: string; functionName: string }> = [];
  let evalSteps = 0;

  const getColumnEntries = (sheetName: string, col: number): Array<{ row: number; addr: string }> => {
    let byCol = sheetColIndexCache.get(sheetName);
    if (!byCol) {
      byCol = new Map();
      const sheet = sheetMap.get(sheetName);
      if (sheet) {
        for (const addr of Object.keys(sheet.cells)) {
          const parsed = parseCellRef(addr);
          if (!parsed) continue;
          let list = byCol.get(parsed.col);
          if (!list) {
            list = [];
            byCol.set(parsed.col, list);
          }
          list.push({ row: parsed.row, addr });
        }
        for (const list of byCol.values()) {
          list.sort((a, b) => a.row - b.row);
        }
      }
      sheetColIndexCache.set(sheetName, byCol);
    }
    return byCol.get(col) ?? [];
  };

  const getCellRecord = (sheetName: string, addr: string): SpreadsheetCellRecord | undefined => {
    return sheetMap.get(sheetName)?.cells[addr.toUpperCase()];
  };

  const evalCell = (
    sheetName: string,
    addr: string,
    stack: string[],
  ): CellStoredValue | { error: ExcelErrorValue; detail?: string } => {
    if (++evalSteps > MAX_WORKBOOK_EVAL_STEPS) {
      return { error: "#VALUE!", detail: "Workbook evaluation budget exceeded." };
    }
    if (stack.length >= MAX_CELL_STACK_DEPTH) {
      return { error: "#VALUE!", detail: `Cell reference chain exceeded maximum depth (${MAX_CELL_STACK_DEPTH}).` };
    }
    const upperAddr = addr.toUpperCase();
    const key = `${sheetName}!${upperAddr}`;
    if (stack.includes(key)) {
      const cycle = [...stack.slice(stack.indexOf(key)), key];
      cyclesDetected.push(cycle);
      return { error: "#CYCLE!", detail: `Circular reference: ${cycle.join(" -> ")}` };
    }
    if (memo.has(key)) return memo.get(key)!;

    const sheet = sheetMap.get(sheetName);
    if (!sheet) return { error: "#REF!", detail: `Unknown sheet '${sheetName}'` };

    const record = getCellRecord(sheetName, upperAddr);
    if (!record) return null;

    if (!record.formula) {
      memo.set(key, record.value);
      return record.value;
    }

    const nextStack = [...stack, key];
    const result = evalExpr(record.formula.slice(1).trim(), sheetName, nextStack, key, 0);
    record.evaluatedValue = result;
    if (isExcelError(result) && result.error === "#NAME?" && result.detail?.startsWith("Unsupported function:")) {
      const fnName = result.detail.replace("Unsupported function:", "").trim();
      record.unsupportedWarning = `Unsupported Excel function '${fnName}'; not substituted with 0.`;
      unsupportedCells.push({ sheet: sheetName, cell: upperAddr, functionName: fnName });
    } else {
      delete record.unsupportedWarning;
    }
    memo.set(key, result);
    return result;
  };

  const resolveRangeValues = (
    arg: string,
    sheetName: string,
    stack: string[],
    depth: number,
  ): Array<CellStoredValue | { error: ExcelErrorValue; detail?: string }> => {
    if (arg.includes(":")) {
      const expanded = expandRange(arg, sheetName);
      if (!expanded) return [{ error: "#REF!" }];
      if (evalSteps + expanded.length > MAX_WORKBOOK_EVAL_STEPS) {
        return [{ error: "#VALUE!", detail: "Workbook evaluation budget exceeded." }];
      }
      return expanded.map((c) => evalCell(c.sheet, c.addr, stack));
    }
    return [evalExpr(arg, sheetName, stack, "", depth + 1)];
  };

  const evalFunction = (
    fnNameRaw: string,
    argsRaw: string[],
    sheetName: string,
    stack: string[],
    depth: number,
  ): CellStoredValue | { error: ExcelErrorValue; detail?: string } => {
    if (depth > MAX_EXPR_DEPTH) {
      return { error: "#VALUE!", detail: `Expression nesting depth exceeded maximum (${MAX_EXPR_DEPTH}).` };
    }
    const fn = fnNameRaw.toUpperCase();
    if (!SUPPORTED_FUNCTIONS.has(fn)) {
      return { error: "#NAME?", detail: `Unsupported function: ${fn}` };
    }

    if (fn === "IFERROR") {
      const first = evalExpr(argsRaw[0] ?? "", sheetName, stack, "", depth + 1);
      if (isExcelError(first)) {
        if (first.error === "#CYCLE!") return first;
        return argsRaw[1] ? evalExpr(argsRaw[1], sheetName, stack, "", depth + 1) : "";
      }
      return first;
    }

    if (fn === "IF") {
      const cond = evalExpr(argsRaw[0] ?? "", sheetName, stack, "", depth + 1);
      if (isExcelError(cond)) return cond;
      const truthy = Boolean(cond);
      const branch = truthy ? argsRaw[1] : argsRaw[2];
      return branch !== undefined ? evalExpr(branch, sheetName, stack, "", depth + 1) : truthy;
    }

    if (fn === "SUM" || fn === "AVERAGE" || fn === "MIN" || fn === "MAX" || fn === "COUNT" || fn === "COUNTA") {
      const values = argsRaw.flatMap((a) => resolveRangeValues(a, sheetName, stack, depth));
      for (const v of values) if (isExcelError(v)) return v;
      if (fn === "COUNTA") {
        return values.filter((v) => v !== null && v !== "").length;
      }
      const nums = values.filter((v): v is number => typeof v === "number");
      if (fn === "COUNT") return nums.length;
      if (fn === "SUM") return nums.reduce((acc, n) => acc + n, 0);
      if (fn === "AVERAGE") return nums.length === 0 ? { error: "#DIV/0!" } : nums.reduce((a, b) => a + b, 0) / nums.length;
      if (fn === "MIN") return nums.length === 0 ? 0 : Math.min(...nums);
      if (fn === "MAX") return nums.length === 0 ? 0 : Math.max(...nums);
    }

    if (fn === "AND" || fn === "OR") {
      const vals = argsRaw.flatMap((a) => resolveRangeValues(a, sheetName, stack, depth));
      for (const v of vals) if (isExcelError(v)) return v;
      const bools = vals.filter((v) => v !== null).map((v) => Boolean(v));
      return fn === "AND" ? bools.every(Boolean) : bools.some(Boolean);
    }

    if (fn === "NOT") {
      const val = evalExpr(argsRaw[0] ?? "", sheetName, stack, "", depth + 1);
      if (isExcelError(val)) return val;
      return !Boolean(val);
    }

    if (fn === "COUNTIF" || fn === "SUMIF") {
      const rangeCells = expandRange(argsRaw[0] ?? "", sheetName);
      if (!rangeCells) return { error: "#VALUE!" };
      const critExpr = (argsRaw[1] ?? "").trim();
      let criteriaStr = "";
      let unquote = true;
      if (critExpr) {
        if (/^(<=|>=|<>|<|>)/.test(critExpr)) {
          criteriaStr = critExpr;
        } else {
          const critVal = evalExpr(critExpr, sheetName, stack, "", depth + 1);
          if (isExcelError(critVal)) return critVal;
          criteriaStr = critVal === null ? "" : String(critVal);
          unquote = false;
        }
      }
      const sumCells = fn === "SUMIF" && argsRaw[2] ? expandRange(argsRaw[2], sheetName) : rangeCells;
      if (!sumCells) return { error: "#VALUE!" };
      let total = 0;
      let count = 0;
      for (let i = 0; i < rangeCells.length; i++) {
        if (evalSteps >= MAX_WORKBOOK_EVAL_STEPS) {
          return { error: "#VALUE!", detail: "Workbook evaluation budget exceeded." };
        }
        const testVal = evalCell(rangeCells[i]!.sheet, rangeCells[i]!.addr, stack);
        if (evaluateCriteria(testVal, criteriaStr, unquote)) {
          count++;
          if (fn === "SUMIF") {
            const targetCell = sumCells[i];
            if (targetCell) {
              const targetVal = evalCell(targetCell.sheet, targetCell.addr, stack);
              if (isExcelError(targetVal)) return targetVal;
              if (typeof targetVal === "number") total += targetVal;
            }
          }
        }
      }
      return fn === "COUNTIF" ? count : total;
    }

    if (fn === "VLOOKUP") {
      const lookupKey = evalExpr(argsRaw[0] ?? "", sheetName, stack, "", depth + 1);
      if (isExcelError(lookupKey)) return lookupKey;
      const tableRef = argsRaw[1] ?? "";
      const parts = tableRef.split(":");
      if (parts.length !== 2) return { error: "#VALUE!" };
      const start = parseCellRef(parts[0]!.trim());
      const end = parseCellRef(parts[1]!.trim());
      if (!start || !end) return { error: "#REF!" };
      const r1 = Math.min(start.row, end.row);
      const r2 = Math.max(start.row, end.row);
      const c1 = Math.min(start.col, end.col);
      const c2 = Math.max(start.col, end.col);
      const colIdxVal = evalExpr(argsRaw[2] ?? "1", sheetName, stack, "", depth + 1);
      if (isExcelError(colIdxVal)) return colIdxVal;
      const colIdx = Number(colIdxVal);
      if (!Number.isInteger(colIdx) || colIdx < 1) return { error: "#VALUE!" };
      const targetSheet = start.sheet ?? end.sheet ?? sheetName;
      if (!sheetMap.has(targetSheet)) return { error: "#REF!" };
      const targetCol = c1 + colIdx - 1;
      if (targetCol > c2) return { error: "#REF!" };

      let approximate = true;
      if (argsRaw[3] !== undefined && argsRaw[3].trim() !== "") {
        const rangeLookupVal = evalExpr(argsRaw[3], sheetName, stack, "", depth + 1);
        if (isExcelError(rangeLookupVal)) return rangeLookupVal;
        if (
          rangeLookupVal === false ||
          rangeLookupVal === 0 ||
          (typeof rangeLookupVal === "string" && rangeLookupVal.trim().toUpperCase() === "FALSE")
        ) {
          approximate = false;
        }
      }

      // Sparse index lookup avoids billion-row CPU hangs on ranges like A1:B999999999 (F-20)
      const colEntries = getColumnEntries(targetSheet, c1);
      if (!approximate) {
        for (const entry of colEntries) {
          if (entry.row < r1 || entry.row > r2) continue;
          const candidate = evalCell(targetSheet, entry.addr, stack);
          if (isExcelError(candidate)) return candidate;
          if (
            candidate === lookupKey ||
            (typeof candidate === "string" &&
              typeof lookupKey === "string" &&
              candidate.toLowerCase() === lookupKey.toLowerCase())
          ) {
            return evalCell(targetSheet, formatCellAddr(targetCol, entry.row), stack);
          }
        }
        return { error: "#N/A" };
      }

      let bestMatchRow: number | null = null;
      for (const entry of colEntries) {
        if (entry.row < r1 || entry.row > r2) continue;
        const candidate = evalCell(targetSheet, entry.addr, stack);
        if (isExcelError(candidate)) return candidate;
        if (candidate === null) continue;
        if (typeof lookupKey === "number" && typeof candidate === "number") {
          if (candidate <= lookupKey) {
            bestMatchRow = entry.row;
          } else {
            break;
          }
        } else if (typeof lookupKey === "string" && typeof candidate === "string") {
          const cmp = candidate.toLowerCase().localeCompare(lookupKey.toLowerCase());
          if (cmp <= 0) {
            bestMatchRow = entry.row;
          } else {
            break;
          }
        } else if (candidate === lookupKey) {
          bestMatchRow = entry.row;
        }
      }
      if (bestMatchRow !== null) {
        return evalCell(targetSheet, formatCellAddr(targetCol, bestMatchRow), stack);
      }
      return { error: "#N/A" };
    }

    if (fn === "ROUND" || fn === "ABS") {
      const n = toNumber(evalExpr(argsRaw[0] ?? "", sheetName, stack, "", depth + 1));
      if (typeof n !== "number") return n;
      if (fn === "ABS") return Math.abs(n);
      const digitsVal = toNumber(evalExpr(argsRaw[1] ?? "0", sheetName, stack, "", depth + 1));
      if (typeof digitsVal !== "number") return digitsVal;
      return roundNumberHalfUp(n, digitsVal);
    }

    if (fn === "LEN" || fn === "TRIM") {
      const v = evalExpr(argsRaw[0] ?? "", sheetName, stack, "", depth + 1);
      if (isExcelError(v)) return v;
      const s = String(v ?? "");
      return fn === "LEN" ? s.length : s.trim();
    }

    if (fn === "CONCAT") {
      const vals = argsRaw.flatMap((a) => resolveRangeValues(a, sheetName, stack, depth));
      for (const v of vals) if (isExcelError(v)) return v;
      return vals.map((v) => String(v ?? "")).join("");
    }

    return { error: "#NAME?" };
  };

  const evalExpr = (
    exprRaw: string,
    sheetName: string,
    stack: string[],
    _originKey: string,
    depth = 0,
  ): CellStoredValue | { error: ExcelErrorValue; detail?: string } => {
    if (depth > MAX_EXPR_DEPTH) {
      return { error: "#VALUE!", detail: `Expression nesting depth exceeded maximum (${MAX_EXPR_DEPTH}).` };
    }
    if (++evalSteps > MAX_WORKBOOK_EVAL_STEPS) {
      return { error: "#VALUE!", detail: "Workbook evaluation budget exceeded." };
    }
    const expr = exprRaw.trim();
    if (!expr) return null;

    if (/^"(?:[^"]|"")*"$/.test(expr)) {
      return expr.slice(1, -1).replace(/""/g, '"');
    }
    if (/^(TRUE|FALSE)$/i.test(expr)) {
      return expr.toUpperCase() === "TRUE";
    }
    if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(expr)) {
      return Number(expr);
    }

    // Parenthesized whole expression (quote-aware)
    if (expr.startsWith("(") && expr.endsWith(")")) {
      let pDepth = 0;
      let inQuote = false;
      let balancedOuter = true;
      for (let i = 0; i < expr.length - 1; i++) {
        const ch = expr[i]!;
        if (ch === '"' && expr[i - 1] !== "\\") {
          inQuote = !inQuote;
          continue;
        }
        if (inQuote) continue;
        if (ch === "(") pDepth++;
        else if (ch === ")") pDepth--;
        if (pDepth === 0) {
          balancedOuter = false;
          break;
        }
      }
      if (balancedOuter) return evalExpr(expr.slice(1, -1), sheetName, stack, _originKey, depth + 1);
    }

    // Comparison operators at top level (<=, >=, <>, <, >, =)
    const cmpSplit = findTopLevelBinaryOp(expr, ["<=", ">=", "<>", "=", "<", ">"]);
    if (cmpSplit) {
      const left = evalExpr(cmpSplit.left, sheetName, stack, _originKey, depth + 1);
      const right = evalExpr(cmpSplit.right, sheetName, stack, _originKey, depth + 1);
      if (isExcelError(left)) return left;
      if (isExcelError(right)) return right;
      switch (cmpSplit.op) {
        case "=":
          return left === right;
        case "<>":
          return left !== right;
        case "<":
          return Number(left) < Number(right);
        case "<=":
          return Number(left) <= Number(right);
        case ">":
          return Number(left) > Number(right);
        case ">=":
          return Number(left) >= Number(right);
      }
    }

    // Addition / Subtraction at top level
    const addSplit = findTopLevelBinaryOp(expr, ["+", "-"]);
    if (addSplit) {
      const left = toNumber(evalExpr(addSplit.left, sheetName, stack, _originKey, depth + 1));
      const right = toNumber(evalExpr(addSplit.right, sheetName, stack, _originKey, depth + 1));
      if (typeof left !== "number") return left;
      if (typeof right !== "number") return right;
      const result = addSplit.op === "+" ? left + right : left - right;
      return Number.isFinite(result) ? result : { error: "#NUM!" };
    }

    // Multiplication / Division at top level
    const mulSplit = findTopLevelBinaryOp(expr, ["*", "/"]);
    if (mulSplit) {
      const left = toNumber(evalExpr(mulSplit.left, sheetName, stack, _originKey, depth + 1));
      const right = toNumber(evalExpr(mulSplit.right, sheetName, stack, _originKey, depth + 1));
      if (typeof left !== "number") return left;
      if (typeof right !== "number") return right;
      if (mulSplit.op === "/") {
        if (right === 0) return { error: "#DIV/0!" };
        const quot = left / right;
        return Number.isFinite(quot) ? quot : { error: "#NUM!" };
      }
      const prod = left * right;
      return Number.isFinite(prod) ? prod : { error: "#NUM!" };
    }

    // Exponentiation
    const powSplit = findTopLevelBinaryOp(expr, ["^"]);
    if (powSplit) {
      const left = toNumber(evalExpr(powSplit.left, sheetName, stack, _originKey, depth + 1));
      const right = toNumber(evalExpr(powSplit.right, sheetName, stack, _originKey, depth + 1));
      if (typeof left !== "number") return left;
      if (typeof right !== "number") return right;
      const pow = left ** right;
      return Number.isFinite(pow) ? pow : { error: "#NUM!" };
    }

    // Unary +/- applied to cell references, functions, or parenthesized sub-expressions (F-20)
    if (expr.startsWith("-") || expr.startsWith("+")) {
      const operand = toNumber(evalExpr(expr.slice(1), sheetName, stack, _originKey, depth + 1));
      if (typeof operand !== "number") return operand;
      return expr.startsWith("-") ? (operand === 0 ? 0 : -operand) : operand;
    }

    // Function call
    const fnMatch = expr.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/);
    if (fnMatch) {
      const args = fnMatch[2]!.trim() ? splitTopLevelArgs(fnMatch[2]!) : [];
      return evalFunction(fnMatch[1]!, args, sheetName, stack, depth + 1);
    }

    // Cell reference (same sheet or Sheet!A1)
    const ref = parseCellRef(expr);
    if (ref) {
      return evalCell(ref.sheet ?? sheetName, formatCellAddr(ref.col, ref.row), stack);
    }

    return { error: "#NAME?", detail: `Unrecognized token: ${expr}` };
  };

  for (const sheet of next.sheets) {
    for (const addr of Object.keys(sheet.cells)) {
      evalCell(sheet.name, addr, []);
    }
  }

  return { workbook: next, cyclesDetected, unsupportedCells };
}

function findTopLevelBinaryOp(
  expr: string,
  ops: string[],
): { left: string; op: string; right: string } | null {
  let depth = 0;
  let inQuote = false;
  // Scan right-to-left for left-associative evaluation
  for (let i = expr.length - 1; i >= 0; i--) {
    const ch = expr[i]!;
    if (ch === '"' && expr[i - 1] !== "\\") {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === ")") depth++;
    else if (ch === "(") depth--;
    if (depth !== 0) continue;

    for (const op of ops) {
      const start = i - op.length + 1;
      if (start <= 0) continue; // ignore unary leading +/-
      if (expr.slice(start, i + 1) === op) {
        const prev = expr[start - 1] ?? "";
        if (op === "+" || op === "-") {
          if ((prev === "e" || prev === "E") && start >= 2 && /\d/.test(expr[start - 2] ?? "")) {
            continue;
          }
          let pIdx = start - 1;
          while (pIdx >= 0 && expr[pIdx] === " ") pIdx--;
          const prevNonSpace = pIdx >= 0 ? expr[pIdx]! : "";
          if (["+", "-", "*", "/", "^", "(", "=", "<", ">"].includes(prevNonSpace)) {
            continue;
          }
        }
        return {
          left: expr.slice(0, start),
          op,
          right: expr.slice(i + 1),
        };
      }
    }
  }
  return null;
}
