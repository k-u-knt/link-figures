import type { Document, End, Node, NodeId } from "./types";
import type { Pt, Rect } from "./geometry";
import { rectPath, transformPath, type Matrix, type PathData } from "./path";
import type { Registries } from "../registry";
import { nodeTypeFor } from "../registry/node-type";
import type { Anchor } from "../registry/shape-kind";
import { boxAnchors } from "../shapes/builtin";

/** What a connector attaches to: an item's outline and anchors in page px, with its rotation applied. */
export interface Attachable {
  outline: PathData;
  anchors: Anchor[];
}

/** What a connector needs of an item: its `Attachable`, and the centre of its box (which rotation leaves where it is). */
export interface AttachTarget extends Attachable {
  center: Pt;
  /**
   * True when the item is attached to as its box because its own `attachable` cannot be asked: its type is not
   * registered (a foreign item), its plugin could not read it, or its hook threw. Its own anchors are not known then,
   * so an end snapped to one of them keeps its anchor id as it is (see `connectorNormaliser`).
   */
  fallback?: true;
}

/** The node types whose throwing `attachable` hook has been reported, so each is reported once. */
const reportedAttachable = new Set<string>();

/** The centre of a node's box, the point its rotation turns about. */
function centerOf(node: Node): Pt {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * An unrotated outline and anchors, turned by the node's rotation about its centre (the convention the SVG export and the
 * DOM share). An anchor's `dir` turns with it and is not translated.
 */
export function rotateAttachable(node: Node, unrotated: Attachable): Attachable {
  if (node.rotation === 0) return unrotated;
  const { x: cx, y: cy } = centerOf(node);
  const rad = (node.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const turn: Matrix = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
  const point = (x: number, y: number): Pt => ({ x: turn[0] * x + turn[2] * y + turn[4], y: turn[1] * x + turn[3] * y + turn[5] });
  return {
    outline: transformPath(unrotated.outline, turn),
    anchors: unrotated.anchors.map((a) => ({
      id: a.id,
      ...point(a.x, a.y),
      dir: { x: cos * a.dir.x - sin * a.dir.y, y: sin * a.dir.x + cos * a.dir.y },
    })),
  };
}

/** The node's box as an `Attachable` with its rotation applied: the contract for items that are a plain rectangle, like file panels and text labels. */
export function boxAttachable(node: Node): Attachable {
  const box: Rect = { x: node.x, y: node.y, width: node.width, height: node.height };
  return rotateAttachable(node, { outline: rectPath(box, 0), anchors: boxAnchors(box) });
}

/**
 * What a connector attaches to for the node `id`: its outline and anchors in page px (rotation applied) and its centre.
 * `null` when there is no such node, or its registered type does not implement `attachable` (a connector). An item no
 * registered type can be asked about (foreign, one of `unreadable`, or whose hook throws) is attached to as its box
 * (`AttachTarget.fallback`), so a connector attached to it keeps its end.
 */
export function attachTarget(doc: Document, registries: Registries, id: NodeId, unreadable?: ReadonlySet<NodeId>): AttachTarget | null {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return null;
  const type = nodeTypeFor(registries, node, unreadable);
  const asBox = (): AttachTarget => ({ ...boxAttachable(node), center: centerOf(node), fallback: true });
  // A foreign or unreadable item is attached to as its box, so a connector attached to it keeps its end.
  if (!type) return asBox();
  if (!type.attachable) return null;
  try {
    return { ...type.attachable(node, { registries }), center: centerOf(node) };
  } catch (error) {
    // A plugin's bug: contained here, so it cannot break a commit (the connector normaliser runs in every one).
    if (!reportedAttachable.has(node.type)) {
      reportedAttachable.add(node.type);
      console.warn(`Link Figures: the "${node.type}" type's attachable hook failed; its items are attached to as their box`, error);
    }
    return asBox();
  }
}

/** How a connector's end that is dropped on an item attaches to it: at its nearest anchor, or at its centre. */
export type SnapMode = "anchor" | "center";

/** The view option (see `FigureViewLike.viewOption`) that holds the snap mode new connector ends take; "anchor" when unset. */
export const SNAP_MODE_OPTION = "connector.snap-mode";

/** The snap mode a view option holds: "center" when it says so, else "anchor". */
export function snapModeOf(value: unknown): SnapMode {
  return value === "center" ? "center" : "anchor";
}

/**
 * The first of `under` (items at a point, topmost first) that a connector on `page` can attach to, and what it attaches
 * to of it; null when there is none. `exclude` (the connector itself) is passed over.
 */
export function attachableUnder(
  doc: Document,
  registries: Registries,
  page: string,
  under: readonly NodeId[],
  exclude?: NodeId,
  unreadable?: ReadonlySet<NodeId>,
): { id: NodeId; target: AttachTarget } | null {
  for (const id of under) {
    if (id === exclude || doc.nodes.find((n) => n.id === id)?.page !== page) continue;
    const target = attachTarget(doc, registries, id, unreadable);
    if (target) return { id, target };
  }
  return null;
}

/**
 * How near (screen px) a connector's end must come to a snap point for it to take it, though it is on no item's body:
 * an anchor's dot sits on the edge, half outside. The view turns it into page px at its zoom; headless it is 0.
 */
export const SNAP_REACH_PX = 8;

/**
 * The item on `page` (other than `exclude`) that a connector can attach to with a snap point within `reach` (page px) of
 * `at`, and that point: its anchors in anchor mode (its centre when it has none), its centre in centre mode. The nearest
 * point wins, and of points as near the one of the higher `z` (the later item, at the same `z`). `anchor` is null for the
 * centre. Null when no point is within reach.
 */
export function attachableNear(
  doc: Document,
  registries: Registries,
  page: string,
  at: Pt,
  mode: SnapMode,
  reach: number,
  exclude?: NodeId,
  unreadable?: ReadonlySet<NodeId>,
): { id: NodeId; target: AttachTarget; anchor: Anchor | null } | null {
  if (!(reach > 0)) return null;
  let best: { id: NodeId; target: AttachTarget; anchor: Anchor | null; away: number; z: number } | null = null;
  for (const node of doc.nodes) {
    if (node.id === exclude || node.page !== page) continue;
    const target = attachTarget(doc, registries, node.id, unreadable);
    if (!target) continue;
    const points: (Anchor | null)[] = mode === "center" || target.anchors.length === 0 ? [null] : target.anchors;
    for (const anchor of points) {
      const p = anchor ?? target.center;
      const away = Math.hypot(p.x - at.x, p.y - at.y);
      if (away > reach) continue;
      if (!best || away < best.away || (away === best.away && node.z >= best.z)) best = { id: node.id, target, anchor, away, z: node.z };
    }
  }
  return best && { id: best.id, target: best.target, anchor: best.anchor };
}

/**
 * The end a connector on `page` gets for a point `at` (page px) with `under` the items there, topmost first. Within
 * `reach` (page px) of a snap point it attaches there (see `attachableNear`). Else it is attached to the first of `under`
 * that it can attach to (see `attachableUnder`), at its anchor nearest `at` in anchor mode or at its centre in centre
 * mode (or when it has no anchors); else free at `at`.
 */
export function endAt(
  doc: Document,
  registries: Registries,
  page: string,
  at: Pt,
  under: readonly NodeId[],
  mode: SnapMode,
  exclude?: NodeId,
  reach = 0,
  unreadable?: ReadonlySet<NodeId>,
): End {
  const near = attachableNear(doc, registries, page, at, mode, reach, exclude, unreadable);
  if (near) {
    return near.anchor ? { kind: "attached", node: near.id, snap: "anchor", anchor: near.anchor.id } : { kind: "attached", node: near.id, snap: "center" };
  }
  const found = attachableUnder(doc, registries, page, under, exclude, unreadable);
  if (!found) return { kind: "free", x: at.x, y: at.y };
  const { anchors } = found.target;
  if (mode === "center" || anchors.length === 0) return { kind: "attached", node: found.id, snap: "center" };
  return { kind: "attached", node: found.id, snap: "anchor", anchor: nearestAnchor(anchors, at).id };
}

/** The anchor of `anchors` (at least one) nearest `at`; the first of those as near as it. */
export function nearestAnchor(anchors: readonly Anchor[], at: Pt): Anchor {
  const away = (p: Pt): number => (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
  return anchors.reduce((best, a) => (away(a) < away(best) ? a : best));
}

/**
 * What is wrong with `end` as an end of a connector on `page`, or null when nothing is: a free end is fine, and an
 * attached one must be attached to a node of `doc` on that page whose type can be attached to. Which anchor it names is
 * the connector normaliser's to settle. The message follows the end's name: `is attached to "a", which is …`.
 */
export function endError(doc: Document, registries: Registries, end: End, page: string, unreadable?: ReadonlySet<NodeId>): string | null {
  if (end.kind === "free") return null;
  const target = doc.nodes.find((n) => n.id === end.node);
  if (!target) return `is attached to "${end.node}", which is not a node of the figure`;
  if (!attachTarget(doc, registries, end.node, unreadable)) return `cannot attach to "${end.node}" (a ${target.type})`;
  if (target.page !== page) return `is attached to "${end.node}", which is on another page`;
  return null;
}

/**
 * The points worth showing while a connector's end is at `at` over `under` (topmost first), of the item `endAt` would
 * attach it to: its anchors in anchor mode, its centre in centre mode (or when it has no anchors), and none when it
 * would be free. So the marks stay on while the end is within `reach` of an anchor's dot, off the item's body.
 */
export function snapMarks(
  doc: Document,
  registries: Registries,
  page: string,
  at: Pt,
  under: readonly NodeId[],
  mode: SnapMode,
  exclude?: NodeId,
  reach = 0,
  unreadable?: ReadonlySet<NodeId>,
): Pt[] {
  const found = attachableNear(doc, registries, page, at, mode, reach, exclude, unreadable) ?? attachableUnder(doc, registries, page, under, exclude, unreadable);
  if (!found) return [];
  const { anchors, center } = found.target;
  return mode === "center" || anchors.length === 0 ? [center] : anchors.map((a) => ({ x: a.x, y: a.y }));
}
