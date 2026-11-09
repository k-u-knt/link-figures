import { MM_TO_PX, PAGE_GAP_MM } from "../constants";
import type { Crop, Document, FileNode, Node, Page, PageId } from "./types";

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
 * What a panel shows now, as a crop of its image: the visible `region` of `cropPlacement` (the box with `cover`, the
 * letterboxed crop with `contain`) taken back into the image's 0–1 frame. It differs from the panel's own crop when its
 * fit leaves part of the crop unseen (cover with the box's aspect not the crop's); crop mode and the inspector's crop
 * fields start an edit from it, so that the box does not take in what was hidden. `natural` is the image's natural size.
 */
export function visibleCrop(
  panel: { width: number; height: number; crop: Crop | null; fit: "cover" | "contain" },
  natural: { width: number; height: number },
): Crop {
  const { image, region } = cropPlacement(panel, natural, panel.crop, panel.fit);
  return {
    x: (region.x - image.x) / image.width,
    y: (region.y - image.y) / image.height,
    w: region.width / image.width,
    h: region.height / image.height,
  };
}

/** The least share of the image's width or height a crop keeps. */
export const MIN_CROP = 0.01;

/**
 * `crop` kept within the image: `x` and `y` within 0 to 1 − `MIN_CROP`, `w` and `h` at least `MIN_CROP` and not past the
 * far edge; each to 1e-6, so that float noise from a drag or an inset (0.30000000000000004) does not reach the file.
 */
export function clampCrop(crop: Crop): Crop {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const x = round(clamp(crop.x, 0, 1 - MIN_CROP));
  const y = round(clamp(crop.y, 0, 1 - MIN_CROP));
  return { x, y, w: round(clamp(crop.w, MIN_CROP, 1 - x)), h: round(clamp(crop.h, MIN_CROP, 1 - y)) };
}

/** The side of a crop that an inspector inset field names. */
export type CropSide = "left" | "top" | "right" | "bottom";

/** How far in from `side` of the image `crop` starts, as a share (0–1) of the image's width or height. */
export function cropInset(crop: Crop | null, side: CropSide): number {
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  if (side === "left") return c.x;
  if (side === "top") return c.y;
  if (side === "right") return 1 - c.x - c.w;
  return 1 - c.y - c.h;
}

/**
 * `crop` with the inset of `side` set to `inset` (a share, 0–1) and the other three sides where they were. The inset is
 * kept from 0 to `MIN_CROP` short of the opposite side, so writing one side never moves another.
 */
export function cropWithInset(crop: Crop | null, side: CropSide, inset: number): Crop {
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), Math.max(hi, 0));
  if (side === "left") {
    const x = clamp(inset, c.x + c.w - MIN_CROP);
    return { ...c, x, w: c.x + c.w - x };
  }
  if (side === "top") {
    const y = clamp(inset, c.y + c.h - MIN_CROP);
    return { ...c, y, h: c.y + c.h - y };
  }
  if (side === "right") return { ...c, w: 1 - c.x - clamp(inset, 1 - c.x - MIN_CROP) };
  return { ...c, h: 1 - c.y - clamp(inset, 1 - c.y - MIN_CROP) };
}

/**
 * The box (and crop) that shows `crop` of `node`'s image (the whole image when null, clamped by `clampCrop` otherwise)
 * with the image where it is on the page now and at the same scale: the box becomes the part of the image's page rect
 * that the crop selects. `natural` is the image's natural size. The node's fit is kept: with the crop's aspect equal to
 * the box's, cover and contain show the same. A rotated node keeps its image too: the box is worked out in the node's
 * unrotated frame, and its centre is turned about the old centre by the rotation.
 */
export function cropKeepingImage(
  node: FileNode,
  natural: { width: number; height: number },
  crop: Crop | null,
): { x: number; y: number; width: number; height: number; crop: Crop | null } {
  const next = crop ? clampCrop(crop) : null;
  const { image } = cropPlacement(node, natural, node.crop, node.fit);
  const c = next ?? { x: 0, y: 0, w: 1, h: 1 };
  const width = c.w * image.width;
  const height = c.h * image.height;
  // The new box's centre, unrotated, relative to the old box's centre; then turned by the node's rotation.
  const dx = image.x + c.x * image.width + width / 2 - node.width / 2;
  const dy = image.y + c.y * image.height + height / 2 - node.height / 2;
  const a = (node.rotation * Math.PI) / 180;
  const cx = node.x + node.width / 2 + dx * Math.cos(a) - dy * Math.sin(a);
  const cy = node.y + node.height / 2 + dx * Math.sin(a) + dy * Math.cos(a);
  // To hundredths of a pixel, as `roundPx` (view/pointer-math, which imports this module) rounds a drag.
  const round = (v: number) => Math.round(v * 100) / 100;
  return { x: round(cx - width / 2), y: round(cy - height / 2), width: round(width), height: round(height), crop: next };
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
