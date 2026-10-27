import type { Page } from "../../model/types";
import type { Exporter } from "../../registry/exporter";

const PDF_MIME = "application/pdf";
const SVG_MIME = "image/svg+xml";
const MAX_PARSE_ERROR_CHARS = 200;

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

/**
 * One PDF with a page per figure page, each page's SVG drawn as vectors by svg2pdf.js. Paper, shapes and clip paths stay
 * vector; the raster assets (`<image>`) become image objects, clipped where the SVG clips them.
 */
export const pdfExporter: Exporter = {
  id: "pdf",
  name: "PDF (vector)",
  ext: "pdf",
  mime: PDF_MIME,
  options: () => [],
  async run(input) {
    // A PDF with no pages cannot exist (jsPDF would make a blank one), so no pages means no file, as for the SVG exporter.
    if (input.pages.length === 0) return { files: [], warnings: input.warnings };

    // Check every page before loading anything heavy.
    const svgs = input.pages.map((page) => {
      const svg = input.svgs.get(page.id);
      if (svg === undefined) throw new Error(`No SVG was built for page "${page.name}"`);
      return svg;
    });

    // Loaded here, not at the top, so the editor does not pay for either library until someone exports a PDF.
    // Importing svg2pdf.js is what adds `svg()` to jsPDF's prototype.
    const { jsPDF } = await import("jspdf");
    await import("svg2pdf.js");
    // Fonts: nothing to embed yet. Text nodes (Task 16) register their font files on the document here, before any page is drawn.

    // jsPDF starts with one page, so the first page sets the document up and the rest are added.
    const first = input.pages[0];
    const pdf = new jsPDF({ unit: "mm", format: [first.width, first.height], orientation: orientationOf(first) });
    for (const [i, page] of input.pages.entries()) {
      const element = parseSvg(svgs[i], page);
      if (i > 0) pdf.addPage([page.width, page.height], orientationOf(page));
      await pdf.svg(element, { x: 0, y: 0, width: page.width, height: page.height });
    }

    return { files: [{ name: `${input.baseName}.pdf`, blob: pdf.output("blob") }], warnings: input.warnings };
  },
};
