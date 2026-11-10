import { PDFDocument } from "@cantoo/pdf-lib";
import { pdfExporter } from "../../src/export/exporters/pdf";
import { createPptxExporter } from "../../src/export/exporters/pptx";
import { buildPageSvg } from "../../src/export/svg-builder";
import { mmToPx } from "../../src/model/geometry";
import { connectorNodeDefaults, createDocument, fileNodeDefaults, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Document, Node } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { isExported, type NodeType } from "../../src/registry/node-type";
import { PNG_BYTES, pptxRegistries } from "./pptx/context";
import { all, one, parseXml, unzipText } from "./pptx/ooxml";

// The file node type imports the real Obsidian API for its DOM; these suites only build strings and zips.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

// The PDF exporter's jsPDF and svg2pdf.js are a recorder (as in pdf-exporter.test.ts).
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

async function onePagePdf(width: number, height: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]).drawRectangle({ x: 0, y: 0, width: width / 2, height: height / 2 });
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

class FakeDOMParser {
  parseFromString(source: string) {
    return { documentElement: { source }, getElementsByTagName: () => [] };
  }
}

const MM = mmToPx(1);

/** A shape as PowerPoint XML named by its id, so a slide's items can be listed by name. */
const named = (node: Node) => ({ xml: `<p:sp><p:nvSpPr><p:cNvPr id="${node.z + 10}" name="${node.id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>` });

/**
 * Registries whose card and connector types draw a marker naming the node (in SVG and in PowerPoint), so what an export
 * drew can be read off it; the card's spies must never be called.
 */
function registries() {
  const r = pptxRegistries();
  const cardSvg = vi.fn((n: Node) => `<g id="drawn-${n.id}"/>`);
  const cardPptx = vi.fn(named);
  r.nodeTypes.register({ ...cardNodeType, toSvg: cardSvg, toPptx: cardPptx } as unknown as NodeType);
  r.nodeTypes.register({
    ...connectorNodeType,
    toSvg: (n: Node) => `<g id="drawn-${n.id}"/>`,
    toPptx: named,
  } as unknown as NodeType);
  r.nodeTypes.register({ ...r.nodeTypes.get("shape")!, toPptx: named } as unknown as NodeType);
  return { r, spies: [cardSvg, cardPptx] };
}

/**
 * Page 1 holding shapes `s` and `s2` and a connector `k` between them (all exported), a card `c` beside the paper, an
 * association `assoc` from the card to the page, and a connector `kc` from the card to `s`. With `grouped`, the card
 * and `s` are in group `g`.
 */
function figure(r: ReturnType<typeof registries>["r"], grouped = false): Document {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const card = { ...cardNodeDefaults(page, 220 * MM, 10 * MM), id: "c", z: 3 } as Node;
  doc.nodes.push(
    shapeNodeDefaults(page, { id: "s", x: 10, y: 10, width: 50, height: 50, z: 0 }, []),
    shapeNodeDefaults(page, { id: "s2", x: 100, y: 10, width: 50, height: 50, z: 1 }, []),
    connectorNodeDefaults(page, { id: "k", z: 2, ends: [{ kind: "attached", node: "s", snap: "center" }, { kind: "attached", node: "s2", snap: "center" }] }, []),
    card,
    connectorNodeDefaults(page, { id: "assoc", z: 4, ends: [{ kind: "attached", node: "c", snap: "anchor", anchor: "w" }, { kind: "page", page: page.id, anchor: "e" }] }, []),
    connectorNodeDefaults(page, { id: "kc", z: 5, ends: [{ kind: "attached", node: "c", snap: "center" }, { kind: "attached", node: "s", snap: "center" }] }, []),
  );
  if (grouped) {
    doc.nodes.push(groupNodeDefaults(page, { id: "g" }, []));
    for (const n of doc.nodes) if (n.id === "s" || n.id === "c") n.parent = "g";
  }
  return createFigureStore(doc, r).doc;
}

async function pptxNames(doc: Document, r: ReturnType<typeof registries>["r"]): Promise<string[]> {
  const backend = { renderClearPng: async () => PNG_BYTES };
  const result = await createPptxExporter(backend).run({ doc, pages: doc.pages, svgs: new Map(), assets: new Map(), registries: r, warnings: [], baseName: "Fig", dpi: 150 }, {});
  const slide = parseXml(unzipText(new Uint8Array(await result.files[0].blob.arrayBuffer())).get("ppt/slides/slide1.xml")!);
  return all(one(slide, "p:spTree"), "p:cNvPr").map((c) => c.getAttribute("name") ?? "");
}

test("isExported: false for a card, for an association and for a connector touching a card; true otherwise", () => {
  const { r } = registries();
  const doc = figure(r);
  const exported = doc.nodes.filter((n) => isExported(doc, r, n)).map((n) => n.id);
  expect(exported).toEqual(["s", "s2", "k"]);
});

test("SVG, PDF layers and PPTX draw no card, no association, and no connector touching a card", async () => {
  const { r, spies } = registries();
  const doc = figure(r);
  const page = doc.pages[0];

  const built = buildPageSvg(doc, page, r, new Map());
  expect(built.svg).toContain('id="drawn-k"');
  expect(built.svg).not.toMatch(/drawn-(c|assoc|kc)"/);
  expect(built.drawn).toBe(3);
  expect(built.warnings).toEqual([]);

  // PDF, composed in layers around a PDF panel at the bottom.
  vi.stubGlobal("DOMParser", FakeDOMParser);
  try {
    pdfLayers.svgs.length = 0;
    pdfLayers.bytes = await onePagePdf(100, 100);
    const panel = { ...fileNodeDefaults(page, { file: "plot.pdf", subpath: "", show: "image" }, []), id: "p", z: -1, x: 0, y: 0, width: 100, height: 100 } as Node;
    const withPanel: Document = { ...doc, nodes: [panel, ...doc.nodes] };
    r.nodeTypes.register({ type: "file", name: "File", icon: "f", mount: () => ({ update() {}, unmount() {} }), bounds: (n: Node) => n, inspector: () => [], toSvg: () => "" } as unknown as NodeType);
    const asset = { kind: "pdf", bytes: await onePagePdf(300, 200), pageIndex: 0, widthPt: 300, heightPt: 200, raster: "data:image/png;base64,", rasterWidth: 1, rasterHeight: 1 } as const;
    const result = await pdfExporter.run(
      { doc: withPanel, pages: [page], svgs: new Map([[page.id, "<svg/>"]]), assets: new Map([[page.id, new Map([["p", asset]])]]), registries: r, warnings: [], baseName: "Fig", dpi: 300 },
      {},
    );
    expect(result.files).toHaveLength(1);
    const layers = pdfLayers.svgs.join("\n");
    expect(layers).toContain('id="drawn-k"');
    expect(layers).not.toMatch(/drawn-(c|assoc|kc)"/);
  } finally {
    vi.unstubAllGlobals();
  }

  const names = await pptxNames(doc, r);
  expect(names).toContain("k");
  expect(names).not.toContain("c");
  expect(names).not.toContain("assoc");
  expect(names).not.toContain("kc");
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test("a group holding a card exports without it", async () => {
  const { r, spies } = registries();
  const doc = figure(r, true);
  expect(doc.nodes.find((n) => n.id === "g")).toBeDefined();
  const built = buildPageSvg(doc, doc.pages[0], r, new Map());
  expect(built.svg).not.toMatch(/drawn-(c|assoc|kc)"/);
  expect(built.drawn).toBe(3);
  const names = await pptxNames(doc, r);
  expect(names).toEqual(expect.arrayContaining(["s", "s2", "k"]));
  expect(names).not.toContain("c");
  expect(names).not.toContain("kc");
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test("a connector to a card its plugin could not read is still not exported", () => {
  const { r } = registries();
  const doc = figure(r);
  const kc = doc.nodes.find((n) => n.id === "kc")!;
  expect(isExported(doc, r, kc, new Set(["c"]))).toBe(false);
});

