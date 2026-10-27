import { inlineSvg, svgIntrinsicSize, svgRootNamespaces } from "../export/inline-svg";
import type { FileAsset } from "../export/asset-types";
import { imagePlacement } from "../model/geometry";
import type { FileNode } from "../model/types";
import type { SvgContext } from "../registry/node-type";

/** The node's image drawn at its crop and fit, clipped to the node's rectangle. Numbers are written as they are, unrounded. */
function clippedImage(node: FileNode, href: string, natural: { width: number; height: number }, ctx: SvgContext): string {
  const place = imagePlacement({ width: node.width, height: node.height }, natural, node.crop, node.fit);
  const clip = ctx.uid("clip");
  ctx.defs.push(`<clipPath id="${clip}"><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}"/></clipPath>`);
  return (
    `<image href="${href}" x="${node.x + place.x}" y="${node.y + place.y}" width="${place.width}" height="${place.height}" ` +
    `preserveAspectRatio="none" clip-path="url(#${clip})"/>`
  );
}

/** The linked SVG as a nested `<svg>`: its viewBox (or the crop's part of it) fills the node's rectangle as `fit` says. */
function nestedSvg(node: FileNode, text: string): string {
  const [vx, vy, vw, vh] = svgIntrinsicSize(text).viewBox;
  const c = node.crop;
  const viewBox = c ? [vx + c.x * vw, vy + c.y * vh, c.w * vw, c.h * vh] : [vx, vy, vw, vh];
  const aspect = node.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet";
  return (
    `<svg x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" viewBox="${viewBox.join(" ")}" ` +
    `preserveAspectRatio="${aspect}"${svgRootNamespaces(text)}>${inlineSvg(text, `${node.id}-`)}</svg>`
  );
}

/**
 * A file node as an SVG fragment, in the node's own (unrotated) coordinates, or `"raster"` for the nodes the DOM must
 * render: content cards, and links whose source could not be read (which also warns).
 */
export function fileNodeSvg(node: FileNode, asset: FileAsset | undefined, ctx: SvgContext): string | "raster" {
  if (node.show === "content") return "raster";
  if (!asset) {
    ctx.warnings.push(`Node ${node.id}: link missing, skipped`);
    return "raster";
  }
  switch (asset.kind) {
    case "image":
      return clippedImage(node, asset.dataUri, { width: asset.naturalWidth, height: asset.naturalHeight }, ctx);
    case "pdf":
      ctx.warnings.push(`Node ${node.id}: PDF panel rasterised`);
      return clippedImage(node, asset.raster, { width: asset.rasterWidth, height: asset.rasterHeight }, ctx);
    case "svg":
      return nestedSvg(node, asset.text);
  }
}
