import { PT_TO_PX } from "../constants";
import { attachTarget, type AttachTarget } from "../model/attach";
import { unionRect, type Pt, type Rect } from "../model/geometry";
import { clipToOutline, pathBounds, pointAtEnd, transformPath, type PathData, type Seg } from "../model/path";
import type { ConnectorNode, Document, End } from "../model/types";
import type { Registries } from "../registry";
import { DEFAULT_CAP_SIZE } from "../registry/cap";
import { maxLead, type EndPoint } from "../registry/route";

/** A connector worked out for drawing, all in page px. */
export interface ResolvedConnector {
  /** Where the line starts and ends (before caps shorten it), with the anchor normal of an end attached to an anchor. */
  ends: [EndPoint, EndPoint];
  /** The line, shortened at each end by its cap's inset. */
  path: PathData;
  /** Each end's cap as a closed area filled with the stroke's paint, or null when the end has none. */
  caps: [PathData | null, PathData | null];
  /**
   * The area drawn: the line and the caps, widened by half the stroke's width (at least 0.5 px), and further where a
   * square line cap or a mitred join reaches out.
   */
  bounds: Rect;
  /**
   * The box the stroke's paint (a gradient, a pattern) is laid out in, for the line and its caps alike: the bounds of the
   * whole route, end to end, each dimension at least the stroke's width (and 1 px) so a straight horizontal or vertical line still
   * has a box to lay a paint across.
   */
  paintBox: Rect;
  /** Which ends are attached to an item that is missing, on another page, or not attachable. */
  detached: [boolean, boolean];
}

/** An end as far as its item says: its point, and its target outline when it is snapped to the centre and must be clipped. */
type Placed = { pt: Pt; dir: Pt | null; clipTo: AttachTarget | null } | null;

/**
 * Where an end is before clipping, or null when it is attached to something it cannot attach to: a missing item, one on
 * another page, or one whose type is not attachable. An anchor id the item does not have (its kind changed) snaps to
 * the item's centre, so the end stays attached.
 */
function place(doc: Document, c: ConnectorNode, end: End, registries: Registries): Placed {
  if (end.kind === "free") return { pt: { x: end.x, y: end.y }, dir: null, clipTo: null };
  const node = doc.nodes.find((n) => n.id === end.node);
  if (!node || node.page !== c.page) return null;
  const target = attachTarget(doc, registries, end.node);
  if (!target) return null;
  if (end.snap === "anchor") {
    const anchor = target.anchors.find((a) => a.id === end.anchor);
    if (anchor) return { pt: { x: anchor.x, y: anchor.y }, dir: anchor.dir, clipTo: null };
  }
  return { pt: target.center, dir: null, clipTo: target };
}

/** The route's path with its zero-length pieces dropped (they would hide where caps trim); at least one piece is kept. */
function withoutEmptyPieces(p: PathData): PathData {
  const start = p[0];
  if (!start || start.op !== "M") return p;
  const out: Seg[] = [start];
  let at: Pt = start;
  for (const s of p.slice(1)) {
    if (s.op === "Z") {
      out.push(s);
      continue;
    }
    const same = (x: number, y: number): boolean => x === at.x && y === at.y;
    const empty = s.op === "C" ? same(s.x, s.y) && same(s.x1, s.y1) && same(s.x2, s.y2) : s.op === "L" && same(s.x, s.y);
    if (empty) continue;
    out.push(s);
    at = s;
  }
  return out.length === 1 ? [start, { op: "L", x: start.x, y: start.y }] : out;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** A drawn piece of an open path: the segment and the point it starts from. */
type Piece = { from: Pt; seg: Exclude<Seg, { op: "Z" }> };

/** The pieces of a single open subpath `M …`, or null for any other path (which is drawn untrimmed). */
function piecesOf(p: PathData): Piece[] | null {
  if (p.length < 2 || p[0].op !== "M" || p.slice(1).some((s) => s.op === "Z" || s.op === "M")) return null;
  const pieces: Piece[] = [];
  let at: Pt = p[0];
  for (const seg of p.slice(1) as Piece["seg"][]) {
    pieces.push({ from: at, seg });
    at = seg;
  }
  return pieces;
}

function pointOn({ from, seg }: Piece, t: number): Pt {
  if (seg.op !== "C") return lerp(from, seg, t);
  const u = 1 - t;
  return {
    x: u * u * u * from.x + 3 * u * u * t * seg.x1 + 3 * u * t * t * seg.x2 + t * t * t * seg.x,
    y: u * u * u * from.y + 3 * u * u * t * seg.y1 + 3 * u * t * t * seg.y2 + t * t * t * seg.y,
  };
}

/** The piece cut at `t` into the part before and the part after. */
function splitPiece(pc: Piece, t: number): [Piece, Piece] {
  const { from, seg } = pc;
  const mid = pointOn(pc, t);
  if (seg.op !== "C") return [{ from, seg: { op: "L", x: mid.x, y: mid.y } }, { from: mid, seg: { op: "L", x: seg.x, y: seg.y } }];
  // De Casteljau's construction.
  const c1: Pt = { x: seg.x1, y: seg.y1 };
  const c2: Pt = { x: seg.x2, y: seg.y2 };
  const p01 = lerp(from, c1, t);
  const p12 = lerp(c1, c2, t);
  const p23 = lerp(c2, seg, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  return [
    { from, seg: { op: "C", x1: p01.x, y1: p01.y, x2: p012.x, y2: p012.y, x: mid.x, y: mid.y } },
    { from: mid, seg: { op: "C", x1: p123.x, y1: p123.y, x2: p23.x, y2: p23.y, x: seg.x, y: seg.y } },
  ];
}

/** Where along the line from `a` to `b` (each t in 0–1) its distance from `c` is exactly `r`: the roots of a quadratic. */
function lineCircleCrossings(a: Pt, b: Pt, c: Pt, r: number): number[] {
  const d = { x: b.x - a.x, y: b.y - a.y };
  const f = { x: a.x - c.x, y: a.y - c.y };
  const A = d.x * d.x + d.y * d.y;
  if (A === 0) return [];
  const B = 2 * (f.x * d.x + f.y * d.y);
  const C = f.x * f.x + f.y * f.y - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-B - root) / (2 * A), (-B + root) / (2 * A)].filter((t) => t >= 0 && t <= 1);
}

/** How far a cubic's control points may lie off its chord for the piece to be taken as that chord. */
const FLAT_PX = 1e-3;

/** The deepest a cubic is split looking for crossings; at this depth a piece is a 2^-20 of the curve and is taken as flat. */
const MAX_SPLIT_DEPTH = 20;

/**
 * Where along the piece (each t in 0–1) its distance from `c` is exactly `r`, in order. Exact for a line. A cubic is
 * split adaptively: it lies inside the convex hull of its control points, so a part whose points' box is wholly
 * outside the circle, or whose points are all inside it, never crosses and is dropped, and any other part is split
 * until it is flat and then taken as its chord. So a quick pass through the circle between two far-apart samples is
 * never missed. Each crossing found is then sharpened by bisection on the true distance where its part brackets it.
 */
function circleCrossings(pc: Piece, c: Pt, r: number): number[] {
  const { from, seg } = pc;
  if (seg.op !== "C") return lineCircleCrossings(from, seg, c, r);
  const gap = (t: number): number => {
    const p = pointOn(pc, t);
    return Math.hypot(p.x - c.x, p.y - c.y) - r;
  };
  const found: number[] = [];
  const visit = (part: Piece, t0: number, t1: number, depth: number): void => {
    if (part.seg.op !== "C") return;
    const p0 = part.from;
    const p3: Pt = part.seg;
    const pts: Pt[] = [p0, { x: part.seg.x1, y: part.seg.y1 }, { x: part.seg.x2, y: part.seg.y2 }, p3];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const dx = Math.max(Math.min(...xs) - c.x, 0, c.x - Math.max(...xs));
    const dy = Math.max(Math.min(...ys) - c.y, 0, c.y - Math.max(...ys));
    if (Math.hypot(dx, dy) > r) return;
    if (pts.every((p) => Math.hypot(p.x - c.x, p.y - c.y) <= r)) return;
    const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const off = (p: Pt): number =>
      chord > 0 ? Math.abs((p3.x - p0.x) * (p.y - p0.y) - (p3.y - p0.y) * (p.x - p0.x)) / chord : Math.hypot(p.x - p0.x, p.y - p0.y);
    if (depth >= MAX_SPLIT_DEPTH || (off(pts[1]) <= FLAT_PX && off(pts[2]) <= FLAT_PX)) {
      const g0 = gap(t0);
      const g1 = gap(t1);
      for (const s of lineCircleCrossings(p0, p3, c, r)) {
        let t = t0 + (t1 - t0) * s;
        if (g0 !== 0 && g1 !== 0 && Math.sign(g0) !== Math.sign(g1)) {
          let lo = t0;
          let hi = t1;
          for (let k = 0; k < 40; k++) {
            const mid = (lo + hi) / 2;
            if (Math.sign(gap(mid)) === Math.sign(g0)) lo = mid;
            else hi = mid;
          }
          t = (lo + hi) / 2;
        }
        found.push(t);
      }
      return;
    }
    const [left, right] = splitPiece(part, 0.5);
    const tm = (t0 + t1) / 2;
    visit(left, t0, tm, depth + 1);
    visit(right, tm, t1, depth + 1);
  };
  visit(pc, 0, 1, 0);
  found.sort((a, b) => a - b);
  // A crossing at a split point is found once from each side.
  return found.filter((t, i) => i === 0 || t - found[i - 1] > 1e-9);
}

/** Every place along the path, as piece index + t, where it is exactly `r` from `c`, in path order. */
function pathCrossings(pieces: Piece[], c: Pt, r: number): number[] {
  return pieces.flatMap((pc, i) => circleCrossings(pc, c, r).map((t) => i + t));
}

/** The pieces between the places `g0` and `g1` (piece index + t, g0 ≤ g1) as a path. */
function subPath(pieces: Piece[], g0: number, g1: number): PathData {
  const n = pieces.length;
  const at = (g: number): [number, number] => {
    const i = Math.min(Math.max(Math.floor(g), 0), n - 1);
    return [i, Math.min(Math.max(g - i, 0), 1)];
  };
  const [i0, t0] = at(g0);
  const [i1, t1] = at(g1);
  let kept: Piece[];
  if (i0 === i1) {
    const before = splitPiece(pieces[i0], t1)[0];
    kept = [splitPiece(before, t1 > 0 ? t0 / t1 : 0)[1]];
  } else kept = [splitPiece(pieces[i0], t0)[1], ...pieces.slice(i0 + 1, i1), splitPiece(pieces[i1], t1)[0]];
  return [{ op: "M", x: kept[0].from.x, y: kept[0].from.y }, ...kept.map((pc) => pc.seg)];
}

/**
 * The open path cut short for its caps, by straight-line distance: the end is cut at the place nearest the start where
 * the path is exactly `endBy` px from its end point (walking back from the end, the last such place), and the start
 * likewise at the place nearest the end that is `startBy` px from its start point. So what is left of the line stays
 * outside a circle of the inset round each tip, whatever the route's shape, and where it stops is on the line from the
 * tip that the cap is turned along. A path that never leaves the circle is cut away entirely; when the two cuts cross,
 * the line shrinks to the point midway between them. A path that is not a single open subpath is left as it is.
 */
function trimPath(p: PathData, startBy: number, endBy: number): PathData {
  const pieces = piecesOf(p);
  if (!pieces) return p;
  const n = pieces.length;
  const first: Pt = pieces[0].from;
  const last: Pt = pieces[n - 1].seg;
  const away = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
  let g1 = n;
  if (endBy > 0) {
    const cs = pathCrossings(pieces, last, endBy);
    g1 = cs.length > 0 ? Math.min(...cs) : away(first, last) < endBy ? 0 : n;
  }
  let g0 = 0;
  if (startBy > 0) {
    const cs = pathCrossings(pieces, first, startBy);
    g0 = cs.length > 0 ? Math.max(...cs) : away(last, first) < startBy ? n : 0;
  }
  if (g0 > g1) g0 = g1 = (g0 + g1) / 2;
  return subPath(pieces, g0, g1);
}

/** A non-negative finite number, else `fallback`. */
function size(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** `r` grown by `by` on every side. */
function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** How much further than `lead` past its inset an attached end runs straight, so its trimmed line stops clear of the turn. */
const LEAD_MARGIN_PX = 1;

/** The least half-width the drawn area and paint box are widened by, so neither has a zero dimension even for a hairline. */
const MIN_HALF_WIDTH_PX = 0.5;

/** SVG's default miter limit: a join longer than this many line widths is drawn bevelled instead. */
const MITER_LIMIT = 4;

/**
 * How far, as a multiple of half the line's width, the line's outline reaches out from its centre line at the path's
 * corners when joins are mitred: 1/sin(θ/2) for the sharpest corner of angle θ whose miter is within the limit (a
 * sharper one is bevelled and reaches no further than 1).
 */
function miterReach(p: PathData): number {
  let worst = 1;
  for (let i = 2; i < p.length; i++) {
    const [from, before, after] = [p[i - 2], p[i - 1], p[i]];
    // A corner joins two drawn pieces: `before` ends where `after` starts.
    if (from.op === "Z" || before.op === "Z" || before.op === "M" || after.op === "Z" || after.op === "M") continue;
    const into = pointAtEnd([{ op: "M", x: from.x, y: from.y }, before], 1).tangent;
    const back = pointAtEnd([{ op: "M", x: before.x, y: before.y }, after], 0).tangent;
    // The corner's two rays are −into (back along the first piece) and −back (on along the second): cos θ = into · back.
    const cos = into.x * back.x + into.y * back.y;
    const ratio = Math.sqrt(2 / Math.max(1e-12, 1 - cos));
    if (ratio <= MITER_LIMIT) worst = Math.max(worst, ratio);
  }
  return worst;
}

/** `r` with each dimension at least `min`, grown about its centre. */
function atLeast(r: Rect, min: number): Rect {
  const w = Math.max(r.width, min);
  const h = Math.max(r.height, min);
  return { x: r.x - (w - r.width) / 2, y: r.y - (h - r.height) / 2, width: w, height: h };
}

/**
 * The connector `c` of `doc` as it is drawn: each end resolved, routed by its registered route, capped by its registered
 * cap kinds and shortened by their insets.
 *
 * - A free end is its stored point. An end attached to an anchor is the anchor's point, with its outward normal as the
 *   end's `dir`. An end snapped to an item's centre is clipped at the item's outline (rotation applied) toward the other
 *   end, so the line, and its cap, meet the edge.
 * - An attached end whose item is missing, on another page, or not attachable is flagged in `detached`. An attached end
 *   stores no point of its own, so it resolves, as a free end would, at the other end's point, or at the centre of the
 *   connector's current box when both ends are detached. The store's normaliser turns such an end into a free end at
 *   its last resolved point within the same commit; this fallback only keeps the geometry finite until it does.
 * - A route that is not registered draws a straight line; a cap kind that is not registered draws nothing.
 * - Each cap's tip is on its end. The line is cut where it is the cap's inset away from the tip in a straight line, and
 *   the cap is turned along the line from that stop to the tip, so the line always ends on the cap's axis and nothing of
 *   it lies within the inset of the tip, whatever the route. An end attached to an anchor also asks the route for a
 *   straight `lead` of the inset plus a pixel (never more than half the way to an end that genuinely lies ahead, see `maxLead`), so in
 *   the usual case the remaining line is straight there and the cap sits square on the anchor.
 *
 * Every number is finite for any ends, including both ends on one item or at one point.
 */
export function resolveConnector(doc: Document, c: ConnectorNode, registries: Registries): ResolvedConnector {
  const placed: [Placed, Placed] = [place(doc, c, c.ends[0], registries), place(doc, c, c.ends[1], registries)];
  const widthPx = size(c.stroke.width, 0) * PT_TO_PX;
  const capped = [0, 1].map((i) => {
    const kind = registries.caps.get(c.caps[i].kind);
    if (!kind) return { shape: [] as PathData, inset: 0 };
    const capSize = size(c.caps[i].size, DEFAULT_CAP_SIZE);
    return { shape: kind.path(capSize, widthPx), inset: size(kind.inset(capSize, widthPx), 0) };
  });
  const boxCenter: Pt = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  const unclipped = (i: 0 | 1): Pt => placed[i]?.pt ?? placed[1 - i]?.pt ?? boxCenter;
  const resolve = (i: 0 | 1): EndPoint => {
    const p = placed[i];
    if (!p) return { pt: unclipped(i), dir: null, lead: 0 };
    const pt = p.clipTo ? (clipToOutline(p.pt, unclipped(i === 0 ? 1 : 0), p.clipTo.outline) ?? p.pt) : p.pt;
    return { pt, dir: p.dir, lead: 0 };
  };
  const ends: [EndPoint, EndPoint] = [resolve(0), resolve(1)];
  for (const i of [0, 1] as const) {
    const inset = capped[i].inset;
    if (ends[i].dir && inset > 0) ends[i].lead = Math.min(inset + LEAD_MARGIN_PX, maxLead(ends[i], ends[i === 0 ? 1 : 0]));
  }

  const route = registries.routes.get(c.route);
  const routed: PathData = route
    ? route.path(ends[0], ends[1], c.routeParams)
    : [
        { op: "M", x: ends[0].pt.x, y: ends[0].pt.y },
        { op: "L", x: ends[1].pt.x, y: ends[1].pt.y },
      ];
  const full = withoutEmptyPieces(routed);
  const path = trimPath(full, capped[0].inset, capped[1].inset);

  const capAt = (i: 0 | 1): PathData | null => {
    const { shape } = capped[i];
    if (shape.length === 0) return null;
    const tip = pointAtEnd(full, i);
    // Turned along the line from where the trimmed line stops to the tip, so the stop is on the cap's axis.
    const stop = pointAtEnd(path, i).pt;
    const len = Math.hypot(tip.pt.x - stop.x, tip.pt.y - stop.y);
    const t = len > 1e-9 ? { x: (tip.pt.x - stop.x) / len, y: (tip.pt.y - stop.y) / len } : tip.tangent;
    // The cap points along +x from the origin; turn +x onto its axis and move the origin to the tip.
    return transformPath(shape, [t.x, t.y, -t.y, t.x, tip.pt.x, tip.pt.y]);
  };
  const caps: [PathData | null, PathData | null] = [capAt(0), capAt(1)];

  // The drawn area: the line and caps, widened by half the line's width, further where a square line cap's corner or a
  // mitred join reaches out (SVG mitres joins when the stroke does not say otherwise).
  const half = Math.max(widthPx / 2, MIN_HALF_WIDTH_PX);
  const mitred = (c.stroke.join ?? "miter") === "miter";
  const reach = half * Math.max(c.stroke.cap === "square" ? Math.SQRT2 : 1, mitred ? miterReach(path) : 1);
  const bounds = grow(unionRect([pathBounds(path), ...caps.filter((p): p is PathData => p !== null).map(pathBounds)]), reach);
  const paintBox = atLeast(pathBounds(full), 2 * half);
  return { ends, path, caps, bounds, paintBox, detached: [placed[0] === null, placed[1] === null] };
}
