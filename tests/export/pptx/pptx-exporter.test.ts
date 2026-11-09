import { createPptxExporter, slideFit, slideTree } from "../../../src/export/exporters/pptx";
import { PATTERN_WARNING } from "../../../src/export/pptx/drawingml";
import { createDocument, createPage, shapeNodeDefaults, textNodeDefaults } from "../../../src/model/defaults";
import type { Document, Node, Page } from "../../../src/model/types";
import type { ExportInput } from "../../../src/registry/exporter";
import type { NodeType } from "../../../src/registry/node-type";
import { PNG_BYTES, pptxRegistries } from "./context";
import { all, one, parseXml, unzip, unzipText } from "./ooxml";

const E = 9525;

function fakeBackend() {
  const calls: { svg: string; width: number; height: number }[] = [];
  return {
    calls,
    backend: {
      renderClearPng: async (svg: string, width: number, height: number) => {
        calls.push({ svg, width, height });
        return PNG_BYTES;
      },
    },
  };
}

const shape = (page: Page, over: Partial<Node> = {}): Node => ({ ...shapeNodeDefaults(page, {}, []), x: 10, y: 10, width: 50, height: 30, ...over }) as Node;

function input(doc: Document, over: Partial<ExportInput> = {}): ExportInput {
  return { doc, pages: doc.pages, svgs: new Map(), assets: new Map(), registries: pptxRegistries(), warnings: [], baseName: "Fig 1", dpi: 150, ...over };
}

async function run(inp: ExportInput, backend = fakeBackend().backend) {
  const result = await createPptxExporter(backend).run(inp, {});
  const files = await Promise.all(result.files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.blob.arrayBuffer()) })));
  return { ...result, files };
}

const slideOf = (bytes: Uint8Array, n = 1) => parseXml(unzipText(bytes).get(`ppt/slides/slide${n}.xml`)!);
const treeTags = (slide: globalThis.Document) => Array.from(one(slide, "p:spTree").children).slice(2).map((c) => c.tagName);

describe("slideFit", () => {
  it("keeps a page within PowerPoint's sides as it is", () => {
    expect(slideFit(183, 170)).toEqual({ scale: 1, cx: 183 * 36000, cy: 170 * 36000 });
  });

  it("scales a page too large or too small uniformly to fit", () => {
    const big = slideFit(2000, 1000);
    expect(big.scale).toBeCloseTo(1422.4 / 2000, 9);
    expect(big.cx).toBe(51206400);
    expect(big.cy).toBe(Math.round(1000 * big.scale * 36000));
    const small = slideFit(20, 40);
    expect(small.scale).toBeCloseTo(25.4 / 20, 9);
    expect(small.cx).toBe(914400);
  });

  it("widens the short side of a page too long and thin for both limits", () => {
    const thin = slideFit(10, 2000);
    expect(thin.cy).toBe(51206400);
    expect(thin.cx).toBe(914400);
  });
});

describe("pptx exporter", () => {
  it("writes one file per page size, the first under the figure's name, one slide per page in order", async () => {
    const doc = createDocument("nature-double");
    doc.pages.push(createPage("a4-portrait", [doc.pages[0].id], "Big"), createPage("nature-double", [doc.pages[0].id, "x"], "Third"));
    doc.pages[2].id = "pg-third";
    const { files } = await run(input(doc));
    expect(files.map((f) => f.name)).toEqual(["Fig 1.pptx", "Fig 1 (210×297 mm).pptx"]);
    const first = parseXml(unzipText(files[0].bytes).get("ppt/presentation.xml")!);
    expect(all(first, "p:sldId")).toHaveLength(2);
    expect(one(first, "p:sldSz").getAttribute("cx")).toBe(String(183 * 36000));
    const second = parseXml(unzipText(files[1].bytes).get("ppt/presentation.xml")!);
    expect(one(second, "p:sldSz").getAttribute("cy")).toBe(String(297 * 36000));
  });

  it("writes the page's items by z, the paper as the background, and unique ids", async () => {
    const doc = createDocument("nature-double");
    const page = doc.pages[0];
    page.paper = "#fafafa";
    doc.nodes.push(
      { ...textNodeDefaults(page, {}, []), id: "t", z: 2 },
      shape(page, { id: "s", z: 1 }),
    );
    const { files, warnings } = await run(input(doc));
    const slide = slideOf(files[0].bytes);
    expect(all(slide, "p:cNvPr").slice(1).map((c) => c.getAttribute("name"))).toEqual(["s", "t"]);
    const ids = all(slide, "p:cNvPr").map((c) => c.getAttribute("id"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(one(one(slide, "p:bg"), "a:srgbClr").getAttribute("val")).toBe("FAFAFA");
    expect(warnings).toEqual([]);
  });

  it("scales a page outside PowerPoint's sizes, with a warning", async () => {
    const doc = createDocument("nature-double");
    doc.pages[0].width = 2844.8;
    doc.pages[0].height = 100;
    doc.nodes.push(shape(doc.pages[0], { id: "s", x: 100, width: 200 }));
    const { files, warnings } = await run(input(doc));
    const slide = slideOf(files[0].bytes);
    const sp = one(slide, "p:sp");
    expect(one(sp, "a:off").getAttribute("x")).toBe(String(50 * E));
    expect(one(sp, "a:ext").getAttribute("cx")).toBe(String(100 * E));
    expect(warnings).toEqual(['"Page 1" is 2844.8×100 mm, outside PowerPoint\'s slide sizes (25.4-1422.4 mm a side): scaled to 50%']);
  });

  it("keeps a group whose members are adjacent in z as a group in slide coordinates", async () => {
    const doc = createDocument("nature-double");
    const page = doc.pages[0];
    doc.nodes.push(
      { id: "g", type: "group", page: page.id, x: 10, y: 10, width: 100, height: 60, z: 5, rotation: 0, opacity: 1, locked: false } as Node,
      shape(page, { id: "a", z: 1, parent: "g" }),
      shape(page, { id: "b", z: 2, parent: "g" }),
      shape(page, { id: "c", z: 3 }),
    );
    const { files, warnings } = await run(input(doc));
    const slide = slideOf(files[0].bytes);
    expect(treeTags(slide)).toEqual(["p:grpSp", "p:sp"]);
    const grp = one(slide, "p:grpSp");
    const xfrm = one(grp, "p:grpSpPr");
    expect(one(xfrm, "a:off").getAttribute("x")).toBe(one(xfrm, "a:chOff").getAttribute("x"));
    expect(one(xfrm, "a:ext").getAttribute("cx")).toBe(one(xfrm, "a:chExt").getAttribute("cx"));
    expect(one(xfrm, "a:off").getAttribute("x")).toBe(String(10 * E));
    expect(all(grp, "p:sp").map((s) => one(s, "p:cNvPr").getAttribute("name"))).toEqual(["a", "b"]);
    expect(warnings).toEqual([]);
  });

  it("writes a group whose members are not adjacent in z loose, in z order, with a warning", async () => {
    const doc = createDocument("nature-double");
    const page = doc.pages[0];
    doc.nodes.push(
      { id: "g", type: "group", page: page.id, x: 10, y: 10, width: 100, height: 60, z: 5, rotation: 0, opacity: 1, locked: false } as Node,
      shape(page, { id: "a", z: 1, parent: "g" }),
      shape(page, { id: "c", z: 2 }),
      shape(page, { id: "b", z: 3, parent: "g" }),
    );
    const { files, warnings } = await run(input(doc));
    const slide = slideOf(files[0].bytes);
    expect(treeTags(slide)).toEqual(["p:sp", "p:sp", "p:sp"]);
    expect(all(slide, "p:cNvPr").slice(1).map((c) => c.getAttribute("name"))).toEqual(["a", "c", "b"]);
    expect(warnings).toEqual(["Group (Page 1): its members are not next to each other in the stacking order, written as separate items"]);
  });

  it("nests kept groups, and keeps an inner group whose outer group is flattened", async () => {
    const doc = createDocument("nature-double");
    const page = doc.pages[0];
    const group = (id: string, parent?: string) => ({ id, type: "group", page: page.id, x: 0, y: 0, width: 100, height: 100, z: 9, rotation: 0, opacity: 1, locked: false, ...(parent ? { parent } : {}) }) as Node;
    doc.nodes.push(group("outer"), group("inner", "outer"), shape(page, { id: "a", z: 1, parent: "inner" }), shape(page, { id: "b", z: 2, parent: "inner" }), shape(page, { id: "x", z: 3 }), shape(page, { id: "c", z: 4, parent: "outer" }));
    const flattened: Node[] = [];
    const tree = slideTree(doc, page, pptxRegistries(), flattened);
    expect(flattened.map((g) => g.id)).toEqual(["outer"]);
    expect(tree.map((t) => (t.kind === "group" ? `[${t.children.map((c) => c.node.id).join(",")}]` : t.node.id))).toEqual(["[a,b]", "x", "c"]);

    doc.nodes = doc.nodes.filter((n) => n.id !== "x");
    const nested = slideTree(doc, page, pptxRegistries(), []);
    expect(nested).toHaveLength(1);
    const outer = nested[0];
    expect(outer.kind === "group" && outer.children.map((c) => `${c.kind}:${c.node.id}`)).toEqual(["group:inner", "item:c"]);
  });

  it("writes an item whose type has no hook as a clear picture of its drawing, with a warning", async () => {
    const doc = createDocument("nature-double");
    const page = doc.pages[0];
    doc.nodes.push({ id: "w", type: "widget", page: page.id, x: 20, y: 30, width: 40, height: 20, z: 0, rotation: 0, opacity: 1, locked: false } as unknown as Node);
    const registries = pptxRegistries();
    const widget = {
      type: "widget",
      name: "Widget",
      icon: "",
      mount: () => ({ update() {}, unmount() {} }),
      bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }),
      inspector: () => [],
      toSvg: (n: Node) => `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="#00f"/>`,
    } as unknown as NodeType;
    registries.nodeTypes.register(widget);
    const fake = fakeBackend();
    const { files, warnings } = await run(input(doc, { registries }), fake.backend);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].svg).toContain('<rect x="20" y="30" width="40" height="20" fill="#00f"/>');
    // The box and an 8 px margin, at 150 dpi.
    expect(fake.calls[0].svg).toContain('viewBox="12 22 56 36"');
    // No paper: what the item does not cover stays clear.
    expect(fake.calls[0].svg).not.toContain("#ffffff");
    expect(Math.abs(fake.calls[0].width - (56 / 96) * 150)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fake.calls[0].height - (36 / 96) * 150)).toBeLessThanOrEqual(0.5);
    const slide = slideOf(files[0].bytes);
    const pic = one(slide, "p:pic");
    expect(one(pic, "a:off").getAttribute("x")).toBe(String(12 * E));
    const entries = unzip(files[0].bytes).map((e) => e.name);
    expect(entries).toContain("ppt/media/image1.png");
    expect(warnings).toEqual(['Item "widget" (Page 1): written as a picture']);
  });

  it("names media image1, image2… across the whole export, never after vault files", async () => {
    const doc = createDocument("nature-double");
    doc.pages.push(createPage("nature-double", [doc.pages[0].id], "Page 2"));
    const uri = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
    const panel = (page: Page, id: string) => ({ ...shapeNodeDefaults(page, {}, []), id, type: "file", file: "secret name.png", subpath: "", show: "image", imageIndex: 0, crop: null, fit: "cover", pageIndex: 0, range: "auto", scale: 1, frame: null, adjustments: [] }) as unknown as Node;
    doc.nodes.push(panel(doc.pages[0], "p1"), panel(doc.pages[1], "p2"));
    const assets = new Map(doc.pages.map((p, i) => [p.id, new Map([[`p${i + 1}`, { kind: "image" as const, dataUri: uri, naturalWidth: 10, naturalHeight: 10 }]])]));
    const { files } = await run(input(doc, { assets }));
    const names = unzip(files[0].bytes).map((e) => e.name).filter((n) => n.startsWith("ppt/media/"));
    expect(names).toEqual(["ppt/media/image1.png", "ppt/media/image2.png"]);
  });

  it("reports each warning once, and drops the SVG build's own", async () => {
    const doc = createDocument("nature-double");
    const page = doc.pages[0];
    const hatch = { type: "pattern", pattern: "hatch", fg: "#000000", bg: null };
    doc.nodes.push(shape(page, { id: "a", fill: hatch } as Partial<Node>), shape(page, { id: "b", fill: hatch } as Partial<Node>));
    const { warnings } = await run(input(doc, { warnings: ['Shape "rect" (Page 1) rasterised', "Page \"x\" is over the limit"] }));
    expect(warnings).toEqual(['Shape "rect" (Page 1) rasterised', 'Page "x" is over the limit', PATTERN_WARNING]);
  });
});
