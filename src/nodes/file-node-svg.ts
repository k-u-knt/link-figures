import { inlineSvg, svgIntrinsicSize, svgRootAttributes } from "../export/inline-svg";
import type { FileAsset, SkippedAsset } from "../export/asset-types";
import { cropPlacement, type Rect } from "../model/geometry";
import { nodeLabel } from "../model/labels";
import { rectPath, toSvgPath } from "../model/path";
import type { Resolved } from "../links/types";
import type { Crop, FileNode } from "../model/types";
import type { SvgContext } from "../registry/node-type";
import { paintToSvg, strokeAttrs } from "../registry/paint";

/** What drawing a frame needs: the paints and the SVG it goes into. Warnings are said without the node's label; the caller adds it. */
export type FrameSvgContext = Pick<SvgContext, "registries" | "defs" | "warnings" | "uid">;

/**
 * The node's frame as an SVG fragment, in page px and unrotated: its box (the panel's rectangle, whatever the crop and
 * fit show inside it) stroked on its edge, half inside and half outside, with the paint laid out in the box. A node
 * without a frame draws nothing (the empty string).
 */
export function fileFrameSvg(node: FileNode, ctx: FrameSvgContext): string {
  if (!node.frame) return "";
  const box = { x: node.x, y: node.y, width: node.width, height: node.height };
  const paint = paintToSvg(ctx.registries.paints, node.frame.paint, box, ctx);
  ctx.defs.push(...paint.defs);
  return `<path d="${toSvgPath(rectPath(box, 0))}" fill="none" ${strokeAttrs(node.frame, paint.ref, paint.opacity)}/>`;
}

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

/** What an id may hold to be written into an attribute and a CSS selector as it is. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The start of the ids, classes and selectors a nested SVG gets: the node's id when it is made of letters, digits, `_` and
 * `-` (as ids the plugin makes are); otherwise, since a figure file can hold any string there, the id with every other
 * character made `_` and a unique suffix, so it can break out of neither an attribute nor a `<style>` rule.
 */
function idPrefixBase(node: FileNode, ctx: SvgContext): string {
  if (SAFE_ID.test(node.id)) return node.id;
  return `${node.id.replace(/[^A-Za-z0-9_-]/g, "_")}_${ctx.uid("id")}`;
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
  const prefix = `${idPrefixBase(node, ctx)}-`;
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
