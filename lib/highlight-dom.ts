export type ScreenRect = { x: number; y: number; w: number; h: number };
type PointBias = "start" | "end" | "closest";
type CharClientRect = { left: number; right: number; top: number; bottom: number };

const spanCharRectsCache = new WeakMap<HTMLSpanElement, CharClientRect[]>();

/** 遍历 TextLayer 的 span 子元素，返回 (textNode, spanCharStart) 列表 */
function collectTextSpans(
  container: HTMLElement,
): { el: HTMLSpanElement; node: Text; start: number; len: number }[] {
  const spans: { el: HTMLSpanElement; node: Text; start: number; len: number }[] = [];
  let offset = 0;
  for (const el of container.children) {
    if (!(el instanceof HTMLSpanElement)) continue;
    const textNode = el.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
    const len = (textNode.textContent ?? "").length;
    if (len === 0) continue;
    spans.push({ el, node: textNode as Text, start: offset, len });
    offset += len;
  }
  return spans;
}

export function annotateTextLayerCharRanges(textLayerContainer: HTMLElement): void {
  for (const { el, start, len } of collectTextSpans(textLayerContainer)) {
    el.dataset.charStart = String(start);
    el.dataset.charEnd = String(start + len);
  }
}

/**
 * 用浏览器 Range API 从已渲染的 pdf.js TextLayer DOM 中获取精确的字符边界框。
 * charStart/charEnd 对应 getTextContent().items.map(i=>i.str).join("") 的下标。
 */
export function computeDomHighlightRects(
  textLayerContainer: HTMLElement,
  charStart: number,
  charEnd: number,
): ScreenRect[] {
  const containerRect = textLayerContainer.getBoundingClientRect();
  const rects: ScreenRect[] = [];

  for (const { node, start: spanStart, len } of collectTextSpans(textLayerContainer)) {
    const spanEnd = spanStart + len;
    if (spanEnd <= charStart || spanStart >= charEnd) continue;

    const rs = Math.max(0, charStart - spanStart);
    const re = Math.min(len, charEnd - spanStart);

    try {
      const range = document.createRange();
      range.setStart(node, rs);
      range.setEnd(node, re);

      for (const cr of range.getClientRects()) {
        if (cr.width > 0 && cr.height > 0) {
          rects.push({
            x: cr.left - containerRect.left,
            y: cr.top - containerRect.top,
            w: cr.width,
            h: cr.height,
          });
        }
      }
    } catch {
      /* invalid offset — skip */
    }
  }

  return rects;
}

function spanBounds(span: HTMLSpanElement): [number, number] | null {
  const start = Number(span.dataset.charStart);
  const end = Number(span.dataset.charEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return [start, end];
}

function resolveBoundaryCharOffset(node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const span = textNode.parentElement;
    if (!(span instanceof HTMLSpanElement)) return null;
    const bounds = spanBounds(span);
    if (!bounds) return null;
    const [start, end] = bounds;
    return Math.max(start, Math.min(start + offset, end));
  }

  if (node instanceof HTMLSpanElement) {
    const bounds = spanBounds(node);
    if (!bounds) return null;
    const [start, end] = bounds;
    return offset <= 0 ? start : end;
  }

  return null;
}

function spanAtPoint(
  textLayerContainer: HTMLElement,
  clientX: number,
  clientY: number,
): HTMLSpanElement | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (el instanceof HTMLSpanElement && textLayerContainer.contains(el)) {
      return el;
    }
  }
  return null;
}

function charOffsetInSpanByPoint(
  span: HTMLSpanElement,
  clientX: number,
  bias: PointBias,
): number | null {
  const bounds = spanBounds(span);
  if (!bounds) return null;
  const [start, end] = bounds;
  const len = end - start;
  if (len <= 0) return start;

  const textNode = span.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return start;

  const charRects = getCharRectsForSpan(span, textNode, len);

  let firstValid: CharClientRect | null = null;
  let lastValid: CharClientRect | null = null;
  for (const r of charRects) {
    if (Number.isFinite(r.left) && Number.isFinite(r.right)) {
      firstValid ??= r;
      lastValid = r;
    }
  }
  if (!firstValid || !lastValid) return start;

  if (clientX <= firstValid.left) return start;
  if (clientX >= lastValid.right) return end;

  for (let i = 0; i < charRects.length; i++) {
    const r = charRects[i]!;
    if (!Number.isFinite(r.left) || !Number.isFinite(r.right)) continue;
    if (clientX >= r.left && clientX <= r.right) {
      if (bias === "start") return start + i;
      if (bias === "end") return start + i + 1;
      const mid = (r.left + r.right) / 2;
      return start + (clientX < mid ? i : i + 1);
    }
  }

  for (let i = 0; i < charRects.length - 1; i++) {
    const r0 = charRects[i]!;
    const r1 = charRects[i + 1]!;
    if (
      !Number.isFinite(r0.right) ||
      !Number.isFinite(r1.left)
    ) continue;
    if (clientX > r0.right && clientX < r1.left) {
      if (bias === "start") return start + i + 1;
      if (bias === "end") return start + i + 1;
      const mid = (r0.right + r1.left) / 2;
      return start + (clientX < mid ? i + 1 : i + 1);
    }
  }

  return start;
}

function getCharRectsForSpan(
  span: HTMLSpanElement,
  textNode: Node,
  len: number,
): CharClientRect[] {
  let charRects = spanCharRectsCache.get(span);
  if (!charRects || charRects.length !== len) {
    charRects = [];
    const range = document.createRange();
    for (let i = 0; i < len; i++) {
      try {
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          charRects.push({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          });
        } else {
          charRects.push({
            left: NaN,
            right: NaN,
            top: NaN,
            bottom: NaN,
          });
        }
      } catch {
        charRects.push({
          left: NaN,
          right: NaN,
          top: NaN,
          bottom: NaN,
        });
      }
    }
    spanCharRectsCache.set(span, charRects);
  }
  return charRects;
}

function normalizeScreenRect(rect: ScreenRect): ScreenRect {
  const x = rect.w >= 0 ? rect.x : rect.x + rect.w;
  const y = rect.h >= 0 ? rect.y : rect.y + rect.h;
  const w = Math.abs(rect.w);
  const h = Math.abs(rect.h);
  return { x, y, w, h };
}

export function snapScreenRectToTextRows(
  textLayerContainer: HTMLElement,
  rect: ScreenRect,
): ScreenRect {
  const norm = normalizeScreenRect(rect);
  if (norm.w < 2 || norm.h < 2) return norm;

  const containerRect = textLayerContainer.getBoundingClientRect();
  const left = containerRect.left + norm.x;
  const right = left + norm.w;
  const top = containerRect.top + norm.y;
  const bottom = top + norm.h;

  let minTop = Infinity;
  let maxBottom = -Infinity;

  for (const { el } of collectTextSpans(textLayerContainer)) {
    const r = el.getBoundingClientRect();
    if (
      r.right < left ||
      r.left > right ||
      r.bottom < top ||
      r.top > bottom
    ) {
      continue;
    }
    minTop = Math.min(minTop, r.top);
    maxBottom = Math.max(maxBottom, r.bottom);
  }

  if (!Number.isFinite(minTop) || !Number.isFinite(maxBottom) || maxBottom <= minTop) {
    return norm;
  }

  return {
    x: norm.x,
    y: minTop - containerRect.top,
    w: norm.w,
    h: maxBottom - minTop,
  };
}

function pointInClientRect(x: number, y: number, rect: CharClientRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function screenRectToCharRange(
  textLayerContainer: HTMLElement,
  rect: ScreenRect,
): [number, number] | null {
  const norm = normalizeScreenRect(rect);
  if (norm.w < 2 || norm.h < 2) return null;

  const containerRect = textLayerContainer.getBoundingClientRect();
  const left = containerRect.left + norm.x;
  const right = left + norm.w;
  const top = containerRect.top + norm.y;
  const bottom = top + norm.h;

  let minChar = Infinity;
  let maxChar = -Infinity;

  for (const { el, node, start, len } of collectTextSpans(textLayerContainer)) {
    const spanRect = el.getBoundingClientRect();
    if (
      spanRect.right < left ||
      spanRect.left > right ||
      spanRect.bottom < top ||
      spanRect.top > bottom
    ) {
      continue;
    }

    const charRects = getCharRectsForSpan(el, node, len);
    for (let i = 0; i < charRects.length; i++) {
      const r = charRects[i]!;
      if (!Number.isFinite(r.left) || !Number.isFinite(r.right)) continue;
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      if (pointInClientRect(cx, cy, { left, right, top, bottom })) {
        minChar = Math.min(minChar, start + i);
        maxChar = Math.max(maxChar, start + i + 1);
      }
    }
  }

  if (!Number.isFinite(minChar) || !Number.isFinite(maxChar) || maxChar <= minChar) {
    return null;
  }
  return [minChar, maxChar];
}

export function pointToCharOffset(
  textLayerContainer: HTMLElement,
  clientX: number,
  clientY: number,
  bias: PointBias = "closest",
): number | null {
  const hitSpan = spanAtPoint(textLayerContainer, clientX, clientY);
  if (hitSpan) {
    const hit = charOffsetInSpanByPoint(hitSpan, clientX, bias);
    if (hit !== null) return hit;
  }

  const docWithCaret = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const pos = docWithCaret.caretPositionFromPoint?.(clientX, clientY);
  if (pos && textLayerContainer.contains(pos.offsetNode)) {
    const exact = resolveBoundaryCharOffset(pos.offsetNode, pos.offset);
    if (exact !== null) return exact;
  }

  const caretRange = docWithCaret.caretRangeFromPoint?.(clientX, clientY);
  if (caretRange && textLayerContainer.contains(caretRange.startContainer)) {
    const exact = resolveBoundaryCharOffset(
      caretRange.startContainer,
      caretRange.startOffset,
    );
    if (exact !== null) return exact;
  }

  let best:
    | { start: number; len: number; rect: DOMRect; score: number }
    | null = null;
  for (const { el, start, len } of collectTextSpans(textLayerContainer)) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dx =
      clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy =
      clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const score = dy * 1000 + dx;
    if (!best || score < best.score) best = { start, len, rect, score };
  }
  if (!best) return null;

  const frac = best.rect.width > 0 ? (clientX - best.rect.left) / best.rect.width : 0;
  const raw = frac * best.len;
  const rel =
    bias === "start" ? Math.floor(raw) : bias === "end" ? Math.ceil(raw) : Math.round(raw);
  return best.start + Math.max(0, Math.min(best.len, rel));
}

/**
 * 直接读取浏览器当前 Selection 的可视矩形。
 * 用于“手动新增标注”时的实时黄色预览，避免先转 charRange 再反算导致错位。
 */
export function selectionToScreenRects(
  textLayerContainer: HTMLElement,
  selection: Selection,
): ScreenRect[] {
  if (selection.rangeCount === 0 || selection.isCollapsed) return [];

  const range = selection.getRangeAt(0);
  if (
    !textLayerContainer.contains(range.startContainer) ||
    !textLayerContainer.contains(range.endContainer)
  ) {
    return [];
  }

  const containerRect = textLayerContainer.getBoundingClientRect();
  const rects: ScreenRect[] = [];
  for (const cr of range.getClientRects()) {
    if (cr.width > 0 && cr.height > 0) {
      rects.push({
        x: cr.left - containerRect.left,
        y: cr.top - containerRect.top,
        w: cr.width,
        h: cr.height,
      });
    }
  }
  return rects;
}

/**
 * 将浏览器 Selection（在 TextLayer 内的选区）转换为 flatText 的 [charStart, charEnd)。
 * 返回 null 表示选区不在 textLayerContainer 内或为空。
 */
export function selectionToCharRange(
  textLayerContainer: HTMLElement,
  selection: Selection,
): [number, number] | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!textLayerContainer.contains(range.startContainer) ||
      !textLayerContainer.contains(range.endContainer)) {
    return null;
  }

  try {
    const startProbe = document.createRange();
    startProbe.selectNodeContents(textLayerContainer);
    startProbe.setEnd(range.startContainer, range.startOffset);

    const endProbe = document.createRange();
    endProbe.selectNodeContents(textLayerContainer);
    endProbe.setEnd(range.endContainer, range.endOffset);

    // 不用 range.toString()，因为跨行时浏览器可能注入视觉空白/换行，
    // 会导致字符数和 textContent().items.map(i=>i.str).join("") 不一致。
    const startChar = startProbe.cloneContents().textContent?.length ?? 0;
    const endChar = endProbe.cloneContents().textContent?.length ?? 0;

    if (startChar === endChar) return null;
    return [Math.min(startChar, endChar), Math.max(startChar, endChar)];
  } catch {
    return null;
  }
}
