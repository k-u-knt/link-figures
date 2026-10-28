import { rectContainsPt, rectIntersects, type Pt, type Rect } from "../model/geometry";
import type { NodeId } from "../model/types";

/** The eight resize handles, named for the edges they move: a corner moves two edges, an edge handle one. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Corners first, so a rectangle too small to tell a corner from an edge by position gives the corner. */
export const HANDLES: Handle[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];

export interface ResizeOptions {
  /** Scale about the opposite corner (or edge) instead of moving the edges independently. */
  keepAspect: boolean;
  /** The least width and height a rectangle may be dragged down to. */
  min: number;
}

/**
 * `start` after dragging `handle` by (`dx`, `dy`). The edges the handle does not move stay where they are; a
 * rectangle never inverts, and the dragged axes never end up below `min`: dragging past the opposite edge pins it.
 *
 * With `keepAspect` a corner handle follows the width (the vertical part of the drag is ignored) and an edge handle
 * follows its own axis, the other axis scaling about the middle of the rectangle. A rectangle with no width or no
 * height has no aspect to keep, and is resized freely.
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, opts: ResizeOptions): Rect {
  const { min } = opts;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const right = start.x + start.width;
  const bottom = start.y + start.height;

  if (opts.keepAspect && start.width > 0 && start.height > 0) {
    let width: number;
    let height: number;
    if (handle.length === 2 || west || east) {
      // Large enough that neither side falls under `min`, whichever is the shorter.
      const floor = Math.max(min, (min * start.width) / start.height);
      width = Math.max(east ? start.width + dx : start.width - dx, floor);
      height = (width * start.height) / start.width;
    } else {
      const floor = Math.max(min, (min * start.height) / start.width);
      height = Math.max(south ? start.height + dy : start.height - dy, floor);
      width = (height * start.width) / start.height;
    }
    return {
      x: west ? right - width : east ? start.x : start.x + (start.width - width) / 2,
      y: north ? bottom - height : south ? start.y : start.y + (start.height - height) / 2,
      width,
      height,
    };
  }

  let { x, y, width, height } = start;
  if (east) width = Math.max(start.width + dx, min);
  if (west) {
    width = Math.max(start.width - dx, min);
    x = right - width;
  }
  if (south) height = Math.max(start.height + dy, min);
  if (north) {
    height = Math.max(start.height - dy, min);
    y = bottom - height;
  }
  return { x, y, width, height };
}

/** The rectangle between two corners, whichever way the drag went. */
export function rectFromPoints(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** The ids of the unlocked items that overlap `marquee` (touching does not count), in the order given. */
export function marqueeSelect(items: { id: NodeId; rect: Rect; locked: boolean }[], marquee: Rect): NodeId[] {
  return items.filter((item) => !item.locked && rectIntersects(item.rect, marquee)).map((item) => item.id);
}

/**
 * The item under `p` that is drawn on top: the highest `layer` (the position of its page, later pages being drawn over
 * earlier ones; 0 when not given), then the highest `z`, then the later item. Locked items count, so that they can be
 * selected and unlocked (what may then be done to them is for the callers to refuse).
 */
export function hitTest(
  items: { id: NodeId; rect: Rect; z: number; locked: boolean; layer?: number }[],
  p: Pt,
): NodeId | null {
  let top: { id: NodeId; z: number; layer: number } | null = null;
  for (const item of items) {
    if (!rectContainsPt(item.rect, p)) continue;
    const layer = item.layer ?? 0;
    if (!top || layer > top.layer || (layer === top.layer && item.z >= top.z)) top = { id: item.id, z: item.z, layer };
  }
  return top ? top.id : null;
}

/** Where a handle sits on `rect`. */
function handlePoint(rect: Rect, handle: Handle): Pt {
  const x = handle.includes("w") ? rect.x : handle.includes("e") ? rect.x + rect.width : rect.x + rect.width / 2;
  const y = handle.includes("n") ? rect.y : handle.includes("s") ? rect.y + rect.height : rect.y + rect.height / 2;
  return { x, y };
}

/** The handle of `rect` within `tolerance` of `p` on both axes, the nearest if several; null when none is. */
export function handleAt(rect: Rect, p: Pt, tolerance: number): Handle | null {
  let best: Handle | null = null;
  let bestDistance = Infinity;
  for (const handle of HANDLES) {
    const at = handlePoint(rect, handle);
    const dx = Math.abs(p.x - at.x);
    const dy = Math.abs(p.y - at.y);
    if (dx > tolerance || dy > tolerance) continue;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  }
  return best;
}

/** To hundredths of a pixel, so positions written to the file by a drag do not trail digits. */
export function roundPx(v: number): number {
  return Math.round(v * 100) / 100;
}
