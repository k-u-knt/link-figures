import UTIF from "utif";
import { createDecoders } from "../../src/links/decoders";
import { SampleCache } from "../../src/links/decoders/sample-cache";
import type { Plane } from "../../src/links/decoders/tiff-convert";
import { resolveFileNode, samplesKey } from "../../src/links/resolver";
import type { FileRef } from "../../src/links/types";
import { createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";
import { testRegistry } from "../adjust/fixtures";
import { FakeAccess } from "./fake-access";

vi.mock("obsidian", () => ({ loadPdfJs: vi.fn() }));

// No canvas under node: the PNG encode is the one part of the TIFF path stubbed out.
vi.mock("../../src/links/decoders/raster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/links/decoders/raster")>()),
  rgbaToPngDataUrl: vi.fn(() => "data:png"),
}));

/** A little-endian TIFF of one 16-bit grey row holding `values`. */
function buildTiff(values: number[]): ArrayBuffer {
  const tags = 9;
  const ifdSize = 2 + tags * 12 + 4;
  const view = new DataView(new ArrayBuffer(8 + ifdSize + values.length * 2));
  const data = 8 + ifdSize;
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  const entries = [[256, 3, values.length], [257, 3, 1], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, data], [277, 3, 1], [278, 3, 1], [279, 4, values.length * 2]];
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, value], i) => {
    const entry = 10 + i * 12;
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, 1, true);
    if (type === 3) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
  });
  values.forEach((value, i) => view.setUint16(data + i * 2, value, true));
  return view.buffer;
}

/** A plane whose sample data claims `bytes` bytes, without allocating them. */
const sized = (bytes: number): Plane => ({ width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 1, data: { byteLength: bytes } as Uint8Array });

describe("SampleCache", () => {
  test("keeps at most 4 planes, evicting the least recently used", () => {
    const cache = new SampleCache();
    const planes = [1, 2, 3, 4, 5].map(() => sized(10));
    planes.slice(0, 4).forEach((p, i) => cache.set(`k${i}`, p));
    // Reading k0 makes k1 the oldest.
    expect(cache.get("k0")).toBe(planes[0]);
    cache.set("k4", planes[4]);
    expect(cache.get("k1")).toBeUndefined();
    expect(["k0", "k2", "k3", "k4"].map((k) => cache.get(k))).toEqual([planes[0], planes[2], planes[3], planes[4]]);
  });

  test("keeps at most 400 MB of sample data, evicting the oldest past it", () => {
    const cache = new SampleCache();
    cache.set("a", sized(150e6));
    cache.set("b", sized(150e6));
    cache.set("c", sized(150e6));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    // A plane bigger than the cap alone is still kept, as the newest.
    cache.set("huge", sized(500e6));
    expect([cache.get("b"), cache.get("c")]).toEqual([undefined, undefined]);
    expect(cache.get("huge")).toBeDefined();
  });

  test("setting a key again replaces its plane and counts its bytes once", () => {
    const cache = new SampleCache();
    cache.set("a", sized(300e6));
    cache.set("a", sized(300e6));
    cache.set("b", sized(90e6));
    expect(cache.get("a")).toBeDefined();
  });
});

describe("decoders with a samples key", () => {
  const recipe = (min: number) => ({ range: { min, max: 4000 }, adjustments: [] });

  test("a second render with a new recipe and the same key does not decode the TIFF again", async () => {
    const decode = vi.spyOn(UTIF, "decode");
    decode.mockClear();
    const decoders = createDecoders(testRegistry());
    const bytes = buildTiff([100, 2000]);
    await decoders.tiff(bytes, 0, recipe(0), "k");
    await decoders.tiff(new ArrayBuffer(0), 0, recipe(500), "k");
    expect(decode).toHaveBeenCalledTimes(1);
    expect([...(decoders.samples("k")?.data ?? [])]).toEqual([100, 2000]);
    // Without a key nothing is cached.
    await decoders.tiff(bytes, 0, recipe(0));
    expect(decode).toHaveBeenCalledTimes(2);
  });

  test("decodeSamples fills the cache without rendering", async () => {
    const decoders = createDecoders(testRegistry());
    const plane = await decoders.decodeSamples(buildTiff([7, 8]), "tiff", 0, "t");
    expect(decoders.samples("t")).toBe(plane);
    expect([...plane.data]).toEqual([7, 8]);
  });
});

describe("the resolver keys the samples by path and mtime", () => {
  function setup() {
    const access = new FakeAccess({ files: { "cells.tif": "BINARY" }, mtimes: { "cells.tif": 1 } });
    const reads: string[] = [];
    access.readBinary = async (file: FileRef) => {
      reads.push(file.path);
      return buildTiff([100, 2000]);
    };
    const decoders = createDecoders(testRegistry());
    const decode = vi.spyOn(UTIF, "decode");
    decode.mockClear();
    const node = (range: FileNode["range"]): FileNode => ({ ...fileNodeDefaults(createPage("a4-portrait", []), { file: "cells.tif", subpath: "", show: "image" }, []), range });
    return { access, reads, decoders, decode, node };
  }

  test("a new range on the same file reads and decodes nothing again (Review Focus 3)", async () => {
    const t = setup();
    expect((await resolveFileNode(t.node("auto"), "f.lnkfig.md", t.access, t.decoders)).kind).toBe("image");
    await resolveFileNode(t.node({ min: 0, max: 1000 }), "f.lnkfig.md", t.access, t.decoders);
    expect(t.reads).toEqual(["cells.tif"]);
    expect(t.decode).toHaveBeenCalledTimes(1);
  });

  test("a different mtime misses: the changed file is read and decoded again (Review Focus 2)", async () => {
    const t = setup();
    await resolveFileNode(t.node("auto"), "f.lnkfig.md", t.access, t.decoders);
    t.access.setMtime("cells.tif", 2);
    await resolveFileNode(t.node("auto"), "f.lnkfig.md", t.access, t.decoders);
    expect(t.reads).toEqual(["cells.tif", "cells.tif"]);
    expect(t.decode).toHaveBeenCalledTimes(2);
  });

  test("a different size with the same mtime misses too", async () => {
    const t = setup();
    await resolveFileNode(t.node("auto"), "f.lnkfig.md", t.access, t.decoders);
    t.access.setSize("cells.tif", 99);
    await resolveFileNode(t.node("auto"), "f.lnkfig.md", t.access, t.decoders);
    expect(t.reads).toHaveLength(2);
  });

  test("without an mtime nothing is cached", async () => {
    const t = setup();
    t.access.setMtime("cells.tif", null);
    await resolveFileNode(t.node("auto"), "f.lnkfig.md", t.access, t.decoders);
    await resolveFileNode(t.node("auto"), "f.lnkfig.md", t.access, t.decoders);
    expect(t.reads).toHaveLength(2);
  });
});

describe("samplesKey", () => {
  const access = new FakeAccess({ files: { "a.tif": "BINARY", "a.png": "BINARY" }, mtimes: { "a.tif": 5, "a.png": 5 }, sizes: { "a.tif": 10 } });
  const tif = { path: "a.tif", extension: "tif" };

  test("a TIFF page index is truncated and clamped at 0 as decodeTiffPage does", () => {
    const zero = samplesKey(tif, "tiff", 0, access);
    expect([-3, 0.7, Number.NaN].map((i) => samplesKey(tif, "tiff", i, access))).toEqual([zero, zero, zero]);
    expect(samplesKey(tif, "tiff", 1.9, access)).toBe(samplesKey(tif, "tiff", 1, access));
    expect(samplesKey(tif, "tiff", 1, access)).not.toBe(zero);
  });

  test("a raster key ignores the page; other sources have none", () => {
    const png = { path: "a.png", extension: "png" };
    expect(samplesKey(png, "raster", 3, access)).toBe(samplesKey(png, "raster", 0, access));
    expect(samplesKey(png, "pdf", 0, access)).toBeUndefined();
  });
});
