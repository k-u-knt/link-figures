import UTIF from "utif";
import { renderSamples, type PixelRecipe } from "../../adjust/render";
import type { AdjustmentRegistry } from "../../registry/adjustment";
import type { DecodedImage } from "../types";
import { checkDecodeBudget } from "./budget";
import type { SampleCache } from "./sample-cache";
import { rgbaToPngDataUrl } from "./raster";
import { ifdToPlane, type Plane } from "./tiff-convert";

/**
 * UTIF decode of one page (index clamped into range) as a `Plane`, plus the file's page count. No DOM. A page over the
 * decode budget is refused (`DecodeLimitError`) before its pixels are decoded.
 */
export function decodeTiffPage(bytes: ArrayBuffer, pageIndex: number): { plane: Plane; pageCount: number } {
  const ifds = UTIF.decode(bytes);
  if (ifds.length === 0) throw new Error("TIFF contains no images");
  const index = Math.min(Math.max(Math.trunc(pageIndex) || 0, 0), ifds.length - 1);
  const ifd = ifds[index];
  checkDecodeBudget(ifd.t256?.[0] ?? 0, ifd.t257?.[0] ?? 0, `TIFF page ${index + 1}`);
  UTIF.decodeImage(bytes, ifd);
  if (!ifd.data) throw new Error("TIFF page has no image data");
  // `decodeImage` byte-swaps big-endian 16-bit samples to little-endian in place, so `ifd.isLE` (the file's byte
  // order) no longer describes `ifd.data`, which is little-endian either way.
  return { plane: ifdToPlane({ ...ifd, isLE: true }), pageCount: ifds.length };
}

/**
 * One TIFF page as a PNG data URL, its native samples drawn through `renderSamples` (by default 16-bit data is
 * stretched to 8 bits by `recipe.range`). With a `key` the page's plane is taken from `cache` when it is there (and
 * `bytes` are not looked at), and put there when it is decoded.
 */
export async function decodeTiff(
  bytes: ArrayBuffer,
  pageIndex: number,
  recipe: PixelRecipe,
  adjustments: AdjustmentRegistry,
  cache?: SampleCache,
  key?: string,
): Promise<DecodedImage> {
  const { plane, pageCount } = tiffPlane(bytes, pageIndex, cache, key);
  const rendered = renderSamples(plane, recipe, adjustments);
  return { dataUrl: rgbaToPngDataUrl(rendered), width: rendered.width, height: rendered.height, pageCount };
}

/** The plane of one TIFF page: from `cache` under `key` when there, else decoded (and cached under `key`). */
export function tiffPlane(bytes: ArrayBuffer, pageIndex: number, cache?: SampleCache, key?: string): { plane: Plane; pageCount: number } {
  const hit = key !== undefined ? cache?.get(key) : undefined;
  if (hit && key !== undefined) return { plane: hit, pageCount: cache?.pageCount(key) ?? 1 };
  const decoded = decodeTiffPage(bytes, pageIndex);
  if (key !== undefined) cache?.set(key, decoded.plane, decoded.pageCount);
  return decoded;
}
