import { describe, expect, it } from "vitest";
import {
  analyzeKhmerText,
  normalizeDocumentText,
  previewDocumentOperation,
  segmentKhmerGraphemes,
  segmentKhmerWords,
  snapRangeToGraphemeBoundaries,
} from "@ai-office-suite/document-engine";
import { buildBilingualManagementReportFixture } from "./fixtures/bilingual-management-report.ts";

describe("D1.03 — Khmer Typography, Grapheme Integrity & Bilingual Segmentation", () => {
  it("analyzes Khmer subscript consonants (coeng), dependent vowels, and mixed numerals accurately", () => {
    const fixture = buildBilingualManagementReportFixture();
    const coengPara = fixture.blocks.find((b) => b.id === "blk_coeng_clusters");
    expect(coengPara?.type).toBe("paragraph");
    const text = coengPara && coengPara.type === "paragraph" ? coengPara.runs.map((r) => r.text).join("") : "";

    const analysis = analyzeKhmerText(text);
    expect(analysis.khmerCodePoints).toBeGreaterThan(40);
    expect(analysis.coengSubscriptCount).toBeGreaterThanOrEqual(8);
    expect(analysis.dependentVowelCount).toBeGreaterThanOrEqual(10);
    expect(analysis.khmerNumeralCount).toBe(4); // ២០២៦
    expect(analysis.arabicNumeralCount).toBe(4); // 2026
    expect(analysis.danglingCoengCount).toBe(0);
  });

  it("segments continuous Khmer paragraphs into linguistic words without whitespace via Intl.Segmenter", () => {
    const fixture = buildBilingualManagementReportFixture();
    const longPara = fixture.blocks.find((b) => b.id === "blk_long_khmer_para");
    const text = longPara && longPara.type === "paragraph" ? longPara.runs.map((r) => r.text).join("") : "";

    const words = segmentKhmerWords(text);
    const graphemes = segmentKhmerGraphemes(text);
    expect(words.length).toBeGreaterThan(15);
    expect(graphemes.length).toBeGreaterThan(40);
    expect(text.includes(" ")).toBe(false); // proves zero ASCII spaces in continuous Khmer paragraph
  });

  it("never splits inside a Khmer coeng subscript cluster during programmatic edit range snapping", () => {
    const sample = normalizeDocumentText("ក្រុមហ៊ុនកម្ពុជា");
    // Index 1 falls right before U+17D2 COENG inside "ក្រុ" — snapping must expand/align to grapheme boundary
    const snapped = snapRangeToGraphemeBoundaries(sample, 1, 2);
    const graphemes = segmentKhmerGraphemes(sample);
    const firstCluster = graphemes[0]!.segment;
    expect(snapped.start).toBe(0);
    expect(snapped.end).toBeGreaterThanOrEqual(firstCluster.length);

    // Inserting at snapped offset preserves zero dangling coengs
    const doc = buildBilingualManagementReportFixture();
    const { nextDoc } = previewDocumentOperation(doc, {
      expectedRevision: 1,
      selection: { blockId: "blk_coeng_clusters", startOffset: 1, endOffset: 1 },
      action: "insert_text",
      params: { text: " [សាកល្បង]" },
    });
    const editedBlock = nextDoc.blocks.find((b) => b.id === "blk_coeng_clusters");
    const editedText =
      editedBlock && editedBlock.type === "paragraph"
        ? editedBlock.runs.map((r) => r.text).join("")
        : "";
    expect(analyzeKhmerText(editedText).danglingCoengCount).toBe(0);
  });
});
