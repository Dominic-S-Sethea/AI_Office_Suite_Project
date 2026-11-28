import type {
  TerminologyDictionaryVersion,
  TerminologyEntry,
} from "@ai-office-suite/shared-contracts";

export const DEFAULT_FINANCE_TERMINOLOGY_ENTRIES: readonly TerminologyEntry[] = [
  {
    termId: "term-net-sales",
    canonical: "Net Sales",
    language: "en",
    aliases: ["net sails", "net sale", "ned sales"],
    category: "financial_metric",
  },
  {
    termId: "term-cogs",
    canonical: "COGS",
    language: "bilingual",
    aliases: ["cost of goods", "cog s", "កូស"],
    category: "financial_metric",
  },
  {
    termId: "term-opex",
    canonical: "OpEx",
    language: "en",
    aliases: ["op ex", "op-ex", "operating ex"],
    category: "financial_metric",
  },
  {
    termId: "term-operating-profit",
    canonical: "Operating Profit",
    language: "en",
    aliases: ["op profit", "operating prophet"],
    category: "financial_metric",
  },
  {
    termId: "term-khmer-net-sales",
    canonical: "ការលក់សុទ្ធ",
    language: "km",
    aliases: ["ការលក់សុត", "ចំណូលលក់សុទ្ធ"],
    category: "financial_metric",
  },
  {
    termId: "term-phnom-penh-hq",
    canonical: "Phnom Penh HQ",
    language: "en",
    aliases: ["phnom pen hq", "pp hq"],
    category: "branch",
  },
];

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tenant-isolated, versioned bilingual EN/KM corporate terminology registry (VI-00 / VOC-02 / VOC-T17).
 */
export class TerminologyRegistry {
  private readonly dictionaries = new Map<string, TerminologyDictionaryVersion[]>();

  publishDictionary(
    tenantId: string,
    entries: readonly TerminologyEntry[],
  ): TerminologyDictionaryVersion {
    const history = this.dictionaries.get(tenantId) ?? [];
    const nextVersion = history.length + 1;
    const record: TerminologyDictionaryVersion = {
      tenantId,
      version: nextVersion,
      entries: structuredClone(entries) as TerminologyEntry[],
      updatedAt: new Date().toISOString(),
    };
    history.push(record);
    this.dictionaries.set(tenantId, history);
    return record;
  }

  getLatestDictionary(tenantId: string): TerminologyDictionaryVersion | null {
    const history = this.dictionaries.get(tenantId);
    if (!history || history.length === 0) return null;
    return history[history.length - 1]!;
  }

  normalizeTranscript(
    tenantId: string,
    rawTranscript: string,
  ): {
    normalizedTranscript: string;
    appliedTerms: Array<{ matchedAlias: string; canonical: string }>;
    dictionaryVersion: number;
  } {
    const dict = this.getLatestDictionary(tenantId);
    if (!dict) {
      return {
        normalizedTranscript: rawTranscript,
        appliedTerms: [],
        dictionaryVersion: 0,
      };
    }

    let text = rawTranscript;
    const appliedTerms: Array<{ matchedAlias: string; canonical: string }> = [];

    for (const entry of dict.entries) {
      for (const alias of entry.aliases) {
        if (!alias.trim()) continue;
        const isAscii = /^[\x00-\x7F]+$/.test(alias);
        const pattern = isAscii
          ? new RegExp(`\\b${escapeRegex(alias)}\\b`, "gi")
          : new RegExp(escapeRegex(alias), "g");
        if (pattern.test(text)) {
          text = text.replace(pattern, () => entry.canonical);
          appliedTerms.push({ matchedAlias: alias, canonical: entry.canonical });
        }
      }
    }

    return {
      normalizedTranscript: text,
      appliedTerms,
      dictionaryVersion: dict.version,
    };
  }
}
