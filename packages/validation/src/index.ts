import { z } from "zod";
import type {
  DocumentOperationProposal,
  ReportingPackageManifest,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";

export const workspaceRoleSchema = z.enum([
  "owner",
  "administrator",
  "editor",
  "reviewer",
  "viewer",
]);

export const textMarksSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  highlight: z.string().max(40).optional(),
  fontFamily: z.string().max(100).optional(),
  fontSizePt: z.number().min(6).max(96).optional(),
  color: z.string().max(40).optional(),
});

export const textRunSchema = z.object({
  text: z.string().max(100000),
  marks: textMarksSchema.optional(),
});

export const alignmentSchema = z.enum(["left", "center", "right", "justify"]);

export const documentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("paragraph"),
    alignment: alignmentSchema.optional(),
    runs: z.array(textRunSchema),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    alignment: alignmentSchema.optional(),
    runs: z.array(textRunSchema),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.enum(["bullet_list", "ordered_list"]),
    items: z.array(z.array(textRunSchema)),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("table"),
    hasHeaderRow: z.boolean(),
    rows: z.array(
      z.array(
        z.object({
          runs: z.array(textRunSchema),
          colspan: z.number().int().min(1).max(20).optional(),
          rowspan: z.number().int().min(1).max(50).optional(),
        }),
      ),
    ),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("page_break"),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("linked_metric_placeholder"),
    metric: z.object({
      datasetId: z.string().min(1),
      datasetVersion: z.string().min(1),
      metricId: z.string().min(1),
      metricVersion: z.string().min(1),
      reportingPeriod: z.string().min(1),
      filterContext: z.record(z.string(), z.string()),
      unit: z.string().min(1),
      currency: z.string().optional(),
      approvalStatus: z.enum(["draft", "certified", "published_snapshot"]),
      freshnessTimestamp: z.string().min(1),
      mode: z.enum(["live_draft", "published_snapshot"]),
      displayLabel: z.string().min(1),
      cachedFormattedValue: z.string(),
      provenanceId: z.string().min(1).optional(),
      calculationEngineVersion: z.string().min(1).optional(),
      precisionPolicyId: z.string().min(1).optional(),
      status: z.enum(["available", "unavailable"]).optional(),
      unavailableReason: z.string().optional(),
    }),
  }),
]);

export const pageLayoutSchema = z.object({
  size: z.enum(["A4", "Letter"]),
  orientation: z.enum(["portrait", "landscape"]),
  marginsMm: z.object({
    top: z.number().min(5).max(80),
    right: z.number().min(5).max(80),
    bottom: z.number().min(5).max(80),
    left: z.number().min(5).max(80),
  }),
  headerText: z.string().max(300),
  footerText: z.string().max(300),
  showPageNumbers: z.boolean(),
});

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  language: z.enum(["en", "km", "bilingual"]).default("bilingual"),
  layout: pageLayoutSchema.optional(),
  blocks: z.array(documentBlockSchema).optional(),
});

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  language: z.enum(["en", "km", "bilingual"]).optional(),
  expectedRevision: z.number().int().min(1),
  layout: pageLayoutSchema.optional(),
  blocks: z.array(documentBlockSchema).max(2000),
  summary: z.string().max(300).optional(),
});

export const aiPlanRequestSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().min(1),
  inputLanguage: z.enum(["en", "km"]).default("en"),
  outputLanguage: z.enum(["en", "km", "match"]).default("match"),
  source: z.enum(["typed_ai", "voice_command"]).default("typed_ai"),
  selection: z
    .object({
      blockId: z.string().min(1).max(120),
      startOffset: z.number().int().min(0).optional(),
      endOffset: z.number().int().min(0).optional(),
      selectedText: z.string().max(20000).optional(),
      selectionHash: z.string().max(128).optional(),
    })
    .optional(),
});

export const documentOperationProposalSchema = z.object({
  operationId: z.string().min(1).max(120),
  documentId: z.string().min(1).max(120),
  expectedRevision: z.number().int().min(1),
  selection: z
    .object({
      blockId: z.string().min(1).max(120),
      startOffset: z.number().int().min(0).optional(),
      endOffset: z.number().int().min(0).optional(),
      selectedText: z.string().max(20000).optional(),
      selectionHash: z.string().max(128).optional(),
    })
    .optional(),
  action: z.enum([
    "insert_text",
    "replace_selection",
    "set_heading",
    "toggle_bold",
    "set_alignment",
    "insert_table",
    "undo_last",
  ]),
  params: z.record(z.string(), z.unknown()),
  requestedBy: z.string().min(1),
  riskLevel: z.enum(["low", "medium", "high"]),
  requiresApproval: z.boolean(),
  source: z.enum(["manual", "typed_ai", "voice_command"]),
  inputLanguage: z.enum(["en", "km"]),
  outputLanguage: z.enum(["en", "km", "match"]),
  originalCommand: z.string().min(1),
  explanation: z.string().min(1),
  previewDiff: z.object({
    blockId: z.string().optional(),
    beforeText: z.string(),
    afterText: z.string(),
    summary: z.string(),
  }),
  createdAt: z.string().min(1),
}) satisfies z.ZodType<DocumentOperationProposal>;

export const aiApplyRequestSchema = z.object({
  proposal: documentOperationProposalSchema,
  approved: z.boolean(),
});

export const speechTranscribeRequestSchema = z.object({
  provider: z
    .enum(["mock", "google-cloud-stt-v2", "azure-speech", "faster-whisper"])
    .default("mock"),
  language: z.enum(["en-US", "km-KH"]),
  mode: z.enum(["dictation", "command", "contextual", "workflow"]).default("command"),
  fixtureId: z.string().max(120).optional(),
  simulatedTranscript: z.string().max(2000).optional(),
  audioBase64: z.string().max(10_000_000).optional(),
  mimeType: z.string().max(100).optional(),
  durationMs: z.number().int().min(0).max(300_000).optional(),
});

export const importDocxRequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentBase64: z.string().min(4).max(20_000_000),
});

const INJECTION_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; reason: string }> = [
  {
    id: "system_override",
    pattern: /\b(ignore\s+(all\s+)?(previous|prior)\s+instructions|override\s+system\s+prompt|jailbreak)\b/i,
    reason: "Prompt injection instruction override attempt detected.",
  },
  {
    id: "khmer_system_override",
    pattern: /(មិនអើពើ\s*(?:លើ|ចំពោះ)?\s*(?:ការណែនាំ|សេចក្តីណែនាំ)(?:មុន|ពីមុន)|បំបែកប្រព័ន្ធ|បំពានការណែនាំប្រព័ន្ធ)/u,
    reason: "Khmer prompt injection instruction override attempt detected.",
  },
  {
    id: "role_framing_marker",
    pattern: /(<\|(?:system|im_start|im_end|assistant)\|>|\[\/?INST\]|<<\/?SYS>>|^\s*#{2,4}\s*system\s*:)/im,
    reason: "LLM control or role-framing delimiter injection detected.",
  },
  {
    id: "shell_or_code_exec",
    pattern: /\b(run\s+shell|execute\s+bash|powershell|rm\s+-rf|child_process|eval\(|process\.env)\b/i,
    reason: "Unauthorized OS or code execution directive detected.",
  },
  {
    id: "secret_exfiltration",
    pattern: /\b(reveal|dump|exfiltrate|print)\s+(all\s+)?(api\s*keys?|secrets?|tokens?|passwords?|env)\b/i,
    reason: "Secret or credential exfiltration attempt detected.",
  },
  {
    id: "khmer_secret_exfiltration",
    pattern: /(បង្ហាញ|លួចយក|បញ្ជូនចេញ).{0,24}(ពាក្យសម្ងាត់|កូនសោ|សម្ងាត់|ថូខឹន)/u,
    reason: "Khmer secret or credential exfiltration attempt detected.",
  },
  {
    id: "cross_tenant_probe",
    pattern: /\b(other\s+tenant|all\s+tenants|bypass\s+rbac|skip\s+approval|disable\s+audit)\b/i,
    reason: "Authorization or audit bypass instruction detected.",
  },
  {
    id: "khmer_bypass_probe",
    pattern: /(រំលងការអនុម័ត|បិទកំណត់ត្រាសវនកម្ម|ទិន្នន័យក្រុមហ៊ុនផ្សេង|រំលងសិទ្ធិ)/u,
    reason: "Khmer authorization or audit bypass instruction detected.",
  },
  {
    id: "active_content_or_markdown_exfil",
    pattern: /(!\[[^\]]*\]\(\s*https?:\/\/|<script\b|javascript:|data:text\/html)/i,
    reason: "Active script or external Markdown image exfiltration vector detected.",
  },
];

function normalizeForPromptScan(raw: string): string {
  // Remove zero-width, soft-hyphen, and bidirectional override characters before NFKC folding
  return raw
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .normalize("NFKC");
}

export interface PromptSafetyScanResult {
  safe: boolean;
  reasons: string[];
}

export function scanForPromptInjection(
  command: string,
  selectedDocumentText?: string,
): PromptSafetyScanResult {
  const normalizedCommand = normalizeForPromptScan(command);
  const normalizedDocText = selectedDocumentText ? normalizeForPromptScan(selectedDocumentText) : undefined;
  const reasons: string[] = [];
  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(normalizedCommand)) {
      reasons.push(rule.reason);
    }
    if (normalizedDocText && rule.pattern.test(normalizedDocText)) {
      reasons.push(`Untrusted document text triggered safety rule (${rule.id}): ${rule.reason}`);
    }
  }
  return {
    safe: reasons.length === 0,
    reasons,
  };
}

export function validateDocxUploadBytes(
  filename: string,
  bytes: Uint8Array,
): { ok: true } | { ok: false; code: string; message: string } {
  const maxBytes = 10 * 1024 * 1024;
  if (bytes.byteLength === 0) {
    return { ok: false, code: "EMPTY_UPLOAD", message: "Uploaded file is empty." };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `Uploaded DOCX exceeds maximum Phase D1 limit (${maxBytes} bytes).`,
    };
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docm") || lower.endsWith(".dotm")) {
    return {
      ok: false,
      code: "MACRO_FILE_BLOCKED",
      message: "Macro-enabled Word formats (.docm/.dotm) are blocked for security.",
    };
  }
  if (!lower.endsWith(".docx")) {
    return {
      ok: false,
      code: "UNSUPPORTED_EXTENSION",
      message: "Only .docx files are accepted by the DOCX importer.",
    };
  }
  // Check OLE2 Compound File Binary magic bytes (D0 CF 11 E0 A1 B1 1A E1) — encrypted or legacy binary Office docs
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    return {
      ok: false,
      code: "ENCRYPTED_FILE_UNSUPPORTED",
      message: "Encrypted or legacy OLE2 binary Word files are not supported in Phase D1.",
    };
  }
  // Check ZIP local file header magic bytes PK\x03\x04
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return {
      ok: false,
      code: "INVALID_ZIP_MAGIC",
      message: "File header is not a valid OOXML ZIP container.",
    };
  }
  return { ok: true };
}

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

const UNSAFE_ANALYTICAL_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; reason: string }> = [
  {
    id: "duckdb_file_or_copy",
    pattern: /\b(read_csv|read_csv_auto|read_parquet|read_json|copy\s+|attach\s+|pragma\s+)/i,
    reason: "Disallowed SQL file, extension, or pragma directive detected.",
  },
  {
    id: "sql_ddl_dml_injection",
    pattern: /(;\s*--|;\s*(drop|delete|alter|insert|update|create|attach)\b|\bunion\s+select\b|\bselect\s+\*\s+from\b)/i,
    reason: "Raw SQL statement or DDL/DML injection pattern detected.",
  },
  {
    id: "external_uri_scheme",
    pattern: /(https?:\/\/|file:\/\/|s3:\/\/|gs:\/\/)/i,
    reason: "Arbitrary external URI scheme is not permitted in analytical commands.",
  },
  {
    id: "python_or_eval_exec",
    pattern: /(\beval\s*\(|\bexec\s*\(|__import__|\bos\.system\b|\bsubprocess\b|\bchild_process\b)/i,
    reason: "Arbitrary script/code execution payload rejected.",
  },
];

export function scanForUnsafeAnalyticalInput(input: string): PromptSafetyScanResult {
  const base = scanForPromptInjection(input);
  const normalized = normalizeForPromptScan(input);
  const reasons = [...base.reasons];
  for (const rule of UNSAFE_ANALYTICAL_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      reasons.push(rule.reason);
    }
  }
  return {
    safe: reasons.length === 0,
    reasons,
  };
}

export function validatePptxUploadBytes(
  filename: string,
  bytes: Uint8Array,
): { ok: true } | { ok: false; code: string; message: string } {
  const maxBytes = 15 * 1024 * 1024;
  if (bytes.byteLength === 0) {
    return { ok: false, code: "EMPTY_UPLOAD", message: "Uploaded presentation file is empty." };
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, code: "FILE_TOO_LARGE", message: "Uploaded PPTX exceeds PS-00 15 MB limit." };
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pptm") || lower.endsWith(".potm") || lower.endsWith(".ppsm")) {
    return { ok: false, code: "MACRO_PRESENTATION_BLOCKED", message: "Macro-enabled PowerPoint files (.pptm/.potm/.ppsm) are blocked." };
  }
  if (!lower.endsWith(".pptx")) {
    return { ok: false, code: "UNSUPPORTED_EXTENSION", message: "Only .pptx files are accepted by the PPTX importer." };
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    return { ok: false, code: "ENCRYPTED_FILE_UNSUPPORTED", message: "Encrypted or legacy OLE2 PowerPoint files are rejected in PS-00." };
  }
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return { ok: false, code: "INVALID_ZIP_MAGIC", message: "File header is not a valid OOXML ZIP container." };
  }
  return { ok: true };
}

const UNSAFE_CHART_SPEC_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; reason: string }> = [
  {
    id: "html_script_or_handler",
    pattern: /<\s*script\b|on\w+\s*=|javascript:/i,
    reason: "Unsafe HTML/script handler rejected in chart specification.",
  },
  {
    id: "external_uri",
    pattern: /(https?:\/\/|file:\/\/|ftp:\/\/)/i,
    reason: "External URLs are not permitted inside validated ChartSpec strings.",
  },
  {
    id: "js_callback_or_eval",
    pattern: /\bfunction\s*\(|\beval\s*\(|=>\s*\{/i,
    reason: "Executable JavaScript expressions are not permitted inside ChartSpec.",
  },
];

export function validateChartSpecSafety(spec: {
  titleEn: string;
  titleKm: string;
  altSummaryEn: string;
  altSummaryKm: string;
  categories: string[];
  series: Array<{ labelEn: string; labelKm: string }>;
}): PromptSafetyScanResult {
  const texts = [
    spec.titleEn,
    spec.titleKm,
    spec.altSummaryEn,
    spec.altSummaryKm,
    ...spec.categories,
    ...spec.series.flatMap((s) => [s.labelEn, s.labelKm]),
  ];
  const reasons: string[] = [];
  for (const t of texts) {
    const promptCheck = scanForUnsafeAnalyticalInput(t);
    if (!promptCheck.safe) {
      reasons.push(...promptCheck.reasons);
    }
    const normalized = normalizeForPromptScan(t);
    for (const rule of UNSAFE_CHART_SPEC_PATTERNS) {
      if (rule.pattern.test(normalized)) {
        reasons.push(rule.reason);
      }
    }
  }
  return {
    safe: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
  };
}

export * from "./ooxmlSafety.ts";

export function validateReportingManifestSafety(manifest: ReportingPackageManifest): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const titleSafety = scanForPromptInjection(manifest.title, manifest.audiencePolicy);
  if (!titleSafety.safe) {
    errors.push(...titleSafety.reasons);
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.manifestDigestSha256)) {
    errors.push("Manifest digest must be a 64-character hex SHA-256 hash.");
  }
  if (manifest.artifactRevisions.length === 0) {
    errors.push("Reporting package manifest must reference at least one artifact revision.");
  }
  if (Object.keys(manifest.fileChecksums).length === 0) {
    errors.push("Reporting package manifest must include file integrity checksums.");
  }
  if (manifest.approval && manifest.approval.manifestDigestSha256 !== manifest.manifestDigestSha256) {
    errors.push("Publication approval digest does not match current manifest digest.");
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

export const listDocumentsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  language: z.enum(["en", "km", "bilingual"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

export const dataPrepStageProfileSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  csvText: z.string().min(1).max(5_000_000),
  delimiter: z.enum([",", ";", "\t", "auto"]).optional(),
  profileScope: z.enum(["sample", "full"]).default("full"),
  sampleSize: z.number().int().min(1).max(200).optional(),
  expectedColumns: z.array(z.string().min(1).max(120)).max(200).optional(),
  steps: z
    .array(
      z.object({
        stepId: z.string().min(1).max(80),
        op: z.enum([
          "trim_normalize",
          "normalize_khmer_numerals",
          "parse_date_locale",
          "quarantine_missing_required",
          "validate_schema_contract",
          "mask_pii_columns",
          "map_bilingual_dictionary",
          "deduplicate_composite_key",
        ]),
        params: z.record(z.string(), z.unknown()),
      }),
    )
    .max(30)
    .optional(),
});

export type ValidatedStudioDocument = StudioDocument;

