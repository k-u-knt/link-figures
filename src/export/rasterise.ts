/** Pixels as `getImageData` gives them: RGBA, 8 bits a sample, row by row. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Draws a page's SVG at `widthPx` × `heightPx`, flattened onto `background` (itself over white), and answers with its
 * pixels. Fails with an Error that says what went wrong.
 */
export type Rasterise = (svg: string, widthPx: number, heightPx: number, background: string) => Promise<RasterImage>;

/** Draws a page's SVG as `Rasterise` does, and answers with the canvas encoded as a PNG file's bytes. */
export type RenderPng = (svg: string, widthPx: number, heightPx: number, background: string) => Promise<Uint8Array>;

/** Draws an SVG at `widthPx` × `heightPx` on a clear canvas (its alpha kept), and answers with it as a PNG file's bytes. */
export type RenderClearPng = (svg: string, widthPx: number, heightPx: number) => Promise<Uint8Array>;

/**
 * What the raster exporters draw with: the browser's canvas, or a fake in tests. TIFF needs the pixels (`rasterise`);
 * PNG takes the canvas's own encoding (`renderPng`), so the pixels are never copied out of the canvas.
 */
export interface RasterBackend {
  rasterise: Rasterise;
  renderPng: RenderPng;
}

const WHITE = "#ffffff";
const TRANSPARENT = new Set(["", "none", "transparent"]);

/** What a page is flattened onto: its paper, or white when the paper is transparent. */
export function paperBackground(paper: string): string {
  return TRANSPARENT.has(paper.trim().toLowerCase()) ? WHITE : paper;
}

const ROOT = /<svg\b[^>]*>/;

/**
 * The SVG with its root's `width` and `height` set to the pixel size it is drawn at (the builder gives them in mm), so
 * that the browser lays it out at that size, not at its CSS size scaled up. The viewBox maps the content onto it.
 */
export function sizedSvg(svg: string, widthPx: number, heightPx: number): string {
  const match = ROOT.exec(svg);
  if (!match) throw new Error("the page's SVG has no <svg> root");
  const rest = match[0]
    .slice(4)
    .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/g, "");
  const root = `<svg width="${widthPx}" height="${heightPx}"${rest}`;
  return svg.slice(0, match.index) + root + svg.slice(match.index + match[0].length);
}

type Context2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

/** A canvas of the size: an `OffscreenCanvas`, or a `<canvas>` where there is none. */
function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every pixel is opaque once the background is filled, so a transparent corner means the canvas never got its pixels
 * (a canvas the browser could not allocate draws nothing and says nothing).
 */
function checkDrawn(context: Context2d, width: number, height: number): void {
  const corner = (x: number, y: number) => context.getImageData(x, y, 1, 1).data[3];
  let opaque: boolean;
  try {
    opaque = corner(0, 0) === 255 && corner(width - 1, height - 1) === 255;
  } catch {
    opaque = false;
  }
  if (!opaque) throw new Error(`the canvas could not be drawn at ${width} × ${height} px`);
}

/**
 * The page drawn on a canvas, handed to `use`: the SVG loaded from a Blob URL into an `Image`, decoded, and drawn onto a
 * canvas filled with white and then the background. The page's SVG is self-contained (its images are data URIs), so
 * nothing else is fetched. The URL is revoked and the canvas's memory let go (its size set to 0) whatever happens.
 * A null background leaves the canvas clear, with its alpha.
 */
async function drawPage<T>(svg: string, width: number, height: number, background: string | null, use: (canvas: AnyCanvas, context: Context2d) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(new Blob([sizedSvg(svg, width, height)], { type: "image/svg+xml" }));
  let canvas: AnyCanvas | undefined;
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch (error) {
      throw new Error(`the page's SVG could not be loaded as an image: ${message(error)}`);
    }
    canvas = makeCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: background === null }) as Context2d | null;
    if (!context) throw new Error(`the canvas could not be drawn at ${width} × ${height} px`);
    if (background !== null) {
      context.fillStyle = WHITE;
      context.fillRect(0, 0, width, height);
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    return await use(canvas, context);
  } finally {
    URL.revokeObjectURL(url);
    if (canvas) canvas.width = canvas.height = 0;
  }
}

/** The browser's rasteriser: the page drawn on a canvas, and its pixels read back. */
export const rasteriseSvg: Rasterise = (svg, widthPx, heightPx, background) =>
  drawPage(svg, widthPx, heightPx, background, async (_canvas, context) => {
    let image: ImageData;
    try {
      image = context.getImageData(0, 0, widthPx, heightPx);
    } catch (error) {
      throw new Error(`the pixels of a ${widthPx} × ${heightPx} px canvas could not be read: ${message(error)}`);
    }
    if (image.data[3] !== 255 || image.data[image.data.length - 1] !== 255) throw new Error(`the canvas could not be drawn at ${widthPx} × ${heightPx} px`);
    return image;
  });

/** The browser's PNG: the page drawn on a canvas, and the canvas encoded as a PNG straight from it. */
export const renderPngOnCanvas: RenderPng = (svg, widthPx, heightPx, background) =>
  drawPage(svg, widthPx, heightPx, background, async (canvas, context) => {
    checkDrawn(context, widthPx, heightPx);
    const blob =
      "convertToBlob" in canvas
        ? await canvas.convertToBlob({ type: "image/png" })
        : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(`a ${widthPx} × ${heightPx} px image is too large to encode as a PNG`);
    return new Uint8Array(await blob.arrayBuffer());
  });

/** The PNG of a canvas, encoded straight from it. */
async function encodePng(canvas: AnyCanvas, widthPx: number, heightPx: number): Promise<Uint8Array> {
  const blob =
    "convertToBlob" in canvas
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`a ${widthPx} × ${heightPx} px image is too large to encode as a PNG`);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The browser's clear PNG: the SVG drawn on a canvas left transparent, so what it does not cover stays clear (an item
 * written as a picture over others). A canvas the browser could not allocate is not caught here, as it is for a page.
 */
export const renderClearPngOnCanvas: RenderClearPng = (svg, widthPx, heightPx) =>
  drawPage(svg, widthPx, heightPx, null, async (canvas) => encodePng(canvas, widthPx, heightPx));

export const browserRaster: RasterBackend = { rasterise: rasteriseSvg, renderPng: renderPngOnCanvas };
