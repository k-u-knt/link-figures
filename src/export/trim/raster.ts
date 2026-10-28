import type { Rect } from "../../model/geometry";
import type { Crop } from "../../model/types";
import { pixelRect, fromFraction, type PixelRect } from "./visible";

/** Cuts `rect` out of the image `dataUri` and answers with the cut as a PNG data URI and its size. */
export type CutImage = (dataUri: string, rect: PixelRect) => Promise<{ dataUri: string; width: number; height: number }>;

/** A raster cut to a panel's visible region. */
export interface RasterCut {
  dataUri: string;
  width: number;
  height: number;
  /** The panel's crop re-expressed in the cut image, so that it is drawn where its part of the uncut one was. */
  crop: Crop;
  /** The pixels of the uncut image that were kept. */
  cut: PixelRect;
}

/**
 * The raster `dataUri` (of size `natural`) cut to `visible`, a fraction of the source (see `toFraction`), rounded outward
 * to whole pixels. `null` when that leaves every pixel in: then nothing is re-encoded. The crop (`null`: the whole
 * image) is re-expressed in the cut image's coordinates; with `cover` it reaches outside 0–1, since the box cuts the
 * crop. It keeps the crop's size in pixels, so `cropPlacement` scales and centres it exactly as before.
 */
export async function cutRaster(
  dataUri: string,
  natural: { width: number; height: number },
  crop: Crop | null,
  visible: Rect,
  cutImage: CutImage,
): Promise<RasterCut | null> {
  const cut = pixelRect(fromFraction(visible, natural), natural);
  if (cut.width === natural.width && cut.height === natural.height) return null;
  if (cut.width <= 0 || cut.height <= 0) throw new Error("the crop shows no whole pixel of the image");
  const out = await cutImage(dataUri, cut);
  if (out.width !== cut.width || out.height !== cut.height) {
    throw new Error(`the cut image is ${out.width} × ${out.height} px, not ${cut.width} × ${cut.height}`);
  }
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    dataUri: out.dataUri,
    width: cut.width,
    height: cut.height,
    crop: {
      x: (c.x * natural.width - cut.x) / cut.width,
      y: (c.y * natural.height - cut.y) / cut.height,
      w: (c.w * natural.width) / cut.width,
      h: (c.h * natural.height) / cut.height,
    },
    cut,
  };
}

/**
 * The browser's cut: the image decoded (colour-managed to sRGB, the first frame of an animation), the rectangle drawn
 * into a canvas of its size, and that canvas as a PNG.
 */
export async function cutImageOnCanvas(dataUri: string, rect: PixelRect): Promise<{ dataUri: string; width: number; height: number }> {
  const image = new Image();
  image.src = dataUri;
  try {
    await image.decode();
  } catch {
    throw new Error("the image could not be decoded");
  }
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const png = canvas.toDataURL("image/png");
  // A canvas over the browser's limit gives "data:," instead of failing.
  if (!png.startsWith("data:image/png")) throw new Error(`the cut (${rect.width} × ${rect.height} px) is too large to encode`);
  return { dataUri: png, width: rect.width, height: rect.height };
}
