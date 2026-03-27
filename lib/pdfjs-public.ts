/**
 * 从 /public/pdfjs/ 用浏览器原生 dynamic import 加载 pdf.js，不经 Webpack 打包，
 * 避免 pdf.mjs 与 Next 冲突（Object.defineProperty called on non-object）。
 */
export type PdfPageViewportLike = {
  width: number;
  height: number;
  transform: number[];
  convertToPdfPoint: (x: number, y: number) => number[];
};

export type TextLayerInstance = {
  render: () => Promise<void>;
  cancel: () => void;
};

export type PdfJsModule = {
  version: string;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (
    src: string | { url: string } | { data: Uint8Array },
  ) => {
    promise: Promise<PdfDocumentLike>;
    destroy?: () => void;
  };
  TextLayer?: new (opts: {
    textContentSource: { items: unknown[] };
    container: HTMLElement;
    viewport: PdfPageViewportLike;
  }) => TextLayerInstance;
};

export type PdfDocumentLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  destroy: () => void;
};

export type PdfPageLike = {
  getViewport: (opts: { scale: number }) => PdfPageViewportLike;
  getTextContent: () => Promise<{ items: unknown[] }>;
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfPageViewportLike;
  }) => { promise: Promise<void> };
};

let cached: Promise<PdfJsModule> | null = null;

export function loadPdfJsFromPublic(): Promise<PdfJsModule> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("loadPdfJsFromPublic 仅能在浏览器调用"));
  }
  if (!cached) {
    const libUrl = new URL("/pdfjs/pdf.min.mjs", window.location.origin).href;
    const workerUrl = new URL("/pdfjs/pdf.worker.min.mjs", window.location.origin)
      .href;
    cached = import(
      /* webpackIgnore: true */
      libUrl
    ).then((mod: Record<string, unknown>) => {
      const pdfjs = (mod.default ?? mod) as PdfJsModule;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return cached;
}
