import { renderSamples, type PixelRecipe } from "../../adjust/render";
import type { AdjustmentRegistry, RgbaImage } from "../../registry/adjustment";
import type { DecodedImage } from "../types";
import { checkDecodeBudget } from "./budget";

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
 * decodes it to 8-bit RGBA, which is the `SampleImage` the adjustments get (8 bits, 4 samples). An image over the
 * decode budget is refused (`DecodeLimitError`) once `createImageBitmap` has decoded it (only then is its size known),
 * before its pixels are read back and drawn through the adjustments.
 */
export async function decodeRaster(bytes: ArrayBuffer, recipe: PixelRecipe, adjustments: AdjustmentRegistry): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
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
    const plane = { width, height, bitsPerSample: 8 as const, samplesPerPixel: 4 as const, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length) };
    const rendered = renderSamples(plane, recipe, adjustments);
    return { dataUrl: rgbaToPngDataUrl(rendered), width: rendered.width, height: rendered.height, pageCount: 1 };
  } finally {
    bitmap.close();
  }
}
