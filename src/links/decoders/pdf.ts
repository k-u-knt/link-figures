import { loadPdfJs } from "obsidian";
import type { DecodedImage } from "../types";

// The few pdf.js members used here; `loadPdfJs` is typed `any` or `unknown` depending on which typings win.
interface PdfViewport {
  width: number;
  height: number;
}
interface PdfPage {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}
interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
interface PdfJs {
  getDocument(source: { data: Uint8Array }): PdfLoadingTask;
}

/** Opens the PDF, runs `use` on one page (index clamped into range), then always releases pdf.js's resources. */
async function withPage<T>(bytes: ArrayBuffer, pageIndex: number, use: (page: PdfPage, pageCount: number) => Promise<T>): Promise<T> {
  const pdfjs = (await loadPdfJs()) as PdfJs;
  // pdf.js may transfer the buffer to its worker, which would detach the caller's; give it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  try {
    const pdf = await task.promise;
    const index = Math.min(Math.max(Math.trunc(pageIndex) || 0, 0), pdf.numPages - 1);
    const page = await pdf.getPage(index + 1);
    return await use(page, pdf.numPages);
  } finally {
    await task.destroy();
  }
}

/** One PDF page as a PNG data URL. `scale` 1 is 72 dpi; `width` and `height` are the canvas's whole pixels. */
export async function decodePdf(bytes: ArrayBuffer, pageIndex: number, scale: number): Promise<DecodedImage> {
  return withPage(bytes, pageIndex, async (page, pageCount) => {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context unavailable");
    await page.render({ canvasContext: context, viewport }).promise;
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, pageCount };
  });
}

/** Size of a page in points (1/72 in), with its rotation applied. */
export async function pdfPageSizePt(bytes: ArrayBuffer, pageIndex: number): Promise<{ width: number; height: number }> {
  return withPage(bytes, pageIndex, async (page) => {
    const { width, height } = page.getViewport({ scale: 1 });
    return { width, height };
  });
}
