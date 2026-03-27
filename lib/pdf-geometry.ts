/**
 * 不直接 import pdfjs-dist，避免与 react-pdf 嵌套的 pdfjs 在 Webpack 中双实例导致
 * “Object.defineProperty called on non-object”（见 pdf.mjs 初始化）。
 */

/** 与 pdf.js getTextContent 条目一致的最小形状 */
export type PdfTextRun = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

/** 仅需 textItemToViewportRect / viewportRectToPdfBox 用到的 viewport 能力 */
export type PdfPageViewport = {
  transform: number[];
  /** pdf.js 返回 number[]，与元组在结构上兼容 */
  convertToPdfPoint: (x: number, y: number) => number[];
};

export type ViewportRect = { x: number; y: number; w: number; h: number };

/** 与 pdfjs Util.transform 一致：6 元仿射矩阵乘法（m1 × m2） */
export function multiplyPdfTransforms(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function textItemToViewportRect(
  item: PdfTextRun,
  viewport: PdfPageViewport
): ViewportRect {
  const tx = multiplyPdfTransforms(viewport.transform, item.transform);
  const fontHeight = Math.hypot(tx[2], tx[3]) || 12;
  const widthScale = Math.hypot(tx[0], tx[1]) || 1;
  const w = Math.max(item.width * widthScale, 1);
  const h = Math.max(
    item.height ? Math.abs(item.height * tx[3]) : fontHeight,
    fontHeight * 0.85
  );
  const x = tx[4];
  const y = tx[5] - h * 0.85;
  return { x, y, w, h };
}

/**
 * 同一 text item 内按字符下标截取水平方向上的窄框（假设横向 LTR，宽度按字符数比例切分）。
 * 用于避免「一个 item 含整段」时整块高亮盖住半页。
 */
export function textItemSubstringViewportRect(
  item: PdfTextRun,
  viewport: PdfPageViewport,
  startChar: number,
  endChar: number
): ViewportRect | null {
  const len = item.str.length;
  if (len === 0 || startChar >= endChar) return null;
  const s = Math.max(0, Math.min(len, startChar));
  const e = Math.max(s, Math.min(len, endChar));
  if (s >= e) return null;
  const full = textItemToViewportRect(item, viewport);
  const denom = len;
  const frac0 = s / denom;
  const frac1 = e / denom;
  const subW = Math.max(full.w * (frac1 - frac0), 2);
  const subX = full.x + full.w * frac0;
  return { x: subX, y: full.y, w: subW, h: full.h };
}

export function unionViewportRects(rects: ViewportRect[]): ViewportRect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function viewportRectToPdfBox(
  viewport: PdfPageViewport,
  r: ViewportRect
): { minX: number; maxX: number; minY: number; maxY: number } {
  const corners: [number, number][] = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ];
  const pdfPts = corners.map(([vx, vy]) => viewport.convertToPdfPoint(vx, vy));
  const xs = pdfPts.map((p) => p[0]);
  const ys = pdfPts.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}
