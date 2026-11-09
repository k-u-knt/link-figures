import { renderSamples, type PixelRecipe } from "../../adjust/render";
import type { AdjustmentRegistry, RgbaImage } from "../../registry/adjustment";
import type { DecodedImage } from "../types";
import { checkDecodeBudget } from "./budget";
import type { SampleCache } from "./sample-cache";
import type { Plane } from "./tiff-convert";

/** 8-bit RGBA pixels as a PNG data URL, through a canvas. */
export function rgbaToPngDataUrl(image: RgbaImage): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * A raster image (PNG, JPEG, GIF, WebP, AVIF, BMP) drawn through `renderSamples` as a PNG data URL. The browser
 * decodes it to 8-bit RGBA, which is the `SampleImage` the adjustments get (8 bits, 4 samples). With a `key` the plane
 * is taken from `cache` when it is there (and `bytes` are not looked at), and put there when it is decoded.
 */
export async function decodeRaster(bytes: ArrayBuffer, recipe: PixelRecipe, adjustments: AdjustmentRegistry, cache?: SampleCache, key?: string): Promise<DecodedImage> {
  const plane = await rasterPlane(bytes, cache, key);
  const rendered = renderSamples(plane, recipe, adjustments);
  return { dataUrl: rgbaToPngDataUrl(rendered), width: rendered.width, height: rendered.height, pageCount: 1 };
}

/**
 * The 8-bit, 4-sample plane of a raster image: from `cache` under `key` when there, else decoded by the browser (and
 * cached under `key`). An image over the decode budget is refused (`DecodeLimitError`) once `createImageBitmap` has
 * decoded it (only then is its size known), before its pixels are read back.
 */
export async function rasterPlane(bytes: ArrayBuffer, cache?: SampleCache, key?: string): Promise<Plane> {
  const hit = key !== undefined ? cache?.get(key) : undefined;
  if (hit) return hit;
  // Turned by the image's EXIF orientation, as an <img> on the stage is: the plane is the upright picture.
  const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    checkDecodeBudget(width, height, "Image");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context unavailable");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    const plane: Plane = { width, height, bitsPerSample: 8, samplesPerPixel: 4, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length) };
    if (key !== undefined) cache?.set(key, plane);
    return plane;
  } finally {
    bitmap.close();
  }
}
