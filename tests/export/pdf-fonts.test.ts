// @vitest-environment happy-dom
import { inflateSync } from "node:zlib";
import { PDFDocument } from "@cantoo/pdf-lib";
import { jsPDF } from "jspdf";
// The package's `main` is a UMD bundle that looks for a global jsPDF; its ES build patches the imported one.
import "svg2pdf.js/dist/svg2pdf.es.js";
import type { AssetMap, PdfAsset } from "../../src/export/asset-types";
import { pdfExporter } from "../../src/export/exporters/pdf";
import { expandFont, faceResolver, prepareFonts, usedFamilies, type FaceResolver } from "../../src/export/pdf-fonts";
import { buildPageSvg } from "../../src/export/svg-builder";
import { createDocument, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { nodeLabel } from "../../src/model/labels";
import type { Document, FileNode, Page, TextNode } from "../../src/model/types";
import { textNodeSvg } from "../../src/nodes/text-node-svg";
import { createRegistries, type Registries } from "../../src/registry";
import { FontSourceUnavailableError, type FontSource, type FontStyle, type LoadedFace } from "../../src/registry/font-source";
import type { NodeType } from "../../src/registry/node-type";
import { buildFont, type BuildStyle } from "../fonts/build-font";

// The exporter imports svg2pdf.js by its package name, whose UMD build wants a global jsPDF; the ES build above already patched it.
vi.mock("svg2pdf.js", () => ({}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const LATIN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789  .,";
const STYLE_NAMES: Record<FontStyle, BuildStyle> = { normal: "Regular", bold: "Bold", italic: "Italic", bolditalic: "Bold Italic" };

/** A family's faces, built in code: the styles given, each mapping `chars`. */
const family = (name: string, styles: FontStyle[] = ["normal"], chars = LATIN, padGlyphs = 0) =>
  Object.fromEntries(styles.map((s) => [s, buildFont({ family: name, style: STYLE_NAMES[s], chars, padGlyphs })])) as Partial<Record<FontStyle, Uint8Array>>;

/**
 * A source over built fonts, matching names case-insensitively. A missing style is stood in for by the regular face,
 * as the local source does (exact: false).
 */
function fakeSource(families: Record<string, Partial<Record<FontStyle, Uint8Array>>>): FontSource & { asked: [string, FontStyle][] } {
  const asked: [string, FontStyle][] = [];
  const byKey = new Map(Object.entries(families).map(([name, faces]) => [name.toLowerCase(), { name, faces }]));
  return {
    id: "fake",
    name: "Fake fonts",
    asked,
    async list() {
      return Object.keys(families);
    },
    async find(name, style): Promise<LoadedFace | null> {
      asked.push([name, style]);
      const found = byKey.get(name.toLowerCase());
      if (!found) return null;
      const exact = found.faces[style];
      if (exact) return { bytes: exact, family: found.name, style, exact: true };
      const regular = found.faces.normal;
      return regular ? { bytes: regular, family: found.name, style: "normal", exact: false } : null;
    },
  };
}

const hiddenSource: FontSource = {
  id: "hidden",
  name: "Hidden",
  async list() {
    throw new FontSourceUnavailableError("installed fonts could not be read (Obsidian was not visible)");
  },
  async find() {
    throw new FontSourceUnavailableError("installed fonts could not be read (Obsidian was not visible)");
  },
};

const resolverOver = (...sources: FontSource[]): FaceResolver => {
  const r = createRegistries();
  for (const s of sources) r.fontSources.register(s);
  return faceResolver(r);
};

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

// ---- Figures, exported for real ------------------------------------------------------------------------------------

const textType = { type: "text", toSvg: textNodeSvg } as unknown as NodeType;
/** File nodes draw nothing in an SVG layer here: the PDF panels are embedded by pdf-lib. */
const fileType = { type: "file", toSvg: () => "", overlaySvg: () => "" } as unknown as NodeType;

function registries(...sources: FontSource[]): Registries {
  const r = createRegistries();
  r.nodeTypes.register(textType as never);
  r.nodeTypes.register(fileType as never);
  for (const s of sources) r.fontSources.register(s);
  return r;
}

function figure() {
  const doc = createDocument("nature-double");
  const page = doc.pages[0];
  return {
    doc,
    page,
    label(text: string, font: Partial<TextNode["font"]> = {}, over: Partial<TextNode> = {}): TextNode {
      const node = textNodeDefaults(page, { text, x: 20, y: 20 + 40 * doc.nodes.length, z: doc.nodes.length, ...over }, doc.nodes.map((n) => n.id));
      node.font = { ...node.font, ...font };
      doc.nodes.push(node);
      return node;
    },
  };
}

/** A figure that is one linked SVG panel showing `plot`, exported. */
async function exportPanel(plot: string, ...sources: FontSource[]) {
  const f = figure();
  const panel: FileNode = { ...fileNodeDefaults(f.page, { file: "plot.svg", subpath: "", show: "image", frame: null }, []), id: "f", x: 20, y: 20, width: 100, height: 100 };
  f.doc.nodes.push(panel);
  const r = registries(...sources);
  const { fileNodeSvg } = await import("../../src/nodes/file-node-svg");
  r.nodeTypes.register({ type: "file", toSvg: (n: FileNode, ctx: never) => fileNodeSvg(n, { kind: "svg", text: plot, width: 100, height: 100 }, ctx) } as never);
  return exportPdf(f.doc, f.page, r, new Map([["f", { kind: "svg", text: plot, width: 100, height: 100 }]]));
}

async function exportPdf(doc: Document, page: Page, r: Registries, assets: AssetMap = new Map()) {
  const built = buildPageSvg(doc, page, r, assets);
  const result = await pdfExporter.run(
    { doc, pages: [page], svgs: new Map([[page.id, built.svg]]), assets: new Map([[page.id, assets]]), registries: r, warnings: built.warnings, baseName: "figure", dpi: 300 },
    {},
  );
  const bytes = new Uint8Array(await result.files[0].blob.arrayBuffer());
  return { ...result, bytes, ...pdfParts(bytes), svg: built.svg };
}

/** The PDF's own text, and every deflated stream inflated. */
function pdfParts(bytes: Uint8Array): { text: string; content: string } {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("latin1");
  const streams: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    try {
      streams.push(inflateSync(buffer.subarray(start, end)).toString("latin1"));
    } catch {
      // Not a deflated stream.
    }
    re.lastIndex = end + "endstream".length;
  }
  return { text, content: streams.join("\n") };
}

/** The BaseFont of every font a page's content selects with `Tf`. */
function fontsDrawn(text: string, content: string): string[] {
  const used = new Set([...content.matchAll(/\/(F\d+) [\d.]+ Tf/g)].map((m) => m[1]));
  return [...used].map((id) => {
    const ref = new RegExp(`/${id} (\\d+) 0 R`).exec(text);
    if (!ref) return `?${id}`;
    const object = new RegExp(`(?:^|\\n)${ref[1]} 0 obj\\s*<<([\\s\\S]*?)>>\\s*endobj`).exec(text);
    return /\/BaseFont \/(\S+)/.exec(object?.[1] ?? "")?.[1] ?? `?${id}`;
  });
}

// ---- usedFamilies --------------------------------------------------------------------------------------------------

describe("usedFamilies", () => {
  test("lists the family lists of attributes, inline styles and <style> rules, unquoted, with generics in place", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg"><style>.a { font-family: 'DejaVu Sans', sans-serif; } text.b{font-weight:bold;font-family:"Fira Code" ,monospace}</style>` +
      `<text font-family="Calibri">A</text><text style="fill: red; font-family: Georgia, serif">B</text></svg>`;
    expect(usedFamilies(svg)).toEqual([
      ["Calibri"],
      ["Georgia", "serif"],
      ["DejaVu Sans", "sans-serif"],
      ["Fira Code", "monospace"],
    ]);
  });

  test("reads the family of a font shorthand, as matplotlib writes it", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text style="font: 10px 'DejaVu Sans', 'Arial', sans-serif; text-anchor: middle">A</text><style>.t{font:bold 9pt/1.2 Georgia}</style></svg>`;
    expect(usedFamilies(svg)).toEqual([["DejaVu Sans", "Arial", "sans-serif"], ["Georgia"]]);
  });

  test("expandFont: style and weight before the size, an optional line height, then the family", () => {
    expect(expandFont("italic small-caps 600 12px/1.5 'A B', serif")).toEqual([
      ["font-style", "italic"],
      ["font-weight", "600"],
      ["font-size", "12px"],
      ["line-height", "1.5"],
      ["font-family", "'A B', serif"],
    ]);
    expect(expandFont("10px Calibri")).toEqual([["font-style", "normal"], ["font-weight", "normal"], ["font-size", "10px"], ["font-family", "Calibri"]]);
    expect(expandFont("caption")).toBeNull();
  });

  test("an SVG with no fonts has none", () => {
    expect(usedFamilies('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')).toEqual([]);
  });
});

// ---- prepareFonts --------------------------------------------------------------------------------------------------

const svgOf = (body: string, head = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${head}${body}</svg>`;

describe("prepareFonts", () => {
  test("resolves a family to the source's face, registered under the SVG's exact string", async () => {
    const calibri = family("Calibri");
    const svg = svgOf('<text font-family="Calibri">Hello</text>');
    const result = await prepareFonts(svg, resolverOver(fakeSource({ calibri: calibri })));
    expect(result.warnings).toEqual([]);
    expect(result.svg).toBe(svg);
    expect(result.faces).toEqual([{ vfsName: expect.stringMatching(/^[A-Z]{6}\+Calibri-normal\.ttf$/), family: "Calibri", style: "normal", base64: toBase64(calibri.normal!) }]);
  });

  test("an SVG panel's <style> rule is the family its text resolves through", async () => {
    const dejavu = family("DejaVu Sans");
    const svg = svgOf('<text class="t">Hello</text>', "<style>.t { font-family: 'DejaVu Sans', sans-serif; }</style>");
    const result = await prepareFonts(svg, resolverOver(fakeSource({ "DejaVu Sans": dejavu })));
    expect(result.faces.map((f) => [f.family, f.style])).toEqual([["DejaVu Sans", "normal"]]);
    expect(result.warnings).toEqual([]);
  });

  test('font-weight="600" is rewritten to bold, and the bold face is what is asked for', async () => {
    const source = fakeSource({ Calibri: family("Calibri", ["normal", "bold"]) });
    const result = await prepareFonts(svgOf('<text font-family="Calibri" font-weight="600">Hello</text><text font-family="Calibri" style="font-weight: 300">Hi</text>'), resolverOver(source));
    expect(result.svg).toContain('font-weight="bold"');
    expect(result.svg).toMatch(/style="font-weight: ?normal;?"/);
    expect(result.svg).not.toContain("600");
    expect(result.faces.map((f) => f.style).sort()).toEqual(["bold", "normal"]);
  });

  test("a missing bold face: the regular face is registered as bold, with the warning", async () => {
    const calibri = family("Calibri");
    const result = await prepareFonts(svgOf('<text font-family="Calibri" font-weight="bold">Hello</text>'), resolverOver(fakeSource({ Calibri: calibri })), () => 'Text "Hello" (Page 1)');
    expect(result.faces).toEqual([expect.objectContaining({ family: "Calibri", style: "bold", base64: toBase64(calibri.normal!) })]);
    expect(result.warnings).toEqual(['Text "Hello" (Page 1): font "Calibri" has no bold face — regular used']);
  });

  test("a character the face lacks: the whole text is set in Helvetica, with the warning, and the face is not registered", async () => {
    const source = fakeSource({ Calibri: family("Calibri", ["normal"], "0123456789 m") });
    const result = await prepareFonts(svgOf('<text font-family="Calibri"><tspan>5 µm −</tspan></text>'), resolverOver(source), () => 'Text "5 µm −" (Page 1)');
    expect(result.warnings).toEqual(['font "Calibri" lacks "µ, −" — Text "5 µm −" (Page 1) set in Helvetica in PDF']);
    expect(result.faces).toEqual([]);
    expect(result.svg).toMatch(/<text[^>]*style="font-family: ?helvetica;?"/);
  });

  test("a serif family that lacks a character falls back to Times", async () => {
    const source = fakeSource({ Georgia: family("Georgia", ["normal"], "abc") });
    const result = await prepareFonts(svgOf('<text font-family="Georgia">abµ</text>'), resolverOver(source), () => "L");
    expect(result.warnings).toEqual(['font "Georgia" lacks "µ" — L set in Times in PDF']);
    expect(result.svg).toMatch(/style="font-family: ?times;?"/);
  });

  test("a family no source has: the reason and the font used instead, naming the label", async () => {
    const result = await prepareFonts(svgOf('<text font-family="Calibri">Hello</text><text font-family="Comic Neue, sans-serif">Hi</text>'), resolverOver(fakeSource({})), () => "L");
    expect(result.faces).toEqual([]);
    expect(result.warnings).toEqual(['L: font "Calibri" not installed — Times used in PDF', 'L: font "Comic Neue" not installed — Helvetica used in PDF']);
  });

  test("Arial, Helvetica and Times New Roman not installed: no warning, and each is named by the standard font's own key", async () => {
    const svg = svgOf('<text font-family="Arial">A</text><text font-family="Helvetica" font-weight="bold">B</text><text font-family="Times New Roman" font-style="italic">C</text>');
    const result = await prepareFonts(svg, resolverOver(fakeSource({})), () => "L");
    expect(result.faces).toEqual([]);
    expect(result.warnings).toEqual([]);
    const families = Array.from(new DOMParser().parseFromString(result.svg, "image/svg+xml").querySelectorAll("text")).map((t) => t.getAttribute("style"));
    expect(families).toEqual(["font-family: helvetica", "font-family: helvetica", "font-family: times"]);
  });

  test("an unresolvable non-standard family leaves the SVG as it was", async () => {
    const svg = svgOf('<text font-family="Calibri">A</text><text font-family="Georgia" font-weight="bold">B</text>');
    expect((await prepareFonts(svg, resolverOver(fakeSource({})))).svg).toBe(svg);
  });

  test("a family inherited from an element in another style is written on the run, which resolves in its own style", async () => {
    const source = fakeSource({ Calibri: family("Calibri", ["normal", "bold"]) });
    const fromGroup = await prepareFonts(svgOf('<g font-family="Calibri"><text font-weight="bold">Title</text></g>'), resolverOver(source));
    expect(fromGroup.faces.map((f) => [f.family, f.style])).toEqual([["Calibri", "bold"]]);
    expect(fromGroup.svg).toMatch(/<text font-weight="bold" style="font-family: Calibri"/);
    const fromText = await prepareFonts(svgOf('<text font-family="Calibri" font-weight="bold"><tspan font-weight="normal">Hello</tspan></text>'), resolverOver(source));
    expect(fromText.faces.map((f) => [f.family, f.style])).toEqual([["Calibri", "normal"]]);
    expect(fromText.svg).toMatch(/<tspan font-weight="normal" style="font-family: Calibri"/);
    // In the same style there is nothing to write.
    const same = svgOf('<g font-family="Calibri"><text>Hello</text></g>');
    expect((await prepareFonts(same, resolverOver(source))).svg).toBe(same);
  });

  test("an inherited Arial with no bold face: the bold run is named helvetica, the regular run keeps Arial", async () => {
    const result = await prepareFonts(svgOf('<g font-family="Arial"><text>Hi</text><text font-weight="bold">Yo</text></g>'), resolverOver(fakeSource({ Arial: family("Arial") })), () => "L");
    expect(result.warnings).toEqual([]);
    expect(result.faces.map((f) => [f.family, f.style])).toEqual([["Arial", "normal"]]);
    expect(result.svg).toContain('<text font-weight="bold" style="font-family: helvetica">Yo</text>');
    expect(result.svg).toContain("<text>Hi</text>");
  });

  test("an inline font shorthand is read, and written out as longhands with a keyword weight", async () => {
    const source = fakeSource({ "DejaVu Sans": family("DejaVu Sans", ["normal", "bold"]) });
    const result = await prepareFonts(svgOf(`<text style="font: 700 10px 'DejaVu Sans'; text-anchor: middle">Hello</text>`), resolverOver(source));
    expect(result.faces.map((f) => [f.family, f.style])).toEqual([["DejaVu Sans", "bold"]]);
    expect(result.svg).toContain(`style="font-style: normal; font-weight: bold; font-size: 10px; font-family: 'DejaVu Sans'; text-anchor: middle"`);
  });

  test("a <style> rule's font shorthand is read too", async () => {
    const source = fakeSource({ Calibri: family("Calibri", ["bolditalic"]) });
    const result = await prepareFonts(svgOf('<text class="t">Hello</text>', "<style>.t { font: italic 600 12px / 1.5 Calibri, sans-serif }</style>"), resolverOver(source));
    expect(result.faces.map((f) => [f.family, f.style])).toEqual([["Calibri", "bolditalic"]]);
    expect(result.svg).toContain(".t { font-style: italic; font-weight: bold; font-size: 12px; line-height: 1.5; font-family: Calibri, sans-serif }");
  });

  test("the label is asked for only when a warning needs it", async () => {
    const labelOf = vi.fn(() => "L");
    await prepareFonts(svgOf('<text font-family="Calibri">Hello</text>'), resolverOver(fakeSource({ Calibri: family("Calibri") })), labelOf);
    expect(labelOf).not.toHaveBeenCalled();
    await prepareFonts(svgOf('<text font-family="Georgia">Hello</text>'), resolverOver(fakeSource({})), labelOf);
    expect(labelOf).toHaveBeenCalledTimes(1);
  });

  test("a hidden window: one warning for the whole export, however many families needed the list", async () => {
    const result = await prepareFonts(svgOf('<text font-family="Calibri">A</text><text font-family="Georgia">B</text>'), resolverOver(hiddenSource), () => "L");
    expect(result.faces).toEqual([]);
    expect(result.warnings).toEqual(["installed fonts could not be read (Obsidian was not visible) — fonts substituted"]);
  });

  test("the same family and style is looked up once per export", async () => {
    const source = fakeSource({ Calibri: family("Calibri") });
    const resolve = resolverOver(source);
    await prepareFonts(svgOf('<text font-family="Calibri">A</text><text font-family="Calibri">B</text>'), resolve);
    await prepareFonts(svgOf('<text font-family="Calibri">C</text>'), resolve);
    expect(source.asked).toEqual([["Calibri", "normal"]]);
  });
});

// ---- The exporter --------------------------------------------------------------------------------------------------

describe("PDF export with installed fonts", () => {
  test("Review Focus 1: an Arial-only figure embeds Arial, and no other font", async () => {
    const f = figure();
    f.label("Hello", { family: "Arial" });
    const out = await exportPdf(f.doc, f.page, registries(fakeSource({ Arial: family("Arial"), Calibri: family("Calibri"), Georgia: family("Georgia") })));
    expect(out.warnings).toEqual([]);
    expect(out.text.match(/\/FontFile2/g)).toHaveLength(1);
    expect(out.text).toContain("/BaseFont /Arial");
    expect(out.text).not.toMatch(/Calibri|Georgia/);
    expect(fontsDrawn(out.text, out.content)).toEqual(["Arial"]);
  });

  test("with nothing resolvable, the PDF bytes are those of the figure drawn as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 12, 0, 0));
    const f = figure();
    f.label("Hello", { family: "Calibri" });
    // Only non-standard families: Arial, Helvetica and Times New Roman are renamed in the PDF copy (see below).
    f.label("World", { family: "Georgia", weight: "bold" });
    const out = await exportPdf(f.doc, f.page, registries(fakeSource({})));

    // What the exporter drew before fonts: the page's SVG, straight into a jsPDF document of the page's size.
    const before = new jsPDF({ unit: "mm", format: [f.page.width, f.page.height], orientation: "landscape", compress: true });
    await before.svg(new DOMParser().parseFromString(out.svg, "image/svg+xml").documentElement, { x: 0, y: 0, width: f.page.width, height: f.page.height });
    // The file id is random per document, so it is the one thing set aside.
    const withoutId = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").replace(/\/ID \[ <[0-9A-F]+> <[0-9A-F]+> \]/, "/ID");
    const expected = withoutId(new Uint8Array(before.output("arraybuffer")));
    expect(expected).toContain("/CreationDate (D:20261110120000");
    expect(withoutId(out.bytes) === expected).toBe(true);
  });

  test("a Calibri label is embedded: a FontFile2 under the family's own name, and the text drawn in it", async () => {
    const f = figure();
    const node = f.label("Hello", { family: "Calibri" });
    const out = await exportPdf(f.doc, f.page, registries(fakeSource({ Calibri: family("Calibri") })));
    expect(out.warnings).toEqual([]);
    expect(out.text).toContain("/FontFile2");
    // No subset tag: svg2pdf.js finds the font by the exact family string, which jsPDF also writes as the BaseFont.
    expect(out.text).toContain("/BaseFont /Calibri");
    expect(fontsDrawn(out.text, out.content)).toEqual(["Calibri"]);
    expect(nodeLabel(f.doc, node)).toBe('Text "Hello" (Page 1)');
  });

  test("a missing bold face: the label is drawn in the regular face, with the warning naming the label", async () => {
    const f = figure();
    const node = f.label("Hello", { family: "Calibri", weight: "bold" });
    const out = await exportPdf(f.doc, f.page, registries(fakeSource({ Calibri: family("Calibri") })));
    expect(out.warnings).toEqual([`${nodeLabel(f.doc, node)}: font "Calibri" has no bold face — regular used`]);
    expect(fontsDrawn(out.text, out.content)).toEqual(["Calibri"]);
  });

  test("Review Focus 3: a label with µ in a font without µ is drawn whole in Helvetica, with the exact warning", async () => {
    const f = figure();
    const node = f.label("5 µm", { family: "Calibri" });
    const out = await exportPdf(f.doc, f.page, registries(fakeSource({ Calibri: family("Calibri") })));
    expect(out.warnings).toEqual([`font "Calibri" lacks "µ" — ${nodeLabel(f.doc, node)} set in Helvetica in PDF`]);
    expect(out.text).not.toContain("/FontFile2");
    expect(fontsDrawn(out.text, out.content)).toEqual(["Helvetica"]);
    // The whole string, µ included (WinAnsi \265), in one piece.
    expect(out.content).toMatch(/\(5 (\\265|µ)m\) Tj/);
  });

  test("a linked SVG's <style> font is embedded, and a warning about it names the panel", async () => {
    const f = figure();
    const plot =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.t { font-family: 'DejaVu Sans', sans-serif; } .u { font-family: Inconsolata; }</style>` +
      '<text class="t" x="10" y="20">Hello</text><text class="u" x="10" y="60">World</text></svg>';
    const panel: FileNode = { ...fileNodeDefaults(f.page, { file: "plot.svg", subpath: "", show: "image", frame: null }, []), id: "f", x: 20, y: 20, width: 100, height: 100 };
    f.doc.nodes.push(panel);
    const r = registries(fakeSource({ "DejaVu Sans": family("DejaVu Sans") }));
    // The real file node type draws a linked SVG inline; it imports the Obsidian API, so its SVG function stands in.
    const { fileNodeSvg } = await import("../../src/nodes/file-node-svg");
    r.nodeTypes.register({ type: "file", toSvg: (n: FileNode, ctx: never) => fileNodeSvg(n, { kind: "svg", text: plot, width: 100, height: 100 }, ctx) } as never);
    const out = await exportPdf(f.doc, f.page, r, new Map([["f", { kind: "svg", text: plot, width: 100, height: 100 }]]));
    expect(out.text).toContain("/BaseFont /DejaVu#20Sans");
    expect(out.warnings).toEqual([`${nodeLabel(f.doc, panel)}: font "Inconsolata" not installed — Times used in PDF`]);
  });

  test("Review Focus 2: in a layered PDF only the layer that draws the Calibri label registers Calibri", async () => {
    const f = figure();
    const source = await PDFDocument.create();
    source.addPage([300, 200]).drawRectangle({ x: 0, y: 0, width: 100, height: 100 });
    const bytes = await source.save();
    const asset: PdfAsset = {
      kind: "pdf",
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      pageIndex: 0,
      widthPt: 300,
      heightPt: 200,
      raster: "data:image/png;base64,",
      rasterWidth: 1,
      rasterHeight: 1,
    };
    const below = f.label("Below", { family: "Arial" }, { z: 0 });
    const panel: FileNode = { ...fileNodeDefaults(f.page, { file: "plot.pdf", subpath: "", show: "image" }, [below.id]), z: 1, x: 200, y: 200, width: 200, height: 100 };
    f.doc.nodes.push(panel);
    const label = f.label("Hello", { family: "Calibri" }, { z: 2 });
    const api = jsPDF.API as unknown as Record<"addFileToVFS" | "svg", (...args: unknown[]) => unknown>;
    const vfs = vi.spyOn(api, "addFileToVFS");
    const svg = vi.spyOn(api, "svg");

    const out = await exportPdf(f.doc, f.page, registries(fakeSource({ Calibri: family("Calibri") })), new Map<string, never>([[panel.id, asset as never]]));

    expect(out.warnings).toEqual([]);
    const drawnLayers = svg.mock.contexts;
    expect(drawnLayers.length).toBeGreaterThanOrEqual(2);
    expect(vfs.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/\+Calibri-normal\.ttf$/)]);
    const registering = vfs.mock.contexts[0];
    const layerSvg = (svg.mock.calls[drawnLayers.indexOf(registering)][0] as Element).outerHTML;
    expect(layerSvg).toContain("Hello");
    expect(layerSvg).not.toContain("Below");
    expect(nodeLabel(f.doc, label)).toContain("Hello");
  });

  test("Review Focus 4: with the font list unavailable, the single warning is given and the PDF is made", async () => {
    const f = figure();
    f.label("Hello", { family: "Calibri" });
    f.label("World", { family: "Georgia" });
    const out = await exportPdf(f.doc, f.page, registries(hiddenSource));
    expect(out.warnings).toEqual(["installed fonts could not be read (Obsidian was not visible) — fonts substituted"]);
    expect(out.bytes.length).toBeGreaterThan(0);
    expect(out.text).not.toContain("/FontFile2");
  });

  test("Review Focus 5: a 1 MB font used for one word gives a PDF under 200 KB", async () => {
    const big = buildFont({ family: "Big Sans", style: "Regular", chars: LATIN, padGlyphs: 40000 });
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const f = figure();
    f.label("Hello", { family: "Big Sans" });
    const out = await exportPdf(f.doc, f.page, registries(fakeSource({ "Big Sans": { normal: big } })));
    expect(out.text).toContain("/FontFile2");
    expect(out.bytes.length).toBeLessThan(200 * 1024);
  });

  test.each([
    ["Arial", "Helvetica"],
    ["Helvetica", "Helvetica"],
    ["Times New Roman", "Times-Roman"],
  ])("%s not installed: drawn in %s, with no warning", async (family, standard) => {
    const f = figure();
    f.label("Hello", { family });
    const out = await exportPdf(f.doc, f.page, registries(fakeSource({})));
    expect(out.warnings).toEqual([]);
    expect(out.text).not.toContain("/FontFile2");
    expect(fontsDrawn(out.text, out.content)).toEqual([standard]);
  });

  test.each([
    ["a group's family under a bold text", '<g font-family="Calibri"><text x="10" y="20" font-weight="bold">Title</text></g>', ["Calibri"]],
    ["a bold text's family under a regular tspan", '<text x="10" y="20" font-family="Calibri" font-weight="bold"><tspan font-weight="normal">Hello</tspan></text>', ["Calibri"]],
    ["an inherited Arial with no bold face", '<g font-family="Arial"><text x="10" y="80">Hi</text><text x="10" y="90" font-weight="bold">Yo</text></g>', ["Arial", "Helvetica-Bold"]],
  ])("a family inherited in another style is drawn in the run's own face, not Times: %s", async (_, body, drawn) => {
    // Each case on its own, so no other text registers the style the inheriting run needs.
    const plot = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
    const out = await exportPanel(plot, fakeSource({ Calibri: family("Calibri", ["normal", "bold"]), Arial: family("Arial") }));
    expect(out.warnings).toEqual([]);
    expect(fontsDrawn(out.text, out.content).sort()).toEqual(drawn);
  });

  test("matplotlib's font shorthand (svg.fonttype none) is embedded", async () => {
    const plot =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      `<text x="10" y="20" style="font: 600 10px 'DejaVu Sans', 'Bitstream Vera Sans', 'Verdana', 'Arial', 'Helvetica', sans-serif; text-anchor: middle">Hello</text>` +
      '<style>.t { font: 9px Calibri }</style><text class="t" x="10" y="60">World</text></svg>';
    const out = await exportPanel(plot, fakeSource({ "DejaVu Sans": family("DejaVu Sans", ["bold"]), Calibri: family("Calibri") }));
    expect(out.warnings).toEqual([]);
    expect(fontsDrawn(out.text, out.content).sort()).toEqual(["Calibri", "DejaVu#20Sans"]);
  });
});
