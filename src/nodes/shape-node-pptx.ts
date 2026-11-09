import { fillXml, labelled, lnXml, nvPrXml, xfrmXml } from "../export/pptx/drawingml";
import { pathBounds } from "../model/path";
import { nodeLabel } from "../model/labels";
import type { ShapeNode } from "../model/types";
import type { PptxContext, PptxPart } from "../registry/node-type";

/**
 * A shape as a `p:sp` with its kind's geometry (`ShapeKind.toPptx`) at its box, turned with the node, filled with its
 * fill and outlined with its border, every colour faded by the node's opacity. A kind without that geometry (or one not
 * registered) is rasterised.
 */
export function shapeNodePptx(node: ShapeNode, base: PptxContext): PptxPart | "raster" {
  const kind = base.registries.shapes.get(node.kind);
  const box = { x: node.x, y: node.y, width: node.width, height: node.height };
  const geometry = kind?.toPptx?.(box, node.params) ?? null;
  if (!kind || geometry === null) return "raster";
  const ctx = labelled(base, nodeLabel(base.doc, node));
  const xfrm = xfrmXml({ x: ctx.px(node.x), y: ctx.px(node.y), cx: ctx.px(node.width), cy: ctx.px(node.height) }, node.rotation);
  const fill = fillXml(node.fill, node.opacity, box, ctx);
  const ln = lnXml(node.border, node.opacity, pathBounds(kind.outline(box, node.params)), ctx);
  const nv = `<p:nvSpPr>${nvPrXml(ctx.nextId(), node.name ?? node.id)}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>`;
  return { xml: `<p:sp>${nv}<p:spPr>${xfrm}${geometry}${fill}${ln}</p:spPr></p:sp>` };
}
