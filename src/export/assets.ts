import type { App } from "obsidian";
import { MAX_DECODE_MEGAPIXELS } from "../constants";
import { DecodeLimitError } from "../links/decoders/budget";
import { jpegOrientation } from "../links/decoders/exif";
import { decodePdf, pdfPageSizePt } from "../links/decoders/pdf";
import { recipeOf } from "../adjust/render";
import type { Decoders, Resolved } from "../links/types";
import { nodeLabel } from "../model/labels";
import type { Document, FileNode, NodeId, Page } from "../model/types";
import { skippedReason } from "../nodes/file-node-svg";
import type { AssetMap, FileAsset, RasterAsset } from "./asset-types";
import { svgIntrinsicSize } from "./inline-svg";
import { withLaidOut } from "./laid-out";
import { turnJpegUpright, type JpegTurner } from "./upright-jpeg";

export type { AssetMap, FileAsset, ImageAsset, PdfAsset, RasterAsset, SkippedAsset, SvgAsset } from "./asset-types";

/** CSS px per inch, the basis of `scale` for a DOM snapshot. */
const CSS_DPI = 96;
/** PDF points per inch: pdf.js's `scale` 1 is 72 dpi. */
const PT_DPI = 72;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** How far below the decode budget a PDF page is drawn when it does not fit at the export's resolution (whole pixels round up). */
const BUDGET_MARGIN = 0.99;

/** A multiple of 3, so that each chunk encodes to base64 without padding and the pieces concatenate. */
const BASE64_CHUNK_BYTES = 3 * 10_000;

/** `data:{mime};base64,…`. Encodes in chunks, so a large file neither overflows the stack nor needs one huge intermediate string. */
export function bytesToDataUri(bytes: ArrayBuffer, mime: string): string {
  const view = new Uint8Array(bytes);
  const pieces: string[] = [`data:${mime};base64,`];
  for (let i = 0; i < view.length; i += BASE64_CHUNK_BYTES) {
    pieces.push(btoa(String.fromCharCode(...view.subarray(i, i + BASE64_CHUNK_BYTES))));
  }
  return pieces.join("");
}

function extensionOf(path: string): string {
  return /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase() ?? "";
}

/** The pixel size of an image given as a data URI. Rejects when it cannot be decoded or reports no size. */
function loadNaturalSize(dataUri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve({ width: img.naturalWidth, height: img.naturalHeight });
      else reject(new Error("the image has no size"));
    };
    img.onerror = () => reject(new Error("the image could not be decoded"));
    img.src = dataUri;
  });
}

export interface AssetDeps {
  app: App;
  resolved: (id: NodeId) => Resolved | undefined;
  /** The node's `.lf-node` element on the stage, which holds the `.lf-node-body` a content card is rasterised from. */
  elementFor: (id: NodeId) => HTMLElement | undefined;
  /** Both take a vault path and reject when the file is gone. */
  readBinary: (path: string) => Promise<ArrayBuffer>;
  readText: (path: string) => Promise<string>;
  /** The stage's decoders: a TIFF or adjusted raster panel is drawn by the same code, with the same recipe, as on the stage. */
  decoders: Decoders;
  /** Resolution of everything that has to be rasterised: PDF pages and note content. */
  dpi: number;
  /** Where the reason goes when one node's asset could not be made: `{label}: {reason}`. */
  warnings: string[];
  /** Turns a JPEG upright by its EXIF orientation (`turnJpegUpright` when absent; a stand-in in a test). */
  turnJpeg?: JpegTurner;
}

/** The node's body as the DOM draws it, rasterised at `dpi`. `dpr: 1` so the pixel size does not also depend on the monitor. */
async function snapshotBody(el: HTMLElement | undefined, dpi: number): Promise<RasterAsset> {
  const body = el?.querySelector<HTMLElement>(".lf-node-body");
  if (!body) throw new Error("the node is not drawn on the stage, so it cannot be rasterised");
  // Loaded when first needed: most figures have no content card, and the library is large.
  const { snapdom } = await import("@zumer/snapdom");
  // A figure in a tab that is not shown has no layout, and its snapshot would be blank: laid out while it is taken.
  const image = await withLaidOut(body, async () => (await snapdom(body, { scale: dpi / CSS_DPI, dpr: 1 })).toPng());
  if (!image.src.startsWith("data:image/")) throw new Error("the snapshot is not an image");
  return { kind: "raster", dataUri: image.src };
}

/**
 * The PDF page drawn at the export's resolution or, when that is over the decode budget, at the highest resolution
 * within it (with a warning, worded so that the PDF exporter drops it with the other "PDF panel rasterised" ones): the
 * PDF export embeds the page as vectors whatever its raster, so it must not lose the panel.
 */
async function decodePdfWithinBudget(doc: Document, node: FileNode, bytes: ArrayBuffer, deps: AssetDeps): ReturnType<typeof decodePdf> {
  const scale = deps.dpi / PT_DPI;
  try {
    return await decodePdf(bytes, node.pageIndex, scale);
  } catch (error) {
    if (!(error instanceof DecodeLimitError)) throw error;
    const fit = scale * Math.sqrt((MAX_DECODE_MEGAPIXELS * 1e6) / (error.width * error.height)) * BUDGET_MARGIN;
    const raster = await decodePdf(bytes, node.pageIndex, fit);
    deps.warnings.push(`${nodeLabel(doc, node)}: PDF panel rasterised at ${Math.floor(fit * PT_DPI)} dpi, not ${deps.dpi}: ${error.message}`);
    return raster;
  }
}

/**
 * A JPEG with an EXIF orientation other than 1. The stage (the browser) draws it turned by that orientation; a PDF, a
 * slide or another SVG viewer may draw the stored pixels as they are. So it is turned upright and encoded again as a
 * JPEG (not a PNG, many times larger), and every export matches the stage. With no recipe: unadjusted, the stage draws
 * the file's pixels as they are. A photo that cannot be turned (over the decode budget, or not decoded) is embedded as
 * it is, at its stored size, with a warning: the panel is never lost for it.
 */
async function turnedPhotoAsset(doc: Document, node: FileNode, data: ArrayBuffer, orientation: number, deps: AssetDeps): Promise<FileAsset> {
  try {
    const upright = await (deps.turnJpeg ?? turnJpegUpright)(data);
    return { kind: "image", dataUri: bytesToDataUri(upright.bytes, "image/jpeg"), naturalWidth: upright.width, naturalHeight: upright.height };
  } catch {
    const dataUri = bytesToDataUri(data, "image/jpeg");
    // The browser reports the turned size; orientations 5 to 8 swap the sides of the stored pixels.
    const natural = await loadNaturalSize(dataUri);
    const swapped = orientation >= 5;
    deps.warnings.push(`${nodeLabel(doc, node)}: photo exported unrotated (it could not be turned upright)`);
    return { kind: "image", dataUri, naturalWidth: swapped ? natural.height : natural.width, naturalHeight: swapped ? natural.width : natural.height };
  }
}

async function imageAsset(doc: Document, node: FileNode, resolved: Extract<Resolved, { kind: "image" }>, deps: AssetDeps): Promise<FileAsset> {
  const path = resolved.file.path;
  switch (resolved.source) {
    case "raster": {
      if (deps.decoders.adjusts(node)) {
        // Drawn as a PNG: the AVIF limit of the PDF export does not apply to it.
        const decoded = await deps.decoders.raster(await deps.readBinary(path), recipeOf(node));
        return { kind: "image", dataUri: decoded.dataUrl, naturalWidth: decoded.width, naturalHeight: decoded.height };
      }
      const mime = MIME_BY_EXTENSION[extensionOf(path)];
      if (!mime) throw new Error(`"${path}" is not an image type that can be embedded`);
      const data = await deps.readBinary(path);
      if (mime === "image/jpeg") {
        const orientation = jpegOrientation(data);
        if (orientation !== 1) return turnedPhotoAsset(doc, node, data, orientation, deps);
      }
      const dataUri = bytesToDataUri(data, mime);
      const natural = await loadNaturalSize(dataUri);
      // svg2pdf.js leaves an AVIF image out of the PDF with nothing but a console message; the SVG export keeps it.
      if (mime === "image/avif") deps.warnings.push(`${nodeLabel(doc, node)}: AVIF is not supported by the PDF export`);
      return { kind: "image", dataUri, naturalWidth: natural.width, naturalHeight: natural.height };
    }
    case "svg": {
      const text = await deps.readText(path);
      const { width, height } = svgIntrinsicSize(text);
      return { kind: "svg", text, width, height };
    }
    case "pdf": {
      const bytes = await deps.readBinary(path);
      const raster = await decodePdfWithinBudget(doc, node, bytes, deps);
      // The page decodePdf drew: an out-of-range index is clamped, and the asset says which page it holds.
      const pageIndex = Math.min(Math.max(Math.trunc(node.pageIndex) || 0, 0), raster.pageCount - 1);
      const size = await pdfPageSizePt(bytes, pageIndex);
      return {
        kind: "pdf",
        bytes,
        pageIndex,
        widthPt: size.width,
        heightPt: size.height,
        raster: raster.dataUrl,
        rasterWidth: raster.width,
        rasterHeight: raster.height,
      };
    }
    case "tiff": {
      // Full resolution, drawn through the node's range and adjustments as on the stage.
      const decoded = await deps.decoders.tiff(await deps.readBinary(path), node.pageIndex, recipeOf(node));
      return { kind: "image", dataUri: decoded.dataUrl, naturalWidth: decoded.width, naturalHeight: decoded.height };
    }
  }
}

/**
 * Everything a page's nodes need that only the vault or the DOM can give: each linked image's bytes (or the SVG's
 * text, or a PDF page, or a TIFF page, decoded) and a raster of each content card. A node that cannot be drawn gets a
 * `skipped` asset that says why (its link is missing or still resolving, or collecting it threw), so `buildPageSvg`
 * reports each such node once. One node that fails does not stop the others.
 */
export async function collectAssets(doc: Document, page: Page, deps: AssetDeps): Promise<AssetMap> {
  const assets: AssetMap = new Map();
  // One at a time: each decode or snapshot holds a canvas or a whole file in memory.
  for (const node of doc.nodes) {
    if (node.page !== page.id || node.type !== "file") continue;
    try {
      const resolved = deps.resolved(node.id);
      if (!resolved) {
        assets.set(node.id, { kind: "skipped", reason: "its link is still being resolved" });
        continue;
      }
      if (resolved.kind === "missing") {
        assets.set(node.id, { kind: "skipped", reason: skippedReason(resolved) });
        continue;
      }
      // The node type draws a content card from a raster, also when a card's link turned out to be an image.
      if (node.show === "content" || resolved.kind === "content") {
        assets.set(node.id, await snapshotBody(deps.elementFor(node.id), deps.dpi));
      } else {
        assets.set(node.id, await imageAsset(doc, node, resolved, deps));
      }
    } catch (error) {
      assets.set(node.id, { kind: "skipped", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return assets;
}
