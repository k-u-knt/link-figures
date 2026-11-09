// @vitest-environment happy-dom
import { PT_TO_PX } from "../../src/constants";
import { buildPageSvg } from "../../src/export/svg-builder";
import { loadDocument } from "../../src/format/load";
import { migrate } from "../../src/format/migrate";
import { FormatError } from "../../src/format/errors";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, createPage, defaultBorder, shapeNodeDefaults } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import type { ShapeNode } from "../../src/model/types";
import { shapeNodeSvg, shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
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
  return r;
}

const linear = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };

function docWith(over: Partial<ShapeNode>) {
  const d = createDocument("nature-double");
  d.nodes.push({ ...shapeNodeDefaults(d.pages[0], {}, []), x: 10, y: 20, width: 100, height: 50, ...over });
  return d;
}

const exportOf = (d: ReturnType<typeof docWith>, r = registries()) => buildPageSvg(d, d.pages[0], r, new Map());
/** Ids as the SVG builder makes them: numbered per prefix. */
const uids = () => {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${n}`;
  };
};
const px = PT_TO_PX;

describe("defaults and the file format", () => {
  test("a new shape is a 30 × 20 mm rectangle, filled white, with a 1 pt solid black border; nothing is shared", () => {
    const page = createPage("a4-portrait", []);
    const a = shapeNodeDefaults(page, {}, []);
    const b = shapeNodeDefaults(page, {}, [a.id]);
    expect(a).toMatchObject({ type: "shape", page: page.id, kind: "rect", params: { cornerRadius: 0 }, fill: { type: "solid", color: "#ffffff" }, border: { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" } });
    expect(a.width).toBeCloseTo(mmToPx(30), 6);
    expect(a.height).toBeCloseTo(mmToPx(20), 6);
    expect(a.border).toEqual(defaultBorder());
    expect(a.params).not.toBe(b.params);
    expect(a.fill).not.toBe(b.fill);
    expect(a.border).not.toBe(b.border);
  });

  test("migrate fills a shape's missing keys as shapeNodeDefaults does, except params, which belong to the kind", () => {
    const geom = { page: "pg-1", x: 1, y: 2, width: 30, height: 40 };
    const doc = migrate({ version: 1, pages: [{ id: "pg-1", width: 100, height: 100 }], nodes: [{ id: "p-1", type: "shape", ...geom }] });
    const { id: _i, page: _p, x: _x, y: _y, width: _w, height: _h, params: _params, ...defaults } = shapeNodeDefaults(createPage("a4-portrait", []), {}, []);
    expect(doc.nodes[0]).toEqual({ id: "p-1", ...geom, ...defaults, params: {} });
  });

  test("a shape's border migrates like any stroke, and may be null", () => {
    const node = (extra: object) => ({ version: 1, pages: [{ id: "pg-1", width: 100, height: 100 }], nodes: [{ id: "p-1", type: "shape", page: "pg-1", x: 0, y: 0, width: 1, height: 1, ...extra }] });
    expect((migrate(node({ border: { color: "#ff0000", width: 2 } })).nodes[0] as ShapeNode).border).toEqual({ paint: { type: "solid", color: "#ff0000" }, width: 2, dash: "solid" });
    expect((migrate(node({ border: null })).nodes[0] as ShapeNode).border).toBeNull();
  });

  test("a malformed shape is a FormatError", () => {
    const node = (extra: object) => ({ version: 1, pages: [{ id: "pg-1", width: 100, height: 100 }], nodes: [{ id: "p-1", type: "shape", page: "pg-1", x: 0, y: 0, width: 1, height: 1, ...extra }] });
    expect(() => migrate(node({ kind: 3 }))).toThrow(new FormatError('Node p-1: "kind" must be a string'));
    expect(() => migrate(node({ params: [] }))).toThrow(new FormatError('Node p-1: "params" must be an object'));
    expect(() => migrate(node({ fill: "red" }))).toThrow(new FormatError('Node p-1: "fill" must be a paint { type, … }'));
    expect(() => migrate(node({ fill: { color: "#ff0000" } }))).toThrow(FormatError);
    expect(() => migrate(node({ border: "red" }))).toThrow(new FormatError('Node p-1: "border" must be null or a stroke { paint: { type, … }, width, dash }'));
  });

  test("a shape of a kind this plugin does not know is kept as it is through a round trip", () => {
    const d = docWith({ kind: "x.star", params: { points: 5, inner: { r: 0.4 } }, fill: { type: "x.glow", amount: 2 } });
    const back = loadDocument(serializeFigureFile(d, emptyParsed())).doc;
    expect(back).toEqual(d);
    expect(back.nodes[0]).toMatchObject({ kind: "x.star", params: { points: 5, inner: { r: 0.4 } }, fill: { type: "x.glow", amount: 2 } });
  });
});

describe("SVG", () => {
  test("a gradient fill and a dashed border: the gradient in defs, laid out in the box, and the dashes scaled to the width", () => {
    const d = docWith({ fill: linear, border: { paint: { type: "solid", color: "#ff0000" }, width: 1, dash: "dash" } });
    const { svg, warnings } = exportOf(d);
    expect(warnings).toEqual([]);
    expect(svg).toContain(
      '<defs><linearGradient id="grad-1" gradientUnits="userSpaceOnUse" x1="10" y1="45" x2="110" y2="45">' +
        '<stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>',
    );
    expect(svg).toContain(`<path d="M10 20 L110 20 L110 70 L10 70 Z" fill="url(#grad-1)" stroke="#ff0000" stroke-width="${px}" stroke-dasharray="${4 * px} ${2 * px}"/>`);
  });

  test("a gradient border is laid out over the outline's bounds, and a translucent solid fill writes fill-opacity", () => {
    const r = registries();
    const node = { ...docWith({}).nodes[0], kind: "ellipse", params: {}, fill: { type: "solid", color: "#00ff00", opacity: 0.5 }, border: { paint: linear, width: 2, dash: "solid" } } as ShapeNode;
    const defs: string[] = [];
    const fragment = shapeNodeSvg(node, { registries: r, defs, warnings: [], uid: uids() });
    expect(fragment).toMatch(/^<path d="M110 45 C[^"]+Z" fill="#00ff00" fill-opacity="0.5" stroke="url\(#grad-1\)" stroke-width="[^"]+"\/>$/);
    expect(defs).toEqual([expect.stringContaining('<linearGradient id="grad-1" gradientUnits="userSpaceOnUse" x1="10" y1="45" x2="110" y2="45">')]);
  });

  test("with no border the path has no stroke; a rounded rectangle's outline is curved", () => {
    const { svg } = exportOf(docWith({ border: null, params: { cornerRadius: 5 } }));
    const path = /<path [^>]*\/>/.exec(svg)![0];
    expect(path).not.toContain("stroke");
    expect(path).toContain('fill="#ffffff"');
    expect(path).toMatch(/^<path d="M15 20 L105 20 C/);
  });

  test("a rotated, translucent shape is wrapped like any node", () => {
    const { svg } = exportOf(docWith({ rotation: 30, opacity: 0.5 }));
    expect(svg).toContain('<g opacity="0.5" transform="rotate(30 60 45)"><path ');
  });

  test("an unknown kind draws a placeholder of its box with one warning", () => {
    const d = docWith({ kind: "x.star", params: { points: 5 } });
    const { svg, warnings } = exportOf(d);
    expect(svg).toContain('<path d="M10 20 L110 20 L110 70 L10 70 Z" fill="none" stroke="#888888" stroke-width="1" stroke-dasharray="4 2"/>');
    expect(warnings).toEqual([`"${d.nodes[0].id}" (${d.pages[0].name}): no shape kind "x.star" is registered, drawn as a placeholder`]);
  });

  test("an unknown paint is drawn as none, with the node's label on its warning", () => {
    const d = docWith({ fill: { type: "x.glow" } });
    const { svg, warnings } = exportOf(d);
    expect(svg).toContain('fill="none" stroke="#000000"');
    expect(warnings).toEqual([`"${d.nodes[0].id}" (${d.pages[0].name}): no paint type "x.glow" is registered, drawn without paint`]);
  });
});

describe("stage", () => {
  const mount = (node: ShapeNode, r = registries()) => {
    const host = document.createElement("div");
    const renderer = r.nodeTypes.get("shape")!.mount(node, host, { registries: r } as never);
    return { host, renderer, el: host.firstElementChild as HTMLElement };
  };
  /** The page's ids made generic, so the stage's own (prefixed) ids compare with the export's. */
  const genericIds = (markup: string) => markup.replace(/lf-shape-\d+-/g, "");

  test("the stage draws the same outline and paints as the export, in an SVG whose viewBox is the box", () => {
    const d = docWith({ fill: linear, border: { paint: { type: "pattern", pattern: "dots", fg: "#ff0000", bg: null, scale: 1, angle: 0 }, width: 2, dash: "dot" } });
    const node = d.nodes[0] as ShapeNode;
    const { el } = mount(node);
    expect(el.classList.contains("lf-node")).toBe(true);
    expect(el.classList.contains("lf-shape")).toBe(true);
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(["10px", "20px", "100px", "50px"]);
    const svg = el.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("10 20 100 50");

    const defs: string[] = [];
    const fragment = shapeNodeSvg(node, { registries: registries(), defs, warnings: [], uid: uids() });
    const parse = (markup: string) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, "image/svg+xml").documentElement;
    const attrsOf = (e: Element) => Object.fromEntries(Array.from(e.attributes, (a) => [a.name, genericIds(a.value)]));
    const stagePath = svg.querySelector("path")!;
    const exportPath = parse(fragment).querySelector("path")!;
    expect(attrsOf(stagePath)).toEqual(attrsOf(exportPath));
    expect(stagePath.getAttribute("fill")).toMatch(/^url\(#lf-shape-\d+-grad-1\)$/);
    const stageDefs = Array.from(svg.querySelector("defs")!.children, (e) => [e.tagName.toLowerCase(), attrsOf(e)]);
    const exportDefs = Array.from(parse(defs.join("")).children, (e) => [e.tagName.toLowerCase(), attrsOf(e)]);
    expect(stageDefs).toEqual(exportDefs);
  });

  test("an update redraws the shape and its box; two shapes never share a gradient id", () => {
    const d = docWith({ fill: linear });
    const node = d.nodes[0] as ShapeNode;
    const r = registries();
    const a = mount(node, r);
    const b = mount(node, r);
    const idOf = (el: HTMLElement) => el.querySelector("linearGradient")!.getAttribute("id");
    expect(idOf(a.el)).not.toBe(idOf(b.el));
    a.renderer.update({ ...node, x: 30, kind: "ellipse", rotation: 90, opacity: 0.5 });
    expect(a.el.style.left).toBe("30px");
    expect(a.el.style.transform).toBe("rotate(90deg)");
    expect(a.el.style.opacity).toBe("0.5");
    expect(a.el.querySelector("svg")!.getAttribute("viewBox")).toBe("30 20 100 50");
    expect(a.el.querySelector("path")!.getAttribute("d")).toMatch(/^M130 45 C/);
    expect(a.el.querySelectorAll("svg")).toHaveLength(1);
    a.renderer.unmount();
    expect(a.host.children).toHaveLength(0);
  });

  test("an unknown kind draws the placeholder on the stage and warns once, not on every redraw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const node = docWith({ kind: "x.star" }).nodes[0] as ShapeNode;
      const { el, renderer } = mount(node);
      renderer.update({ ...node, x: 12 });
      renderer.update({ ...node, x: 14 });
      expect(el.querySelector("path")!.getAttribute("stroke-dasharray")).toBe("4 2");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('no shape kind "x.star" is registered');
    } finally {
      warn.mockRestore();
    }
  });
});

describe("node type", () => {
  test("bounds are the box", () => {
    const node = docWith({}).nodes[0] as ShapeNode;
    expect(registries().nodeTypes.get("shape")!.bounds(node)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  test("the inspector is the kind's fields under params, the fill, a Border toggle and, with a border, its paint, width and dashes", () => {
    const r = registries();
    const type = r.nodeTypes.get("shape")!;
    const node = docWith({}).nodes[0] as ShapeNode;
    const fieldsOf = (n: ShapeNode) => type.inspector(n, { registries: r });
    const keys = (n: ShapeNode) => fieldsOf(n).map((f) => `${f.kind}:${f.key}`);
    expect(keys(node)).toEqual(["number:params.cornerRadius", "paint:fill", "toggle:border", "paint:border.paint", "number:border.width", "select:border.dash"]);
    expect(fieldsOf(node).find((f) => f.key === "border")!.onValue).toEqual(defaultBorder());
    expect(fieldsOf(node).find((f) => f.key === "params.cornerRadius")!.unit).toBe("mm");
    expect(keys({ ...node, border: null })).toEqual(["number:params.cornerRadius", "paint:fill", "toggle:border"]);
    expect(keys({ ...node, kind: "ellipse" })[0]).toBe("paint:fill");
    expect(keys({ ...node, kind: "x.star" })[0]).toBe("paint:fill");
  });

  test("kinds and paints come from the context's registries, whatever is registered there", () => {
    const r = createRegistries();
    for (const paint of builtinPaintTypes) r.paints.register(paint);
    const node = docWith({}).nodes[0] as ShapeNode;
    expect(shapeNodeType.inspector(node, { registries: r })[0].key).toBe("fill");
    r.shapes.register(builtinShapeKinds[0]);
    expect(shapeNodeType.inspector(node, { registries: r })[0].key).toBe("params.cornerRadius");
    const warnings: string[] = [];
    shapeNodeSvg(node, { registries: createRegistries(), defs: [], warnings, uid: uids() });
    expect(warnings).toEqual(['no shape kind "rect" is registered, drawn as a placeholder']);
  });
});
