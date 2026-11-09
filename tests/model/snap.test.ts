import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { connectorNodeDefaults, createDocument, createPage, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { mmToPx, pageSizePx } from "../../src/model/geometry";
import { builtinSnapSources, snapEdges, snapMove } from "../../src/model/snap";
import type { Document, Node } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { SnapLine } from "../../src/registry/snap";
import { builtinShapeKinds } from "../../src/shapes/builtin";

const line = (pos: number, kind: SnapLine["kind"] = "item", source = "t"): SnapLine => ({ pos, from: 0, to: 10, kind, source });
const none = { x: [] as SnapLine[], y: [] as SnapLine[] };
const rect = (x: number, y: number, width = 10, height = 10) => ({ x, y, width, height });

describe("snapMove", () => {
  test("snaps a feature within reach and gives one guide", () => {
    const r = snapMove({ ...none, x: [line(100)] }, rect(97, 0, 200), 6);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0);
    expect(r.guides).toHaveLength(1);
  });
  test("nothing snaps beyond reach", () => {
    const r = snapMove({ ...none, x: [line(100)] }, rect(97, 0, 200), 2);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });
  test("the nearest candidate wins across left, centre and right", () => {
    // left 97 → 100 is 3 away; right 107 → 108 is 1 away.
    const r = snapMove({ ...none, x: [line(100), line(108)] }, rect(97, 0), 6);
    expect(r.dx).toBe(1);
    expect(r.guides.map((g) => g.pos)).toEqual([108]);
  });
  test("ties go to page and margin lines before items, then the first found", () => {
    const a = snapMove({ ...none, x: [line(98, "item"), line(96, "page")] }, rect(97, 0), 6);
    expect(a.dx).toBe(-1);
    const b = snapMove({ ...none, x: [line(98, "item", "first"), line(96, "item", "second")] }, rect(97, 0), 6);
    expect(b.guides[0].source).toBe("first");
    const c = snapMove({ ...none, x: [line(98, "item"), line(96, "margin")] }, rect(97, 0), 6);
    expect(c.guides[0].kind).toBe("margin");
  });
  test("lines at the winning position all show as guides", () => {
    const r = snapMove({ ...none, x: [line(100, "item", "a"), line(100, "item", "b"), line(103)] }, rect(98, 0, 200), 6);
    expect(r.guides.map((g) => g.source)).toEqual(["a", "b"]);
  });
  test("x and y snap independently", () => {
    const r = snapMove({ x: [line(100)], y: [line(50)] }, rect(98, 200, 200, 200), 6);
    expect(r.dx).toBe(2);
    expect(r.dy).toBe(0);
    expect(r.guides).toHaveLength(1);
    const both = snapMove({ x: [line(100)], y: [line(203)] }, rect(98, 200, 200, 200), 6);
    expect(both).toMatchObject({ dx: 2, dy: 3 });
    expect(both.guides).toHaveLength(2);
  });
  test("the centre feature snaps too", () => {
    const r = snapMove({ ...none, x: [line(105)] }, rect(97, 0, 10, 10), 6);
    // left 97 (8), centre 102 (3), right 107 (2): right wins.
    expect(r.dx).toBe(-2);
    const c = snapMove({ ...none, x: [line(103)] }, rect(97, 0, 10, 10), 0.5);
    expect(c.dx).toBe(0);
    expect(snapMove({ ...none, x: [line(103)] }, rect(97, 0, 10, 10), 2).dx).toBe(1);
  });
});

describe("snapEdges", () => {
  test("only the given moving edge snaps, and the opposite edge stays", () => {
    const r = snapEdges({ x: [line(52), line(100)], y: [] }, rect(50, 0, 47, 10), { right: true }, 6);
    expect(r.rect).toEqual({ x: 50, y: 0, width: 50, height: 10 });
    expect(r.guides.map((g) => g.pos)).toEqual([100]);
  });
  test("a left edge moves x and keeps the right edge", () => {
    const r = snapEdges({ x: [line(40)], y: [] }, rect(43, 5, 20, 10), { left: true }, 6);
    expect(r.rect).toEqual({ x: 40, y: 5, width: 23, height: 10 });
  });
  test("top and bottom snap on y; unlisted edges are untouched", () => {
    const r = snapEdges({ x: [line(1)], y: [line(30)] }, rect(0, 28, 10, 10), { top: true }, 6);
    expect(r.rect).toEqual({ x: 0, y: 30, width: 10, height: 8 });
  });
  test("a snap that would shrink the rect below the minimum is refused", () => {
    // The right edge at 50 + 20 = 70 would snap to 51, leaving width 1, under MIN_NODE_PX.
    const r = snapEdges({ x: [line(51)], y: [] }, rect(50, 0, 20, 10), { right: true }, 30);
    expect(r).toEqual({ rect: rect(50, 0, 20, 10), guides: [] });
    const l = snapEdges({ x: [line(69)], y: [] }, rect(50, 0, 20, 10), { left: true }, 30);
    expect(l.rect).toEqual(rect(50, 0, 20, 10));
  });
  test("out of reach leaves the rect", () => {
    const r = snapEdges({ x: [line(100)], y: [] }, rect(50, 0, 20, 10), { right: true }, 6);
    expect(r).toEqual({ rect: rect(50, 0, 20, 10), guides: [] });
  });
});

describe("builtin sources", () => {
  const page = { ...createPage("a4-portrait", []), margins: { top: 10, right: 20, bottom: 30, left: 15 } };
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(groupNodeType);
  r.nodeTypes.register(connectorNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  const box = (id: string, x: number, y: number, w: number, h: number, parent?: string): Node => ({ ...shapeNodeDefaults(page, { id, x, y, width: w, height: h }, []), ...(parent ? { parent } : {}) });
  const doc: Document = {
    ...createDocument("a4-portrait"),
    pages: [page],
    nodes: [box("a", 10, 20, 30, 40, "g"), box("b", 100, 200, 50, 60, "g"), groupNodeDefaults(page, { id: "g" }, []), box("c", 300, 400, 10, 10)],
  };
  const source = (id: string) => builtinSnapSources.find((s) => s.id === id)!;

  test("items: each unit's visual left/centre/right and top/middle/bottom", () => {
    const { x, y } = source("items").lines(doc, page, new Set(), r);
    const c = x.filter((l) => l.source === "c").filter((l) => [300, 305, 310].includes(l.pos));
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ kind: "item", from: 400, to: 410 });
    expect(y.filter((l) => [400, 405, 410].includes(l.pos))).toHaveLength(3);
    expect(y.find((l) => l.pos === 405)).toMatchObject({ from: 300, to: 310 });
    // The group is one unit (10..150); its members are not separate items.
    expect(x.some((l) => l.pos === 40)).toBe(false);
    expect(x.some((l) => l.pos === 10)).toBe(true);
    expect(x.some((l) => l.pos === 150)).toBe(true);
  });
  test("items: excluded units and their descendants give no lines", () => {
    const { x } = source("items").lines(doc, page, new Set(["g", "a", "b"]), r);
    expect(x.map((l) => l.pos).sort((p, q) => p - q)).toEqual([300, 305, 310]);
  });
  test("items: a member excluded alone gives no lines from its group, but its sibling and others do", () => {
    const { x } = source("items").lines(doc, page, new Set(["a"]), r);
    expect(x.some((l) => l.source === "g")).toBe(false);
    expect(x.some((l) => l.source === "a")).toBe(false);
    expect(x.filter((l) => l.source === "b").map((l) => l.pos)).toEqual([100, 125, 150]);
    expect(x.filter((l) => l.source === "c")).toHaveLength(3);
  });
  test("items: excluding only the group gives no lines from its members", () => {
    const { x } = source("items").lines(doc, page, new Set(["g"]), r);
    expect(x.some((l) => ["a", "b", "g"].includes(l.source))).toBe(false);
    expect(x.filter((l) => l.source === "c")).toHaveLength(3);
  });
  test("items: a connector attached to an excluded item gives no lines", () => {
    const withLine: Document = {
      ...doc,
      nodes: [...doc.nodes, connectorNodeDefaults(page, { id: "k", ends: [{ kind: "attached", node: "c", snap: "center" }, { kind: "free", x: 500, y: 500 }] }, [])],
    };
    expect(source("items").lines(withLine, page, new Set(["c"]), r).x.some((l) => l.source === "k")).toBe(false);
    expect(source("items").lines(withLine, page, new Set(), r).x.some((l) => l.source === "k")).toBe(true);
  });
  test("page: edges and centre lines", () => {
    const { w, h } = { w: pageSizePx(page).width, h: pageSizePx(page).height };
    const { x, y } = source("page").lines(doc, page, new Set(), r);
    expect(x.map((l) => l.pos)).toEqual([0, w / 2, w]);
    expect(y.map((l) => l.pos)).toEqual([0, h / 2, h]);
    expect(x.every((l) => l.kind === "page")).toBe(true);
  });
  test("margins: the margin box's edges from mm", () => {
    const { width, height } = pageSizePx(page);
    const { x, y } = source("margins").lines(doc, page, new Set(), r);
    expect(x.map((l) => l.pos)).toEqual([mmToPx(15), width - mmToPx(20)]);
    expect(y.map((l) => l.pos)).toEqual([mmToPx(10), height - mmToPx(30)]);
    expect(x.every((l) => l.kind === "margin")).toBe(true);
  });
});
