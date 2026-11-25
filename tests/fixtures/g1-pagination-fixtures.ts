import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import { buildBilingualManagementReportFixture } from "./bilingual-management-report.ts";

/** 1-page formal bilingual corporate letter (A4 Portrait). */
export function buildFormalBilingualLetterFixture(): StudioDocument {
  const now = "2026-11-26T00:00:00.000Z";
  return {
    documentId: "doc_formal_letter_01",
    tenantId: "tenant_demo_sme",
    workspaceId: "ws_corporate_hq",
    title: "លិខិតផ្លូវការ · Formal Administration Letter",
    language: "bilingual",
    revision: 1,
    status: "draft",
    layout: {
      size: "A4",
      orientation: "portrait",
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      headerText: "Phnom Penh Corporate Headquarters · AI Office Suite",
      footerText: "Ref: ADM-2026-11-008 · ឯកសារផ្លូវការ",
      showPageNumbers: true,
    },
    blocks: [
      {
        id: "ltr_h1",
        type: "heading",
        level: 1,
        alignment: "center",
        runs: [
          {
            text: "ព្រះរាជាណាចក្រកម្ពុជា · Kingdom of Cambodia",
            marks: { bold: true, fontFamily: "Kantumruy Pro", fontSizePt: 16 },
          },
        ],
      },
      {
        id: "ltr_subject",
        type: "heading",
        level: 2,
        alignment: "left",
        runs: [
          {
            text: "កម្មវត្ថុ៖ សេចក្តីជូនដំណឹងស្តីពីការបិទបញ្ជីប្រចាំខែវិច្ឆិកា ឆ្នាំ២០២៦",
            marks: { bold: true, fontFamily: "Noto Sans Khmer", fontSizePt: 13 },
          },
        ],
      },
      {
        id: "ltr_body_km",
        type: "paragraph",
        alignment: "justify",
        runs: [
          {
            text: "សូមជម្រាបជូនប្រធាននាយកដ្ឋានហិរញ្ញវត្ថុ និងរដ្ឋបាលទាំងអស់មេត្តាជ្រាបថា ការបញ្ជូនរបាយការណ៍ចំណូល និងចំណាយប្រចាំខែវិច្ឆិកា ត្រូវបញ្ចប់ត្រឹមថ្ងៃទី៣០ ខែវិច្ឆិកា ឆ្នាំ២០២៦ វេលាម៉ោង ១៧:០០ នាទី។",
            marks: { fontFamily: "Noto Sans Khmer", fontSizePt: 11 },
          },
        ],
      },
      {
        id: "ltr_body_en",
        type: "paragraph",
        alignment: "left",
        runs: [
          {
            text: "All departmental managers are kindly requested to submit verified expense schedules and reconciliation notes by 30 November 2026 at 17:00 ICT.",
            marks: { fontFamily: "Inter", fontSizePt: 11 },
          },
        ],
      },
      {
        id: "ltr_sign",
        type: "paragraph",
        alignment: "right",
        runs: [
          {
            text: "Phnom Penh, 26 November 2026\nនាយកដ្ឋានរដ្ឋបាល · Administration Director",
            marks: { bold: true, fontFamily: "Noto Sans Khmer", fontSizePt: 11 },
          },
        ],
      },
    ],
    createdBy: "user_demo_editor",
    createdAt: now,
    updatedAt: now,
  };
}

/** Landscape bilingual operations schedule (A4 Landscape). */
export function buildLandscapeOperationsFixture(): StudioDocument {
  const base = buildBilingualManagementReportFixture();
  return {
    ...base,
    documentId: "doc_landscape_ops_01",
    title: "Landscape Operations Brief · របាយការណ៍ប្រតិបត្តិការ",
    layout: {
      ...base.layout,
      size: "A4",
      orientation: "landscape",
      headerText: "Operations Schedule (A4 Landscape) · AI Office Suite",
    },
  };
}
