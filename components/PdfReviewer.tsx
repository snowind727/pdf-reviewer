"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildReviewedPdf,
  type NoteLine,
  type PageAnnotation,
} from "@/lib/pdf-export";
import {
  loadPdfJsFromPublic,
  type PdfDocumentLike,
  type PdfJsModule,
  type TextLayerInstance,
} from "@/lib/pdfjs-public";
import {
  getPageTextItems,
  buildFormattedPageText,
  matchIssuesToCharRanges,
  charRangeToPdfBoxes,
  resolveIssueCharRange,
} from "@/lib/pdf-text-match";
import type { Annotation, IssueKind, NormalizedReviewIssue } from "@/lib/review-types";
import { copyTextToClipboard } from "@/lib/copy-text";
import {
  annotateTextLayerCharRanges,
  computeDomHighlightRects,
  screenRectToCharRange,
  snapScreenRectToTextRows,
  type ScreenRect,
} from "@/lib/highlight-dom";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ScreenAnnotation = Annotation & { rects: ScreenRect[] };
type ReviewMode = "precise" | "discover-more";

function highlightBgClass(kind: IssueKind): string {
  return kind === "error" ? "bg-red-500/35" : "bg-sky-400/30";
}

function connectorColor(kind: IssueKind): string {
  return kind === "error" ? "#ef4444" : "#38bdf8";
}

function DisclosureSummary({ label }: { label: string }) {
  return (
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-medium text-neutral-600 marker:hidden dark:text-neutral-400">
      <span>{label}</span>
      <span className="text-[11px] text-neutral-400 transition-transform duration-150 group-open:rotate-180 dark:text-neutral-500">
        v
      </span>
    </summary>
  );
}

let _nextId = 0;
function genId(): string {
  return `ann_${Date.now()}_${++_nextId}`;
}

function normalizeRect(rect: ScreenRect): ScreenRect {
  return {
    x: rect.w >= 0 ? rect.x : rect.x + rect.w,
    y: rect.h >= 0 ? rect.y : rect.y + rect.h,
    w: Math.abs(rect.w),
    h: Math.abs(rect.h),
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function PdfReviewer() {
  /* --- PDF file & engine ------------------------------------------ */
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const pdfBytesRef = useRef<ArrayBuffer | null>(null);

  const [pdfjsLib, setPdfjsLib] = useState<PdfJsModule | null>(null);
  const [pdfjsError, setPdfjsError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfDocumentLike | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PdfDocumentLike | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageJumpInput, setPageJumpInput] = useState("1");
  const [scale, setScale] = useState(1.2);

  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });

  /* --- Annotations (unified: AI + manual) ------------------------- */
  const [pageAnnotations, setPageAnnotations] = useState<Record<number, Annotation[]>>({});
  const pageFlatTextRef = useRef<Record<number, string>>({});

  const [textLayerReady, setTextLayerReady] = useState(false);
  const [screenAnnotations, setScreenAnnotations] = useState<ScreenAnnotation[]>([]);

  const [loadingAi, setLoadingAi] = useState(false);
  const [reviewMode, setReviewMode] = useState<ReviewMode>("precise");
  const [batchReviewCount, setBatchReviewCount] = useState(3);
  const [batchReviewProgress, setBatchReviewProgress] = useState<{
    done: number;
    total: number;
    currentPage: number;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* --- Editing state ---------------------------------------------- */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    excerpt: string;
    kind: IssueKind;
    suggestion: string;
    reason: string;
  } | null>(null);

  /* --- Text selection --------------------------------------------- */
  const [liveSelectionRange, setLiveSelectionRange] = useState<[number, number] | null>(null);
  const [selectionBox, setSelectionBox] = useState<ScreenRect | null>(null);
  const selectionBoxRef = useRef<ScreenRect | null>(null);
  selectionBoxRef.current = selectionBox;
  const [selectionPopup, setSelectionPopup] = useState<{
    x: number;
    y: number;
    charRange: [number, number];
    text: string;
  } | null>(null);

  /* --- Selection-triggered AI annotation -------------------------- */
  const [creatingSelectionAnnotation, setCreatingSelectionAnnotation] = useState<{
    excerpt: string;
    charRange: [number, number];
  } | null>(null);
  const [copySelectionFeedback, setCopySelectionFeedback] = useState(false);
  const [bingSearchText, setBingSearchText] = useState("");
  const [speechSearchText, setSpeechSearchText] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  /* --- Connector line refs ---------------------------------------- */
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const annotationRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [connectorLines, setConnectorLines] = useState<
    { x1: number; y1: number; xMid: number; y2: number; x2: number; color: string }[]
  >([]);
  const draggingRef = useRef(false);
  const interactionModeRef = useRef<
    "idle" | "marquee" | "resize-n" | "resize-e" | "resize-s" | "resize-w" | "resize-ne" | "resize-se" | "resize-sw" | "resize-nw"
  >("idle");
  const selectionOriginRef = useRef<{ x: number; y: number } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectionStartRectRef = useRef<ScreenRect | null>(null);

  /* --- Load pdf.js ------------------------------------------------ */
  useEffect(() => {
    void loadPdfJsFromPublic()
      .then(setPdfjsLib)
      .catch((e) =>
        setPdfjsError(
          e instanceof Error
            ? e.message
            : "无法加载 PDF 引擎，请确认已执行 npm install 且 public/pdfjs 下存在 pdf.min.mjs",
        ),
      );
  }, []);

  /* --- File selection --------------------------------------------- */
  const onFile = useCallback(
    async (file: File | null) => {
      setError(null);
      setDocError(null);
      setNotice(null);
      setPageAnnotations({});
      pageFlatTextRef.current = {};
      setScreenAnnotations([]);
      setConnectorLines([]);
      setLiveSelectionRange(null);
      setSelectionBox(null);
      setSelectionPopup(null);
      setCreatingSelectionAnnotation(null);
      setSpeechSearchText("");
      setEditingId(null);
      setPageNumber(1);
      setPageJumpInput("1");
      setPageSize({ w: 0, h: 0 });
      setPdfDoc(null);
      setNumPages(0);
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      if (!file) {
        setFileUrl(null);
        pdfBytesRef.current = null;
        return;
      }
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        setError("请选择 PDF 文件");
        return;
      }
      const buf = await file.arrayBuffer();
      pdfBytesRef.current = buf;
      setFileUrl(URL.createObjectURL(file));
    },
    [fileUrl],
  );

  /* --- Open document ---------------------------------------------- */
  useEffect(() => {
    if (!fileUrl || !pdfjsLib) return;
    let cancelled = false;
    setDocLoading(true);
    setDocError(null);
    const lt = pdfjsLib.getDocument(fileUrl);
    lt.promise
      .then((doc) => {
        pdfDocRef.current?.destroy();
        if (cancelled) {
          doc.destroy();
          return;
        }
        pdfDocRef.current = doc;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
      })
      .catch((e) => {
        if (!cancelled) setDocError(e instanceof Error ? e.message : "无法打开 PDF");
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });

    return () => {
      cancelled = true;
      lt.destroy?.();
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
      setPdfDoc(null);
      setNumPages(0);
    };
  }, [fileUrl, pdfjsLib]);

  useEffect(() => {
    setPageJumpInput(String(pageNumber));
  }, [pageNumber]);

  /* --- Render canvas + text layer --------------------------------- */
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    setTextLayerReady(false);
    setLiveSelectionRange(null);
    setSelectionBox(null);
    setSelectionPopup(null);

    let revoked = false;
    let tlInstance: TextLayerInstance | null = null;
    const textLayerDiv = textLayerRef.current;

    void (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (revoked) return;
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
        if (revoked) return;
        setPageSize({ w: viewport.width, h: viewport.height });

        if (textLayerDiv && pdfjsLib?.TextLayer) {
          textLayerDiv.innerHTML = "";
          const tc = await page.getTextContent();
          if (revoked) return;
          tlInstance = new pdfjsLib.TextLayer({
            textContentSource: tc,
            container: textLayerDiv,
            viewport,
          });
          await tlInstance.render();
          annotateTextLayerCharRanges(textLayerDiv);
          if (!revoked) setTextLayerReady(true);
        }
      } catch {
        if (!revoked) setPageSize({ w: 0, h: 0 });
      }
    })();

    return () => {
      revoked = true;
      try {
        tlInstance?.cancel();
      } catch {
        /* already done */
      }
      if (textLayerDiv) textLayerDiv.innerHTML = "";
    };
  }, [pdfDoc, pageNumber, scale, pdfjsLib]);

  /* --- Compute screen annotations when text layer ready ----------- */
  useEffect(() => {
    const div = textLayerRef.current;
    if (!textLayerReady || !div) {
      setScreenAnnotations([]);
      return;
    }
    const anns = pageAnnotations[pageNumber];
    if (!anns?.length) {
      setScreenAnnotations([]);
      return;
    }
    const sa = anns
      .map((a) => ({
        ...a,
        rects: a.charRange ? computeDomHighlightRects(div, a.charRange[0], a.charRange[1]) : [],
      }))
      .sort((a, b) => {
        const ay = a.rects[0]?.y ?? Infinity;
        const by = b.rects[0]?.y ?? Infinity;
        if (ay !== by) return ay - by;
        const ax = a.rects[0]?.x ?? Infinity;
        const bx = b.rects[0]?.x ?? Infinity;
        return ax - bx;
      });
    setScreenAnnotations(sa);
  }, [textLayerReady, pageAnnotations, pageNumber]);

  /* --- Compute connector lines ------------------------------------ */
  useEffect(() => {
    if (screenAnnotations.length === 0 || !mainAreaRef.current || !pdfContainerRef.current) {
      setConnectorLines([]);
      return;
    }
    const mainRect = mainAreaRef.current.getBoundingClientRect();
    const pdfRect = pdfContainerRef.current.getBoundingClientRect();

    const GAP = 6;
    const count = screenAnnotations.filter((h, i) => h.rects.length > 0 && annotationRefs.current[i]).length;

    const raw: {
      idx: number;
      hlX: number;
      hlY: number;
      cardX: number;
      cardY: number;
      color: string;
    }[] = [];

    for (let i = 0; i < screenAnnotations.length; i++) {
      const h = screenAnnotations[i];
      const card = annotationRefs.current[i];
      if (!card || h.rects.length === 0) continue;

      const cardRect = card.getBoundingClientRect();
      const firstRect = h.rects[0];

      raw.push({
        idx: i,
        hlX: pdfRect.left - mainRect.left + firstRect.x + firstRect.w,
        hlY: pdfRect.top - mainRect.top + firstRect.y + firstRect.h / 2,
        cardX: cardRect.left - mainRect.left,
        cardY: cardRect.top - mainRect.top + cardRect.height / 2,
        color: connectorColor(h.kind),
      });
    }

    if (raw.length === 0) {
      setConnectorLines([]);
      return;
    }

    const baseX = Math.min(...raw.map((r) => r.cardX)) - GAP * (count + 1);

    const sorted = [...raw].sort((a, b) => a.hlY - b.hlY);
    const slotMap = new Map<number, number>();
    sorted.forEach((r, si) => slotMap.set(r.idx, si));

    const lines: typeof connectorLines = [];
    for (const r of raw) {
      const slot = slotMap.get(r.idx) ?? 0;
      const xMid = baseX + GAP * (slot + 1);
      lines.push({
        x1: r.hlX,
        y1: r.hlY,
        xMid,
        y2: r.cardY,
        x2: r.cardX,
        color: r.color,
      });
    }
    setConnectorLines(lines);
  }, [screenAnnotations]);

  const buildSelectionFromRect = useCallback((rect: ScreenRect | null) => {
    const div = textLayerRef.current;
    if (!div || !rect) return null;
    const snapped = snapScreenRectToTextRows(div, rect);
    const range = screenRectToCharRange(div, snapped);
    if (!range) return null;
    return {
      rect: normalizeRect(snapped),
      range,
      text: (pageFlatTextRef.current[pageNumber] ?? "").slice(range[0], range[1]),
    };
  }, [pageNumber]);

  const loadPageText = useCallback(async (targetPageNumber: number) => {
    const doc = pdfDoc;
    if (!doc) throw new Error("PDF 尚未加载完成");

    const page = await doc.getPage(targetPageNumber);
    const tc = await page.getTextContent();
    const items = getPageTextItems(tc.items as unknown[]);
    const flatText = items.map((i) => i.str).join("");
    const formattedText = buildFormattedPageText(items);

    pageFlatTextRef.current[targetPageNumber] = flatText;
    return { flatText, formattedText };
  }, [pdfDoc]);

  /* --- Text selection on PDF (rectangle marquee) ------------------- */
  useEffect(() => {
    const div = textLayerRef.current;
    const container = pdfContainerRef.current;
    if (!div || !container || !textLayerReady) return;

    const rectFromPoints = (clientX: number, clientY: number): ScreenRect | null => {
      const origin = selectionOriginRef.current;
      if (!origin) return null;
      const containerRect = container.getBoundingClientRect();
      return {
        x: origin.x,
        y: origin.y,
        w: clientX - containerRect.left - origin.x,
        h: clientY - containerRect.top - origin.y,
      };
    };

    const resizeRectFromPointer = (clientX: number, clientY: number): ScreenRect | null => {
      const base = selectionStartRectRef.current;
      const start = pointerStartRef.current;
      if (!base || !start) return null;
      const containerRect = container.getBoundingClientRect();
      const x = clientX - containerRect.left;
      const y = clientY - containerRect.top;
      const dx = x - start.x;
      const dy = y - start.y;
      const mode = interactionModeRef.current;
      const next = { ...base };
      if (mode.includes("w")) {
        next.x = base.x + dx;
        next.w = base.w - dx;
      }
      if (mode.includes("e")) {
        next.w = base.w + dx;
      }
      if (mode.includes("n")) {
        next.y = base.y + dy;
        next.h = base.h - dy;
      }
      if (mode.includes("s")) {
        next.h = base.h + dy;
      }
      return normalizeRect(next);
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-selection-popup='true']")) {
        return;
      }
      if (target instanceof Element) {
        const handle = target.closest("[data-selection-handle]");
        if (handle instanceof HTMLElement && selectionBoxRef.current) {
          e.preventDefault();
          draggingRef.current = true;
          interactionModeRef.current = handle.dataset.selectionHandle as typeof interactionModeRef.current;
          const containerRect = container.getBoundingClientRect();
          pointerStartRef.current = {
            x: e.clientX - containerRect.left,
            y: e.clientY - containerRect.top,
          };
          selectionStartRectRef.current = normalizeRect(selectionBoxRef.current);
          return;
        }
      }
      e.preventDefault();
      const containerRect = container.getBoundingClientRect();
      draggingRef.current = true;
      interactionModeRef.current = "marquee";
      selectionOriginRef.current = {
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
      };
      pointerStartRef.current = null;
      selectionStartRectRef.current = null;
      setSelectionPopup(null);
      setLiveSelectionRange(null);
      setSelectionBox(null);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      const rect =
        interactionModeRef.current === "marquee"
          ? rectFromPoints(e.clientX, e.clientY)
          : resizeRectFromPointer(e.clientX, e.clientY);
      if (!rect) return;
      const data = buildSelectionFromRect(rect);
      setSelectionBox(data?.rect ?? normalizeRect(rect));
      setLiveSelectionRange(data?.range ?? null);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const rect =
        interactionModeRef.current === "marquee"
          ? rectFromPoints(e.clientX, e.clientY)
          : resizeRectFromPointer(e.clientX, e.clientY);
      const data = buildSelectionFromRect(rect);
      interactionModeRef.current = "idle";
      selectionOriginRef.current = null;
      pointerStartRef.current = null;
      selectionStartRectRef.current = null;

      if (!data) {
        setLiveSelectionRange(null);
        setSelectionBox(null);
        setSelectionPopup(null);
        return;
      }

      const normX = data.rect.x;
      const normY = data.rect.y;
      const normW = data.rect.w;
      setSelectionBox(data.rect);
      setLiveSelectionRange(data.range);
      setSelectionPopup({
        x: normX + normW,
        y: normY - 8,
        charRange: data.range,
        text: data.text,
      });
    };

    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [buildSelectionFromRect, pageNumber, textLayerReady]);

  /* --- Helpers: CRUD on pageAnnotations --------------------------- */
  const deleteAnnotation = useCallback((id: string) => {
    setPageAnnotations((prev) => {
      const anns = prev[pageNumber];
      if (!anns) return prev;
      return { ...prev, [pageNumber]: anns.filter((a) => a.id !== id) };
    });
    if (editingId === id) {
      setEditingId(null);
      setEditDraft(null);
    }
  }, [pageNumber, editingId]);

  const startEditing = useCallback((a: Annotation) => {
    setEditingId(a.id);
    setEditDraft({
      excerpt: a.excerpt,
      kind: a.kind,
      suggestion: a.suggestion,
      reason: a.reason,
    });
  }, []);

  const saveEditing = useCallback(() => {
    if (!editingId || !editDraft) return;
    const flatText = pageFlatTextRef.current[pageNumber] ?? "";
    const newRange = editDraft.excerpt
      ? resolveIssueCharRange(flatText, {
          excerpt: editDraft.excerpt,
          suggestion: editDraft.suggestion,
          reason: editDraft.reason,
          kind: editDraft.kind,
        })
      : null;

    setPageAnnotations((prev) => {
      const anns = prev[pageNumber];
      if (!anns) return prev;
      return {
        ...prev,
        [pageNumber]: anns.map((a) =>
          a.id === editingId
            ? { ...a, ...editDraft, charRange: newRange }
            : a,
        ),
      };
    });
    setEditingId(null);
    setEditDraft(null);
  }, [editingId, editDraft, pageNumber]);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditDraft(null);
  }, []);

  const createAnnotationFromSelection = useCallback(async () => {
    if (!selectionPopup) return;
    const pending = {
      excerpt: selectionPopup.text,
      charRange: selectionPopup.charRange,
    };
    setCreatingSelectionAnnotation(pending);
    setSelectionPopup(null);
    setLiveSelectionRange(null);
    setSelectionBox(null);
    setError(null);
    setNotice(null);
    try {
      const { formattedText } = await loadPageText(pageNumber);
      const res = await fetch("/api/suggest-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excerpt: pending.excerpt,
          pageText: formattedText.slice(0, 48000),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "AI 建议请求失败");
        return;
      }

      const newAnn: Annotation = {
        id: genId(),
        source: "selection-ai",
        excerpt: pending.excerpt,
        kind: (data.kind as IssueKind) ?? "suspected",
        suggestion: typeof data.suggestion === "string" ? data.suggestion : "",
        reason: typeof data.reason === "string" ? data.reason : "",
        charRange: pending.charRange,
      };

      setPageAnnotations((prev) => ({
        ...prev,
        [pageNumber]: [...(prev[pageNumber] ?? []), newAnn],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 建议请求失败");
    } finally {
      setCreatingSelectionAnnotation(null);
    }
  }, [loadPageText, pageNumber, selectionPopup]);

  const copySelectionText = useCallback(async () => {
    if (!selectionPopup?.text) return;
    try {
      await copyTextToClipboard(selectionPopup.text);
      setCopySelectionFeedback(true);
      window.setTimeout(() => setCopySelectionFeedback(false), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "复制文本失败");
    }
  }, [selectionPopup]);

  const openSpeechDatabaseSearch = useCallback(() => {
    const keywords = speechSearchText.trim();
    if (!keywords) return;
    const url = `https://jhsjk.people.cn/result?keywords=${encodeURIComponent(keywords)}&isFuzzy=0`;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [speechSearchText]);

  const openBingSearch = useCallback(() => {
    const keywords = bingSearchText.trim();
    if (!keywords) return;
    const url = `https://www.bing.com/?mkt=zh-CN&q=${encodeURIComponent(keywords)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [bingSearchText]);

  /* --- AI review -------------------------------------------------- */
  const reviewSinglePage = useCallback(async (targetPageNumber: number, mode: ReviewMode) => {
    const { flatText, formattedText } = await loadPageText(targetPageNumber);

    const res = await fetch("/api/review-page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageIndex: targetPageNumber - 1,
        text: formattedText.slice(0, 48000),
        mode,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error ?? `第 ${targetPageNumber} 页审稿请求失败`);
    }

    const issues = (data.issues ?? []) as NormalizedReviewIssue[];
    const matches = matchIssuesToCharRanges(flatText, issues);
    const aiAnnotations: Annotation[] = [];
    let droppedCount = 0;

    for (const m of matches) {
      if (!m.charRange) {
        droppedCount += 1;
        continue;
      }
      aiAnnotations.push({
        id: genId(),
        source: "ai" as const,
        excerpt: m.excerpt,
        kind: m.kind,
        suggestion: m.suggestion ?? "",
        reason: m.reason,
        charRange: m.charRange,
      });
    }

    setPageAnnotations((prev) => {
      const existing = prev[targetPageNumber] ?? [];
      const preserved = existing.filter((a) => a.source !== "ai");
      return { ...prev, [targetPageNumber]: [...aiAnnotations, ...preserved] };
    });
    return { droppedCount };
  }, [loadPageText]);

  const runAiReview = useCallback(async () => {
    if (!pdfDoc) return;
    setError(null);
    setNotice(null);
    setLoadingAi(true);
    try {
      const { droppedCount } = await reviewSinglePage(pageNumber, reviewMode);
      if (droppedCount > 0) {
        setNotice(`AI 返回了 ${droppedCount} 条无法与当前页原文对齐的批注，已自动忽略。`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "审稿失败");
    } finally {
      setLoadingAi(false);
    }
  }, [pageNumber, pdfDoc, reviewMode, reviewSinglePage]);

  const runBatchAiReview = useCallback(async () => {
    if (!pdfDoc) return;
    const startPage = pageNumber;
    const total = Math.min(10, Math.max(1, numPages - startPage + 1), Math.max(1, batchReviewCount));
    if (total <= 1) return;

    setError(null);
    setNotice(null);
    setBatchReviewProgress({ done: 0, total, currentPage: startPage });
    let totalDroppedCount = 0;
    const failedPages: number[] = [];
    try {
      for (let offset = 0; offset < total; offset += 1) {
        const targetPageNumber = startPage + offset;
        setBatchReviewProgress({ done: offset, total, currentPage: targetPageNumber });
        try {
          const { droppedCount } = await reviewSinglePage(targetPageNumber, reviewMode);
          totalDroppedCount += droppedCount;
        } catch (e) {
          failedPages.push(targetPageNumber);
          console.error(`[batch-review] 第 ${targetPageNumber} 页审稿失败:`, e);
        }
      }
      setBatchReviewProgress({ done: total, total, currentPage: startPage + total - 1 });
      const notices: string[] = [];
      if (totalDroppedCount > 0) {
        notices.push(`连续审稿中有 ${totalDroppedCount} 条批注无法与原文对齐，已自动忽略。`);
      }
      if (failedPages.length > 0) {
        notices.push(`以下页面审稿失败，但未影响后续页面：第 ${failedPages.join("、")} 页。`);
      }
      if (notices.length > 0) {
        setNotice(notices.join(" "));
      }
    } finally {
      setBatchReviewProgress(null);
    }
  }, [batchReviewCount, numPages, pageNumber, pdfDoc, reviewMode, reviewSinglePage]);

  /* --- Ensure flatText is loaded for current page ------------------- */
  useEffect(() => {
    if (!pdfDoc || pageFlatTextRef.current[pageNumber]) return;
    void (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        const tc = await page.getTextContent();
        const items = getPageTextItems(tc.items as unknown[]);
        pageFlatTextRef.current[pageNumber] = items.map((i) => i.str).join("");
      } catch { /* ignore */ }
    })();
  }, [pdfDoc, pageNumber]);

  /* --- PDF export ------------------------------------------------- */
  const downloadPdf = useCallback(async () => {
    const bytes = pdfBytesRef.current;
    const doc = pdfDoc;
    if (!bytes || !doc) return;
    setExporting(true);
    setError(null);
    try {
      const annotations: PageAnnotation[] = [];
      const notes: NoteLine[] = [];
      let n = 1;
      const pageNums = Object.keys(pageAnnotations)
        .map(Number)
        .sort((a, b) => a - b);

      for (const pn of pageNums) {
        const anns = pageAnnotations[pn];
        if (!anns?.length) continue;

        const page = await doc.getPage(pn);
        const tc = await page.getTextContent();
        const items = getPageTextItems(tc.items as unknown[]);

        for (const ann of anns) {
          const label = String(n++);

          if (ann.charRange) {
            const boxes = charRangeToPdfBoxes(items, ann.charRange);
            for (const box of boxes) {
              annotations.push({ pageIndex: pn - 1, label, kind: ann.kind, pdfBox: box });
            }
          }

          notes.push({
            pageIndex: pn - 1,
            label,
            kind: ann.kind,
            excerpt: ann.excerpt,
            suggestion: ann.suggestion,
            reason: ann.reason,
          });
        }
      }

      const out = await buildReviewedPdf(bytes, annotations, notes);
      const blob = new Blob([new Uint8Array(out)], { type: "application/pdf" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "reviewed.pdf";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error("[PDF Export] error:", e);
      setError(e instanceof Error ? e.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }, [pageAnnotations, pdfDoc]);

  const hasAnyAnnotations = Object.values(pageAnnotations).some((a) => a && a.length > 0);
  const maxBatchPages = Math.min(10, Math.max(0, numPages - pageNumber + 1));
  const aiBusy = loadingAi || !!batchReviewProgress;
  const jumpToPage = useCallback(() => {
    const parsed = Number(pageJumpInput.trim());
    if (!Number.isFinite(parsed)) {
      setPageJumpInput(String(pageNumber));
      return;
    }
    const target = Math.min(numPages || 1, Math.max(1, Math.floor(parsed)));
    setPageNumber(target);
    setPageJumpInput(String(target));
  }, [numPages, pageJumpInput, pageNumber]);

  /* --- Render ----------------------------------------------------- */
  return (
    <div className="mx-auto flex max-w-[1480px] flex-col gap-5 px-4 pb-8 pt-2">
      {/* Header */}
      <header className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-950 dark:text-neutral-50">PDF AI 审稿</h1>
          <p className="text-sm leading-6 text-neutral-600 dark:text-neutral-400">
            上传 PDF，支持当前页单页审稿，也支持从当前页起连续审稿最多 10 页；还可选中 PDF 文字后直接调用 AI 添加批注；导出 PDF 含高亮标注与批注。
          </p>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[auto_1fr_auto]">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">文件</div>
            <label className="inline-flex cursor-pointer items-center rounded-xl bg-neutral-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white">
              选择 PDF
              <input
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">审稿</div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={aiBusy || !pdfDoc}
                onClick={() => void runAiReview()}
                className="rounded-xl bg-amber-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-amber-600 disabled:opacity-50"
              >
                {loadingAi ? "审稿中…" : "AI 审稿（当前页）"}
              </button>
              <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <span>审稿模式</span>
                <select
                  value={reviewMode}
                  disabled={aiBusy || !pdfDoc}
                  onChange={(e) => setReviewMode(e.target.value as ReviewMode)}
                  className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                >
                  <option value="precise">精确查找</option>
                  <option value="discover-more">发现更多</option>
                </select>
              </div>
              <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <span>连续审核</span>
                <select
                  value={Math.min(batchReviewCount, Math.max(2, maxBatchPages))}
                  disabled={aiBusy || maxBatchPages < 2}
                  onChange={(e) => setBatchReviewCount(Number(e.target.value))}
                  className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                >
                  {Array.from({ length: Math.max(0, maxBatchPages - 1) }, (_, i) => i + 2).map((count) => (
                    <option key={count} value={count}>
                      {count} 页
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={aiBusy || maxBatchPages < 2}
                onClick={() => void runBatchAiReview()}
                className="rounded-xl bg-orange-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-orange-600 disabled:opacity-50"
              >
                {batchReviewProgress
                  ? `连续审稿中… ${batchReviewProgress.done}/${batchReviewProgress.total}`
                  : "AI 审稿（从当前页起）"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">导出</div>
            <button
              type="button"
              disabled={exporting || !hasAnyAnnotations}
              onClick={() => void downloadPdf()}
              className="rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              {exporting ? "导出中…" : "下载标注 PDF"}
            </button>
          </div>
        </div>

        {batchReviewProgress && (
          <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
            正在连续审核第 {batchReviewProgress.currentPage} 页，已完成 {batchReviewProgress.done} / {batchReviewProgress.total} 页。
          </p>
        )}
        {notice && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
        {pdfjsError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{pdfjsError}</p>}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </header>

      {/* Main */}
      {fileUrl && (
        <div ref={mainAreaRef} className="relative grid flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_400px]">
          {/* SVG connector lines */}
          {connectorLines.length > 0 && (
            <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible">
              {connectorLines.map((l, i) => (
                <polyline
                  key={i}
                  points={`${l.x1},${l.y1} ${l.xMid},${l.y1} ${l.xMid},${l.y2} ${l.x2},${l.y2}`}
                  fill="none"
                  stroke={l.color}
                  strokeWidth={1.5}
                  strokeDasharray="5,3"
                  opacity={0.7}
                />
              ))}
            </svg>
          )}

          {helpOpen && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4">
              <div className="w-full max-w-xl rounded-3xl border border-neutral-200 bg-white p-6 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold text-neutral-950 dark:text-neutral-50">使用说明</h2>
                    <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">快速了解这套 PDF 审稿工作台的常用操作。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setHelpOpen(false)}
                    className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  >
                    关闭
                  </button>
                </div>
                <div className="mt-5 space-y-3">
                  {[
                    "上传 PDF 后，可先用“AI 审稿（当前页）”快速扫描当前页。",
                    "如需批量处理，可从当前页起连续审核最多 10 页。",
                    "选中文本后可“复制文本”或直接“添加批注”。",
                    "需要核对讲话原文时，可把内容粘贴到“重要讲话数据库”中按回车搜索。",
                    "若出现无法定位到原文的 AI 批注，系统会自动忽略并提示。",
                  ].map((item, index) => (
                    <div
                      key={item}
                      className="flex items-start gap-3 rounded-2xl bg-neutral-50 px-4 py-3 dark:bg-neutral-900"
                    >
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
                        {index + 1}
                      </span>
                      <p className="text-sm leading-6 text-neutral-700 dark:text-neutral-300">{item}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-2.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 lg:col-start-1 lg:row-start-1 lg:flex lg:h-full lg:min-h-[66px] lg:items-center">
            <div className="flex w-full items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">使用提示</div>
                <p className="mt-0.5 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                  查看这套审稿工具的常用操作说明与快捷路径。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                查看说明
              </button>
            </div>
          </div>

          <aside className="lg:col-start-1 lg:row-start-2">
            <div className="flex h-full min-h-0 flex-col gap-4">
              <section className="relative flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-3xl border border-amber-200 bg-[radial-gradient(circle_at_top_left,_rgba(253,230,138,0.35),_transparent_38%),linear-gradient(180deg,rgba(255,251,235,0.98),rgba(254,249,195,0.96))] p-5 shadow-sm dark:border-amber-900 dark:bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.12),_transparent_38%),linear-gradient(180deg,rgba(41,30,9,0.98),rgba(24,24,27,0.98))]">
                <div className="pointer-events-none absolute -right-8 top-0 h-24 w-24 rounded-full bg-amber-200/50 blur-3xl dark:bg-amber-400/10" />
                <div className="relative flex h-full flex-col">
                  <h2 className="text-xl font-semibold tracking-tight text-amber-950 dark:text-amber-50">必应搜索</h2>
                  <textarea
                    value={bingSearchText}
                    onChange={(e) => setBingSearchText(e.target.value)}
                    placeholder="输入要搜索的内容"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        openBingSearch();
                      }
                    }}
                    className="mt-4 block min-h-0 flex-1 resize-none rounded-2xl border border-amber-200 bg-white px-4 py-3 text-sm leading-relaxed text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-amber-400 dark:border-amber-800 dark:bg-neutral-950 dark:text-neutral-100"
                  />
                  <p className="mt-3 text-xs text-amber-900/75 dark:text-amber-100/60">按 Enter 搜索，按 Shift + Enter 换行。</p>
                </div>
              </section>

              <section className="relative flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-3xl border border-sky-200 bg-[radial-gradient(circle_at_top_left,_rgba(186,230,253,0.5),_transparent_36%),linear-gradient(180deg,rgba(240,249,255,0.98),rgba(248,250,252,0.98))] p-5 shadow-sm dark:border-sky-900 dark:bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_36%),linear-gradient(180deg,rgba(2,6,23,0.98),rgba(3,7,18,0.98))]">
                <div className="pointer-events-none absolute -left-8 top-12 h-24 w-24 rounded-full bg-sky-200/40 blur-3xl dark:bg-sky-500/10" />
                <div className="relative flex h-full flex-col">
                  <h2 className="text-xl font-semibold tracking-tight text-sky-950 dark:text-sky-50">重要讲话数据库</h2>
                  <textarea
                    value={speechSearchText}
                    onChange={(e) => setSpeechSearchText(e.target.value)}
                    placeholder="输入要检索的讲话内容"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        openSpeechDatabaseSearch();
                      }
                    }}
                    className="mt-4 block min-h-0 flex-1 resize-none rounded-2xl border border-sky-200 bg-white px-4 py-3 text-sm leading-relaxed text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-sky-400 dark:border-sky-800 dark:bg-neutral-950 dark:text-neutral-100"
                  />
                  <p className="mt-3 text-xs text-sky-800/80 dark:text-sky-200/70">按 Enter 搜索，按 Shift + Enter 换行。</p>
                </div>
              </section>
            </div>
          </aside>

          <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-2.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 lg:col-start-2 lg:row-start-1">
            <div className="flex min-h-[66px] flex-wrap items-center gap-3 text-sm">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pageNumber <= 1 || !pdfDoc}
                  className="rounded-xl border border-neutral-300 px-3 py-2 leading-none transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900 disabled:opacity-40"
                  onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={pageNumber >= numPages || !pdfDoc}
                  className="rounded-xl border border-neutral-300 px-3 py-2 leading-none transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900 disabled:opacity-40"
                  onClick={() => setPageNumber((p) => Math.min(numPages || p, p + 1))}
                >
                  下一页
                </button>
              </div>
              <div className="rounded-xl bg-neutral-100 px-3 py-2 leading-none text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                第 {pageNumber} / {numPages || "—"} 页
              </div>
              <div className="flex items-center gap-2">
                <span className="text-neutral-500 dark:text-neutral-400">跳转到</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, numPages)}
                  inputMode="numeric"
                  value={pageJumpInput}
                  onChange={(e) => setPageJumpInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      jumpToPage();
                    }
                  }}
                  className="w-20 rounded-xl border border-neutral-300 bg-white px-3 py-2 leading-none text-sm dark:border-neutral-700 dark:bg-neutral-950"
                />
                <button
                  type="button"
                  disabled={!pdfDoc}
                  onClick={jumpToPage}
                  className="rounded-xl border border-neutral-300 px-3 py-2 leading-none transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900 disabled:opacity-40"
                >
                  跳转
                </button>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-neutral-500 dark:text-neutral-400">缩放</span>
                <input
                  type="range"
                  min={0.6}
                  max={2}
                  step={0.1}
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                />
                <span className="min-w-12 tabular-nums text-neutral-700 dark:text-neutral-200">{scale.toFixed(1)}×</span>
              </div>
            </div>
          </div>

          {/* PDF canvas + overlays */}
          <div className="overflow-auto rounded-2xl border border-neutral-200 bg-neutral-100 p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 lg:col-start-2 lg:row-start-2">
            {docLoading && <p className="text-sm text-neutral-500">正在打开 PDF…</p>}
            {docError && <p className="text-sm text-red-600">{docError}</p>}
            {!docLoading && !docError && pdfDoc && (
              <div
                ref={pdfContainerRef}
                className="relative mx-auto inline-block shadow-md"
                style={pageSize.w ? { width: pageSize.w, height: pageSize.h } : undefined}
              >
                <canvas ref={canvasRef} className="block max-w-full" />
                <div ref={textLayerRef} className="pdf-text-layer" />

                {/* Highlight overlays */}
                {pageSize.w > 0 &&
                  screenAnnotations.map((a) =>
                    a.rects.map((r, ri) => (
                      <div
                        key={`${a.id}-${ri}`}
                        className={`pointer-events-none absolute z-[1] rounded-sm ${highlightBgClass(a.kind)}`}
                        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                      />
                    )),
                  )}

                {/* Yellow preview highlight: live drag / popup / AI generation */}
                {(() => {
                  if (!pageSize.w) return null;
                  const pendingRects = creatingSelectionAnnotation?.charRange && textLayerRef.current
                    ? computeDomHighlightRects(
                        textLayerRef.current,
                        creatingSelectionAnnotation.charRange[0],
                        creatingSelectionAnnotation.charRange[1],
                      )
                    : liveSelectionRange && textLayerRef.current
                      ? computeDomHighlightRects(
                          textLayerRef.current,
                          liveSelectionRange[0],
                          liveSelectionRange[1],
                        )
                      : [];
                  return pendingRects.map((r, ri) => (
                    <div
                      key={`pending-${ri}`}
                      className="pointer-events-none absolute z-[1] rounded-sm bg-yellow-400/40"
                      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                    />
                  ));
                })()}

                {/* Rectangle marquee while dragging */}
                {selectionBox && (
                  <>
                    <div
                      className="pointer-events-none absolute z-[3] border-2 border-yellow-500/80 bg-yellow-300/10"
                      style={{
                        left: selectionBox.x,
                        top: selectionBox.y,
                        width: selectionBox.w,
                        height: selectionBox.h,
                      }}
                    />
                    {[
                      { key: "resize-nw", left: selectionBox.x - 5, top: selectionBox.y - 5, cursor: "nwse-resize" },
                      { key: "resize-n", left: selectionBox.x + selectionBox.w / 2 - 5, top: selectionBox.y - 5, cursor: "ns-resize" },
                      { key: "resize-ne", left: selectionBox.x + selectionBox.w - 5, top: selectionBox.y - 5, cursor: "nesw-resize" },
                      { key: "resize-e", left: selectionBox.x + selectionBox.w - 5, top: selectionBox.y + selectionBox.h / 2 - 5, cursor: "ew-resize" },
                      { key: "resize-se", left: selectionBox.x + selectionBox.w - 5, top: selectionBox.y + selectionBox.h - 5, cursor: "nwse-resize" },
                      { key: "resize-s", left: selectionBox.x + selectionBox.w / 2 - 5, top: selectionBox.y + selectionBox.h - 5, cursor: "ns-resize" },
                      { key: "resize-sw", left: selectionBox.x - 5, top: selectionBox.y + selectionBox.h - 5, cursor: "nesw-resize" },
                      { key: "resize-w", left: selectionBox.x - 5, top: selectionBox.y + selectionBox.h / 2 - 5, cursor: "ew-resize" },
                    ].map((handle) => (
                      <div
                        key={handle.key}
                        data-selection-handle={handle.key}
                        className="absolute z-[4] h-2.5 w-2.5 rounded-full border border-yellow-700 bg-white"
                        style={{
                          left: handle.left,
                          top: handle.top,
                          cursor: handle.cursor,
                        }}
                      />
                    ))}
                  </>
                )}

                {/* Selection popup: "添加批注" button */}
                {selectionPopup && (
                  <div
                    data-selection-popup="true"
                    className="absolute z-20 -translate-x-1/2 -translate-y-full"
                    style={{ left: selectionPopup.x, top: selectionPopup.y }}
                  >
                    <div
                      data-selection-popup="true"
                      className="flex items-center gap-2 rounded-md bg-neutral-900 p-1 shadow-lg dark:bg-neutral-100"
                    >
                      <button
                        type="button"
                        data-selection-popup="true"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => void copySelectionText()}
                        className="rounded px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/10 dark:text-neutral-900 dark:hover:bg-neutral-200"
                      >
                        {copySelectionFeedback ? "已复制" : "复制文本"}
                      </button>
                      <button
                        type="button"
                        data-selection-popup="true"
                        onMouseDown={(e) => e.stopPropagation()}
                        disabled={!!creatingSelectionAnnotation}
                        onClick={() => void createAnnotationFromSelection()}
                        className="rounded bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/15 disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
                      >
                        {creatingSelectionAnnotation ? "AI 生成中…" : "添加批注"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="w-full shrink-0 lg:col-start-3 lg:row-span-2">
            <h2 className="mb-2 text-sm font-semibold text-neutral-800 dark:text-neutral-200">批注</h2>

            {creatingSelectionAnnotation && (
              <div className="mb-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
                <div className="flex items-center justify-between gap-2 border-b border-neutral-100 pb-2 dark:border-neutral-800">
                  <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    生成中
                  </span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">问问 AI</span>
                </div>
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                  摘录：{creatingSelectionAnnotation.excerpt || "—"}
                </p>
                <div className="mt-2 rounded-md bg-amber-50/90 px-2.5 py-2 text-neutral-900 dark:bg-amber-950/30 dark:text-neutral-100">
                  <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">修改意见</span>
                  <p className="mt-0.5 leading-relaxed">AI 正在生成批注…</p>
                </div>
              </div>
            )}

            {screenAnnotations.length === 0 && !creatingSelectionAnnotation ? (
              <p className="text-sm text-neutral-500">尚未审稿。点击「AI 审稿」分析当前页，或在 PDF 上选中文字后直接添加 AI 批注。</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {screenAnnotations.map((a, i) => {
                  const isEditing = editingId === a.id;
                  return (
                    <li
                      key={a.id}
                      ref={(el) => { annotationRefs.current[i] = el; }}
                      className={`rounded-lg border bg-white p-3 text-sm shadow-sm dark:bg-neutral-900 ${
                        a.kind === "error"
                          ? "border-l-4 border-l-red-500 border-neutral-200 dark:border-neutral-700"
                          : "border-l-4 border-l-sky-500 border-neutral-200 dark:border-neutral-700"
                      }`}
                    >
                      {/* Card header */}
                      <div className="flex items-start justify-between gap-2 border-b border-neutral-100 pb-2 dark:border-neutral-800">
                        <div className="flex items-center gap-1.5">
                          {a.source === "manual" && (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                              手动
                            </span>
                          )}
                          {isEditing ? (
                            <select
                              value={editDraft!.kind}
                              onChange={(e) => setEditDraft((d) => d ? { ...d, kind: e.target.value as IssueKind } : d)}
                              className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-600 dark:bg-neutral-800"
                            >
                              <option value="error">确定错误</option>
                              <option value="suspected">疑似错误</option>
                            </select>
                          ) : (
                            <span
                              className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${
                                a.kind === "error"
                                  ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
                                  : "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200"
                              }`}
                            >
                              {a.kind === "error" ? "确定错误" : "疑似错误"}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onClick={saveEditing}
                                className="rounded px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditing}
                                className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => startEditing(a)}
                                className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteAnnotation(a.id)}
                                className="rounded px-2 py-0.5 text-xs text-red-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950 dark:hover:text-red-300"
                              >
                                删除
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {a.rects.length === 0 && (
                        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                          （未能定位到 PDF 文本，仅显示批注）
                        </p>
                      )}

                      {/* Excerpt */}
                      {isEditing ? (
                        <div className="mt-2">
                          <label className="text-xs text-neutral-500">摘录</label>
                          <input
                            type="text"
                            value={editDraft!.excerpt}
                            onChange={(e) => setEditDraft((d) => d ? { ...d, excerpt: e.target.value } : d)}
                            className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                          />
                        </div>
                      ) : (
                        <details className="mt-2 rounded-md border border-neutral-200/80 bg-neutral-50/70 px-2.5 py-1.5 dark:border-neutral-800 dark:bg-neutral-950/40">
                          <DisclosureSummary label="原句" />
                          <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                            {a.excerpt || "—"}
                          </p>
                        </details>
                      )}

                      {/* Suggestion */}
                      {isEditing ? (
                        <div className="mt-2">
                          <label className="text-xs text-neutral-500">修改意见</label>
                          <textarea
                            value={editDraft!.suggestion}
                            onChange={(e) => setEditDraft((d) => d ? { ...d, suggestion: e.target.value } : d)}
                            rows={2}
                            className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                          />
                        </div>
                      ) : (
                        <div
                          className={`mt-2 rounded-md px-2.5 py-2 text-neutral-900 dark:text-neutral-100 ${
                            a.kind === "error" ? "bg-red-50/90 dark:bg-red-950/40" : "bg-amber-50/90 dark:bg-amber-950/30"
                          }`}
                        >
                          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">修改意见</span>
                          <p className="mt-0.5 leading-relaxed">{a.suggestion?.trim() || "—"}</p>
                        </div>
                      )}

                      {/* Reason */}
                      {isEditing ? (
                        <div className="mt-2">
                          <label className="text-xs text-neutral-500">说明</label>
                          <textarea
                            value={editDraft!.reason}
                            onChange={(e) => setEditDraft((d) => d ? { ...d, reason: e.target.value } : d)}
                            rows={1}
                            className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                          />
                        </div>
                      ) : a.reason?.trim() ? (
                        <details className="mt-2 rounded-md border border-neutral-200/80 bg-neutral-50/70 px-2.5 py-1.5 dark:border-neutral-800 dark:bg-neutral-950/40">
                          <DisclosureSummary label="说明" />
                          <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                            {a.reason}
                          </p>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      )}

      {!fileUrl && <p className="text-sm text-neutral-500">请先上传 PDF 文件。</p>}
    </div>
  );
}
