import { nodeLabel } from "../../src/model/labels";
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream } from "@cantoo/pdf-lib";
import { PX_TO_PT } from "../../src/constants";
import type { PdfAsset } from "../../src/export/asset-types";
import { pdfExporter } from "../../src/export/exporters/pdf";
import { createDocument, createPage, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import type { FileNode, Node, Page } from "../../src/model/types";
import type { ExportInput } from "../../src/registry/exporter";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";

// jsPDF and svg2pdf.js are replaced by a recorder: what is checked here is what the exporter asks of them, per page.
// (Whether the PDF they make is right can only be seen in a real browser.)
const calls = vi.hoisted(() => [] as unknown[][]);
// What the stand-in jsPDF hands back as one layer's PDF: a real one-page PDF, made in `beforeAll`, which pdf-lib can embed.
const layerPdf = vi.hoisted(() => ({ bytes: undefined as ArrayBuffer | undefined }));
vi.mock("jspdf", () => ({
  jsPDF: class {
    constructor(options: unknown) {
      calls.push(["new", options]);
    }
    addPage(...args: unknown[]) {
      calls.push(["addPage", ...args]);
    }
    async svg(element: { source: string }, options: unknown) {
      calls.push(["svg", element.source, options]);
    }
    output(type: string) {
      calls.push(["output", type]);
      return type === "arraybuffer" ? layerPdf.bytes?.slice(0) : new Blob(["%PDF"], { type: "application/pdf" });
    }
  },
}));
vi.mock("svg2pdf.js", () => ({}));

// There is no DOM in this suite; a document that is not an <svg> stands for what the browser returns as <parsererror>.
class FakeDOMParser {
  parseFromString(source: string) {
    const bad = !source.startsWith("<svg");
    return {
      documentElement: { source },
      getElementsByTagName: () => (bad ? [{ textContent: "error on line 1", querySelector: () => null }] : []),
    };
  }
}

beforeAll(async () => {
  layerPdf.bytes = await sourcePdf([[100, 100]]);
});
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("DOMParser", FakeDOMParser);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const input = (over: Partial<ExportInput> = {}): ExportInput => {
  const doc = createDocument("nature-double");
  doc.pages.push(createPage("a4-portrait", [doc.pages[0].id]));
  return {
    doc,
    pages: doc.pages,
    svgs: new Map(doc.pages.map((p) => [p.id, `<svg>${p.name}</svg>`])),
    assets: new Map(),
    registries: createRegistries(),
    warnings: [],
    baseName: "Untitled figure",
    dpi: 300,
    ...over,
  };
};

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("it describes itself as a vector PDF, with no options", () => {
  expect(pdfExporter).toMatchObject({ id: "pdf", name: "PDF (vector)", ext: "pdf", mime: "application/pdf" });
  expect(pdfExporter.options()).toEqual([]);
});

test("one PDF: the first page sets the document up, later pages are added, each is drawn at its own size", async () => {
  const { files } = await pdfExporter.run(input(), {});
  expect(calls).toEqual([
    ["new", { unit: "mm", format: [183, 170], orientation: "landscape", compress: true }],
    ["svg", "<svg>Page 1</svg>", { x: 0, y: 0, width: 183, height: 170 }],
    ["addPage", [210, 297], "portrait"],
    ["svg", "<svg>Page 2</svg>", { x: 0, y: 0, width: 210, height: 297 }],
    ["output", "blob"],
  ]);
  expect(files.map((f) => f.name)).toEqual(["Untitled figure.pdf"]);
  expect(files[0].blob.type).toBe("application/pdf");
});

test("the warnings it was given are the warnings it returns", async () => {
  const warnings = ["Node p-aaaa rasterised"];
  expect((await pdfExporter.run(input({ warnings }), {})).warnings).toEqual(warnings);
});

test("no pages make no file, not a blank PDF", async () => {
  expect((await pdfExporter.run(input({ pages: [] }), {})).files).toEqual([]);
  expect(calls).toEqual([]);
});

test("a page with no built SVG is an error, before any drawing", async () => {
  await expect(pdfExporter.run(input({ svgs: new Map() }), {})).rejects.toThrow('No SVG was built for page "Page 1"');
  expect(calls).toEqual([]);
});

test("an SVG the parser rejects is an error that names the page", async () => {
  const i = input();
  const svgs = new Map(i.svgs).set(i.doc.pages[1].id, "not xml");
  await expect(pdfExporter.run({ ...i, svgs }, {})).rejects.toThrow('The SVG built for page "Page 2" is not valid XML: error on line 1');
});

// ---- PDF panels: layers composed with pdf-lib ------------------------------------------------------------------------
// Here the real pdf-lib does the composing, so the output can be read back; jsPDF and svg2pdf.js stay the recorder above.

const MM_TO_PT = 72 / 25.4;
const pt = (v: number) => v / PX_TO_PT;

/** A PDF with a page per size, each with something drawn on it so that it has contents to embed. */
async function sourcePdf(sizes: [number, number][], edit: (page: PDFPage, index: number) => void = () => {}): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (const [i, [width, height]] of sizes.entries()) {
    const page = doc.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width: width / 2, height: height / 2 });
    edit(page, i);
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const pdfAsset = (bytes: ArrayBuffer, over: Partial<PdfAsset> = {}): PdfAsset => ({
  kind: "pdf",
  bytes,
  pageIndex: 0,
  widthPt: 300,
  heightPt: 200,
  raster: "data:image/png;base64,",
  rasterWidth: 1,
  rasterHeight: 1,
  ...over,
});

/** A node type that draws each node as a marker carrying its id, so a layer's SVG says which nodes it holds. */
const markerType = (type: string): NodeType =>
  ({ type, name: type, icon: "", mount: () => ({ update() {}, unmount() {} }), bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }), inspector: () => [], toSvg: (node: Node) => `<g id="${node.id}"/>` }) as NodeType;

function markerTypes() {
  const registries = createRegistries();
  registries.nodeTypes.register(markerType("file"));
  registries.nodeTypes.register(markerType("text"));
  return registries;
}

/** The default two-page figure (183 x 170 mm, then A4), with helpers to put panels on its pages. */
function panelFigure() {
  const i = input({ registries: markerTypes() });
  const [first, second] = i.doc.pages;
  const ids = () => i.doc.nodes.map((n) => n.id);
  return {
    i,
    first,
    second,
    /** A panel at the given rectangle (pt, from the page's top-left); a PDF panel when `asset` is given. */
    panel(page: Page, z: number, rect: [number, number, number, number], asset?: PdfAsset, over: Partial<FileNode> = {}): FileNode {
      const [x, y, width, height] = rect;
      const node: FileNode = {
        ...fileNodeDefaults(page, { file: asset ? "plot.pdf" : "plot.png", subpath: "", show: "image" }, ids()),
        z,
        x: pt(x),
        y: pt(y),
        width: pt(width),
        height: pt(height),
        ...over,
      };
      i.doc.nodes.push(node);
      if (asset) {
        const pageAssets = i.assets.get(page.id) ?? new Map();
        i.assets.set(page.id, pageAssets.set(node.id, asset));
      }
      return node;
    },
    label(page: Page, z: number) {
      const node = textNodeDefaults(page, { z, text: "A" }, ids());
      i.doc.nodes.push(node);
      return node;
    },
  };
}

/** The rectangles of the form XObjects (embedded pages) a page of the output draws. */
async function formBoxes(blob: Blob, pageIndex: number): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const out = await PDFDocument.load(await blob.arrayBuffer());
  const xobjects = out.getPage(pageIndex).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
  if (!xobjects) return [];
  return xobjects.keys().map((key) => (xobjects.lookup(key) as PDFRawStream).dict.lookup(PDFName.of("BBox"), PDFArray).asRectangle());
}

const svgCalls = () => calls.filter((c) => c[0] === "svg").map((c) => c[1] as string);
const spyOnDrawPage = () => vi.spyOn(PDFPage.prototype, "drawPage");
/** The options of each page drawn onto the output, in order. */
const drawn = (spy: ReturnType<typeof spyOnDrawPage>) => spy.mock.calls.map(([, options]) => options ?? {});

test("a PDF panel is drawn as the source's own page, between an SVG layer below it and one above", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]]);
  const png = f.panel(f.first, 0, [0, 0, 100, 100]);
  const pdf = f.panel(f.first, 1, [40, 30, 300, 200], pdfAsset(source));
  const label = f.label(f.first, 2);
  const drawPage = spyOnDrawPage();

  const { files } = await pdfExporter.run(f.i, {});

  // Two layers, one jsPDF each (page 2 is one more): the nodes below the panel with the paper, then the nodes above it.
  const [below, above] = svgCalls();
  expect(below).toContain(`id="${png.id}"`);
  expect(below).toContain("<rect width=");
  expect(below).not.toContain(label.id);
  expect(above).toContain(`id="${label.id}"`);
  expect(above).not.toContain("<rect");
  expect(above).not.toContain(png.id);
  expect(below + above).not.toContain(pdf.id);

  const wPt = 183 * MM_TO_PT;
  const hPt = 170 * MM_TO_PT;
  const [first, panel, second] = drawn(drawPage);
  expect(first).toMatchObject({ x: 0, y: 0, width: expect.closeTo(wPt), height: expect.closeTo(hPt) });
  expect(panel).toMatchObject({ x: expect.closeTo(40), y: expect.closeTo(hPt - 30 - 200), width: expect.closeTo(300), height: expect.closeTo(200) });
  expect(panel?.rotate?.angle).toBe(0);
  expect(second).toMatchObject({ x: 0, y: 0, width: expect.closeTo(wPt), height: expect.closeTo(hPt) });

  const out = await PDFDocument.load(await files[0].blob.arrayBuffer());
  expect(out.getPageCount()).toBe(2);
  expect(out.getPage(0).getSize().width).toBeCloseTo(wPt);
  expect(out.getPage(0).getSize().height).toBeCloseTo(hPt);
  expect(files.map((file) => file.name)).toEqual(["Untitled figure.pdf"]);
  expect(files[0].blob.type).toBe("application/pdf");
});

test("each layer is its own single-page jsPDF at the figure page's size, and the second page is an ordinary one-layer page", async () => {
  const f = panelFigure();
  f.panel(f.first, 0, [0, 0, 100, 100]);
  f.panel(f.first, 1, [40, 30, 300, 200], pdfAsset(await sourcePdf([[300, 200]])));
  f.label(f.first, 2);
  await pdfExporter.run(f.i, {});
  const options = { unit: "mm", format: [183, 170], orientation: "landscape", compress: true };
  const box = { x: 0, y: 0, width: 183, height: 170 };
  // Page 1 is two jsPDF documents (the layers around the panel, which has none of its own), page 2 is one.
  expect(calls.map((c) => c[0])).toEqual(["new", "svg", "output", "new", "svg", "output", "new", "svg", "output"]);
  expect(calls[0]).toEqual(["new", options]);
  expect(calls[1]).toEqual(["svg", expect.stringContaining("<rect width="), box]);
  expect(calls[2]).toEqual(["output", "arraybuffer"]);
  expect(calls[3]).toEqual(["new", options]);
  // The page with no PDF panel is its SVG as it was built, in one layer.
  expect(calls[6]).toEqual(["new", { unit: "mm", format: [210, 297], orientation: "portrait", compress: true }]);
  expect(calls[7]).toEqual(["svg", "<svg>Page 2</svg>", { x: 0, y: 0, width: 210, height: 297 }]);
  expect(calls).toHaveLength(9);
});

test("what a PDF panel's node type draws over it (its frame) is a layer of its own, right above the panel", async () => {
  const f = panelFigure();
  // The file type's overlay: a marker for a node with a frame, nothing for one without.
  f.i.registries.nodeTypes.register({ ...markerType("file"), overlaySvg: (node: Node) => ((node as FileNode).frame ? `<g id="${node.id}-frame"/>` : "") } as NodeType);
  const source = await sourcePdf([[300, 200]]);
  const framed = f.panel(f.first, 0, [40, 30, 300, 200], pdfAsset(source), { frame: { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" } });
  f.panel(f.first, 1, [0, 0, 100, 100], pdfAsset(source));
  const drawPage = spyOnDrawPage();

  await pdfExporter.run(f.i, {});

  // The paper, the framed panel, its frame, the plain panel (with no overlay layer), then page 2.
  const [paper, frame, second] = svgCalls();
  expect(paper).toContain("<rect width=");
  expect(frame).toContain(`id="${framed.id}-frame"`);
  expect(frame).not.toContain("<rect");
  expect(frame).not.toContain(`id="${framed.id}"`);
  expect(second).toBe("<svg>Page 2</svg>");
  const sizes = drawn(drawPage).map((o) => o.width);
  expect(sizes).toEqual([expect.closeTo(183 * MM_TO_PT), expect.closeTo(300), expect.closeTo(183 * MM_TO_PT), expect.closeTo(100), expect.closeTo(210 * MM_TO_PT)]);
});

test("a PDF panel below everything leaves an empty first layer that still draws the paper", async () => {
  const f = panelFigure();
  f.panel(f.first, 0, [0, 0, 300, 200], pdfAsset(await sourcePdf([[300, 200]])));
  const drawPage = spyOnDrawPage();
  await pdfExporter.run(f.i, {});
  // The paper (page 1's layer) and page 2's SVG; the panel has nothing above it, so there is no layer for that.
  expect(svgCalls()).toHaveLength(2);
  expect(svgCalls()[0]).toContain("<rect width=");
  expect(drawn(drawPage)).toHaveLength(3); // paper, panel, page 2
});

test("two PDF panels on one page keep their z order with the SVG between them", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]]);
  f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(source));
  const png = f.panel(f.first, 1, [10, 10, 50, 50]);
  f.panel(f.first, 2, [200, 0, 150, 100], pdfAsset(source));
  const drawPage = spyOnDrawPage();
  await pdfExporter.run(f.i, {});
  expect(svgCalls().slice(0, 2)).toEqual([expect.stringContaining("<rect width="), expect.stringContaining(`id="${png.id}"`)]);
  const [paper, first, between, second] = drawn(drawPage);
  expect(paper).toMatchObject({ x: 0, y: 0, width: expect.closeTo(183 * MM_TO_PT) });
  expect(between).toMatchObject({ x: 0, y: 0, width: expect.closeTo(183 * MM_TO_PT) });
  expect(first?.x).toBeCloseTo(0);
  expect(second?.x).toBeCloseTo(200);
});

test("a PDF panel on the second page only: the first page stays an ordinary one-layer page", async () => {
  const f = panelFigure();
  f.panel(f.second, 0, [20, 20, 300, 200], pdfAsset(await sourcePdf([[300, 200]])));
  const { files } = await pdfExporter.run(f.i, {});
  expect(calls[1]).toEqual(["svg", "<svg>Page 1</svg>", { x: 0, y: 0, width: 183, height: 170 }]);
  const out = await PDFDocument.load(await files[0].blob.arrayBuffer());
  expect(out.getPageCount()).toBe(2);
  expect(out.getPage(1).getSize().height).toBeCloseTo(297 * MM_TO_PT);
});

test("the crop is the part of the source page that is embedded", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]]);
  f.panel(f.first, 0, [0, 0, 150, 200], pdfAsset(source), { crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  const { files } = await pdfExporter.run(f.i, {});
  // 150 x 200 starting 150 across: the right half, which is all that the form shows.
  expect(await formBoxes(files[0].blob, 0)).toContainEqual({ x: 150, y: 0, width: 150, height: 200 });
});

test("a source page whose box does not start at the origin is measured from the box", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]], (page) => page.setMediaBox(20, 10, 300, 200));
  f.panel(f.first, 0, [0, 0, 150, 200], pdfAsset(source), { crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  const { files } = await pdfExporter.run(f.i, {});
  expect(await formBoxes(files[0].blob, 0)).toContainEqual({ x: 170, y: 10, width: 150, height: 200 });
});

test("a rotated and cropped panel is turned about its centre, counter-clockwise for a clockwise rotation", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]]);
  f.panel(f.first, 0, [100, 100, 150, 200], pdfAsset(source), { rotation: 30, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  const drawPage = spyOnDrawPage();
  await pdfExporter.run(f.i, {});
  const panel = drawn(drawPage)[1];
  expect(panel?.rotate).toEqual(degrees(-30));
  const angle = (-30 * Math.PI) / 180;
  const hPt = 170 * MM_TO_PT;
  expect((panel?.x ?? NaN) + 75 * Math.cos(angle) - 100 * Math.sin(angle)).toBeCloseTo(175);
  expect((panel?.y ?? NaN) + 75 * Math.sin(angle) + 100 * Math.cos(angle)).toBeCloseTo(hPt - 200);
});

test("a translucent PDF panel keeps its opacity; an opaque one sets none", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]]);
  f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(source), { opacity: 0.5 });
  f.panel(f.first, 1, [0, 100, 150, 100], pdfAsset(source));
  const drawPage = spyOnDrawPage();
  await pdfExporter.run(f.i, {});
  // The paper's layer, the two panels, then page 2.
  expect(drawn(drawPage).map((o) => o.opacity)).toEqual([undefined, 0.5, undefined, undefined]);
});

test("PDF panels are not 'rasterised' any more: those warnings go, the others stay", async () => {
  const f = panelFigure();
  f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(await sourcePdf([[300, 200]])));
  f.i.warnings.push("Node p-aaaa: PDF panel rasterised", "Node p-bbbb: link missing, skipped", "Node p-cccc rasterised");
  const { warnings } = await pdfExporter.run(f.i, {});
  expect(warnings).toEqual(["Node p-bbbb: link missing, skipped", "Node p-cccc rasterised"]);
});

test("a page that cannot be embedded fails the export, naming the node and the page", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]]);
  const node = f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(source, { pageIndex: 4 }));
  await expect(pdfExporter.run(f.i, {})).rejects.toThrow(`${nodeLabel(f.i.doc, node)}: could not embed page 5 of the PDF`);
});

test("a source that is not a PDF fails the export, naming the node and the page", async () => {
  const f = panelFigure();
  const node = f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(new TextEncoder().encode("not a pdf").buffer as ArrayBuffer));
  await expect(pdfExporter.run(f.i, {})).rejects.toThrow(`${nodeLabel(f.i.doc, node)}: could not embed page 1 of the PDF as vectors`);
});

test("a source page with its own rotation is refused rather than drawn turned", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]], (page) => page.setRotation(degrees(90)));
  const node = f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(source));
  await expect(pdfExporter.run(f.i, {})).rejects.toThrow(new RegExp(`${escapeRe(nodeLabel(f.i.doc, node))}: .*rotation`));
});

test("a crop with no area fails the export instead of drawing a broken page", async () => {
  const f = panelFigure();
  const source = await sourcePdf([[300, 200]]);
  const node = f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(source), { crop: { x: 0.5, y: 0, w: 0, h: 1 } });
  await expect(pdfExporter.run(f.i, {})).rejects.toThrow(new RegExp(`${escapeRe(nodeLabel(f.i.doc, node))}: .*no area`));
});

describe("fonts the PDF cannot set", () => {
  test("a label in Calibri is reported once, naming the font it gets; Arial, Helvetica and Times New Roman are not", async () => {
    const i = input();
    const [first, second] = i.doc.pages;
    const label = (page: Page, family: string) => {
      const node = textNodeDefaults(page, { text: "A" }, i.doc.nodes.map((n) => n.id));
      node.font = { ...node.font, family };
      i.doc.nodes.push(node);
      return node;
    };
    const calibri = label(first, "Calibri");
    for (const family of ["Arial", "helvetica", "Times New Roman"]) label(first, family);
    const courier = label(second, "Courier New");
    i.warnings.push("Node p-zzzz: link missing, skipped");
    const { warnings } = await pdfExporter.run(i, {});
    expect(warnings).toEqual([
      "Node p-zzzz: link missing, skipped",
      `${nodeLabel(i.doc, calibri)}: font "Calibri" substituted by Times in PDF`,
      `${nodeLabel(i.doc, courier)}: font "Courier New" substituted by Times in PDF`,
    ]);
  });

  test("only the pages exported count, and the layered path reports them too", async () => {
    const f = panelFigure();
    f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(await sourcePdf([[300, 200]])));
    const georgia = textNodeDefaults(f.first, { text: "B" }, f.i.doc.nodes.map((n) => n.id));
    georgia.font = { ...georgia.font, family: "Georgia" };
    const elsewhere = textNodeDefaults(f.second, { text: "C" }, [...f.i.doc.nodes.map((n) => n.id), georgia.id]);
    elsewhere.font = { ...elsewhere.font, family: "Georgia" };
    f.i.doc.nodes.push(georgia, elsewhere);
    const { warnings } = await pdfExporter.run({ ...f.i, pages: [f.first] }, {});
    expect(warnings).toEqual([`${nodeLabel(f.i.doc, georgia)}: font "Georgia" substituted by Times in PDF`]);
  });
});

describe("encrypted source PDFs", () => {
  /** `sourcePdf`, encrypted with the given passwords. */
  async function encryptedPdf(passwords: { ownerPassword: string; userPassword?: string }): Promise<ArrayBuffer> {
    const doc = await PDFDocument.load(await sourcePdf([[300, 200]]));
    doc.encrypt(passwords);
    const bytes = await doc.save();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  test("a file with only an owner password is opened and embedded as vectors", async () => {
    const source = await encryptedPdf({ ownerPassword: "owner" });
    await expect(PDFDocument.load(source)).rejects.toThrow(/encrypted/);
    const f = panelFigure();
    f.panel(f.first, 0, [40, 30, 300, 200], pdfAsset(source));
    const drawPage = spyOnDrawPage();
    const { files } = await pdfExporter.run(f.i, {});
    expect(drawn(drawPage)[1]).toMatchObject({ x: expect.closeTo(40), width: expect.closeTo(300), height: expect.closeTo(200) });
    // The output is not encrypted itself, and holds the source page as a form of the page's size.
    expect(await formBoxes(files[0].blob, 0)).toContainEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  test("a file that needs a user password still fails, naming the node and the page", async () => {
    const source = await encryptedPdf({ ownerPassword: "owner", userPassword: "secret" });
    const f = panelFigure();
    const node = f.panel(f.first, 0, [0, 0, 150, 100], pdfAsset(source));
    await expect(pdfExporter.run(f.i, {})).rejects.toThrow(`${nodeLabel(f.i.doc, node)}: could not embed page 1 of the PDF as vectors`);
  });
});
