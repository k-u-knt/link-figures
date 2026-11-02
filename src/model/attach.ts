import type { Document, End, Node, NodeId } from "./types";
import type { Pt, Rect } from "./geometry";
import { rectPath, transformPath, type Matrix, type PathData } from "./path";
import type { Registries } from "../registry";
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
}

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
 * `null` when there is no such node, or its type does not implement `attachable` (a connector, or a type that is not
 * registered).
 */
export function attachTarget(doc: Document, registries: Registries, id: NodeId): AttachTarget | null {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return null;
  const type = registries.nodeTypes.get(node.type);
  if (!type?.attachable) return null;
  return { ...type.attachable(node, { registries }), center: centerOf(node) };
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
): { id: NodeId; target: AttachTarget } | null {
  for (const id of under) {
    if (id === exclude || doc.nodes.find((n) => n.id === id)?.page !== page) continue;
    const target = attachTarget(doc, registries, id);
    if (target) return { id, target };
  }
  return null;
}

/**
 * The end a connector on `page` gets for a point `at` (page px) with `under` the items there, topmost first: attached
 * to the first of them that it can attach to (see `attachableUnder`), at its anchor nearest `at` in anchor mode or at its
 * centre in centre mode (or when it has no anchors); else free at `at`.
 */
export function endAt(doc: Document, registries: Registries, page: string, at: Pt, under: readonly NodeId[], mode: SnapMode, exclude?: NodeId): End {
  const found = attachableUnder(doc, registries, page, under, exclude);
  if (!found) return { kind: "free", x: at.x, y: at.y };
  const { anchors } = found.target;
  if (mode === "center" || anchors.length === 0) return { kind: "attached", node: found.id, snap: "center" };
  const away = (p: Pt): number => Math.hypot(p.x - at.x, p.y - at.y);
  const nearest = anchors.reduce((best, a) => (away(a) < away(best) ? a : best));
  return { kind: "attached", node: found.id, snap: "anchor", anchor: nearest.id };
}

/**
 * The points worth showing while a connector's end is over `under` (topmost first): the anchors of the item it would
 * attach to in anchor mode, its centre in centre mode (or when it has no anchors), and none over nothing it can attach to.
 */
export function snapMarks(doc: Document, registries: Registries, page: string, under: readonly NodeId[], mode: SnapMode, exclude?: NodeId): Pt[] {
  const found = attachableUnder(doc, registries, page, under, exclude);
  if (!found) return [];
  const { anchors, center } = found.target;
  return mode === "center" || anchors.length === 0 ? [center] : anchors.map((a) => ({ x: a.x, y: a.y }));
}
