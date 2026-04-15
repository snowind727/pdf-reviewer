"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import {
  AI_REVIEW_MODELS,
  DEFAULT_AI_REVIEW_MODEL_ID,
} from "@/lib/ai-review-models";
import type { Annotation, IssueKind, NormalizedReviewIssue } from "@/lib/review-types";
import { copyTextToClipboard } from "@/lib/copy-text";

/** 豆包「审稿提示」临时覆盖稿，仅当前浏览器标签有效，关闭标签后失效 */
const DOUBAO_SPEC_SESSION_KEY = "pdf-reviewer:doubao-editor-spec-override";
import {
  annotateTextLayerCharRanges,
  computeDomHighlightRects,
  selectionToCharRange,
  type ScreenRect,
} from "@/lib/highlight-dom";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ScreenAnnotation = Annotation & { rects: ScreenRect[] };
type ReviewMode = "precise" | "discover-more";
type PunctuationReviewMode = "check" | "ignore";
type AnnotationListItem = Annotation & { pageNumber: number };
type AnnotationTarget = { pageNumber: number; id: string };
type ActiveConnectorLine = {
  x1: number;
  y1: number;
  xMid: number;
  y2: number;
  x2: number;
  color: string;
};

function highlightBgClass(kind: IssueKind): string {
  return kind === "error" ? "bg-red-500/35" : "bg-sky-400/30";
}

function connectorColor(kind: IssueKind): string {
  return kind === "error" ? "#ef4444" : "#38bdf8";
}

function annotationTargetKey(target: AnnotationTarget): string {
  return `${target.pageNumber}:${target.id}`;
}

function elementVisibleInContainer(element: HTMLElement, container: HTMLElement): boolean {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return (
    elementRect.bottom > containerRect.top + 4 &&
    elementRect.top < containerRect.bottom - 4
  );
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

function resolveAnnotationRangeWithinSelection(
  text: string,
  selectionRange: [number, number],
  annotation: Pick<Annotation, "excerpt" | "suggestion" | "reason" | "kind">,
): [number, number] | null {
  const [selectionStart, selectionEnd] = selectionRange;
  const selectionText = text.slice(selectionStart, selectionEnd);
  const localRange = resolveIssueCharRange(selectionText, annotation);
  if (localRange) {
    return [selectionStart + localRange[0], selectionStart + localRange[1]];
  }
  return resolveIssueCharRange(text, annotation);
}

function scrollAnnotationCardIntoView(
  refs: Record<string, HTMLLIElement | null>,
  target: AnnotationTarget,
  block: ScrollLogicalPosition = "nearest",
) {
  const key = annotationTargetKey(target);
  refs[key]?.scrollIntoView({ block, behavior: "smooth" });
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
  const [scale, setScale] = useState(1.3);

  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });

  /* --- Annotations (unified: AI + manual) ------------------------- */
  const [pageAnnotations, setPageAnnotations] = useState<Record<number, Annotation[]>>({});
  const pageFlatTextRef = useRef<Record<number, string>>({});

  const [textLayerReady, setTextLayerReady] = useState(false);
  const [screenAnnotations, setScreenAnnotations] = useState<ScreenAnnotation[]>([]);

  const [reviewMode, setReviewMode] = useState<ReviewMode>("discover-more");
  const [punctuationReviewMode, setPunctuationReviewMode] =
    useState<PunctuationReviewMode>("ignore");
  const [aiModelId, setAiModelId] = useState(DEFAULT_AI_REVIEW_MODEL_ID);
  const [batchReviewCount, setBatchReviewCount] = useState(1);
  const [batchReviewProgress, setBatchReviewProgress] = useState<{
    done: number;
    total: number;
    currentPage: number;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    variant: "warning" | "success";
  } | null>(null);

  /* --- Editing state ---------------------------------------------- */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPageNumber, setEditingPageNumber] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{
    excerpt: string;
    kind: IssueKind;
    suggestion: string;
    reason: string;
  } | null>(null);

  /* --- Text selection --------------------------------------------- */
  const [liveSelectionRange, setLiveSelectionRange] = useState<[number, number] | null>(null);
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
  const [doubaoSearchText, setDoubaoSearchText] = useState("");
  /** true：复制编校规范（editor-spec.md）+ 文本框；false：仅复制文本框 */
  const [doubaoAttachSpec, setDoubaoAttachSpec] = useState(true);
  /** 缓存 GET /api/editor-spec，避免每次点击都请求 */
  const editorSpecCacheRef = useRef<string | null>(null);
  /** 回车打开豆包前已写入剪贴板，提示用户在新标签粘贴 */
  const [doubaoCopyHint, setDoubaoCopyHint] = useState(false);
  const [doubaoSpecModalOpen, setDoubaoSpecModalOpen] = useState(false);
  const [doubaoSpecDraft, setDoubaoSpecDraft] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragOverTarget, setDragOverTarget] = useState<'bing' | 'speech' | 'doubao' | null>(null);
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ page: number; range: [number, number] }[]>([]);
  const [currentSearchResultIndex, setCurrentSearchResultIndex] = useState(-1);

  /* --- Connector line refs ---------------------------------------- */
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const pdfViewportRef = useRef<HTMLDivElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const annotationPanelRef = useRef<HTMLDivElement>(null);
  const annotationRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const [activeAnnotationTarget, setActiveAnnotationTarget] = useState<AnnotationTarget | null>(null);
  const [pendingFocusTarget, setPendingFocusTarget] = useState<AnnotationTarget | null>(null);
  const [activeConnectorLine, setActiveConnectorLine] = useState<ActiveConnectorLine | null>(null);
  /* --- Custom drag interaction ----------------------------------- */
  useEffect(() => {
    if (!isDraggingSelection) return;
    const body = document.body;
    body.classList.add("dragging-grab-cursor");

    const onMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const bing = el?.closest("#bing-search-input");
      const speech = el?.closest("#speech-search-input");
      const doubao = el?.closest("#doubao-search-input");
      if (bing) setDragOverTarget("bing");
      else if (speech) setDragOverTarget("speech");
      else if (doubao) setDragOverTarget("doubao");
      else setDragOverTarget(null);
    };

    const onMouseUp = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const text = selectionPopup?.text;
      if (text) {
        if (el?.closest("#bing-search-input")) setBingSearchText(text);
        else if (el?.closest("#speech-search-input")) setSpeechSearchText(text);
        else if (el?.closest("#doubao-search-input")) setDoubaoSearchText(text);
      }
      setIsDraggingSelection(false);
      setDragOverTarget(null);
      body.classList.remove("dragging-grab-cursor");
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      body.classList.remove("dragging-grab-cursor");
    };
  }, [isDraggingSelection, selectionPopup]);

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

  /* 预拉取编校规范，减少首次选择「加提示」时的等待 */
  useEffect(() => {
    void fetch("/api/editor-spec")
      .then((r) => {
        if (!r.ok) return;
        return r.json() as Promise<{ spec: string }>;
      })
      .then((data) => {
        if (data?.spec) editorSpecCacheRef.current = data.spec;
      })
      .catch(() => {
        /* 静默失败，用户点击时再请求 */
      });
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
      setActiveAnnotationTarget(null);
      setPendingFocusTarget(null);
      setActiveConnectorLine(null);
      setLiveSelectionRange(null);
      setSelectionPopup(null);
      setCreatingSelectionAnnotation(null);
      setSpeechSearchText("");
      setDoubaoSearchText("");
      setDoubaoCopyHint(false);
      setEditingId(null);
      setEditingPageNumber(null);
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
        const outputScale =
          typeof window !== "undefined" && window.devicePixelRatio > 0
            ? window.devicePixelRatio
            : 1;
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          await page.render({
            canvasContext: ctx,
            viewport,
            transform:
              outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
          }).promise;
        }
        if (revoked) return;
        setPageSize({ w: viewport.width, h: viewport.height });

        if (textLayerDiv && pdfjsLib?.TextLayer) {
          textLayerDiv.innerHTML = "";
          textLayerDiv.style.setProperty("--total-scale-factor", `${scale}`);
          const tc = await page.getTextContent();
          if (revoked) return;
          tlInstance = new pdfjsLib.TextLayer({
            textContentSource: tc,
            container: textLayerDiv,
            viewport,
          });
          await tlInstance.render();
          annotateTextLayerCharRanges(textLayerDiv);

          const endOfContent = document.createElement("div");
          endOfContent.className = "endOfContent";
          textLayerDiv.append(endOfContent);

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

  const annotationFeed = useMemo<AnnotationListItem[]>(() => {
    return Object.entries(pageAnnotations)
      .flatMap(([page, annotations]) =>
        (annotations ?? []).map((annotation) => ({
          ...annotation,
          pageNumber: Number(page),
        })),
      )
      .sort((a, b) => {
        if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
        const aStart = a.charRange?.[0] ?? Number.MAX_SAFE_INTEGER;
        const bStart = b.charRange?.[0] ?? Number.MAX_SAFE_INTEGER;
        if (aStart !== bStart) return aStart - bStart;
        return a.id.localeCompare(b.id);
      });
  }, [pageAnnotations]);

  const groupedAnnotationFeed = useMemo(() => {
    const groups = new Map<number, AnnotationListItem[]>();
    for (const item of annotationFeed) {
      const existing = groups.get(item.pageNumber);
      if (existing) existing.push(item);
      else groups.set(item.pageNumber, [item]);
    }
    return Array.from(groups.entries()).map(([page, items]) => ({ pageNumber: page, items }));
  }, [annotationFeed]);

  const activeAnnotationKey = activeAnnotationTarget ? annotationTargetKey(activeAnnotationTarget) : null;
  const errorAnnotationCount = annotationFeed.filter((item) => item.kind === "error").length;
  const suspectedAnnotationCount = annotationFeed.length - errorAnnotationCount;
  const currentPageAnnotationCount = pageAnnotations[pageNumber]?.length ?? 0;

  const recomputeActiveConnector = useCallback(() => {
    if (
      !activeAnnotationTarget ||
      activeAnnotationTarget.pageNumber !== pageNumber ||
      !mainAreaRef.current ||
      !pdfContainerRef.current
    ) {
      setActiveConnectorLine(null);
      return;
    }

    const activeKey = annotationTargetKey(activeAnnotationTarget);
    const card = annotationRefs.current[activeKey];
    const annotation = screenAnnotations.find((item) => item.id === activeAnnotationTarget.id);
    const firstRect = annotation?.rects[0];
    if (!card || !annotation || !firstRect) {
      setActiveConnectorLine(null);
      return;
    }

    const panel = annotationPanelRef.current;
    if (panel && !elementVisibleInContainer(card, panel)) {
      setActiveConnectorLine(null);
      return;
    }

    const mainRect = mainAreaRef.current.getBoundingClientRect();
    const pdfRect = pdfContainerRef.current.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const x1 = pdfRect.left - mainRect.left + firstRect.x + firstRect.w;
    const y1 = pdfRect.top - mainRect.top + firstRect.y + firstRect.h / 2;
    const x2 = cardRect.left - mainRect.left;
    const visibleTop = panel ? Math.max(cardRect.top, panel.getBoundingClientRect().top + 4) : cardRect.top;
    const visibleBottom = panel
      ? Math.min(cardRect.bottom, panel.getBoundingClientRect().bottom - 4)
      : cardRect.bottom;
    const y2 = (visibleTop + visibleBottom) / 2 - mainRect.top;
    if (x2 <= x1 + 24) {
      setActiveConnectorLine(null);
      return;
    }

    setActiveConnectorLine({
      x1,
      y1,
      xMid: x2 - Math.max(18, Math.min(56, (x2 - x1) * 0.28)),
      y2,
      x2,
      color: connectorColor(annotation.kind),
    });
  }, [activeAnnotationTarget, pageNumber, screenAnnotations]);

  useEffect(() => {
    recomputeActiveConnector();
  }, [recomputeActiveConnector]);

  useEffect(() => {
    if (!activeAnnotationTarget) return;

    const update = () => recomputeActiveConnector();
    const panel = annotationPanelRef.current;
    const viewport = pdfViewportRef.current;

    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    panel?.addEventListener("scroll", update);
    viewport?.addEventListener("scroll", update);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      panel?.removeEventListener("scroll", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [activeAnnotationTarget, recomputeActiveConnector]);

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

  const focusAnnotation = useCallback((target: AnnotationTarget) => {
    setActiveAnnotationTarget(target);
    setPendingFocusTarget(target);
    scrollAnnotationCardIntoView(annotationRefs.current, target);
    if (target.pageNumber !== pageNumber) {
      setPageNumber(target.pageNumber);
    }
  }, [pageNumber]);

  /* --- Text selection on PDF (native selection + endOfContent fix) -- */
  useEffect(() => {
    const div = textLayerRef.current;
    const container = pdfContainerRef.current;
    if (!div || !container || !textLayerReady) return;

    const endDiv = div.querySelector<HTMLDivElement>(".endOfContent");
    const ac = new AbortController();
    const { signal } = ac;

    let isPointerDown = false;
    let prevRange: Range | null = null;

    const resetEndOfContent = () => {
      if (endDiv) {
        div.append(endDiv);
        endDiv.style.width = "";
        endDiv.style.height = "";
      }
      div.classList.remove("selecting");
    };

    /* --- mousedown on container: clear popup & start selecting --- */
    container.addEventListener("mousedown", (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-selection-popup='true']")) return;
      setSelectionPopup(null);
      setLiveSelectionRange(null);
    }, { signal });

    /* --- mousedown on text layer: mark as selecting --- */
    div.addEventListener("mousedown", () => {
      div.classList.add("selecting");
    }, { signal });

    /* --- pointerdown / pointerup / blur: track pointer state --- */
    document.addEventListener("pointerdown", () => { isPointerDown = true; }, { signal });
    document.addEventListener("pointerup", () => {
      isPointerDown = false;
      resetEndOfContent();
    }, { signal });
    window.addEventListener("blur", () => {
      isPointerDown = false;
      resetEndOfContent();
    }, { signal });
    document.addEventListener("keyup", () => {
      if (!isPointerDown) resetEndOfContent();
    }, { signal });

    /* --- mouseup on container: finalize selection popup --- */
    container.addEventListener("mouseup", () => {
      requestAnimationFrame(() => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed) return;
        const charRange = selectionToCharRange(div, sel);
        if (!charRange) return;
        const text = (pageFlatTextRef.current[pageNumber] ?? "").slice(charRange[0], charRange[1]);
        if (!text) return;
        setLiveSelectionRange(charRange);
        const rects = computeDomHighlightRects(div, charRange[0], charRange[1]);
        if (rects.length > 0) {
          const lastRect = rects[rects.length - 1];
          setSelectionPopup({
            x: lastRect.x + lastRect.w,
            y: lastRect.y - 8,
            charRange,
            text,
          });
        }
      });
    }, { signal });

    /* --- selectionchange: live highlight + Chrome endOfContent repositioning --- */
    const isFirefox = typeof CSS !== "undefined" && CSS.supports?.("-moz-appearance", "none");

    document.addEventListener("selectionchange", () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) {
        resetEndOfContent();
        return;
      }

      const range = sel.getRangeAt(0);
      const selInTextLayer = range.intersectsNode(div);

      if (selInTextLayer) {
        div.classList.add("selecting");
      } else {
        resetEndOfContent();
      }

      if (!sel.isCollapsed) {
        const charRange = selectionToCharRange(div, sel);
        if (charRange) setLiveSelectionRange(charRange);
      }

      if (isFirefox || !endDiv || !selInTextLayer) return;

      const modifyStart = prevRange && (
        range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0
      );
      let anchor: Node = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) {
        anchor = anchor.parentNode!;
      }

      if (!modifyStart && range.endOffset === 0) {
        try {
          do {
            while (!anchor.previousSibling) anchor = anchor.parentNode!;
            anchor = anchor.previousSibling;
          } while (!anchor.childNodes.length);
        } catch {
          prevRange = range.cloneRange();
          return;
        }
      }

      const parentTextLayer = (anchor as Element).parentElement?.closest(".pdf-text-layer");
      if (parentTextLayer === div) {
        endDiv.style.width = div.style.width || "";
        endDiv.style.height = div.style.height || "";
        (anchor as Element).parentElement!.insertBefore(
          endDiv,
          modifyStart ? anchor : anchor.nextSibling,
        );
      }

      prevRange = range.cloneRange();
    }, { signal });

    return () => {
      ac.abort();
      resetEndOfContent();
    };
  }, [pageNumber, textLayerReady]);

  useEffect(() => {
    if (!pendingFocusTarget || pendingFocusTarget.pageNumber !== pageNumber || !textLayerReady) return;

    const active = screenAnnotations.find((annotation) => annotation.id === pendingFocusTarget.id);
    if (!active) {
      setPendingFocusTarget(null);
      setActiveConnectorLine(null);
      return;
    }

    if (active.rects.length > 0 && pdfViewportRef.current) {
      const firstRect = active.rects[0];
      const viewport = pdfViewportRef.current;
      const nextTop = Math.max(0, firstRect.y - Math.max(40, viewport.clientHeight * 0.24));
      viewport.scrollTo({ top: nextTop, behavior: "smooth" });
    }

    setPendingFocusTarget(null);
  }, [pageNumber, pendingFocusTarget, screenAnnotations, textLayerReady]);

  /* --- Helpers: CRUD on pageAnnotations --------------------------- */
  const deleteAnnotation = useCallback((targetPageNumber: number, id: string) => {
    setPageAnnotations((prev) => {
      const anns = prev[targetPageNumber];
      if (!anns) return prev;
      return { ...prev, [targetPageNumber]: anns.filter((a) => a.id !== id) };
    });
    if (editingId === id && editingPageNumber === targetPageNumber) {
      setEditingId(null);
      setEditingPageNumber(null);
      setEditDraft(null);
    }
    if (activeAnnotationTarget?.id === id && activeAnnotationTarget.pageNumber === targetPageNumber) {
      setActiveAnnotationTarget(null);
      setPendingFocusTarget(null);
      setActiveConnectorLine(null);
    }
  }, [activeAnnotationTarget, editingId, editingPageNumber]);

  const startEditing = useCallback((targetPageNumber: number, a: Annotation) => {
    setEditingId(a.id);
    setEditingPageNumber(targetPageNumber);
    setEditDraft({
      excerpt: a.excerpt,
      kind: a.kind,
      suggestion: a.suggestion,
      reason: a.reason,
    });
  }, []);

  const saveEditing = useCallback(() => {
    if (!editingId || !editDraft || editingPageNumber === null) return;
    const flatText = pageFlatTextRef.current[editingPageNumber] ?? "";
    const newRange = editDraft.excerpt
      ? resolveIssueCharRange(flatText, {
          excerpt: editDraft.excerpt,
          suggestion: editDraft.suggestion,
          reason: editDraft.reason,
          kind: editDraft.kind,
        })
      : null;

    setPageAnnotations((prev) => {
      const anns = prev[editingPageNumber];
      if (!anns) return prev;
      return {
        ...prev,
        [editingPageNumber]: anns.map((a) =>
          a.id === editingId
            ? { ...a, ...editDraft, charRange: newRange }
            : a,
        ),
      };
    });
    setEditingId(null);
    setEditingPageNumber(null);
    setEditDraft(null);
  }, [editingId, editDraft, editingPageNumber]);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditingPageNumber(null);
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
    document.getSelection()?.removeAllRanges();
    setError(null);
    setNotice(null);
    try {
      const { flatText, formattedText } = await loadPageText(pageNumber);
      const res = await fetch("/api/suggest-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excerpt: pending.excerpt,
          pageText: formattedText.slice(0, 48000),
          model: aiModelId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "AI 建议请求失败");
        return;
      }

      const annotationExcerpt =
        typeof data.excerpt === "string" && data.excerpt.trim()
          ? data.excerpt.trim()
          : pending.excerpt;
      const annotationKind = (data.kind as IssueKind) ?? "suspected";
      const annotationSuggestion = typeof data.suggestion === "string" ? data.suggestion : "";
      const annotationReason = typeof data.reason === "string" ? data.reason : "";
      const annotationRange = resolveAnnotationRangeWithinSelection(
        flatText,
        pending.charRange,
        {
          excerpt: annotationExcerpt,
          kind: annotationKind,
          suggestion: annotationSuggestion,
          reason: annotationReason,
        },
      );

      const newAnn: Annotation = {
        id: genId(),
        source: "selection-ai",
        excerpt: annotationExcerpt,
        kind: annotationKind,
        suggestion: annotationSuggestion,
        reason: annotationReason,
        charRange: annotationRange,
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
  }, [aiModelId, loadPageText, pageNumber, selectionPopup]);

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

  const openDoubaoSpecModal = useCallback(async () => {
    setError(null);
    try {
      let initial = "";
      const stored =
        typeof window !== "undefined"
          ? sessionStorage.getItem(DOUBAO_SPEC_SESSION_KEY)
          : null;
      if (stored !== null) {
        initial = stored;
      } else {
        if (editorSpecCacheRef.current === null) {
          const res = await fetch("/api/editor-spec");
          if (!res.ok) throw new Error("无法加载审稿规范");
          const data = (await res.json()) as { spec?: string };
          if (typeof data.spec !== "string" || !data.spec.trim()) {
            throw new Error("审稿规范内容为空");
          }
          editorSpecCacheRef.current = data.spec;
        }
        initial = editorSpecCacheRef.current ?? "";
      }
      setDoubaoSpecDraft(initial);
      setDoubaoSpecModalOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载审稿规范失败");
    }
  }, []);

  const saveDoubaoSpecOverride = useCallback(() => {
    const t = doubaoSpecDraft.trim();
    try {
      if (t === "") {
        sessionStorage.removeItem(DOUBAO_SPEC_SESSION_KEY);
      } else {
        sessionStorage.setItem(DOUBAO_SPEC_SESSION_KEY, t);
      }
      setDoubaoSpecModalOpen(false);
    } catch {
      setError("无法写入浏览器缓存（请检查是否禁用本地存储）");
    }
  }, [doubaoSpecDraft]);

  const restoreDoubaoSpecDefault = useCallback(async () => {
    setError(null);
    try {
      sessionStorage.removeItem(DOUBAO_SPEC_SESSION_KEY);
      editorSpecCacheRef.current = null;
      const res = await fetch("/api/editor-spec");
      if (!res.ok) throw new Error("无法加载审稿规范");
      const data = (await res.json()) as { spec?: string };
      if (typeof data.spec !== "string" || !data.spec.trim()) {
        throw new Error("审稿规范内容为空");
      }
      editorSpecCacheRef.current = data.spec;
      setDoubaoSpecDraft(data.spec);
    } catch (e) {
      setError(e instanceof Error ? e.message : "恢复默认失败");
    }
  }, []);

  /**
   * 先复制到剪贴板再打开豆包（不依赖对方 URL 参数；跨域无法代填输入框，粘贴最可靠）。
   * 选择「加提示」时拼接 editor-spec（含 session 临时稿）与文本框内容。
   */
  const openDoubaoChat = useCallback(async () => {
    const q = doubaoSearchText.trim();
    if (!q) return;
    setError(null);
    let toCopy = q;
    if (doubaoAttachSpec) {
      try {
        let spec: string;
        let stored: string | null = null;
        try {
          stored = sessionStorage.getItem(DOUBAO_SPEC_SESSION_KEY);
        } catch {
          stored = null;
        }
        if (stored !== null && stored.trim() !== "") {
          spec = stored;
        } else {
          if (editorSpecCacheRef.current === null) {
            const res = await fetch("/api/editor-spec");
            if (!res.ok) throw new Error("无法加载审稿规范");
            const data = (await res.json()) as { spec?: string };
            if (typeof data.spec !== "string" || !data.spec.trim()) {
              throw new Error("审稿规范内容为空");
            }
            editorSpecCacheRef.current = data.spec;
          }
          spec = editorSpecCacheRef.current as string;
        }
        toCopy = `${spec}\n\n-------正文如下-------\n\n${q}`;
      } catch (e) {
        setError(e instanceof Error ? e.message : "加载审稿规范失败");
        return;
      }
    }
    try {
      await copyTextToClipboard(toCopy);
      setDoubaoCopyHint(true);
      window.setTimeout(() => setDoubaoCopyHint(false), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "复制失败，请手动复制框内文字后再打开豆包");
      return;
    }
    window.open("https://www.doubao.com/chat/", "_blank", "noopener,noreferrer");
  }, [doubaoSearchText, doubaoAttachSpec]);

  /* --- AI review -------------------------------------------------- */
  const reviewSinglePage = useCallback(async (targetPageNumber: number, mode: ReviewMode) => {
    const { flatText, formattedText } = await loadPageText(targetPageNumber);
    const body = JSON.stringify({
      pageIndex: targetPageNumber - 1,
      text: formattedText.slice(0, 48000),
      mode,
      checkPunctuation: punctuationReviewMode === "check",
      model: aiModelId,
    });

    const REVIEW_PAGE_ATTEMPTS = 3;
    const reviewResponseRetryable = (status: number) =>
      status === 429 || status === 529 || (status >= 500 && status < 600);

    for (let attempt = 1; attempt <= REVIEW_PAGE_ATTEMPTS; attempt += 1) {
      let res: Response;
      try {
        res = await fetch("/api/review-page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        if (attempt < REVIEW_PAGE_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw new Error("AI审稿异常，请稍后再试");
      }

      let data: { error?: string; issues?: unknown } = {};
      try {
        data = await res.json();
      } catch {
        /* ignore */
      }

      if (res.ok) {
        const issues = (data.issues ?? []) as NormalizedReviewIssue[];
        const matches = matchIssuesToCharRanges(flatText, issues);
        const aiAnnotations: Annotation[] = matches.map((m) => ({
          id: genId(),
          source: "ai" as const,
          excerpt: m.excerpt,
          kind: m.kind,
          suggestion: m.suggestion ?? "",
          reason: m.reason,
          charRange: m.charRange ?? null,
        }));

        setPageAnnotations((prev) => {
          const existing = prev[targetPageNumber] ?? [];
          const preserved = existing.filter((a) => a.source !== "ai");
          return { ...prev, [targetPageNumber]: [...aiAnnotations, ...preserved] };
        });
        return;
      }

      if (attempt < REVIEW_PAGE_ATTEMPTS && reviewResponseRetryable(res.status)) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }

      if (reviewResponseRetryable(res.status)) {
        throw new Error("AI审稿异常，请稍后再试");
      }
      throw new Error(typeof data.error === "string" ? data.error : `第 ${targetPageNumber} 页审稿请求失败`);
    }

    throw new Error("AI审稿异常，请稍后再试");
  }, [aiModelId, loadPageText, punctuationReviewMode]);

  const runAiReview = useCallback(async () => {
    if (!pdfDoc) return;
    const startPage = pageNumber;
    const total = Math.min(10, Math.max(1, numPages - startPage + 1), Math.max(1, batchReviewCount));

    setError(null);
    setNotice(null);
    setBatchReviewProgress({ done: 0, total, currentPage: startPage });
    const failedPages: number[] = [];
    let firstFailedMessage: string | null = null;
    try {
      for (let offset = 0; offset < total; offset += 1) {
        const targetPageNumber = startPage + offset;
        setBatchReviewProgress({ done: offset, total, currentPage: targetPageNumber });
        try {
          await reviewSinglePage(targetPageNumber, reviewMode);
        } catch (e) {
          failedPages.push(targetPageNumber);
          if (!firstFailedMessage && e instanceof Error) {
            firstFailedMessage = e.message;
          }
          console.error(`[batch-review] 第 ${targetPageNumber} 页审稿失败:`, e);
        }
      }
      setBatchReviewProgress({ done: total, total, currentPage: startPage + total - 1 });
      if (failedPages.length > 0) {
        if (total === 1) {
          setError(firstFailedMessage ?? `第 ${startPage} 页审稿失败`);
        } else {
          setNotice({
            text: `以下页面审稿失败，但未影响后续页面：第 ${failedPages.join("、")} 页。`,
            variant: "warning",
          });
        }
      } else {
        setNotice({
          text: `AI审稿已完成，共处理 ${total} 页。`,
          variant: "success",
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "审稿失败");
    } finally {
      setBatchReviewProgress(null);
    }
  }, [batchReviewCount, numPages, pageNumber, pdfDoc, reviewMode, reviewSinglePage]);

  /* --- Search logic ----------------------------------------------- */
  const performSearch = useCallback(async (q: string) => {
    if (!pdfDoc || !q.trim()) {
      setSearchResults([]);
      setCurrentSearchResultIndex(-1);
      return;
    }
    const results: { page: number; range: [number, number] }[] = [];
    const query = q.toLowerCase();
    
    // Make sure we have text for all pages? 
    // For large docs this might be slow, but let's try a reactive indexing
    for (let pn = 1; pn <= numPages; pn++) {
      let text = pageFlatTextRef.current[pn];
      if (text === undefined) {
        try {
          const page = await pdfDoc.getPage(pn);
          const tc = await page.getTextContent();
          const items = getPageTextItems(tc.items as unknown[]);
          text = items.map((i) => i.str).join("");
          pageFlatTextRef.current[pn] = text;
        } catch { continue; }
      }
      
      let pos = 0;
      while (true) {
        const idx = text.toLowerCase().indexOf(query, pos);
        if (idx === -1) break;
        results.push({ page: pn, range: [idx, idx + query.length] });
        pos = idx + query.length;
      }
    }
    
    setSearchResults(results);
    if (results.length > 0) {
      setCurrentSearchResultIndex(0);
      const first = results[0];
      if (first.page !== pageNumber) setPageNumber(first.page);
    } else {
      setCurrentSearchResultIndex(-1);
    }
  }, [numPages, pdfDoc, pageNumber]);

  const nextSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIdx = (currentSearchResultIndex + 1) % searchResults.length;
    setCurrentSearchResultIndex(nextIdx);
    const next = searchResults[nextIdx];
    if (next.page !== pageNumber) setPageNumber(next.page);
  }, [currentSearchResultIndex, pageNumber, searchResults]);

  const prevSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const prevIdx = (currentSearchResultIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentSearchResultIndex(prevIdx);
    const prev = searchResults[prevIdx];
    if (prev.page !== pageNumber) setPageNumber(prev.page);
  }, [currentSearchResultIndex, pageNumber, searchResults]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setCurrentSearchResultIndex(-1);
  }, []);

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
  const aiBusy = !!batchReviewProgress || !!creatingSelectionAnnotation;
  const scaleSliderPercent = `${Math.max(0, Math.min(100, ((scale - 0.6) / 1.4) * 100))}%`;
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
    <div className="mx-auto flex min-h-0 w-full max-w-[1480px] flex-1 flex-col gap-5 px-4 pb-8 pt-2">
      {/* Header */}
      <header className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-950 dark:text-neutral-50">AI 审稿</h1>
          <p className="text-sm leading-6 text-neutral-600 dark:text-neutral-400">
            上传 PDF，可从当前页起审稿 1 到 10 页；还可选中 PDF 文字后直接调用 AI 添加 AI专审；导出 PDF 含高亮标注与批注。
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
                className="min-w-[8.5rem] rounded-xl bg-orange-500 px-6 py-3 text-sm font-medium text-white transition hover:bg-orange-600 disabled:opacity-50"
              >
                {batchReviewProgress
                  ? `审稿中… ${batchReviewProgress.done}/${batchReviewProgress.total}`
                  : "AI审稿"}
              </button>
              <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <span>审稿页数</span>
                <select
                  value={Math.min(batchReviewCount, Math.max(1, maxBatchPages))}
                  disabled={aiBusy || !pdfDoc}
                  onChange={(e) => setBatchReviewCount(Number(e.target.value))}
                  className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                >
                  {Array.from({ length: Math.max(1, maxBatchPages) }, (_, i) => i + 1).map((count) => (
                    <option key={count} value={count}>
                      {count} 页
                    </option>
                  ))}
                </select>
              </div>
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
                <span>检查排版/符号</span>
                <select
                  value={punctuationReviewMode}
                  disabled={aiBusy || !pdfDoc}
                  onChange={(e) =>
                    setPunctuationReviewMode(e.target.value as PunctuationReviewMode)
                  }
                  className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                >
                  <option value="check">是</option>
                  <option value="ignore">否</option>
                </select>
              </div>
              <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <span>选择模型</span>
                <select
                  value={aiModelId}
                  disabled={aiBusy || !pdfDoc}
                  onChange={(e) => setAiModelId(e.target.value)}
                  className="max-w-[min(100vw-6rem,18rem)] rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                  title="MiniMax 需 MINIMAX_API_KEY；方舟需 ARK_API_KEY；列表见 lib/ai-review-models.ts"
                >
                  {AI_REVIEW_MODELS.map((m, i) => (
                    <option key={`ai-opt-${i}-${m.id}`} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
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
            正在审稿第 {batchReviewProgress.currentPage} 页，已完成 {batchReviewProgress.done} / {batchReviewProgress.total} 页。
          </p>
        )}
        {notice && (
          <p
            className={
              notice.variant === "success"
                ? "mt-2 text-sm text-emerald-700 dark:text-emerald-400"
                : "mt-2 text-sm text-amber-700 dark:text-amber-300"
            }
            role="status"
          >
            {notice.text}
          </p>
        )}
        {pdfjsError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{pdfjsError}</p>}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </header>

      {/* Main */}
      {fileUrl && (
        <div ref={mainAreaRef} className="relative flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:items-start">
          {/* SVG connector lines */}
          {activeConnectorLine && (
            <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible">
              <polyline
                points={`${activeConnectorLine.x1},${activeConnectorLine.y1} ${activeConnectorLine.xMid},${activeConnectorLine.y1} ${activeConnectorLine.xMid},${activeConnectorLine.y2} ${activeConnectorLine.x2},${activeConnectorLine.y2}`}
                fill="none"
                stroke={activeConnectorLine.color}
                strokeWidth={2}
                strokeDasharray="6,4"
                opacity={0.9}
              />
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
                    "上传 PDF 后，可直接用“AI审稿”从当前页开始处理，默认审 1 页。",
                    "如需批量处理，可把审稿页数调大，从当前页起连续审核最多 10 页。",
                    "选中文本后可“复制”或直接“AI专审”。",
                    "需要核对讲话原文时，可把内容粘贴到“重要讲话数据库”中按回车搜索。",
                    "「豆包搜索」：Enter 或下方按钮会复制到剪贴板并打开豆包，在豆包输入框手动粘贴即可。",
                    "若某条 AI 批注无法在 PDF 文本层定位，仍会出现在右侧批注列表中，页面上不会高亮。",
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

          {doubaoSpecModalOpen && (
            <div className="fixed inset-0 z-[41] flex items-center justify-center bg-black/40 px-4">
              <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-3xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
                <div className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
                  <div>
                    <h2 className="text-lg font-semibold text-neutral-950 dark:text-neutral-50">修改审稿提示词</h2>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      仅保存在本标签页缓存；关闭标签或新开会重新从服务器读取。复制到豆包时优先使用此处内容。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDoubaoSpecModalOpen(false)}
                    className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  >
                    关闭
                  </button>
                </div>
                <textarea
                  value={doubaoSpecDraft}
                  onChange={(e) => setDoubaoSpecDraft(e.target.value)}
                  className="min-h-[min(50vh,320px)] flex-1 resize-y border-0 bg-white px-5 py-3 text-sm leading-relaxed text-neutral-900 outline-none dark:bg-neutral-950 dark:text-neutral-100"
                  placeholder="审稿规范全文…"
                  spellCheck={false}
                />
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
                  <button
                    type="button"
                    onClick={() => void restoreDoubaoSpecDefault()}
                    className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  >
                    恢复默认
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDoubaoSpecModalOpen(false);
                    }}
                    className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={saveDoubaoSpecOverride}
                    className="rounded-xl bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-700"
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="grid min-h-0 min-w-0 flex-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)]">
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
                    id="bing-search-input"
                    value={bingSearchText}
                    onChange={(e) => setBingSearchText(e.target.value)}
                    placeholder="输入要搜索的内容"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        openBingSearch();
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setDragOverTarget('bing');
                    }}
                    onDragLeave={() => setDragOverTarget((v) => v === 'bing' ? null : v)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const text = e.dataTransfer.getData('text/plain');
                      if (text) setBingSearchText(text);
                      setDragOverTarget(null);
                    }}
                    className={`mt-4 block min-h-0 flex-1 resize-none rounded-2xl border bg-white px-4 py-3 text-sm leading-relaxed text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-amber-400 dark:bg-neutral-950 dark:text-neutral-100 transition-all ${
                      dragOverTarget === 'bing'
                        ? 'border-amber-500 ring-2 ring-amber-300 dark:border-amber-400 dark:ring-amber-500/40'
                        : 'border-amber-200 dark:border-amber-800'
                    }`}
                  />
                  <p className="mt-3 text-xs text-amber-900/75 dark:text-amber-100/60">按 Enter 搜索，按 Shift + Enter 换行。</p>
                </div>
              </section>

              <section className="relative flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-3xl border border-sky-200 bg-[radial-gradient(circle_at_top_left,_rgba(186,230,253,0.5),_transparent_36%),linear-gradient(180deg,rgba(240,249,255,0.98),rgba(248,250,252,0.98))] p-5 shadow-sm dark:border-sky-900 dark:bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_36%),linear-gradient(180deg,rgba(2,6,23,0.98),rgba(3,7,18,0.98))]">
                <div className="pointer-events-none absolute -left-8 top-12 h-24 w-24 rounded-full bg-sky-200/40 blur-3xl dark:bg-sky-500/10" />
                <div className="relative flex h-full flex-col">
                  <h2 className="text-xl font-semibold tracking-tight text-sky-950 dark:text-sky-50">重要讲话数据库</h2>
                  <textarea
                    id="speech-search-input"
                    value={speechSearchText}
                    onChange={(e) => setSpeechSearchText(e.target.value)}
                    placeholder="输入要检索的讲话内容"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        openSpeechDatabaseSearch();
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setDragOverTarget('speech');
                    }}
                    onDragLeave={() => setDragOverTarget((v) => v === 'speech' ? null : v)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const text = e.dataTransfer.getData('text/plain');
                      if (text) setSpeechSearchText(text);
                      setDragOverTarget(null);
                    }}
                    className={`mt-4 block min-h-0 flex-1 resize-none rounded-2xl border bg-white px-4 py-3 text-sm leading-relaxed text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-sky-400 dark:bg-neutral-950 dark:text-neutral-100 transition-all ${
                      dragOverTarget === 'speech'
                        ? 'border-sky-500 ring-2 ring-sky-300 dark:border-sky-400 dark:ring-sky-500/40'
                        : 'border-sky-200 dark:border-sky-800'
                    }`}
                  />
                  <p className="mt-3 text-xs text-sky-800/80 dark:text-sky-200/70">按 Enter 搜索，按 Shift + Enter 换行。</p>
                </div>
              </section>

              <section className="relative flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-3xl border border-violet-200 bg-[radial-gradient(circle_at_top_left,_rgba(196,181,253,0.45),_transparent_36%),linear-gradient(180deg,rgba(245,243,255,0.98),rgba(250,245,255,0.98))] p-5 shadow-sm dark:border-violet-900 dark:bg-[radial-gradient(circle_at_top_left,_rgba(139,92,246,0.16),_transparent_36%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(3,7,18,0.98))]">
                <div className="pointer-events-none absolute -right-6 bottom-8 h-20 w-20 rounded-full bg-violet-300/35 blur-3xl dark:bg-violet-500/10" />
                <div className="relative flex h-full flex-col">
                  <button
                    type="button"
                    onClick={() => void openDoubaoSpecModal()}
                    className="absolute right-0 top-0 z-10 text-[11px] font-normal text-violet-600 underline underline-offset-2 hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300"
                  >
                    修改提示
                  </button>
                  <div className="flex min-w-0 flex-nowrap items-center gap-2 pr-16">
                    <h2 className="shrink-0 text-xl font-semibold tracking-tight text-violet-950 dark:text-violet-50">
                      豆包搜索
                    </h2>
                    <select
                      value={doubaoAttachSpec ? "with-spec" : "no-spec"}
                      onChange={(e) => setDoubaoAttachSpec(e.target.value === "with-spec")}
                      className="shrink-0 rounded-lg border border-violet-200/90 bg-white px-2 py-1 text-xs font-medium text-violet-950 shadow-sm outline-none focus:border-violet-400 dark:border-violet-700 dark:bg-neutral-950 dark:text-violet-100"
                      aria-label="加提示或不提示"
                    >
                      <option value="with-spec">加提示</option>
                      <option value="no-spec">不提示</option>
                    </select>
                  </div>
                  <textarea
                    id="doubao-search-input"
                    value={doubaoSearchText}
                    onChange={(e) => setDoubaoSearchText(e.target.value)}
                    placeholder="输入要在豆包中发送的内容"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void openDoubaoChat();
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setDragOverTarget("doubao");
                    }}
                    onDragLeave={() => setDragOverTarget((v) => (v === "doubao" ? null : v))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const text = e.dataTransfer.getData("text/plain");
                      if (text) setDoubaoSearchText(text);
                      setDragOverTarget(null);
                    }}
                    className={`mt-4 block min-h-0 flex-1 resize-none rounded-2xl border bg-white px-4 py-3 text-sm leading-relaxed text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:bg-neutral-950 dark:text-neutral-100 transition-all ${
                      dragOverTarget === "doubao"
                        ? "border-violet-500 ring-2 ring-violet-300 dark:border-violet-400 dark:ring-violet-500/40"
                        : "border-violet-200 dark:border-violet-800"
                    }`}
                  />
                  <p className="mt-3 text-xs leading-relaxed text-violet-900/80 dark:text-violet-200/70">
                    按 Enter 或下方按钮：会将本框内容复制到剪贴板并打开豆包，在豆包输入框手动粘贴即可。
                  </p>
                  {doubaoCopyHint && (
                    <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      已复制，请在新开的豆包页中粘贴。
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!doubaoSearchText.trim()}
                    onClick={() => void openDoubaoChat()}
                    className="mt-2 w-full rounded-xl border border-violet-300/80 bg-white/80 px-3 py-2 text-xs font-medium text-violet-900 transition hover:bg-violet-50 disabled:opacity-40 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-100 dark:hover:bg-violet-950/70"
                  >
                    复制并打开豆包
                  </button>
                </div>
              </section>
            </div>
          </aside>

          <div className="flex min-h-0 items-center justify-start rounded-2xl border border-neutral-200 bg-white px-4 py-2.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 lg:col-start-2 lg:row-start-1">
            <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-x-3 gap-y-2 text-sm">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
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
              <div className="shrink-0 rounded-xl bg-neutral-100 px-3 py-2 leading-none text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                第 {pageNumber} / {numPages || "—"} 页
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                  className="w-[4.5ch] min-w-[2.5rem] max-w-[3.75rem] rounded-xl border border-neutral-300 bg-white px-1 py-2 text-center tabular-nums leading-none text-sm [appearance:textfield] dark:border-neutral-700 dark:bg-neutral-950 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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

              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-initial">
                <span className="whitespace-nowrap text-neutral-500 dark:text-neutral-400">缩放</span>
                <button
                  type="button"
                  disabled={!pdfDoc || scale <= 0.6}
                  aria-label="缩小"
                  title="缩小 0.1×"
                  onClick={() =>
                    setScale((s) => Math.max(0.6, Math.round((Math.min(s, 2) - 0.1) * 10) / 10))
                  }
                  className="rounded-xl border border-neutral-300 px-2.5 py-2 text-sm font-medium leading-none text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
                >
                  −
                </button>
                <div className="relative flex h-8 w-[6.5rem] shrink-0 items-center justify-center sm:w-28">
                  <input
                    type="range"
                    min={0.6}
                    max={2}
                    step={0.1}
                    value={scale}
                    disabled={!pdfDoc}
                    onChange={(e) =>
                      setScale(Math.round(Number(e.target.value) * 10) / 10)
                    }
                    className="pdf-scale-slider relative z-0 m-0 h-2 w-full cursor-pointer align-middle"
                    style={{ backgroundSize: `${scaleSliderPercent} 100%, 100% 100%` }}
                  />
                  <span className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded bg-white/90 px-1 text-[11px] font-semibold tabular-nums leading-none text-neutral-800 shadow-sm dark:bg-neutral-950/90 dark:text-neutral-100">
                    {scale.toFixed(1)}×
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!pdfDoc || scale >= 2}
                  aria-label="放大"
                  title="放大 0.1×"
                  onClick={() =>
                    setScale((s) => Math.min(2, Math.round((Math.max(s, 0.6) + 0.1) * 10) / 10))
                  }
                  className="rounded-xl border border-neutral-300 px-2.5 py-2 text-sm font-medium leading-none text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {/* PDF canvas + overlays */}
          <div
            ref={pdfViewportRef}
            className="relative h-full min-h-0 overflow-auto rounded-2xl border border-neutral-200 bg-neutral-100 p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 lg:col-start-2 lg:row-start-2"
          >
            {!docLoading && !docError && pdfDoc && (
              <>
                <button
                  type="button"
                  disabled={pageNumber <= 1}
                  aria-label="上一页"
                  onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                  className="absolute left-px top-1/2 z-20 hidden -translate-y-1/2 items-center justify-center rounded-xl border border-neutral-200 bg-white/95 px-1.5 py-3 text-neutral-700 shadow-sm backdrop-blur-sm transition hover:bg-neutral-50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-200 dark:hover:bg-neutral-800 sm:inline-flex"
                >
                  <span className="text-[11px] font-medium leading-tight tracking-normal [writing-mode:vertical-rl]">
                    上一页
                  </span>
                </button>
                <button
                  type="button"
                  disabled={pageNumber >= numPages}
                  aria-label="下一页"
                  onClick={() => setPageNumber((p) => Math.min(numPages || p, p + 1))}
                  className="absolute right-px top-1/2 z-20 hidden -translate-y-1/2 items-center justify-center rounded-xl border border-neutral-200 bg-white/95 px-1.5 py-3 text-neutral-700 shadow-sm backdrop-blur-sm transition hover:bg-neutral-50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-200 dark:hover:bg-neutral-800 sm:inline-flex"
                >
                  <span className="text-[11px] font-medium leading-tight tracking-normal [writing-mode:vertical-rl]">
                    下一页
                  </span>
                </button>
              </>
            )}
            {/* PDF Search Trigger */}
            {!isSearchOpen && pdfDoc && (
              <button
                type="button"
                onClick={() => setIsSearchOpen(true)}
                className="absolute right-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200 bg-white shadow-sm transition-all hover:bg-neutral-50 active:scale-95 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-neutral-600 dark:text-neutral-400"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </button>
            )}

            {/* Floating Search Bar */}
            {isSearchOpen && (
              <div className="absolute right-4 top-4 z-40 flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white/95 p-2 shadow-2xl backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/95">
                <div className="flex min-w-[200px] items-center px-2">
                  <input
                    autoFocus
                    type="text"
                    placeholder="搜索文档内容..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      performSearch(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (e.shiftKey) prevSearchResult();
                        else nextSearchResult();
                      } else if (e.key === "Escape") {
                        closeSearch();
                      }
                    }}
                    className="w-full bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
                  />
                </div>

                <div className="flex items-center gap-1 border-l border-neutral-200 pl-2 dark:border-neutral-800">
                  {searchResults.length > 0 && (
                    <span className="mr-2 text-[10px] font-medium tabular-nums text-neutral-500 dark:text-neutral-400">
                      {currentSearchResultIndex + 1} / {searchResults.length}
                    </span>
                  )}
                  
                  <button
                    type="button"
                    onClick={prevSearchResult}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    onClick={nextSearchResult}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    onClick={closeSearch}
                    className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            <div className="flex min-h-full w-full flex-col items-center justify-start">
            {docLoading && <p className="text-sm text-neutral-500">正在打开 PDF…</p>}
            {docError && <p className="text-sm text-red-600">{docError}</p>}
            {!docLoading && !docError && pdfDoc && (
              <div className="relative flex w-full max-w-full justify-center">
                <div className="flex min-w-0 justify-center">
                <div
                  ref={pdfContainerRef}
                  className="relative shrink-0 shadow-md"
                  style={pageSize.w ? { width: pageSize.w, height: pageSize.h } : undefined}
                >
                <canvas ref={canvasRef} className="block" />
                <div ref={textLayerRef} className="pdf-text-layer" />

                {/* Highlight overlays */}
                {pageSize.w > 0 &&
                  screenAnnotations.map((a) =>
                    a.rects.map((r, ri) => {
                      const isActive =
                        activeAnnotationTarget?.pageNumber === pageNumber &&
                        activeAnnotationTarget.id === a.id;
                      return (
                        <button
                          key={`${a.id}-${ri}`}
                          type="button"
                          onClick={() => {
                            focusAnnotation({ pageNumber, id: a.id });
                            scrollAnnotationCardIntoView(
                              annotationRefs.current,
                              { pageNumber, id: a.id },
                              "center",
                            );
                          }}
                          className={`absolute z-[3] rounded-sm border-0 p-0 transition cursor-pointer appearance-none ${
                            isActive
                              ? a.kind === "error"
                                ? "bg-red-500/50 outline outline-2 outline-red-500/80"
                                : "bg-sky-400/50 outline outline-2 outline-sky-500/80"
                              : `${highlightBgClass(a.kind)} hover:outline hover:outline-2 hover:outline-orange-400/80`
                          }`}
                          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                          aria-label={`定位到第 ${pageNumber} 页批注`}
                        />
                      );
                    }),
                  )}

                {/* Yellow preview highlight: live selection / popup / AI generation */}
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
                  if (pendingRects.length === 0) return null;
                  const showGrab = selectionPopup && !creatingSelectionAnnotation;
                  let grabBox: ScreenRect | null = null;
                  if (showGrab) {
                    const minX = Math.min(...pendingRects.map((r) => r.x));
                    const minY = Math.min(...pendingRects.map((r) => r.y));
                    const maxX = Math.max(...pendingRects.map((r) => r.x + r.w));
                    const maxY = Math.max(...pendingRects.map((r) => r.y + r.h));
                    grabBox = { x: minX + 4, y: minY + 4, w: Math.max(0, maxX - minX - 8), h: Math.max(0, maxY - minY - 8) };
                  }
                  return (
                    <>
                      {pendingRects.map((r, ri) => (
                        <div
                          key={`pending-${ri}`}
                          className="pointer-events-none absolute z-[1] rounded-sm bg-yellow-400/40"
                          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                        />
                      ))}
                      {grabBox && (
                        <div
                          data-selection-popup="true"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setIsDraggingSelection(true);
                          }}
                          className="absolute z-[3] cursor-grab active:cursor-grabbing"
                          style={{ left: grabBox.x, top: grabBox.y, width: grabBox.w, height: grabBox.h }}
                        />
                      )}
                    </>
                  );
                })()}

                {/* Highlight current search result */}
                {(() => {
                  if (!pageSize.w || currentSearchResultIndex === -1 || !textLayerRef.current) return null;
                  const match = searchResults[currentSearchResultIndex];
                  if (!match || match.page !== pageNumber) return null;
                  
                  const rects = computeDomHighlightRects(textLayerRef.current, match.range[0], match.range[1]);
                  return rects.map((r, ri) => (
                    <div
                      key={`search-match-${ri}`}
                      className="pointer-events-none absolute z-[1] rounded-sm bg-blue-500/40 outline outline-1 outline-blue-500/60"
                      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                    />
                  ));
                })()}

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
                        {copySelectionFeedback ? "已复制" : "复制"}
                      </button>
                      <button
                        type="button"
                        data-selection-popup="true"
                        onMouseDown={(e) => e.stopPropagation()}
                        disabled={!!creatingSelectionAnnotation}
                        onClick={() => void createAnnotationFromSelection()}
                        className="rounded bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/15 disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
                      >
                        {creatingSelectionAnnotation ? "AI 生成中…" : "AI专审"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
                </div>
              </div>
            )}
            </div>
          </div>
          </div>

          {/* Sidebar */}
          <aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-[360px] xl:w-[420px]">
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">批注面板</h2>
                  <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                    按页码和文内顺序展示全部批注，点击卡片可定位到对应页面。
                  </p>
                </div>
                <div className="rounded-xl bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                  共 {annotationFeed.length} 条
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
                  <div className="text-neutral-500 dark:text-neutral-400">当前页</div>
                  <div className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{currentPageAnnotationCount}</div>
                </div>
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/50 dark:bg-red-950/20">
                  <div className="text-red-600 dark:text-red-300">确定错误</div>
                  <div className="mt-1 text-sm font-semibold text-red-700 dark:text-red-200">{errorAnnotationCount}</div>
                </div>
                <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 dark:border-sky-900/50 dark:bg-sky-950/20">
                  <div className="text-sky-700 dark:text-sky-300">疑似问题</div>
                  <div className="mt-1 text-sm font-semibold text-sky-800 dark:text-sky-200">{suspectedAnnotationCount}</div>
                </div>
              </div>

              {creatingSelectionAnnotation && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20">
                  <div className="flex items-center justify-between gap-2 border-b border-amber-200/70 pb-2 dark:border-amber-900/60">
                    <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                      生成中
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">第 {pageNumber} 页</span>
                  </div>
                  <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                    摘录：{creatingSelectionAnnotation.excerpt || "—"}
                  </p>
                  <div className="mt-2 rounded-md bg-white/80 px-2.5 py-2 text-neutral-900 dark:bg-neutral-900/70 dark:text-neutral-100">
                    <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">修改意见</span>
                    <p className="mt-0.5 leading-relaxed">AI 正在生成批注…</p>
                  </div>
                </div>
              )}

              <div
                ref={annotationPanelRef}
                className="mt-4 max-h-[calc(100vh-11rem)] overflow-y-auto pr-1"
              >
                {annotationFeed.length === 0 && !creatingSelectionAnnotation ? (
                  <p className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
                    尚未审稿。点击「AI审稿」分析页面，或在 PDF 上选中文字后直接添加 AI 批注。
                  </p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {groupedAnnotationFeed.map((group) => (
                      <section key={group.pageNumber} className="flex flex-col gap-3">
                        <div className="sticky top-0 z-[1] flex items-center justify-between rounded-xl border border-neutral-200 bg-white/95 px-3 py-2 text-xs backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
                          <span className="font-medium text-neutral-700 dark:text-neutral-200">第 {group.pageNumber} 页</span>
                          <span className="text-neutral-500 dark:text-neutral-400">{group.items.length} 条批注</span>
                        </div>

                        <ul className="flex flex-col gap-3">
                          {group.items.map((a) => {
                            const target: AnnotationTarget = { pageNumber: group.pageNumber, id: a.id };
                            const itemKey = annotationTargetKey(target);
                            const isEditing = editingId === a.id && editingPageNumber === group.pageNumber;
                            const isActive = activeAnnotationKey === itemKey;
                            const currentPageScreenAnnotation =
                              group.pageNumber === pageNumber
                                ? screenAnnotations.find((item) => item.id === a.id)
                                : null;
                            const isUnmapped = !a.charRange || (group.pageNumber === pageNumber && currentPageScreenAnnotation?.rects.length === 0);

                            return (
                              <li
                                key={itemKey}
                                ref={(el) => {
                                  annotationRefs.current[itemKey] = el;
                                }}
                                onClick={() => focusAnnotation(target)}
                                className={`cursor-pointer rounded-xl border bg-white p-3 text-sm shadow-sm transition dark:bg-neutral-900 ${
                                  isActive
                                    ? "border-orange-300 ring-2 ring-orange-200 dark:border-orange-500/60 dark:ring-orange-500/20"
                                    : a.kind === "error"
                                      ? "border-l-4 border-l-red-500 border-neutral-200 dark:border-neutral-700"
                                      : "border-l-4 border-l-sky-500 border-neutral-200 dark:border-neutral-700"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2 border-b border-neutral-100 pb-2 dark:border-neutral-800">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="rounded bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                                      第 {group.pageNumber} 页
                                    </span>
                                    {a.source === "manual" && (
                                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                                        手动
                                      </span>
                                    )}
                                    {a.source === "selection-ai" && (
                                      <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900 dark:text-violet-300">
                                        选区 AI
                                      </span>
                                    )}
                                    {isEditing ? (
                                      <select
                                        value={editDraft!.kind}
                                        onClick={(e) => e.stopPropagation()}
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
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            saveEditing();
                                          }}
                                          className="rounded px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                                        >
                                          保存
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            cancelEditing();
                                          }}
                                          className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                        >
                                          取消
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            startEditing(group.pageNumber, a);
                                          }}
                                          className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                                        >
                                          编辑
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            deleteAnnotation(group.pageNumber, a.id);
                                          }}
                                          className="rounded px-2 py-0.5 text-xs text-red-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950 dark:hover:text-red-300"
                                        >
                                          删除
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>

                                {isUnmapped && (
                                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                    （未能定位到 PDF 文本，仅显示批注）
                                  </p>
                                )}

                                {isEditing ? (
                                  <div className="mt-2">
                                    <label className="text-xs text-neutral-500">摘录</label>
                                    <input
                                      type="text"
                                      value={editDraft!.excerpt}
                                      onClick={(e) => e.stopPropagation()}
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

                                {isEditing ? (
                                  <div className="mt-2">
                                    <label className="text-xs text-neutral-500">修改意见</label>
                                    <textarea
                                      value={editDraft!.suggestion}
                                      onClick={(e) => e.stopPropagation()}
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

                                {isEditing ? (
                                  <div className="mt-2">
                                    <label className="text-xs text-neutral-500">说明</label>
                                    <textarea
                                      value={editDraft!.reason}
                                      onClick={(e) => e.stopPropagation()}
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
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {!fileUrl && <p className="text-sm text-neutral-500">请先上传 PDF 文件。</p>}
    </div>
  );
}
