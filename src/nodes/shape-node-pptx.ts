import { fillXml, labelled, lnXml, nvPrXml, xfrmXml } from "../export/pptx/drawingml";
import { pathBounds } from "../model/path";
import { nodeLabel } from "../model/labels";
import type { ShapeNode } from "../model/types";
import type { PptxContext, PptxPart } from "../registry/node-type";

/** The preset geometry of a shape kind PowerPoint has, with its adjust values; null for a kind it has not. */
function presetGeometry(node: ShapeNode): string | null {
  if (node.kind === "ellipse") return '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>';
  if (node.kind !== "rect") return null;
  const raw = node.params.cornerRadius;
  const radius = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const short = Math.min(node.width, node.height);
  if (radius === 0 || short <= 0) return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  // roundRect's adj is the radius as a fraction of the short side, in 1/100 000, at most a half.
  const adj = Math.round(Math.min(0.5, radius / short) * 100000);
  return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
}

/**
 * A shape as a `p:sp` with a preset geometry (rect, roundRect, ellipse) at its box, turned with the node, filled with
 * its fill and outlined with its border, every colour faded by the node's opacity. A kind PowerPoint has no preset for
 * (or one not registered) is rasterised.
 */
export function shapeNodePptx(node: ShapeNode, base: PptxContext): PptxPart | "raster" {
  const kind = base.registries.shapes.get(node.kind);
  const geometry = kind ? presetGeometry(node) : null;
  if (!kind || geometry === null) return "raster";
  const ctx = labelled(base, nodeLabel(base.doc, node));
  const box = { x: node.x, y: node.y, width: node.width, height: node.height };
  const xfrm = xfrmXml({ x: ctx.px(node.x), y: ctx.px(node.y), cx: ctx.px(node.width), cy: ctx.px(node.height) }, node.rotation);
  const fill = fillXml(node.fill, node.opacity, box, ctx);
  const ln = lnXml(node.border, node.opacity, pathBounds(kind.outline(box, node.params)), ctx);
  const nv = `<p:nvSpPr>${nvPrXml(ctx.nextId(), node.name ?? node.id)}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>`;
  return { xml: `<p:sp>${nv}<p:spPr>${xfrm}${geometry}${fill}${ln}</p:spPr></p:sp>` };
}
