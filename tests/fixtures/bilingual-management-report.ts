import type { StudioDocument } from "@ai-office-suite/shared-contracts";

export function buildBilingualManagementReportFixture(): StudioDocument {
  const now = "2026-11-26T00:00:00.000Z";
  return {
    documentId: "doc_bilingual_fixture_01",
    tenantId: "tenant_demo_sme",
    workspaceId: "ws_corporate_hq",
    title: "របាយការណ៍គ្រប់គ្រងប្រចាំខែ · Monthly Management Report 2026",
    language: "bilingual",
    revision: 1,
    status: "draft",
    layout: {
      size: "A4",
      orientation: "portrait",
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      headerText: "AI Office Suite · Bilingual Corporate Fixture",
      footerText: "Confidential · ឯកសារសម្ងាត់",
      showPageNumbers: true,
    },
    blocks: [
      {
        id: "blk_km_h1",
        type: "heading",
        level: 1,
        alignment: "left",
        runs: [
          {
            text: "របាយការណ៍គ្រប់គ្រងប្រចាំខែវិច្ឆិកា ឆ្នាំ២០២៦",
            marks: { bold: true, fontFamily: "Kantumruy Pro", fontSizePt: 18 },
          },
        ],
      },
      {
        id: "blk_en_h2",
        type: "heading",
        level: 2,
        alignment: "left",
        runs: [
          {
            text: "Executive Summary — Phnom Penh Operations",
            marks: { bold: true, fontFamily: "Inter", fontSizePt: 14 },
          },
        ],
      },
      {
        id: "blk_coeng_clusters",
        type: "paragraph",
        alignment: "left",
        runs: [
          {
            text: "ពាក្យគំរូដែលមានជើងអក្សរ និងស្រៈផ្សំ៖ ក្រុមហ៊ុន ស្រ្តី ព្រះរាជាណាចក្រកម្ពុជា ប្រសិទ្ធភាព ស្តង់ដារ ការគ្រប់គ្រងហិរញ្ញវត្ថុ ឆ្នាំ២០២៦ (2026)។",
            marks: { fontFamily: "Noto Sans Khmer", fontSizePt: 11 },
          },
        ],
      },
      {
        id: "blk_long_khmer_para",
        type: "paragraph",
        alignment: "justify",
        runs: [
          {
            text: "នាយកដ្ឋានរដ្ឋបាលនិងហិរញ្ញវត្ថុបានអនុវត្តការផ្ទៀងផ្ទាត់ទិន្នន័យចំណូលនិងចំណាយប្រចាំខែវិច្ឆិកាដោយប្រើប្រាស់ប្រព័ន្ធស្វ័យប្រវត្តិកម្មនិងការត្រួតពិនិត្យដោយមនុស្សដើម្បីធានាថាតួលេខទាំងអស់មានភាពត្រឹមត្រូវច្បាស់លាស់និងអាចតាមដានប្រភពបានគ្រប់ពេលវេលា។",
            marks: { fontFamily: "Noto Sans Khmer", fontSizePt: 11 },
          },
        ],
      },
      {
        id: "blk_mixed_numerals",
        type: "paragraph",
        alignment: "left",
        runs: [
          {
            text: "ចំណូលសរុប Total Revenue: $125,450.00 (៥០១,៨០០,០០០ ៛) · Active Branches: ១២ (12) · Variance: +4.8%.",
          },
        ],
      },
      {
        id: "blk_table_bilingual",
        type: "table",
        hasHeaderRow: true,
        rows: [
          [
            { runs: [{ text: "Department / នាយកដ្ឋាន", marks: { bold: true } }] },
            { runs: [{ text: "Budget (USD)", marks: { bold: true } }] },
            { runs: [{ text: "Actual (USD)", marks: { bold: true } }] },
          ],
          [
            { runs: [{ text: "រដ្ឋបាល (Administration)" }] },
            { runs: [{ text: "$15,000.00" }] },
            { runs: [{ text: "$14,250.00" }] },
          ],
          [
            { runs: [{ text: "ហិរញ្ញវត្ថុ (Finance)" }] },
            { runs: [{ text: "$22,000.00" }] },
            { runs: [{ text: "$21,400.00" }] },
          ],
        ],
      },
      {
        id: "blk_metric_d7",
        type: "linked_metric_placeholder",
        metric: {
          datasetId: "ds_sales_2026_11",
          datasetVersion: "v1.0",
          metricId: "m_gross_margin",
          metricVersion: "v1.0",
          reportingPeriod: "2026-11",
          filterContext: { region: "Phnom Penh", currency: "USD" },
          unit: "USD",
          currency: "USD",
          approvalStatus: "certified",
          freshnessTimestamp: now,
          mode: "published_snapshot",
          displayLabel: "Net Operating Profit (Synthetic D7 Placeholder)",
          cachedFormattedValue: "$38,500.00",
        },
      },
      {
        id: "blk_page_break",
        type: "page_break",
      },
      {
        id: "blk_page2_en",
        type: "paragraph",
        alignment: "left",
        runs: [
          {
            text: "Page 2 — Appendix: All figures above are deterministic synthetic fixtures for Phase D1 typography and interoperability testing.",
            marks: { italic: true, fontFamily: "Inter", fontSizePt: 10 },
          },
        ],
      },
    ],
    createdBy: "user_demo_editor",
    createdAt: now,
    updatedAt: now,
  };
}
