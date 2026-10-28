import { cropPlacement, type Rect } from "../../model/geometry";
import type { Crop } from "../../model/types";

/** A rectangle of whole pixels of an image, inside it. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How close (relative to the source's size) a visible edge must be to the source's to count as reaching it. */
const WHOLE_TOLERANCE = 1e-9;

/** How close (in pixels) an edge must be to a whole pixel to be taken as on it, so that rounding noise does not add a pixel. */
const PIXEL_SNAP = 1e-6;

/**
 * The part of the source that shows in the node's box, in the source's own units (`natural`'s), from its top-left
 * corner: the crop, further cut by the box when `cover` pushes the crop past it. This is `cropPlacement`'s `region`
 * mapped back through its `image` rectangle, cut to the source. A source without a size shows whole.
 */
export function visibleSourceRect(
  box: { width: number; height: number },
  natural: { width: number; height: number },
  crop: Crop | null,
  fit: "cover" | "contain",
): Rect {
  const whole: Rect = { x: 0, y: 0, width: natural.width, height: natural.height };
  if (!(natural.width > 0 && natural.height > 0)) return whole;
  const { image, region } = cropPlacement(box, natural, crop, fit);
  const sx = image.width / natural.width;
  const sy = image.height / natural.height;
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) return whole;
  const left = Math.max(0, (region.x - image.x) / sx);
  const top = Math.max(0, (region.y - image.y) / sy);
  const right = Math.min(natural.width, (region.x + region.width - image.x) / sx);
  const bottom = Math.min(natural.height, (region.y + region.height - image.y) / sy);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** True when `rect` covers the whole source (within rounding noise): there is nothing to trim. */
export function isWhollyVisible(rect: Rect, natural: { width: number; height: number }): boolean {
  const tx = WHOLE_TOLERANCE * Math.max(natural.width, 1);
  const ty = WHOLE_TOLERANCE * Math.max(natural.height, 1);
  return rect.x <= tx && rect.y <= ty && rect.x + rect.width >= natural.width - tx && rect.y + rect.height >= natural.height - ty;
}

/** `rect` (in pixels of an image of size `natural`) rounded outward to whole pixels and clamped to the image. */
export function pixelRect(rect: Rect, natural: { width: number; height: number }): PixelRect {
  const left = Math.max(0, Math.floor(rect.x + PIXEL_SNAP));
  const top = Math.max(0, Math.floor(rect.y + PIXEL_SNAP));
  const right = Math.min(natural.width, Math.ceil(rect.x + rect.width - PIXEL_SNAP));
  const bottom = Math.min(natural.height, Math.ceil(rect.y + rect.height - PIXEL_SNAP));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** `rect` in units of `size` as fractions of it. */
export function toFraction(rect: Rect, size: { width: number; height: number }): Rect {
  return { x: rect.x / size.width, y: rect.y / size.height, width: rect.width / size.width, height: rect.height / size.height };
}

/** A fraction of a source (see `toFraction`) in units of `size`. */
export function fromFraction(fraction: Rect, size: { width: number; height: number }): Rect {
  return { x: fraction.x * size.width, y: fraction.y * size.height, width: fraction.width * size.width, height: fraction.height * size.height };
}
