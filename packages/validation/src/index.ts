import { z } from "zod";
import type {
  DocumentBlock,
  DocumentOperationProposal,
  ReportingPackageManifest,
  StudioDocument,
} from "@ai-office-suite/shared-contracts";

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
  text: z.string().max(100_000),
  marks: textMarksSchema.optional(),
});

export const alignmentSchema = z.enum(["left", "center", "right", "justify"]);

const filterContextSchema = z
  .record(z.string().min(1).max(64), z.string().max(200))
  .refine((obj) => Object.keys(obj).length <= 32, {
    message: "filterContext cannot exceed 32 keys.",
  });

export const documentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("paragraph"),
    alignment: alignmentSchema.optional(),
    runs: z.array(textRunSchema).max(500),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    alignment: alignmentSchema.optional(),
    runs: z.array(textRunSchema).max(500),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.enum(["bullet_list", "ordered_list"]),
    items: z.array(z.array(textRunSchema).max(200)).max(500),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("table"),
    hasHeaderRow: z.boolean(),
    rows: z
      .array(
        z
          .array(
            z.object({
              runs: z.array(textRunSchema).max(100),
              colspan: z.number().int().min(1).max(20).optional(),
              rowspan: z.number().int().min(1).max(50).optional(),
            }),
          )
          .max(50),
      )
      .max(500),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("page_break"),
  }),
  z.object({
    id: z.string().min(1).max(120),
    type: z.literal("linked_metric_placeholder"),
    metric: z.object({
      datasetId: z.string().min(1).max(160),
      datasetVersion: z.string().min(1).max(64),
      metricId: z.string().min(1).max(160),
      metricVersion: z.string().min(1).max(64),
      reportingPeriod: z.string().min(1).max(120),
      filterContext: filterContextSchema,
      unit: z.string().min(1).max(40),
      currency: z.string().max(16).optional(),
      approvalStatus: z.enum(["draft", "certified", "published_snapshot"]),
      freshnessTimestamp: z.string().min(1).max(80),
      mode: z.enum(["live_draft", "published_snapshot"]),
      displayLabel: z.string().min(1).max(300),
      cachedFormattedValue: z.string().max(200),
      provenanceId: z.string().min(1).max(160).optional(),
      calculationEngineVersion: z.string().min(1).max(80).optional(),
      precisionPolicyId: z.string().min(1).max(80).optional(),
      status: z.enum(["available", "unavailable"]).optional(),
      unavailableReason: z.string().max(400).optional(),
      bindingMode: z.enum(["independent_copy", "refreshable_link", "pinned_snapshot"]).optional(),
      linkState: z
        .enum([
          "current",
          "update_available",
          "refreshing",
          "stale",
          "incompatible",
          "access_restricted",
          "source_unavailable",
          "detached",
          "pinned",
        ])
        .optional(),
      sourceArtifactId: z.string().min(1).max(160).optional(),
      resultReferenceId: z.string().min(1).max(160).optional(),
      effectivePolicyScope: z.string().min(1).max(200).optional(),
      policyVersion: z.number().int().min(1).max(1_000_000).optional(),
    }),
  }),
]) satisfies z.ZodType<DocumentBlock>;

const uniqueDocumentBlocksSchema = z
  .array(documentBlockSchema)
  .max(2000)
  .superRefine((blocks, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < blocks.length; i++) {
      const id = blocks[i]!.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `Duplicate block id '${id}' is not permitted.`,
        });
      }
      seen.add(id);
    }
  });

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
  blocks: uniqueDocumentBlocksSchema.optional(),
});

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  language: z.enum(["en", "km", "bilingual"]).optional(),
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  layout: pageLayoutSchema.optional(),
  blocks: uniqueDocumentBlocksSchema,
  summary: z.string().max(300).optional(),
});

export const aiPlanRequestSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  inputLanguage: z.enum(["en", "km"]).default("en"),
  outputLanguage: z.enum(["en", "km", "match"]).default("match"),
  source: z.enum(["typed_ai", "voice_command"]).default("typed_ai"),
  selection: z
    .object({
      blockId: z.string().min(1).max(120),
      startOffset: z.number().int().min(0).max(100_000).optional(),
      endOffset: z.number().int().min(0).max(100_000).optional(),
      selectedText: z.string().max(20000).optional(),
      selectionHash: z.string().max(128).optional(),
    })
    .refine(
      (s) => s.startOffset === undefined || s.endOffset === undefined || s.startOffset <= s.endOffset,
      { message: "selection.startOffset must be <= selection.endOffset." },
    )
    .optional(),
});

export const documentOperationProposalSchema = z.object({
  operationId: z.string().min(1).max(120),
  documentId: z.string().min(1).max(120),
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  selection: z
    .object({
      blockId: z.string().min(1).max(120),
      startOffset: z.number().int().min(0).max(100_000).optional(),
      endOffset: z.number().int().min(0).max(100_000).optional(),
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
  params: z
    .record(z.string().max(64), z.unknown())
    .refine((obj) => Object.keys(obj).length <= 32, { message: "params cannot exceed 32 keys." }),
  requestedBy: z.string().min(1).max(160),
  riskLevel: z.enum(["low", "medium", "high"]),
  requiresApproval: z.boolean(),
  source: z.enum(["manual", "typed_ai", "voice_command"]),
  inputLanguage: z.enum(["en", "km"]),
  outputLanguage: z.enum(["en", "km", "match"]),
  originalCommand: z.string().min(1).max(2000),
  explanation: z.string().min(1).max(2000),
  previewDiff: z.object({
    blockId: z.string().max(120).optional(),
    beforeText: z.string().max(100_000),
    afterText: z.string().max(100_000),
    summary: z.string().max(500),
  }),
  createdAt: z.string().min(1).max(80),
  proposalSignature: z.string().max(256).optional(),
}) satisfies z.ZodType<DocumentOperationProposal & { proposalSignature?: string }>;

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

// 10 MB binary cap = ceil(10 * 1024 * 1024 / 3) * 4 = 13,981,016 base64 chars (M8)
export const importDocxRequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentBase64: z
    .string()
    .min(4)
    .max(13_981_016)
    .regex(/^[A-Za-z0-9+/\r\n]+=*$/, "contentBase64 must be valid base64 data."),
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
  // Remove invisible formatting/control characters (Cf), combining grapheme joiner (U+034F), and variation selectors before NFKC folding
  return raw
    .replace(/[\p{Cf}\u034F\uFE00-\uFE0F]/gu, "")
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

import { validateOoxmlUploadHeader } from "./ooxmlSafety.ts";

export function validateDocxUploadBytes(
  filename: string,
  bytes: Uint8Array,
): { ok: true } | { ok: false; code: string; message: string } {
  return validateOoxmlUploadHeader(filename, bytes, "docx");
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

export type ReleaseEvidenceGateInput = {
  requiredFixturesPresent: boolean;
  approvalValidAndFresh: boolean;
  authorizationChecksPassed: boolean;
  requiresRealEnvironment: boolean;
  submittedEvidenceIsMock: boolean;
};

export function evaluateReleaseEvidenceGate(
  input: ReleaseEvidenceGateInput,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.requiredFixturesPresent) reasons.push("MISSING_MANDATORY_FIXTURE");
  if (!input.approvalValidAndFresh) reasons.push("STALE_OR_MISSING_APPROVAL");
  if (!input.authorizationChecksPassed) reasons.push("AUTHORIZATION_CHECK_FAILED");
  if (input.requiresRealEnvironment && input.submittedEvidenceIsMock) {
    reasons.push("MOCK_ONLY_EVIDENCE_CANNOT_PASS_REAL_ENV_GATE");
  }
  return { allowed: reasons.length === 0, reasons };
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
  if (
    manifest.approval &&
    manifest.approval.status === "approved" &&
    manifest.approval.manifestDigestSha256 !== manifest.manifestDigestSha256
  ) {
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

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export const restoreVersionRequestSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2_147_483_647).optional(),
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
export * from "./decimalPrecision.ts";
