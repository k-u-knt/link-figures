import { ellipsePath, rectPath } from "../../src/model/path";
import { ShapeKindRegistry, type ShapeKind } from "../../src/registry/shape-kind";
import { boxAnchors, builtinShapeKinds, ellipseShape, rectShape } from "../../src/shapes/builtin";

const box = { x: 10, y: 20, width: 100, height: 50 };
const expectedAnchors = [
  { id: "n", x: 60, y: 20, dir: { x: 0, y: -1 } },
  { id: "e", x: 110, y: 45, dir: { x: 1, y: 0 } },
  { id: "s", x: 60, y: 70, dir: { x: 0, y: 1 } },
  { id: "w", x: 10, y: 45, dir: { x: -1, y: 0 } },
];

test("the registry replaces a kind in place and keeps registration order", () => {
  const r = new ShapeKindRegistry();
  const k = (id: string, name: string) => ({ ...rectShape, id, name }) as ShapeKind;
  r.register(k("rect", "R"));
  r.register(k("ellipse", "E"));
  r.register(k("rect", "R2"));
  expect(r.all().map((x) => x.id)).toEqual(["rect", "ellipse"]);
  expect(r.get("rect")!.name).toBe("R2");
  expect(r.get("missing")).toBeUndefined();
});

test("the built-in kinds are rect then ellipse, and their defaults are fresh objects", () => {
  expect(builtinShapeKinds.map((k) => k.id)).toEqual(["rect", "ellipse"]);
  expect(rectShape.defaults()).toEqual({ cornerRadius: 0 });
  expect(rectShape.defaults()).not.toBe(rectShape.defaults());
  expect(ellipseShape.defaults()).toEqual({});
});

test("a 100 × 50 rectangle's outline is its box, with corners rounded by its corner radius", () => {
  expect(rectShape.outline(box, { cornerRadius: 0 })).toEqual([
    { op: "M", x: 10, y: 20 },
    { op: "L", x: 110, y: 20 },
    { op: "L", x: 110, y: 70 },
    { op: "L", x: 10, y: 70 },
    { op: "Z" },
  ]);
  expect(rectShape.outline(box, { cornerRadius: 8 })).toEqual(rectPath(box, 8));
  // Kept within half the short side.
  expect(rectShape.outline(box, { cornerRadius: 1000 })).toEqual(rectPath(box, 25));
});

test("a corner radius that is missing or not a finite number reads as 0", () => {
  for (const cornerRadius of [undefined, NaN, Infinity, "3", null]) {
    const outline = rectShape.outline(box, { cornerRadius });
    expect(outline).toEqual(rectPath(box, 0));
    expect(JSON.stringify(outline)).not.toMatch(/null|NaN/);
  }
});

test("the rectangle's corner radius is one field, in mm, never negative", () => {
  expect(rectShape.fields({ cornerRadius: 0 })).toEqual([{ kind: "number", key: "cornerRadius", label: "Corner radius", unit: "mm", min: 0, step: 0.5 }]);
  expect(ellipseShape.fields({})).toEqual([]);
});

test("a 100 × 50 ellipse's outline is the inscribed ellipse", () => {
  const outline = ellipseShape.outline(box, {});
  expect(outline).toEqual(ellipsePath(box));
  expect(outline[0]).toEqual({ op: "M", x: 110, y: 45 });
});

test("both kinds have the anchors n e s w at the edge midpoints, pointing out", () => {
  expect(rectShape.anchors(box, { cornerRadius: 10 })).toEqual(expectedAnchors);
  expect(ellipseShape.anchors(box, {})).toEqual(expectedAnchors);
  expect(boxAnchors(box)).toEqual(expectedAnchors);
});

test("a zero-size box gives finite outlines and anchors", () => {
  const zero = { x: 5, y: 5, width: 0, height: 0 };
  for (const kind of builtinShapeKinds) {
    const out = JSON.stringify([kind.outline(zero, kind.defaults()), kind.anchors(zero, kind.defaults())]);
    expect(out).not.toMatch(/null|NaN|Infinity/);
  }
});
