// @vitest-environment happy-dom
import { buildPageSvg } from "../../src/export/svg-builder";
import { createDocument, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import type { GroupNode, Node } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { RenderContext, SvgContext } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";

// Obsidian's `createDiv`, which the renderer uses to add its element; happy-dom has the rest of the DOM.
beforeAll(() => {
  (HTMLElement.prototype as unknown as { createDiv: unknown }).createDiv = function (this: HTMLElement, info: { cls?: string | string[] } = {}) {
    const el = this.ownerDocument.createElement("div");
    if (info.cls) el.classList.add(...(Array.isArray(info.cls) ? info.cls : [info.cls]));
    this.appendChild(el);
    return el;
  };
});

function registries() {
  const r = createRegistries();
  for (const paint of builtinPaintTypes) r.paints.register(paint);
  for (const kind of builtinShapeKinds) r.shapes.register(kind);
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(groupNodeType);
  return r;
}

/** Shapes `a` and `b`, and, with `grouped`, both in group `g` (its box their union, as the normaliser keeps it). */
function figure(grouped: boolean) {
  const d = createDocument("nature-double");
  const page = d.pages[0];
  const a: Node = { ...shapeNodeDefaults(page, { id: "a", x: 10, y: 20, width: 100, height: 50, z: 0 }, []) };
  const b: Node = { ...shapeNodeDefaults(page, { id: "b", x: 200, y: 20, width: 100, height: 50, z: 1 }, []) };
  if (!grouped) {
    d.nodes.push(a, b);
    return d;
  }
  const g: GroupNode = groupNodeDefaults(page, { id: "g", x: 10, y: 20, width: 290, height: 50, z: 1 }, []);
  d.nodes.push({ ...a, parent: "g" }, { ...b, parent: "g" }, g);
  return d;
}

test("toSvg draws nothing", () => {
  const d = figure(true);
  const g = d.nodes.find((n) => n.id === "g") as GroupNode;
  expect(groupNodeType.toSvg(g, {} as SvgContext)).toBe("");
});

test("a page with a group exports as it does without it", () => {
  const r = registries();
  const without = figure(false);
  const withGroup = figure(true);
  const a = buildPageSvg(without, without.pages[0], r, new Map());
  const b = buildPageSvg(withGroup, withGroup.pages[0], r, new Map());
  expect(b.svg).toBe(a.svg);
  expect(b.warnings).toEqual(a.warnings);
  expect(b.drawn).toBe(a.drawn);
});

test("mount appends an empty div.lf-group", () => {
  const host = document.createElement("div");
  const g = figure(true).nodes.find((n) => n.id === "g") as GroupNode;
  const renderer = groupNodeType.mount(g, host, {} as RenderContext);
  expect(host.children).toHaveLength(1);
  const el = host.lastElementChild as HTMLElement;
  expect(el.classList.contains("lf-group")).toBe(true);
  expect(el.childElementCount).toBe(0);
  renderer.update(g);
  renderer.unmount();
  expect(host.children).toHaveLength(0);
});

test("its members are its children, its bounds its box, rotation and opacity are derived and it has no own fields", () => {
  const d = figure(true);
  const g = d.nodes.find((n) => n.id === "g") as GroupNode;
  expect(groupNodeType.members?.(g, d)).toEqual(["a", "b"]);
  expect(groupNodeType.bounds(g)).toEqual({ x: 10, y: 20, width: 290, height: 50 });
  expect(groupNodeType.derivedFields).toEqual(["rotation", "opacity"]);
  expect(groupNodeType.inspector(g, { registries: registries() })).toEqual([]);
});
