import type { Pt } from "../model/geometry";
import { ellipsePath, type PathData, type Seg } from "../model/path";
import type { CapKind } from "../registry/cap";
import { maxLead, type EndPoint, type Route } from "../registry/route";

/** `params[key]` when it is a finite number, else `fallback`: route params come from the file as they are. */
function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A straight line from end to end. */
export const straightRoute: Route = {
  id: "straight",
  name: "Straight",
  icon: "minus",
  defaults: () => ({}),
  fields: () => [],
  path: (a, b) => [
    { op: "M", x: a.pt.x, y: a.pt.y },
    { op: "L", x: b.pt.x, y: b.pt.y },
  ],
};

/**
 * One cubic from end to end. Its control points sit a third and two thirds of the way along the line, pushed sideways
 * by `bend` × the line's length (to the right of the direction of travel as the page shows it; a negative bend goes
 * left). An end attached to an anchor instead puts its control point the same distance (at least its `lead`) out along
 * the anchor's normal and then the same push sideways, so the curve leaves the item square to its edge and still bows
 * to the side `bend`'s sign picks.
 */
export const curvedRoute: Route = {
  id: "curved",
  name: "Curved",
  icon: "spline",
  defaults: () => ({ bend: 0.25 }),
  fields: () => [{ kind: "number", key: "bend", label: "Bend", min: -1, max: 1, step: 0.05 }],
  path(a, b, params) {
    const bend = numberParam(params, "bend", 0.25);
    const dx = b.pt.x - a.pt.x;
    const dy = b.pt.y - a.pt.y;
    // The perpendicular already scaled by the line's length, so a zero-length line needs no division and stays finite.
    const side = { x: -dy * bend, y: dx * bend };
    const reach = Math.hypot(Math.hypot(dx, dy) / 3, Math.hypot(side.x, side.y));
    const control = (end: EndPoint, other: EndPoint, along: number): Pt => {
      if (!end.dir) return { x: a.pt.x + dx * along + side.x, y: a.pt.y + dy * along + side.y };
      const out = Math.max(reach, Math.min(end.lead, maxLead(end, other)));
      return { x: end.pt.x + end.dir.x * out + side.x, y: end.pt.y + end.dir.y * out + side.y };
    };
    const c1 = control(a, b, 1 / 3);
    const c2 = control(b, a, 2 / 3);
    return [
      { op: "M", x: a.pt.x, y: a.pt.y },
      { op: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.pt.x, y: b.pt.y },
    ];
  },
  /** One handle, `bend`, on the curve half way along it. */
  handles(a, b, params) {
    const seg = curvedRoute.path(a, b, params)[1];
    if (seg?.op !== "C") return [];
    // The cubic at t = 1/2.
    const pt = { x: (a.pt.x + 3 * seg.x1 + 3 * seg.x2 + b.pt.x) / 8, y: (a.pt.y + 3 * seg.y1 + 3 * seg.y2 + b.pt.y) / 8 };
    return [{ id: "bend", pt }];
  },
  /**
   * The bend that puts the curve's middle (its handle) at `to`'s distance to the side of the line, within the field's
   * −1 to 1. Between two free ends that middle lies 3/4 of the control points' push off the line, so the bend is that
   * distance over 3/4 of the length. With an end attached, the anchor's normal moves the middle too, so the bend is
   * found by bisection on where `handles` puts it: its distance to the side only grows with the bend (the normal's part
   * is the same for a bend and its negative, and never grows faster than the push). A line with no length keeps its
   * bend.
   */
  dragHandle(id, to, a, b, params) {
    const dx = b.pt.x - a.pt.x;
    const dy = b.pt.y - a.pt.y;
    const len2 = dx * dx + dy * dy;
    if (id !== "bend" || len2 === 0) return { bend: numberParam(params, "bend", 0.25) };
    // Distance to the side of the line, times its length.
    const sideOf = (pt: Pt): number => (pt.x - a.pt.x) * -dy + (pt.y - a.pt.y) * dx;
    const target = sideOf(to);
    let bend: number;
    if (!a.dir && !b.dir) bend = Math.max(-1, Math.min(1, target / (0.75 * len2)));
    else {
      let lo = -1;
      let hi = 1;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        const pt = curvedRoute.handles?.(a, b, { ...params, bend: mid })[0]?.pt;
        if (pt && sideOf(pt) < target) lo = mid;
        else hi = mid;
      }
      bend = (lo + hi) / 2;
    }
    return { bend: Math.round(bend * 1000) / 1000 };
  },
};

/**
 * The middle segment of an elbow path and the axis it moves along when its `offset` changes: "x" when it is upright (a
 * horizontal Z), "y" when it lies flat. Null when the path has no segment between its first and last legs (a straight
 * run, an L) or that segment is slanted.
 */
function middleSegment(path: PathData): { from: Pt; to: Pt; axis: "x" | "y" } | null {
  const pts = path.filter((s): s is Extract<Seg, { op: "M" | "L" }> => s.op === "M" || s.op === "L");
  // Three or more legs: the middle one. Fewer (a straight line, an L) have no middle segment to move.
  if (pts.length < 4) return null;
  const i = Math.floor((pts.length - 2) / 2);
  const from = pts[i];
  const to = pts[i + 1];
  if (from.x === to.x && from.y !== to.y) return { from, to, axis: "x" };
  if (from.y === to.y && from.x !== to.x) return { from, to, axis: "y" };
  return null;
}

/** How far, at most, an orthogonal route runs straight out along an anchor's normal before it may turn. */
const STUB_PX = 12;

/** A unit direction along the page axis nearest `d`. */
function nearestAxis(d: Pt): Pt {
  return Math.abs(d.x) >= Math.abs(d.y) ? { x: Math.sign(d.x) || 1, y: 0 } : { x: 0, y: Math.sign(d.y) || 1 };
}

/**
 * How well a leg leaving `from` toward `to` respects an end that must leave along `dir`: 2 when it goes along `dir` (or
 * the end has no direction), 1 when it goes square to it, 0 when it doubles back.
 */
function legScore(from: Pt, to: Pt, dir: Pt | null): number {
  if (!dir) return 2;
  const along = (to.x - from.x) * dir.x + (to.y - from.y) * dir.y;
  return along > 1e-9 ? 2 : along < -1e-9 ? 0 : 1;
}

/** The first leg of `pts` (from its first point) that has length, as its two ends; null when every point is the same. */
function firstLeg(pts: Pt[]): [Pt, Pt] | null {
  for (let i = 1; i < pts.length; i++) if (pts[i].x !== pts[0].x || pts[i].y !== pts[0].y) return [pts[0], pts[i]];
  return null;
}

/** `pts` without repeated points, and without corners where the line runs straight on in the same direction. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const pt of pts) {
    const last = out[out.length - 1];
    if (last && last.x === pt.x && last.y === pt.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const cross = (last.x - a.x) * (pt.y - last.y) - (last.y - a.y) * (pt.x - last.x);
      const dot = (last.x - a.x) * (pt.x - last.x) + (last.y - a.y) * (pt.y - last.y);
      if (Math.abs(cross) < 1e-9 && dot > 0) out.pop();
    }
    out.push(pt);
  }
  return out;
}

/**
 * A simple elbow, with no obstacle avoidance. An end attached to an anchor first runs a short stub straight out along
 * the anchor's normal (rotated with its item), never shorter than the end's `lead`, so the line leaves its item square
 * to the edge and arrives into an anchor from outside; a free or centre end has no stub. Between the stub ends the route is axis-aligned: of a few candidate
 * elbows (a Z whose middle segment crosses at `offset`, 0–1, of the way from start to end; an L with one corner; a U
 * round the far side when both ends face the same way) it takes the first that never doubles back along an end's
 * normal, preferring legs that carry straight on from a stub. Ends with no normal use the axis on which they are
 * further apart.
 *
 * A stub never overshoots: each end's stub is capped, on its own, at half the way to an end that genuinely lies ahead
 * of it (`maxLead`), so between close facing ends the two stubs meet and the route on one row is a straight line. The
 * candidates are scored whatever the stubs, so a route that doubles back is never taken while another does not.
 */
export const orthogonalRoute: Route = {
  id: "orthogonal",
  name: "Orthogonal",
  icon: "corner-down-right",
  defaults: () => ({ offset: 0.5 }),
  fields: () => [{ kind: "number", key: "offset", label: "Bend position", min: 0, max: 1, step: 0.05 }],
  path(a, b, params) {
    const offset = Math.max(0, Math.min(1, numberParam(params, "offset", 0.5)));
    const stub = Math.min(STUB_PX, Math.hypot(b.pt.x - a.pt.x, b.pt.y - a.pt.y) / 3);
    const out = (e: EndPoint, other: EndPoint): Pt => {
      if (!e.dir) return e.pt;
      const run = Math.min(Math.max(stub, e.lead), maxLead(e, other));
      return { x: e.pt.x + e.dir.x * run, y: e.pt.y + e.dir.y * run };
    };
    const p = out(a, b);
    const q = out(b, a);
    const da = a.dir ? nearestAxis(a.dir) : null;
    const db = b.dir ? nearestAxis(b.dir) : null;
    const wide = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y);
    const horizontalA = da ? da.x !== 0 : wide;
    const horizontalB = db ? db.x !== 0 : wide;
    const between = (from: number, to: number, lo: number, hi: number): number =>
      Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), from + (to - from) * offset));
    const mx = between(a.pt.x, b.pt.x, p.x, q.x);
    const my = between(a.pt.y, b.pt.y, p.y, q.y);
    // The far side, for a U: beyond both ends in the direction an end faces.
    const far = (axis: "x" | "y"): number => {
      const d = (da && da[axis] !== 0 ? da : db && db[axis] !== 0 ? db : null)?.[axis] ?? 1;
      return d > 0 ? Math.max(p[axis], q[axis]) : Math.min(p[axis], q[axis]);
    };
    const zh: Pt[] = [{ x: mx, y: p.y }, { x: mx, y: q.y }];
    const zv: Pt[] = [{ x: p.x, y: my }, { x: q.x, y: my }];
    const uh: Pt[] = [{ x: far("x"), y: p.y }, { x: far("x"), y: q.y }];
    const uv: Pt[] = [{ x: p.x, y: far("y") }, { x: q.x, y: far("y") }];
    const lh: Pt[] = [{ x: q.x, y: p.y }];
    const lv: Pt[] = [{ x: p.x, y: q.y }];
    const candidates =
      horizontalA && horizontalB
        ? [zh, uh, lh, lv, zv, uv]
        : !horizontalA && !horizontalB
          ? [zv, uv, lv, lh, zh, uh]
          : horizontalA
            ? [lh, lv, zh, zv, uh, uv]
            : [lv, lh, zv, zh, uv, uh];
    let best = candidates[0];
    let bestScore = -1;
    for (const corners of candidates) {
      const pts = [p, ...corners, q];
      const first = firstLeg(pts);
      const last = firstLeg([...pts].reverse());
      const sa = first ? legScore(first[0], first[1], da) : 2;
      const sb = last ? legScore(last[0], last[1], db) : 2;
      const score = sa === 0 || sb === 0 ? 0 : sa + sb;
      if (score > bestScore) {
        best = corners;
        bestScore = score;
      }
    }
    const pts = simplify([a.pt, p, ...best, q, b.pt]);
    if (pts.length === 1) pts.push(pts[0]);
    return [{ op: "M", x: pts[0].x, y: pts[0].y }, ...pts.slice(1).map((pt) => ({ op: "L" as const, x: pt.x, y: pt.y }))];
  },
  /**
   * One handle, `offset`, half way along the elbow's middle segment, when `offset` moves anything (the route at offset 0
   * and at 1 differ); none otherwise (a straight run, an L, a U round the far side), nor when there is no middle segment.
   */
  handles(a, b, params) {
    const middle = middleSegment(orthogonalRoute.path(a, b, params));
    const at = (offset: number): string => JSON.stringify(orthogonalRoute.path(a, b, { ...params, offset }));
    if (!middle || at(0) === at(1)) return [];
    return [{ id: "offset", pt: { x: (middle.from.x + middle.to.x) / 2, y: (middle.from.y + middle.to.y) / 2 } }];
  },
  /**
   * The offset that puts the middle segment through `to`: how far `to` is from the start toward the end, across the
   * segment, as a fraction 0–1. Ends level on that axis keep their offset.
   */
  dragHandle(id, to, a, b, params) {
    const offset = numberParam(params, "offset", 0.5);
    const middle = id === "offset" ? middleSegment(orthogonalRoute.path(a, b, params)) : null;
    if (!middle) return { offset };
    const span = b.pt[middle.axis] - a.pt[middle.axis];
    if (span === 0) return { offset };
    return { offset: Math.round(Math.max(0, Math.min(1, (to[middle.axis] - a.pt[middle.axis]) / span)) * 1000) / 1000 };
  },
};

/** The routes the plugin registers at load. */
export const builtinRoutes: Route[] = [straightRoute, curvedRoute, orthogonalRoute];

/**
 * A cap's length along the line in px: its size (a multiple of the stroke width) times that width, but never below
 * `minSize` widths, the smallest at which that kind still makes a sound shape at least as wide as the line. 0 when the
 * line has no width, which draws no cap.
 */
function capLength(size: number, strokeWidthPx: number, minSize: number): number {
  if (!(Number.isFinite(strokeWidthPx) && strokeWidthPx > 0)) return 0;
  return Math.max(Number.isFinite(size) ? size : 0, minSize) * strokeWidthPx;
}

/** No cap: the line runs to its end. */
export const noCap: CapKind = {
  id: "none",
  name: "None",
  path: () => [],
  inset: () => 0,
  pptxEnd: "none",
};

/** The smallest arrow: two thirds as wide as long, it is then 1 line width wide at its base. */
const ARROW_MIN_SIZE = 1.5;

/** A filled triangle as long as the cap's size and two thirds as wide, its tip on the end; the line stops at its base. */
export const arrowCap: CapKind = {
  id: "arrow",
  name: "Arrow",
  path(size, w) {
    const l = capLength(size, w, ARROW_MIN_SIZE);
    if (l === 0) return [];
    return [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: -l, y: l / 3 },
      { op: "L", x: -l, y: -l / 3 },
      { op: "Z" },
    ];
  },
  inset: (size, w) => capLength(size, w, ARROW_MIN_SIZE),
  pptxEnd: "triangle",
};

/**
 * The smallest open arrow. Its arms' inner edges meet √5 line widths behind the tip and reach the axis at 4/√5 ≈ 1.79
 * widths, where the outline would cross itself; at 2.5 the chevron is still open.
 */
const OPEN_ARROW_MIN_SIZE = 2.5;

/**
 * An open chevron, its tip on the end and its arms reaching back the cap's size, as thick as the line, drawn as a
 * filled outline. The line stops inside the solid part of the tip, where the chevron is at least as thick as the line.
 */
export const openArrowCap: CapKind = {
  id: "openArrow",
  name: "Open arrow",
  path(size, w) {
    const l = capLength(size, w, OPEN_ARROW_MIN_SIZE);
    if (l === 0) return [];
    const h = l / 2;
    const m = Math.hypot(l, h);
    // Each arm's inner edge is its outer edge moved the line's width toward the axis; the two inner edges meet on the axis.
    const inner = { x: -l - (w * h) / m, y: h - (w * l) / m };
    return [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: -l, y: h },
      { op: "L", x: inner.x, y: inner.y },
      { op: "L", x: (-w * m) / h, y: 0 },
      { op: "L", x: inner.x, y: -inner.y },
      { op: "L", x: -l, y: -h },
      { op: "Z" },
    ];
  },
  inset(size, w) {
    const l = capLength(size, w, OPEN_ARROW_MIN_SIZE);
    // Half the inner corner's depth (w·m/h with h = l/2): there the chevron's solid tip is at least the line's width across.
    return l === 0 ? 0 : (w * Math.hypot(l, l / 2)) / l;
  },
  pptxEnd: "arrow",
};

/** A filled disc whose diameter is the cap's size (at least the line's width), touching the end; the line stops at its centre. */
export const circleCap: CapKind = {
  id: "circle",
  name: "Circle",
  path(size, w) {
    const l = capLength(size, w, 1);
    return l === 0 ? [] : ellipsePath({ x: -l, y: -l / 2, width: l, height: l });
  },
  inset: (size, w) => capLength(size, w, 1) / 2,
  pptxEnd: "oval",
};

/** A bar across the end, as long as the cap's size (at least the line's width) and as thick as the line, its outer edge on the end; the line stops inside it. */
export const barCap: CapKind = {
  id: "bar",
  name: "Bar",
  path(size, w) {
    const l = capLength(size, w, 1);
    if (l === 0) return [];
    return [
      { op: "M", x: 0, y: -l / 2 },
      { op: "L", x: 0, y: l / 2 },
      { op: "L", x: -w, y: l / 2 },
      { op: "L", x: -w, y: -l / 2 },
      { op: "Z" },
    ];
  },
  inset: (size, w) => (capLength(size, w, 1) === 0 ? 0 : w / 2),
};

/** The cap kinds the plugin registers at load. */
export const builtinCapKinds: CapKind[] = [noCap, arrowCap, openArrowCap, circleCap, barCap];
