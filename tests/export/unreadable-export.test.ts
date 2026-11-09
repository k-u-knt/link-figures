import { createPptxExporter } from "../../src/export/exporters/pptx";
import { buildPageSvg } from "../../src/export/svg-builder";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import type { Node } from "../../src/model/types";
import type { NodeType } from "../../src/registry/node-type";
import { PNG_BYTES, pptxRegistries } from "./pptx/context";
import { all, one, parseXml, unzipText } from "./pptx/ooxml";

// The file node type imports the real Obsidian API for its DOM; these suites only build strings and zips.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

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
