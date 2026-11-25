import type { TextRun } from "@ai-office-suite/shared-contracts";
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun as DocxTextRun,
  WidthType,
} from "docx";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";

function mapAlignment(align?: string) {
  switch (align) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
      return AlignmentType.RIGHT;
    case "justify":
      return AlignmentType.JUSTIFIED;
    default:
      return AlignmentType.LEFT;
  }
}

function buildDocxRuns(runs: TextRun[]): DocxTextRun[] {
  return runs.map((run) => {
    const fontName = run.marks?.fontFamily ?? "Noto Sans Khmer";
    return new DocxTextRun({
      text: run.text,
      bold: run.marks?.bold,
      italics: run.marks?.italic,
      underline: run.marks?.underline ? {} : undefined,
      color: run.marks?.color?.replace("#", ""),
      size: run.marks?.fontSizePt ? Math.round(run.marks.fontSizePt * 2) : undefined,
      font: {
        ascii: fontName,
        hAnsi: fontName,
        cs: "Noto Sans Khmer",
        eastAsia: fontName,
      },
    });
  });
}

export async function exportToDocxBuffer(doc: StudioDocument): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  for (const block of doc.blocks) {
    if (block.type === "paragraph") {
      children.push(
        new Paragraph({
          alignment: mapAlignment(block.alignment),
          children: buildDocxRuns(block.runs),
          spacing: { after: 140, line: 300 },
        }),
      );
    } else if (block.type === "heading") {
      const headingLevel =
        block.level === 1
          ? HeadingLevel.HEADING_1
          : block.level === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3;
      children.push(
        new Paragraph({
          heading: headingLevel,
          alignment: mapAlignment(block.alignment),
          children: buildDocxRuns(block.runs),
          spacing: { before: 200, after: 120 },
        }),
      );
    } else if (block.type === "bullet_list" || block.type === "ordered_list") {
      for (let i = 0; i < block.items.length; i++) {
        const itemRuns = block.items[i] ?? [{ text: "" }];
        children.push(
          new Paragraph({
            bullet: block.type === "bullet_list" ? { level: 0 } : undefined,
            children:
              block.type === "ordered_list"
                ? [new DocxTextRun({ text: `${i + 1}. ` }), ...buildDocxRuns(itemRuns)]
                : buildDocxRuns(itemRuns),
            spacing: { after: 80 },
          }),
        );
      }
    } else if (block.type === "table") {
      const rows = block.rows.map((row, rowIdx) =>
        new TableRow({
          tableHeader: block.hasHeaderRow && rowIdx === 0,
          children: row.map((cell) =>
            new TableCell({
              shading:
                block.hasHeaderRow && rowIdx === 0
                  ? { type: ShadingType.CLEAR, fill: "E2E8F0" }
                  : undefined,
              children: [
                new Paragraph({
                  children: buildDocxRuns(cell.runs),
                }),
              ],
            }),
          ),
        }),
      );
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows,
        }),
      );
      children.push(new Paragraph({ text: "" }));
    } else if (block.type === "page_break") {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    } else if (block.type === "linked_metric_placeholder") {
      children.push(
        new Paragraph({
          children: [
            new DocxTextRun({
              text: `[Linked Metric (${block.metric.mode}): ${block.metric.displayLabel} = ${block.metric.cachedFormattedValue} · Period: ${block.metric.reportingPeriod}]`,
              italics: true,
              color: "92400E",
            }),
          ],
          spacing: { after: 120 },
        }),
      );
    }
  }

  const mmToTwips = (mm: number) => Math.round((mm / 25.4) * 1440);
  const pageDims =
    doc.layout.size === "Letter"
      ? { width: 12240, height: 15840 }
      : { width: 11906, height: 16838 }; // A4 in twips

  const docxDocument = new Document({
    title: doc.title,
    creator: "AI Office Suite",
    sections: [
      {
        properties: {
          page: {
            size:
              doc.layout.orientation === "landscape"
                ? { width: pageDims.height, height: pageDims.width }
                : pageDims,
            margin: {
              top: mmToTwips(doc.layout.marginsMm.top),
              right: mmToTwips(doc.layout.marginsMm.right),
              bottom: mmToTwips(doc.layout.marginsMm.bottom),
              left: mmToTwips(doc.layout.marginsMm.left),
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new DocxTextRun({ text: doc.layout.headerText, size: 18, color: "64748B" })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new DocxTextRun({ text: `${doc.layout.footerText}   `, size: 18, color: "64748B" }),
                  ...(doc.layout.showPageNumbers
                    ? [
                        new DocxTextRun({ text: "Page ", size: 18, color: "64748B" }),
                        new DocxTextRun({ children: [PageNumber.CURRENT], size: 18, color: "64748B" }),
                        new DocxTextRun({ text: " of ", size: 18, color: "64748B" }),
                        new DocxTextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "64748B" }),
                      ]
                    : []),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(docxDocument);
}
