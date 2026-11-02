import { Window } from "happy-dom";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createDocument, createPage, defaultBorder, fileNodeDefaults } from "../../src/model/defaults";
import { strokeFields } from "../../src/registry/paint";
import type { FileNode } from "../../src/model/types";
import { createRegistries } from "../../src/registry";

// `obsidian` ships only typings, so this module cannot be loaded for real; the parts under test never touch it.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));
const { fileNodeType, fileNodeSvg } = await import("../../src/nodes/file-node");
const { fileNodeSvg: pureFileNodeSvg, fileFrameSvg } = await import("../../src/nodes/file-node-svg");

const page = createPage("a4-portrait", []);
const noCtx = { registries: createRegistries() };
const node = (over: Partial<FileNode> = {}): FileNode => ({
  ...fileNodeDefaults(page, { file: "a.png", subpath: "", show: "image" }, []),
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  ...over,
});

test("the type is registered as 'file', named, with the image icon", () => {
  expect([fileNodeType.type, fileNodeType.name, fileNodeType.icon]).toEqual(["file", "Linked file", "image"]);
});

test("bounds are the node's rectangle", () => expect(fileNodeType.bounds(node())).toEqual({ x: 10, y: 20, width: 100, height: 50 }));

const FRAME_TOGGLE = { kind: "toggle", key: "frame", label: "Frame", onValue: defaultBorder() };

test("the inspector offers a Page field for pdf and tiff targets only", () => {
  const page = [{ kind: "number", key: "pageIndex", label: "Page", min: 0, step: 1 }, FRAME_TOGGLE];
  expect(fileNodeType.inspector(node({ file: "plot.pdf" }), noCtx)).toEqual(page);
  expect(fileNodeType.inspector(node({ file: "figs/cells.TIF" }), noCtx)).toEqual(page);
  expect(fileNodeType.inspector(node({ file: "cells.tiff" }), noCtx)).toEqual(page);
  expect(fileNodeType.inspector(node({ file: "plot.png" }), noCtx)).toEqual([FRAME_TOGGLE]);
  expect(fileNodeType.inspector(node({ file: "analysis", subpath: "#Figure 2" }), noCtx)).toEqual([FRAME_TOGGLE]);
  expect(fileNodeType.inspector(node({ file: "v1.2/analysis" }), noCtx)).toEqual([FRAME_TOGGLE]);
});

test("the inspector's Frame toggle is off for no frame; with a frame, its paint, width and dashes follow", () => {
  expect(fileNodeType.inspector(node({ frame: defaultBorder() }), noCtx)).toEqual([FRAME_TOGGLE, ...strokeFields("frame", "Frame")]);
  expect(fileNodeType.checkField?.("frame", null, noCtx)).toBeNull();
  expect(fileNodeType.checkField?.("frame", defaultBorder(), noCtx)).toBeNull();
});

test("file-node re-exports the pure SVG function", () => expect(fileNodeSvg).toBe(pureFileNodeSvg));

describe("toSvg", () => {
  const ctx = (assets: Map<string, any>) => ({ registries: createRegistries(), doc: { ...createDocument("a4-portrait"), pages: [page] }, page, assets, defs: [] as string[], warnings: [] as string[], uid: (p: string) => p + "-1" });

  test("reads the node's file asset from the asset map", () => {
    const n = node();
    const c = ctx(new Map([[n.id, { kind: "image", dataUri: "data:,x", naturalWidth: 100, naturalHeight: 50 }]]));
    expect(fileNodeType.toSvg(n, c)).toContain('<image href="data:,x"');
  });

  test("a rasterised asset is not the node type's own: the node counts as unresolved", () => {
    const n = node();
    const c = ctx(new Map([[n.id, { kind: "raster", dataUri: "data:,r" }]]));
    expect(fileNodeType.toSvg(n, c)).toBe("raster");
    expect(c.warnings[0]).toMatch(/missing/);
  });

  test("a content node asks for rasterising without a warning", () => {
    const c = ctx(new Map());
    expect(fileNodeType.toSvg(node({ show: "content" }), c)).toBe("raster");
    expect(c.warnings).toEqual([]);
  });
});

// The stage: the panel's picture is clipped to the crop region, so a crop with `contain` leaves the rest of the image out of the letterbox.

/** Just enough of an element to build and drive a file node's DOM without a browser. */
class FakeEl {
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  cls: string[] = [];
  src: string | null = null;
  draggable = true;
  title = "";
  naturalWidth = 0;
  naturalHeight = 0;
  private readonly listeners = new Map<string, (() => void)[]>();
  readonly classList = { toggle: () => true };
  readonly ownerDocument = { importNode: <T>(node: T) => node };
  replaceChildren(...nodes: FakeEl[]): void {
    this.children = nodes;
  }
  createEl(_tag: string, info: { cls?: string | string[] } = {}): FakeEl {
    const el = new FakeEl();
    if (info.cls) el.cls = Array.isArray(info.cls) ? info.cls : [info.cls];
    this.children.push(el);
    return el;
  }
  createDiv(info?: { cls?: string | string[] }): FakeEl {
    return this.createEl("div", info);
  }
  empty(): void {
    this.children = [];
  }
  remove(): void {}
  getAttribute(name: string): string | null {
    return name === "src" ? this.src : null;
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

describe("the picture on the stage", () => {
  /** A 200x100 image linked as the node, mounted, and loaded. */
  function mounted(over: Partial<FileNode>) {
    const n = node({ x: 0, y: 0, width: 200, height: 100, ...over });
    const resolved = { kind: "image", file: { path: "a.png" }, src: "app://a.png", source: "file", pageCount: 1, deps: [] };
    const host = new FakeEl();
    const renderer = fileNodeType.mount(n, host as unknown as HTMLElement, { resolved: () => resolved, openLink: () => {}, component: {} } as never);
    const frame = host.children[0].children[0].children[0];
    const img = frame.children[0];
    const load = () => {
      img.naturalWidth = 200;
      img.naturalHeight = 100;
      img.fire("load");
    };
    return { n, renderer, frame, img, load };
  }
  const box = (el: FakeEl) => [el.style.left, el.style.top, el.style.width, el.style.height];
  const rightHalf = { x: 0.5, y: 0, w: 0.5, h: 1 };

  test("with contain, the frame is the crop's region and the whole image sits inside it, offset", () => {
    const { frame, img, load } = mounted({ crop: rightHalf, fit: "contain" });
    load();
    expect(frame.cls).toEqual(["lf-image"]);
    expect(box(frame)).toEqual(["50px", "0px", "100px", "100px"]);
    expect(box(img)).toEqual(["-100px", "0px", "200px", "100px"]);
  });

  test("with cover, the frame is the node's box", () => {
    const { frame, img, load } = mounted({ crop: rightHalf, fit: "cover" });
    load();
    expect(box(frame)).toEqual(["0px", "0px", "200px", "100px"]);
    expect(box(img)).toEqual(["-200px", "-50px", "400px", "200px"]);
  });

  test("until the image has loaded, the frame is the box and the picture fills it", () => {
    const { frame, img } = mounted({ crop: rightHalf, fit: "contain" });
    expect(box(frame)).toEqual(["0px", "0px", "200px", "100px"]);
    expect(box(img)).toEqual(["0px", "0px", "200px", "100px"]);
  });

  test("a change of crop or fit is placed again", () => {
    const { n, renderer, frame, img, load } = mounted({ crop: rightHalf, fit: "contain" });
    load();
    renderer.update({ ...n, fit: "cover" });
    expect(box(frame)).toEqual(["0px", "0px", "200px", "100px"]);
    renderer.update({ ...n, crop: null, fit: "contain" });
    expect(box(frame)).toEqual(["0px", "0px", "200px", "100px"]);
    expect(box(img)).toEqual(["0px", "0px", "200px", "100px"]);
    // A shorter node, 200x50: the 100x100 crop is scaled by 0.5 and centred (x 75), so the whole image is 100x50, at x 25 in the box and so -50 in the frame.
    renderer.update({ ...n, crop: rightHalf, fit: "contain", height: 50 });
    expect(box(frame)).toEqual(["75px", "0px", "50px", "50px"]);
    expect(box(img)).toEqual(["-50px", "0px", "100px", "50px"]);
  });
});

describe("the frame on the stage", () => {
  const registries = () => {
    const r = createRegistries();
    for (const paint of builtinPaintTypes) r.paints.register(paint);
    return r;
  };
  const hatch = { type: "pattern", pattern: "hatch", fg: "#123456", bg: null, scale: 1, angle: 0 };

  beforeEach(() => vi.stubGlobal("DOMParser", new Window().DOMParser));
  afterEach(() => vi.unstubAllGlobals());

  test("is an SVG of the export's fragment over the node's box, between the body and the badge, and follows edits", () => {
    const n = node({ frame: { paint: hatch, width: 3, dash: "solid" } });
    const host = new FakeEl();
    const ctx = { registries: registries(), resolved: () => undefined, openLink: () => {}, component: {} };
    const renderer = fileNodeType.mount(n, host as unknown as HTMLElement, ctx as never);
    const [, frameEl] = host.children[0].children;
    expect(frameEl.cls).toEqual(["lf-frame"]);
    const svg = frameEl.children[0] as unknown as Element;
    expect(svg.getAttribute("viewBox")).toBe("10 20 100 50");
    const defs: string[] = [];
    const uids = new Map<string, number>();
    const fragment = fileFrameSvg(n, { registries: ctx.registries, defs, warnings: [], uid: (p) => `${p}-${(uids.set(p, (uids.get(p) ?? 0) + 1), uids.get(p))}` });
    // The DOM writes empty elements with an end tag; the export writes them self-closed.
    const markup = svg.outerHTML.replace(/lf-file-\d+-/g, "").replace(/><\/(path|stop|rect|circle)>/g, "/>");
    expect(markup).toContain(fragment);
    expect(markup).toContain(defs[0]);

    renderer.update({ ...n, frame: null });
    expect(frameEl.children).toEqual([]);
  });
});
