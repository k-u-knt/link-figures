import type { Exporter } from "../../registry/exporter";

const SVG_MIME = "image/svg+xml";

/** One SVG file per page, each exactly as `buildPageSvg` made it. */
export const svgExporter: Exporter = {
  id: "svg",
  name: "SVG",
  ext: "svg",
  mime: SVG_MIME,
  pdfPanels: "raster",
  options: () => [],
  async run(input) {
    const files = input.pages.map((page) => {
      const svg = input.svgs.get(page.id);
      if (svg === undefined) throw new Error(`No SVG was built for page "${page.name}"`);
      return { name: `${input.baseName} - ${page.name}.svg`, blob: new Blob([svg], { type: SVG_MIME }) };
    });
    return { files, warnings: input.warnings };
  },
};
