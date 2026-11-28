import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ActorContext,
  DocumentOperationProposal,
  DocumentOperationType,
  DocumentSelectionRef,
  OperationRiskLevel,
  OperationSource,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";
import { assertCanPerform } from "@ai-office-suite/authorization";
import type { AuditStore } from "@ai-office-suite/audit";
import { scanForPromptInjection } from "@ai-office-suite/validation";
import {
  DocumentEngineError,
  getBlockPlainText,
  hashTextSelection,
  khmerNumeralsToArabic,
  normalizeDocumentText,
  previewDocumentOperation,
  snapRangeToGraphemeBoundaries,
} from "@ai-office-suite/document-engine";

const EPHEMERAL_PROPOSAL_HMAC_KEY = randomBytes(32).toString("hex");
const PLACEHOLDER_SECRET_RE = /(changeme|placeholder|super_secret|dev_key|example_secret|default_secret|replace-with)/i;
export const DEFAULT_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const MAX_PROPOSAL_CLOCK_SKEW_MS = 60_000;

function resolveProposalHmacKey(): string {
  const configured =
    process.env.AI_PROPOSAL_SIGNING_SECRET?.trim() || process.env.PROPOSAL_SIGNING_KEY?.trim();
  const jwtSecret = process.env.JWT_SECRET?.trim();
  if (process.env.NODE_ENV === "production") {
    if (!configured || configured.length < 32 || PLACEHOLDER_SECRET_RE.test(configured)) {
      throw new Error(
        "AI_PROPOSAL_SIGNING_SECRET must be set to a strong non-placeholder secret (>= 32 chars) in production.",
      );
    }
    if (jwtSecret && configured === jwtSecret) {
      throw new Error("AI_PROPOSAL_SIGNING_SECRET must be distinct from JWT_SECRET in production.");
    }
    return configured;
  }
  if (configured && configured.length >= 32) {
    return configured;
  }
  if (jwtSecret && jwtSecret.length >= 32) {
    return jwtSecret;
  }
  return EPHEMERAL_PROPOSAL_HMAC_KEY;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        sorted[k] = canonicalizeJson(v);
      }
    }
    return sorted;
  }
  return value;
}

function canonicalProposalSignPayload(actor: ActorContext, proposal: DocumentOperationProposal): string {
  return JSON.stringify(
    canonicalizeJson({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      operationId: proposal.operationId,
      documentId: proposal.documentId,
      expectedRevision: proposal.expectedRevision,
      selection: proposal.selection ?? null,
      action: proposal.action,
      params: proposal.params,
      requestedBy: proposal.requestedBy,
      riskLevel: proposal.riskLevel,
      requiresApproval: proposal.requiresApproval,
      source: proposal.source,
      inputLanguage: proposal.inputLanguage,
      outputLanguage: proposal.outputLanguage,
      originalCommand: proposal.originalCommand,
      previewDiff: proposal.previewDiff ?? null,
      createdAt: proposal.createdAt,
    }),
  );
}

export function signDocumentProposal(actor: ActorContext, proposal: DocumentOperationProposal): string {
  return createHmac("sha256", resolveProposalHmacKey())
    .update(canonicalProposalSignPayload(actor, proposal))
    .digest("hex");
}

export function verifyDocumentProposalSignature(
  actor: ActorContext,
  proposal: DocumentOperationProposal,
  options: { maxAgeMs?: number; nowMs?: number } = {},
): boolean {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_PROPOSAL_TTL_MS;
  const nowMs = options.nowMs ?? Date.now();
  const createdMs = Date.parse(proposal.createdAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(createdMs) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0
  ) {
    return false;
  }
  if (nowMs - createdMs > maxAgeMs || createdMs > nowMs + MAX_PROPOSAL_CLOCK_SKEW_MS) {
    return false;
  }
  const provided = proposal.proposalSignature;
  if (!provided || !/^[0-9a-f]{64}$/i.test(provided)) {
    return false;
  }
  const expected = signDocumentProposal(actor, proposal);
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AiPlanningError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AiPlanningError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface PlanCommandInput {
  command: string;
  expectedRevision: number;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km" | "match";
  source: OperationSource;
  selection?: DocumentSelectionRef;
}

const DEMO_TRANSLATION_MAP: ReadonlyArray<{ en: string; km: string }> = [
  {
    en: "The administration department has completed its operational activities for the reporting period.",
    km: "នាយកដ្ឋានរដ្ឋបាលបានបញ្ចប់សកម្មភាពប្រតិបត្តិការរបស់ខ្លួនសម្រាប់រយៈពេលរាយការណ៍នេះរួចរាល់ហើយ។",
  },
  {
    en: "The administration and finance departments completed operational reconciliation for November 2026 across all Phnom Penh and regional branches.",
    km: "នាយកដ្ឋានរដ្ឋបាល និងហិរញ្ញវត្ថុបានបញ្ចប់ការផ្ទៀងផ្ទាត់ប្រតិបត្តិការប្រចាំខែវិច្ឆិកា ឆ្នាំ២០២៦ នៅទូទាំងសាខារាជធានីភ្នំពេញ និងតាមខេត្តរួចរាល់ហើយ។",
  },
  {
    en: "Monthly Management Report",
    km: "របាយការណ៍គ្រប់គ្រងប្រចាំខែ",
  },
];

function extractQuotedText(command: string): string | null {
  const match = command.match(/["“«]([\s\S]+?)["”»]/);
  return match?.[1]?.trim() || null;
}

export function isUndoCommandIntent(command: string): boolean {
  const normalized = khmerNumeralsToArabic(normalizeDocumentText(command).trim());
  const lower = normalized.toLowerCase();
  return (
    /^(undo|revert)\b/i.test(lower) ||
    /(មិនធ្វើវិញ|ត្រឡប់ក្រោយ|មិនយកការកែប្រែ)/.test(normalized)
  );
}

function parseBilingualCommand(
  command: string,
  selectedText: string,
  outputLanguage: "en" | "km" | "match",
): {
  action: DocumentOperationType;
  params: Record<string, unknown>;
  riskLevel: OperationRiskLevel;
  explanation: string;
} {
  const normalized = khmerNumeralsToArabic(normalizeDocumentText(command).trim());
  const lower = normalized.toLowerCase();

  // 1. Undo last change (EN / KM)
  if (isUndoCommandIntent(command)) {
    return {
      action: "undo_last",
      params: {},
      riskLevel: "medium",
      explanation: "Revert the document by restoring the previous revision as a new non-destructive revision.",
    };
  }

  // 2. Insert table (EN / KM with Arabic or Khmer numerals, strictly clamped 1..20 x 1..10 — M10)
  const tableMatch = normalized.match(/(\d+)\s*[x×*]\s*(\d+)/i);
  if (
    (/\btable\b/i.test(lower) || normalized.includes("តារាង")) &&
    (/\b(insert|add|create)\b/i.test(lower) || /(បញ្ចូល|បន្ថែម|បង្កើត)/.test(normalized))
  ) {
    const rawRows = tableMatch ? Number(tableMatch[1]) : 3;
    const rawCols = tableMatch ? Number(tableMatch[2]) : 3;
    const rows = Math.max(1, Math.min(20, Number.isFinite(rawRows) ? Math.trunc(rawRows) : 3));
    const cols = Math.max(1, Math.min(10, Number.isFinite(rawCols) ? Math.trunc(rawCols) : 3));
    return {
      action: "insert_table",
      params: { rows, cols },
      riskLevel: "medium",
      explanation: `Insert an editable ${rows}×${cols} corporate table into the document.`,
    };
  }

  // 3. Heading styles (EN / KM)
  if (
    /\bheading\s*([1-3])\b/i.test(lower) ||
    /(?:ចំណងជើងកម្រិត|ចំណងជើង)\s*([1-3])/.test(normalized)
  ) {
    const levelMatch = normalized.match(/([1-3])/);
    const level = Number(levelMatch?.[1] ?? 1);
    return {
      action: "set_heading",
      params: { level },
      riskLevel: "low",
      explanation: `Convert the target block to Heading ${level}.`,
    };
  }
  if (
    /\b(normal\s+paragraph|remove\s+heading)\b/i.test(lower) ||
    /(កថាខណ្ឌធម្មតា|ប្ដូរជាកថាខណ្ឌ)/.test(normalized)
  ) {
    return {
      action: "set_heading",
      params: { level: 0 },
      riskLevel: "low",
      explanation: "Convert the target heading back to a normal paragraph.",
    };
  }

  // 4. Bold formatting (EN / KM)
  if (
    /\b(make\s+bold|apply\s+bold|bold)\b/i.test(lower) ||
    /(ធ្វើឱ្យដិត|អក្សរដិត|ដិត)/.test(normalized)
  ) {
    const unbold = /\b(unbold|remove\s+bold)\b/i.test(lower) || /ដកអក្សរដិត/.test(normalized);
    return {
      action: "toggle_bold",
      params: { bold: !unbold },
      riskLevel: "low",
      explanation: unbold ? "Remove bold formatting from the target block." : "Apply bold formatting to the target block.",
    };
  }

  // 5. Paragraph alignment (EN / KM)
  if (
    /\balign\s*(left|center|right|justify)\b/i.test(lower) ||
    /\bcenter\s*(this|paragraph|heading|text)?\b/i.test(lower) ||
    /តម្រឹម(ឆ្វេង|កណ្តាល|ស្តាំ|ស្មើ)/.test(normalized)
  ) {
    let alignment: "left" | "center" | "right" | "justify" = "left";
    if (/\bcenter\b/i.test(lower) || normalized.includes("កណ្តាល")) alignment = "center";
    else if (/\bright\b/i.test(lower) || normalized.includes("ស្តាំ")) alignment = "right";
    else if (/\bjustify\b/i.test(lower) || normalized.includes("ស្មើ")) alignment = "justify";
    return {
      action: "set_alignment",
      params: { alignment },
      riskLevel: "low",
      explanation: `Set paragraph alignment to '${alignment}'.`,
    };
  }

  // 6. Bilingual translation / replace selection (EN <-> KM prototype)
  if (
    /\btranslate\b/i.test(lower) ||
    normalized.includes("បកប្រែ")
  ) {
    const targetKm =
      outputLanguage === "km" ||
      /\b(to|into)\s+khmer\b/i.test(lower) ||
      normalized.includes("ជាភាសាខ្មែរ");
    const targetEn =
      outputLanguage === "en" ||
      /\b(to|into)\s+english\b/i.test(lower) ||
      normalized.includes("ជាភាសាអង់គ្លេស");

    const trimmedSelection = normalizeDocumentText(selectedText.trim());
    const matchedPair = DEMO_TRANSLATION_MAP.find(
      (p) => p.en === trimmedSelection || p.km === trimmedSelection,
    );
    let translated: string;
    if (matchedPair) {
      translated = targetEn && !targetKm ? matchedPair.en : matchedPair.km;
    } else if (targetEn && !targetKm) {
      translated = `[Prototype EN translation — review before approval]: ${trimmedSelection || "Translated management summary."}`;
    } else {
      translated = `[សេចក្តីប្រែសម្រួលគំរូ — សូមពិនិត្យមុនអនុម័ត]: ${trimmedSelection || "សេចក្តីសង្ខេបរបាយការណ៍គ្រប់គ្រង។"}`;
    }
    return {
      action: "replace_selection",
      params: { replacement: translated },
      riskLevel: "medium",
      explanation: targetEn && !targetKm
        ? "Translate the selected paragraph into English and preserve its corporate meaning."
        : "Translate the selected paragraph into Khmer and preserve its corporate meaning.",
    };
  }

  if (
    /\b(replace|rewrite|change\s+selection)\b/i.test(lower) ||
    /(ជំនួស|ប្ដូរទៅជា|កែសម្រួល)/.test(normalized)
  ) {
    const quoted = extractQuotedText(normalized);
    const replacement =
      quoted ??
      normalized
        .replace(/^(replace(\s+selection)?(\s+with)?|rewrite(\s+as)?|ជំនួសដោយ|ប្ដូរទៅជា)\s*/i, "")
        .trim();
    if (!replacement) {
      throw new AiPlanningError(400, "AMBIGUOUS_COMMAND", "Replacement command requires target replacement text.");
    }
    return {
      action: "replace_selection",
      params: { replacement },
      riskLevel: "medium",
      explanation: "Replace the selected document content with the proposed text.",
    };
  }

  // 7. Insert text / dictation (EN / KM)
  if (
    /\b(insert|add\s+paragraph|add\s+text|dictate)\b/i.test(lower) ||
    /(បញ្ចូល|បន្ថែមអក្សរ|បន្ថែមកថាខណ្ឌ)/.test(normalized)
  ) {
    const quoted = extractQuotedText(normalized);
    const text =
      quoted ??
      normalized
        .replace(/^(insert(\s+text)?|add\s+(paragraph|text)|dictate|បញ្ចូលអក្សរ|បញ្ចូល|បន្ថែមអក្សរ|បន្ថែមកថាខណ្ឌ)\s*:?\s*/i, "")
        .trim();
    if (!text) {
      throw new AiPlanningError(400, "AMBIGUOUS_COMMAND", "Insert command requires text content.");
    }
    return {
      action: "insert_text",
      params: { text, asNewParagraph: /\bparagraph\b/i.test(lower) || normalized.includes("កថាខណ្ឌ") },
      riskLevel: "medium",
      explanation: "Insert the requested English/Khmer text into the document at a safe grapheme boundary.",
    };
  }

  throw new AiPlanningError(
    400,
    "UNSUPPORTED_OR_AMBIGUOUS_COMMAND",
    "Command could not be mapped safely to an authorized D1 document operation. Try: insert text, replace/translate selection, make heading 1-3, bold, align left/center/right, insert 3x3 table, or undo.",
  );
}

export function planDocumentOperation(params: {
  actor: ActorContext;
  document: StudioDocument;
  priorRevisionDoc?: StudioDocument | null;
  input: PlanCommandInput;
  audit: AuditStore;
}): DocumentOperationProposal {
  const { actor, document, priorRevisionDoc, input, audit } = params;
  assertCanPerform(actor, "document", "write");

  if (
    typeof input.selection?.startOffset === "number" &&
    typeof input.selection?.endOffset === "number" &&
    input.selection.startOffset > input.selection.endOffset
  ) {
    throw new AiPlanningError(400, "INVALID_SELECTION_RANGE", "selection.startOffset must be <= selection.endOffset.");
  }

  const targetBlock = input.selection?.blockId
    ? document.blocks.find((b) => b.id === input.selection?.blockId)
    : document.blocks.find((b) => b.type === "paragraph" || b.type === "heading");

  const blockPlainText = targetBlock ? normalizeDocumentText(getBlockPlainText(targetBlock)) : "";
  const selectedText = input.selection?.selectedText ?? blockPlainText;

  // Untrusted-content & prompt-injection defense (D4.05 / AI-05)
  const blockScan = scanForPromptInjection(input.command, blockPlainText);
  const selectionScan =
    input.selection?.selectedText && input.selection.selectedText !== blockPlainText
      ? scanForPromptInjection("", input.selection.selectedText)
      : { safe: true, reasons: [] };
  const safetyScan = {
    safe: blockScan.safe && selectionScan.safe,
    reasons: Array.from(new Set([...blockScan.reasons, ...selectionScan.reasons])),
  };
  if (!safetyScan.safe) {
    audit.append({
      auditId: `aud_${randomUUID()}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      documentId: document.documentId,
      actorId: actor.userId,
      actorRole: actor.role,
      source: input.source,
      action: "ai.plan_blocked_prompt_injection",
      outcome: "denied",
      revisionBefore: document.revision,
      summary: `Blocked unsafe AI instruction: ${safetyScan.reasons.join(" | ")}`,
      createdAt: new Date().toISOString(),
    });
    throw new AiPlanningError(
      400,
      "PROMPT_INJECTION_BLOCKED",
      `Instruction rejected by AI safety policy: ${safetyScan.reasons[0]}`,
    );
  }

  const parsed = parseBilingualCommand(input.command, selectedText, input.outputLanguage);

  const snappedRange =
    typeof input.selection?.startOffset === "number" && typeof input.selection?.endOffset === "number"
      ? snapRangeToGraphemeBoundaries(blockPlainText, input.selection.startOffset, input.selection.endOffset)
      : { start: 0, end: blockPlainText.length };

  const resolvedSelection: DocumentSelectionRef | undefined =
    parsed.action === "undo_last"
      ? undefined
      : {
          blockId: targetBlock?.id ?? document.blocks[0]?.id ?? "",
          startOffset: snappedRange.start,
          endOffset: snappedRange.end,
          selectedText,
          selectionHash:
            input.selection?.selectionHash ??
            hashTextSelection(blockPlainText.slice(snappedRange.start, snappedRange.end)),
        };

  const { preview } = previewDocumentOperation(
    document,
    {
      expectedRevision: input.expectedRevision,
      selection: resolvedSelection,
      action: parsed.action,
      params: parsed.params,
    },
    priorRevisionDoc,
  );

  const proposal: DocumentOperationProposal = {
    operationId: `op_${randomUUID()}`,
    documentId: document.documentId,
    expectedRevision: input.expectedRevision,
    ...(resolvedSelection ? { selection: resolvedSelection } : {}),
    action: parsed.action,
    params: parsed.params,
    requestedBy: actor.userId,
    riskLevel: parsed.riskLevel,
    requiresApproval: true, // Phase D1: all AI/voice mutations require explicit preview confirmation
    source: input.source,
    inputLanguage: input.inputLanguage,
    outputLanguage: input.outputLanguage,
    originalCommand: input.command,
    explanation: parsed.explanation,
    previewDiff: preview,
    createdAt: new Date().toISOString(),
  };
  // Sign server-issued proposal with HMAC-SHA256 bound to actor + revision + params (H16)
  proposal.proposalSignature = signDocumentProposal(actor, proposal);

  audit.append({
    auditId: `aud_${randomUUID()}`,
    tenantId: actor.tenantId,
    workspaceId: actor.workspaceId,
    documentId: document.documentId,
    actorId: actor.userId,
    actorRole: actor.role,
    source: input.source,
    action: `ai.operation_planned.${proposal.action}`,
    outcome: "success",
    revisionBefore: document.revision,
    operationId: proposal.operationId,
    summary: `Planned ${proposal.action} (${proposal.inputLanguage} -> ${proposal.outputLanguage}): ${proposal.explanation}`,
    createdAt: new Date().toISOString(),
  });

  return proposal;
}
