import { PT_TO_PX } from "../constants";
import { attachTarget, type AttachTarget } from "../model/attach";
import { unionRect, type Pt, type Rect } from "../model/geometry";
import { clipToOutline, pathBounds, pointAtEnd, transformPath, type PathData, type Seg } from "../model/path";
import type { ConnectorNode, Document, End } from "../model/types";
import type { Registries } from "../registry";
import { DEFAULT_CAP_SIZE } from "../registry/cap";
import type { EndPoint } from "../registry/route";

/** A connector worked out for drawing, all in page px. */
export interface ResolvedConnector {
  /** Where the line starts and ends (before caps shorten it), with the anchor normal of an end attached to an anchor. */
  ends: [EndPoint, EndPoint];
  /** The line, shortened at each end by its cap's inset. */
  path: PathData;
  /** Each end's cap as a closed area filled with the stroke's paint, or null when the end has none. */
  caps: [PathData | null, PathData | null];
  /** The area drawn: the line and the caps, widened by half the stroke's width (more where its line cap is square). */
  bounds: Rect;
  /**
   * The box the stroke's paint (a gradient, a pattern) is laid out in, for the line and its caps alike: the bounds of the
   * whole route, end to end, each dimension at least the stroke's width so a straight horizontal or vertical line still
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

/** A cubic's length from its start to `t`, at each of `n + 1` even steps of t (a polyline estimate, fine for trimming caps). */
function cubicLengths(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): number[] {
  const at = (t: number): Pt => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  };
  const out = [0];
  let prev = p0;
  for (let i = 1; i <= n; i++) {
    const pt = at(i / n);
    out.push(out[i - 1] + Math.hypot(pt.x - prev.x, pt.y - prev.y));
    prev = pt;
  }
  return out;
}

/** The parameter t at which `lengths` (from `cubicLengths`) reaches `d`, by linear interpolation between the steps. */
function tAtLength(lengths: number[], d: number): number {
  const n = lengths.length - 1;
  if (d <= 0) return 0;
  if (d >= lengths[n]) return 1;
  let i = 1;
  while (lengths[i] < d) i++;
  const span = lengths[i] - lengths[i - 1];
  return (i - 1 + (span > 0 ? (d - lengths[i - 1]) / span : 0)) / n;
}

/**
 * The piece from `from` (its `s`) shortened by `d` px at its start (`atStart`) or its end, never by more than its own
 * length, so trimming both ends of one piece can make it a point but never turn it round. Returns the piece's new start
 * and the segment that now ends it.
 */
function trimPiece(from: Pt, s: Exclude<Seg, { op: "Z" }>, d: number, atStart: boolean): { start: Pt; seg: Seg } {
  const to: Pt = { x: s.x, y: s.y };
  if (s.op !== "C") {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const t = len > 0 ? Math.min(d, len) / len : 0;
    if (atStart) return { start: lerp(from, to, t), seg: s };
    const end = lerp(to, from, t);
    return { start: from, seg: { op: "L", x: end.x, y: end.y } };
  }
  const c1: Pt = { x: s.x1, y: s.y1 };
  const c2: Pt = { x: s.x2, y: s.y2 };
  const lengths = cubicLengths(from, c1, c2, to, 64);
  const total = lengths[lengths.length - 1];
  const t = atStart ? tAtLength(lengths, d) : tAtLength(lengths, total - d);
  // De Casteljau's split at t: keep the part after t when trimming the start, before it when trimming the end.
  const p01 = lerp(from, c1, t);
  const p12 = lerp(c1, c2, t);
  const p23 = lerp(c2, to, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const mid = lerp(p012, p123, t);
  if (atStart) return { start: mid, seg: { op: "C", x1: p123.x, y1: p123.y, x2: p23.x, y2: p23.y, x: to.x, y: to.y } };
  return { start: from, seg: { op: "C", x1: p01.x, y1: p01.y, x2: p012.x, y2: p012.y, x: mid.x, y: mid.y } };
}

/** A drawn piece of an open path: the segment and the point it starts from. */
type Piece = { from: Pt; seg: Exclude<Seg, { op: "Z" }> };

function pieceLength({ from, seg }: Piece): number {
  if (seg.op !== "C") return Math.hypot(seg.x - from.x, seg.y - from.y);
  const lengths = cubicLengths(from, { x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }, seg, 64);
  return lengths[lengths.length - 1];
}

/**
 * The open path `M …` shortened by `startBy` px along its length from the start and `endBy` px from the end. A trim
 * longer than the end piece carries on into the pieces before it, so a cap always covers the last `inset` px of line
 * however short the pieces are. When the two trims together are longer than the path, they are scaled down to meet at
 * one point. A path that is not a single open subpath is returned as it is.
 */
function trimPath(p: PathData, startBy: number, endBy: number): PathData {
  if (p.length < 2 || p[0].op !== "M" || p.slice(1).some((s) => s.op === "Z" || s.op === "M")) return p;
  let start: Pt = p[0];
  const pieces: Piece[] = [];
  let at: Pt = start;
  for (const seg of p.slice(1) as Piece["seg"][]) {
    pieces.push({ from: at, seg });
    at = seg;
  }
  const lengths = pieces.map(pieceLength);
  const total = lengths.reduce((a, b) => a + b, 0);
  if (startBy + endBy > total) {
    const k = startBy + endBy > 0 ? total / (startBy + endBy) : 0;
    startBy *= k;
    endBy *= k;
  }
  // Whole pieces the trims swallow go first (keeping at least one piece), then the piece they end in is cut.
  let rest = endBy;
  while (pieces.length > 1 && rest > 0 && lengths[lengths.length - 1] <= rest) {
    rest -= lengths.pop()!;
    pieces.pop();
  }
  if (rest > 0) {
    const last = pieces[pieces.length - 1];
    pieces[pieces.length - 1] = { from: last.from, seg: trimPiece(last.from, last.seg, rest, false).seg as Piece["seg"] };
  }
  rest = startBy;
  while (pieces.length > 1 && rest > 0 && pieceLength(pieces[0]) <= rest) {
    rest -= pieceLength(pieces[0]);
    pieces.shift();
  }
  start = pieces[0].from;
  if (rest > 0) {
    const cut = trimPiece(pieces[0].from, pieces[0].seg, rest, true);
    start = cut.start;
    pieces[0] = { from: cut.start, seg: cut.seg as Piece["seg"] };
  }
  return [{ op: "M", x: start.x, y: start.y }, ...pieces.map((pc) => pc.seg)];
}

/** A non-negative finite number, else `fallback`. */
function size(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** `r` grown by `by` on every side. */
function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
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
 * - Each cap's tip is on its end, and the line is shortened by the cap's inset along its length. The cap's axis runs from
 *   where the shortened line now stops to the tip, so the line ends inside the cap even where the inset reaches round a
 *   corner of the route; on a straight end piece that axis is the path's tangent.
 *
 * Every number is finite for any ends, including both ends on one item or at one point.
 */
export function resolveConnector(doc: Document, c: ConnectorNode, registries: Registries): ResolvedConnector {
  const placed: [Placed, Placed] = [place(doc, c, c.ends[0], registries), place(doc, c, c.ends[1], registries)];
  const boxCenter: Pt = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  const unclipped = (i: 0 | 1): Pt => placed[i]?.pt ?? placed[1 - i]?.pt ?? boxCenter;
  const resolve = (i: 0 | 1): EndPoint => {
    const p = placed[i];
    if (!p) return { pt: unclipped(i), dir: null };
    const pt = p.clipTo ? (clipToOutline(p.pt, unclipped(i === 0 ? 1 : 0), p.clipTo.outline) ?? p.pt) : p.pt;
    return { pt, dir: p.dir };
  };
  const ends: [EndPoint, EndPoint] = [resolve(0), resolve(1)];

  const route = registries.routes.get(c.route);
  const routed: PathData = route
    ? route.path(ends[0], ends[1], c.routeParams)
    : [
        { op: "M", x: ends[0].pt.x, y: ends[0].pt.y },
        { op: "L", x: ends[1].pt.x, y: ends[1].pt.y },
      ];
  const full = withoutEmptyPieces(routed);

  const widthPx = size(c.stroke.width, 0) * PT_TO_PX;
  const capped = [0, 1].map((i) => {
    const kind = registries.caps.get(c.caps[i].kind);
    if (!kind) return { shape: [] as PathData, inset: 0 };
    const capSize = size(c.caps[i].size, DEFAULT_CAP_SIZE);
    return { shape: kind.path(capSize, widthPx), inset: size(kind.inset(capSize, widthPx), 0) };
  });
  const path = trimPath(full, capped[0].inset, capped[1].inset);

  const capAt = (i: 0 | 1): PathData | null => {
    const { shape } = capped[i];
    if (shape.length === 0) return null;
    const tip = pointAtEnd(full, i);
    const stop = pointAtEnd(path, i).pt;
    const dx = tip.pt.x - stop.x;
    const dy = tip.pt.y - stop.y;
    const len = Math.hypot(dx, dy);
    const t = len > 1e-9 ? { x: dx / len, y: dy / len } : tip.tangent;
    // The cap points along +x from the origin; turn +x onto its axis and move the origin to the tip.
    return transformPath(shape, [t.x, t.y, -t.y, t.x, tip.pt.x, tip.pt.y]);
  };
  const caps: [PathData | null, PathData | null] = [capAt(0), capAt(1)];

  // The drawn area: the line and caps, widened by half the line's width (a square line cap reaches √2 times that at a corner).
  const reach = (widthPx / 2) * (c.stroke.cap === "square" ? Math.SQRT2 : 1);
  const bounds = grow(unionRect([pathBounds(path), ...caps.filter((p): p is PathData => p !== null).map(pathBounds)]), reach);
  const paintBox = atLeast(pathBounds(full), widthPx);
  return { ends, path, caps, bounds, paintBox, detached: [placed[0] === null, placed[1] === null] };
}
