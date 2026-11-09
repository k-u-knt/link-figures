import { cropCommands } from "../../src/commands/crop";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { createDocument, fileNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { cropKeepingImage } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import type { Document, FileNode, Node } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { Inspector } from "../../src/view/inspector";
import { SelectionState } from "../../src/view/selection";
import { pageInFocus } from "../../src/view/viewport";
import { FakeEl } from "../view/fake-dom";

// `obsidian` ships only typings, so this module cannot be loaded for real; the parts under test never touch it.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

function registries() {
  const r = createRegistries();
  r.nodeTypes.register(fileNodeType);
  r.nodeTypes.register(shapeNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const c of drawingCommands()) r.commands.register(c);
  for (const c of cropCommands()) r.commands.register(c);
  return r;
}

/** A 200×100 image shown whole in a 200×100 box at 10,10. */
function setup(partial: Partial<FileNode> = {}, natural: { width: number; height: number } | null = { width: 200, height: 100 }) {
  const doc: Document = createDocument("a4-portrait");
  const panel = { ...fileNodeDefaults(doc.pages[0], { file: "plot.png", subpath: "", show: "image" }, []), id: "p-1", x: 10, y: 10, width: 200, height: 100, ...partial } as FileNode;
  const shape = shapeNodeDefaults(doc.pages[0], { id: "s-1", x: 0, y: 0, width: 10, height: 10, z: 1 }, []);
  doc.nodes.push(panel, shape as Node);
  const r = registries();
  const store = createFigureStore(doc, r);
  const view = { imageSizeNow: (id: string) => (id === "p-1" ? natural : null) };
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: view as never, store, selection: [], page: undefined });
  const call = async (id: string, args: Record<string, unknown>, c: CommandContext = ctx()) => runCall(store, c, prepareCall(r, { id, args }));
  const node = () => store.doc.nodes.find((n) => n.id === "p-1") as FileNode;
  const box = () => ({ x: node().x, y: node().y, width: node().width, height: node().height });
  return { r, store, ctx, call, node, box };
}

describe("cropKeepingImage", () => {
  test("keeps the image's page placement and scale", () => {
    const { node } = setup();
    expect(cropKeepingImage(node(), { width: 200, height: 100 }, { x: 0.5, y: 0, w: 0.5, h: 1 })).toEqual({
      x: 110, y: 10, width: 100, height: 100, crop: { x: 0.5, y: 0, w: 0.5, h: 1 },
    });
  });
  test("a rotated panel keeps its image where it is on the page", () => {
    const { node } = setup({ rotation: 90 });
    const out = cropKeepingImage(node(), { width: 200, height: 100 }, { x: 0.5, y: 0, w: 0.5, h: 1 });
    // The right half of the image: rotated a quarter turn about the old centre (110, 60), its centre is at (110, 110).
    expect(out.x + out.width / 2).toBeCloseTo(110, 1);
    expect(out.y + out.height / 2).toBeCloseTo(110, 1);
  });
});

describe("panel.crop", () => {
  test("keep image (the default) moves the box to the region and leaves the image where it is", async () => {
    const { call, node, box } = setup();
    await call("panel.crop", { id: "p-1", crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
    expect(box()).toEqual({ x: 110, y: 10, width: 100, height: 100 });
    expect(node().crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  test("keep box leaves the box as it is and sets the crop", async () => {
    const { call, node, box } = setup();
    await call("panel.crop", { id: "p-1", crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, keep: "box" });
    expect(box()).toEqual({ x: 10, y: 10, width: 200, height: 100 });
    expect(node().crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  test("a crop is clamped to 0–1 with at least 1 % per side", async () => {
    const { call, node } = setup();
    await call("panel.crop", { id: "p-1", crop: { x: 0.2, y: 0, w: 0, h: 1 }, keep: "box" });
    expect(node().crop).toEqual({ x: 0.2, y: 0, w: 0.01, h: 1 });
    await call("panel.crop", { id: "p-1", crop: { x: 1.2, y: -0.5, w: 0.5, h: 2 }, keep: "box" });
    expect(node().crop!.x).toBeCloseTo(0.99, 10);
    expect(node().crop!.w).toBeCloseTo(0.01, 10);
    expect(node().crop!.y).toBe(0);
    expect(node().crop!.h).toBe(1);
  });

  test("a crop that is not an object is refused", async () => {
    const { call } = setup();
    await expect(call("panel.crop", { id: "p-1", crop: "half" })).rejects.toThrow(/^panel\.crop:/);
    await expect(call("panel.crop", { id: "p-1", crop: [0, 0, 1, 1] })).rejects.toThrow(/^panel\.crop:/);
  });

  test("a node that is not a file panel is refused", async () => {
    const { call } = setup();
    await expect(call("panel.crop", { id: "s-1", crop: null })).rejects.toThrow(/^panel\.crop:/);
    await expect(call("panel.crop", { id: "nope", crop: null })).rejects.toThrow(/^panel\.crop:/);
  });

  test("an effectively locked panel is refused", async () => {
    const { call } = setup({ locked: true });
    await expect(call("panel.crop", { id: "p-1", crop: null, keep: "box" })).rejects.toThrow(/^panel\.crop:.*locked/);
  });

  test("with the image size unknown, keep image is refused and keep box works", async () => {
    const { call, node } = setup({}, null);
    await expect(call("panel.crop", { id: "p-1", crop: { x: 0.5, y: 0, w: 0.5, h: 1 } })).rejects.toThrow(
      'panel.crop: the image size is not known yet; use keep "box"',
    );
    await call("panel.crop", { id: "p-1", crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, keep: "box" });
    expect(node().crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  test("headless (no view) the image size is unknown", async () => {
    const { call, ctx } = setup();
    await expect(call("panel.crop", { id: "p-1", crop: null }, { ...ctx(), view: null })).rejects.toThrow(
      'panel.crop: the image size is not known yet; use keep "box"',
    );
  });

  test("each call is one undo step", async () => {
    const { call, store, box, node } = setup();
    await call("panel.crop", { id: "p-1", crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
    await call("panel.crop", { id: "p-1", crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
    expect(box()).toEqual({ x: 110, y: 60, width: 100, height: 50 });
    store.undo();
    expect(box()).toEqual({ x: 110, y: 10, width: 100, height: 100 });
    expect(node().crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    store.undo();
    expect(box()).toEqual({ x: 10, y: 10, width: 200, height: 100 });
    expect(node().crop).toBeNull();
  });
});

describe("panel.crop-reset", () => {
  test("restores the whole image at the same scale, the image unmoved", async () => {
    const { call, node, box } = setup();
    await call("panel.crop", { id: "p-1", crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
    expect(box()).toEqual({ x: 110, y: 60, width: 100, height: 50 });
    await call("panel.crop-reset", { id: "p-1" });
    expect(box()).toEqual({ x: 10, y: 10, width: 200, height: 100 });
    expect(node().crop).toBeNull();
  });

  test("is a toolbar button in edit, labelled Reset crop, that applies to one selected cropped panel", () => {
    const { r, ctx, store } = setup({ crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    const reset = r.commands.get("panel.crop-reset")!;
    expect([reset.group, reset.icon, reset.name, !!reset.hidden]).toEqual(["edit", "crop", "Reset crop", false]);
    expect(reset.applies({ ...ctx(), selection: ["p-1"] })).toBe(true);
    expect(reset.applies({ ...ctx(), selection: [] })).toBe(false);
    expect(reset.applies({ ...ctx(), selection: ["p-1", "s-1"] })).toBe(false);
    store.commit("uncrop", (d) => { (d.nodes[0] as FileNode).crop = null; });
    expect(reset.applies({ ...ctx(), selection: ["p-1"] })).toBe(false);
  });
});

describe("inspector crop fields", () => {
  function inspect(partial: Partial<FileNode> = {}) {
    const { r, store, node, box } = setup(partial);
    const selection = new SelectionState();
    const view = {
      readOnly: false,
      store,
      selection,
      plugin: { registries: r },
      currentPage: () => store.doc.pages[0],
      focusPage: () => pageInFocus(store.doc, selection.ids, store.doc.pages[0])!,
      imageSizeNow: (id: string) => (id === "p-1" ? { width: 200, height: 100 } : null),
      commandContext: (): CommandContext => ({ app: {} as never, registries: r, view: view as never, store, selection: [...selection.ids], page: view.focusPage() }),
    };
    const el = new FakeEl("div");
    const notices: string[] = [];
    const inspector = new Inspector(view as never, el as never, (m) => notices.push(m));
    store.subscribe(() => inspector.render());
    selection.onChange(() => inspector.render());
    selection.set(["p-1"]);
    return { el, store, node, box, notices };
  }

  test("a file panel shows the four insets, in %", () => {
    const { el } = inspect({ crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } });
    expect(el.control("crop.left").value).toBe("10");
    expect(el.control("crop.top").value).toBe("20");
    expect(el.control("crop.right").value).toBe("40");
    expect(el.control("crop.bottom").value).toBe("20");
  });

  test("Crop left (%) set to 25 crops the left quarter, keeping the image where it is, as one undo step", () => {
    const { el, store, node, box, notices } = inspect();
    const seen: string[] = [];
    store.subscribe((ev) => seen.push(ev.label));
    el.typeInto("crop.left", "25");
    expect(notices).toEqual([]);
    expect(node().crop).toEqual({ x: 0.25, y: 0, w: 0.75, h: 1 });
    expect(box().x).toBe(60);
    expect(box().width).toBe(150);
    expect(seen).toEqual(["inspect:crop.left"]);
    store.undo();
    expect(node().crop).toBeNull();
  });

  test("writing one side leaves the others as they are", () => {
    const { el, node } = inspect({ crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } });
    el.typeInto("crop.right", "10");
    const crop = node().crop!;
    expect(crop.x).toBeCloseTo(0.1, 10);
    expect(crop.w).toBeCloseTo(0.8, 10);
    expect(crop.y).toBeCloseTo(0.2, 10);
    expect(crop.h).toBeCloseTo(0.6, 10);
  });
});
