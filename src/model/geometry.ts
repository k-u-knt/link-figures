import { MM_TO_PX, PAGE_GAP_MM } from "../constants";
import type { Crop, Document, Node, Page, PageId } from "./types";

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point on a page, in that page's own pixels (from its top-left corner): where a node is put. */
export interface PlacePoint {
  page: Page;
  x: number;
  y: number;
}

export function mmToPx(mm: number): number {
  return mm * MM_TO_PX;
}

export function pxToMm(px: number): number {
  return px / MM_TO_PX;
}

export function pageSizePx(page: Page): { width: number; height: number } {
  return { width: mmToPx(page.width), height: mmToPx(page.height) };
}

/** Pages are stacked vertically at x = 0, separated by PAGE_GAP_MM. */
export function pageOriginsPx(doc: Document): Map<PageId, Pt> {
  const origins = new Map<PageId, Pt>();
  let offsetMm = 0;
  for (const page of doc.pages) {
    origins.set(page.id, { x: 0, y: mmToPx(offsetMm) });
    offsetMm += page.height + PAGE_GAP_MM;
  }
  return origins;
}

/** The node's rectangle in world (canvas) coordinates: its page origin plus its page-relative position. */
export function nodeWorldRect(doc: Document, node: Node): Rect {
  const origin = pageOriginsPx(doc).get(node.page) ?? { x: 0, y: 0 };
  return { x: origin.x + node.x, y: origin.y + node.y, width: node.width, height: node.height };
}

/** True when the rectangles overlap with positive area; rectangles that only touch do not intersect. */
export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Edges are inclusive. */
export function rectContainsPt(r: Rect, p: Pt): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Bounding rectangle of all rects; an empty list gives a zero rect at the origin. */
export function unionRect(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Where an image's crop goes in a node's box, all relative to the box (see `cropPlacement`). */
export interface CropPlacement {
  /** The whole image, relative to the box: what `imagePlacement` returns. */
  image: Rect;
  /** The crop region scaled and centred in the box: where the picture is to show. Reaches beyond the box with `cover`. */
  fitted: Rect;
  /** `fitted` cut to the box: what is visible. The box itself while the image has no size. */
  region: Rect;
}

/**
 * Where the crop region (the whole image when `crop` is null) goes in the box, centred and scaled to cover it or be
 * contained in it. `image` is the whole image placed so, `fitted` the crop region alone, and `region` the part of that
 * inside the box: what a consumer clips to, so that with `contain` the image outside the crop does not fill the letterbox.
 */
export function cropPlacement(
  box: { width: number; height: number },
  natural: { width: number; height: number },
  crop: Crop | null,
  fit: "cover" | "contain",
): CropPlacement {
  const cropW = (crop ? crop.w : 1) * natural.width;
  const cropH = (crop ? crop.h : 1) * natural.height;
  // An image that has no size yet (not loaded) cannot be scaled; fill the box instead of producing NaN.
  if (cropW <= 0 || cropH <= 0) {
    const whole = (): Rect => ({ x: 0, y: 0, width: box.width, height: box.height });
    return { image: whole(), fitted: whole(), region: whole() };
  }

  const sx = box.width / cropW;
  const sy = box.height / cropH;
  const scale = fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);

  // Centre the (scaled) crop region in the box, then offset back to the image's own origin.
  const fitted: Rect = { x: (box.width - cropW * scale) / 2, y: (box.height - cropH * scale) / 2, width: cropW * scale, height: cropH * scale };
  const image: Rect = {
    x: fitted.x - (crop ? crop.x : 0) * natural.width * scale,
    y: fitted.y - (crop ? crop.y : 0) * natural.height * scale,
    width: natural.width * scale,
    height: natural.height * scale,
  };
  // `fitted` cut to the box. `cover` scales the crop region up until it reaches past the box on both axes, so the box is what shows;
  // `contain` scales it down until it is inside the box, so all of it shows. Saying so avoids rounding noise from cutting.
  const region: Rect = fit === "cover" ? { x: 0, y: 0, width: box.width, height: box.height } : { ...fitted };
  return { image, fitted, region };
}

/**
 * Rectangle of the full image, relative to the box, such that the crop region
 * (the whole image when `crop` is null) covers or is contained in the box, centred.
 */
export function imagePlacement(
  box: { width: number; height: number },
  natural: { width: number; height: number },
  crop: Crop | null,
  fit: "cover" | "contain",
): Rect {
  return cropPlacement(box, natural, crop, fit).image;
}
