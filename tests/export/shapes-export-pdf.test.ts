// @vitest-environment happy-dom
import { inflateSync } from "node:zlib";
import { jsPDF } from "jspdf";
// The package's `main` is a UMD bundle that looks for a global jsPDF; its ES build patches the imported one.
import "svg2pdf.js/dist/svg2pdf.es.js";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import type { AssetMap } from "../../src/export/asset-types";
import { pdfExporter } from "../../src/export/exporters/pdf";
import { buildPageSvg } from "../../src/export/svg-builder";
import type { Document, FileNode } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { fileFrameSvg, fileNodeSvg } from "../../src/nodes/file-node-svg";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { NodeType, SvgContext } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { connector, docWith, hatch, panel, panelAssets, shape, STOPS } from "./shapes-fixtures";

// The exporter imports svg2pdf.js by its package name, whose UMD build wants a global jsPDF; the ES build above already patched it.
vi.mock("svg2pdf.js", () => ({}));

/**
 * The file node type's export, drawn by the same functions it uses. The type itself imports the Obsidian API, which
 * cannot be resolved in a DOM environment; tests/export/shapes-export.test.ts checks that the type draws with these.
 */
const fileExport = {
  type: "file",
  toSvg: (node: FileNode, ctx: SvgContext) => {
    const asset = ctx.assets.get(node.id);
    return fileNodeSvg(node, asset && asset.kind !== "raster" ? asset : undefined, ctx);
  },
  overlaySvg: (node: FileNode, ctx: SvgContext) => fileFrameSvg(node, ctx),
} as Pick<NodeType<FileNode>, "type" | "toSvg" | "overlaySvg"> as NodeType<FileNode>;

function registries() {
  const r = createRegistries();
  for (const paint of builtinPaintTypes) r.paints.register(paint);
  for (const kind of builtinShapeKinds) r.shapes.register(kind);
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  r.nodeTypes.register(fileExport as never);
  return r;
}

/** The page's content streams of a PDF jsPDF wrote compressed, inflated, and the PDF's own text. */
async function pdfParts(blob: Blob): Promise<{ text: string; content: string }> {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const text = bytes.toString("latin1");
  const streams: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    try {
      streams.push(inflateSync(bytes.subarray(start, end)).toString("latin1"));
    } catch {
      // Not a deflated stream.
    }
    re.lastIndex = end + "endstream".length;
  }
  return { text, content: streams.join("\n") };
}

describe("svg2pdf.js 2.8.1", () => {
  /** What svg2pdf.js writes for the SVG body, uncompressed. */
  const draw = async (defs: string, body: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs>${defs}</defs>${body}</svg>`;
    const pdf = new jsPDF({ unit: "px", format: [200, 120], compress: false, hotfixes: ["px_scaling"] });
    await pdf.svg(new DOMParser().parseFromString(svg, "image/svg+xml").documentElement, { x: 0, y: 0, width: 200, height: 120 });
    return pdf.output();
  };
  const GRADIENT = `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="190" y2="0">${STOPS}</linearGradient>`;
  const PATTERN = '<pattern id="p" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M0 8 L8 0" stroke="#000000"/></pattern>';

  // The probe the PDF stroke conversion rests on. Should svg2pdf.js start painting these strokes, this fails, and the
  // conversion in `outlinePaintedStrokes` can be reconsidered.
  test("paints a gradient or pattern fill as vectors, but leaves a gradient or pattern stroke unpainted", async () => {
    for (const [defs, ref] of [
      [GRADIENT, "url(#g)"],
      [PATTERN, "url(#p)"],
    ]) {
      const stroked = await draw(defs, `<path d="M10 60 L190 60" fill="none" stroke="${ref}" stroke-width="10"/>`);
      // The path is built and then ended with `n`: no paint at all, not even a solid colour.
      expect(stroked).toMatch(/10\. 60\. m\n190\. 60\. l\nn\n/);
      expect(stroked).not.toMatch(/\/Shading|\/PatternType/);
      const filled = await draw(defs, `<path d="M10 50 L190 50 L190 70 L10 70 Z" fill="${ref}"/>`);
      expect(filled).toMatch(/\/Sh\d+ sh|\/Pattern cs\n\/P\d+ scn\nf/);
    }
  });

  // The probe the pattern pre-pass rests on: the /BBox follows the pattern's x and y, but the tile is drawn at the
  // origin. Should this start failing, the pre-pass (`normalisePatternOrigins`) can go.
  test("writes a pattern's /BBox at its x and y, away from where the tile is drawn", async () => {
    const offset = await draw(PATTERN.replace('width="8"', 'x="30" y="40" width="8"'), '<rect width="100" height="100" fill="url(#p)"/>');
    expect(offset).toMatch(/\/BBox \[30\. 40\. 38\. 48\.\]/);
  });
});

describe("PDF export", () => {
  const exportPdf = async (d: Document, assets: AssetMap = new Map()) => {
    const r = registries();
    const page = d.pages[0];
    const built = buildPageSvg(d, page, r, assets);
    return pdfExporter.run({
      doc: d,
      pages: [page],
      svgs: new Map([[page.id, built.svg]]),
      assets: new Map([[page.id, assets]]),
      registries: r,
      warnings: built.warnings,
      baseName: "figure",
      dpi: 300,
    }, {});
  };

  test("a connector's gradient stroke is a vector gradient filling the line's outline, with no image for it", async () => {
    const result = await exportPdf(docWith(connector));
    expect(result.warnings).toEqual([]);
    const { text, content } = await pdfParts(result.files[0].blob);
    expect(text).toMatch(/\/ShadingType 2/);
    // The shading paints through a clip of the outline: `W n` then `sh`, once for the line and once for the arrowhead.
    expect(content.match(/W\s+n[\s\S]*?\/Sh\d+ sh/g)?.length).toBe(2);
    expect(text).not.toMatch(/\/Subtype \/Image/);
  });

  test("a file panel's pattern frame is a vector pattern filling the frame's outline", async () => {
    const result = await exportPdf(docWith(panel), panelAssets());
    expect(result.warnings).toEqual([]);
    const { text, content } = await pdfParts(result.files[0].blob);
    expect(text).toMatch(/\/PatternType 1/);
    expect(content).toMatch(/\/Pattern cs\s+\/P\d+ scn\s+f/);
    expect(text).not.toMatch(/\/Subtype \/Image/);
  });

  test("a pattern fill away from the page's origin keeps its tile: every pattern's /BBox starts at the origin", async () => {
    const result = await exportPdf(docWith((d) => ({ ...shape(d), fill: hatch, x: 60, y: 60 })));
    const { text } = await pdfParts(result.files[0].blob);
    const dictionaries = text.match(/<<[^>]*\/PatternType 1[^>]*>>/g) ?? [];
    expect(dictionaries.length).toBeGreaterThan(0);
    for (const dictionary of dictionaries) {
      const [, xStep] = /\/XStep ([\d.]+)/.exec(dictionary)!;
      const [, yStep] = /\/YStep ([\d.]+)/.exec(dictionary)!;
      expect(dictionary).toContain(`/BBox [0. 0. ${xStep} ${yStep}]`);
    }
  });
});

describe("PDF export notice", () => {
  test("a linked SVG's gradient line that cannot be outlined is drawn in one colour, and the notice names its panel", async () => {
    const arc =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g">${STOPS}</linearGradient></defs>` +
      '<path d="M1 5 A4 4 0 0 1 9 5" fill="none" stroke="url(#g)"/></svg>';
    const d = docWith((doc) => ({ ...panel(doc), frame: null }));
    const assets: AssetMap = new Map([["f", { kind: "svg", text: arc, width: 10, height: 10 }]]);
    const r = registries();
    const page = d.pages[0];
    const built = buildPageSvg(d, page, r, assets);
    const result = await pdfExporter.run({ doc: d, pages: [page], svgs: new Map([[page.id, built.svg]]), assets: new Map([[page.id, assets]]), registries: r, warnings: built.warnings, baseName: "figure", dpi: 300 }, {});
    expect(result.warnings).toEqual([`Panel "plot.svg" (${page.name}): gradient line drawn in one colour in the PDF`]);
  });
});
