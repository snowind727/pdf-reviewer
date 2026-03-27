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

function highlightBgClass(kind: IssueKind): string {
  return kind === "error" ? "bg-red-500/35" : "bg-sky-400/30";
}

function connectorColor(kind: IssueKind): string {
  return kind === "error" ? "#ef4444" : "#38bdf8";
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
  const [scale, setScale] = useState(1.2);

  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });

  /* --- Annotations (unified: AI + manual) ------------------------- */
  const [pageAnnotations, setPageAnnotations] = useState<Record<number, Annotation[]>>({});
  const pageFlatTextRef = useRef<Record<number, string>>({});

  const [textLayerReady, setTextLayerReady] = useState(false);
  const [screenAnnotations, setScreenAnnotations] = useState<ScreenAnnotation[]>([]);

  const [loadingAi, setLoadingAi] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  /* --- Manual add form -------------------------------------------- */
  const [addingAnnotation, setAddingAnnotation] = useState<{
    excerpt: string;
    charRange: [number, number];
  } | null>(null);
  const [addForm, setAddForm] = useState({
    kind: "error" as IssueKind,
    suggestion: "",
    reason: "",
  });
  const [loadingAiSuggestion, setLoadingAiSuggestion] = useState(false);

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
      setPageAnnotations({});
      pageFlatTextRef.current = {};
      setScreenAnnotations([]);
      setConnectorLines([]);
      setLiveSelectionRange(null);
      setSelectionBox(null);
      setSelectionPopup(null);
      setAddingAnnotation(null);
      setEditingId(null);
      setPageNumber(1);
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

  /* --- Render canvas + text layer --------------------------------- */
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    setTextLayerReady(false);
    setLiveSelectionRange(null);
    setSelectionBox(null);
    setSelectionPopup(null);

    let revoked = false;
    let tlInstance: TextLayerInstance | null = null;

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

        const textLayerDiv = textLayerRef.current;
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
      if (textLayerRef.current) textLayerRef.current.innerHTML = "";
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

  const openAddForm = useCallback(() => {
    if (!selectionPopup) return;
    setAddingAnnotation({
      excerpt: selectionPopup.text,
      charRange: selectionPopup.charRange,
    });
    setAddForm({ kind: "error", suggestion: "", reason: "" });
    setSelectionPopup(null);
    setLiveSelectionRange(null);
    setSelectionBox(null);
  }, [selectionPopup]);

  const confirmAdd = useCallback(() => {
    if (!addingAnnotation) return;
    const newAnn: Annotation = {
      id: genId(),
      source: "manual",
      excerpt: addingAnnotation.excerpt,
      kind: addForm.kind,
      suggestion: addForm.suggestion,
      reason: addForm.reason,
      charRange: addingAnnotation.charRange,
    };
    setPageAnnotations((prev) => ({
      ...prev,
      [pageNumber]: [...(prev[pageNumber] ?? []), newAnn],
    }));
    setAddingAnnotation(null);
  }, [addingAnnotation, addForm, pageNumber]);

  const askAiForSuggestion = useCallback(async () => {
    if (!addingAnnotation || !pdfDoc) return;
    setLoadingAiSuggestion(true);
    setError(null);
    try {
      const page = await pdfDoc.getPage(pageNumber);
      const tc = await page.getTextContent();
      const items = getPageTextItems(tc.items as unknown[]);
      const formattedText = buildFormattedPageText(items);

      const res = await fetch("/api/suggest-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excerpt: addingAnnotation.excerpt,
          pageText: formattedText.slice(0, 48000),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "AI 建议请求失败");
        return;
      }

      setAddForm((prev) => ({
        ...prev,
        kind: (data.kind as IssueKind) ?? prev.kind,
        suggestion: typeof data.suggestion === "string" ? data.suggestion : prev.suggestion,
        reason: typeof data.reason === "string" ? data.reason : prev.reason,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 建议请求失败");
    } finally {
      setLoadingAiSuggestion(false);
    }
  }, [addingAnnotation, pdfDoc, pageNumber]);

  /* --- AI review -------------------------------------------------- */
  const runAiReview = useCallback(async () => {
    const doc = pdfDoc;
    if (!doc) return;
    setError(null);
    setLoadingAi(true);
    try {
      const page = await doc.getPage(pageNumber);
      const tc = await page.getTextContent();
      const items = getPageTextItems(tc.items as unknown[]);
      const flatText = items.map((i) => i.str).join("");
      const formattedText = buildFormattedPageText(items);

      pageFlatTextRef.current[pageNumber] = flatText;

      const res = await fetch("/api/review-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageIndex: pageNumber - 1, text: formattedText.slice(0, 48000) }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "审稿请求失败");
        return;
      }

      const issues = (data.issues ?? []) as NormalizedReviewIssue[];
      const matches = matchIssuesToCharRanges(flatText, issues);

      const aiAnnotations: Annotation[] = matches.map((m) => ({
        id: genId(),
        source: "ai" as const,
        excerpt: m.excerpt,
        kind: m.kind,
        suggestion: m.suggestion ?? "",
        reason: m.reason,
        charRange: m.charRange,
      }));

      setPageAnnotations((prev) => {
        const existing = prev[pageNumber] ?? [];
        const manualOnly = existing.filter((a) => a.source === "manual");
        return { ...prev, [pageNumber]: [...aiAnnotations, ...manualOnly] };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "审稿失败");
    } finally {
      setLoadingAi(false);
    }
  }, [pdfDoc, pageNumber]);

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

  /* --- Render ----------------------------------------------------- */
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
      {/* Header */}
      <header className="flex flex-col gap-2 border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <h1 className="text-xl font-semibold tracking-tight">PDF AI 审稿</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          上传 PDF，逐页浏览后点击「AI 审稿」；可选中 PDF 文字手动添加批注；导出 PDF 含高亮标注与批注。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-md bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
            选择 PDF
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {fileUrl && pdfDoc && (
            <>
              <button
                type="button"
                disabled={loadingAi}
                onClick={() => void runAiReview()}
                className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {loadingAi ? "审稿中…" : "AI 审稿（当前页）"}
              </button>
              <button
                type="button"
                disabled={exporting || !hasAnyAnnotations}
                onClick={() => void downloadPdf()}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-600 disabled:opacity-50"
              >
                {exporting ? "导出中…" : "下载标注 PDF"}
              </button>
            </>
          )}
        </div>
        {pdfjsError && <p className="text-sm text-red-600 dark:text-red-400">{pdfjsError}</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </header>

      {/* Main */}
      {fileUrl && (
        <div ref={mainAreaRef} className="relative flex flex-1 flex-col gap-4 lg:flex-row">
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

          {/* PDF canvas + overlays */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button
                type="button"
                disabled={pageNumber <= 1 || !pdfDoc}
                className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-600 disabled:opacity-40"
                onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                disabled={pageNumber >= numPages || !pdfDoc}
                className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-600 disabled:opacity-40"
                onClick={() => setPageNumber((p) => Math.min(numPages || p, p + 1))}
              >
                下一页
              </button>
              <span className="text-neutral-600 dark:text-neutral-400">
                第 {pageNumber} / {numPages || "—"} 页
              </span>
              <label className="flex items-center gap-1">
                缩放
                <input
                  type="range"
                  min={0.6}
                  max={2}
                  step={0.1}
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                />
                <span className="tabular-nums">{scale.toFixed(1)}×</span>
              </label>
            </div>

            <div className="overflow-auto rounded-lg border border-neutral-200 bg-neutral-100 p-4 dark:border-neutral-800 dark:bg-neutral-950">
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

                  {/* Yellow preview highlight: live drag / popup / add form */}
                  {(() => {
                    if (!pageSize.w) return null;
                    const pendingRects = addingAnnotation?.charRange && textLayerRef.current
                      ? computeDomHighlightRects(
                          textLayerRef.current,
                          addingAnnotation.charRange[0],
                          addingAnnotation.charRange[1],
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
                      <button
                        type="button"
                        data-selection-popup="true"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={openAddForm}
                        className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
                      >
                        添加批注
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <aside className="w-full shrink-0 lg:w-[380px]">
            <h2 className="mb-2 text-sm font-semibold text-neutral-800 dark:text-neutral-200">批注</h2>

            {/* Manual add form */}
            {addingAnnotation && (
              <div className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-700 dark:bg-emerald-950">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-emerald-800 dark:text-emerald-200">新增批注</span>
                  <button
                    type="button"
                    onClick={() => setAddingAnnotation(null)}
                    className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                  >
                    取消
                  </button>
                </div>
                <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">
                  选中文字：<span className="font-medium text-neutral-900 dark:text-neutral-100">{addingAnnotation.excerpt}</span>
                </p>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-neutral-600 dark:text-neutral-400">AI 辅助</span>
                  <button
                    type="button"
                    onClick={() => void askAiForSuggestion()}
                    disabled={loadingAiSuggestion}
                    className="rounded border border-sky-300 bg-white px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50 dark:border-sky-700 dark:bg-neutral-900 dark:text-sky-300"
                  >
                    {loadingAiSuggestion ? "AI 生成中…" : "问问 AI"}
                  </button>
                </div>
                <label className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">
                  类型
                  <select
                    value={addForm.kind}
                    onChange={(e) => setAddForm((f) => ({ ...f, kind: e.target.value as IssueKind }))}
                    className="ml-2 rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs dark:border-neutral-600 dark:bg-neutral-800"
                  >
                    <option value="error">确定错误</option>
                    <option value="suspected">疑似错误</option>
                  </select>
                </label>
                <label className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">
                  修改意见
                  <textarea
                    value={addForm.suggestion}
                    onChange={(e) => setAddForm((f) => ({ ...f, suggestion: e.target.value }))}
                    rows={2}
                    className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                  />
                </label>
                <label className="mb-2 block text-xs text-neutral-600 dark:text-neutral-400">
                  说明（可选）
                  <textarea
                    value={addForm.reason}
                    onChange={(e) => setAddForm((f) => ({ ...f, reason: e.target.value }))}
                    rows={1}
                    className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                  />
                </label>
                <button
                  type="button"
                  onClick={confirmAdd}
                  disabled={!addForm.suggestion.trim()}
                  className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  确认添加
                </button>
              </div>
            )}

            {screenAnnotations.length === 0 && !addingAnnotation ? (
              <p className="text-sm text-neutral-500">尚未审稿。点击「AI 审稿」分析当前页，或在 PDF 上选中文字手动添加批注。</p>
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
                        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                          摘录：{a.excerpt || "—"}
                        </p>
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
                          <p className="mt-0.5 leading-relaxed">{a.suggestion?.trim() || a.reason || "—"}</p>
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
                      ) : (
                        a.suggestion?.trim() && a.reason?.trim() && (
                          <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                            <span className="text-neutral-500">说明：</span>
                            {a.reason}
                          </p>
                        )
                      )}
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
