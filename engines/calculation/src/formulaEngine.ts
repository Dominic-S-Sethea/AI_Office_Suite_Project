import type {
  CellStoredValue,
  ExcelErrorValue,
  SpreadsheetCellRecord,
  SpreadsheetWorkbook,
} from "@ai-office-suite/shared-contracts";

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
  return formula.replace(
    /('[^']+'!|[A-Za-z0-9_]+!)?(\$?)([A-Z]{1,3})(\$?)(\d+)/g,
    (_full, sheetPrefix: string | undefined, absCol: string, colStr: string, absRow: string, rowStr: string) => {
      const nextCol = absCol === "$" ? colLettersToIndex(colStr) : Math.max(1, colLettersToIndex(colStr) + deltaCol);
      const nextRow = absRow === "$" ? Number(rowStr) : Math.max(1, Number(rowStr) + deltaRow);
      return `${sheetPrefix ?? ""}${absCol}${colIndexToLetters(nextCol)}${absRow}${nextRow}`;
    },
  );
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

function evaluateCriteria(val: CellStoredValue | { error: ExcelErrorValue }, criteriaRaw: string): boolean {
  if (isExcelError(val)) return false;
  const cleaned = criteriaRaw.replace(/^"|"$/g, "");
  const cmp = cleaned.match(/^(<=|>=|<>|<|>|=)(.*)$/);
  if (cmp) {
    const op = cmp[1]!;
    const rhsRaw = cmp[2]!.trim();
    const rhsNum = Number(rhsRaw);
    const lhsNum = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(rhsNum) && val !== null && val !== "" && Number.isFinite(lhsNum)) {
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
  const cyclesDetected: string[][] = [];
  const unsupportedCells: Array<{ sheet: string; cell: string; functionName: string }> = [];

  const getCellRecord = (sheetName: string, addr: string): SpreadsheetCellRecord | undefined => {
    return sheetMap.get(sheetName)?.cells[addr.toUpperCase()];
  };

  const evalCell = (
    sheetName: string,
    addr: string,
    stack: string[],
  ): CellStoredValue | { error: ExcelErrorValue; detail?: string } => {
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
    const result = evalExpr(record.formula.slice(1).trim(), sheetName, nextStack, key);
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
  ): Array<CellStoredValue | { error: ExcelErrorValue; detail?: string }> => {
    if (arg.includes(":")) {
      const expanded = expandRange(arg, sheetName);
      if (!expanded) return [{ error: "#REF!" }];
      return expanded.map((c) => evalCell(c.sheet, c.addr, stack));
    }
    return [evalExpr(arg, sheetName, stack, "")];
  };

  const evalFunction = (
    fnNameRaw: string,
    argsRaw: string[],
    sheetName: string,
    stack: string[],
  ): CellStoredValue | { error: ExcelErrorValue; detail?: string } => {
    const fn = fnNameRaw.toUpperCase();
    if (!SUPPORTED_FUNCTIONS.has(fn)) {
      return { error: "#NAME?", detail: `Unsupported function: ${fn}` };
    }

    if (fn === "IFERROR") {
      const first = evalExpr(argsRaw[0] ?? "", sheetName, stack, "");
      if (isExcelError(first)) {
        if (first.error === "#CYCLE!") return first;
        return argsRaw[1] ? evalExpr(argsRaw[1], sheetName, stack, "") : "";
      }
      return first;
    }

    if (fn === "IF") {
      const cond = evalExpr(argsRaw[0] ?? "", sheetName, stack, "");
      if (isExcelError(cond)) return cond;
      const truthy = Boolean(cond);
      const branch = truthy ? argsRaw[1] : argsRaw[2];
      return branch !== undefined ? evalExpr(branch, sheetName, stack, "") : truthy;
    }

    if (fn === "SUM" || fn === "AVERAGE" || fn === "MIN" || fn === "MAX" || fn === "COUNT" || fn === "COUNTA") {
      const values = argsRaw.flatMap((a) => resolveRangeValues(a, sheetName, stack));
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
      const vals = argsRaw.flatMap((a) => resolveRangeValues(a, sheetName, stack));
      for (const v of vals) if (isExcelError(v)) return v;
      const bools = vals.filter((v) => v !== null).map((v) => Boolean(v));
      return fn === "AND" ? bools.every(Boolean) : bools.some(Boolean);
    }

    if (fn === "NOT") {
      const val = evalExpr(argsRaw[0] ?? "", sheetName, stack, "");
      if (isExcelError(val)) return val;
      return !Boolean(val);
    }

    if (fn === "COUNTIF" || fn === "SUMIF") {
      const rangeCells = expandRange(argsRaw[0] ?? "", sheetName);
      if (!rangeCells) return { error: "#VALUE!" };
      const criteria = argsRaw[1] ?? "";
      const sumCells = fn === "SUMIF" && argsRaw[2] ? expandRange(argsRaw[2], sheetName) : rangeCells;
      if (!sumCells) return { error: "#VALUE!" };
      let total = 0;
      let count = 0;
      for (let i = 0; i < rangeCells.length; i++) {
        const testVal = evalCell(rangeCells[i]!.sheet, rangeCells[i]!.addr, stack);
        if (evaluateCriteria(testVal, criteria)) {
          count++;
          if (fn === "SUMIF") {
            const targetCell = sumCells[i];
            if (targetCell) {
              const targetVal = evalCell(targetCell.sheet, targetCell.addr, stack);
              if (typeof targetVal === "number") total += targetVal;
            }
          }
        }
      }
      return fn === "COUNTIF" ? count : total;
    }

    if (fn === "VLOOKUP") {
      const lookupKey = evalExpr(argsRaw[0] ?? "", sheetName, stack, "");
      if (isExcelError(lookupKey)) return lookupKey;
      const tableRef = argsRaw[1] ?? "";
      const parts = tableRef.split(":");
      if (parts.length !== 2) return { error: "#VALUE!" };
      const start = parseCellRef(parts[0]!.trim());
      const end = parseCellRef(parts[1]!.trim());
      if (!start || !end) return { error: "#REF!" };
      const colIdxVal = evalExpr(argsRaw[2] ?? "1", sheetName, stack, "");
      if (isExcelError(colIdxVal)) return colIdxVal;
      const colIdx = Number(colIdxVal);
      if (!Number.isInteger(colIdx) || colIdx < 1) return { error: "#VALUE!" };
      const targetSheet = start.sheet ?? sheetName;
      if (!sheetMap.has(targetSheet)) return { error: "#REF!" };
      const targetCol = start.col + colIdx - 1;
      if (targetCol > end.col) return { error: "#REF!" };
      for (let r = start.row; r <= end.row; r++) {
        const candidate = evalCell(targetSheet, formatCellAddr(start.col, r), stack);
        if (candidate === lookupKey) {
          return evalCell(targetSheet, formatCellAddr(targetCol, r), stack);
        }
      }
      return { error: "#N/A" };
    }

    if (fn === "ROUND" || fn === "ABS") {
      const n = toNumber(evalExpr(argsRaw[0] ?? "", sheetName, stack, ""));
      if (typeof n !== "number") return n;
      if (fn === "ABS") return Math.abs(n);
      const digitsVal = toNumber(evalExpr(argsRaw[1] ?? "0", sheetName, stack, ""));
      if (typeof digitsVal !== "number") return digitsVal;
      const digits = Math.trunc(digitsVal);
      if (digits === 0) {
        return Math.sign(n) * Math.round(Math.abs(n));
      }
      const absN = Math.abs(n);
      const shifted = Number(`${absN}e${digits}`);
      const roundedAbs = Number(`${Math.round(shifted)}e${-digits}`);
      return Math.sign(n) * roundedAbs;
    }

    if (fn === "LEN" || fn === "TRIM") {
      const v = evalExpr(argsRaw[0] ?? "", sheetName, stack, "");
      if (isExcelError(v)) return v;
      const s = String(v ?? "");
      return fn === "LEN" ? s.length : s.trim();
    }

    if (fn === "CONCAT") {
      const vals = argsRaw.flatMap((a) => resolveRangeValues(a, sheetName, stack));
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
  ): CellStoredValue | { error: ExcelErrorValue; detail?: string } => {
    const expr = exprRaw.trim();
    if (!expr) return null;

    if (expr.startsWith('"') && expr.endsWith('"') && !expr.slice(1, -1).includes('"')) {
      return expr.slice(1, -1);
    }
    if (/^(TRUE|FALSE)$/i.test(expr)) {
      return expr.toUpperCase() === "TRUE";
    }
    if (/^-?\d+(\.\d+)?$/.test(expr)) {
      return Number(expr);
    }

    // Parenthesized whole expression (quote-aware)
    if (expr.startsWith("(") && expr.endsWith(")")) {
      let depth = 0;
      let inQuote = false;
      let balancedOuter = true;
      for (let i = 0; i < expr.length - 1; i++) {
        const ch = expr[i]!;
        if (ch === '"' && expr[i - 1] !== "\\") {
          inQuote = !inQuote;
          continue;
        }
        if (inQuote) continue;
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth === 0) {
          balancedOuter = false;
          break;
        }
      }
      if (balancedOuter) return evalExpr(expr.slice(1, -1), sheetName, stack, _originKey);
    }

    // Comparison operators at top level (<=, >=, <>, <, >, =)
    const cmpSplit = findTopLevelBinaryOp(expr, ["<=", ">=", "<>", "=", "<", ">"]);
    if (cmpSplit) {
      const left = evalExpr(cmpSplit.left, sheetName, stack, _originKey);
      const right = evalExpr(cmpSplit.right, sheetName, stack, _originKey);
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
      const left = toNumber(evalExpr(addSplit.left, sheetName, stack, _originKey));
      const right = toNumber(evalExpr(addSplit.right, sheetName, stack, _originKey));
      if (typeof left !== "number") return left;
      if (typeof right !== "number") return right;
      return addSplit.op === "+" ? left + right : left - right;
    }

    // Multiplication / Division at top level
    const mulSplit = findTopLevelBinaryOp(expr, ["*", "/"]);
    if (mulSplit) {
      const left = toNumber(evalExpr(mulSplit.left, sheetName, stack, _originKey));
      const right = toNumber(evalExpr(mulSplit.right, sheetName, stack, _originKey));
      if (typeof left !== "number") return left;
      if (typeof right !== "number") return right;
      if (mulSplit.op === "/") {
        return right === 0 ? { error: "#DIV/0!" } : left / right;
      }
      return left * right;
    }

    // Exponentiation
    const powSplit = findTopLevelBinaryOp(expr, ["^"]);
    if (powSplit) {
      const left = toNumber(evalExpr(powSplit.left, sheetName, stack, _originKey));
      const right = toNumber(evalExpr(powSplit.right, sheetName, stack, _originKey));
      if (typeof left !== "number") return left;
      if (typeof right !== "number") return right;
      return left ** right;
    }

    // Function call
    const fnMatch = expr.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/);
    if (fnMatch) {
      const args = fnMatch[2]!.trim() ? splitTopLevelArgs(fnMatch[2]!) : [];
      return evalFunction(fnMatch[1]!, args, sheetName, stack);
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
        if ((op === "+" || op === "-") && ["+", "-", "*", "/", "^", "(", "=", "<", ">"].includes(prev)) {
          continue;
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
