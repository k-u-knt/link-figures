import { PT_TO_PX } from "../constants";
import type { Pt } from "../model/geometry";
import { flattenPath, type PathData, type Seg } from "../model/path";

/**
 * A stroke turned into the area it covers, for the PDF export: svg2pdf.js (2.8.1) paints a gradient or pattern on a
 * fill but not on a stroke, so such a stroke is drawn as its outline filled with the paint (see `outlinePaintedStrokes`).
 * The outline is a union of pieces (each segment's body, each join, each cap), every piece wound the same way, so it is
 * to be filled with the nonzero rule. Straight segments are exact; cubics are flattened to `OUTLINE_TOLERANCE_PX`.
 */

export type LineCap = "butt" | "round" | "square";
export type LineJoin = "miter" | "round" | "bevel";

export interface OutlineOptions {
  /** Where along the dash pattern the path starts, as `stroke-dashoffset`. */
  dashOffset?: number;
  /** As `stroke-miterlimit`: a miter longer than this many stroke widths is bevelled. */
  miterLimit?: number;
  /** How far, in the path's units, a curve's flattened outline may stray from the true one. */
  tolerance?: number;
}

/** The tolerance curves are flattened to: 0.05 pt, in px. */
export const OUTLINE_TOLERANCE_PX = 0.05 * PT_TO_PX;

const DEFAULT_MITER_LIMIT = 4;
/** The cubic control constant for a quarter circle. */
const KAPPA = 0.5522847498307936;
const EPS = 1e-9;

/** A polyline's point; `corner` is false inside a flattened curve, where the line is smooth and no join style applies. */
interface Vertex extends Pt {
  corner: boolean;
}

/** One subpath as a polyline, or one dash of it. `dir` orients the caps of a line with no length. */
interface Polyline {
  pts: Vertex[];
  closed: boolean;
  dir: Pt;
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const same = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

function unit(v: Pt): Pt | null {
  const len = Math.hypot(v.x, v.y);
  return len > EPS ? { x: v.x / len, y: v.y / len } : null;
}

/** The normal on one side of the direction `d`, `hw` long. */
const normal = (d: Pt, hw: number): Pt => ({ x: -d.y * hw, y: d.x * hw });

/** The path's subpaths as polylines, with consecutive repeated points merged. A subpath that is only a move draws nothing. */
function polylines(path: PathData, tolerance: number): Polyline[] {
  const out: Polyline[] = [];
  let pts: Vertex[] | null = null;
  let drawn = false;
  let start: Pt = { x: 0, y: 0 };
  let at: Pt = { x: 0, y: 0 };
  const finish = (closed: boolean) => {
    if (pts && drawn) out.push(tidy(pts, closed));
    pts = null;
    drawn = false;
  };
  const open = (): Vertex[] => (pts ??= [{ ...at, corner: true }]);
  for (const seg of path) {
    if (seg.op === "M") {
      finish(false);
      at = start = { x: seg.x, y: seg.y };
      pts = [{ ...at, corner: true }];
    } else if (seg.op === "L") {
      open().push({ x: seg.x, y: seg.y, corner: true });
      drawn = true;
      at = { x: seg.x, y: seg.y };
    } else if (seg.op === "C") {
      const line = open();
      const flat = flattenPath([{ op: "M", x: at.x, y: at.y }, seg as Seg], tolerance)[0];
      for (let i = 1; i < flat.length; i++) line.push({ ...flat[i], corner: i === flat.length - 1 });
      drawn = true;
      at = { x: seg.x, y: seg.y };
    } else {
      open();
      drawn = true;
      finish(true);
      at = start;
    }
  }
  finish(false);
  return out;
}

/** The polyline without repeated points (a closed one without a last point on its first), and the direction its first piece goes. */
function tidy(raw: Vertex[], closed: boolean): Polyline {
  const pts: Vertex[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (last && same(last, p)) last.corner ||= p.corner;
    else pts.push({ ...p });
  }
  if (closed && pts.length > 1 && same(pts[0], pts[pts.length - 1])) {
    pts[0].corner ||= pts[pts.length - 1].corner;
    pts.pop();
  }
  const dir = pts.length > 1 ? unit(sub(pts[1], pts[0])) ?? { x: 1, y: 0 } : { x: 1, y: 0 };
  return { pts, closed, dir };
}

/**
 * The line cut into its dashes, each an open polyline. `dash` is the dash and gap lengths (an odd list repeated, as
 * SVG does); a closed line's dashes run on through its closing segment but are not joined across its start.
 */
function dashes(line: Polyline, dash: number[], offset: number): Polyline[] {
  const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : dash;
  const total = pattern.reduce((a, b) => a + b, 0);
  const pts = line.closed ? [...line.pts, { ...line.pts[0] }] : line.pts;
  if (pts.length < 2) return [line];

  let phase = ((offset % total) + total) % total;
  let i = 0;
  // A dash of length zero where the path starts is still drawn (a dot); a dash that ends exactly there is not.
  while (phase > pattern[i] || (phase === pattern[i] && pattern[i] > 0)) {
    phase -= pattern[i];
    i = (i + 1) % pattern.length;
  }
  let left = pattern[i] - phase;
  let on = i % 2 === 0;
  const out: Polyline[] = [];
  let current: Vertex[] | null = on ? [{ ...pts[0], corner: false }] : null;
  let dir = line.dir;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    dir = unit(sub(b, a)) ?? dir;
    let pos = 0;
    while (length - pos > left) {
      pos += left;
      const p = { x: a.x + ((b.x - a.x) * pos) / length, y: a.y + ((b.y - a.y) * pos) / length, corner: false };
      if (current) {
        current.push(p);
        out.push({ pts: current, closed: false, dir });
        current = null;
      } else {
        current = [p];
      }
      i = (i + 1) % pattern.length;
      left = pattern[i];
      on = !on;
    }
    left -= length - pos;
    if (current) current.push({ ...b });
  }
  // Pattern entries that end exactly at the path's end: a dash of length zero there is still a dot.
  const end = pts[pts.length - 1];
  while (left <= EPS) {
    i = (i + 1) % pattern.length;
    left = pattern[i];
    on = !on;
    if (on) {
      if (left <= EPS) out.push({ pts: [{ ...end, corner: false }], closed: false, dir });
    } else if (current) {
      current.push({ ...end, corner: false });
      out.push({ pts: current, closed: false, dir });
      current = null;
    }
  }
  if (current) out.push({ pts: current, closed: false, dir });
  // A dash with no length (a dot) keeps the direction of the segment it lies on, for its square caps.
  return out.map((d) => {
    const tidied = tidy(d.pts, false);
    return tidied.pts.length > 1 ? tidied : { ...tidied, dir: d.dir };
  });
}

/** Appends a polygon wound the positive way (by the shoelace sum); one with no area is left out. */
function polygon(out: PathData, pts: Pt[]): void {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area) < EPS) return;
  const ring = area > 0 ? pts : [...pts].reverse();
  ring.forEach((p, i) => out.push({ op: i === 0 ? "M" : "L", x: p.x, y: p.y }));
  out.push({ op: "Z" });
}

/** A quarter of an ellipse arc from `from` to `to`, leaving `from` along `t0` and arriving at `to` along `t1` (each `r` long). */
const quarter = (from: Pt, t0: Pt, to: Pt, t1: Pt): Seg => ({
  op: "C",
  x1: from.x + t0.x * KAPPA,
  y1: from.y + t0.y * KAPPA,
  x2: to.x - t1.x * KAPPA,
  y2: to.y - t1.y * KAPPA,
  x: to.x,
  y: to.y,
});

/** A disc of radius `r` about `c`, wound the positive way. */
function disc(out: PathData, c: Pt, r: number): void {
  const e = { x: r, y: 0 };
  const s = { x: 0, y: r };
  const pts = [add(c, e), add(c, s), sub(c, e), sub(c, s)];
  const tangents = [s, scale(e, -1), scale(s, -1), e];
  out.push({ op: "M", x: pts[0].x, y: pts[0].y });
  for (let i = 0; i < 4; i++) out.push(quarter(pts[i], tangents[i], pts[(i + 1) % 4], tangents[(i + 1) % 4]));
  out.push({ op: "Z" });
}

/** A half disc of radius `hw` on the end `e` of a line, bulging along `d` (the way out of the line), wound the positive way. */
function halfDisc(out: PathData, e: Pt, d: Pt, hw: number): void {
  let n = normal(d, hw);
  const tip = add(e, scale(d, hw));
  const a = add(e, n);
  const b = sub(e, n);
  // The triangle (a, tip, b) has the half disc's winding; flipping the normal reverses it.
  if ((tip.x - a.x) * (b.y - a.y) - (b.x - a.x) * (tip.y - a.y) < 0) n = scale(n, -1);
  const from = add(e, n);
  const to = sub(e, n);
  const out1 = scale(d, hw);
  out.push({ op: "M", x: from.x, y: from.y });
  out.push(quarter(from, out1, tip, scale(n, -1)));
  out.push(quarter(tip, scale(n, -1), to, scale(out1, -1)));
  out.push({ op: "Z" });
}

/** The cap on the end `e` of a line, where `d` points out of the line. */
function cap(out: PathData, e: Pt, d: Pt, hw: number, kind: LineCap): void {
  if (kind === "round") halfDisc(out, e, d, hw);
  else if (kind === "square") {
    const n = normal(d, hw);
    const ahead = scale(d, hw);
    polygon(out, [add(e, n), add(add(e, n), ahead), add(sub(e, n), ahead), sub(e, n)]);
  }
}

/** The join at `v` between a segment going along `d1` and the next going along `d2`. */
function joint(out: PathData, v: Vertex, d1: Pt, d2: Pt, hw: number, join: LineJoin, limit: number, tolerance: number): void {
  const cross = d1.x * d2.y - d1.y * d2.x;
  const dot = d1.x * d2.x + d1.y * d2.y;
  if (Math.abs(cross) < EPS && dot > 0) return;
  // The outer side of the turn: the bodies already cover the inner side.
  const side = cross > 0 ? -1 : 1;
  const o1 = add(v, scale(normal(d1, hw), side));
  const o2 = add(v, scale(normal(d2, hw), side));
  // cos of half the angle the line turns by; a smooth vertex of a flattened curve is rounded only when a bevel would stray.
  const halfCos = Math.sqrt(Math.max(0, (1 + dot) / 2));
  const style: LineJoin = v.corner ? join : hw * (1 - halfCos) > tolerance ? "round" : "bevel";
  if (style === "round") return disc(out, v, hw);
  if (style === "miter" && halfCos > EPS && 1 / halfCos <= limit) {
    const bisector = unit(add(normal(d1, 1), normal(d2, 1)));
    if (bisector) return polygon(out, [v, o1, add(v, scale(bisector, (side * hw) / halfCos)), o2]);
  }
  polygon(out, [v, o1, o2]);
}

/** The outline of one polyline: its segments' bodies, its joins, and its caps when it is open. */
function lineOutline(out: PathData, line: Polyline, hw: number, capKind: LineCap, join: LineJoin, limit: number, tolerance: number): void {
  const { pts, closed } = line;
  if (pts.length === 1) {
    if (capKind === "round") disc(out, pts[0], hw);
    else if (capKind === "square") {
      const d = scale(line.dir, hw);
      const n = normal(line.dir, hw);
      polygon(out, [add(add(pts[0], d), n), add(sub(pts[0], d), n), sub(sub(pts[0], d), n), sub(add(pts[0], d), n)]);
    }
    return;
  }
  const count = closed ? pts.length : pts.length - 1;
  const dirs: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = unit(sub(b, a)) ?? line.dir;
    dirs.push(d);
    const n = normal(d, hw);
    polygon(out, [add(a, n), add(b, n), sub(b, n), sub(a, n)]);
  }
  for (let i = closed ? 0 : 1; i < (closed ? pts.length : pts.length - 1); i++) {
    joint(out, pts[i], dirs[(i - 1 + count) % count], dirs[i], hw, join, limit, tolerance);
  }
  if (!closed) {
    cap(out, pts[0], scale(dirs[0], -1), hw, capKind);
    cap(out, pts[pts.length - 1], dirs[count - 1], hw, capKind);
  }
}

/**
 * The area a stroke of `width` covers along `path`, as closed subpaths to fill with the nonzero rule: what SVG draws for
 * `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray` (`dash`, in the path's units) and the
 * options' offset and miter limit. A zero-length subpath is a dot with round or square caps, as SVG draws it. A width
 * of zero (or less), or a dash list that draws nothing, gives an empty outline.
 */
export function strokeOutline(path: PathData, width: number, capKind: LineCap, join: LineJoin, dash: number[] = [], opts: OutlineOptions = {}): PathData {
  const hw = width / 2;
  if (!(hw > 0) || !Number.isFinite(hw)) return [];
  const tolerance = opts.tolerance ?? OUTLINE_TOLERANCE_PX;
  const limit = Math.max(1, opts.miterLimit ?? DEFAULT_MITER_LIMIT);
  const dashTotal = dash.reduce((a, b) => a + b, 0);
  const dashed = dash.length > 0 && dash.every((d) => d >= 0 && Number.isFinite(d)) && dashTotal > 0;
  const out: PathData = [];
  for (const line of polylines(path, tolerance)) {
    for (const piece of dashed ? dashes(line, dash, opts.dashOffset ?? 0) : [line]) lineOutline(out, piece, hw, capKind, join, limit, tolerance);
  }
  return out;
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const COMMAND = /[MmLlHhVvCcSsQqTtZzAa]/y;
const SEPARATOR = /[\s,]*/y;

/**
 * An SVG `d` attribute as absolute `PathData`: moves, lines (H and V too), cubics (S too) and quadratics (Q, T, raised
 * to cubics, which is exact), closes, absolute or relative. Null for a path with arcs, or one that does not parse.
 */
export function svgPathData(d: string): PathData | null {
  let pos = 0;
  const skip = () => {
    SEPARATOR.lastIndex = pos;
    SEPARATOR.exec(d);
    pos = SEPARATOR.lastIndex;
  };
  const number = (): number | null => {
    skip();
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(d);
    if (!m) return null;
    pos = NUMBER.lastIndex;
    return Number(m[0]);
  };
  const numbers = (n: number): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = number();
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };

  const out: PathData = [];
  let cur = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  /** The last cubic's second control point, or quadratic's control point, for S and T. */
  let lastC: Pt | null = null;
  let lastQ: Pt | null = null;
  let command: string | null = null;
  for (;;) {
    skip();
    if (pos >= d.length) break;
    COMMAND.lastIndex = pos;
    const m = COMMAND.exec(d);
    if (m) {
      command = m[0];
      pos = COMMAND.lastIndex;
    } else if (command === null || command === "Z" || command === "z") return null;
    const letter: string = command;
    const rel = letter === letter.toLowerCase();
    const base = rel ? cur : { x: 0, y: 0 };
    const kind = letter.toUpperCase();
    if (kind === "A") return null;
    if (kind === "Z") {
      out.push({ op: "Z" });
      cur = start;
      lastC = lastQ = null;
      continue;
    }
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 }[kind]!;
    const v = numbers(arity);
    if (!v) return null;
    let nextC: Pt | null = null;
    let nextQ: Pt | null = null;
    if (kind === "M") {
      cur = start = { x: base.x + v[0], y: base.y + v[1] };
      out.push({ op: "M", ...cur });
      // Further pairs after a move are lines.
      command = rel ? "l" : "L";
    } else if (kind === "L" || kind === "H" || kind === "V") {
      const x = kind === "V" ? cur.x : base.x + v[0];
      const y = kind === "H" ? cur.y : kind === "V" ? base.y + v[0] : base.y + v[1];
      cur = { x, y };
      out.push({ op: "L", ...cur });
    } else if (kind === "C" || kind === "S") {
      const c1: Pt = kind === "C" ? { x: base.x + v[0], y: base.y + v[1] } : lastC ? sub(scale(cur, 2), lastC) : cur;
      const rest = kind === "C" ? v.slice(2) : v;
      const c2 = { x: base.x + rest[0], y: base.y + rest[1] };
      const end = { x: base.x + rest[2], y: base.y + rest[3] };
      out.push({ op: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
      nextC = c2;
      cur = end;
    } else {
      const q: Pt = kind === "Q" ? { x: base.x + v[0], y: base.y + v[1] } : lastQ ? sub(scale(cur, 2), lastQ) : cur;
      const rest = kind === "Q" ? v.slice(2) : v;
      const end = { x: base.x + rest[0], y: base.y + rest[1] };
      const c1 = add(cur, scale(sub(q, cur), 2 / 3));
      const c2 = add(end, scale(sub(q, end), 2 / 3));
      out.push({ op: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
      nextQ = q;
      cur = end;
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  return out;
}
