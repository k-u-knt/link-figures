import { labelled, lnXml, nvPrXml, turnedXfrmXml } from "../export/pptx/drawingml";
import { dataUriBytes, mediaExt, pictureXml, type SrcRect } from "../export/pptx/media";
import { cropPlacement, type Rect } from "../model/geometry";
import { nodeLabel } from "../model/labels";
import type { Crop, FileNode } from "../model/types";
import type { PptxContext, PptxPart, SvgContext } from "../registry/node-type";
import { fileNodeSvg } from "./file-node-svg";

/** What a panel shows as one picture: its media, where it shows (page px, unturned) and the part of the media cut off. */
interface Shown {
  rId: string;
  rect: Rect;
  srcRect?: SrcRect;
}

const EPS = 1e-6;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r - x > EPS && btm - y > EPS ? { x, y, width: r - x, height: btm - y } : null;
}

const extensionOf = (path: string): string => /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase() ?? "";

/**
 * An image (a data URI of `natural` size) placed in the panel at `crop` and the panel's fit: the part that shows, as
 * its PNG or JPEG bytes cut by `srcRect` (never negative: what shows is the image's part of the visible region), or,
 * for another format, that part drawn as a PNG (with a warning). Null when nothing of it shows.
 */
async function placedImage(node: FileNode, uri: string, natural: { width: number; height: number }, crop: Crop | null, ctx: PptxContext): Promise<Shown | null> {
  const { image, region } = cropPlacement({ width: node.width, height: node.height }, natural, crop, node.fit);
  const seen = intersect(region, image);
  if (!seen) return null;
  const rect = { x: node.x + seen.x, y: node.y + seen.y, width: seen.width, height: seen.height };
  const data = dataUriBytes(uri);
  const ext = data ? mediaExt(data.mime) : null;
  if (data && ext) {
    const srcRect = {
      l: (seen.x - image.x) / image.width,
      t: (seen.y - image.y) / image.height,
      r: (image.x + image.width - seen.x - seen.width) / image.width,
      b: (image.y + image.height - seen.y - seen.height) / image.height,
    };
    return { rId: ctx.addMedia(data.bytes, ext), rect, srcRect };
  }
  ctx.warn(`${data?.mime ?? "an image"} is not a format PowerPoint embeds, written as PNG`);
  const fragment = `<image href="${uri.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" x="${node.x + image.x}" y="${node.y + image.y}" width="${image.width}" height="${image.height}" preserveAspectRatio="none"/>`;
  return { rId: ctx.addMedia(await ctx.rasterise(fragment, rect), "png"), rect };
}

/**
 * A file panel as a `p:pic` named after the node and described by its link (`[[file#subpath]]`), turned and faded with
 * the node:
 * - a PNG or JPEG image (as the export collected it: the file's own bytes, or the PNG it drew for a trimmed, adjusted or
 *   TIFF panel) is embedded, cut to what shows by `a:srcRect`;
 * - a PDF panel is its page's raster (at the export dpi), cut the same way, with a warning;
 * - an SVG panel and a content card are pictures drawn at the export dpi, with a warning;
 * - a missing link is left out, with a warning.
 * The frame is the picture's `a:ln` when the picture fills the box, else a rectangle of its own over it.
 */
export async function fileNodePptx(node: FileNode, base: PptxContext): Promise<PptxPart | null> {
  const ctx = labelled(base, nodeLabel(base.doc, node));
  const asset = ctx.assets.get(node.id);
  if (!asset) {
    ctx.warn("link missing, skipped");
    return null;
  }
  if (asset.kind === "skipped") {
    ctx.warn(`${asset.reason}, skipped`);
    return null;
  }
  const box: Rect = { x: node.x, y: node.y, width: node.width, height: node.height };
  let shown: Shown | null;
  try {
    switch (asset.kind) {
      case "raster": {
        const data = dataUriBytes(asset.dataUri);
        const ext = data ? mediaExt(data.mime) : null;
        if (!data || !ext) throw new Error("its snapshot is not a PNG or JPEG");
        ctx.warn("content card written as a picture");
        shown = { rId: ctx.addMedia(data.bytes, ext), rect: box };
        break;
      }
      case "image":
        if (["tif", "tiff"].includes(extensionOf(node.file))) ctx.warn("TIFF panel written as PNG");
        shown = await placedImage(node, asset.dataUri, { width: asset.naturalWidth, height: asset.naturalHeight }, asset.crop ?? node.crop, ctx);
        break;
      case "pdf":
        ctx.warn("PDF panel written as a picture");
        shown = await placedImage(node, asset.raster, { width: asset.rasterWidth, height: asset.rasterHeight }, asset.rasterCrop ?? node.crop, ctx);
        break;
      case "svg": {
        const defs: string[] = [];
        const warnings: string[] = [];
        let n = 0;
        const svgCtx: SvgContext = { registries: ctx.registries, doc: ctx.doc, page: ctx.page, assets: ctx.assets, defs, warnings, uid: (prefix) => `pptx-${prefix}-${++n}`, unreadable: ctx.unreadable };
        const fragment = fileNodeSvg(node, asset, svgCtx);
        for (const warning of warnings) base.warn(warning);
        ctx.warn("SVG panel written as a picture");
        const png = await ctx.rasterise(`<defs>${defs.join("")}</defs>${fragment}`, box);
        shown = { rId: ctx.addMedia(png, "png"), rect: box };
        break;
      }
    }
  } catch (error) {
    ctx.warn(`could not be written: ${message(error)}, skipped`);
    return null;
  }

  const pivot = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const frame = node.frame && node.frame.width > 0 ? lnXml(node.frame, node.opacity, box, ctx) : "";
  const fills = shown !== null && Math.abs(shown.rect.x - box.x) < EPS && Math.abs(shown.rect.y - box.y) < EPS && Math.abs(shown.rect.width - box.width) < EPS && Math.abs(shown.rect.height - box.height) < EPS;
  const name = node.name ?? node.id;
  const descr = `[[${node.file}${node.subpath}]]`;
  const parts: string[] = [];
  if (shown) {
    parts.push(pictureXml({ id: ctx.nextId(), name, descr, rId: shown.rId, rect: shown.rect, pivot, rotation: node.rotation, srcRect: shown.srcRect, alpha: node.opacity, ln: fills ? frame : undefined }, ctx));
  }
  if (frame !== "" && !fills) {
    const nv = `<p:nvSpPr>${nvPrXml(ctx.nextId(), `${name} frame`)}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>`;
    parts.push(`<p:sp>${nv}<p:spPr>${turnedXfrmXml(box, pivot, node.rotation, ctx)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>${frame}</p:spPr></p:sp>`);
  }
  return parts.length === 0 ? null : { xml: parts.join("") };
}
