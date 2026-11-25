import { randomUUID } from "node:crypto";
import type {
  SpreadsheetOperationProposal,
  SpreadsheetWorkbook,
} from "@ai-office-suite/shared-contracts";
import { scanForPromptInjection } from "@ai-office-suite/validation";
import {
  colIndexToLetters,
  parseCellRef,
  recalculateWorkbook,
  shiftFormulaReferences,
} from "./formulaEngine.ts";

export class SpreadsheetAiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "SpreadsheetAiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function planSpreadsheetCommand(params: {
  workbook: SpreadsheetWorkbook;
  sheetName: string;
  targetRange: string;
  command: string;
  inputLanguage: "en" | "km";
  source: "typed_ai" | "voice_command";
}): SpreadsheetOperationProposal {
  const { workbook, sheetName, targetRange, command, inputLanguage, source } = params;
  const sheet = workbook.sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new SpreadsheetAiError(404, "SHEET_NOT_FOUND", `Worksheet '${sheetName}' does not exist.`);
  }

  // Scan both command and target cells for prompt-injection (SHT-T10)
  const cellTexts = Object.values(sheet.cells)
    .map((c) => (typeof c.value === "string" ? c.value : ""))
    .join(" ");
  const safety = scanForPromptInjection(command, cellTexts);
  if (!safety.safe) {
    throw new SpreadsheetAiError(
      400,
      "PROMPT_INJECTION_BLOCKED",
      `Spreadsheet AI command blocked: ${safety.reasons[0]}`,
    );
  }

  const lower = command.toLowerCase();

  // Currency conversion requires explicit rate + date; format-only is allowed (Section 10)
  if (
    (/\bconvert\b/i.test(lower) && /\b(usd|khr)\b/i.test(lower)) ||
    command.includes("បំប្លែង")
  ) {
    return {
      operationId: `sop_${randomUUID()}`,
      workbookId: workbook.workbookId,
      expectedRevision: workbook.revision,
      sheetName,
      targetRange,
      action: "format_currency",
      requiresApproval: true,
      blockedReason:
        "EXCHANGE_RATE_REQUIRED: Converting currency values requires an explicit exchange rate, source, and effective date. Formatting display currency does not convert values.",
      inputLanguage,
      source,
      originalCommand: command,
      explanation: "Blocked ambiguous currency conversion until exchange rate and effective date are specified.",
    };
  }

  if (
    (/\bformat\b/i.test(lower) && /\busd\b/i.test(lower)) ||
    command.includes("ប្តូរទម្រង់លេខទៅជាប្រាក់ដុល្លារ")
  ) {
    return {
      operationId: `sop_${randomUUID()}`,
      workbookId: workbook.workbookId,
      expectedRevision: workbook.revision,
      sheetName,
      targetRange,
      action: "format_currency",
      currencyDisplayOnly: "USD",
      requiresApproval: true,
      inputLanguage,
      source,
      originalCommand: command,
      explanation: "Format cell display as USD ($#,##0.00) without modifying underlying numerical values.",
    };
  }

  if (
    (/\bprofit\b/i.test(lower) && (/\bsubtract/i.test(lower) || /\bcalculate\b/i.test(lower))) ||
    command.includes("គណនាប្រាក់ចំណេញ")
  ) {
    const startAddr = targetRange.split(":")[0]?.trim() || "D2";
    const parsedStart = parseCellRef(startAddr);
    const row = parsedStart?.row ?? 2;
    const revCol = colIndexToLetters(Math.max(1, (parsedStart?.col ?? 4) - 2));
    const costCol = colIndexToLetters(Math.max(1, (parsedStart?.col ?? 4) - 1));
    const formula = `=${revCol}${row}-${costCol}${row}`;

    return {
      operationId: `sop_${randomUUID()}`,
      workbookId: workbook.workbookId,
      expectedRevision: workbook.revision,
      sheetName,
      targetRange,
      action: "set_range_formula",
      formula,
      fillMode: "adjust_relative_references",
      requiresApproval: true,
      inputLanguage,
      source,
      originalCommand: command,
      explanation: `Insert editable formula ${formula} across ${targetRange} with relative row adjustment (calculated by deterministic engine, never hardcoded).`,
    };
  }

  if (
    /\bsum\b/i.test(lower) ||
    command.includes("ផលបូក")
  ) {
    const formula = `=SUM(${targetRange})`;
    return {
      operationId: `sop_${randomUUID()}`,
      workbookId: workbook.workbookId,
      expectedRevision: workbook.revision,
      sheetName,
      targetRange,
      action: "set_range_formula",
      formula,
      fillMode: "fixed",
      requiresApproval: true,
      inputLanguage,
      source,
      originalCommand: command,
      explanation: `Generate editable SUM formula ${formula}.`,
    };
  }

  throw new SpreadsheetAiError(
    400,
    "UNSUPPORTED_SPREADSHEET_COMMAND",
    "Spreadsheet command did not match a verified SS-00 feasibility operation.",
  );
}

export function applySpreadsheetProposal(
  workbook: SpreadsheetWorkbook,
  proposal: SpreadsheetOperationProposal,
  approved: boolean,
): SpreadsheetWorkbook {
  if (proposal.blockedReason) {
    throw new SpreadsheetAiError(400, "OPERATION_BLOCKED", proposal.blockedReason);
  }
  if (proposal.requiresApproval && !approved) {
    throw new SpreadsheetAiError(400, "APPROVAL_REQUIRED", "Approval required before mutating workbook.");
  }
  if (workbook.revision !== proposal.expectedRevision) {
    throw new SpreadsheetAiError(409, "REVISION_CONFLICT", "Workbook revision conflict.");
  }

  const next = structuredClone(workbook);
  next.revision += 1;
  const sheet = next.sheets.find((s) => s.name === proposal.sheetName);
  if (!sheet) {
    throw new SpreadsheetAiError(404, "SHEET_NOT_FOUND", `Worksheet '${proposal.sheetName}' not found.`);
  }

  if (proposal.action === "set_range_formula" && proposal.formula) {
    const parts = proposal.targetRange.split(":");
    const start = parseCellRef(parts[0]!.trim());
    const end = parseCellRef((parts[1] ?? parts[0]!).trim());
    if (!start || !end) {
      throw new SpreadsheetAiError(400, "INVALID_RANGE", `Invalid target range '${proposal.targetRange}'.`);
    }

    for (let r = start.row; r <= end.row; r++) {
      for (let c = start.col; c <= end.col; c++) {
        const addr = `${colIndexToLetters(c)}${r}`;
        const existing = sheet.cells[addr];
        if (existing?.protected) {
          throw new SpreadsheetAiError(
            403,
            "PROTECTED_CELL",
            `Cell ${proposal.sheetName}!${addr} is protected and cannot be overwritten by AI.`,
          );
        }
        const shifted =
          proposal.fillMode === "adjust_relative_references"
            ? shiftFormulaReferences(proposal.formula, c - start.col, r - start.row)
            : proposal.formula;
        sheet.cells[addr] = {
          ...(existing ?? { value: null }),
          value: null,
          formula: shifted,
        };
      }
    }
  } else if (proposal.action === "format_currency" && proposal.currencyDisplayOnly) {
    const parts = proposal.targetRange.split(":");
    const start = parseCellRef(parts[0]!.trim());
    const end = parseCellRef((parts[1] ?? parts[0]!).trim());
    if (!start || !end) {
      throw new SpreadsheetAiError(400, "INVALID_RANGE", `Invalid target range '${proposal.targetRange}'.`);
    }
    for (let r = start.row; r <= end.row; r++) {
      for (let c = start.col; c <= end.col; c++) {
        const addr = `${colIndexToLetters(c)}${r}`;
        const existing = sheet.cells[addr];
        if (existing) {
          existing.numberFormat = proposal.currencyDisplayOnly === "USD" ? "$#,##0.00" : "៛#,##0";
          existing.currency = proposal.currencyDisplayOnly;
        }
      }
    }
  }

  return recalculateWorkbook(next).workbook;
}
