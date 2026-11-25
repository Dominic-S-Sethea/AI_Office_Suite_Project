import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync, unzipSync } from "fflate";
import {
  detectChromiumBinary,
  DocxImportError,
  exportToDocxBuffer,
  exportToPdfBuffer,
  importFromDocxBuffer,
  renderDocumentScreenshot,
} from "@ai-office-suite/file-conversion";
import { getBlockPlainText } from "@ai-office-suite/document-engine";
import { buildBilingualManagementReportFixture } from "./fixtures/bilingual-management-report.ts";
import {
  buildFormalBilingualLetterFixture,
  buildLandscapeOperationsFixture,
} from "./fixtures/g1-pagination-fixtures.ts";

describe("D1.01, D1.03 & G1 — DOCX Round-Trip, Security Hardening, Pagination & HarfBuzz Visual Renders", () => {
  it("exports bilingual EN/KM fixture to valid OOXML DOCX with Complex Script Khmer fonts and re-imports without Khmer Unicode loss", async () => {
    const doc = buildBilingualManagementReportFixture();
    const docxBuffer = await exportToDocxBuffer(doc);
    expect(docxBuffer.byteLength).toBeGreaterThan(3000);

    const artifactsDir = path.resolve(process.cwd(), "tests", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "bilingual-management-report.docx"), docxBuffer);

    const entries = unzipSync(docxBuffer);
    expect(entries["word/document.xml"]).toBeDefined();
    const docXml = Buffer.from(entries["word/document.xml"]!).toString("utf8");
    expect(docXml).toContain("Noto Sans Khmer");
    expect(docXml).toContain("របាយការណ៍គ្រប់គ្រងប្រចាំខែវិច្ឆិកា");

    const imported = await importFromDocxBuffer({
      buffer: docxBuffer,
      filename: "bilingual-management-report.docx",
      tenantId: doc.tenantId,
      workspaceId: doc.workspaceId,
      actorId: "user_test",
    });

    const allImportedText = imported.document.blocks.map(getBlockPlainText).join("\n");
    expect(allImportedText).toContain("របាយការណ៍គ្រប់គ្រងប្រចាំខែវិច្ឆិកា ឆ្នាំ២០២៦");
    expect(allImportedText).toContain("ព្រះរាជាណាចក្រកម្ពុជា");
    expect(allImportedText).toContain("Executive Summary — Phnom Penh Operations");
    expect(imported.diagnostics.macrosBlocked).toBe(false);
    expect(imported.diagnostics.originalSha256).toHaveLength(64);
  });

  it("blocks macro-enabled, encrypted OLE2, and path-traversal DOCX uploads; warns on external relationships & SmartArt", async () => {
    const doc = buildBilingualManagementReportFixture();
    const cleanDocx = await exportToDocxBuffer(doc);

    // 1. Macro part blocked
    const entries = unzipSync(cleanDocx);
    entries["word/vbaProject.bin"] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
    await expect(
      importFromDocxBuffer({
        buffer: zipSync(entries),
        filename: "malicious.docx",
        tenantId: "t1",
        workspaceId: "w1",
        actorId: "u1",
      }),
    ).rejects.toMatchObject({ code: "MACRO_CONTENT_BLOCKED" } satisfies Partial<DocxImportError>);

    // 2. OLE2 encrypted file blocked
    const ole2Magic = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    await expect(
      importFromDocxBuffer({
        buffer: ole2Magic,
        filename: "encrypted.docx",
        tenantId: "t1",
        workspaceId: "w1",
        actorId: "u1",
      }),
    ).rejects.toMatchObject({ code: "ENCRYPTED_FILE_UNSUPPORTED" } satisfies Partial<DocxImportError>);

    // 3. ZIP path traversal blocked
    const traversalEntries = unzipSync(cleanDocx);
    traversalEntries["../evil.xml"] = Buffer.from("<evil/>");
    await expect(
      importFromDocxBuffer({
        buffer: zipSync(traversalEntries),
        filename: "traversal.docx",
        tenantId: "t1",
        workspaceId: "w1",
        actorId: "u1",
      }),
    ).rejects.toMatchObject({ code: "ZIP_PATH_TRAVERSAL_BLOCKED" } satisfies Partial<DocxImportError>);

    // 4. SmartArt + content control + External relationship flagged without fetching
    const extras = unzipSync(cleanDocx);
    extras["word/diagrams/data1.xml"] = Buffer.from("<dgm:dataModel/>");
    extras["word/_rels/document.xml.rels"] = Buffer.from(
      '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://untrusted.example/probe" TargetMode="External"/></Relationships>',
    );
    const origDocXml = Buffer.from(extras["word/document.xml"]!).toString("utf8");
    extras["word/document.xml"] = Buffer.from(origDocXml.replace("</w:body>", "<w:sdt/></w:body>"));

    const res = await importFromDocxBuffer({
      buffer: zipSync(extras),
      filename: "with-smartart-and-external-rel.docx",
      tenantId: "t1",
      workspaceId: "w1",
      actorId: "u1",
    });
    expect(res.diagnostics.unsupportedFeatures.some((f) => f.includes("SmartArt"))).toBe(true);
    expect(res.diagnostics.unsupportedFeatures.some((f) => f.includes("Structured content controls"))).toBe(true);
    expect(res.diagnostics.unsupportedFeatures.some((f) => f.includes("External relationship"))).toBe(true);
  });

  it("renders 1-page formal letter, multi-page report (>=2 pages), landscape brief, and visual PNG renders via HarfBuzz", async () => {
    const browser = detectChromiumBinary();
    expect(browser).not.toBeNull();

    const artifactsDir = path.resolve(process.cwd(), "tests", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    // Multi-page management report (explicit page break -> >= 2 pages)
    const reportDoc = buildBilingualManagementReportFixture();
    const reportPdf = await exportToPdfBuffer(reportDoc);
    expect(reportPdf.engine).toBe("chromium-harfbuzz");
    expect(reportPdf.pdfBuffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(reportPdf.pageCount).toBeGreaterThanOrEqual(2);
    writeFileSync(path.join(artifactsDir, "bilingual-management-report.pdf"), reportPdf.pdfBuffer);

    // 1-page formal bilingual letter
    const letterDoc = buildFormalBilingualLetterFixture();
    const letterPdf = await exportToPdfBuffer(letterDoc);
    expect(letterPdf.pageCount).toBe(1);
    writeFileSync(path.join(artifactsDir, "formal-bilingual-letter.pdf"), letterPdf.pdfBuffer);

    // Landscape operations brief
    const landscapeDoc = buildLandscapeOperationsFixture();
    const landscapePdf = await exportToPdfBuffer(landscapeDoc);
    expect(landscapePdf.pageCount).toBeGreaterThanOrEqual(2);

    // Visual render PNG screenshots for founder/CTO inspection
    const reportPng = await renderDocumentScreenshot(
      reportDoc,
      path.join(artifactsDir, "bilingual-management-report-render.png"),
    );
    const letterPng = await renderDocumentScreenshot(
      letterDoc,
      path.join(artifactsDir, "formal-letter-render.png"),
    );
    expect(reportPng.byteLength).toBeGreaterThan(10_000);
    expect(letterPng.byteLength).toBeGreaterThan(10_000);
  });
});
