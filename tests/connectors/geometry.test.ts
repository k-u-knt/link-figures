import { PT_TO_PX } from "../../src/constants";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { pathBounds, pointAtEnd, toSvgPath, type PathData } from "../../src/model/path";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { createRegistries } from "../../src/registry";
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
    { pt: { x: 10, y: 20 }, dir: null },
    { pt: { x: 110, y: 70 }, dir: null },
  ]);
  expect(r.caps).toEqual([null, null]);
  expect(r.bounds).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  expect(r.detached).toEqual([false, false]);
});

test("a curved route offsets its control points perpendicular by bend times the length", () => {
  const p = route("curved").path({ pt: { x: 0, y: 0 }, dir: null }, { pt: { x: 300, y: 0 }, dir: null }, { bend: 0.25 });
  expect(p).toEqual([
    { op: "M", x: 0, y: 0 },
    { op: "C", x1: 100, y1: 75, x2: 200, y2: 75, x: 300, y: 0 },
  ]);
});

test("a curved route leaves along an attached end's direction", () => {
  const p = route("curved").path({ pt: { x: 0, y: 0 }, dir: { x: 0, y: -1 } }, { pt: { x: 300, y: 0 }, dir: null }, { bend: 0 });
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
    { pt: { x: 100, y: 25 }, dir: { x: 1, y: 0 } },
    { pt: { x: 300, y: 125 }, dir: { x: -1, y: 0 } },
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
  const d = 4 * 2 * PT_TO_PX;
  expect(r.bounds.x).toBeCloseTo(0);
  expect(r.bounds.width).toBeCloseTo(100);
  expect(r.bounds.y).toBeLessThan(-d / 3 + 1e-9);
  expect(r.bounds.height).toBeCloseTo(d);
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
  expect(r.ends[0]).toEqual({ pt: { x: 30, y: 40 }, dir: null });
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
