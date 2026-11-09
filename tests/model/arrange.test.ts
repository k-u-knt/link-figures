import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { alignOffsets, distributeOffsets, referenceRect, visualBounds } from "../../src/model/arrange";
import { connectorNodeDefaults, createDocument, createPage, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { mmToPx, pageSizePx } from "../../src/model/geometry";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import { builtinShapeKinds } from "../../src/shapes/builtin";

function registries() {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  return r;
}

const r = registries();
const page = { ...createPage("a4-portrait", []), margins: { top: 10, right: 20, bottom: 30, left: 15 } };
const box = (id: string, x: number, y: number, width: number, height: number, extra: { parent?: string; rotation?: number } = {}): Node => ({
  ...shapeNodeDefaults(page, { id, x, y, width, height }, []),
  ...extra,
});
const make = (nodes: Node[]): Document => ({ ...createDocument("a4-portrait"), pages: [page], nodes });

describe("visualBounds", () => {
  test("a 100×50 box at 0,0 rotated 90° is its turned AABB", () => {
    const doc = make([box("a", 0, 0, 100, 50, { rotation: 90 })]);
    expect(visualBounds(doc, "a", r)).toEqual({ x: 25, y: -25, width: 50, height: 100 });
  });
  test("an unrotated box is its box", () => {
    const doc = make([box("a", 3, 4, 10, 20)]);
    expect(visualBounds(doc, "a", r)).toEqual({ x: 3, y: 4, width: 10, height: 20 });
  });
  test("a group is the union of its members' visual bounds, recursively", () => {
    const doc = make([
      box("a", 0, 0, 10, 10, { parent: "g" }),
      box("b", 50, 0, 100, 50, { parent: "h", rotation: 90 }),
      { ...groupNodeDefaults(page, { id: "h" }, []), parent: "g" },
      groupNodeDefaults(page, { id: "g", x: 999, y: 999, width: 1, height: 1 }, []),
    ]);
    expect(visualBounds(doc, "g", r)).toEqual({ x: 0, y: -25, width: 125, height: 100 });
  });
  test("a connector is its resolved drawn bounds", () => {
    const ends: [End, End] = [
      { kind: "free", x: 10, y: 10 },
      { kind: "free", x: 60, y: 40 },
    ];
    const c = connectorNodeDefaults(page, { id: "c", ends }, []);
    const doc = make([c]);
    const drawn = resolveConnector(doc, c as ConnectorNode, r).bounds;
    const got = visualBounds(doc, "c", r);
    for (const key of ["x", "y", "width", "height"] as const) expect(got[key]).toBeCloseTo(drawn[key], 2);
  });
});

describe("referenceRect", () => {
  const doc = make([box("a", 10, 10, 10, 10), box("b", 50, 30, 20, 20)]);
  test("selection is the union of the units' bounds", () => {
    expect(referenceRect(doc, page, ["a", "b"], "selection", r)).toEqual({ x: 10, y: 10, width: 60, height: 40 });
  });
  test("page is the page", () => {
    expect(referenceRect(doc, page, ["a"], "page", r)).toEqual({ x: 0, y: 0, ...pageSizePx(page) });
  });
  test("margins is the margin box, in px", () => {
    const size = pageSizePx(page);
    expect(referenceRect(doc, page, ["a"], "margins", r)).toEqual({
      x: mmToPx(15),
      y: mmToPx(10),
      width: size.width - mmToPx(35),
      height: size.height - mmToPx(40),
    });
  });
});

describe("alignOffsets", () => {
  const doc = make([box("a", 10, 0, 10, 10), box("b", 50, 20, 30, 10), box("c", 0, 0, 100, 50, { rotation: 90 })]);
  test("left moves each visual left to the reference's left", () => {
    const offsets = alignOffsets(doc, ["a", "b", "c"], "left", { x: 5, y: 0, width: 100, height: 100 }, r);
    expect(offsets.get("a")).toEqual({ x: -5, y: 0 });
    expect(offsets.get("b")).toEqual({ x: -45, y: 0 });
    expect(offsets.get("c")).toEqual({ x: -20, y: 0 });
  });
  test("vcenter and bottom move along y", () => {
    const ref = { x: 0, y: 0, width: 100, height: 100 };
    expect(alignOffsets(doc, ["a"], "vcenter", ref, r).get("a")).toEqual({ x: 0, y: 45 });
    expect(alignOffsets(doc, ["c"], "bottom", ref, r).get("c")).toEqual({ x: 0, y: 25 });
  });
});

describe("distributeOffsets", () => {
  test("gap: outer two stay, the gaps are equal", () => {
    const doc = make([box("a", 0, 0, 10, 10), box("b", 15, 0, 20, 10), box("c", 40, 0, 5, 10), box("d", 100, 0, 10, 10)]);
    const offsets = distributeOffsets(doc, ["d", "b", "a", "c"], "horizontal", "gap", r);
    expect(offsets.get("a") ?? { x: 0, y: 0 }).toEqual({ x: 0, y: 0 });
    expect(offsets.get("d") ?? { x: 0, y: 0 }).toEqual({ x: 0, y: 0 });
    // span 0..110, sizes 45, three gaps of 65/3.
    expect(offsets.get("b")?.x).toBeCloseTo(10 + 65 / 3 - 15, 1);
  });
  test("center: centres evenly spaced", () => {
    const doc = make([box("a", 0, 0, 10, 10), box("b", 0, 5, 10, 30), box("c", 0, 90, 10, 10)]);
    const offsets = distributeOffsets(doc, ["a", "b", "c"], "vertical", "center", r);
    expect(offsets.get("b")).toEqual({ x: 0, y: 30 });
  });
});
