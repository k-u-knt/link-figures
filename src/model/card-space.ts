import { mmToPx, pageOriginsPx, pageSizePx, type Rect } from "./geometry";
import type { Document } from "./types";

/**
 * Where an item kept off the paper (a card, see `NodeType.offPaper`) may be: at least this far outside every page's paper
 * rectangle, in mm.
 */
export const CARD_PAPER_GAP_MM = 4;

/** The most rounds `pushOffPaper` takes: each round clears the papers it hits, and may land on another. */
const MAX_ROUNDS = 8;

/** A move this small (px) is no move: what floating-point sums leave over. */
const EPS = 1e-9;

/** Each page's paper as a world px rectangle (pages are stacked, see `pageOriginsPx`), inflated by `CARD_PAPER_GAP_MM` all round. */
export function paperRectsWorld(doc: Document): Rect[] {
  const origins = pageOriginsPx(doc);
  const gap = mmToPx(CARD_PAPER_GAP_MM);
  return doc.pages.flatMap((page) => {
    const at = origins.get(page.id);
    if (!at) return [];
    const size = pageSizePx(page);
    return [{ x: at.x - gap, y: at.y - gap, width: size.width + 2 * gap, height: size.height + 2 * gap }];
  });
}

/** Whether `a` and `b` overlap by more than `EPS`; touching edges do not. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width - EPS && a.x + a.width > b.x + EPS && a.y < b.y + b.height - EPS && a.y + a.height > b.y + EPS;
}

const hits = (rect: Rect, papers: readonly Rect[]): Rect[] => papers.filter((p) => overlaps(rect, p));

/** `rect` moved just outside each of the four sides of `paper`. */
function sidesOf(rect: Rect, paper: Rect): Rect[] {
  return [
    { ...rect, x: paper.x - rect.width },
    { ...rect, x: paper.x + paper.width },
    { ...rect, y: paper.y - rect.height },
    { ...rect, y: paper.y + paper.height },
  ];
}

const distance = (a: Rect, b: Rect): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * `rect` (world px) moved by the smallest move that clears every one of `papers` (see `paperRectsWorld`); `rect` itself
 * when it is clear. Each round tries `rect` just outside each of the four sides of every paper it hits: the nearest
 * candidate (to where `rect` started) that is clear of all papers wins; when none is, the nearest candidate is taken
 * and the next round starts from it. After `MAX_ROUNDS` rounds the last candidate is given back.
 */
export function pushOffPaper(rect: Rect, papers: readonly Rect[]): Rect {
  let at = rect;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const hit = hits(at, papers);
    if (hit.length === 0) return at;
    const candidates = hit.flatMap((paper) => sidesOf(at, paper));
    const clear = candidates.filter((c) => hits(c, papers).length === 0);
    const pool = clear.length > 0 ? clear : candidates;
    at = pool.reduce((best, c) => (distance(c, rect) < distance(best, rect) ? c : best));
    if (clear.length > 0) return at;
  }
  return at;
}

/**
 * Moves `rect` along one axis from `from` to `to` (that axis's position), stopping at the first paper in the way: the
 * position on that axis it ends at. A paper it already overlaps at `from` does not stop it.
 */
function slideAxis(rect: Rect, axis: "x" | "y", to: number, papers: readonly Rect[]): number {
  const size = axis === "x" ? "width" : "height";
  const from = rect[axis];
  const d = to - from;
  if (d === 0) return to;
  // The area the rect sweeps on its way, so a fast move cannot pass through a paper.
  const swept: Rect = { ...rect, [axis]: Math.min(from, to), [size]: rect[size] + Math.abs(d) };
  let end = to;
  for (const paper of hits(swept, papers)) {
    if (overlaps(rect, paper)) continue;
    end = d > 0 ? Math.min(end, paper[axis] - rect[size]) : Math.max(end, paper[axis] + paper[size]);
  }
  // Never back past where it started.
  return d > 0 ? Math.max(from, end) : Math.min(from, end);
}

/**
 * Where a drag of `from` (world px, clear of `papers`) to `to` ends: the motion across a paper's edge stops at the edge,
 * and the motion along it is kept, so the rect slides along the paper. Each axis is moved in turn (x, then y), and a
 * paper in the way stops it however far the drag goes, so a fast drag never passes through a page to its far side. A result
 * that still overlaps a paper (`from` was not clear) is pushed off (`pushOffPaper`).
 */
export function slideAlongPaper(from: Rect, to: Rect, papers: readonly Rect[]): Rect {
  const sized: Rect = { ...from, width: to.width, height: to.height };
  const x = slideAxis(sized, "x", to.x, papers);
  const y = slideAxis({ ...sized, x }, "y", to.y, papers);
  const out = { ...to, x, y };
  return hits(out, papers).length === 0 ? out : pushOffPaper(out, papers);
}
