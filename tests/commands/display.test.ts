import { describe, expect, it, vi } from "vitest";
import { displayAdjustment, seedDisplay, type DisplayChannel } from "../../src/adjust/display";
import { builtinLuts } from "../../src/adjust/luts";
import { recipeOf, renderSamples } from "../../src/adjust/render";
import { displayCommands } from "../../src/commands/display";
import { prepareCall, runCall } from "../../src/commands/headless";
import { planeToRgba, type Plane } from "../../src/links/decoders/tiff-convert";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Document, FileNode } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import { createRegistries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";

// `obsidian` ships only typings, so this module cannot be loaded for real; the parts under test never touch it.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

function registries() {
  const r = createRegistries();
  r.nodeTypes.register(fileNodeType);
  for (const l of builtinLuts) r.luts.register(l);
  r.adjustments.register(displayAdjustment(r.luts));
  for (const c of displayCommands()) r.commands.register(c);
  return r;
}

/** 16-bit grey, 2×2: values 1000..4000. */
const grey16: Plane = { width: 2, height: 2, bitsPerSample: 16, samplesPerPixel: 1, data: Uint16Array.from([1000, 2000, 3000, 4000]) };

/** 1000 grey 16-bit samples 0..999 (shuffled order does not matter). */
const ramp16: Plane = { width: 1000, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: Uint16Array.from({ length: 1000 }, (_, i) => 999 - i) };

/** 8-bit whiteIsZero: the user sees 255 − v. */
const wiz8: Plane = { width: 1000, height: 1, bitsPerSample: 8, samplesPerPixel: 1, data: Uint8Array.from({ length: 1000 }, (_, i) => i % 200), whiteIsZero: true };

/** 8-bit RGBA raster, 2 pixels. */
const rgba8: Plane = { width: 2, height: 1, bitsPerSample: 8, samplesPerPixel: 4, data: Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255]) };

function setup(opts: { plane?: Plane | null; file?: string; headless?: boolean; partial?: Partial<FileNode> } = {}) {
  const plane = opts.plane === undefined ? grey16 : opts.plane;
  const doc: Document = createDocument("a4-portrait");
  const panel = {
    ...fileNodeDefaults(doc.pages[0], { file: opts.file ?? "cells.tif", subpath: "", show: "image" }, []),
    id: "p-1",
    ...opts.partial,
  } as FileNode;
  doc.nodes.push(panel);
  const r = registries();
  const store = createFigureStore(doc, r);
  const view = {
    imageSizeNow: () => (plane ? { width: plane.width, height: plane.height } : null),
    imageStateNow: () => (plane ? "image" : "loading"),
    samplesNow: (id: string) => (id === "p-1" ? plane : null),
  };
  const ctx = (selection: string[] = []): CommandContext => ({
    app: {} as never,
    registries: r,
    view: opts.headless ? null : (view as never),
    store,
    selection: opts.headless ? [] : selection,
    page: undefined,
  });
  const call = async (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const node = () => store.doc.nodes.find((n) => n.id === "p-1") as FileNode;
  const channels = () => node().adjustments.find((a) => a.type === "display")?.params.channels as DisplayChannel[] | undefined;
  return { r, store, ctx, call, node, channels };
}

describe("panel.display", () => {
  it("adds one display adjustment seeded from what the panel shows, with only the LUT changed, in one undo step", async () => {
    const { call, node, channels, store } = setup({ partial: { range: { min: 1500, max: 3500 } } });
    await call("panel.display", { id: "p-1", set: { lut: "fire" } });
    expect(node().adjustments.filter((a) => a.type === "display")).toHaveLength(1);
    expect(channels()).toEqual([{ ...seedDisplay(grey16, { min: 1500, max: 3500 })[0], lut: "fire" }]);
    store.undo();
    expect(node().adjustments).toEqual([]);
  });

  it("seeds an RGBA raster with three channels and inserts display before the other adjustments", async () => {
    const other = { type: "sharpen", enabled: true, params: { amount: 1 } };
    const { call, node, channels } = setup({ plane: rgba8, file: "photo.png", partial: { adjustments: [other] } });
    await call("panel.display", { id: "p-1", channel: 2, set: { gamma: 2 } });
    expect(node().adjustments.map((a) => a.type)).toEqual(["display", "sharpen"]);
    expect(node().adjustments[1]).toEqual(other);
    const seed = seedDisplay(rgba8, "auto");
    expect(channels()).toEqual([seed[0], seed[1], { ...seed[2], gamma: 2 }]);
  });

  it("patches the existing adjustment on a second call rather than adding another", async () => {
    const { call, node, channels } = setup();
    await call("panel.display", { id: "p-1", set: { lut: "fire" } });
    await call("panel.display", { id: "p-1", set: { min: 1200, visible: false } });
    expect(node().adjustments).toHaveLength(1);
    expect(channels()![0]).toMatchObject({ min: 1200, lut: "fire", visible: false });
  });

  it("refuses a channel out of range", async () => {
    const { call } = setup();
    await expect(call("panel.display", { id: "p-1", channel: 1, set: { lut: "fire" } })).rejects.toThrow(/panel\.display: .*channel/);
  });

  it("refuses gamma 0", async () => {
    const { call } = setup();
    await expect(call("panel.display", { id: "p-1", set: { gamma: 0 } })).rejects.toThrow(/panel\.display: .*gamma/);
  });

  it("refuses an unknown LUT", async () => {
    const { call } = setup();
    await expect(call("panel.display", { id: "p-1", set: { lut: "nope" } })).rejects.toThrow(/panel\.display: .*"nope"/);
  });

  it("clamps min and max to the plane's value range", async () => {
    const { call, channels } = setup({ plane: { ...grey16, bitsPerSample: 8, data: Uint8Array.from([1, 2, 3, 4]) } });
    await call("panel.display", { id: "p-1", set: { min: 300, max: -5 } });
    expect(channels()![0]).toMatchObject({ min: 255, max: 0 });
  });

  it("headless with no adjustment refuses: the image is not loaded", async () => {
    const { call } = setup({ headless: true });
    await expect(call("panel.display", { id: "p-1", set: { lut: "fire" } })).rejects.toThrow("panel.display: the image is not loaded; open the figure");
  });

  it("headless with an existing adjustment patches it", async () => {
    const seeded = { type: "display", enabled: true, params: { channels: seedDisplay(grey16, "auto") } };
    const { call, channels } = setup({ headless: true, partial: { adjustments: [seeded] } });
    await call("panel.display", { id: "p-1", set: { lut: "viridis", max: 3000 } });
    expect(channels()).toEqual([{ ...seedDisplay(grey16, "auto")[0], lut: "viridis", max: 3000 }]);
  });

  it("refuses with the not-loaded message when the view has no samples yet (Review Focus 5)", async () => {
    const { call } = setup({ plane: null });
    await expect(call("panel.display", { id: "p-1", set: { lut: "fire" } })).rejects.toThrow("panel.display: the image is not loaded; open the figure");
  });

  it("refuses an SVG panel as a vector panel", async () => {
    const { call } = setup({ file: "diagram.svg" });
    await expect(call("panel.display", { id: "p-1", set: { lut: "fire" } })).rejects.toThrow('panel.display: "p-1" is a vector panel');
  });

  it("refuses a locked panel and a panel showing content", async () => {
    await expect(setup({ partial: { locked: true } }).call("panel.display", { id: "p-1", set: {} })).rejects.toThrow('"p-1" is locked');
    await expect(setup({ partial: { show: "content" } }).call("panel.display", { id: "p-1", set: {} })).rejects.toThrow('"p-1" shows no image');
  });
});

describe("panel.display-auto", () => {
  it("sets min and max to the 0.35/99.65 percentiles", async () => {
    const { call, channels } = setup({ plane: ramp16 });
    await call("panel.display-auto", { id: "p-1" });
    expect(channels()![0]).toMatchObject({ min: 3, max: 996, lut: "grey", gamma: 1 });
  });

  it("works in the inverted values of a whiteIsZero plane (Review Focus 4)", async () => {
    const { call, channels } = setup({ plane: wiz8, file: "scan.tif" });
    await call("panel.display-auto", { id: "p-1", saturation: 0 });
    // Raw samples 0..199, so the user sees 56..255.
    expect(channels()![0]).toMatchObject({ min: 56, max: 255 });
  });

  it("refuses with the not-loaded message when there are no samples", async () => {
    const { call } = setup({ plane: null });
    await expect(call("panel.display-auto", { id: "p-1" })).rejects.toThrow("panel.display-auto: the image is not loaded; open the figure");
  });

  it("is in the palette under style, applying to one selected image panel", () => {
    const { r, ctx } = setup();
    const command = r.commands.get("panel.display-auto")!;
    expect(command).toMatchObject({ name: "Auto display range", group: "style", icon: "contrast" });
    expect(command.hidden).toBeFalsy();
    expect(command.applies(ctx(["p-1"]))).toBe(true);
    expect(command.applies(ctx([]))).toBe(false);
    expect(setup({ file: "diagram.svg" }).r.commands.get("panel.display-auto")!.applies(setup({ file: "diagram.svg" }).ctx(["p-1"]))).toBe(false);
  });
});

describe("panel.display-reset", () => {
  it("removes the display adjustment, and the render then equals today's", async () => {
    const other = { type: "sharpen", enabled: true, params: {} };
    const { call, node, r } = setup({ partial: { adjustments: [other] } });
    const before = renderSamples(grey16, recipeOf(node()), r.adjustments);
    await call("panel.display", { id: "p-1", set: { lut: "fire" } });
    await call("panel.display-reset", { id: "p-1" });
    expect(node().adjustments).toEqual([other]);
    expect(renderSamples(grey16, recipeOf(node()), r.adjustments)).toEqual(before);
    expect([...before.data]).toEqual([...planeToRgba(grey16, node().range).rgba]);
  });

  it("applies only to a selected panel that has a display adjustment", async () => {
    const { r, ctx, call } = setup();
    const command = r.commands.get("panel.display-reset")!;
    expect(command).toMatchObject({ name: "Reset display", group: "style" });
    expect(command.applies(ctx(["p-1"]))).toBe(false);
    await call("panel.display", { id: "p-1", set: { lut: "fire" } });
    expect(command.applies(ctx(["p-1"]))).toBe(true);
  });
});

describe("panel.histogram", () => {
  it("returns dataMin, dataMax, lo, hi, bitsPerSample and counts summing to the pixel count", async () => {
    const { call } = setup({ plane: ramp16 });
    const out = (await call("panel.histogram", { id: "p-1", bins: 10 })) as Record<string, unknown>;
    expect(out).toMatchObject({ dataMin: 0, dataMax: 999, lo: 0, hi: 999, bitsPerSample: 16 });
    const counts = out.counts as number[];
    expect(counts).toHaveLength(10);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("defaults to 256 bins and does not commit", async () => {
    const { call, store } = setup();
    const out = (await call("panel.histogram", { id: "p-1" })) as { counts: number[] };
    expect(out.counts).toHaveLength(256);
    expect(store.canUndo()).toBe(false);
  });

  it("spans to include display min and max outside the data", async () => {
    const seeded = { type: "display", enabled: true, params: { channels: [{ min: 500, max: 5000, gamma: 1, lut: "grey", visible: true }] } };
    const { call } = setup({ partial: { adjustments: [seeded] } });
    expect(await call("panel.histogram", { id: "p-1" })).toMatchObject({ dataMin: 1000, dataMax: 4000, lo: 500, hi: 5000 });
  });

  it("spans the panel's range when there is no adjustment", async () => {
    const { call } = setup({ partial: { range: { min: 0, max: 10000 } } });
    expect(await call("panel.histogram", { id: "p-1" })).toMatchObject({ dataMin: 1000, dataMax: 4000, lo: 0, hi: 10000 });
  });

  it("widens a flat channel by ±0.5", async () => {
    const flat: Plane = { width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: Uint16Array.from([700, 700]) };
    const { call } = setup({ plane: flat });
    expect(await call("panel.histogram", { id: "p-1", bins: 3 })).toMatchObject({ dataMin: 700, dataMax: 700, lo: 699.5, hi: 700.5, counts: [0, 2, 0] });
  });

  it("uses the inverted values of a whiteIsZero plane (Review Focus 4)", async () => {
    const { call } = setup({ plane: wiz8 });
    expect(await call("panel.histogram", { id: "p-1" })).toMatchObject({ dataMin: 56, dataMax: 255, bitsPerSample: 8 });
  });

  it("reads the asked channel of an RGB plane", async () => {
    const { call } = setup({ plane: rgba8, file: "photo.png" });
    expect(await call("panel.histogram", { id: "p-1", channel: 1 })).toMatchObject({ dataMin: 20, dataMax: 50 });
    await expect(call("panel.histogram", { id: "p-1", channel: 3 })).rejects.toThrow(/panel\.histogram: .*channel/);
  });

  it("refuses bins above 4096", async () => {
    const { call } = setup();
    await expect(call("panel.histogram", { id: "p-1", bins: 4097 })).rejects.toThrow(/panel\.histogram: .*bins/);
  });

  it("refuses with the not-loaded message when there are no samples", async () => {
    const { call } = setup({ plane: null });
    await expect(call("panel.histogram", { id: "p-1" })).rejects.toThrow("panel.histogram: the image is not loaded; open the figure");
  });
});
