import type { Registries } from "../registry";
import type { SnapLine, SnapSource } from "../registry/snap";
import { visualBounds } from "./arrange";
import { mmToPx, pageSizePx, type Rect } from "./geometry";
import { MIN_NODE_PX } from "../constants";
import type { ConnectorNode, Document, NodeId, Page } from "./types";
import { ancestorsOf, childrenOf, descendantsOf, unitsOf } from "./groups";

/** The view option (see `FigureViewLike.viewOption`) that turns snapping off when `false`; any other value, unset included, is on. */
export const SNAP_OPTION = "snap";

/** How near, in screen px, a dragged edge or centre has to come to a line to snap to it; divided by the zoom for page px. */
export const SNAP_REACH_SCREEN_PX = 6;

/** Whether the value of the view option `SNAP_OPTION` turns snapping on: anything but `false`. */
export function snapOn(value: unknown): boolean {
  return value !== false;
}

/** The lines a move or resize snaps to, by axis: `x` are vertical lines, `y` horizontal ones. */
export type SnapLines = { x: SnapLine[]; y: SnapLine[] };

/** Each unit on the page (outermost, so a group is one item) but the `exclude`d and their descendants. */
const items: SnapSource = {
  id: "items",
  lines(doc, page, exclude, registries) {
    const skip = new Set<string>(exclude);
    for (const id of exclude) for (const d of descendantsOf(doc, id)) skip.add(d);
    const onPage = doc.nodes.filter((n) => n.page === page.id).map((n) => n.id);
    // An ancestor of an excluded node has the moving node inside its bounds, so it is walked into, not offered.
    const ancestors = new Set<string>();
    for (const id of exclude) for (const a of ancestorsOf(doc, id)) ancestors.add(a);
    const out: SnapLines = { x: [], y: [] };
    const offer = (id: NodeId) => {
      if (skip.has(id)) return;
      if (ancestors.has(id)) {
        for (const child of childrenOf(doc, id)) offer(child);
        return;
      }
      const node = doc.nodes.find((n) => n.id === id);
      // A connector attached to a moving item is re-resolved as the item moves.
      if (node?.type === "connector" && (node as ConnectorNode).ends.some((e) => e.kind === "attached" && skip.has(e.node))) return;
      const b = visualBounds(doc, id, registries);
      for (const pos of [b.x, b.x + b.width / 2, b.x + b.width]) out.x.push({ pos, from: b.y, to: b.y + b.height, kind: "item", source: id });
      for (const pos of [b.y, b.y + b.height / 2, b.y + b.height]) out.y.push({ pos, from: b.x, to: b.x + b.width, kind: "item", source: id });
    };
    for (const id of unitsOf(doc, onPage, null)) offer(id);
    return out;
  },
};

const page: SnapSource = {
  id: "page",
  lines(_doc, p) {
    const { width, height } = pageSizePx(p);
    const line = (pos: number, from: number, to: number): SnapLine => ({ pos, from, to, kind: "page", source: "page" });
    return {
      x: [0, width / 2, width].map((pos) => line(pos, 0, height)),
      y: [0, height / 2, height].map((pos) => line(pos, 0, width)),
    };
  },
};

const margins: SnapSource = {
  id: "margins",
  lines(_doc, p) {
    const { width, height } = pageSizePx(p);
    const left = mmToPx(p.margins.left);
    const right = width - mmToPx(p.margins.right);
    const top = mmToPx(p.margins.top);
    const bottom = height - mmToPx(p.margins.bottom);
    const line = (pos: number, from: number, to: number): SnapLine => ({ pos, from, to, kind: "margin", source: "margins" });
    return {
      x: [line(left, top, bottom), line(right, top, bottom)],
      y: [line(top, left, right), line(bottom, left, right)],
    };
  },
};

export const builtinSnapSources: SnapSource[] = [items, page, margins];

/** Every source's lines on `pg`, joined; ties between them are settled by each line's `kind`, not by order. */
export function collectSnapLines(sources: readonly SnapSource[], doc: Document, pg: Page, exclude: Set<NodeId>, registries: Registries): SnapLines {
  const out: SnapLines = { x: [], y: [] };
  for (const s of sources) {
    const l = s.lines(doc, pg, exclude, registries);
    out.x.push(...l.x);
    out.y.push(...l.y);
  }
  return out;
}

/**
 * The line to snap one axis to: nearest to any of `features` within `reach`; a tie goes to a page or margin line over an
 * item line, then to the one found first. Gives the shift to add and every line at the winning position (the guides).
 */
function snapAxis(lines: readonly SnapLine[], features: readonly number[], reach: number): { d: number; guides: SnapLine[] } {
  let best: { d: number; dist: number; rank: number; pos: number } | null = null;
  for (const feature of features) {
    for (const l of lines) {
      const dist = Math.abs(l.pos - feature);
      if (dist > reach) continue;
      const rank = l.kind === "item" ? 1 : 0;
      if (!best || dist < best.dist || (dist === best.dist && rank < best.rank)) best = { d: l.pos - feature, dist, rank, pos: l.pos };
    }
  }
  if (!best) return { d: 0, guides: [] };
  const pos = best.pos;
  return { d: best.d, guides: lines.filter((l) => l.pos === pos) };
}

/** Snaps a moving rect's left, centre and right (x) and top, middle and bottom (y), each axis on its own. */
export function snapMove(lines: SnapLines, moving: Rect, reach: number): { dx: number; dy: number; guides: SnapLine[] } {
  const x = snapAxis(lines.x, [moving.x, moving.x + moving.width / 2, moving.x + moving.width], reach);
  const y = snapAxis(lines.y, [moving.y, moving.y + moving.height / 2, moving.y + moving.height], reach);
  return { dx: x.d, dy: y.d, guides: [...x.guides, ...y.guides] };
}

/** Snaps only the edges being dragged; the rect's other edges stay where they are. */
export function snapEdges(lines: SnapLines, rect: Rect, edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }, reach: number): { rect: Rect; guides: SnapLine[] } {
  let { x, y, width, height } = rect;
  const guides: SnapLine[] = [];
  // A snap that would shrink the rect below the minimum size is refused: that edge stays where it was.
  const ok = (size: number, d: number, grows: 1 | -1) => size + grows * d >= MIN_NODE_PX;
  if (edges.left) {
    const s = snapAxis(lines.x, [rect.x], reach);
    if (ok(width, s.d, -1)) {
      guides.push(...s.guides);
      x += s.d;
      width -= s.d;
    }
  }
  if (edges.right) {
    const s = snapAxis(lines.x, [rect.x + rect.width], reach);
    if (ok(width, s.d, 1)) {
      guides.push(...s.guides);
      width += s.d;
    }
  }
  if (edges.top) {
    const s = snapAxis(lines.y, [rect.y], reach);
    if (ok(height, s.d, -1)) {
      guides.push(...s.guides);
      y += s.d;
      height -= s.d;
    }
  }
  if (edges.bottom) {
    const s = snapAxis(lines.y, [rect.y + rect.height], reach);
    if (ok(height, s.d, 1)) {
      guides.push(...s.guides);
      height += s.d;
    }
  }
  return { rect: { x, y, width, height }, guides };
}
