import { inlineSvg, svgIntrinsicSize, svgRootAttributes } from "../export/inline-svg";
import type { FileAsset, SkippedAsset } from "../export/asset-types";
import { cropPlacement, type Rect } from "../model/geometry";
import { nodeLabel } from "../model/labels";
import type { Resolved } from "../links/types";
import type { Crop, FileNode } from "../model/types";
import type { SvgContext } from "../registry/node-type";

/**
 * The node's image drawn at its crop and fit, clipped to the crop's region of the node's rectangle, so that with `contain`
 * the image outside the crop does not fill the letterbox. `crop` is the node's, or the one a trimmed asset carries for its
 * cut image. Numbers are written as they are, unrounded.
 */
function clippedImage(node: FileNode, href: string, natural: { width: number; height: number }, crop: Crop | null, ctx: SvgContext): string {
  const { image, region } = cropPlacement({ width: node.width, height: node.height }, natural, crop, node.fit);
  const clip = ctx.uid("clip");
  ctx.defs.push(clipRect(clip, node, region));
  return (
    `<image href="${href}" x="${node.x + image.x}" y="${node.y + image.y}" width="${image.width}" height="${image.height}" ` +
    `preserveAspectRatio="none" clip-path="url(#${clip})"/>`
  );
}

/** A `<clipPath>` of the part of the node's rectangle that `region` (relative to the node) names. */
function clipRect(id: string, node: FileNode, region: Rect): string {
  return `<clipPath id="${id}"><rect x="${node.x + region.x}" y="${node.y + region.y}" width="${region.width}" height="${region.height}"/></clipPath>`;
}

/**
 * The linked SVG as a nested `<svg>`: its viewBox (or the crop's part of it) fills the crop's region as `fit` says, and
 * a clip to that region cuts off what `cover` pushes beyond the node's rectangle. The nested `<svg>`'s viewport has the
 * crop's aspect ratio, so `meet` and `slice` draw the same and `meet` is used for both. It carries the file's root
 * attributes (namespaces, `class`, `fill`…) and the id `{node.id}-root` that the file's scoped `<style>` rules start from.
 * Things inlining had to drop are reported as warnings.
 */
function nestedSvg(node: FileNode, text: string, ctx: SvgContext): string {
  const [vx, vy, vw, vh] = svgIntrinsicSize(text).viewBox;
  const c = node.crop;
  const viewBox = c ? [vx + c.x * vw, vy + c.y * vh, c.w * vw, c.h * vh] : [vx, vy, vw, vh];
  const { fitted, region } = cropPlacement({ width: node.width, height: node.height }, { width: vw, height: vh }, c, node.fit);
  const clip = ctx.uid("clip");
  ctx.defs.push(clipRect(clip, node, region));
  const prefix = `${node.id}-`;
  const dropped: string[] = [];
  const rootAttributes = svgRootAttributes(text, prefix, dropped);
  const content = inlineSvg(text, prefix, dropped);
  for (const message of dropped) ctx.warnings.push(`${nodeLabel(ctx.doc, node)}: ${message}`);
  return (
    `<g clip-path="url(#${clip})">` +
    `<svg x="${node.x + fitted.x}" y="${node.y + fitted.y}" width="${fitted.width}" height="${fitted.height}" viewBox="${viewBox.join(" ")}" ` +
    `preserveAspectRatio="xMidYMid meet" id="${prefix}root"${rootAttributes}>${content}</svg></g>`
  );
}

/** Why a missing link cannot be drawn, as an export warning says it (after the node's label, before ", skipped"). */
export function skippedReason(resolved: Extract<Resolved, { kind: "missing" }>): string {
  switch (resolved.reason) {
    case "file":
      return "link missing";
    case "subpath":
      return "heading or block not found";
    case "no-image":
      return "no image in that section";
    case "decode":
      return resolved.message ? `could not be decoded (${resolved.message})` : "could not be decoded";
  }
}

/**
 * A file node as an SVG fragment, in the node's own (unrotated) coordinates, or `"raster"` for the nodes the DOM must
 * render: content cards, and links that could not be drawn (which also warns).
 */
export function fileNodeSvg(node: FileNode, asset: FileAsset | SkippedAsset | undefined, ctx: SvgContext): string | "raster" {
  if (asset?.kind === "skipped") {
    ctx.warnings.push(`${nodeLabel(ctx.doc, node)}: ${asset.reason}, skipped`);
    return "raster";
  }
  if (node.show === "content") return "raster";
  if (!asset) {
    ctx.warnings.push(`${nodeLabel(ctx.doc, node)}: link missing, skipped`);
    return "raster";
  }
  switch (asset.kind) {
    case "image":
      return clippedImage(node, asset.dataUri, { width: asset.naturalWidth, height: asset.naturalHeight }, asset.crop ?? node.crop, ctx);
    case "pdf":
      ctx.warnings.push(`${nodeLabel(ctx.doc, node)}: PDF panel rasterised`);
      return clippedImage(node, asset.raster, { width: asset.rasterWidth, height: asset.rasterHeight }, asset.rasterCrop ?? node.crop, ctx);
    case "svg":
      return nestedSvg(node, asset.text, ctx);
  }
}
