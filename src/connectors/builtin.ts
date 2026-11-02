import type { Pt } from "../model/geometry";
import { ellipsePath } from "../model/path";
import type { CapKind } from "../registry/cap";
import type { EndPoint, Route } from "../registry/route";

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
 * left). An end attached to an anchor instead puts its control point the same distance out along the anchor's normal,
 * so the curve leaves the item square to its edge.
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
    const control = (end: EndPoint, along: number): Pt =>
      end.dir
        ? { x: end.pt.x + end.dir.x * reach, y: end.pt.y + end.dir.y * reach }
        : { x: a.pt.x + dx * along + side.x, y: a.pt.y + dy * along + side.y };
    const c1 = control(a, 1 / 3);
    const c2 = control(b, 2 / 3);
    return [
      { op: "M", x: a.pt.x, y: a.pt.y },
      { op: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.pt.x, y: b.pt.y },
    ];
  },
};

/** How far, at most, an orthogonal route runs out along a slanted anchor normal (a rotated item's) before it turns square. */
const SLANT_STUB_PX = 12;

/** Whether a unit direction runs (within rounding) along the page's x or y axis. */
function onAxis(d: Pt): boolean {
  return Math.abs(d.x) < 1e-9 || Math.abs(d.y) < 1e-9;
}

/**
 * A simple elbow, with no obstacle avoidance. Each end runs along its anchor's normal or, when it has none, along the
 * axis on which the ends are further apart. When both run along the same axis the route is three segments, the middle
 * one crossing at `offset` (0–1) of the way from start to end; when they differ it is two, meeting at a corner. An
 * anchor normal that is not on an axis (a rotated item's) first gets a short stub along the normal, so the line still
 * leaves square to the item's edge, and the elbow continues from the stub's end on the normal's nearer axis.
 */
export const orthogonalRoute: Route = {
  id: "orthogonal",
  name: "Orthogonal",
  icon: "corner-down-right",
  defaults: () => ({ offset: 0.5 }),
  fields: () => [{ kind: "number", key: "offset", label: "Bend position", min: 0, max: 1, step: 0.05 }],
  path(a, b, params) {
    const offset = numberParam(params, "offset", 0.5);
    const stub = Math.min(SLANT_STUB_PX, Math.hypot(b.pt.x - a.pt.x, b.pt.y - a.pt.y) / 3);
    const out = (e: EndPoint): Pt => (e.dir && !onAxis(e.dir) ? { x: e.pt.x + e.dir.x * stub, y: e.pt.y + e.dir.y * stub } : e.pt);
    const p = out(a);
    const q = out(b);
    const wide = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y);
    const horizontal = (e: EndPoint): boolean => (e.dir ? Math.abs(e.dir.x) >= Math.abs(e.dir.y) : wide);
    const ha = horizontal(a);
    const hb = horizontal(b);
    let corners: Pt[];
    if (ha && hb) {
      const mx = p.x + (q.x - p.x) * offset;
      corners = [{ x: mx, y: p.y }, { x: mx, y: q.y }];
    } else if (!ha && !hb) {
      const my = p.y + (q.y - p.y) * offset;
      corners = [{ x: p.x, y: my }, { x: q.x, y: my }];
    } else corners = [ha ? { x: q.x, y: p.y } : { x: p.x, y: q.y }];
    const pts = [a.pt, ...(p === a.pt ? [] : [p]), ...corners, ...(q === b.pt ? [] : [q]), b.pt];
    return [{ op: "M", x: pts[0].x, y: pts[0].y }, ...pts.slice(1).map((pt) => ({ op: "L" as const, x: pt.x, y: pt.y }))];
  },
};

/** The routes the plugin registers at load. */
export const builtinRoutes: Route[] = [straightRoute, curvedRoute, orthogonalRoute];

/** A cap's length along the line in px: its size (a multiple of the stroke width) times that width; never negative. */
function capLength(size: number, strokeWidthPx: number): number {
  const l = size * strokeWidthPx;
  return Number.isFinite(l) && l > 0 ? l : 0;
}

/** No cap: the line runs to its end. */
export const noCap: CapKind = {
  id: "none",
  name: "None",
  path: () => [],
  inset: () => 0,
};

/** A filled triangle as long as the cap's size and two thirds as wide, its tip on the end; the line stops at its base. */
export const arrowCap: CapKind = {
  id: "arrow",
  name: "Arrow",
  path(size, w) {
    const l = capLength(size, w);
    if (l === 0) return [];
    return [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: -l, y: l / 3 },
      { op: "L", x: -l, y: -l / 3 },
      { op: "Z" },
    ];
  },
  inset: (size, w) => capLength(size, w),
};

/**
 * An open chevron, its tip on the end and its arms reaching back the cap's size, as thick as the line, drawn as a
 * filled outline. The line stops inside the solid part of the tip, where the chevron is at least as thick as the line.
 */
export const openArrowCap: CapKind = {
  id: "openArrow",
  name: "Open arrow",
  path(size, w) {
    const l = capLength(size, w);
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
    const l = capLength(size, w);
    // Half the inner corner's depth (w·m/h with h = l/2): there the chevron's solid tip is at least the line's width across.
    return l === 0 ? 0 : (w * Math.hypot(l, l / 2)) / l;
  },
};

/** A filled disc whose diameter is the cap's size, touching the end; the line stops at its centre. */
export const circleCap: CapKind = {
  id: "circle",
  name: "Circle",
  path(size, w) {
    const l = capLength(size, w);
    return l === 0 ? [] : ellipsePath({ x: -l, y: -l / 2, width: l, height: l });
  },
  inset: (size, w) => capLength(size, w) / 2,
};

/** A bar across the end, as long as the cap's size and as thick as the line, its outer edge on the end; the line stops inside it. */
export const barCap: CapKind = {
  id: "bar",
  name: "Bar",
  path(size, w) {
    const l = capLength(size, w);
    if (l === 0) return [];
    return [
      { op: "M", x: 0, y: -l / 2 },
      { op: "L", x: 0, y: l / 2 },
      { op: "L", x: -w, y: l / 2 },
      { op: "L", x: -w, y: -l / 2 },
      { op: "Z" },
    ];
  },
  inset: (size, w) => (capLength(size, w) === 0 ? 0 : w / 2),
};

/** The cap kinds the plugin registers at load. */
export const builtinCapKinds: CapKind[] = [noCap, arrowCap, openArrowCap, circleCap, barCap];
