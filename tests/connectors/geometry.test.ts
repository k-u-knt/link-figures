import { PT_TO_PX } from "../../src/constants";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { flattenPath, pathBounds, pointAtEnd, toSvgPath, type PathData } from "../../src/model/path";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { createRegistries } from "../../src/registry";
import { maxLead, RouteRegistry, type EndPoint } from "../../src/registry/route";
import type { Pt } from "../../src/model/geometry";
import { builtinShapeKinds } from "../../src/shapes/builtin";

const registries = createRegistries();
registries.nodeTypes.register(shapeNodeType);
for (const k of builtinShapeKinds) registries.shapes.register(k);
for (const r of builtinRoutes) registries.routes.register(r);
for (const c of builtinCapKinds) registries.caps.register(c);

const page = createPage("a4-portrait", []);
const shape = (id: string, kind: string, x: number, y: number, width: number, height: number, rotation = 0): Node => ({
  ...shapeNodeDefaults(page, { kind, params: {} }, []),
  id,
  page: page.id,
  x,
  y,
  width,
  height,
  rotation,
});
const docWith = (...nodes: Node[]): Document => ({ ...createDocument("a4-portrait"), pages: [page], nodes });
const free = (x: number, y: number): End => ({ kind: "free", x, y });
const connector = (from: End, to: End, over: Partial<ConnectorNode> = {}): ConnectorNode => ({
  id: "c",
  type: "connector",
  page: page.id,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  z: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  ends: [from, to],
  route: "straight",
  routeParams: {},
  stroke: { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" },
  caps: [
    { kind: "none", size: 3 },
    { kind: "none", size: 3 },
  ],
  ...over,
});
const route = (id: string) => registries.routes.get(id)!;
const allFinite = (p: PathData) => p.every((s) => Object.values(s).every((v) => typeof v === "string" || Number.isFinite(v)));
const finiteResult = (r: ReturnType<typeof resolveConnector>) =>
  allFinite(r.path) && r.caps.every((c) => c === null || allFinite(c)) && Object.values(r.bounds).every(Number.isFinite) && !toSvgPath(r.path).includes("NaN");

test("the built-in routes and caps are registered under their ids", () => {
  expect(builtinRoutes.map((r) => r.id)).toEqual(["straight", "curved", "orthogonal"]);
  expect(builtinCapKinds.map((c) => c.id)).toEqual(["none", "arrow", "openArrow", "circle", "bar"]);
  expect(route("curved").defaults()).toEqual({ bend: 0.25 });
  expect(route("orthogonal").defaults()).toEqual({ offset: 0.5 });
});

test("a straight connector between two free points is one line", () => {
  const r = resolveConnector(docWith(), connector(free(10, 20), free(110, 70)), registries);
  expect(r.path).toEqual([
    { op: "M", x: 10, y: 20 },
    { op: "L", x: 110, y: 70 },
  ]);
  expect(r.ends).toEqual([
    { pt: { x: 10, y: 20 }, dir: null, lead: 0 },
    { pt: { x: 110, y: 70 }, dir: null, lead: 0 },
  ]);
  expect(r.caps).toEqual([null, null]);
  const half = PT_TO_PX / 2;
  expect(r.bounds).toEqual({ x: 10 - half, y: 20 - half, width: 100 + PT_TO_PX, height: 50 + PT_TO_PX });
  expect(r.paintBox).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  expect(r.detached).toEqual([false, false]);
});

test("a curved route offsets its control points perpendicular by bend times the length", () => {
  const p = route("curved").path({ pt: { x: 0, y: 0 }, dir: null, lead: 0 }, { pt: { x: 300, y: 0 }, dir: null, lead: 0 }, { bend: 0.25 });
  expect(p).toEqual([
    { op: "M", x: 0, y: 0 },
    { op: "C", x1: 100, y1: 75, x2: 200, y2: 75, x: 300, y: 0 },
  ]);
});

test("a curved route leaves along an attached end's direction", () => {
  const p = route("curved").path({ pt: { x: 0, y: 0 }, dir: { x: 0, y: -1 }, lead: 0 }, { pt: { x: 300, y: 0 }, dir: null, lead: 0 }, { bend: 0 });
  const c = p[1] as Extract<PathData[number], { op: "C" }>;
  expect(c.x1).toBeCloseTo(0);
  expect(c.y1).toBeCloseTo(-100);
  expect(c.x2).toBeCloseTo(200);
  expect(c.y2).toBeCloseTo(0);
});

test("orthogonal from A's e anchor to B's w anchor leaves horizontally in three segments, the middle at offset", () => {
  const doc = docWith(shape("a", "rect", 0, 0, 100, 50), shape("b", "rect", 300, 100, 100, 50));
  const c = connector({ kind: "attached", node: "a", snap: "anchor", anchor: "e" }, { kind: "attached", node: "b", snap: "anchor", anchor: "w" }, {
    route: "orthogonal",
    routeParams: { offset: 0.25 },
  });
  const r = resolveConnector(doc, c, registries);
  expect(r.ends).toEqual([
    { pt: { x: 100, y: 25 }, dir: { x: 1, y: 0 }, lead: 0 },
    { pt: { x: 300, y: 125 }, dir: { x: -1, y: 0 }, lead: 0 },
  ]);
  expect(r.path).toEqual([
    { op: "M", x: 100, y: 25 },
    { op: "L", x: 150, y: 25 },
    { op: "L", x: 150, y: 125 },
    { op: "L", x: 300, y: 125 },
  ]);
});

test("orthogonal from a rotated item leaves along the rotated normal (Review Focus 5)", () => {
  const doc = docWith(shape("a", "rect", 0, 0, 100, 100, 30));
  const c = connector({ kind: "attached", node: "a", snap: "anchor", anchor: "e" }, free(400, 300), { route: "orthogonal", routeParams: { offset: 0.5 } });
  const r = resolveConnector(doc, c, registries);
  const dir = r.ends[0].dir!;
  expect(dir.x).toBeCloseTo(Math.cos(Math.PI / 6));
  expect(dir.y).toBeCloseTo(Math.sin(Math.PI / 6));
  const start = pointAtEnd(r.path, 0).tangent;
  expect(-start.x).toBeCloseTo(dir.x);
  expect(-start.y).toBeCloseTo(dir.y);
});

test("a centre-snapped end is clipped at a circle's outline toward the other end", () => {
  const doc = docWith(shape("o", "ellipse", 0, 0, 100, 100));
  const r = resolveConnector(doc, connector({ kind: "attached", node: "o", snap: "center" }, free(300, 50)), registries);
  expect(r.ends[0].pt.x).toBeCloseTo(100, 1);
  expect(r.ends[0].pt.y).toBeCloseTo(50, 1);
  expect(r.ends[0].dir).toBeNull();
});

test("a centre-snapped end clips at a rotated item's outline (Review Focus 5)", () => {
  // A 200×20 bar rotated 90° stands upright about its centre (100, 10): its outline crosses y = 10 at x = 90 and 110.
  const doc = docWith(shape("r", "rect", 0, 0, 200, 20, 90));
  const r = resolveConnector(doc, connector({ kind: "attached", node: "r", snap: "center" }, free(300, 10)), registries);
  expect(r.ends[0].pt.x).toBeCloseTo(110, 3);
  expect(r.ends[0].pt.y).toBeCloseTo(10, 3);
});

test("an arrow cap shortens the line by its inset and sits at the end, pointing along the path", () => {
  const c = connector(free(0, 0), free(100, 0), { caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 3 }] });
  const r = resolveConnector(docWith(), c, registries);
  const w = PT_TO_PX;
  const inset = registries.caps.get("arrow")!.inset(3, w);
  expect(inset).toBeGreaterThan(0);
  expect(r.path).toEqual([
    { op: "M", x: 0, y: 0 },
    { op: "L", x: 100 - inset, y: 0 },
  ]);
  const cap = pathBounds(r.caps[1]!);
  expect(cap.x + cap.width).toBeCloseTo(100);
  expect(cap.x).toBeCloseTo(100 - 3 * w);
  expect(r.ends[1].pt).toEqual({ x: 100, y: 0 });
});

test("a start cap points back out of the path's start", () => {
  const c = connector(free(0, 0), free(100, 0), { caps: [{ kind: "arrow", size: 3 }, { kind: "none", size: 3 }] });
  const r = resolveConnector(docWith(), c, registries);
  const cap = pathBounds(r.caps[0]!);
  expect(cap.x).toBeCloseTo(0);
  expect(cap.x + cap.width).toBeCloseTo(3 * PT_TO_PX);
  expect((r.path[0] as { x: number }).x).toBeCloseTo(registries.caps.get("arrow")!.inset(3, PT_TO_PX));
});

test("bounds cover the caps", () => {
  const c = connector(free(0, 0), free(100, 0), {
    stroke: { paint: { type: "solid", color: "#000000" }, width: 2, dash: "solid" },
    caps: [{ kind: "circle", size: 4 }, { kind: "arrow", size: 4 }],
  });
  const r = resolveConnector(docWith(), c, registries);
  const w = 2 * PT_TO_PX;
  const d = 4 * w;
  expect(r.bounds.x).toBeCloseTo(-w / 2);
  expect(r.bounds.width).toBeCloseTo(100 + w);
  expect(r.bounds.y).toBeCloseTo(-d / 2 - w / 2);
  expect(r.bounds.height).toBeCloseTo(d + w);
});

test("every built-in cap draws something finite and insets by a finite amount", () => {
  for (const kind of builtinCapKinds) {
    expect(allFinite(kind.path(3, 2))).toBe(true);
    expect(Number.isFinite(kind.inset(3, 2))).toBe(true);
    expect(allFinite(kind.path(0, 0))).toBe(true);
    expect(Number.isFinite(kind.inset(0, 0))).toBe(true);
  }
});

test("both ends on the same item give finite paths for every route (Review Focus 3)", () => {
  const doc = docWith(shape("a", "ellipse", 0, 0, 100, 100), shape("z", "rect", 50, 50, 0, 0));
  const ends: [End, End][] = [
    [{ kind: "attached", node: "a", snap: "center" }, { kind: "attached", node: "a", snap: "center" }],
    [{ kind: "attached", node: "a", snap: "anchor", anchor: "n" }, { kind: "attached", node: "a", snap: "anchor", anchor: "n" }],
    [{ kind: "attached", node: "a", snap: "anchor", anchor: "n" }, { kind: "attached", node: "a", snap: "center" }],
    [{ kind: "attached", node: "z", snap: "center" }, { kind: "attached", node: "z", snap: "anchor", anchor: "e" }],
  ];
  for (const r of builtinRoutes)
    for (const [a, b] of ends) {
      const res = resolveConnector(doc, connector(a, b, { route: r.id, routeParams: r.defaults(), caps: [{ kind: "arrow", size: 3 }, { kind: "openArrow", size: 3 }] }), registries);
      expect(finiteResult(res)).toBe(true);
    }
});

test("both ends at one point give finite paths for every route and cap (Review Focus 3)", () => {
  for (const r of builtinRoutes)
    for (const cap of builtinCapKinds) {
      const c = connector(free(40, 40), free(40, 40), { route: r.id, routeParams: r.defaults(), caps: [{ kind: cap.id, size: 3 }, { kind: cap.id, size: 3 }] });
      const res = resolveConnector(docWith(), c, registries);
      expect(finiteResult(res)).toBe(true);
    }
});

test("an end whose target is missing is flagged detached and resolves at the other end's point", () => {
  const r = resolveConnector(docWith(), connector({ kind: "attached", node: "gone", snap: "center" }, free(30, 40)), registries);
  expect(r.detached).toEqual([true, false]);
  expect(r.ends[0]).toEqual({ pt: { x: 30, y: 40 }, dir: null, lead: 0 });
  expect(finiteResult(r)).toBe(true);
});

test("an end attached to an item on another page is flagged detached", () => {
  const other = { ...shape("b", "rect", 0, 0, 10, 10), page: "elsewhere" };
  const r = resolveConnector(docWith(other), connector(free(0, 0), { kind: "attached", node: "b", snap: "anchor", anchor: "e" }), registries);
  expect(r.detached).toEqual([false, true]);
  expect(r.ends[1].pt).toEqual({ x: 0, y: 0 });
});

test("two missing targets resolve at the connector's box centre", () => {
  const c = connector({ kind: "attached", node: "x", snap: "center" }, { kind: "attached", node: "y", snap: "center" }, { x: 10, y: 20, width: 40, height: 60 });
  const r = resolveConnector(docWith(), c, registries);
  expect(r.detached).toEqual([true, true]);
  expect(r.ends.map((e) => e.pt)).toEqual([
    { x: 30, y: 50 },
    { x: 30, y: 50 },
  ]);
});

test("an unknown route draws a straight line and an unknown cap draws nothing", () => {
  const c = connector(free(0, 0), free(50, 0), { route: "teleport", caps: [{ kind: "star", size: 3 }, { kind: "none", size: 3 }] });
  const r = resolveConnector(docWith(), c, registries);
  expect(r.path).toEqual([
    { op: "M", x: 0, y: 0 },
    { op: "L", x: 50, y: 0 },
  ]);
  expect(r.caps).toEqual([null, null]);
});

test("an anchor the item no longer has snaps to its centre", () => {
  const doc = docWith(shape("a", "rect", 0, 0, 100, 100));
  const r = resolveConnector(doc, connector({ kind: "attached", node: "a", snap: "anchor", anchor: "nw" }, free(300, 50)), registries);
  expect(r.detached).toEqual([false, false]);
  expect(r.ends[0].pt.x).toBeCloseTo(100);
  expect(r.ends[0].pt.y).toBeCloseTo(50);
});

test("a cap on a curved path is trimmed along the curve", () => {
  const c = connector(free(0, 0), free(300, 0), { route: "curved", routeParams: { bend: 0.25 }, caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 3 }] });
  const r = resolveConnector(docWith(), c, registries);
  const end = pointAtEnd(r.path, 1).pt;
  const inset = registries.caps.get("arrow")!.inset(3, PT_TO_PX);
  expect(Math.hypot(end.x - 300, end.y)).toBeCloseTo(inset, 0);
  expect(r.path[1].op).toBe("C");
});

const w3 = 3 * PT_TO_PX;
const thick = { paint: { type: "solid", color: "#000000" }, width: 3, dash: "solid" as const };

test("a horizontal line's bounds are as tall as its stroke, and a vertical line's paint box as wide", () => {
  const h = resolveConnector(docWith(), connector(free(0, 10), free(100, 10), { stroke: thick }), registries);
  expect(h.bounds.height).toBeCloseTo(w3);
  expect(h.bounds.y).toBeCloseTo(10 - w3 / 2);
  const v = resolveConnector(docWith(), connector(free(10, 0), free(10, 100), { stroke: thick }), registries);
  expect(v.paintBox).toEqual({ x: 10 - w3 / 2, y: 0, width: w3, height: 100 });
});

test("a square line cap widens the bounds by its corner's reach", () => {
  const r = resolveConnector(docWith(), connector(free(0, 0), free(100, 0), { stroke: { ...thick, cap: "square" } }), registries);
  expect(r.bounds.height).toBeCloseTo(w3 * Math.SQRT2);
});

test("orthogonal from a north anchor to a point below leaves upward before turning", () => {
  const p = route("orthogonal").path({ pt: { x: 50, y: 0 }, dir: { x: 0, y: -1 }, lead: 0 }, { pt: { x: 200, y: 100 }, dir: null, lead: 0 }, { offset: 0.5 });
  expect(p).toEqual([
    { op: "M", x: 50, y: 0 },
    { op: "L", x: 50, y: -12 },
    { op: "L", x: 200, y: -12 },
    { op: "L", x: 200, y: 100 },
  ]);
});

test("orthogonal from e to e goes round the far side and enters the second item from outside", () => {
  const p = route("orthogonal").path({ pt: { x: 100, y: 25 }, dir: { x: 1, y: 0 }, lead: 0 }, { pt: { x: 400, y: 125 }, dir: { x: 1, y: 0 }, lead: 0 }, { offset: 0.5 });
  expect(p).toEqual([
    { op: "M", x: 100, y: 25 },
    { op: "L", x: 412, y: 25 },
    { op: "L", x: 412, y: 125 },
    { op: "L", x: 400, y: 125 },
  ]);
  const end = pointAtEnd(p, 1).tangent;
  expect(end).toEqual({ x: -1, y: 0 });
});

test("orthogonal between facing anchors that have crossed takes an S, never doubling back on a normal", () => {
  const p = route("orthogonal").path({ pt: { x: 300, y: 0 }, dir: { x: 1, y: 0 }, lead: 0 }, { pt: { x: 0, y: 200 }, dir: { x: -1, y: 0 }, lead: 0 }, { offset: 0.5 });
  expect(p[1]).toEqual({ op: "L", x: 312, y: 0 });
  expect(p[p.length - 2]).toEqual({ op: "L", x: -12, y: 200 });
});

/** Whether a closed polygon (M, L…, Z) has two non-neighbouring edges that cross. */
function selfIntersects(p: PathData): boolean {
  const pts = p.filter((s): s is { op: "M" | "L"; x: number; y: number } => s.op !== "Z" && s.op !== "C");
  const edges = pts.map((a, i) => [a, pts[(i + 1) % pts.length]] as const);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 2; j < edges.length; j++) {
      if (i === 0 && j === edges.length - 1) continue;
      const [a, b] = edges[i];
      const [c, d] = edges[j];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    }
  return false;
}

test.each([0.5, 1])("every cap at size %s is a sound shape at least as wide as the line, with the line ending inside it", (size) => {
  const w = 2;
  for (const kind of builtinCapKinds.filter((k) => k.id !== "none")) {
    const shape = kind.path(size, w);
    const b = pathBounds(shape);
    expect(b.height).toBeGreaterThanOrEqual(w - 1e-9);
    expect(kind.inset(size, w)).toBeLessThanOrEqual(b.width + 1e-9);
    expect(selfIntersects(shape)).toBe(false);
  }
});

/** The cap's outline as polygon points (the built-in caps tested here are straight-sided). */
const polygon = (p: PathData) => p.filter((s): s is { op: "M" | "L"; x: number; y: number } => s.op === "M" || s.op === "L");

/** Whether `pt` lies inside or on the convex polygon `poly` (either winding), allowing `slack` px. */
function insideConvex(poly: { x: number; y: number }[], pt: { x: number; y: number }, slack = 1e-6): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const side = ((b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x)) / len;
    if (Math.abs(side) <= slack) continue;
    if (sign === 0) sign = Math.sign(side);
    else if (Math.sign(side) !== sign) return false;
  }
  return true;
}

test("an arrow into an e anchor at the end of a U arrives along the normal, with no line beside the head", () => {
  // The review's probe: e to e, 3 pt line, size-4 arrow (inset 16 px) — longer than the route's own 12 px stub.
  const doc = docWith(shape("a", "rect", 0, 0, 100, 50), shape("b", "rect", 300, 100, 100, 50));
  const c = connector({ kind: "attached", node: "a", snap: "anchor", anchor: "e" }, { kind: "attached", node: "b", snap: "anchor", anchor: "e" }, {
    route: "orthogonal",
    stroke: thick,
    caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 4 }],
  });
  const r = resolveConnector(doc, c, registries);
  const inset = registries.caps.get("arrow")!.inset(4, w3);
  expect(inset).toBeGreaterThan(12);
  expect(r.ends[1].lead).toBeCloseTo(inset + 1);
  const tip = r.ends[1].pt;
  expect(tip).toEqual({ x: 400, y: 125 });
  // The head points −x into the e anchor: its tip is its rightmost point and its base is upright, inset px to the right.
  const head = polygon(r.caps[1]!);
  expect(head[0]).toMatchObject({ x: 400, y: 125 });
  expect(head[1].x).toBeCloseTo(400 + inset);
  expect(head[2].x).toBeCloseTo(400 + inset);
  expect(pointAtEnd(r.path, 1).tangent.x).toBeCloseTo(-1);
  expect(pointAtEnd(r.path, 1).tangent.y).toBeCloseTo(0);
  // No part of the 3 pt line lies beside the head: every point of the trimmed line within the head's length of its tip,
  // widened to both edges of the stroke, is inside the head. (Before leads, the line ran down beside it to y ≈ 117.5.)
  for (const line of flattenPath(r.path, 0.01))
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
      for (let k = 0; k <= 50; k++) {
        const x = a.x + ((b.x - a.x) * k) / 50;
        const y = a.y + ((b.y - a.y) * k) / 50;
        if (Math.hypot(x - tip.x, y - tip.y) > inset + 1e-6) continue;
        for (const off of [-w3 / 2, 0, w3 / 2]) expect(insideConvex(head, { x: x + n.x * off, y: y + n.y * off })).toBe(true);
      }
    }
});

test("a curved route keeps its control point at least the end's lead out along the normal", () => {
  const p = route("curved").path({ pt: { x: 0, y: 0 }, dir: { x: 0, y: -1 }, lead: 50 }, { pt: { x: 30, y: 0 }, dir: null, lead: 0 }, { bend: 0 });
  const c = p[1] as Extract<PathData[number], { op: "C" }>;
  expect(c.x1).toBeCloseTo(0);
  expect(c.y1).toBeCloseTo(-50);
});

test("a free end whose arrow reaches round a corner points from where the line stops to the tip", () => {
  // Orthogonal between free points with the middle at 95 %: the last leg is 5 px, shorter than the 16 px inset.
  const c = connector(free(0, 0), free(100, 100), { route: "orthogonal", routeParams: { offset: 0.95 }, stroke: thick, caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 4 }] });
  const r = resolveConnector(docWith(), c, registries);
  const stop = pointAtEnd(r.path, 1).pt;
  const head = polygon(r.caps[1]!);
  const base = { x: (head[1].x + head[2].x) / 2, y: (head[1].y + head[2].y) / 2 };
  const axis = { x: base.x - head[0].x, y: base.y - head[0].y };
  const across = Math.abs((stop.x - head[0].x) * axis.y - (stop.y - head[0].y) * axis.x) / Math.hypot(axis.x, axis.y);
  expect(across).toBeCloseTo(0);
  expect(insideConvex(head, stop)).toBe(true);
});

test("a hairline still has a drawn area and a paint box with no zero dimension", () => {
  const r = resolveConnector(docWith(), connector(free(0, 10), free(100, 10), { stroke: { ...thick, width: 0 } }), registries);
  expect(r.bounds.height).toBeCloseTo(1);
  expect(r.paintBox.height).toBeCloseTo(1);
});

test("a mitred sharp corner widens the bounds by its miter length; a bevelled one does not", () => {
  // A route with a 60° corner at (100, 0): its miter reaches 1/sin(30°) = 2 half-widths, within the limit of 4.
  const kinked = { ...registries, routes: new RouteRegistry() };
  kinked.routes.register({
    id: "kink",
    name: "Kink",
    icon: "",
    defaults: () => ({}),
    fields: () => [],
    path: () => [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: 100, y: 0 },
      { op: "L", x: 100 - 100 * Math.cos(Math.PI / 3), y: 100 * Math.sin(Math.PI / 3) },
    ],
  });
  const sharp = (join?: "miter" | "bevel") =>
    resolveConnector(docWith(), connector(free(0, 0), free(0, 0), { route: "kink", stroke: { ...thick, join } }), kinked);
  expect(sharp().bounds.x + sharp().bounds.width).toBeCloseTo(100 + w3);
  expect(sharp("bevel").bounds.x + sharp("bevel").bounds.width).toBeCloseTo(100 + w3 / 2);
});

test("caps longer than the whole line meet at one point and stay finite", () => {
  const c = connector(free(0, 0), free(5, 0), { stroke: thick, caps: [{ kind: "arrow", size: 4 }, { kind: "arrow", size: 4 }] });
  const r = resolveConnector(docWith(), c, registries);
  expect(finiteResult(r)).toBe(true);
  const a = pointAtEnd(r.path, 0).pt;
  const b = pointAtEnd(r.path, 1).pt;
  expect(a.x).toBeCloseTo(b.x);
  expect(a.x).toBeCloseTo(2.5);
});

/** Every point of the trimmed line (its centre line and both stroke edges) that lies within a cap's inset of its tip is inside that cap. */
function linesClearOfHeads(r: ReturnType<typeof resolveConnector>, w: number, insets: [number, number]): boolean {
  for (const i of [0, 1] as const) {
    if (!r.caps[i]) continue;
    const head = polygon(r.caps[i]!);
    const tip = r.ends[i].pt;
    for (const line of flattenPath(r.path, 0.01))
      for (let j = 1; j < line.length; j++) {
        const [a, b] = [line[j - 1], line[j]];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len === 0) continue;
        const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
        for (let k = 0; k <= 50; k++) {
          const x = a.x + ((b.x - a.x) * k) / 50;
          const y = a.y + ((b.y - a.y) * k) / 50;
          if (Math.hypot(x - tip.x, y - tip.y) > insets[i] - 1e-6) continue;
          for (const off of [-w / 2, 0, w / 2]) if (!insideConvex(head, { x: x + n.x * off, y: y + n.y * off }, 1e-3)) return false;
        }
      }
  }
  return true;
}

const strokes = [
  { stroke: thick, size: 4 },
  { stroke: { ...thick, width: 1 }, size: 3 },
];

describe.each([20, 10, 4])("close facing anchors, gap %s px", (gap) => {
  test.each(strokes.flatMap((s) => [0, 20].map((dy) => ({ ...s, dy }))))("$stroke.width pt, size $size, offset $dy: no doubling back, nothing beside a head, nothing in an item", ({ stroke, size, dy }) => {
    const A = shape("a", "rect", 0, 0, 100, 50);
    const B = shape("b", "rect", 100 + gap, dy, 100, 50);
    const c = connector({ kind: "attached", node: "a", snap: "anchor", anchor: "e" }, { kind: "attached", node: "b", snap: "anchor", anchor: "w" }, {
      route: "orthogonal",
      routeParams: { offset: 0.5 },
      stroke,
      caps: [{ kind: "arrow", size }, { kind: "arrow", size }],
    });
    const r = resolveConnector(docWith(A, B), c, registries);
    expect(finiteResult(r)).toBe(true);
    const w = stroke.width * PT_TO_PX;
    const inset = registries.caps.get("arrow")!.inset(size, w);
    // The route itself never doubles back along the x axis, and neither does the trimmed line.
    const routed = route("orthogonal").path(r.ends[0], r.ends[1], c.routeParams);
    for (const p of [routed, r.path]) {
      const xs = p.filter((s): s is { op: "M" | "L"; x: number; y: number } => s.op !== "Z" && s.op !== "C").map((s) => s.x);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-9);
    }
    expect(linesClearOfHeads(r, w, [inset, inset])).toBe(true);
    // No point of the line is strictly inside either item.
    for (const line of flattenPath(r.path, 0.01))
      for (const pt of line)
        for (const box of [A, B]) {
          const inside = pt.x > box.x + 1e-9 && pt.x < box.x + box.width - 1e-9 && pt.y > box.y + 1e-9 && pt.y < box.y + box.height - 1e-9;
          expect(inside).toBe(false);
        }
  });
});

test.each([0, 0.25])("a short curved connector with a large arrow (bend %s) stops on the head's axis with nothing beside it", (bend) => {
  // The review's probe: A's e anchor (100, 25) to B's n anchor (170, 30), 3 pt, size 4.
  const doc = docWith(shape("a", "rect", 0, 0, 100, 50), shape("b", "rect", 120, 30, 100, 50));
  const c = connector({ kind: "attached", node: "a", snap: "anchor", anchor: "e" }, { kind: "attached", node: "b", snap: "anchor", anchor: "n" }, {
    route: "curved",
    routeParams: { bend },
    stroke: thick,
    caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 4 }],
  });
  const r = resolveConnector(doc, c, registries);
  const inset = registries.caps.get("arrow")!.inset(4, w3);
  const tip = r.ends[1].pt;
  expect(tip).toEqual({ x: 170, y: 30 });
  const head = polygon(r.caps[1]!);
  const base = { x: (head[1].x + head[2].x) / 2, y: (head[1].y + head[2].y) / 2 };
  const axis = { x: base.x - tip.x, y: base.y - tip.y };
  const stop = pointAtEnd(r.path, 1).pt;
  const across = Math.abs((stop.x - tip.x) * axis.y - (stop.y - tip.y) * axis.x) / Math.hypot(axis.x, axis.y);
  expect(across).toBeLessThan(0.01);
  expect(Math.hypot(stop.x - tip.x, stop.y - tip.y)).toBeCloseTo(inset, 6);
  expect(linesClearOfHeads(r, w3, [0, inset])).toBe(true);
});

/** The points of a path of moves and lines, rounded to 6 decimals. */
const linePoints = (p: PathData): [number, number][] =>
  p.filter((s): s is { op: "M" | "L"; x: number; y: number } => s.op === "M" || s.op === "L").map((s) => [+s.x.toFixed(6), +s.y.toFixed(6)]);

/** Whether the path's first leg leaves along `a`'s direction and its last leg arrives against `b`'s (neither doubles back). */
function neverDoublesBack(p: PathData, a: { pt: Pt; dir: Pt | null }, b: { pt: Pt; dir: Pt | null }): boolean {
  const pts = linePoints(p);
  const legs: [typeof a, [number, number], [number, number] | undefined][] = [
    [a, pts[0], pts.find(([x, y]) => x !== pts[0][0] || y !== pts[0][1])],
    [b, pts[pts.length - 1], [...pts].reverse().find(([x, y]) => x !== pts[pts.length - 1][0] || y !== pts[pts.length - 1][1])],
  ];
  return legs.every(([e, from, to]) => !e.dir || !to || (to[0] - from[0]) * e.dir.x + (to[1] - from[1]) * e.dir.y >= -1e-6);
}

const anchored = (node: string, anchor: string): End => ({ kind: "attached", node, snap: "anchor", anchor });

describe("orthogonal stubs are capped per end, only when the other end genuinely lies ahead", () => {
  // A = (0, 0, 100, 50), 1 pt line, size-3 arrows at both ends (inset 4 px), offset 0.5.
  const thin = { ...thick, width: 1 };
  const resolve = (bx: number, by: number, from: string, to: string, rotation = 0, offset = 0.5) => {
    const doc = docWith(shape("a", "rect", 0, 0, 100, 50), shape("b", "rect", bx, by, 100, 50, rotation));
    const c = connector(anchored("a", from), anchored("b", to), {
      route: "orthogonal",
      routeParams: { offset },
      stroke: thin,
      caps: [{ kind: "arrow", size: 3 }, { kind: "arrow", size: 3 }],
    });
    return resolveConnector(doc, c, registries);
  };

  test.each([
    ["B to the right, a little lower, n → n", 140, 8, "n", "n", [[50, -4], [50, -12], [190, -12], [190, 4]]],
    ["B to the left, a little lower, n → n", -130, 8, "n", "n", [[50, -4], [50, -12], [-80, -12], [-80, 4]]],
    ["B to the left, e → s", -130, -30, "e", "s", [[104, 25], [112, 25], [112, 32], [-80, 32], [-80, 24]]],
    ["B to the left, n → w", -130, -30, "n", "w", [[50, -4], [50, -12], [-142, -12], [-142, -5], [-134, -5]]],
  ] as const)("%s: both stubs are kept in full", (_name, bx, by, from, to, expected) => {
    const r = resolve(bx, by, from, to);
    expect(linePoints(r.path)).toEqual(expected);
    expect(neverDoublesBack(route("orthogonal").path(r.ends[0], r.ends[1], { offset: 0.5 }), r.ends[0], r.ends[1])).toBe(true);
  });

  test("a rotated item's slanted stub keeps the line clear of the head at offsets 0 and 1", () => {
    for (const offset of [0, 1]) {
      const doc = docWith(shape("a", "rect", 0, 0, 100, 50), shape("b", "rect", 110, -10, 100, 50, 30));
      const c = connector(anchored("a", "e"), anchored("b", "w"), {
        route: "orthogonal",
        routeParams: { offset },
        stroke: thick,
        caps: [{ kind: "arrow", size: 4 }, { kind: "arrow", size: 4 }],
      });
      const r = resolveConnector(doc, c, registries);
      const inset = registries.caps.get("arrow")!.inset(4, w3);
      expect(finiteResult(r)).toBe(true);
      expect(linesClearOfHeads(r, w3, [inset, inset])).toBe(true);
      expect(neverDoublesBack(route("orthogonal").path(r.ends[0], r.ends[1], { offset }), r.ends[0], r.ends[1])).toBe(true);
    }
  });

  test("facing stubs across a 20 px gap still meet half way, on one row and offset by a row", () => {
    expect(linePoints(resolve(120, 0, "e", "w").path)).toEqual([[104, 25], [116, 25]]);
    expect(linePoints(resolve(120, 20, "e", "w").path)).toEqual([[104, 25], [110, 25], [110, 45], [116, 45]]);
  });

  // A small grid: every anchor pair, three offsets, B at positions on every side of A, including ones a little above
  // or below A's row, where a stub used to be cut short and the plain elbow doubled back through the items.
  const grid = [-130, 0, 110, 140].flatMap((bx) => [-70, -10, 8, 60].map((by) => [bx, by] as const)).filter(([bx, by]) => Math.abs(bx) >= 100 || Math.abs(by) >= 50);
  const anchors = ["n", "e", "s", "w"] as const;
  test.each([0, 0.5, 1])("offset %s: across the grid, no route doubles back and no line runs beside a head", (offset) => {
    const inset = registries.caps.get("arrow")!.inset(3, PT_TO_PX);
    let checked = 0;
    for (const [bx, by] of grid)
      for (const from of anchors)
        for (const to of anchors) {
          const r = resolve(bx, by, from, to, 0, offset);
          const tag = `B@${bx},${by} ${from}->${to}`;
          expect(finiteResult(r), tag).toBe(true);
          const routed = route("orthogonal").path(r.ends[0], r.ends[1], { offset });
          expect(neverDoublesBack(routed, r.ends[0], r.ends[1]), tag).toBe(true);
          expect(linesClearOfHeads(r, PT_TO_PX, [inset, inset]), tag).toBe(true);
          checked++;
        }
    expect(checked).toBe(14 * 16);
  });
});

describe("maxLead", () => {
  const end = (x: number, y: number, dir: Pt | null): EndPoint => ({ pt: { x, y }, dir, lead: 0 });
  const right = { x: 1, y: 0 };
  const left = { x: -1, y: 0 };
  const up = { x: 0, y: -1 };

  test("ends facing each other: half the way, however far apart sideways", () => {
    expect(maxLead(end(100, 25, right), end(120, 25, left))).toBe(10);
    expect(maxLead(end(100, 25, right), end(120, 200, left))).toBe(10);
    expect(maxLead(end(120, 200, left), end(100, 25, right))).toBe(10);
  });

  test("ends facing the same way, or one behind the other: no limit", () => {
    expect(maxLead(end(190, 8, up), end(50, 0, up))).toBe(Infinity);
    expect(maxLead(end(50, 0, up), end(190, 8, up))).toBe(Infinity);
    expect(maxLead(end(100, 25, right), end(-30, 25, left))).toBe(Infinity);
  });

  test("ends looking into one quadrant: half the way; one ahead by a little but far to the side: no limit", () => {
    // A's e at (100, 25) and B's n at (140, 40): each is ahead of the other and no further beside it than that.
    expect(maxLead(end(140, 40, up), end(100, 25, right))).toBe(7.5);
    expect(maxLead(end(100, 25, right), end(140, 40, up))).toBe(20);
    // B's s at (-80, 20) with A's e at (100, 25): A is 5 ahead but 180 to the side, and B is behind A.
    expect(maxLead(end(-80, 20, { x: 0, y: 1 }), end(100, 25, right))).toBe(Infinity);
  });

  test("a free other end: half the way when no further to the side than ahead", () => {
    expect(maxLead(end(50, 0, up), end(50, -5, null))).toBe(2.5);
    expect(maxLead(end(50, 0, up), end(200, -5, null))).toBe(Infinity);
    expect(maxLead(end(50, 0, null), end(50, -5, null))).toBe(0);
  });
});

test("a cubic that passes quickly through the end's inset circle is cut there, not where a coarse sample would first notice", () => {
  // From (0, 0) to (300, 0), swinging far out and back through the tip near t ≈ 0.62: 64 even samples all miss the
  // 4 px circle round the tip, so a sampled search would trim only at the very end and leave a loop through the head.
  const dip = { ...registries, routes: new RouteRegistry() };
  dip.routes.register({
    id: "dip",
    name: "Dip",
    icon: "",
    defaults: () => ({}),
    fields: () => [],
    path: () => [
      { op: "M", x: 0, y: 0 },
      { op: "C", x1: -600, y1: -800, x2: 900, y2: 500, x: 300, y: 0 },
    ],
  });
  const c = connector(free(0, 0), free(300, 0), { route: "dip", stroke: { ...thick, width: 1 }, caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 3 }] });
  const inset = registries.caps.get("arrow")!.inset(3, PT_TO_PX);
  expect(inset).toBe(4);
  const at = (t: number): Pt => {
    const u = 1 - t;
    return { x: 3 * u * u * t * -600 + 3 * u * t * t * 900 + t * t * t * 300, y: 3 * u * u * t * -800 + 3 * u * t * t * 500 };
  };
  for (let i = 1; i < 64; i++) expect(Math.hypot(at(i / 64).x - 300, at(i / 64).y)).toBeGreaterThan(inset + 1);
  const r = resolveConnector(docWith(), c, dip);
  expect(finiteResult(r)).toBe(true);
  const stop = pointAtEnd(r.path, 1).pt;
  expect(Math.hypot(stop.x - 300, stop.y)).toBeCloseTo(inset, 6);
  expect(stop.x).toBeLessThan(299);
  for (const line of flattenPath(r.path, 0.01)) for (const pt of line) expect(Math.hypot(pt.x - 300, pt.y)).toBeGreaterThanOrEqual(inset - 1e-3);
});

describe("a curve's bend with attached ends", () => {
  const curved = route("curved");
  const a: EndPoint = { pt: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, lead: 0 };
  const b: EndPoint = { pt: { x: 200, y: 100 }, dir: { x: -1, y: 0 }, lead: 0 };
  const handleAt = (x: EndPoint, y: EndPoint, bend: number): Pt => curved.handles!(x, y, { bend })[0].pt;
  // Signed distance to the right of the chord a→b as the page shows it.
  const sideOf = (pt: Pt): number => ((pt.x - a.pt.x) * -(b.pt.y - a.pt.y) + (pt.y - a.pt.y) * (b.pt.x - a.pt.x)) / Math.hypot(200, 100);

  test("bends of 0.3 and −0.3 put the curve's middle more than 10 px apart, on opposite sides of the chord", () => {
    const plus = handleAt(a, b, 0.3);
    const minus = handleAt(a, b, -0.3);
    expect(Math.hypot(plus.x - minus.x, plus.y - minus.y)).toBeGreaterThan(10);
    expect(Math.sign(sideOf(plus))).toBe(-Math.sign(sideOf(minus)));
    expect(sideOf(plus)).toBeGreaterThan(0);
  });

  test.each([0.4, -0.6])("dragging the handle to where bend %s puts it gives that bend back", (bend) => {
    const got = curved.dragHandle!("bend", handleAt(a, b, bend), a, b, {}) as { bend: number };
    expect(Math.abs(got.bend - bend)).toBeLessThanOrEqual(0.002);
  });

  test.each([0.4, -0.6])("with one end free, dragging to where bend %s puts the handle gives that bend back", (bend) => {
    const free: EndPoint = { ...b, dir: null };
    const got = curved.dragHandle!("bend", handleAt(a, free, bend), a, free, {}) as { bend: number };
    expect(Math.abs(got.bend - bend)).toBeLessThanOrEqual(0.002);
  });
});
