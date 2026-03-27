import {
  textItemSubstringViewportRect,
  viewportRectToPdfBox,
  type PdfPageViewport,
  type PdfTextRun,
  type ViewportRect,
} from "./pdf-geometry";
import type { IssueKind, TextRange } from "./review-types";

function isTextRun(item: unknown): item is PdfTextRun {
  if (typeof item !== "object" || item === null) return false;
  const o = item as Record<string, unknown>;
  return (
    typeof o.str === "string" &&
    Array.isArray(o.transform) &&
    typeof o.width === "number"
  );
}

export function getPageTextItems(items: unknown[]): PdfTextRun[] {
  return items.filter(isTextRun);
}

/**
 * 根据文本项的 (x, y) 坐标还原 PDF 的视觉排版（分行、分段）。
 * 发给 AI 使用，让模型看到接近原版 PDF 的文本格式。
 *
 * 规则：
 *  - Y 坐标变化 > fontSize × 0.3 → 换行
 *  - Y 间距 > fontSize × 1.8 → 段落分隔（空一行）
 *  - 同行内水平间距 > fontSize × 0.3 → 插入空格
 */
export function buildFormattedPageText(items: PdfTextRun[]): string {
  if (items.length === 0) return "";

  const parts: string[] = [];
  let prevY: number | null = null;
  let prevRight: number | null = null;
  let prevFontSize = 12;

  for (const item of items) {
    if (item.str.length === 0) continue;

    const x = item.transform[4];
    const y = item.transform[5];
    const fontSize = Math.hypot(item.transform[0], item.transform[1]) || 12;

    if (prevY !== null) {
      const dy = Math.abs(y - prevY);

      if (dy > Math.min(fontSize, prevFontSize) * 0.3) {
        if (dy > Math.max(fontSize, prevFontSize) * 1.8) {
          parts.push("\n\n");
        } else {
          parts.push("\n");
        }
        prevRight = null;
      } else if (prevRight !== null) {
        const hGap = x - prevRight;
        if (hGap > fontSize * 0.3) {
          parts.push(" ");
        }
      }
    }

    parts.push(item.str);
    prevY = y;
    prevRight = x + item.width;
    prevFontSize = fontSize;
  }

  return parts.join("");
}

export function buildCharToItemMap(items: PdfTextRun[]): {
  text: string;
  charToItem: number[];
} {
  let text = "";
  const charToItem: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const s = items[i].str;
    for (let j = 0; j < s.length; j++) {
      charToItem.push(i);
    }
    text += s;
  }
  return { text, charToItem };
}

/** 每个 text item 在拼接串中的起始字符下标 */
function buildItemCharStarts(items: PdfTextRun[]): number[] {
  const starts: number[] = [];
  let o = 0;
  for (let i = 0; i < items.length; i++) {
    starts.push(o);
    o += items[i].str.length;
  }
  return starts;
}

/** 去掉匹配区间末尾空白，使高亮更贴错误位置 */
function trimRangeEnd(plain: string, start: number, end: number): [number, number] {
  let e = end;
  while (e > start + 1) {
    const ch = plain[e - 1];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\u00a0") {
      e--;
    } else break;
  }
  return [start, e];
}

/** 从修改意见中解析「要删掉/标出的原文片段」（不是替换后的新文） */
function parseDeletionTarget(suggestion: string): string | null {
  const del = suggestion.match(/删除[^：:\n]*[：:]\s*(.+?)(?:\s*$|。|\.|；|;|\n)/);
  if (!del?.[1]) return null;
  const t = del[1].trim().replace(/^[`「"'【]|['」"\]`】]$/g, "");
  return t.length > 0 ? t : null;
}

/** 扫描件常见拉丁/竖线混淆，仅多生成几种摘录候选，仍须与 text 完全一致才能命中 */
function ocrConfusionVariants(s: string): string[] {
  const out: string[] = [];
  const a = s.replace(/\|/g, "l");
  const b = s.replace(/l/g, "|");
  const c = s.replace(/\|/g, "I");
  if (a !== s) out.push(a);
  if (b !== s) out.push(b);
  if (c !== s) out.push(c);
  return out;
}

/**
 * 搜索顺序：**先摘录（及 OCR 变体）锚定**，再尝试删除目标串。
 * 避免「删除字符：l」先于摘录匹配到全页第一个 l；不把「替换为：」后的新文当作搜索串。
 */
type ExcerptCandidateKind =
  | "exact"
  | "trimmed"
  | "wsNorm"
  | "noWs"
  | "ocr"
  | "delete";

type ExcerptCandidate = {
  text: string;
  kind: ExcerptCandidateKind;
};

function buildExcerptSearchCandidates(issue: IssueInput): ExcerptCandidate[] {
  const list: ExcerptCandidate[] = [];
  const ex = issue.excerpt?.trim() ?? "";
  if (ex) {
    list.push({ text: ex, kind: "exact" });
    const wsNorm = ex.replace(/\s+/g, " ").trim();
    if (wsNorm !== ex) list.push({ text: wsNorm, kind: "wsNorm" });
    const trimmed = issue.excerpt ?? "";
    if (trimmed.trim() !== trimmed && trimmed.trim()) {
      list.push({ text: trimmed.trim(), kind: "trimmed" });
    }
    const noWs = ex.replace(/\s+/g, "");
    if (noWs !== ex && noWs !== wsNorm) list.push({ text: noWs, kind: "noWs" });
    for (const v of ocrConfusionVariants(ex)) {
      if (v.replace(/\s+/g, " ") !== ex.replace(/\s+/g, " ")) {
        list.push({ text: v, kind: "ocr" });
      }
    }
  }
  const sug = issue.suggestion?.trim() ?? "";
  const del = sug ? parseDeletionTarget(sug) : null;
  if (del && del.length <= 40) list.push({ text: del, kind: "delete" });

  const uniq = new Map<string, ExcerptCandidate>();
  for (const item of list) {
    if (!item.text) continue;
    const key = `${item.kind}\u0000${item.text}`;
    if (!uniq.has(key)) uniq.set(key, item);
  }
  return [...uniq.values()];
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 模型可选返回 textRange；仅当与 excerpt 在正文串上可对齐时才采用，否则回退摘录搜索。
 */
function tryIssueTextRange(plain: string, excerpt: string, range: TextRange): [number, number] | null {
  const ex = excerpt.trim();
  if (!ex) return null;
  let start = Math.max(0, Math.min(plain.length, Math.floor(range.start)));
  let end = Math.max(0, Math.min(plain.length, Math.floor(range.end)));
  if (start >= end) return null;
  [, end] = trimRangeEnd(plain, start, end);
  if (start >= end) return null;
  const sub = plain.slice(start, end);
  if (sub === ex) return [start, end];
  if (normalizeWs(sub) === normalizeWs(ex)) return [start, end];
  const rel = sub.indexOf(ex);
  if (rel >= 0) {
    const s0 = start + rel;
    const e0 = s0 + ex.length;
    return trimRangeEnd(plain, s0, e0);
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, pos);
    if (i < 0) break;
    n++;
    pos = i + Math.max(1, needle.length);
  }
  return n;
}

export function findExcerptRange(plain: string, excerpt: string): [number, number] | null {
  const candidates = [
    excerpt,
    excerpt.trim(),
    excerpt.replace(/\s+/g, " ").trim(),
  ];
  for (const c of candidates) {
    if (!c) continue;
    /** 极短串在全页多次出现时拒绝匹配，防止高亮飘到无关处 */
    if (c.length <= 2 && countOccurrences(plain, c) > 1) continue;
    const idx = plain.indexOf(c);
    if (idx >= 0) {
      let end = idx + c.length;
      [, end] = trimRangeEnd(plain, idx, end);
      return [idx, end];
    }
  }
  return null;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, pos);
    if (i < 0) break;
    out.push(i);
    pos = i + 1;
  }
  return out;
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length) {
    if (a[a.length - 1 - n] !== b[b.length - 1 - n]) break;
    n++;
  }
  return n;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length) {
    if (a[n] !== b[n]) break;
    n++;
  }
  return n;
}

function candidateBaseScore(kind: ExcerptCandidateKind): number {
  switch (kind) {
    case "exact":
      return 1200;
    case "trimmed":
      return 1140;
    case "wsNorm":
      return 1080;
    case "noWs":
      return 980;
    case "ocr":
      return 900;
    case "delete":
      return 760;
  }
}

function scoreOccurrence(
  plain: string,
  issue: IssueInput,
  candidate: ExcerptCandidate,
  occurrenceCount: number,
  start: number,
): number {
  const text = candidate.text;
  const end = start + text.length;
  const matched = plain.slice(start, end);
  const excerpt = issue.excerpt?.trim() ?? "";
  const del = issue.suggestion ? parseDeletionTarget(issue.suggestion) : null;

  let score = candidateBaseScore(candidate.kind);
  score += Math.min(text.length, 60) * 4;

  if (excerpt && matched === excerpt) score += 240;
  if (excerpt && normalizeWs(matched) === normalizeWs(excerpt)) score += 120;
  if (excerpt && matched.replace(/\s+/g, "") === excerpt.replace(/\s+/g, "")) score += 80;

  if (del && matched.includes(del)) score += 140;
  if (candidate.kind === "delete" && del === matched) score += 80;

  if (occurrenceCount === 1) {
    score += 80;
  } else {
    score -= Math.min(occurrenceCount - 1, 8) * 18;
  }

  if (excerpt && excerpt.includes(text)) {
    const rel = excerpt.indexOf(text);
    const expectedLeft = excerpt.slice(Math.max(0, rel - 8), rel);
    const expectedRight = excerpt.slice(rel + text.length, rel + text.length + 8);
    const actualLeft = plain.slice(Math.max(0, start - 8), start);
    const actualRight = plain.slice(end, Math.min(plain.length, end + 8));
    score += commonSuffixLen(actualLeft, expectedLeft) * 24;
    score += commonPrefixLen(actualRight, expectedRight) * 24;
  }

  // 位置只作为弱 tie-breaker，避免重复命中时随机落到后文。
  score -= start / Math.max(plain.length, 1);
  return score;
}

type ScoredOccurrence = {
  candidate: ExcerptCandidate;
  start: number;
  end: number;
  score: number;
  occurrenceCount: number;
  matched: string;
};

function excerptLogPreview(s: string, max = 24): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`;
}

function logExcerptMatchDebug(
  issue: IssueInput,
  best: ScoredOccurrence | null,
  ranked: ScoredOccurrence[],
): void {
  const top = ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x, i) => ({
      rank: i + 1,
      candidateKind: x.candidate.kind,
      candidate: excerptLogPreview(x.candidate.text),
      matched: excerptLogPreview(x.matched),
      start: x.start,
      end: x.end,
      score: Math.round(x.score * 100) / 100,
      occurrenceCount: x.occurrenceCount,
    }));

  console.log("[excerpt-match] issue:", {
    excerpt: excerptLogPreview(issue.excerpt ?? ""),
    suggestion: excerptLogPreview(issue.suggestion ?? ""),
    reason: excerptLogPreview(issue.reason ?? ""),
  });
  if (best) {
    console.log("[excerpt-match] best:", {
      candidateKind: best.candidate.kind,
      candidate: excerptLogPreview(best.candidate.text),
      matched: excerptLogPreview(best.matched),
      start: best.start,
      end: best.end,
      score: Math.round(best.score * 100) / 100,
      occurrenceCount: best.occurrenceCount,
    });
  } else {
    console.log("[excerpt-match] best: none");
  }
  console.table(top);
}

function findBestExcerptRange(
  plain: string,
  issue: IssueInput,
): [number, number] | null {
  let best: ScoredOccurrence | null = null;
  const ranked: ScoredOccurrence[] = [];

  for (const candidate of buildExcerptSearchCandidates(issue)) {
    const c = candidate.text;
    if (!c) continue;
    const positions = findAllOccurrences(plain, c);
    if (positions.length === 0) continue;

    if (c.length <= 2 && positions.length > 1 && candidate.kind !== "delete") {
      continue;
    }

    for (const idx of positions) {
      let end = idx + c.length;
      [, end] = trimRangeEnd(plain, idx, end);
      const score = scoreOccurrence(plain, issue, candidate, positions.length, idx);
      const scored: ScoredOccurrence = {
        candidate,
        start: idx,
        end,
        score,
        occurrenceCount: positions.length,
        matched: plain.slice(idx, end),
      };
      ranked.push(scored);
      if (!best || score > best.score) {
        best = scored;
      }
    }
  }

  logExcerptMatchDebug(issue, best, ranked);
  return best ? [best.start, best.end] : null;
}

/** 单字符 OCR 混淆：删除目标写「l」时，正文中可能是竖线等 */
function ocrPeerChars(ch: string): string[] {
  const u = ch.toLowerCase();
  if (u === "l") return ["|", "｜", "I", "l", "L"];
  if (ch === "|" || ch === "｜") return ["l", "L", "|", "｜", "I"];
  if (u === "i") return ["l", "|", "｜", "I", "i"];
  return [ch];
}

/**
 * 在已锚定的 [start,end) 内，用「删除字符：…」收窄到真正要标出的几个字。
 */
function narrowRangeByDeletionSuggestion(
  plain: string,
  start: number,
  end: number,
  suggestion: string | undefined
): [number, number] {
  const del = suggestion ? parseDeletionTarget(suggestion) : null;
  if (!del || del.length === 0 || del.length > 40) return [start, end];
  const seg = plain.slice(start, end);
  let idx = seg.indexOf(del);
  if (idx < 0 && del.length === 1) {
    for (const p of ocrPeerChars(del)) {
      const j = seg.indexOf(p);
      if (j >= 0) {
        idx = j;
        break;
      }
    }
  }
  if (idx >= 0) {
    const s0 = start + idx;
    const span = Math.min(del.length, seg.length - idx);
    const e0 = s0 + span;
    return trimRangeEnd(plain, s0, e0);
  }
  return [start, end];
}

export type MatchedHighlight = {
  excerpt: string;
  reason: string;
  suggestion?: string;
  kind: IssueKind;
  viewportRects: ViewportRect[];
  pdfBoxes: { minX: number; maxX: number; minY: number; maxY: number }[];
};

export type IssueInput = {
  excerpt: string;
  reason: string;
  suggestion?: string;
  kind: IssueKind;
  textRange?: TextRange;
};

/* ---------- 仅返回字符区间（屏幕定位走 DOM Range） ---------- */

export type MatchedIssueRange = {
  excerpt: string;
  reason: string;
  suggestion?: string;
  kind: IssueKind;
  charRange: [number, number] | null;
};

export function resolveIssueCharRange(
  text: string,
  issue: IssueInput,
): [number, number] | null {
  let range: [number, number] | null = null;
  if (issue.textRange) {
    range = tryIssueTextRange(text, issue.excerpt, issue.textRange);
  }
  if (!range) {
    range = findBestExcerptRange(text, issue);
  }
  if (range) {
    const [s, e] = narrowRangeByDeletionSuggestion(text, range[0], range[1], issue.suggestion);
    range = [s, e];
  }
  return range;
}

export function matchIssuesToCharRanges(
  text: string,
  issues: IssueInput[],
): MatchedIssueRange[] {
  return issues.map((issue) => ({
    excerpt: issue.excerpt,
    reason: issue.reason,
    suggestion: issue.suggestion,
    kind: issue.kind,
    charRange: resolveIssueCharRange(text, issue),
  }));
}

/* ---------- charRange → PDF 坐标（导出用，无需 DOM / viewport） ---------- */

/**
 * 直接从 text item 的 transform 和 width 计算 PDF 用户空间坐标。
 * pdf.js getTextContent() 返回的 item.width 已经是用户空间值（含字体大小），
 * 无需再经 viewport 变换，避免二次缩放导致坐标偏移。
 */
export function charRangeToPdfBoxes(
  items: PdfTextRun[],
  charRange: [number, number],
): { minX: number; maxX: number; minY: number; maxY: number }[] {
  const itemStarts = buildItemCharStarts(items);
  const [start, end] = charRange;
  const boxes: { minX: number; maxX: number; minY: number; maxY: number }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const is_ = itemStarts[i];
    const ie = is_ + item.str.length;
    const segStart = Math.max(start, is_);
    const segEnd = Math.min(end, ie);
    if (segStart >= segEnd) continue;

    const len = item.str.length;
    if (len === 0) continue;

    const frac0 = (segStart - is_) / len;
    const frac1 = (segEnd - is_) / len;

    const t = item.transform;
    const fontSize = Math.hypot(t[0], t[1]) || 12;

    // item.width 已在用户空间（含字体大小）
    const totalW = item.width > 0 ? item.width : len * fontSize * 0.5;

    // 文字推进方向（水平 LTR 时 dirX≈1, dirY≈0）
    const dirX = t[0] / fontSize;
    const dirY = t[1] / fontSize;

    // 垂直方向（CJK 水平排版：perpX≈0, perpY≈1，即 PDF Y+ 向上）
    const perpX = -dirY;
    const perpY = dirX;

    const off0 = totalW * frac0;
    const off1 = totalW * frac1;

    const ascent = fontSize * 0.85;
    const descent = fontSize * 0.15;

    // 四角坐标
    const corners = [
      [t[4] + dirX * off0 - perpX * descent, t[5] + dirY * off0 - perpY * descent],
      [t[4] + dirX * off0 + perpX * ascent, t[5] + dirY * off0 + perpY * ascent],
      [t[4] + dirX * off1 - perpX * descent, t[5] + dirY * off1 - perpY * descent],
      [t[4] + dirX * off1 + perpX * ascent, t[5] + dirY * off1 + perpY * ascent],
    ];

    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    if (maxX > minX && maxY > minY) {
      boxes.push({ minX, maxX, minY, maxY });
    }
  }
  return boxes;
}

/* ---------- 旧版：变换矩阵几何（仅 PDF 导出使用） ---------- */

export function matchIssuesToHighlights(
  items: PdfTextRun[],
  viewport: PdfPageViewport,
  issues: IssueInput[],
): MatchedHighlight[] {
  const { text } = buildCharToItemMap(items);
  const itemStarts = buildItemCharStarts(items);

  return issues.map((issue) => {
    const range = resolveIssueCharRange(text, issue);
    if (!range) {
      return {
        excerpt: issue.excerpt,
        reason: issue.reason,
        suggestion: issue.suggestion,
        kind: issue.kind,
        viewportRects: [],
        pdfBoxes: [],
      };
    }
    const [start, end] = range;

    const viewportRects: ViewportRect[] = [];
    const pdfBoxes: { minX: number; maxX: number; minY: number; maxY: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      const is = itemStarts[i];
      const ie = is + items[i].str.length;
      const segStart = Math.max(start, is);
      const segEnd = Math.min(end, ie);
      if (segStart >= segEnd) continue;

      const ls = segStart - is;
      const le = segEnd - is;
      const vr = textItemSubstringViewportRect(items[i], viewport, ls, le);
      if (vr && vr.w > 0 && vr.h > 0) {
        viewportRects.push(vr);
        pdfBoxes.push(viewportRectToPdfBox(viewport, vr));
      }
    }

    return {
      excerpt: issue.excerpt,
      reason: issue.reason,
      suggestion: issue.suggestion,
      kind: issue.kind,
      viewportRects,
      pdfBoxes,
    };
  });
}
