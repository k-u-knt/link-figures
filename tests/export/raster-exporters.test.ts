import UTIF from "utif";
import { crc32 } from "node:zlib";
import { createPngExporter, createTiffExporter, pngExporter, tiffExporter } from "../../src/export/exporters/raster";
import type { RasterBackend, RasterImage } from "../../src/export/rasterise";
import { createDocument, createPage } from "../../src/model/defaults";
import type { ExportInput } from "../../src/registry/exporter";
import { createRegistries } from "../../src/registry";

const input = (over: Partial<ExportInput> = {}): ExportInput => {
  const doc = createDocument("nature-double");
  doc.pages.push(createPage("a4-portrait", [doc.pages[0].id]));
  return {
    doc,
    pages: doc.pages,
    svgs: new Map(doc.pages.map((p) => [p.id, `<svg id="${p.name}"/>`])),
    assets: new Map(),
    registries: createRegistries(),
    warnings: [],
    baseName: "Untitled figure",
    dpi: 300,
    ...over,
  };
};

/** A tiny PNG's chunks: signature, IHDR, one IDAT, IEND (enough for `withPhys`). */
function tinyPng(): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0));
    const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    return [...be(data.length), ...t, ...data, ...be(crc32(Uint8Array.from([...t, ...data])))];
  };
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), ...chunk("IDAT", [1]), ...chunk("IEND", [])]);
}

/** A rasteriser that records its calls and answers with a flat image of the size asked for, in a colour per call. */
function fakeBackend(fail: (svg: string) => boolean = () => false) {
  const calls: { svg: string; width: number; height: number; background: string }[] = [];
  const encoded: RasterImage[] = [];
  const backend: RasterBackend = {
    async rasterise(svg, width, height, background) {
      calls.push({ svg, width, height, background });
      if (fail(svg)) throw new Error("the page's SVG could not be loaded as an image");
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) data.set([calls.length * 10, 20, 30, 255], i);
      return { width, height, data };
    },
    async encodePng(image) {
      encoded.push(image);
      return tinyPng();
    },
  };
  return { backend, calls, encoded };
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

test("PNG and TIFF describe themselves, and embed PDF panels as rasters", () => {
  expect(pngExporter).toMatchObject({ id: "png", name: "PNG", ext: "png", mime: "image/png", pdfPanels: "raster" });
  expect(tiffExporter).toMatchObject({ id: "tiff", name: "TIFF", ext: "tif", mime: "image/tiff", pdfPanels: "raster" });
  expect(pngExporter.options()).toEqual([]);
  expect(tiffExporter.options()).toEqual([
    { kind: "select", key: "compression", label: "Compression", options: [{ value: "deflate", label: "Deflate" }, { value: "none", label: "None" }] },
  ]);
});

test("PNG: one file per page, each page drawn at dpi / 96 onto its paper, with the dpi in pHYs", async () => {
  const { backend, calls, encoded } = fakeBackend();
  const run = input();
  run.pages[1].paper = "#ffeecc";
  const { files, warnings } = await createPngExporter(backend).run(run, {});
  expect(files.map((f) => f.name)).toEqual(["Untitled figure - Page 1.png", "Untitled figure - Page 2.png"]);
  expect(files.map((f) => f.blob.type)).toEqual(["image/png", "image/png"]);
  // 183 × 170 mm and 210 × 297 mm at 300 dpi.
  expect(calls).toEqual([
    { svg: '<svg id="Page 1"/>', width: 2161, height: 2008, background: "#ffffff" },
    { svg: '<svg id="Page 2"/>', width: 2480, height: 3508, background: "#ffeecc" },
  ]);
  expect(encoded.map((i) => [i.width, i.height])).toEqual([[2161, 2008], [2480, 3508]]);
  const png = await bytesOf(files[0].blob);
  const at = png.findIndex((_, i) => String.fromCharCode(...png.subarray(i, i + 4)) === "pHYs");
  expect(new DataView(png.buffer).getUint32(at + 4)).toBe(11811);
  expect(warnings).toEqual([]);
});

test("TIFF: one RGB file per page, deflate by default, the dpi as its resolution", async () => {
  const { backend } = fakeBackend();
  const run = input({ dpi: 96 });
  const { files } = await createTiffExporter(backend).run(run, {});
  expect(files.map((f) => f.name)).toEqual(["Untitled figure - Page 1.tif", "Untitled figure - Page 2.tif"]);
  expect(files[0].blob.type).toBe("image/tiff");
  const bytes = await bytesOf(files[0].blob);
  const [ifd] = UTIF.decode(bytes);
  expect(ifd.t259).toEqual([8]);
  expect(ifd.t282).toEqual([96]);
  expect(ifd.t277).toEqual([3]);
  UTIF.decodeImage(bytes, ifd);
  // 183 mm at 96 dpi is 692 px.
  expect([ifd.width, ifd.height]).toEqual([692, 643]);
  expect([...ifd.data.subarray(0, 6)]).toEqual([10, 20, 30, 10, 20, 30]);
});

test("TIFF: compression none is uncompressed", async () => {
  const { backend } = fakeBackend();
  const { files } = await createTiffExporter(backend).run(input({ dpi: 72 }), { compression: "none" });
  const [ifd] = UTIF.decode(await bytesOf(files[0].blob));
  expect(ifd.t259).toEqual([1]);
});

test("a transparent paper is flattened onto white", async () => {
  for (const paper of ["transparent", "none", "", "  TRANSPARENT "]) {
    const { backend, calls } = fakeBackend();
    const run = input();
    run.pages = [run.pages[0]];
    run.pages[0].paper = paper;
    await createPngExporter(backend).run(run, {});
    expect(calls[0].background).toBe("#ffffff");
  }
});

test("a page over the canvas limits is drawn at the largest dpi that fits, and that is said", async () => {
  const { backend, calls } = fakeBackend();
  const run = input({ dpi: 1200 });
  run.pages = [run.pages[1]];
  run.pages[0].width = 1000;
  const { files, warnings } = await createTiffExporter(backend).run(run, { compression: "none" });
  expect(files).toHaveLength(1);
  expect(calls[0].width).toBeLessThanOrEqual(16384);
  expect(warnings).toEqual(['"Page 2": drawn at 416 dpi (the largest that fits)']);
  const [ifd] = UTIF.decode(await bytesOf(files[0].blob));
  expect(ifd.t282).toEqual([416]);
});

test("a page that cannot be drawn is a warning, and the other pages are still exported", async () => {
  const { backend } = fakeBackend((svg) => svg.includes("Page 1"));
  const { files, warnings } = await createPngExporter(backend).run(input({ warnings: ["from the builder"] }), {});
  expect(files.map((f) => f.name)).toEqual(["Untitled figure - Page 2.png"]);
  expect(warnings).toEqual(["from the builder", `"Page 1": could not be drawn: the page's SVG could not be loaded as an image`]);
});

test("a rasteriser that answers with the wrong size is a failed page", async () => {
  const { backend } = fakeBackend();
  const wrong: RasterBackend = { ...backend, rasterise: async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }) };
  const run = input();
  run.pages = [run.pages[0]];
  const { files, warnings } = await createTiffExporter(wrong).run(run, {});
  expect(files).toEqual([]);
  expect(warnings).toEqual(['"Page 1": could not be drawn: the drawn image is 1 × 1 px, not 2161 × 2008']);
});

test("the builder's plain 'PDF panel rasterised' notes are dropped (everything is a raster here); a lower panel dpi is kept", async () => {
  const { backend } = fakeBackend();
  const run = input({ warnings: ["Panel A: PDF panel rasterised", "Panel B: PDF panel rasterised at 400 dpi, not 600: too large"] });
  run.pages = [run.pages[0]];
  const { warnings } = await createPngExporter(backend).run(run, {});
  expect(warnings).toEqual(["Panel B: PDF panel rasterised at 400 dpi, not 600: too large"]);
});

test("a page with no SVG is an error, as for the other exporters", async () => {
  const { backend } = fakeBackend();
  await expect(createPngExporter(backend).run(input({ svgs: new Map() }), {})).rejects.toThrow('No SVG was built for page "Page 1"');
});
