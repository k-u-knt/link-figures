// @vitest-environment happy-dom
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { buildPageSvg } from "../../src/export/svg-builder";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { toSvgPath } from "../../src/model/path";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { connectorNodeSvg, connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
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
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  return r;
}

const page = createPage("a4-portrait", []);
const linear = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };
const free = (x: number, y: number): End => ({ kind: "free", x, y });
const connector = (over: Partial<ConnectorNode> = {}): ConnectorNode => ({
  id: "c",
  type: "connector",
  page: page.id,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  z: 1,
  rotation: 0,
  opacity: 1,
  locked: false,
  ends: [{ kind: "attached", node: "a", snap: "anchor", anchor: "e" }, free(300, 200)],
  route: "orthogonal",
  routeParams: { offset: 0.5 },
  stroke: { paint: linear, width: 2, dash: "dash" },
  caps: [
    { kind: "circle", size: 3 },
    { kind: "arrow", size: 3 },
  ],
  ...over,
});
const shapeA = (): Node => ({ ...shapeNodeDefaults(page, { kind: "rect", params: {} }, []), id: "a", x: 10, y: 20, width: 100, height: 50 });
const docWith = (c: ConnectorNode = connector()): Document => ({ ...createDocument("a4-portrait"), pages: [page], nodes: [shapeA(), c] });

/** Ids as the SVG builder makes them: numbered per prefix. */
const uids = () => {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${n}`;
  };
};

describe("SVG", () => {
  test("the line is stroked with the stroke's paint over the paint box, and each cap is filled with the same paint", () => {
    const d = docWith();
    const c = d.nodes[1] as ConnectorNode;
    const r = registries();
    const resolved = resolveConnector(d, c, r);
    const defs: string[] = [];
    const warnings: string[] = [];
    const { svg, bounds } = connectorNodeSvg(d, c, { registries: r, defs, warnings, uid: uids() });
    expect(warnings).toEqual([]);
    expect(bounds).toEqual(resolved.bounds);
    const box = resolved.paintBox;
    expect(defs).toEqual([
      expect.stringContaining(`<linearGradient id="grad-1" gradientUnits="userSpaceOnUse" x1="${box.x}" y1="${box.y + box.height / 2}" x2="${box.x + box.width}"`),
    ]);
    const paths = svg.match(/<path [^>]*\/>/g)!;
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(`<path d="${toSvgPath(resolved.path)}" fill="none" stroke="url(#grad-1)" stroke-width="${(2 * 96) / 72}" stroke-dasharray="${(8 * 96) / 72} ${(4 * 96) / 72}"/>`);
    expect(paths[1]).toBe(`<path d="${toSvgPath(resolved.caps[0]!)}" fill="url(#grad-1)"/>`);
    expect(paths[2]).toBe(`<path d="${toSvgPath(resolved.caps[1]!)}" fill="url(#grad-1)"/>`);
  });

  test("a translucent solid stroke writes its opacity on the line and on the caps; a cap of none draws nothing", () => {
    const d = docWith(connector({ stroke: { paint: { type: "solid", color: "#ff0000", opacity: 0.5 }, width: 1, dash: "solid" }, caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 3 }] }));
    const { svg } = connectorNodeSvg(d, d.nodes[1] as ConnectorNode, { registries: registries(), defs: [], warnings: [], uid: uids() });
    const paths = svg.match(/<path [^>]*\/>/g)!;
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('stroke="#ff0000" stroke-width');
    expect(paths[0]).toContain('stroke-opacity="0.5"');
    expect(paths[1]).toMatch(/fill="#ff0000" fill-opacity="0\.5"\/>$/);
  });

  test("in a page export it is drawn by its node type, translucent as a group, never rotated; unknown routes and caps are said", () => {
    const d = docWith(connector({ opacity: 0.5, route: "x.wiggle", caps: [{ kind: "x.star", size: 3 }, { kind: "arrow", size: 3 }] }));
    const { svg, warnings } = buildPageSvg(d, page, registries(), new Map());
    expect(svg).toContain('<g opacity="0.5"><path d="');
    expect(warnings).toEqual([
      `"c" (${page.name}): no route "x.wiggle" is registered, drawn straight`,
      `"c" (${page.name}): no cap kind "x.star" is registered, drawn without it`,
    ]);
  });
});

describe("stage", () => {
  const mount = (doc: Document, r = registries()) => {
    const host = document.createElement("div");
    let current = doc;
    const ctx = { registries: r, doc: () => current };
    const renderer = r.nodeTypes.get("connector")!.mount(doc.nodes[1], host, ctx as never);
    return { host, renderer, el: host.firstElementChild as HTMLElement, setDoc: (d: Document) => (current = d) };
  };
  /** The page's ids made generic, so the stage's own (prefixed) ids compare with the export's. */
  const genericIds = (markup: string) => markup.replace(/lf-connector-\d+-/g, "");
  const parse = (markup: string) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, "image/svg+xml").documentElement;
  const attrsOf = (e: Element) => Object.fromEntries(Array.from(e.attributes, (a) => [a.name, genericIds(a.value)]));
  const shapes = (root: Element) => Array.from(root.children, (e) => [e.tagName.toLowerCase(), attrsOf(e)]);

  test("the stage draws exactly the export's fragment, in an SVG placed on, and viewing, the drawn area", () => {
    const d = docWith();
    const { el } = mount(d);
    expect(el.classList.contains("lf-node")).toBe(true);
    expect(el.classList.contains("lf-connector")).toBe(true);
    const defs: string[] = [];
    const { svg: fragment, bounds } = connectorNodeSvg(d, d.nodes[1] as ConnectorNode, { registries: registries(), defs, warnings: [], uid: uids() });
    const placed = [el.style.left, el.style.top, el.style.width, el.style.height].map((v) => parseFloat(v));
    [bounds.x, bounds.y, bounds.width, bounds.height].forEach((v, i) => expect(placed[i]).toBeCloseTo(v, 5));
    const svg = el.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe(`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    const stageBody = Array.from(svg.children).filter((e) => e.tagName.toLowerCase() !== "defs");
    expect(stageBody.map((e) => [e.tagName.toLowerCase(), attrsOf(e)])).toEqual(shapes(parse(fragment)));
    expect(shapes(svg.querySelector("defs")!)).toEqual(shapes(parse(defs.join(""))));
    expect(svg.querySelector("path")!.getAttribute("stroke")).toMatch(/^url\(#lf-connector-\d+-grad-1\)$/);
  });

  test("an update draws it again from the document as it is now: a moved target moves the line", () => {
    const d = docWith();
    const r = registries();
    const { el, renderer, setDoc, host } = mount(d, r);
    const first = el.querySelector("path")!.getAttribute("d");
    const moved: Document = { ...d, nodes: [{ ...d.nodes[0], y: 60 }, d.nodes[1]] };
    setDoc(moved);
    renderer.update(moved.nodes[1]);
    expect(el.querySelector("path")!.getAttribute("d")).not.toBe(first);
    expect(el.querySelector("path")!.getAttribute("d")).toBe(toSvgPath(resolveConnector(moved, moved.nodes[1] as ConnectorNode, r).path));
    expect(el.querySelectorAll("svg")).toHaveLength(1);
    renderer.unmount();
    expect(host.children).toHaveLength(0);
  });

  test("a hairline straight connector still has a non-empty viewBox", () => {
    const d = docWith(connector({ ends: [free(10, 10), free(110, 10)], route: "straight", stroke: { paint: { type: "solid", color: "#000000" }, width: 0, dash: "solid" }, caps: [{ kind: "none", size: 3 }, { kind: "none", size: 3 }] }));
    const { el } = mount(d);
    const [, , w, h] = el.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });
});

describe("node type", () => {
  test("it cannot be attached to, and depends on the items its ends are attached to", () => {
    expect(connectorNodeType.attachable).toBeUndefined();
    expect(connectorNodeType.dependsOn!(connector())).toEqual(["a"]);
    expect(connectorNodeType.dependsOn!(connector({ ends: [free(0, 0), { kind: "attached", node: "b", snap: "center" }] }))).toEqual(["b"]);
  });

  test("bounds are the box; the inspector offers no box or rotation of its own", () => {
    expect(connectorNodeType.bounds(connector({ x: 1, y: 2, width: 3, height: 4 }))).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(connectorNodeType.derivedFields).toEqual(["x", "y", "width", "height", "rotation"]);
  });

  test("the inspector is the route, its fields, the line's stroke, each cap, and each attached end's snap", () => {
    const r = registries();
    const keys = (c: ConnectorNode) => connectorNodeType.inspector(c, { registries: r }).map((f) => `${f.kind}:${f.key}`);
    expect(keys(connector())).toEqual([
      "select:route",
      "number:routeParams.offset",
      "paint:stroke.paint",
      "number:stroke.width",
      "select:stroke.dash",
      "select:caps.0.kind",
      "number:caps.0.size",
      "select:caps.1.kind",
      "number:caps.1.size",
      "select:ends.0.snap",
    ]);
    expect(keys(connector({ route: "straight", ends: [free(0, 0), free(1, 1)] }))).not.toContain("select:ends.0.snap");
    const fields = connectorNodeType.inspector(connector({ route: "x.wiggle" }), { registries: r });
    expect(fields[0].options!.map((o) => o.value)).toEqual(["straight", "curved", "orthogonal", "x.wiggle"]);
    expect(fields.find((f) => f.key === "caps.1.kind")!.options!.map((o) => o.value)).toEqual(["none", "arrow", "openArrow", "circle", "bar"]);
  });
});
