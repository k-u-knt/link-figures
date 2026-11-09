import type { PDFDocument, PDFPage } from "@cantoo/pdf-lib";
import type { jsPDF as JsPdf } from "jspdf";
import type { Document, FileNode, Node, NodeId, Page } from "../../model/types";
import { pageSizePx } from "../../model/geometry";
import { nodeLabel } from "../../model/labels";
import { PX_TO_PT } from "../../constants";
import type { Exporter, ExportInput } from "../../registry/exporter";
import type { AssetMap, PdfAsset } from "../asset-types";
import { pdfPanelPlacement, splitLayers, type Layer, type PdfPlacement } from "../pdf-layers";
import { buildPageSvg } from "../svg-builder";
import { normaliseUserSpaceMarkers } from "../svg-markers";
import { normalisePatternOrigins } from "../svg-patterns";
import { outlinePaintedStrokes } from "../svg-stroke-paints";

const PDF_MIME = "application/pdf";
const SVG_MIME = "image/svg+xml";
const MAX_PARSE_ERROR_CHARS = 200;
/** What the SVG builder says about a PDF panel it had to draw from its raster; here the panels are embedded as vectors instead. */
const RASTERISED_PANEL_WARNING = /PDF panel rasterised/;
/**
 * The font families svg2pdf.js sets text in as they are, or as their metric twin: jsPDF has only the standard PDF fonts,
 * so Arial is drawn as Helvetica and Times New Roman as Times. Any other family (Calibri, Georgia, and Courier New too)
 * falls back to Times (`findFirstAvailableFontFamily` in svg2pdf.js), lower-cased here.
 */
const PDF_FONT_FAMILIES = new Set(["arial", "helvetica", "times new roman"]);

type JsPdfConstructor = typeof JsPdf;

const orientationOf = (page: Page) => (page.width > page.height ? "landscape" : "portrait");

/** The page's SVG as a DOM element. A document the parser rejected comes back as a `<parsererror>` page, which is an error here. */
function parseSvg(svg: string, page: Page): Element {
  const parsed = new DOMParser().parseFromString(svg, SVG_MIME);
  const failure = parsed.getElementsByTagName("parsererror")[0];
  if (failure) {
    // Chromium puts "error on line L at column C: ..." in a <div>, between two generic headings.
    const detail = ((failure.querySelector("div") ?? failure).textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PARSE_ERROR_CHARS);
    throw new Error(`The SVG built for page "${page.name}" is not valid XML${detail ? `: ${detail}` : ""}`);
  }
  return parsed.documentElement;
}

/** A jsPDF document whose first page has the figure page's size. */
function createPdf(jsPDF: JsPdfConstructor, page: Page): JsPdf {
  // Fonts: nothing to embed yet. Text nodes (Task 16) register their font files on the document here, before any page is drawn.
  return new jsPDF({ unit: "mm", format: [page.width, page.height], orientation: orientationOf(page), compress: true });
}

/**
 * Names what an element of the page's SVG belongs to, for a warning: the node whose inlined content it is (the SVG
 * builder starts the ids of a linked SVG's content with the node's id and a hyphen), else the page.
 */
function ownerLabel(doc: Document, page: Page): (el: Element) => string {
  const nodes = doc.nodes.filter((n) => n.page === page.id);
  return (el) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const id = node.getAttribute("id");
      const owner = id === null ? undefined : nodes.find((n) => id.startsWith(`${n.id}-`));
      if (owner) return nodeLabel(doc, owner);
    }
    return `Page "${page.name}"`;
  };
}

/**
 * The page's SVG drawn as vectors, over the whole of jsPDF's current page. Markers sized in user units are first
 * swapped for copies that svg2pdf.js draws at their own size (it scales every marker by the stroke width), and gradient
 * and pattern strokes, which svg2pdf.js leaves unpainted, for their outlines filled with the paint. Patterns placed by
 * `x`/`y` are moved to the origin with a translate, as svg2pdf.js clips their tiles away otherwise. What could not be
 * drawn so is added to `warnings`.
 */
async function drawSvg(pdf: JsPdf, svg: string, doc: Document, page: Page, warnings: Set<string>): Promise<void> {
  const outlined = outlinePaintedStrokes(normaliseUserSpaceMarkers(svg), ownerLabel(doc, page));
  for (const warning of outlined.warnings) warnings.add(warning);
  await pdf.svg(parseSvg(normalisePatternOrigins(outlined.svg), page), { x: 0, y: 0, width: page.width, height: page.height });
}

/** One PDF holding a page per figure page, each drawn from its own SVG. */
async function plainPdf(jsPDF: JsPdfConstructor, doc: Document, pages: Page[], svgs: string[], warnings: Set<string>): Promise<Blob> {
  // jsPDF starts with one page, so the first page sets the document up and the rest are added.
  const pdf = createPdf(jsPDF, pages[0]);
  for (const [i, page] of pages.entries()) {
    if (i > 0) pdf.addPage([page.width, page.height], orientationOf(page));
    await drawSvg(pdf, svgs[i], doc, page, warnings);
  }
  return pdf.output("blob");
}

interface PdfPanel {
  node: FileNode;
  asset: PdfAsset;
}

/** The page's PDF panels, each with the PDF page it shows: the file nodes whose asset is a PDF page. */
function pdfPanelsOf(nodes: Node[], assets: AssetMap): Map<NodeId, PdfPanel> {
  const panels = new Map<NodeId, PdfPanel>();
  for (const node of nodes) {
    const asset = assets.get(node.id);
    if (node.type === "file" && asset?.kind === "pdf") panels.set(node.id, { node, asset });
  }
  return panels;
}

type PdfLib = typeof import("@cantoo/pdf-lib");

/** One warning per text node whose font the PDF cannot set, naming the font it gets instead. */
function fontWarnings(doc: Document, nodes: Node[]): string[] {
  return nodes.flatMap((node) =>
    node.type === "text" && !PDF_FONT_FAMILIES.has(node.font.family.trim().toLowerCase())
      ? [`${nodeLabel(doc, node)}: font "${node.font.family}" substituted by Times in PDF`]
      : [],
  );
}

/**
 * The source PDF as pdf-lib reads it. A file with only an owner password (which restricts what a reader may do) opens
 * with the empty user password, so an encrypted file is tried with that; one that needs a real password still fails.
 */
async function loadSource(lib: PdfLib, bytes: ArrayBuffer): Promise<PDFDocument> {
  try {
    return await lib.PDFDocument.load(bytes);
  } catch (error) {
    if (!(error instanceof lib.EncryptedPDFError)) throw error;
    return lib.PDFDocument.load(bytes, { password: "" });
  }
}

/** One page to export: its built SVG, its PDF panels, and the layers its nodes fall into around them. */
interface PagePlan {
  page: Page;
  svg: string;
  panels: Map<NodeId, PdfPanel>;
  layers: Layer[];
}

/** The layer's SVG drawn by svg2pdf.js on a jsPDF page of its own, as the bytes of that one-page PDF. */
async function svgLayerPdf(jsPDF: JsPdfConstructor, svg: string, doc: Document, page: Page, warnings: Set<string>): Promise<ArrayBuffer> {
  const pdf = createPdf(jsPDF, page);
  await drawSvg(pdf, svg, doc, page, warnings);
  return pdf.output("arraybuffer");
}

/** True when the placement can be drawn: finite numbers, and a part of the source page that has an area. */
function isDrawable({ box, ...placed }: PdfPlacement): boolean {
  const numbers = [box.left, box.bottom, box.right, box.top, placed.x, placed.y, placed.width, placed.height];
  return numbers.every(Number.isFinite) && box.right > box.left && box.top > box.bottom;
}

/**
 * One panel's page of its source PDF, drawn on `target` at the panel's rectangle as vectors: the source page's own content
 * is embedded in the output, clipped to the part that shows. Anything that goes wrong names the node and the page.
 */
async function drawPdfPanel(doc: Document, lib: PdfLib, out: PDFDocument, target: PDFPage, page: Page, { node, asset }: PdfPanel): Promise<void> {
  try {
    const source = await loadSource(lib, asset.bytes);
    const sourcePage = source.getPage(asset.pageIndex);
    // pdf-lib embeds a page's content as it is stored, so a page the viewer turns would come out unturned.
    if (sourcePage.getRotation().angle % 360 !== 0) throw new Error("the page has a rotation of its own, which cannot be embedded");

    const placement = pdfPanelPlacement(node, page, asset);
    if (!isDrawable(placement)) throw new Error("the part of the page that shows has no area");
    // The placement measures from the page's own corner, which is not the origin when the page's box starts elsewhere.
    const origin = sourcePage.getCropBox();
    const { box } = placement;
    const embedded = await out.embedPage(sourcePage, {
      left: box.left + origin.x,
      bottom: box.bottom + origin.y,
      right: box.right + origin.x,
      top: box.top + origin.y,
    });
    target.drawPage(embedded, {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      rotate: lib.degrees(placement.rotate),
      ...(node.opacity < 1 ? { opacity: node.opacity } : {}),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${nodeLabel(doc, node)}: could not embed page ${asset.pageIndex + 1} of the PDF as vectors: ${reason}`, { cause });
  }
}

/**
 * The same document for figures with PDF panels. svg2pdf.js can only draw a PDF panel from its raster, so the page is
 * composed in layers instead: each run of other nodes is drawn on its own as vectors and embedded as a page, and each PDF
 * panel's source page is embedded as a page of its own, with what its node type draws over it (its frame) as a layer
 * of its own on top, all stacked on one output page in z order.
 */
async function layeredPdf(jsPDF: JsPdfConstructor, input: ExportInput, plans: PagePlan[], warnings: Set<string>): Promise<Blob> {
  const lib = await import("@cantoo/pdf-lib");
  const out = await lib.PDFDocument.create();
  for (const { page, svg: pageSvg, panels, layers } of plans) {
    const size = pageSizePx(page);
    const [width, height] = [size.width * PX_TO_PT, size.height * PX_TO_PT];
    const target = out.addPage([width, height]);
    for (const [index, layer] of layers.entries()) {
      if (layer.kind === "pdf") {
        const panel = panels.get(layer.nodeId);
        if (!panel) {
          const node = input.doc.nodes.find((n) => n.id === layer.nodeId);
          throw new Error(`${node ? nodeLabel(input.doc, node) : `Node ${layer.nodeId}`} is not a PDF panel`);
        }
        await drawPdfPanel(input.doc, lib, out, target, page, panel);
        const assets = input.assets.get(page.id) ?? new Map();
        const overlay = buildPageSvg(input.doc, page, input.registries, assets, { only: new Set([layer.nodeId]), paper: false, overlaysOnly: true });
        // What drawing the overlay had to say (a frame's paint that is not registered) is said in the notice too.
        for (const warning of overlay.warnings) warnings.add(warning);
        if (overlay.drawn > 0) {
          const [embedded] = await out.embedPdf(await svgLayerPdf(jsPDF, overlay.svg, input.doc, page, warnings));
          target.drawPage(embedded, { x: 0, y: 0, width, height });
        }
        continue;
      }
      // Only the first layer has the paper; a layer with no nodes (the first, below a panel) is just that.
      if (layer.nodeIds.length === 0 && index > 0) continue;
      // A page without PDF panels is one layer of everything, which is the SVG already built.
      const svg =
        panels.size === 0
          ? pageSvg
          : buildPageSvg(input.doc, page, input.registries, input.assets.get(page.id) ?? new Map(), {
              only: new Set(layer.nodeIds),
              paper: index === 0,
            }).svg;
      const [embedded] = await out.embedPdf(await svgLayerPdf(jsPDF, svg, input.doc, page, warnings));
      target.drawPage(embedded, { x: 0, y: 0, width, height });
    }
  }
  return new Blob([await out.save()], { type: PDF_MIME });
}

/**
 * One PDF with a page per figure page, each page's SVG drawn as vectors by svg2pdf.js. Paper, shapes and clip paths stay
 * vector; the raster assets (`<image>`) become image objects, clipped where the SVG clips them. A page with PDF panels is
 * composed in layers by pdf-lib so that the panels stay vectors too.
 */
export const pdfExporter: Exporter = {
  id: "pdf",
  name: "PDF (vector)",
  ext: "pdf",
  mime: PDF_MIME,
  pdfPanels: "vector",
  options: () => [],
  async run(input) {
    // A PDF with no pages cannot exist (jsPDF would make a blank one), so no pages means no file, as for the SVG exporter.
    if (input.pages.length === 0) return { files: [], warnings: input.warnings };

    // Check every page before loading anything heavy.
    const fonts: string[] = [];
    const plans = input.pages.map((page): PagePlan => {
      const svg = input.svgs.get(page.id);
      if (svg === undefined) throw new Error(`No SVG was built for page "${page.name}"`);
      const nodes = input.doc.nodes.filter((n) => n.page === page.id);
      fonts.push(...fontWarnings(input.doc, nodes));
      const panels = pdfPanelsOf(nodes, input.assets.get(page.id) ?? new Map());
      return { page, svg, panels, layers: splitLayers(nodes, (n) => panels.has(n.id), (n) => input.registries.nodeTypes.get(n.type)?.members !== undefined) };
    });

    // Loaded here, not at the top, so the editor does not pay for any of the libraries until someone exports a PDF.
    // Importing svg2pdf.js is what adds `svg()` to jsPDF's prototype.
    const { jsPDF } = await import("jspdf");
    await import("svg2pdf.js");

    const name = `${input.baseName}.pdf`;
    // What only the PDF finds out: strokes it could not keep as vectors, and what a PDF panel's overlay layer said.
    const strokes = new Set<string>();
    if (plans.every((plan) => plan.panels.size === 0)) {
      const blob = await plainPdf(jsPDF, input.doc, input.pages, plans.map((plan) => plan.svg), strokes);
      return { files: [{ name, blob }], warnings: [...new Set([...input.warnings, ...fonts, ...strokes])] };
    }
    const blob = await layeredPdf(jsPDF, input, plans, strokes);
    const kept = input.warnings.filter((w) => !RASTERISED_PANEL_WARNING.test(w));
    return { files: [{ name, blob }], warnings: [...new Set([...kept, ...fonts, ...strokes])] };
  },
};
