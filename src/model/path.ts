import type { Pt, Rect } from "./geometry";

/** A 2D affine matrix [a b c d e f], mapping (x, y) to (a·x + c·y + e, b·x + d·y + f); the same layout PDF and SVG use. */
export type Matrix = [number, number, number, number, number, number];

/** `a` then `b`: the matrix a PDF writes as a × b. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** The point (x, y) mapped through `m`. */
export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** One path segment: move, line, cubic Bézier (control points 1 and 2, then the end point), or close back to the subpath start. */
export type Seg =
  | { op: "M" | "L"; x: number; y: number }
  | { op: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: "Z" };

/** A path as absolute segments in one coordinate space. Pure data: no DOM, no rounding. */
export type PathData = Seg[];

/** An SVG `d` attribute for the path; numbers are written as they are, unrounded, like the SVG builder does. */
export function toSvgPath(p: PathData): string {
  return p
    .map((s) => {
      if (s.op === "Z") return "Z";
      if (s.op === "C") return `C${s.x1} ${s.y1} ${s.x2} ${s.y2} ${s.x} ${s.y}`;
      return `${s.op}${s.x} ${s.y}`;
    })
    .join(" ");
}

/** The path with every point mapped through `m`. */
export function transformPath(p: PathData, m: Matrix): PathData {
  return p.map((s): Seg => {
    if (s.op === "Z") return s;
    if (s.op === "C") {
      const [x1, y1] = applyMatrix(m, s.x1, s.y1);
      const [x2, y2] = applyMatrix(m, s.x2, s.y2);
      const [x, y] = applyMatrix(m, s.x, s.y);
      return { op: "C", x1, y1, x2, y2, x, y };
    }
    const [x, y] = applyMatrix(m, s.x, s.y);
    return { op: s.op, x, y };
  });
}

/** A drawn piece of a path with its end points resolved: a line or a cubic. */
type Piece = { kind: "L"; a: Pt; b: Pt } | { kind: "C"; a: Pt; c1: Pt; c2: Pt; b: Pt };

/** The drawn pieces of each subpath, with `Z` as a closing line; a lone move gives a subpath with no pieces. */
function subpathPieces(p: PathData): { start: Pt; pieces: Piece[]; closed: boolean }[] {
  const out: { start: Pt; pieces: Piece[]; closed: boolean }[] = [];
  let cur: { start: Pt; pieces: Piece[]; closed: boolean } | null = null;
  let at: Pt = { x: 0, y: 0 };
  for (const s of p) {
    if (s.op === "M") {
      at = { x: s.x, y: s.y };
      cur = { start: at, pieces: [], closed: false };
      out.push(cur);
      continue;
    }
    if (!cur) {
      cur = { start: at, pieces: [], closed: false };
      out.push(cur);
    }
    if (s.op === "Z") {
      cur.pieces.push({ kind: "L", a: at, b: cur.start });
      at = cur.start;
      cur.closed = true;
      cur = null;
    } else if (s.op === "C") {
      const b = { x: s.x, y: s.y };
      cur.pieces.push({ kind: "C", a: at, c1: { x: s.x1, y: s.y1 }, c2: { x: s.x2, y: s.y2 }, b });
      at = b;
    } else {
      const b = { x: s.x, y: s.y };
      cur.pieces.push({ kind: "L", a: at, b });
      at = b;
    }
  }
  return out;
}

/** The roots in (0, 1) of the derivative of one coordinate of a cubic with the given four control values. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const q = Math.sqrt(disc);
      roots.push((-b + q) / (2 * a), (-b - q) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

function cubicAt(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

/** The exact bounding rectangle: cubics contribute their curve's extrema, not their control-point hull. An empty path gives a zero rect at the origin. */
export function pathBounds(p: PathData): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const sub of subpathPieces(p)) {
    add(sub.start.x, sub.start.y);
    for (const pc of sub.pieces) {
      add(pc.b.x, pc.b.y);
      if (pc.kind === "C") {
        for (const t of cubicExtrema(pc.a.x, pc.c1.x, pc.c2.x, pc.b.x)) add(cubicAt(pc.a.x, pc.c1.x, pc.c2.x, pc.b.x, t), cubicAt(pc.a.y, pc.c1.y, pc.c2.y, pc.b.y, t));
        for (const t of cubicExtrema(pc.a.y, pc.c1.y, pc.c2.y, pc.b.y)) add(cubicAt(pc.a.x, pc.c1.x, pc.c2.x, pc.b.x, t), cubicAt(pc.a.y, pc.c1.y, pc.c2.y, pc.b.y, t));
      }
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Subpaths as polylines, each cubic cut into straight pieces that stay within `tolerance` of the curve; a closed subpath ends on its start point. */
export function flattenPath(p: PathData, tolerance: number): Pt[][] {
  const tol = tolerance > 0 ? tolerance : 1e-6;
  const out: Pt[][] = [];
  for (const sub of subpathPieces(p)) {
    const line: Pt[] = [sub.start];
    for (const pc of sub.pieces) {
      if (pc.kind === "L") {
        line.push(pc.b);
        continue;
      }
      // The deviation of a cubic from its chord pieces is bounded by 3/4 of its largest second difference over n².
      const dd = Math.max(
        Math.hypot(pc.a.x - 2 * pc.c1.x + pc.c2.x, pc.a.y - 2 * pc.c1.y + pc.c2.y),
        Math.hypot(pc.c1.x - 2 * pc.c2.x + pc.b.x, pc.c1.y - 2 * pc.c2.y + pc.b.y),
      );
      const n = Math.min(500, Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / tol))));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        line.push(i === n ? pc.b : { x: cubicAt(pc.a.x, pc.c1.x, pc.c2.x, pc.b.x, t), y: cubicAt(pc.a.y, pc.c1.y, pc.c2.y, pc.b.y, t) });
      }
    }
    out.push(line);
  }
  return out;
}

function distanceToSegment(pt: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

/** The distance from `pt` to the nearest point on the path's outline (to within a hundredth of a unit on curves); Infinity for an empty path. */
export function distanceToPath(p: PathData, pt: Pt): number {
  let best = Infinity;
  for (const line of flattenPath(p, 0.01)) {
    if (line.length === 1) best = Math.min(best, Math.hypot(pt.x - line[0].x, pt.y - line[0].y));
    for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(pt, line[i - 1], line[i]));
  }
  return best;
}

function unit(dx: number, dy: number): Pt | null {
  const len = Math.hypot(dx, dy);
  return len > 1e-12 ? { x: dx / len, y: dy / len } : null;
}

/** The direction a piece is travelling at its end (`atEnd`) or its start, or null when it has no length. */
function pieceDirection(pc: Piece, atEnd: boolean): Pt | null {
  if (pc.kind === "L") return unit(pc.b.x - pc.a.x, pc.b.y - pc.a.y);
  const pts = atEnd ? [pc.b, pc.c2, pc.c1, pc.a] : [pc.a, pc.c1, pc.c2, pc.b];
  for (let i = 1; i < 4; i++) {
    const d = atEnd ? unit(pts[0].x - pts[i].x, pts[0].y - pts[i].y) : unit(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d) return d;
  }
  return null;
}

/**
 * Where the path starts (`which` 0) or ends (1), and the unit tangent there pointing out of the path: backwards along the
 * first piece at the start, onwards along the last at the end. A closing `Z` counts as the last piece. Zero-length pieces
 * are skipped for the tangent; when nothing has length it is (1, 0), so the result is always finite.
 */
export function pointAtEnd(p: PathData, which: 0 | 1): { pt: Pt; tangent: Pt } {
  const subs = subpathPieces(p);
  if (subs.length === 0) return { pt: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
  if (which === 0) {
    const first = subs[0];
    for (const pc of first.pieces) {
      const d = pieceDirection(pc, false);
      if (d) return { pt: first.start, tangent: { x: -d.x || 0, y: -d.y || 0 } };
    }
    return { pt: first.start, tangent: { x: 1, y: 0 } };
  }
  const last = subs[subs.length - 1];
  const end = last.pieces.length ? last.pieces[last.pieces.length - 1].b : last.start;
  for (let i = last.pieces.length - 1; i >= 0; i--) {
    const d = pieceDirection(last.pieces[i], true);
    if (d) return { pt: end, tangent: d };
  }
  return { pt: end, tangent: { x: 1, y: 0 } };
}

/** The cubic control constant for a quarter circle. */
const KAPPA = 0.5522847498307936;

/** A rectangle, with corners rounded by `radius` (clamped to half the short side, never negative); clockwise from the top-left. */
export function rectPath(r: Rect, radius: number): PathData {
  const { x, y, width: w, height: h } = r;
  const k = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  if (k === 0) return [{ op: "M", x, y }, { op: "L", x: x + w, y }, { op: "L", x: x + w, y: y + h }, { op: "L", x, y: y + h }, { op: "Z" }];
  const c = k * KAPPA;
  const r2 = x + w;
  const b2 = y + h;
  return [
    { op: "M", x: x + k, y },
    { op: "L", x: r2 - k, y },
    { op: "C", x1: r2 - k + c, y1: y, x2: r2, y2: y + k - c, x: r2, y: y + k },
    { op: "L", x: r2, y: b2 - k },
    { op: "C", x1: r2, y1: b2 - k + c, x2: r2 - k + c, y2: b2, x: r2 - k, y: b2 },
    { op: "L", x: x + k, y: b2 },
    { op: "C", x1: x + k - c, y1: b2, x2: x, y2: b2 - k + c, x, y: b2 - k },
    { op: "L", x, y: y + k },
    { op: "C", x1: x, y1: y + k - c, x2: x + k - c, y2: y, x: x + k, y },
    { op: "Z" },
  ];
}

/** The ellipse inscribed in the rectangle, as four cubics from its rightmost point, clockwise. */
export function ellipsePath(r: Rect): PathData {
  const rx = r.width / 2;
  const ry = r.height / 2;
  const cx = r.x + rx;
  const cy = r.y + ry;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { op: "M", x: cx + rx, y: cy },
    { op: "C", x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { op: "C", x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { op: "C", x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { op: "C", x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { op: "Z" },
  ];
}

/** The crossing of the segment from→to with the outline that lies nearest `to` (the last one met going from `from`), or null when they do not cross. */
export function clipToOutline(from: Pt, to: Pt, outline: PathData): Pt | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let bestT = -Infinity;
  for (const line of flattenPath(outline, 0.01)) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const ex = line[i].x - a.x;
      const ey = line[i].y - a.y;
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-12) continue;
      const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / denom;
      const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / denom;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t > bestT) bestT = t;
    }
  }
  return bestT === -Infinity ? null : { x: from.x + bestT * dx, y: from.y + bestT * dy };
}
