import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  PDFHexString,
} from "pdf-lib";
import type { IssueKind } from "./review-types";

export type PageAnnotation = {
  pageIndex: number;
  label: string;
  kind: IssueKind;
  pdfBox: { minX: number; maxX: number; minY: number; maxY: number };
};

export type NoteLine = {
  pageIndex: number;
  label: string;
  kind: IssueKind;
  excerpt: string;
  suggestion: string;
  reason: string;
};

function kindLabelZh(kind: IssueKind): string {
  return kind === "error" ? "确定错误" : "疑似错误";
}

function highlightColor(kind: IssueKind): number[] {
  return kind === "error" ? [1, 0.2, 0.2] : [0.2, 0.5, 1];
}

function buildCommentText(note: NoteLine): string {
  const parts: string[] = [`[${note.label}] ${kindLabelZh(note.kind)}`];
  if (note.excerpt) parts.push(`摘录：${note.excerpt}`);
  if (note.suggestion) parts.push(`修改：${note.suggestion}`);
  if (note.reason) parts.push(`说明：${note.reason}`);
  return parts.join("\n");
}

/**
 * 创建原生 PDF Highlight 批注。
 * PDF 阅读器（WPS / Adobe Reader / Foxit 等）在「批注模式」下显示批注内容，
 * 普通模式下只显示高亮。
 */
export async function buildReviewedPdf(
  originalBytes: ArrayBuffer,
  annotations: PageAnnotation[],
  notes: NoteLine[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(originalBytes.slice(0), {
    ignoreEncryption: true,
  });
  const pages = doc.getPages();
  const context = doc.context;

  const annByPage = new Map<number, PageAnnotation[]>();
  for (const a of annotations) {
    const list = annByPage.get(a.pageIndex) ?? [];
    list.push(a);
    annByPage.set(a.pageIndex, list);
  }

  const noteMap = new Map<string, NoteLine>();
  for (const n of notes) noteMap.set(`${n.pageIndex}:${n.label}`, n);

  for (const [pageIndex, pageAnns] of annByPage) {
    const page = pages[pageIndex];
    if (!page) continue;

    const groups = new Map<
      string,
      { boxes: PageAnnotation["pdfBox"][]; kind: IssueKind }
    >();
    for (const ann of pageAnns) {
      const g = groups.get(ann.label);
      if (g) {
        g.boxes.push(ann.pdfBox);
      } else {
        groups.set(ann.label, { boxes: [ann.pdfBox], kind: ann.kind });
      }
    }

    const pageNode = page.node;
    const existing = pageNode.lookup(PDFName.of("Annots"));
    const annotsArr: PDFArray =
      existing instanceof PDFArray
        ? existing
        : (context.obj([]) as unknown as PDFArray);
    if (!(existing instanceof PDFArray)) {
      pageNode.set(PDFName.of("Annots"), annotsArr);
    }

    for (const [label, { boxes, kind }] of groups) {
      let rMinX = Infinity,
        rMinY = Infinity,
        rMaxX = -Infinity,
        rMaxY = -Infinity;
      const qp: number[] = [];

      for (const b of boxes) {
        rMinX = Math.min(rMinX, b.minX);
        rMinY = Math.min(rMinY, b.minY);
        rMaxX = Math.max(rMaxX, b.maxX);
        rMaxY = Math.max(rMaxY, b.maxY);
        qp.push(
          b.minX, b.maxY, b.maxX, b.maxY,
          b.minX, b.minY, b.maxX, b.minY,
        );
      }

      const note = noteMap.get(`${pageIndex}:${label}`);
      const contents = note
        ? buildCommentText(note)
        : `[${label}] ${kindLabelZh(kind)}`;

      const annot = context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: [rMinX - 1, rMinY - 1, rMaxX + 1, rMaxY + 1],
        QuadPoints: qp,
        C: highlightColor(kind),
        CA: 0.35,
        F: 4,
      }) as PDFDict;
      annot.set(PDFName.of("T"), PDFHexString.fromText("AI审稿"));
      annot.set(PDFName.of("Contents"), PDFHexString.fromText(contents));

      annotsArr.push(context.register(annot));
    }
  }

  console.log(
    `[buildReviewedPdf] created ${[...annByPage.values()].reduce((s, a) => s + new Set(a.map((x) => x.label)).size, 0)} highlight annotations`,
  );

  return doc.save({ useObjectStreams: false });
}
