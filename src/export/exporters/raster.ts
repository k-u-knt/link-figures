import type { Field } from "../../registry/fields";
import type { Exporter, ExportInput } from "../../registry/exporter";
import { withPhys } from "../png-phys";
import { fitDpi } from "../raster-size";
import { browserRaster, paperBackground, type RasterBackend } from "../rasterise";
import { encodeTiffRgb, type TiffCompression } from "../tiff-write";

/** The SVG builder's note that a PDF panel was drawn from its raster: true of everything in a raster export. */
const PLAIN_RASTERISED_PANEL = /: PDF panel rasterised$/;

interface RasterFormat {
  id: string;
  name: string;
  ext: string;
  mime: string;
  options(): Field[];
  /** The page drawn at `widthPx` × `heightPx` on `background`, as the file's parts. */
  render(page: { svg: string; widthPx: number; heightPx: number; background: string }, dpi: number, opts: Record<string, unknown>, backend: RasterBackend): Promise<Uint8Array[]>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * An exporter that writes one raster file per page: the page's SVG drawn at `dpi / 96` of its px size (lower when that is
 * over the canvas limits, which is said), flattened onto its paper. A page that cannot be drawn is a warning; the
 * other pages are still written.
 */
function rasterExporter(format: RasterFormat, backend: RasterBackend): Exporter {
  return {
    id: format.id,
    name: format.name,
    ext: format.ext,
    mime: format.mime,
    pdfPanels: "raster",
    options: format.options,
    async run(input: ExportInput, opts) {
      const svgs = input.pages.map((page) => {
        const svg = input.svgs.get(page.id);
        if (svg === undefined) throw new Error(`No SVG was built for page "${page.name}"`);
        return svg;
      });
      const files: { name: string; blob: Blob }[] = [];
      const warnings = input.warnings.filter((w) => !PLAIN_RASTERISED_PANEL.test(w));
      for (const [i, page] of input.pages.entries()) {
        const fit = fitDpi(page, input.dpi);
        if (fit.reduced) warnings.push(`"${page.name}": drawn at ${fit.dpi} dpi (the largest that fits)`);
        try {
          const drawn = { svg: svgs[i], widthPx: fit.widthPx, heightPx: fit.heightPx, background: paperBackground(page.paper) };
          const parts = await format.render(drawn, fit.dpi, opts, backend);
          files.push({ name: `${input.baseName} - ${page.name}.${format.ext}`, blob: new Blob(parts as Uint8Array<ArrayBuffer>[], { type: format.mime }) });
        } catch (error) {
          warnings.push(`"${page.name}": could not be drawn: ${message(error)}`);
        }
      }
      return { files, warnings };
    },
  };
}

/** PNG: the canvas's own PNG, with the dpi in a `pHYs` chunk and an `sRGB` chunk. */
export function createPngExporter(backend: RasterBackend = browserRaster): Exporter {
  return rasterExporter(
    {
      id: "png",
      name: "PNG",
      ext: "png",
      mime: "image/png",
      options: () => [],
      render: async (page, dpi, _opts, raster) => withPhys(await raster.renderPng(page.svg, page.widthPx, page.heightPx, page.background), dpi),
    },
    backend,
  );
}

const COMPRESSION_FIELD: Field = {
  kind: "select",
  key: "compression",
  label: "Compression",
  options: [
    { value: "deflate", label: "Deflate" },
    { value: "none", label: "None" },
  ],
};

/** TIFF: 8-bit RGB, one strip, the dpi as its resolution; Adobe Deflate unless the `compression` option is `none`. */
export function createTiffExporter(backend: RasterBackend = browserRaster): Exporter {
  return rasterExporter(
    {
      id: "tiff",
      name: "TIFF",
      ext: "tif",
      mime: "image/tiff",
      options: () => [COMPRESSION_FIELD],
      render: async (page, dpi, opts, raster) => {
        const image = await raster.rasterise(page.svg, page.widthPx, page.heightPx, page.background);
        if (image.width !== page.widthPx || image.height !== page.heightPx) {
          throw new Error(`the drawn image is ${image.width} × ${image.height} px, not ${page.widthPx} × ${page.heightPx}`);
        }
        const compression: TiffCompression = opts.compression === "none" ? "none" : "deflate";
        return encodeTiffRgb(image.data, image.width, image.height, dpi, compression);
      },
    },
    backend,
  );
}

export const pngExporter = createPngExporter();
export const tiffExporter = createTiffExporter();
