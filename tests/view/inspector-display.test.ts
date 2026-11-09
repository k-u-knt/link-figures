import { seedDisplay } from "../../src/adjust/display";
import { builtinLuts } from "../../src/adjust/luts";
import { cropCommands } from "../../src/commands/crop";
import { displayCommands } from "../../src/commands/display";
import { drawingCommands } from "../../src/commands/drawing";
import { SampleCache } from "../../src/links/decoders/sample-cache";
import type { Plane } from "../../src/links/decoders/tiff-convert";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { FileNode } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import { createRegistries } from "../../src/registry";
import { formatNumber, Inspector } from "../../src/view/inspector";
import { pageInFocus } from "../../src/view/viewport";
import { SelectionState } from "../../src/view/selection";
import { FakeEl } from "./fake-dom";

// `obsidian` ships only typings, so the file node type is loaded with it stubbed.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

/** The histogram canvas's width in CSS px, over which a handle's x maps linearly onto [lo, hi]. */
const WIDTH = 220;

/** 16-bit grey, 2×2: values 1000..4000, so a fresh display is 1000..4000 and the histogram spans the same. */
const grey16: Plane = { width: 2, height: 2, bitsPerSample: 16, samplesPerPixel: 1, data: Uint16Array.from([1000, 2000, 3000, 4000]) };

/** 16-bit RGB, 2 pixels. */
const rgb16: Plane = { width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 3, data: Uint16Array.from([100, 2000, 300, 4000, 500, 6000]) };

/**
 * An inspector on one panel (`file`), selected, with the view's `samplesNow` answering `samples()` for it: the real file
 * node type and the display, crop and drawing commands, as the plugin registers them.
 */
function setup(opts: { file?: string; samples?: () => Plane | null; second?: boolean; clock?: { now: number } } = {}) {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const panel = { ...fileNodeDefaults(page, { file: opts.file ?? "cells.tif", subpath: "", show: "image" }, []), id: "p-1" } as FileNode;
  doc.nodes.push(panel);
  if (opts.second) doc.nodes.push({ ...fileNodeDefaults(page, { file: "other.tif", subpath: "", show: "image" }, ["p-1"]), id: "p-2" } as FileNode);
  const registries = createRegistries();
  registries.nodeTypes.register(fileNodeType);
  for (const lut of builtinLuts) registries.luts.register(lut);
  for (const command of [...drawingCommands(), ...cropCommands(), ...displayCommands()]) registries.commands.register(command);
  // The store's clock as the view wires it: a gesture's start while one lasts (`PointerController.commitTime`), else the time.
  const clock = opts.clock;
  const store = createFigureStore(doc, registries, clock ? () => view.gestureStartedAt ?? clock.now : undefined);
  const selection = new SelectionState();
  let samples = opts.samples ?? (() => grey16);
  const view = {
    gestureStartedAt: null as number | null,
    readOnly: false,
    store,
    selection,
    plugin: { registries },
    focusPage: () => pageInFocus(store.doc, selection.ids, store.doc.pages[0])!,
    imageSizeNow: () => ({ width: 2, height: 2 }),
    imageStateNow: () => "image",
    samplesNow: (id: string) => (id === "p-1" ? samples() : null),
    commandContext: () => ({ app: {} as never, registries, view, store, selection: selection.ids, page: view.focusPage() }),
  };
  const el = new FakeEl("div");
  const notices: string[] = [];
  const inspector = new Inspector(view as never, el as never, (message) => notices.push(message));
  store.subscribe(() => inspector.render());
  selection.onChange(() => inspector.render());
  selection.set(opts.second ? ["p-1", "p-2"] : ["p-1"]);
  const labels: string[] = [];
  store.subscribe((ev) => labels.push(ev.label));
  const node = (id = "p-1") => store.doc.nodes.find((n) => n.id === id) as FileNode;
  const channels = (id = "p-1") => node(id).adjustments.find((a) => a.type === "display")?.params.channels as Record<string, unknown>[] | undefined;
  return { view, selection, store, el, inspector, notices, labels, registries, node, channels, setSamples: (f: () => Plane | null) => (samples = f) };
}

const keysOf = (el: FakeEl) => el.findAll((e) => "data-key" in e.attrs).map((e) => e.attrs["data-key"]);
const displayKeys = (el: FakeEl) => keysOf(el).filter((k) => k.startsWith("display."));
const headings = (el: FakeEl) => el.findAll((e) => e.hasClass("lf-field-heading")).map((e) => e.text);
const canvasOf = (el: FakeEl, channel = 0) => {
  const canvas = el.control(`display.${channel}.histogram`).find((e) => e.tag === "canvas");
  if (!canvas) throw new Error("no canvas");
  return canvas;
};

/** A pointer event at `x` CSS px across the canvas. */
const at = (x: number) => ({ offsetX: x, pointerId: 1, button: 0, preventDefault: () => {} });

describe("the Display section", () => {
  test("shows for a TIFF panel with loaded samples: a header, LUT, min, max, gamma, visible and the histogram", () => {
    const { el } = setup();
    expect(headings(el)).toEqual(["Grey"]);
    expect(displayKeys(el)).toEqual(["display.0.lut", "display.0.min", "display.0.max", "display.0.gamma", "display.0.visible", "display.0.histogram"]);
    expect(el.control("display.0.lut").value).toBe("grey");
    expect(el.control("display.0.min").value).toBe("1000");
    expect(el.control("display.0.max").value).toBe("4000");
    expect(el.control("display.0.gamma").value).toBe("1");
    expect(el.control("display.0.visible").checked).toBe(true);
    // The LUT select lists the registered LUTs.
    const options = el.control("display.0.lut").findAll((e) => e.tag === "option").map((e) => e.value);
    expect(options).toEqual(builtinLuts.map((l) => l.id));
    // The canvas is 220×60 CSS px, its bitmap at the device's pixel ratio (1 here).
    expect(canvasOf(el).hasClass("lf-histogram")).toBe(true);
    expect([canvasOf(el).attrs.width, canvasOf(el).attrs.height]).toEqual(["220", "60"]);
  });

  test("is absent for an SVG panel, and for a PDF one", () => {
    expect(displayKeys(setup({ file: "plot.svg" }).el)).toEqual([]);
    expect(displayKeys(setup({ file: "plot.pdf" }).el)).toEqual([]);
  });

  test("is absent while the samples are null and there is no display, and appears when they land (Review Focus 5)", () => {
    let plane: Plane | null = null;
    const t = setup({ samples: () => plane });
    expect(displayKeys(t.el)).toEqual([]);
    expect(t.notices).toEqual([]);
    plane = grey16;
    // What the view does when samples land: it draws its chrome again.
    t.inspector.render();
    expect(displayKeys(t.el)).toContain("display.0.min");
    expect(t.el.control("display.0.max").value).toBe("4000");
  });

  test("a panel with a display adjustment shows it without samples, read from the adjustment", () => {
    const t = setup();
    t.el.typeInto("display.0.max", "3000");
    t.setSamples(() => null);
    t.inspector.render();
    expect(t.el.control("display.0.max").value).toBe("3000");
    expect(t.el.control("display.0.min").value).toBe("1000");
  });

  test("a 16-bit RGB panel shows 3 channel blocks with seeded values", () => {
    const { el } = setup({ samples: () => rgb16 });
    expect(headings(el)).toEqual(["Red", "Green", "Blue"]);
    const seed = seedDisplay(rgb16, "auto");
    for (let c = 0; c < 3; c++) {
      expect(el.control(`display.${c}.lut`).value).toBe(seed[c].lut);
      expect(el.control(`display.${c}.min`).value).toBe(formatNumber(seed[c].min));
      expect(el.control(`display.${c}.max`).value).toBe(formatNumber(seed[c].max));
      expect(el.control(`display.${c}.histogram`)).toBeTruthy();
    }
  });

  test("changing the LUT select writes one panel.display", () => {
    const t = setup({ samples: () => rgb16 });
    const run = vi.spyOn(t.registries.commands.get("panel.display")!, "run");
    const select = t.el.control("display.1.lut");
    select.value = "fire";
    select.fire("change");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual({ id: "p-1", channel: 1, set: { lut: "fire" } });
    expect(t.labels).toEqual(["inspect:display.1.lut"]);
    expect(t.channels()?.map((c) => c.lut)).toEqual(["red", "fire", "blue"]);
    expect(t.el.control("display.1.lut").value).toBe("fire");
  });

  test("gamma, min and the visible toggle write their channel's property", () => {
    const t = setup();
    t.el.typeInto("display.0.gamma", "2");
    t.el.typeInto("display.0.min", "1500");
    const visible = t.el.control("display.0.visible");
    visible.checked = false;
    visible.fire("change");
    expect(t.channels()).toEqual([{ min: 1500, max: 4000, gamma: 2, lut: "grey", visible: false }]);
  });

  test("with several panels selected it shows the first one's display and writes to it only", () => {
    const t = setup({ second: true });
    expect(headings(t.el)).toEqual(["Grey"]);
    t.el.typeInto("display.0.max", "3000");
    expect(t.channels("p-1")?.[0].max).toBe(3000);
    expect(t.channels("p-2")).toBeUndefined();
    expect(t.notices).toEqual([]);
  });
});

describe("the histogram", () => {
  test("dragging the max handle over 3 moves is 3 commits in one undo step, ending at the value under the release x", () => {
    const t = setup();
    // An edit of max just before the drag stays a step of its own.
    t.el.typeInto("display.0.max", "3900");
    t.labels.length = 0;
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(WIDTH));
    canvas.fire("pointermove", at(200));
    canvas.fire("pointermove", at(150));
    canvas.fire("pointermove", at(110));
    canvas.fire("pointerup", at(110));
    expect(t.labels).toEqual(["inspect:display.0.max", "inspect:display.0.max", "inspect:display.0.max"]);
    // [lo, hi] = [1000, 4000]: x 110 of 220 is half way.
    expect(t.channels()?.[0].max).toBe(2500);
    expect(t.el.control("display.0.max").value).toBe("2500");

    // Release ended the step: an edit straight after is a step of its own.
    t.el.typeInto("display.0.max", "3000");
    t.store.undo();
    expect(t.channels()?.[0].max).toBe(2500);
    t.store.undo();
    expect(t.channels()?.[0].max).toBe(3900);
  });

  test("a drag that rests longer than the merge window between moves is still one undo step", () => {
    const clock = { now: Date.now() };
    const t = setup({ clock });
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(WIDTH));
    canvas.fire("pointermove", at(200));
    clock.now += 1000;
    canvas.fire("pointermove", at(150));
    clock.now += 1000;
    canvas.fire("pointermove", at(110));
    canvas.fire("pointerup", at(110));
    expect(t.labels).toHaveLength(3);
    expect(t.channels()?.[0].max).toBe(2500);
    t.store.undo();
    expect(t.channels()).toBeUndefined();
    expect(t.store.canUndo()).toBe(false);
  });

  test("after the release commits are stamped with their own time again: a typed edit soon after is its own step", () => {
    const clock = { now: Date.now() };
    const t = setup({ clock });
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(WIDTH));
    canvas.fire("pointermove", at(110));
    canvas.fire("pointerup", at(110));
    t.el.typeInto("display.0.max", "3000");
    clock.now += 100;
    t.el.typeInto("display.0.max", "3100");
    // The two typed edits merge with each other (100 ms apart), not with the drag.
    t.store.undo();
    expect(t.channels()?.[0].max).toBe(2500);
  });

  test("the section going away (nothing to inspect) mid-drag clears the gesture stamp; a later same-label commit far apart is its own step", () => {
    const clock = { now: Date.now() };
    const t = setup({ clock });
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(WIDTH));
    canvas.fire("pointermove", at(110));
    expect(t.view.gestureStartedAt).not.toBeNull();
    // `describe` gives no section when the file could not be read.
    t.view.readOnly = true;
    t.inspector.render();
    expect(t.view.gestureStartedAt).toBeNull();
    clock.now += 5000;
    t.view.readOnly = false;
    t.inspector.render();
    t.el.typeInto("display.0.max", "3000");
    t.store.undo();
    expect(t.channels()?.[0].max).toBe(2500);
  });

  test("the whole drag is undone at once", () => {
    const t = setup();
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(WIDTH));
    canvas.fire("pointermove", at(200));
    canvas.fire("pointermove", at(150));
    canvas.fire("pointerup", at(150));
    expect(t.channels()?.[0].max).toBe(Math.round(1000 + (150 / WIDTH) * 3000));
    t.store.undo();
    expect(t.channels()).toBeUndefined();
  });

  test("the min handle stops at max", () => {
    const t = setup();
    t.el.typeInto("display.0.max", "2500");
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(0));
    canvas.fire("pointermove", at(WIDTH));
    canvas.fire("pointerup", at(WIDTH));
    expect(t.channels()?.[0]).toMatchObject({ min: 2500, max: 2500 });
  });

  test("the max handle stops at min", () => {
    const t = setup();
    t.el.typeInto("display.0.min", "2500");
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(WIDTH));
    canvas.fire("pointermove", at(0));
    canvas.fire("pointerup", at(0));
    expect(t.channels()?.[0]).toMatchObject({ min: 2500, max: 2500 });
  });

  test("on a flat black plane the min handle at the left writes 0, never -0", () => {
    const flat: Plane = { width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: new Uint16Array(2) };
    const t = setup({ samples: () => flat });
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(0));
    canvas.fire("pointermove", at(0));
    canvas.fire("pointerup", at(0));
    expect(Object.is(t.channels()?.[0].min, 0)).toBe(true);
  });

  test("a move without a press writes nothing", () => {
    const t = setup();
    canvasOf(t.el).fire("pointermove", at(100));
    expect(t.labels).toEqual([]);
  });

  test("a drag on a 2000×2000 16-bit plane reads the cached plane and never decodes again (Review Focus 3)", () => {
    const big: Plane = { width: 2000, height: 2000, bitsPerSample: 16, samplesPerPixel: 1, data: new Uint16Array(2000 * 2000) };
    for (let i = 0; i < big.data.length; i++) big.data[i] = i % 4096;
    const cache = new SampleCache();
    const key = JSON.stringify(["cells.tif", 1, 0]);
    cache.set(key, big);
    const decode = vi.fn();
    const get = vi.spyOn(cache, "get");
    const t = setup({ samples: () => cache.get(key) ?? (decode(), null) });
    const canvas = canvasOf(t.el);
    canvas.fire("pointerdown", at(WIDTH));
    canvas.fire("pointermove", at(200));
    canvas.fire("pointermove", at(180));
    canvas.fire("pointermove", at(160));
    canvas.fire("pointerup", at(160));
    expect(decode).not.toHaveBeenCalled();
    expect(get.mock.results.every((r) => r.value === big)).toBe(true);
    expect(t.labels).toHaveLength(3);
    expect(t.channels()?.[0].max).toBe(Math.round((160 / WIDTH) * 4095));
  });
});
