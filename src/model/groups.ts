import { current, isDraft } from "immer";
import type { Registries } from "../registry";
import { nodeSizePx, roundPx } from "../view/pointer-math";
import type { Pt } from "./geometry";
import type { Document, Node, NodeId } from "./types";

/**
 * Containment: a node's `parent` names the group it is a member of. Code that acts on whole units (a group with all its
 * members) goes through these helpers, and asks whether a node contains others with `isGroup`, never by its type. Each
 * walk up the parents stops at a node it has already seen, so a document whose parents form a cycle (before the group
 * normaliser has broken it) cannot hang them.
 */

/** The group node `id` is a member of, or null at top level (and for no such node). */
export function parentOf(doc: Document, id: NodeId): NodeId | null {
  return doc.nodes.find((n) => n.id === id)?.parent ?? null;
}

/** The direct members of `id`, in z order (nodes with the same `z` in document order). */
export function childrenOf(doc: Document, id: NodeId): NodeId[] {
  // `sort` is stable, so nodes with the same `z` keep the document's order.
  return doc.nodes
    .filter((n) => n.parent === id)
    .sort((a, b) => a.z - b.z)
    .map((n) => n.id);
}

/** Every member of `id`, its members' members and so on, groups included; `id` itself is not. */
export function descendantsOf(doc: Document, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>([id]);
  const visit = (parent: NodeId) => {
    for (const child of childrenOf(doc, parent)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      visit(child);
    }
  };
  visit(id);
  return out;
}

/** Whether node `id`'s type contains other nodes (has a `members` hook): a group, or any later kind of container. */
export function isGroup(doc: Document, id: NodeId, registries: Pick<Registries, "nodeTypes">): boolean {
  const node = doc.nodes.find((n) => n.id === id);
  return node !== undefined && registries.nodeTypes.get(node.type)?.members !== undefined;
}

/** `id` and its ancestors, nearest first, stopping at a missing node or at one already seen. */
function lineage(doc: Document, id: NodeId): NodeId[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const out: NodeId[] = [];
  let node = byId.get(id);
  while (node && !out.includes(node.id)) {
    out.push(node.id);
    node = node.parent === undefined ? undefined : byId.get(node.parent);
  }
  return out;
}

/** Whether node `id` is effectively locked: it or any group it is in (at any depth) is locked. */
export function isLocked(doc: Document, id: NodeId): boolean {
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  return lineage(doc, id).some((ancestor) => byId.get(ancestor)?.locked === true);
}

/**
 * The unit node `id` is acted on as: its top-level ancestor, or, when group `within` is entered, its ancestor that is a
 * direct member of `within`. A node that is not inside `within` is taken to its top-level ancestor; `within` itself is
 * its own unit (it stays what it is, not the group it is in).
 */
export function outermostUnit(doc: Document, id: NodeId, within: NodeId | null): NodeId {
  if (id === within) return id;
  const line = lineage(doc, id);
  if (line.length === 0) return id;
  const at = within === null ? -1 : line.indexOf(within);
  return at > 0 ? line[at - 1] : line[line.length - 1];
}

/** `ids` and all their descendants, each once, in document order; ids of no node are left out. */
export function expandUnits(doc: Document, ids: readonly NodeId[]): NodeId[] {
  const wanted = new Set<NodeId>();
  for (const id of ids) {
    wanted.add(id);
    for (const d of descendantsOf(doc, id)) wanted.add(d);
  }
  return doc.nodes.filter((n) => wanted.has(n.id)).map((n) => n.id);
}

/** The outermost unit (see `outermostUnit`) of each of `ids`, each once, in the order `ids` first reach it. */
export function unitsOf(doc: Document, ids: readonly NodeId[], within: NodeId | null): NodeId[] {
  return [...new Set(ids.map((id) => outermostUnit(doc, id, within)))];
}

/** `id`'s ancestors, nearest first (not `id` itself); stops at one already seen, so a cyclic parent chain ends. */
export function ancestorsOf(doc: Document, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  let at = parentOf(doc, id);
  while (at !== null && !out.includes(at) && at !== id) {
    out.push(at);
    at = parentOf(doc, at);
  }
  return out;
}

/** The deepest group that every one of `ids` is inside (at any depth), or null when they share none. */
export function commonParent(doc: Document, ids: readonly NodeId[]): NodeId | null {
  if (ids.length === 0) return null;
  const [first, ...rest] = ids.map((id) => ancestorsOf(doc, id));
  return first.find((a) => rest.every((list) => list.includes(a))) ?? null;
}

/**
 * Scales the units `ids` (each with all its descendants) of `draft` by (`sx`, `sy`) about `origin` (page px), in place:
 * what resizing a group does to its members. Each node is scaled by its type's `scale` hook, else by the default: the
 * offset of its top-left from `origin` and its size are scaled, rounded as `roundPx` rounds and kept to `nodeSizePx`;
 * nothing else (text size, stroke width, corner radius) changes. A container's own box is left to the group normaliser,
 * which derives it from its members. Only fields that change are written.
 */
export function scaleUnits(draft: Document, ids: readonly NodeId[], sx: number, sy: number, origin: Pt, registries: Registries): void {
  const doc: Document = isDraft(draft) ? current(draft) : structuredClone(draft);
  const wanted = new Set(expandUnits(doc, ids));
  const ctx = { registries, doc };
  for (const target of draft.nodes) {
    if (!wanted.has(target.id)) continue;
    const node = doc.nodes.find((n) => n.id === target.id) as Node;
    const type = registries.nodeTypes.get(node.type);
    let next: Record<string, unknown>;
    if (type?.scale) next = type.scale(node, sx, sy, origin, ctx) as Record<string, unknown>;
    else if (type?.members) continue;
    else {
      next = {
        x: roundPx(origin.x + (node.x - origin.x) * sx),
        y: roundPx(origin.y + (node.y - origin.y) * sy),
        width: nodeSizePx(roundPx(node.width * sx)),
        height: nodeSizePx(roundPx(node.height * sy)),
      };
    }
    const before = node as unknown as Record<string, unknown>;
    const out = target as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(next)) if (value !== before[key]) out[key] = value;
  }
}
