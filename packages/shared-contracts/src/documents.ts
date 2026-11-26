import type {
  LinkedObjectBindingMode,
  LinkedResourceState,
  OperationRiskLevel,
  OperationSource,
} from "./core.ts";

export type TextAlignment = "left" | "center" | "right" | "justify";
export type PageSize = "A4" | "Letter";
export type PageOrientation = "portrait" | "landscape";

export interface TextMarks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlight?: string;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
}

export interface TextRun {
  text: string;
  marks?: TextMarks;
}

export interface ParagraphBlock {
  id: string;
  type: "paragraph";
  alignment?: TextAlignment;
  runs: TextRun[];
}

export interface HeadingBlock {
  id: string;
  type: "heading";
  level: 1 | 2 | 3;
  alignment?: TextAlignment;
  runs: TextRun[];
}

export interface ListBlock {
  id: string;
  type: "bullet_list" | "ordered_list";
  items: TextRun[][];
}

export interface TableCell {
  runs: TextRun[];
  colspan?: number;
  rowspan?: number;
}

export interface TableBlock {
  id: string;
  type: "table";
  hasHeaderRow: boolean;
  rows: TableCell[][];
}

export interface PageBreakBlock {
  id: string;
  type: "page_break";
}

export interface LinkedMetricReference {
  datasetId: string;
  datasetVersion: string;
  metricId: string;
  metricVersion: string;
  reportingPeriod: string;
  filterContext: Record<string, string>;
  unit: string;
  currency?: string;
  approvalStatus: "draft" | "certified" | "published_snapshot";
  freshnessTimestamp: string;
  mode: "live_draft" | "published_snapshot";
  displayLabel: string;
  cachedFormattedValue: string;
  provenanceId?: string;
  calculationEngineVersion?: string;
  precisionPolicyId?: string;
  status?: "available" | "unavailable";
  unavailableReason?: string;
  bindingMode?: LinkedObjectBindingMode;
  linkState?: LinkedResourceState;
  sourceArtifactId?: string;
  resultReferenceId?: string;
  effectivePolicyScope?: string;
  policyVersion?: number;
}

export interface LinkedMetricPlaceholderBlock {
  id: string;
  type: "linked_metric_placeholder";
  metric: LinkedMetricReference;
}

export type DocumentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | TableBlock
  | PageBreakBlock
  | LinkedMetricPlaceholderBlock;

export interface PageLayoutConfig {
  size: PageSize;
  orientation: PageOrientation;
  marginsMm: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  headerText: string;
  footerText: string;
  showPageNumbers: boolean;
}

export interface StudioDocument {
  documentId: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  language: "en" | "km" | "bilingual";
  revision: number;
  status: "draft" | "in_review" | "approved";
  layout: PageLayoutConfig;
  blocks: DocumentBlock[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sourceImportSha256?: string;
}

export interface DocumentVersion {
  versionId: string;
  documentId: string;
  revision: number;
  snapshot: StudioDocument;
  summary: string;
  source: "manual" | "typed_ai" | "voice_command" | "import" | "restore";
  actorId: string;
  restoredFromRevision?: number;
  undoneRevision?: number;
  createdAt: string;
}

export interface ImportDiagnostics {
  originalSha256: string;
  filename: string;
  byteLength: number;
  macrosBlocked: boolean;
  warnings: string[];
  unsupportedFeatures: string[];
}

export type DocumentOperationType =
  | "insert_text"
  | "replace_selection"
  | "set_heading"
  | "toggle_bold"
  | "set_alignment"
  | "insert_table"
  | "undo_last";

export interface DocumentSelectionRef {
  blockId: string;
  startOffset?: number;
  endOffset?: number;
  selectedText?: string;
  selectionHash?: string;
}


export interface DocumentOperationPreview {
  blockId?: string;
  beforeText: string;
  afterText: string;
  summary: string;
}

export interface DocumentOperationProposal {
  operationId: string;
  documentId: string;
  expectedRevision: number;
  selection?: DocumentSelectionRef;
  action: DocumentOperationType;
  params: Record<string, unknown>;
  requestedBy: string;
  riskLevel: OperationRiskLevel;
  requiresApproval: boolean;
  source: OperationSource;
  inputLanguage: "en" | "km";
  outputLanguage: "en" | "km" | "match";
  originalCommand: string;
  explanation: string;
  previewDiff: DocumentOperationPreview;
  createdAt: string;
  proposalSignature?: string;
}

export type SpeechProviderId =
  | "mock"
  | "google-cloud-stt-v2"
  | "azure-speech"
  | "faster-whisper";

export type SpeechLanguageCode = "en-US" | "km-KH";

export interface SpeechRecognitionRequest {
  language: SpeechLanguageCode;
  mode: "dictation" | "command" | "contextual" | "workflow";
  fixtureId?: string;
  simulatedTranscript?: string;
  audioBase64?: string;
  mimeType?: string;
  durationMs?: number;
}

export interface SpeechRecognitionResult {
  transcript: string;
  language: SpeechLanguageCode;
  confidence: number;
  provider: SpeechProviderId;
  isMock: boolean;
  disclaimer?: string;
  durationMs: number;
  warnings: string[];
}

export interface SpeechRecognitionAdapter {
  readonly providerId: SpeechProviderId;
  readonly isMock: boolean;
  transcribe(request: SpeechRecognitionRequest): Promise<SpeechRecognitionResult>;
}

