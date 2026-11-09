import type { Rect } from "../model/geometry";
import { ellipsePath, rectPath } from "../model/path";
import type { Anchor, ShapeKind } from "../registry/shape-kind";

/** The four edge midpoints of a box, `n e s w`, each pointing straight out of its edge. */
export function boxAnchors(box: Rect): Anchor[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [
    { id: "n", x: cx, y: box.y, dir: { x: 0, y: -1 } },
    { id: "e", x: box.x + box.width, y: cy, dir: { x: 1, y: 0 } },
    { id: "s", x: cx, y: box.y + box.height, dir: { x: 0, y: 1 } },
    { id: "w", x: box.x, y: cy, dir: { x: -1, y: 0 } },
  ];
}

/** A rectangle; `cornerRadius` (px) rounds its corners, kept within half the short side. A radius that is not a number reads as 0. */
export const rectShape: ShapeKind = {
  id: "rect",
  name: "Rectangle",
  icon: "square",
  defaults: () => ({ cornerRadius: 0 }),
  fields: () => [{ kind: "number", key: "cornerRadius", label: "Corner radius", unit: "mm", min: 0, step: 0.5 }],
  outline(box, params) {
    const radius = typeof params.cornerRadius === "number" && Number.isFinite(params.cornerRadius) ? params.cornerRadius : 0;
    return rectPath(box, radius);
  },
  anchors: (box) => boxAnchors(box),
  /** `rect`, or `roundRect` whose `adj` is the radius as a fraction of the short side (1/100 000), at most a half. */
  toPptx(box, params) {
    const raw = params.cornerRadius;
    const radius = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const short = Math.min(box.width, box.height);
    if (radius === 0 || short <= 0) return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
    const adj = Math.round(Math.min(0.5, radius / short) * 100000);
    return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
  },
};

/** The ellipse inscribed in the box; its edge midpoints are the box's. */
export const ellipseShape: ShapeKind = {
  id: "ellipse",
  name: "Ellipse",
  icon: "circle",
  defaults: () => ({}),
  fields: () => [],
  outline: (box) => ellipsePath(box),
  anchors: (box) => boxAnchors(box),
  toPptx: () => '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>',
};

/** The shape kinds the plugin registers at load. */
export const builtinShapeKinds: ShapeKind[] = [rectShape, ellipseShape];
