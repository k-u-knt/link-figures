import type { Field } from "../../registry/fields";
import type { Exporter, ExportInput } from "../../registry/exporter";
import { withPhys } from "../png-phys";
import { fitDpi } from "../raster-size";
import { browserRaster, paperBackground, type RasterBackend, type RasterImage } from "../rasterise";
import { encodeTiffRgb, rgbaToRgb, type TiffCompression } from "../tiff-write";

/** The SVG builder's note that a PDF panel was drawn from its raster: true of everything in a raster export. */
const PLAIN_RASTERISED_PANEL = /: PDF panel rasterised$/;

interface RasterFormat {
  id: string;
  name: string;
  ext: string;
  mime: string;
  options(): Field[];
  encode(image: RasterImage, dpi: number, opts: Record<string, unknown>, backend: RasterBackend): Promise<Uint8Array>;
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
          const image = await backend.rasterise(svgs[i], fit.widthPx, fit.heightPx, paperBackground(page.paper));
          if (image.width !== fit.widthPx || image.height !== fit.heightPx) {
            throw new Error(`the drawn image is ${image.width} × ${image.height} px, not ${fit.widthPx} × ${fit.heightPx}`);
          }
          const bytes = await format.encode(image, fit.dpi, opts, backend);
          files.push({ name: `${input.baseName} - ${page.name}.${format.ext}`, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: format.mime }) });
        } catch (error) {
          warnings.push(`"${page.name}": could not be drawn: ${message(error)}`);
        }
      }
      return { files, warnings };
    },
  };
}

/** PNG: the canvas's own PNG, with the dpi written into a `pHYs` chunk. */
export function createPngExporter(backend: RasterBackend = browserRaster): Exporter {
  return rasterExporter(
    {
      id: "png",
      name: "PNG",
      ext: "png",
      mime: "image/png",
      options: () => [],
      encode: async (image, dpi, _opts, raster) => withPhys(await raster.encodePng(image), dpi),
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
      encode: async (image, dpi, opts) => {
        const compression: TiffCompression = opts.compression === "none" ? "none" : "deflate";
        return encodeTiffRgb(rgbaToRgb(image.data), image.width, image.height, dpi, compression);
      },
    },
    backend,
  );
}

export const pngExporter = createPngExporter();
export const tiffExporter = createTiffExporter();
