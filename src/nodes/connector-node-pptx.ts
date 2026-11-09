import { resolveConnector } from "../connectors/geometry";
import { custGeomXml, labelled, lnXml, nvPrXml, xfrmXml } from "../export/pptx/drawingml";
import { nodeLabel } from "../model/labels";
import { pathBounds } from "../model/path";
import type { Cap, ConnectorNode } from "../model/types";
import { DEFAULT_CAP_SIZE } from "../registry/cap";
import type { PptxContext, PptxPart } from "../registry/node-type";

/** A line end's width and length from the cap's size (a multiple of the line's width). */
function endSize(size: number): "sm" | "med" | "lg" {
  const s = Number.isFinite(size) ? size : DEFAULT_CAP_SIZE;
  return s <= 2 ? "sm" : s <= 4 ? "med" : "lg";
}

/** A cap as an `a:headEnd` or `a:tailEnd`; a kind without a PowerPoint line end (or not registered) is none, with a warning. */
function lineEnd(tag: "a:headEnd" | "a:tailEnd", cap: Cap, ctx: Pick<PptxContext, "registries" | "warn">): string {
  const kind = ctx.registries.caps.get(cap.kind);
  let type: string = kind?.pptxEnd ?? "none";
  if (!kind) ctx.warn(`no cap kind "${cap.kind}" is registered, written without it`);
  else if (!kind.pptxEnd) ctx.warn(`the "${kind.name}" cap has no PowerPoint line end, written without one`);
  if (type === "none") return `<${tag} type="none"/>`;
  const size = endSize(cap.size);
  return `<${tag} type="${type}" w="${size}" len="${size}"/>`;
}

/**
 * A connector as a `p:cxnSp` whose custom geometry is its whole route, not shortened for its caps, stroked with its
 * stroke (a gradient or pattern laid out over the route, as on the stage), with its caps as the line's head and tail
 * ends. Its ends are not PowerPoint connections: the line stays where it is when the items it joins move.
 */
export function connectorNodePptx(node: ConnectorNode, base: PptxContext): PptxPart {
  const ctx = labelled(base, nodeLabel(base.doc, node));
  if (!ctx.registries.routes.get(node.route)) ctx.warn(`no route "${node.route}" is registered, drawn straight`);
  const resolved = resolveConnector(ctx.doc, node, ctx.registries, ctx.unreadable);
  const box = pathBounds(resolved.full);
  const xfrm = xfrmXml({ x: ctx.px(box.x), y: ctx.px(box.y), cx: ctx.px(box.width), cy: ctx.px(box.height) }, 0);
  const ends = lineEnd("a:headEnd", node.caps[0], ctx) + lineEnd("a:tailEnd", node.caps[1], ctx);
  const ln = lnXml(node.stroke, node.opacity, resolved.paintBox, ctx, ends);
  const nv = `<p:nvCxnSpPr>${nvPrXml(ctx.nextId(), node.name ?? node.id)}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>`;
  return { xml: `<p:cxnSp>${nv}<p:spPr>${xfrm}${custGeomXml(resolved.full, box, ctx)}<a:noFill/>${ln}</p:spPr></p:cxnSp>` };
}
