import { hasActiveAdjustments, type PixelRecipe } from "../../src/adjust/render";
import { nodeLabel } from "../../src/model/labels";
import { createDocument, createPage, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import type { Document, FileNode } from "../../src/model/types";
import type { Resolved } from "../../src/links/types";

const mocks = vi.hoisted(() => ({
  decodePdf: vi.fn(),
  pdfPageSizePt: vi.fn(),
  tiff: vi.fn(),
  raster: vi.fn(),
  snapdom: vi.fn(),
}));
// pdf.js and the DOM are not available here; what matters is what collectAssets asks of them.
vi.mock("../../src/links/decoders/pdf", () => ({ decodePdf: mocks.decodePdf, pdfPageSizePt: mocks.pdfPageSizePt }));
vi.mock("@zumer/snapdom", () => ({ snapdom: mocks.snapdom }));
const { bytesToDataUri, collectAssets } = await import("../../src/export/assets");
const { DecodeLimitError } = await import("../../src/links/decoders/budget");
const { resolveFileNode } = await import("../../src/links/resolver");
const { FakeAccess } = await import("../links/fake-access");
const { testRegistry } = await import("../adjust/fixtures");

/** The decoders collectAssets is given; only TIFF and raster go through them. */
const decoders = { pdf: vi.fn(), tiff: mocks.tiff, raster: mocks.raster, adjusts: (recipe: PixelRecipe) => hasActiveAdjustments(recipe, testRegistry()) };

/** An image decoder that reports 640 x 480 for any data URI, and fails for the bytes 0xff 0xff 0xff. */
class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    queueMicrotask(() => {
      if (value.endsWith(",////")) return this.onerror?.();
      this.naturalWidth = 640;
      this.naturalHeight = 480;
      this.onload?.();
    });
  }
}

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

interface Setup {
  doc: Document;
  nodes: FileNode[];
  resolved: Map<string, Resolved>;
  files: Record<string, ArrayBuffer | string>;
  elements: Map<string, HTMLElement>;
  warnings: string[];
  run(dpi?: number): ReturnType<typeof collectAssets>;
}

/** A one-page document with one file node per entry of `specs`, each resolved as given. */
function setup(specs: { node?: Partial<FileNode>; resolved?: Resolved }[]): Setup {
  const doc = createDocument("nature-double");
  const page = doc.pages[0];
  const nodes: FileNode[] = [];
  const resolved = new Map<string, Resolved>();
  for (const spec of specs) {
    const node = fileNodeDefaults(page, { file: "x", subpath: "", show: "image", ...spec.node }, doc.nodes.map((n) => n.id));
    doc.nodes.push(node);
    nodes.push(node);
    if (spec.resolved) resolved.set(node.id, spec.resolved);
  }
  const files: Record<string, ArrayBuffer | string> = {};
  const elements = new Map<string, HTMLElement>();
  const warnings: string[] = [];
  return {
    doc,
    nodes,
    resolved,
    files,
    elements,
    warnings,
    run: (dpi = 300) =>
      collectAssets(doc, page, {
        app: {} as never,
        resolved: (id) => resolved.get(id),
        elementFor: (id) => elements.get(id),
        readBinary: async (path) => {
          const data = files[path];
          if (!(data instanceof ArrayBuffer)) throw new Error(`File not found in vault: ${path}`);
          return data;
        },
        readText: async (path) => {
          const data = files[path];
          if (typeof data !== "string") throw new Error(`File not found in vault: ${path}`);
          return data;
        },
        decoders,
        dpi,
        warnings,
      }),
  };
}

const image = (path: string, source: "raster" | "svg" | "pdf" | "tiff"): Resolved => ({
  kind: "image",
  file: { path, extension: path.slice(path.lastIndexOf(".") + 1) },
  src: "app://x",
  source,
  pageCount: 1,
  deps: [path],
});

const content: Resolved = { kind: "content", file: { path: "note.md", extension: "md" }, markdown: "# Hi", deps: ["note.md"] };

describe("bytesToDataUri", () => {
  test("encodes like base64, whatever the length (the chunks are joined without padding in between)", () => {
    for (const length of [0, 1, 2, 3, 29_999, 30_000, 30_001, 65_537]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 256);
      expect(bytesToDataUri(data.buffer, "image/png")).toBe(`data:image/png;base64,${Buffer.from(data).toString("base64")}`);
    }
  });

  test("a file of many megabytes does not overflow the stack", () => {
    const data = new Uint8Array(8 * 1024 * 1024).fill(200);
    expect(bytesToDataUri(data.buffer, "image/png").length).toBe("data:image/png;base64,".length + Math.ceil(data.length / 3) * 4);
  });
});

describe("raster sources", () => {
  test("become a data URI with the file's mime type and the size the image reports", async () => {
    const s = setup([{ resolved: image("fig/a.png", "raster") }, { resolved: image("fig/b.JPG", "raster") }]);
    s.files["fig/a.png"] = bytes(1, 2, 3);
    s.files["fig/b.JPG"] = bytes(4, 5, 6);
    const assets = await s.run();
    expect(assets.get(s.nodes[0].id)).toEqual({ kind: "image", dataUri: "data:image/png;base64,AQID", naturalWidth: 640, naturalHeight: 480 });
    expect((assets.get(s.nodes[1].id) as { dataUri: string }).dataUri).toBe("data:image/jpeg;base64,BAUG");
    expect(s.warnings).toEqual([]);
  });

  test("an AVIF image is embedded, with a warning that the PDF export cannot show it", async () => {
    const s = setup([{ resolved: image("fig/a.avif", "raster") }, { resolved: image("fig/b.webp", "raster") }]);
    s.files["fig/a.avif"] = bytes(1, 2, 3);
    s.files["fig/b.webp"] = bytes(1, 2, 3);
    const assets = await s.run();
    expect((assets.get(s.nodes[0].id) as { dataUri: string }).dataUri).toBe("data:image/avif;base64,AQID");
    expect(assets.has(s.nodes[1].id)).toBe(true);
    expect(s.warnings).toEqual([`${nodeLabel(s.doc, s.nodes[0])}: AVIF is not supported by the PDF export`]);
  });

  test("an image that cannot be decoded, or has an unknown type, is a warning and no asset", async () => {
    const s = setup([{ resolved: image("a.png", "raster") }, { resolved: image("b.xyz", "raster") }]);
    s.files["a.png"] = bytes(255, 255, 255);
    s.files["b.xyz"] = bytes(1);
    const assets = await s.run();
    expect(assets.size).toBe(0);
    expect(s.warnings).toEqual([
      `${nodeLabel(s.doc, s.nodes[0])}: the image could not be decoded`,
      `${nodeLabel(s.doc, s.nodes[1])}: "b.xyz" is not an image type that can be embedded`,
    ]);
  });
});

describe("svg sources", () => {
  test("keep their text and take the size the file gives itself", async () => {
    const s = setup([{ resolved: image("plot.svg", "svg") }]);
    const text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect/></svg>';
    s.files["plot.svg"] = text;
    expect((await s.run()).get(s.nodes[0].id)).toEqual({ kind: "svg", text, width: 200, height: 100 });
  });
});

describe("pdf sources", () => {
  test("carry the bytes, the page's size in points and a raster of it at dpi / 72", async () => {
    const s = setup([{ node: { pageIndex: 1 }, resolved: image("doc.pdf", "pdf") }]);
    const pdf = bytes(37, 80, 68, 70);
    s.files["doc.pdf"] = pdf;
    mocks.decodePdf.mockResolvedValue({ dataUrl: "data:image/png;base64,UEc=", width: 1250, height: 833, pageCount: 3 });
    mocks.pdfPageSizePt.mockResolvedValue({ width: 300, height: 200 });
    expect((await s.run(300)).get(s.nodes[0].id)).toEqual({
      kind: "pdf",
      bytes: pdf,
      pageIndex: 1,
      widthPt: 300,
      heightPt: 200,
      raster: "data:image/png;base64,UEc=",
      rasterWidth: 1250,
      rasterHeight: 833,
    });
    expect(mocks.decodePdf).toHaveBeenCalledWith(pdf, 1, 300 / 72);
    expect(mocks.pdfPageSizePt).toHaveBeenCalledWith(pdf, 1);
  });

  test("a page over the decode budget at the export's dpi is drawn at the most that fits, with a warning; the asset is kept", async () => {
    const s = setup([{ resolved: image("doc.pdf", "pdf") }]);
    const pdf = bytes(1);
    s.files["doc.pdf"] = pdf;
    const message = "PDF page at 1200 dpi is 9921×14031 px (139.2 MP); the limit is 50 MP";
    mocks.decodePdf
      .mockRejectedValueOnce(new DecodeLimitError(message, 9921, 14031))
      .mockResolvedValueOnce({ dataUrl: "data:,r", width: 5900, height: 8344, pageCount: 1 });
    mocks.pdfPageSizePt.mockResolvedValue({ width: 595, height: 842 });
    const asset = (await s.run(1200)).get(s.nodes[0].id);
    expect(asset).toMatchObject({ kind: "pdf", bytes: pdf, raster: "data:,r", rasterWidth: 5900 });
    const fit = mocks.decodePdf.mock.calls[1][2] as number;
    expect(Math.ceil(9921 * (fit * 72) / 1200) * Math.ceil(14031 * (fit * 72) / 1200)).toBeLessThanOrEqual(50e6);
    expect(fit).toBeGreaterThan((0.98 * 1200 * Math.sqrt(50e6 / (9921 * 14031))) / 72);
    expect(s.warnings).toEqual([`${nodeLabel(s.doc, s.nodes[0])}: PDF panel rasterised at ${Math.floor(fit * 72)} dpi, not 1200: ${message}`]);
  });

  test("any other decoding failure is still the node's warning, with no asset", async () => {
    const s = setup([{ resolved: image("doc.pdf", "pdf") }]);
    s.files["doc.pdf"] = bytes(1);
    mocks.decodePdf.mockRejectedValue(new Error("bad xref"));
    expect((await s.run()).size).toBe(0);
    expect(mocks.decodePdf).toHaveBeenCalledTimes(1);
    expect(s.warnings).toEqual([`${nodeLabel(s.doc, s.nodes[0])}: bad xref`]);
  });

  test("a page index beyond the file is recorded as the page that was drawn", async () => {
    const s = setup([{ node: { pageIndex: 9 }, resolved: image("doc.pdf", "pdf") }]);
    s.files["doc.pdf"] = bytes(1);
    mocks.decodePdf.mockResolvedValue({ dataUrl: "data:,r", width: 1, height: 1, pageCount: 3 });
    mocks.pdfPageSizePt.mockResolvedValue({ width: 1, height: 1 });
    const asset = (await s.run()).get(s.nodes[0].id) as { pageIndex: number };
    expect(asset.pageIndex).toBe(2);
    expect(mocks.pdfPageSizePt).toHaveBeenCalledWith(expect.anything(), 2);
  });
});

describe("tiff sources", () => {
  test("are decoded at full resolution with the node's page, range and adjustments", async () => {
    const range = { min: 100, max: 4000 };
    const adjustments = [{ type: "test.invert", enabled: true, params: {} }];
    const s = setup([{ node: { pageIndex: 2, range, adjustments }, resolved: image("cells.tif", "tiff") }]);
    const tiff = bytes(73, 73, 42, 0);
    s.files["cells.tif"] = tiff;
    mocks.tiff.mockResolvedValue({ dataUrl: "data:image/png;base64,VFQ=", width: 2048, height: 1536, pageCount: 3 });
    expect((await s.run()).get(s.nodes[0].id)).toEqual({ kind: "image", dataUri: "data:image/png;base64,VFQ=", naturalWidth: 2048, naturalHeight: 1536 });
    expect(mocks.tiff).toHaveBeenCalledWith(tiff, 2, { range, adjustments });
  });

  test("are drawn by the same decoder with the same recipe as on the stage", async () => {
    const adjustments = [{ type: "test.double", enabled: true, params: { k: 2 } }, { type: "test.invert", enabled: false, params: {} }];
    const s = setup([{ node: { file: "cells.tif", pageIndex: 1, range: { min: 5, max: 50 }, adjustments }, resolved: image("cells.tif", "tiff") }]);
    s.files["cells.tif"] = bytes(1, 2, 3);
    mocks.tiff.mockResolvedValue({ dataUrl: "data:image/png;base64,VFQ=", width: 1, height: 1, pageCount: 2 });
    await resolveFileNode(s.nodes[0], "f.lnkfig.md", new FakeAccess({ files: { "cells.tif": "BINARY" } }), decoders);
    await s.run();
    expect(mocks.tiff).toHaveBeenCalledTimes(2);
    const [stage, exported] = mocks.tiff.mock.calls;
    expect(exported.slice(1)).toEqual(stage.slice(1));
  });
});

describe("raster sources with adjustments", () => {
  test("are drawn by the raster decoder with the node's recipe, as a PNG", async () => {
    const adjustments = [{ type: "test.invert", enabled: true, params: {} }];
    const s = setup([{ node: { adjustments }, resolved: image("fig/a.avif", "raster") }]);
    s.files["fig/a.avif"] = bytes(1, 2, 3);
    mocks.raster.mockResolvedValue({ dataUrl: "data:image/png;base64,UE4=", width: 30, height: 20, pageCount: 1 });
    expect((await s.run()).get(s.nodes[0].id)).toEqual({ kind: "image", dataUri: "data:image/png;base64,UE4=", naturalWidth: 30, naturalHeight: 20 });
    expect(mocks.raster).toHaveBeenCalledWith(s.files["fig/a.avif"], { range: "auto", adjustments });
    // A PNG now, so the AVIF limit of the PDF export does not apply.
    expect(s.warnings).toEqual([]);
  });

  test("with only enabled entries of types not registered keep the file's own bytes", async () => {
    const s = setup([{ node: { adjustments: [{ type: "future.thing", enabled: true, params: {} }] }, resolved: image("fig/a.png", "raster") }]);
    s.files["fig/a.png"] = bytes(1, 2, 3);
    expect((await s.run()).get(s.nodes[0].id)).toMatchObject({ dataUri: "data:image/png;base64,AQID" });
    expect(mocks.raster).not.toHaveBeenCalled();
  });

  test("with every entry disabled keep the file's own bytes", async () => {
    const s = setup([{ node: { adjustments: [{ type: "test.invert", enabled: false, params: {} }] }, resolved: image("fig/a.png", "raster") }]);
    s.files["fig/a.png"] = bytes(1, 2, 3);
    expect((await s.run()).get(s.nodes[0].id)).toMatchObject({ dataUri: "data:image/png;base64,AQID" });
    expect(mocks.raster).not.toHaveBeenCalled();
  });
});

describe("content cards", () => {
  const body = { id: "body" } as unknown as HTMLElement;
  const stage = (): HTMLElement => ({ querySelector: (sel: string) => (sel === ".lf-node-body" ? body : null) }) as unknown as HTMLElement;
  const capture = (src: string) => ({ toPng: async () => ({ src }) });

  test("are rasterised from the node's body at dpi / 96, independent of the monitor", async () => {
    const s = setup([{ node: { show: "content" }, resolved: content }]);
    s.elements.set(s.nodes[0].id, stage());
    mocks.snapdom.mockResolvedValue(capture("data:image/png;base64,Q0M="));
    expect((await s.run(192)).get(s.nodes[0].id)).toEqual({ kind: "raster", dataUri: "data:image/png;base64,Q0M=" });
    expect(mocks.snapdom).toHaveBeenCalledWith(body, { scale: 2, dpr: 1 });
  });

  test("a content node whose link turned out to be an image is still rasterised, as its node type draws it", async () => {
    const s = setup([{ node: { show: "content" }, resolved: image("a.png", "raster") }]);
    s.elements.set(s.nodes[0].id, stage());
    mocks.snapdom.mockResolvedValue(capture("data:image/png;base64,Q0M="));
    expect((await s.run()).get(s.nodes[0].id)?.kind).toBe("raster");
  });

  test("a card that is not on the stage, or whose snapshot is not an image, is a warning and no asset", async () => {
    const s = setup([
      { node: { show: "content" }, resolved: content },
      { node: { show: "content" }, resolved: content },
    ]);
    s.elements.set(s.nodes[1].id, stage());
    mocks.snapdom.mockResolvedValue(capture("blob:nope"));
    expect((await s.run()).size).toBe(0);
    expect(s.warnings).toEqual([
      `${nodeLabel(s.doc, s.nodes[0])}: the node is not drawn on the stage, so it cannot be rasterised`,
      `${nodeLabel(s.doc, s.nodes[1])}: the snapshot is not an image`,
    ]);
  });
});

describe("nodes without anything to embed", () => {
  test.each([
    [{ reason: "file" }, "link missing"],
    [{ reason: "subpath" }, "heading or block not found"],
    [{ reason: "no-image" }, "no image in that section"],
    [{ reason: "decode", message: "over the 50 MP limit" }, "could not be decoded (over the 50 MP limit)"],
    [{ reason: "decode" }, "could not be decoded"],
  ] as const)("a missing link (%j) gets a skipped asset with the reason, and no warning of its own", async (missing, reason) => {
    const s = setup([{ resolved: { kind: "missing", deps: [], ...missing } }]);
    const assets = await s.run();
    expect(assets.get(s.nodes[0].id)).toEqual({ kind: "skipped", reason });
    expect(s.warnings).toEqual([]);
  });

  test("a link that is still being resolved is skipped with a warning that says so", async () => {
    const s = setup([{}]);
    expect((await s.run()).size).toBe(0);
    expect(s.warnings).toEqual([`${nodeLabel(s.doc, s.nodes[0])}: its link is still being resolved, skipped`]);
  });

  test("only file nodes of the page asked for are looked at", async () => {
    const s = setup([{ resolved: image("a.png", "raster") }]);
    s.files["a.png"] = bytes(1);
    const other = createPage("a4-portrait", [s.doc.pages[0].id]);
    s.doc.pages.push(other);
    s.doc.nodes.push({ ...fileNodeDefaults(other, { file: "b.png", subpath: "", show: "image" }, ["x"]) });
    s.doc.nodes.push(textNodeDefaults(s.doc.pages[0], {}, ["y"]));
    s.resolved.set(s.doc.nodes[1].id, image("b.png", "raster"));
    const assets = await s.run();
    expect([...assets.keys()]).toEqual([s.nodes[0].id]);
    expect(s.warnings).toEqual([]);
  });
});

test("one node that fails does not stop the rest", async () => {
  const s = setup([
    { resolved: image("gone.png", "raster") },
    { resolved: image("a.png", "raster") },
    { resolved: image("plot.svg", "svg") },
  ]);
  s.files["a.png"] = bytes(1, 2, 3);
  s.files["plot.svg"] = '<svg viewBox="0 0 10 10"/>';
  const assets = await s.run();
  expect([...assets.keys()]).toEqual([s.nodes[1].id, s.nodes[2].id]);
  expect(s.warnings).toEqual([`${nodeLabel(s.doc, s.nodes[0])}: File not found in vault: gone.png`]);
});

test("a rejection that is not an Error is still reported", async () => {
  const s = setup([{ resolved: image("a.pdf", "pdf") }]);
  s.files["a.pdf"] = bytes(1);
  mocks.decodePdf.mockRejectedValue("bad xref");
  mocks.pdfPageSizePt.mockResolvedValue({ width: 1, height: 1 });
  expect((await s.run()).size).toBe(0);
  expect(s.warnings).toEqual([`${nodeLabel(s.doc, s.nodes[0])}: bad xref`]);
});
