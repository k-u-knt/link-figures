import { resolveConnector } from "../connectors/geometry";
import type { Registries } from "../registry";
import { roundPx } from "../view/pointer-math";
import { mmToPx, pageSizePx, unionRect, type Pt, type Rect } from "./geometry";
import { childrenOf, isGroup } from "./groups";
import type { ConnectorNode, Document, NodeId, Page } from "./types";

/**
 * Align and distribute: where each unit (a node, or a group with all in it) moves so that its visual bounds meet a
 * reference. Everything here is in page px of the units' page; the offsets are rounded as `roundPx` rounds.
 */

export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type AlignTo = "selection" | "page" | "margins";
export type Axis = "horizontal" | "vertical";
export type DistributeBy = "gap" | "center";

const roundRect = (r: Rect): Rect => ({ x: roundPx(r.x), y: roundPx(r.y), width: roundPx(r.width), height: roundPx(r.height) });

/**
 * Node `id`'s bounds as drawn, in page px: its box turned by its rotation about the box centre, then axis-aligned. A
 * container (a type with `members`) is the union of its members' visual bounds, at any depth (its own box when it has
 * none); a connector is the area it draws (`resolveConnector(…).bounds`). A missing node gives a zero rect.
 */
export function visualBounds(doc: Document, id: NodeId, registries: Registries): Rect {
  return roundRect(rawBounds(doc, id, registries, new Set()));
}

function rawBounds(doc: Document, id: NodeId, registries: Registries, seen: Set<NodeId>): Rect {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return { x: 0, y: 0, width: 0, height: 0 };
  seen.add(id);
  if (isGroup(doc, id, registries)) {
    const members = childrenOf(doc, id).filter((m) => !seen.has(m));
    if (members.length > 0) return unionRect(members.map((m) => rawBounds(doc, m, registries, seen)));
  }
  if (node.type === "connector") return resolveConnector(doc, node as ConnectorNode, registries).bounds;
  const turn = (node.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  const width = node.width * cos + node.height * sin;
  const height = node.width * sin + node.height * cos;
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/**
 * What `align` aligns to on `page`: the union of the units' visual bounds ("selection"), the page, or the page's margin
 * box ("margins", the page less its margins, which are in mm).
 */
export function referenceRect(doc: Document, page: Page, units: readonly NodeId[], to: AlignTo, registries: Registries): Rect {
  const size = pageSizePx(page);
  if (to === "page") return { x: 0, y: 0, ...size };
  if (to === "margins") {
    const m = page.margins;
    return { x: mmToPx(m.left), y: mmToPx(m.top), width: size.width - mmToPx(m.left + m.right), height: size.height - mmToPx(m.top + m.bottom) };
  }
  return unionRect(units.map((id) => visualBounds(doc, id, registries)));
}

/** Where a rect's `edge` lies along its axis. */
function edgeOf(r: Rect, edge: AlignEdge): number {
  switch (edge) {
    case "left":
      return r.x;
    case "hcenter":
      return r.x + r.width / 2;
    case "right":
      return r.x + r.width;
    case "top":
      return r.y;
    case "vcenter":
      return r.y + r.height / 2;
    case "bottom":
      return r.y + r.height;
  }
}

const horizontalEdge = (edge: AlignEdge): boolean => edge === "left" || edge === "hcenter" || edge === "right";

/** How far each of `units` moves so its visual bounds' `edge` (or centre) meets `reference`'s. */
export function alignOffsets(doc: Document, units: readonly NodeId[], edge: AlignEdge, reference: Rect, registries: Registries): Map<NodeId, Pt> {
  const out = new Map<NodeId, Pt>();
  const target = edgeOf(reference, edge);
  for (const id of units) {
    const d = roundPx(target - edgeOf(visualBounds(doc, id, registries), edge));
    out.set(id, horizontalEdge(edge) ? { x: d, y: 0 } : { x: 0, y: d });
  }
  return out;
}

/**
 * How far each of `units` moves to spread them along `axis`: the two outermost (by the centre of their visual bounds)
 * stay, and the others move so the gaps between neighbouring bounds are equal ("gap") or the centres are evenly spaced
 * ("center"). Fewer than three units move nothing.
 */
export function distributeOffsets(doc: Document, units: readonly NodeId[], axis: Axis, by: DistributeBy, registries: Registries): Map<NodeId, Pt> {
  const out = new Map<NodeId, Pt>();
  const along = (r: Rect) => (axis === "horizontal" ? { start: r.x, size: r.width } : { start: r.y, size: r.height });
  // `sort` is stable, so units whose centres tie keep the order given.
  const items = units
    .map((id) => ({ id, ...along(visualBounds(doc, id, registries)) }))
    .sort((a, b) => a.start + a.size / 2 - (b.start + b.size / 2));
  const put = (id: NodeId, d: number) => out.set(id, axis === "horizontal" ? { x: roundPx(d), y: 0 } : { x: 0, y: roundPx(d) });
  for (const item of items) put(item.id, 0);
  if (items.length < 3) return out;
  const first = items[0];
  const last = items[items.length - 1];
  const steps = items.length - 1;
  if (by === "center") {
    const from = first.start + first.size / 2;
    const step = (last.start + last.size / 2 - from) / steps;
    items.forEach((item, i) => {
      if (i > 0 && i < steps) put(item.id, from + i * step - (item.start + item.size / 2));
    });
    return out;
  }
  const span = last.start + last.size - first.start;
  const gap = (span - items.reduce((sum, item) => sum + item.size, 0)) / steps;
  let at = first.start;
  items.forEach((item, i) => {
    if (i > 0 && i < steps) put(item.id, at - item.start);
    at += item.size + gap;
  });
  return out;
}
