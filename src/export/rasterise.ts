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

/** The pixels as a PNG file's bytes. */
export type EncodePng = (image: RasterImage) => Promise<Uint8Array>;

/** What the raster exporters draw and encode with: the browser's canvas, or a fake in tests. */
export interface RasterBackend {
  rasterise: Rasterise;
  encodePng: EncodePng;
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

/** A 2D canvas of the size: an `OffscreenCanvas`, or a `<canvas>` where there is none. */
function canvas2d(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; context: Context2d } {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d") as Context2d | null;
  if (!context) throw new Error(`a canvas of ${width} × ${height} px could not be made`);
  return { canvas, context };
}

/**
 * The browser's rasteriser: the SVG loaded from a Blob URL into an `Image`, decoded, and drawn onto a canvas filled
 * with the background first. The page's SVG is self-contained (its images are data URIs), so nothing else is fetched.
 */
export const rasteriseSvg: Rasterise = async (svg, widthPx, heightPx, background) => {
  const url = URL.createObjectURL(new Blob([sizedSvg(svg, widthPx, heightPx)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error("the page's SVG could not be loaded as an image");
    }
    const { context } = canvas2d(widthPx, heightPx);
    context.fillStyle = WHITE;
    context.fillRect(0, 0, widthPx, heightPx);
    context.fillStyle = background;
    context.fillRect(0, 0, widthPx, heightPx);
    context.drawImage(image, 0, 0, widthPx, heightPx);
    try {
      return context.getImageData(0, 0, widthPx, heightPx);
    } catch (error) {
      throw new Error(`the pixels of a ${widthPx} × ${heightPx} px canvas could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** The browser's PNG encoder: the pixels put on a canvas, and the canvas encoded as a PNG. */
export const encodePngOnCanvas: EncodePng = async (image) => {
  const { canvas, context } = canvas2d(image.width, image.height);
  context.putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
  const blob =
    "convertToBlob" in canvas
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`a ${image.width} × ${image.height} px image is too large to encode as a PNG`);
  return new Uint8Array(await blob.arrayBuffer());
};

export const browserRaster: RasterBackend = { rasterise: rasteriseSvg, encodePng: encodePngOnCanvas };
