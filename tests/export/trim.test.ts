import type { AssetMap, FileAsset, ImageAsset, PdfAsset, SvgAsset } from "../../src/export/asset-types";
import { buildPageSvg } from "../../src/export/svg-builder";
import { trimAssets, type TrimDeps } from "../../src/export/trim";
import type { PixelRect } from "../../src/export/trim/visible";
import { nodeLabel } from "../../src/model/labels";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import { NodeTypeRegistry } from "../../src/registry/node-type";

// The file node type imports the real Obsidian API for its DOM; this suite only builds strings.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

/** Deps that record their calls: the cut answers with an image of the cut's size, SVG and PDF trims with what they are told. */
function fakeDeps(over: Partial<TrimDeps> & { svgRemoved?: number; pdfRemoved?: number; pdfNotes?: string[] } = {}) {
  const cuts: { dataUri: string; rect: PixelRect }[] = [];
  const svgCalls: { text: string; visible: unknown }[] = [];
  const pdfCalls: { pageIndex: number; visible: unknown }[] = [];
  const deps: TrimDeps = {
    cutImage: async (dataUri, rect) => {
      cuts.push({ dataUri, rect });
      return { dataUri: `data:image/png;base64,CUT${cuts.length}`, width: rect.width, height: rect.height };
    },
    trimSvg: async (text, visible) => {
      svgCalls.push({ text, visible });
      return { text: over.svgRemoved ? "<svg trimmed/>" : text, removed: over.svgRemoved ?? 0 };
    },
    trimPdf: async (bytes, pageIndex, visible) => {
      pdfCalls.push({ pageIndex, visible });
      return { bytes: over.pdfRemoved ? new Uint8Array([9, 9]) : new Uint8Array(bytes), removed: over.pdfRemoved ?? 0, notes: over.pdfNotes ?? [] };
    },
    ...over,
  };
  return { deps, cuts, svgCalls, pdfCalls };
}

function figure(over: Partial<FileNode> = {}) {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const node: FileNode = { ...fileNodeDefaults(page, { file: "plots/a.png", subpath: "", show: "image" }, []), x: 10, y: 20, width: 100, height: 50, ...over };
  doc.nodes.push(node);
  return { doc, page, node, label: nodeLabel(doc, node) };
}

const png = (naturalWidth = 400, naturalHeight = 200): ImageAsset => ({ kind: "image", dataUri: "data:image/png;base64,SRC", naturalWidth, naturalHeight });

test("an uncropped, wholly visible panel keeps its asset object and gets no report line", async () => {
  // 400×200 contained in 100×50: the whole image shows.
  const { doc, page, node } = figure({ fit: "contain" });
  const asset = png();
  const { deps, cuts } = fakeDeps();
  const report: string[] = [];
  const out = await trimAssets(doc, page, new Map([[node.id, asset]]), deps, report);
  expect(out.get(node.id)).toBe(asset);
  expect(cuts).toEqual([]);
  expect(report).toEqual([]);
});

test("a cropped raster is cut to its crop, and the report says how much is left", async () => {
  const { doc, page, node, label } = figure({ fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const assets: AssetMap = new Map([[node.id, png()]]);
  const { deps, cuts } = fakeDeps();
  const report: string[] = [];
  const out = await trimAssets(doc, page, assets, deps, report);
  expect(cuts).toEqual([{ dataUri: "data:image/png;base64,SRC", rect: { x: 100, y: 50, width: 200, height: 100 } }]);
  expect(out.get(node.id)).toEqual({ kind: "image", dataUri: "data:image/png;base64,CUT1", naturalWidth: 200, naturalHeight: 100, crop: { x: 0, y: 0, w: 1, h: 1 } });
  expect(report).toEqual([`${label}: cut to the crop (200 × 100 of 400 × 200 px)`]);
  // The input map is not changed.
  expect((assets.get(node.id) as ImageAsset).dataUri).toBe("data:image/png;base64,SRC");
});

test("a crop that leaves no whole pixel outside is passed through and reported as such", async () => {
  const { doc, page, node, label } = figure({ fit: "contain", crop: { x: 0.001, y: 0, w: 0.998, h: 1 } });
  const asset = png();
  const { deps, cuts } = fakeDeps();
  const report: string[] = [];
  const out = await trimAssets(doc, page, new Map([[node.id, asset]]), deps, report);
  expect(out.get(node.id)).toBe(asset);
  expect(cuts).toEqual([]);
  expect(report).toEqual([`${label}: nothing lay wholly outside the crop`]);
});

test("a failing cut leaves the asset whole and says why; the other panels are still trimmed", async () => {
  const { doc, page, node, label } = figure({ fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const other: FileNode = { ...node, id: "other", file: "b.png" };
  doc.nodes.push(other);
  const asset = png();
  let first = true;
  const { deps } = fakeDeps({
    cutImage: async (_, rect) => {
      if (first) {
        first = false;
        throw new Error("the image could not be decoded");
      }
      return { dataUri: "data:cut", width: rect.width, height: rect.height };
    },
  });
  const report: string[] = [];
  const out = await trimAssets(doc, page, new Map<string, FileAsset>([[node.id, asset], [other.id, png()]]), deps, report);
  expect(out.get(node.id)).toBe(asset);
  expect((out.get(other.id) as ImageAsset).dataUri).toBe("data:cut");
  expect(report).toEqual([
    `${label}: could not be trimmed, embedded whole (the image could not be decoded)`,
    `${nodeLabel(doc, other)}: cut to the crop (200 × 100 of 400 × 200 px)`,
  ]);
});

test("a content card's raster is left alone", async () => {
  const { doc, page, node } = figure({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, show: "content" });
  const raster = { kind: "raster" as const, dataUri: "data:card" };
  const { deps, cuts } = fakeDeps();
  const report: string[] = [];
  const out = await trimAssets(doc, page, new Map([[node.id, raster]]), deps, report);
  expect(out.get(node.id)).toBe(raster);
  expect(cuts).toEqual([]);
  expect(report).toEqual([]);
});

const svgAsset = (): SvgAsset => ({ kind: "svg", text: '<svg viewBox="-50 10 400 200"><rect/></svg>', width: 400, height: 200 });

test("a cropped SVG is trimmed to its visible region in viewBox units, and the report counts what went", async () => {
  const { doc, page, node, label } = figure({ file: "plot.svg", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const { deps, svgCalls } = fakeDeps({ svgRemoved: 412 });
  const report: string[] = [];
  const out = await trimAssets(doc, page, new Map([[node.id, svgAsset()]]), deps, report);
  expect(svgCalls).toHaveLength(1);
  const visible = svgCalls[0].visible as { x: number; y: number; width: number; height: number };
  expect(visible.x).toBeCloseTo(50, 9);
  expect(visible.y).toBeCloseTo(60, 9);
  expect(visible.width).toBeCloseTo(200, 9);
  expect(visible.height).toBeCloseTo(100, 9);
  expect(out.get(node.id)).toEqual({ ...svgAsset(), text: "<svg trimmed/>" });
  expect(report).toEqual([`${label}: 412 items outside the crop removed`]);
});

test("an SVG with nothing wholly outside keeps its asset object, and says so", async () => {
  const { doc, page, node, label } = figure({ file: "plot.svg", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const asset = svgAsset();
  const { deps } = fakeDeps();
  const report: string[] = [];
  const out = await trimAssets(doc, page, new Map([[node.id, asset]]), deps, report);
  expect(out.get(node.id)).toBe(asset);
  expect(report).toEqual([`${label}: nothing lay wholly outside the crop`]);
});

test("one item removed is one item", async () => {
  const { doc, page, node, label } = figure({ file: "plot.svg", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const { deps } = fakeDeps({ svgRemoved: 1 });
  const report: string[] = [];
  await trimAssets(doc, page, new Map([[node.id, svgAsset()]]), deps, report);
  expect(report).toEqual([`${label}: 1 item outside the crop removed`]);
});

const pdfAsset = (): PdfAsset => ({
  kind: "pdf",
  bytes: new Uint8Array([1, 2, 3]).buffer,
  pageIndex: 2,
  widthPt: 300,
  heightPt: 150,
  raster: "data:image/png;base64,PAGE",
  rasterWidth: 1250,
  rasterHeight: 625,
});

test("a cropped PDF panel has its raster cut and its page trimmed, each in its own units", async () => {
  const { doc, page, node, label } = figure({ file: "plot.pdf", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const { deps, cuts, pdfCalls } = fakeDeps({ pdfRemoved: 7, pdfNotes: ["a form nested deeper than 8 was kept whole"] });
  const report: string[] = [];
  const out = (await trimAssets(doc, page, new Map([[node.id, pdfAsset()]]), deps, report)).get(node.id) as PdfAsset;
  // Points for the page (top-left origin), raster pixels for the raster.
  expect(pdfCalls).toEqual([{ pageIndex: 2, visible: { x: 75, y: 37.5, width: 150, height: 75 } }]);
  expect(cuts).toEqual([{ dataUri: "data:image/png;base64,PAGE", rect: { x: 312, y: 156, width: 626, height: 313 } }]);
  expect(Array.from(new Uint8Array(out.bytes))).toEqual([9, 9]);
  expect(out.raster).toBe("data:image/png;base64,CUT1");
  expect([out.rasterWidth, out.rasterHeight]).toEqual([626, 313]);
  expect(out.rasterCrop!.x).toBeCloseTo(0.5 / 626, 12);
  expect(out.rasterCrop!.w).toBeCloseTo(625 / 626, 12);
  // The page itself keeps its size: the crop still names the same part of it.
  expect([out.widthPt, out.heightPt, out.pageIndex]).toEqual([300, 150, 2]);
  expect(report).toEqual([`${label}: 7 items outside the crop removed`, `${label}: a form nested deeper than 8 was kept whole`]);
});

test("a PDF page trim that removes nothing keeps the original bytes", async () => {
  const { doc, page, node, label } = figure({ file: "plot.pdf", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const asset = pdfAsset();
  const { deps } = fakeDeps();
  const report: string[] = [];
  const out = (await trimAssets(doc, page, new Map([[node.id, asset]]), deps, report)).get(node.id) as PdfAsset;
  expect(out.bytes).toBe(asset.bytes);
  expect(report).toEqual([`${label}: nothing lay wholly outside the crop`]);
});

test("a PDF page that cannot be trimmed is embedded whole, and its raster is still cut", async () => {
  const { doc, page, node, label } = figure({ file: "plot.pdf", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const asset = pdfAsset();
  const { deps } = fakeDeps({
    trimPdf: async () => {
      throw new Error("the content stream could not be decoded");
    },
  });
  const report: string[] = [];
  const out = (await trimAssets(doc, page, new Map([[node.id, asset]]), deps, report)).get(node.id) as PdfAsset;
  expect(out.bytes).toBe(asset.bytes);
  expect(out.raster).toBe("data:image/png;base64,CUT1");
  expect(report).toEqual([`${label}: could not be trimmed, embedded whole (the content stream could not be decoded)`]);
});

test("a PDF raster that cannot be cut is reported beside the page's own line", async () => {
  const { doc, page, node, label } = figure({ file: "plot.pdf", fit: "contain", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const asset = pdfAsset();
  const { deps } = fakeDeps({
    pdfRemoved: 3,
    cutImage: async () => {
      throw new Error("out of memory");
    },
  });
  const report: string[] = [];
  const out = (await trimAssets(doc, page, new Map([[node.id, asset]]), deps, report)).get(node.id) as PdfAsset;
  expect(out.raster).toBe(asset.raster);
  expect(out.rasterCrop).toBeUndefined();
  expect(report).toEqual([`${label}: 3 items outside the crop removed`, `${label}: its raster could not be trimmed, embedded whole (out of memory)`]);
});

/** The `<image>` of a page SVG and its clip rectangle, as numbers. */
function placed(svg: string) {
  const image = /<image href="([^"]*)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/.exec(svg)!;
  const clip = /<clipPath id="[^"]+"><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"\/><\/clipPath>/.exec(svg)!;
  const n = (s: string) => Number(s);
  return {
    href: image[1],
    image: { x: n(image[2]), y: n(image[3]), width: n(image[4]), height: n(image[5]) },
    clip: { x: n(clip[1]), y: n(clip[2]), width: n(clip[3]), height: n(clip[4]) },
  };
}

test.each([
  ["image", (): FileAsset => png(997, 613)],
  ["pdf", (): FileAsset => ({ ...pdfAsset(), widthPt: 239.28, heightPt: 147.12, rasterWidth: 997, rasterHeight: 613 })],
])("cover with a crop at the right edge: the cut %s lands where its part of the uncut one did", async (_, make) => {
  const { doc, page, node } = figure({ file: "plots/a.png", fit: "cover", crop: { x: 0.6, y: 0.1, w: 0.4, h: 0.5 }, x: 13.7, y: 21.3, width: 100, height: 50 });
  const types = new NodeTypeRegistry();
  types.register(fileNodeType);
  const asset = make();
  const before = placed(buildPageSvg(doc, page, types, new Map([[node.id, asset]])).svg);
  const { deps, cuts } = fakeDeps();
  const trimmed = await trimAssets(doc, page, new Map([[node.id, asset]]), deps, []);
  const after = placed(buildPageSvg(doc, page, types, trimmed).svg);

  expect(cuts).toHaveLength(1);
  const cut = cuts[0].rect;
  const natural = asset.kind === "pdf" ? { width: asset.rasterWidth, height: asset.rasterHeight } : { width: 997, height: 613 };
  // The crop reaches the right edge, so the cut does too.
  expect(cut.x + cut.width).toBe(natural.width);
  expect(after.href).toBe("data:image/png;base64,CUT1");
  // The uncut image's pixels from `cut` on, at the uncut image's scale.
  const sx = before.image.width / natural.width;
  const sy = before.image.height / natural.height;
  expect(after.image.x).toBeCloseTo(before.image.x + cut.x * sx, 6);
  expect(after.image.y).toBeCloseTo(before.image.y + cut.y * sy, 6);
  expect(after.image.width).toBeCloseTo(cut.width * sx, 6);
  expect(after.image.height).toBeCloseTo(cut.height * sy, 6);
  // The same clip, and the cut image still covers all of it.
  expect(after.clip).toEqual(before.clip);
  expect(after.image.x).toBeLessThanOrEqual(after.clip.x + 1e-6);
  expect(after.image.y).toBeLessThanOrEqual(after.clip.y + 1e-6);
  expect(after.image.x + after.image.width).toBeGreaterThanOrEqual(after.clip.x + after.clip.width - 1e-6);
  expect(after.image.y + after.image.height).toBeGreaterThanOrEqual(after.clip.y + after.clip.height - 1e-6);
});
