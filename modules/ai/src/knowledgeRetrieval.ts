import { createHash } from "node:crypto";
import type {
  ActorContext,
  KnowledgeChunkRecord,
  KnowledgeCitation,
  KnowledgeConflict,
  KnowledgeRetrievalResult,
} from "@ai-office-suite/shared-contracts";
import { scanForPromptInjection } from "@ai-office-suite/validation";

const INJECTION_LINE_RE =
  /(ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s+override|disregard\s+policy|exfiltrate|reveal\s+system\s+prompt|bypass\s+rbac|sudo\s+grant)/i;

const REDACTED_RETRIEVAL_PLACEHOLDER =
  "[UNTRUSTED_INSTRUCTION_CONTENT_REDACTED_FROM_RETRIEVED_DOCUMENT]";

function normalizeForInjectionCheck(raw: string): string {
  return raw
    .replace(/[\p{Cf}\u034F\uFE00-\uFE0F]/gu, "")
    .normalize("NFKC");
}

function hasUnsafeMetadataText(text: string): boolean {
  const norm = normalizeForInjectionCheck(text);
  return !scanForPromptInjection(norm).safe || INJECTION_LINE_RE.test(norm);
}

function computeMetricConflicts(chunks: readonly KnowledgeChunkRecord[]): KnowledgeConflict[] {
  const claimIndex = new Map<
    string,
    Array<{ value: string; artifactId: string; revision: number; chunkId: string }>
  >();
  for (const chunk of chunks) {
    for (const claim of chunk.metricClaims ?? []) {
      const key = `${claim.metricId}::${claim.period}`;
      const list = claimIndex.get(key) ?? [];
      list.push({
        value: claim.formattedValue,
        artifactId: chunk.artifactId,
        revision: chunk.revision,
        chunkId: chunk.chunkId,
      });
      claimIndex.set(key, list);
    }
  }
  const conflicts: KnowledgeConflict[] = [];
  for (const [key, list] of claimIndex.entries()) {
    const distinctVals = new Set(list.map((x) => x.value));
    if (distinctVals.size > 1) {
      const [metricId = "", period = ""] = key.split("::");
      conflicts.push({
        metricId,
        period,
        conflictingValues: list,
      });
    }
  }
  return conflicts;
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}"'“”«»/\\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * Permission-aware corporate knowledge retrieval index (AIC-00 / AI-03 / AI-T14..T21).
 * Enforces:
 * 1. Strict ACL pre-filter (tenant, restricted workspace grant, role, department, non-revoked, latest revision)
 * 2. Indirect prompt-injection neutralization (untrusted retrieved content cannot act as instructions)
 * 3. Contradictory figure detection & insufficient-evidence honesty
 * 4. Response-time citation re-check against live revocation/ACL state
 */
export class CorporateKnowledgeIndex {
  private readonly chunks = new Map<string, KnowledgeChunkRecord>();

  indexChunk(
    chunk: Omit<KnowledgeChunkRecord, "contentHash" | "tombstoneRevoked"> & {
      contentHash?: string;
      tombstoneRevoked?: boolean;
    },
  ): KnowledgeChunkRecord {
    const record: KnowledgeChunkRecord = {
      ...chunk,
      tombstoneRevoked: chunk.tombstoneRevoked ?? false,
      contentHash: chunk.contentHash ?? createHash("sha256").update(chunk.text, "utf8").digest("hex"),
    };
    this.chunks.set(`${record.tenantId}::${record.workspaceId}::${record.chunkId}`, record);
    return record;
  }

  revokeArtifact(tenantId: string, artifactId: string): number {
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.tenantId === tenantId && chunk.artifactId === artifactId && !chunk.tombstoneRevoked) {
        chunk.tombstoneRevoked = true;
        count += 1;
      }
    }
    return count;
  }

  supersedeArtifactRevision(tenantId: string, artifactId: string, oldRevision: number, newRevision: number): number {
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.tenantId === tenantId && chunk.artifactId === artifactId && chunk.revision === oldRevision) {
        chunk.supersededByRevision = newRevision;
        count += 1;
      }
    }
    return count;
  }

  private isChunkAuthorized(actor: ActorContext, chunk: KnowledgeChunkRecord): boolean {
    if (chunk.tenantId !== actor.tenantId) return false;
    if (chunk.tombstoneRevoked) return false;
    if (chunk.supersededByRevision !== undefined) return false;

    // Billing admin and auditor never read restricted/confidential business content via RAG
    if (actor.role === "billing_admin" || actor.role === "auditor") return false;

    // Workspace isolation: standard queries stay inside actor's workspace; restricted workspace requires explicit content grant
    if (chunk.workspaceId !== actor.workspaceId) return false;
    if (
      (chunk.workspaceVisibility === "restricted" || chunk.classification === "restricted") &&
      actor.workspaceContentGrant !== true
    ) {
      return false;
    }

    if (chunk.allowedRoles && !chunk.allowedRoles.includes(actor.role)) {
      return false;
    }

    if (chunk.allowedDepartments && chunk.allowedDepartments !== "ALL") {
      if (actor.departmentScopes !== "ALL") {
        const actorDepts = actor.departmentScopes ?? [];
        const overlaps = chunk.allowedDepartments.some((d) => actorDepts.includes(d));
        if (!overlaps) return false;
      }
    }

    return true;
  }

  private sanitizeRetrievedText(chunk: KnowledgeChunkRecord): { cleanText: string; hadInjection: boolean } {
    if (hasUnsafeMetadataText(chunk.artifactId)) {
      return { cleanText: REDACTED_RETRIEVAL_PLACEHOLDER, hadInjection: true };
    }
    for (const claim of chunk.metricClaims ?? []) {
      if (hasUnsafeMetadataText(`${claim.metricId} ${claim.period} ${claim.formattedValue}`)) {
        return { cleanText: REDACTED_RETRIEVAL_PLACEHOLDER, hadInjection: true };
      }
    }

    const normalizedFull = normalizeForInjectionCheck(chunk.text);
    const scan = scanForPromptInjection(normalizedFull);
    const hasLinePattern = INJECTION_LINE_RE.test(normalizedFull);
    if (scan.safe && !hasLinePattern) {
      return { cleanText: chunk.text, hadInjection: false };
    }
    const cleanLines = chunk.text.split(/\r?\n/).filter((line) => {
      const normalizedLine = normalizeForInjectionCheck(line);
      return scanForPromptInjection(normalizedLine).safe && !INJECTION_LINE_RE.test(normalizedLine);
    });
    const joined = cleanLines.join(" ").trim();
    const rescan = joined
      ? scanForPromptInjection(normalizeForInjectionCheck(joined)).safe &&
        !INJECTION_LINE_RE.test(normalizeForInjectionCheck(joined))
      : false;
    return {
      cleanText: joined && rescan ? joined : REDACTED_RETRIEVAL_PLACEHOLDER,
      hadInjection: true,
    };
  }

  retrieve(params: {
    actor: ActorContext;
    query: string;
    maxResults?: number;
  }): KnowledgeRetrievalResult {
    const tokens = tokenizeQuery(params.query);
    let filteredUnauthorizedCount = 0;
    const sanitizedInjectionChunks: string[] = [];

    const scored: Array<{ chunk: KnowledgeChunkRecord; cleanText: string; score: number }> = [];

    for (const chunk of this.chunks.values()) {
      if (!this.isChunkAuthorized(params.actor, chunk)) {
        filteredUnauthorizedCount += 1;
        continue;
      }

      const { cleanText, hadInjection } = this.sanitizeRetrievedText(chunk);
      if (hadInjection) {
        sanitizedInjectionChunks.push(chunk.chunkId);
      }

      const haystack = `${cleanText} ${chunk.artifactId} ${(chunk.metricClaims ?? []).map((m) => `${m.metricId} ${m.period} ${m.formattedValue}`).join(" ")}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (haystack.includes(t)) score += 1;
      }
      if (score > 0 || tokens.length === 0) {
        scored.push({ chunk, cleanText, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || b.chunk.revision - a.chunk.revision);
    const top = scored.slice(0, params.maxResults ?? 8);

    if (top.length === 0) {
      return {
        status: "insufficient_evidence",
        verifiedFacts: [],
        citations: [],
        conflicts: [],
        filteredUnauthorizedCount,
        revokedAtRecheckCount: 0,
        sanitizedInjectionChunks,
      };
    }

    const nonRedactedChunks = top
      .filter((item) => item.cleanText !== REDACTED_RETRIEVAL_PLACEHOLDER)
      .map((item) => item.chunk);
    const conflicts = computeMetricConflicts(nonRedactedChunks);

    const citations: KnowledgeCitation[] = top.map(({ chunk, cleanText }) => ({
      chunkId: chunk.chunkId,
      artifactId: chunk.artifactId,
      revision: chunk.revision,
      contentHash: chunk.contentHash,
      excerpt: cleanText.slice(0, 240),
      verifiedAtRecheck: true,
    }));

    const verifiedFacts = top.flatMap(({ cleanText }, idx) =>
      cleanText === REDACTED_RETRIEVAL_PLACEHOLDER
        ? []
        : [{
            claim: cleanText,
            citation: citations[idx]!,
          }],
    );

    return {
      status:
        verifiedFacts.length === 0
          ? "insufficient_evidence"
          : conflicts.length > 0
            ? "conflicting_evidence"
            : "grounded",
      verifiedFacts,
      citations,
      conflicts,
      filteredUnauthorizedCount,
      revokedAtRecheckCount: 0,
      sanitizedInjectionChunks,
    };
  }

  /**
   * Re-verifies citations at response assembly time against live ACL & tombstone revocation state (AI-T17).
   */
  recheckCitations(
    actor: ActorContext,
    result: KnowledgeRetrievalResult,
  ): KnowledgeRetrievalResult {
    const survivingCitations: KnowledgeCitation[] = [];
    const survivingChunkIds = new Set<string>();
    const survivingChunks: KnowledgeChunkRecord[] = [];
    let revokedAtRecheckCount = 0;

    for (const cit of result.citations) {
      const liveChunk = this.chunks.get(`${actor.tenantId}::${actor.workspaceId}::${cit.chunkId}`);
      if (
        !liveChunk ||
        !this.isChunkAuthorized(actor, liveChunk) ||
        liveChunk.contentHash !== cit.contentHash ||
        liveChunk.revision !== cit.revision
      ) {
        revokedAtRecheckCount += 1;
        continue;
      }
      const verifiedCit: KnowledgeCitation = { ...cit, verifiedAtRecheck: true };
      survivingCitations.push(verifiedCit);
      survivingChunkIds.add(cit.chunkId);
      if (this.sanitizeRetrievedText(liveChunk).cleanText !== REDACTED_RETRIEVAL_PLACEHOLDER) {
        survivingChunks.push(liveChunk);
      }
    }

    const survivingCitationMap = new Map(survivingCitations.map((c) => [c.chunkId, c]));
    const survivingFacts: KnowledgeRetrievalResult["verifiedFacts"] = result.verifiedFacts
      .filter((f) => f.citation && survivingChunkIds.has(f.citation.chunkId))
      .map((f) => ({
        claim: f.claim,
        citation: survivingCitationMap.get(f.citation!.chunkId)!,
      }));

    const survivingConflicts = computeMetricConflicts(survivingChunks);

    return {
      ...result,
      status:
        survivingFacts.length === 0
          ? "insufficient_evidence"
          : survivingConflicts.length > 0
            ? "conflicting_evidence"
            : "grounded",
      citations: survivingCitations,
      verifiedFacts: survivingFacts,
      conflicts: survivingConflicts,
      revokedAtRecheckCount: result.revokedAtRecheckCount + revokedAtRecheckCount,
    };
  }
}
