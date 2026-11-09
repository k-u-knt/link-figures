import { PDFDocument } from "@cantoo/pdf-lib";
import { pdfExporter } from "../../src/export/exporters/pdf";
import { createPptxExporter } from "../../src/export/exporters/pptx";
import { createTiffExporter } from "../../src/export/exporters/raster";
import { buildPageSvg } from "../../src/export/svg-builder";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, fileNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import type { Node } from "../../src/model/types";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";
import { PNG_BYTES, pptxRegistries } from "./pptx/context";
import { all, one, parseXml, unzipText } from "./pptx/ooxml";

// The file node type imports the real Obsidian API for its DOM; these suites only build strings and zips.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

// The PDF exporter's jsPDF and svg2pdf.js are a recorder (as in pdf-exporter.test.ts): each layer's SVG is kept, and its
// PDF is a real one-page PDF that pdf-lib can embed.
const pdfLayers = vi.hoisted(() => ({ svgs: [] as string[], bytes: undefined as ArrayBuffer | undefined }));
vi.mock("jspdf", () => ({
  jsPDF: class {
    addPage() {}
    async svg(element: { source: string }) {
      pdfLayers.svgs.push(element.source);
    }
    output(type: string) {
      return type === "arraybuffer" ? pdfLayers.bytes?.slice(0) : new Blob(["%PDF"], { type: "application/pdf" });
    }
  },
}));
vi.mock("svg2pdf.js", () => ({}));

/** A one-page PDF with something drawn on it, which pdf-lib can embed. */
async function onePagePdf(width: number, height: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]).drawRectangle({ x: 0, y: 0, width: width / 2, height: height / 2 });
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** There is no DOM here: what the PDF exporter parses is handed on as its source. */
class FakeDOMParser {
  parseFromString(source: string) {
    return { documentElement: { source }, getElementsByTagName: () => [] };
  }
}

const UNREADABLE = '"x.chart" item skipped: its plugin could not read it';

/**
 * A figure holding two "x.chart" items and a shape, loaded with a registered "x.chart" type whose migrate hook throws:
 * the load result, and the type's drawing hooks (spies, which an export must never call for those items).
 */
function figure() {
  const doc = createDocument("nature-double");
  const page = doc.pages[0];
  const chart = (id: string) => ({ id, type: "x.chart", page: page.id, x: 0, y: 0, width: 20, height: 20, z: 0, rotation: 0, opacity: 1, locked: false, series: "bad" });
  const text = serializeFigureFile({ ...doc, nodes: [chart("x-1"), chart("x-2"), shapeNodeDefaults(page, { id: "s", x: 30, y: 30, width: 40, height: 20, z: 1 }, [])] as unknown as Node[] }, emptyParsed());
  const registries = pptxRegistries();
  const toSvg = vi.fn(() => "<g/>");
  const toPptx = vi.fn(() => ({ xml: "" }));
  const overlaySvg = vi.fn(() => "");
  const chartType = {
    type: "x.chart",
    name: "Chart",
    icon: "chart",
    mount: () => ({ update() {}, unmount() {} }),
    bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }),
    inspector: () => [],
    toSvg,
    toPptx,
    overlaySvg,
    migrate: () => {
      throw new Error('"series" must be a list');
    },
  } as unknown as NodeType;
  registries.nodeTypes.register(chartType);
  const loaded = loadDocument(text, registries);
  return { loaded, registries, spies: [toSvg, toPptx, overlaySvg] };
}

test("the load result names the nodes its plugin could not read", () => {
  const { loaded } = figure();
  expect([...loaded.unreadable]).toEqual(["x-1", "x-2"]);
});

test("SVG: an unreadable item is skipped with the warning, said once, and its type is never asked to draw it", () => {
  const { loaded, registries, spies } = figure();
  const page = loaded.doc.pages[0];
  const { svg, warnings, drawn } = buildPageSvg(loaded.doc, page, registries, new Map(), { unreadable: loaded.unreadable });
  expect(warnings).toEqual([UNREADABLE]);
  expect(drawn).toBe(1);
  expect(svg).not.toContain("<g/>");
  const overlays = buildPageSvg(loaded.doc, page, registries, new Map(), { unreadable: loaded.unreadable, overlaysOnly: true });
  expect(overlays.warnings).toEqual([UNREADABLE]);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test("PPTX: an unreadable item is skipped with the warning, said once, and toPptx and toSvg are never called", async () => {
  const { loaded, registries, spies } = figure();
  const backend = { renderClearPng: async () => PNG_BYTES };
  const input = {
    doc: loaded.doc,
    pages: loaded.doc.pages,
    svgs: new Map(),
    assets: new Map(),
    registries,
    warnings: buildPageSvg(loaded.doc, loaded.doc.pages[0], registries, new Map(), { unreadable: loaded.unreadable }).warnings,
    baseName: "Fig",
    dpi: 150,
    unreadable: loaded.unreadable,
  };
  const result = await createPptxExporter(backend).run(input, {});
  expect(result.warnings).toEqual([UNREADABLE]);
  const slide = parseXml(unzipText(new Uint8Array(await result.files[0].blob.arrayBuffer())).get("ppt/slides/slide1.xml")!);
  expect(all(one(slide, "p:spTree"), "p:cNvPr").slice(1).map((c) => c.getAttribute("name"))).toEqual(["s"]);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test("PDF (layered, with a PDF panel): neither an unreadable panel's overlay nor an unreadable item in a layer is handed to its type", async () => {
  vi.stubGlobal("DOMParser", FakeDOMParser);
  try {
    pdfLayers.svgs.length = 0;
    pdfLayers.bytes = await onePagePdf(100, 100);
    const doc = createDocument("nature-double");
    const page = doc.pages[0];
    // A PDF panel at z 0 and an "x.chart" item above it, both unreadable: the page is composed in layers, the panel's
    // overlay built on its own (the first `buildPageSvg` call in layeredPdf) and the item in the layer above it (the second).
    const panel = { ...fileNodeDefaults(page, { file: "plot.pdf", subpath: "", show: "image" }, []), id: "p", z: 0, x: 0, y: 0, width: 100, height: 100 };
    const chart = { id: "x-1", type: "x.chart", page: page.id, x: 0, y: 0, width: 20, height: 20, z: 1, rotation: 0, opacity: 1, locked: false } as unknown as Node;
    doc.nodes.push(panel, chart);
    const registries = createRegistries();
    const toSvg = vi.fn(() => '<g id="drawn"/>');
    const overlaySvg = vi.fn(() => '<g id="overlay"/>');
    const draws = { mount: () => ({ update() {}, unmount() {} }), bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }), inspector: () => [], toSvg, overlaySvg };
    registries.nodeTypes.register({ type: "file", name: "File", icon: "f", ...draws } as unknown as NodeType);
    registries.nodeTypes.register({ type: "x.chart", name: "Chart", icon: "c", ...draws } as unknown as NodeType);
    const asset = { kind: "pdf", bytes: await onePagePdf(300, 200), pageIndex: 0, widthPt: 300, heightPt: 200, raster: "data:image/png;base64,", rasterWidth: 1, rasterHeight: 1 } as const;
    const result = await pdfExporter.run(
      {
        doc,
        pages: [page],
        svgs: new Map([[page.id, "<svg/>"]]),
        assets: new Map([[page.id, new Map([["p", asset]])]]),
        registries,
        warnings: [],
        baseName: "Fig",
        dpi: 300,
        unreadable: new Set(["p", "x-1"]),
      },
      {},
    );
    expect(result.files).toHaveLength(1);
    expect(toSvg).not.toHaveBeenCalled();
    expect(overlaySvg).not.toHaveBeenCalled();
    expect(pdfLayers.svgs.join("")).not.toMatch(/id="(drawn|overlay)"/);
    // Said by the overlay build; the layers' own skips were said when the page's SVG was built, before the exporter.
    expect(result.warnings).toEqual(['"file" item skipped: its plugin could not read it']);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("TIFF: the page rasterised is the one built without the unreadable items, and the warning is passed on", async () => {
  const { loaded, registries, spies } = figure();
  const page = loaded.doc.pages[0];
  const built = buildPageSvg(loaded.doc, page, registries, new Map(), { unreadable: loaded.unreadable });
  const rasterised: string[] = [];
  const backend = {
    rasterise: async (svg: string, width: number, height: number) => {
      rasterised.push(svg);
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    renderPng: vi.fn(),
  };
  const result = await createTiffExporter(backend).run(
    { doc: loaded.doc, pages: [page], svgs: new Map([[page.id, built.svg]]), assets: new Map(), registries, warnings: built.warnings, baseName: "Fig", dpi: 10, unreadable: loaded.unreadable },
    {},
  );
  expect(result.warnings).toEqual([UNREADABLE]);
  expect(rasterised).toHaveLength(1);
  expect(rasterised[0]).not.toContain("<g/>");
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
