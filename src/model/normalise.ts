import { current, isDraft } from "immer";
import { isConnector, resolveConnector } from "../connectors/geometry";
import type { Registries } from "../registry";
import { attachTarget, nearestAnchor } from "./attach";
import { pageOriginsPx, type Pt } from "./geometry";
import { DocumentStore } from "./store";
import type { ConnectorNode, Document, End, Node, NodeId, PageId } from "./types";

/**
 * A rule that keeps derived parts of a document consistent with the rest. The store runs every normaliser on the draft
 * of each commit, after the commit's own recipe and inside the same `produce`, so what a normaliser changes is part of
 * the commit's patches and undo restores it exactly. A normaliser must change nothing when the document is already
 * consistent, so a commit it has nothing to say about stays as small as the recipe made it. `before` is the document
 * as it was before the edit being normalised: the committed document for a commit, the draft as the previous call left
 * it for one call of a batch, and the document itself for a load.
 */
export type Normaliser = (draft: Document, before: Document) => void;

/**
 * A store for a figure with every normaliser a figure has: the one way a store for a figure is made, by the view and by
 * the API's headless calls alike, so the two cannot keep a document differently. `now` is the store's clock.
 */
export function createFigureStore(doc: Document, registries: Registries, now?: () => number): DocumentStore {
  const store = new DocumentStore(doc, now);
  // Every connector is kept in step with its items in each commit, and the document is brought in line now.
  store.addNormaliser(connectorNormaliser(registries));
  // After the connectors, so a group whose member is a connector takes in the connector's box as it now is.
  store.addNormaliser(groupNormaliser(registries));
  return store;
}

/**
 * Keeps every connector in step with what its ends are attached to:
 * - an attached end whose item is gone, is on another page, or cannot be attached to (a connector) becomes a free end
 *   at its last resolved point: where it was in the document before this commit, when it was drawn there, else where
 *   the connector resolves it now;
 * - an end snapped to an anchor whose id its item does not have (the snap was just switched to anchor) takes the item's
 *   anchor nearest to where the end is drawn; an end snapped to the centre keeps no anchor id;
 * - the box (`x, y, width, height`) is the drawn area (`resolveConnector(…).bounds`) and `rotation` is 0.
 * Connectors never attach to connectors, so the order they are visited in does not matter.
 */
export function connectorNormaliser(registries: Registries): Normaliser {
  return (draft, before) => {
    if (!draft.nodes.some(isConnector)) return;
    // Resolving reads the whole document, so it reads plain snapshots rather than the draft's proxies.
    let now: Document = isDraft(draft) ? current(draft) : draft;
    for (const node of draft.nodes) {
      if (!isConnector(node)) continue;
      const snapshot = now.nodes.find((n) => n.id === node.id) as ConnectorNode;
      if (keptAsItWas(before, now, snapshot, registries)) continue;
      const resolved = resolveConnector(now, snapshot, registries);
      let ends: [End, End] = snapshot.ends;
      for (const i of [0, 1] as const) {
        const end = ends[i];
        if (end.kind !== "attached") continue;
        if (resolved.detached[i]) {
          const pt = lastPoint(before, snapshot, i, registries) ?? resolved.ends[i].pt;
          ends = withEnd(ends, i, { kind: "free", x: pt.x, y: pt.y });
        } else if (end.snap === "anchor") {
          const target = attachTarget(now, registries, end.node);
          // An item attached to as its box (see `AttachTarget.fallback`) does not know its own anchors: the id stays.
          const anchors = target && !target.fallback ? target.anchors : [];
          if (anchors.length > 0 && !anchors.some((a) => a.id === end.anchor)) {
            ends = withEnd(ends, i, { kind: "attached", node: end.node, snap: "anchor", anchor: nearestAnchor(anchors, resolved.ends[i].pt).id });
          }
        } else if ("anchor" in end) {
          ends = withEnd(ends, i, { kind: "attached", node: end.node, snap: "center" });
        }
      }
      if (ends !== snapshot.ends) {
        node.ends = ends;
        now = isDraft(draft) ? current(draft) : draft;
      }
      const { bounds } = ends === snapshot.ends ? resolved : resolveConnector(now, now.nodes.find((n) => n.id === node.id) as ConnectorNode, registries);
      if (node.x !== bounds.x) node.x = bounds.x;
      if (node.y !== bounds.y) node.y = bounds.y;
      if (node.width !== bounds.width) node.width = bounds.width;
      if (node.height !== bounds.height) node.height = bounds.height;
      if (node.rotation !== 0) node.rotation = 0;
    }
  };
}

/**
 * Whether connector `c` is left exactly as it is: when an end of it is attached to an item that is attached to as its
 * box (foreign, unreadable, or with a failing hook: `AttachTarget.fallback`), and neither it nor any item it is
 * attached to has changed since `before`. Its box and anchors were worked out by the item's own plugin, which the box
 * cannot redo, so an edit elsewhere leaves the file as it was.
 */
function keptAsItWas(before: Document, now: Document, c: ConnectorNode, registries: Registries): boolean {
  const attached = c.ends.flatMap((end) => (end.kind === "attached" ? [end.node] : []));
  if (!attached.some((id) => attachTarget(now, registries, id)?.fallback)) return false;
  const same = (id: NodeId): boolean => {
    const was = before.nodes.find((n) => n.id === id);
    const is = now.nodes.find((n) => n.id === id);
    return was !== undefined && is !== undefined && (was === is || JSON.stringify(was) === JSON.stringify(is));
  };
  return same(c.id) && attached.every(same);
}

/** `ends` with end `i` replaced: a new pair, so the caller can tell that something changed. */
function withEnd(ends: [End, End], i: 0 | 1, end: End): [End, End] {
  return i === 0 ? [end, ends[1]] : [ends[0], end];
}

/**
 * Where end `i` of `c` was drawn in `before` (the document as it was before this edit), when the connector was there
 * with that end attached to the same item and the item was there to resolve it; otherwise null. A connector that has
 * changed page since gets the point in its new page's pixels, at the same place on the canvas.
 */
function lastPoint(before: Document, c: ConnectorNode, i: 0 | 1, registries: Registries): Pt | null {
  const was = before.nodes.find((n) => n.id === c.id);
  if (!was || !isConnector(was)) return null;
  const end = was.ends[i];
  const now = c.ends[i];
  if (end.kind !== "attached" || now.kind !== "attached" || end.node !== now.node) return null;
  const resolved = resolveConnector(before, was, registries);
  if (resolved.detached[i]) return null;
  const pt = resolved.ends[i].pt;
  if (was.page === c.page) return pt;
  // The connector has changed page in this edit: the point keeps its place on the canvas, in its new page's pixels.
  const origins = pageOriginsPx(before);
  const from = origins.get(was.page);
  const to = origins.get(c.page);
  return from && to ? { x: pt.x + from.x - to.x, y: pt.y + from.y - to.y } : pt;
}

/**
 * Keeps containment consistent (spec §3.1). A group here is any node whose type has a `members` hook; its members are
 * the nodes whose `parent` is its id.
 * - a `parent` that names no node, the node itself, or a node that is not a group is removed;
 * - a cycle of parents is broken by removing one `parent` in it: one this edit changed (compared with `before`), else
 *   the last one met walking up from the node first in the document;
 * - a group with no members is deleted, and one with a single member is dissolved (the member takes the group's
 *   `parent`, and its lock when the group was locked), until every group has two members or more;
 * - a group's page is the page of its first member by z, and each node in it (at any depth) goes to its outermost
 *   group's page, keeping its coordinates; when that takes a node to another page, the connector rules
 *   (`connectorNormaliser`) are applied again in the same commit, so a connector attached to it from its old page is
 *   freed there and then;
 * - a group's box is the union of its members' unrotated boxes, its `z` the highest member's, its rotation 0 and its
 *   opacity 1. Nested groups are worked out first, so a group's box takes in its member groups' boxes as they now are.
 * A document without parents or groups is left alone, and a value is written only when it differs.
 */
export function groupNormaliser(registries: Registries): Normaliser {
  const once = groupPass(registries);
  const connectors = connectorNormaliser(registries);
  return (draft, before) => {
    // A member this pass took to its group's page may have a connector attached to it from its old page; the connector
    // rule (an end attached to an item on another page is freed) is applied again at once, in this same commit, and the
    // boxes are then worked out again from the connectors as they now are.
    if (once(draft, before)) {
      connectors(draft, before);
      once(draft, before);
    }
  };
}

/** One pass of `groupNormaliser`; true when it took a node to another page. */
function groupPass(registries: Registries): (draft: Document, before: Document) => boolean {
  const isGroupNode = (n: Node) => registries.nodeTypes.get(n.type)?.members !== undefined;
  return (draft, before) => {
    if (!draft.nodes.some((n) => n.parent !== undefined || isGroupNode(n))) return false;
    let paged = false;

    let byId = new Map(draft.nodes.map((n) => [n.id, n] as const));
    for (const node of draft.nodes) {
      if (node.parent === undefined) continue;
      const parent = byId.get(node.parent);
      if (!parent || parent === node || !isGroupNode(parent)) delete node.parent;
    }
    breakCycles(draft.nodes, byId, before);

    // Deleting or dissolving a group can leave its own group with fewer members, so this goes on until none is left.
    for (;;) {
      const members = membersByGroup(draft.nodes);
      const index = draft.nodes.findIndex((n) => isGroupNode(n) && (members.get(n.id)?.length ?? 0) < 2);
      if (index < 0) break;
      const group = draft.nodes[index];
      const list = members.get(group.id) ?? [];
      for (const member of list) {
        if (group.parent === undefined) delete member.parent;
        else member.parent = group.parent;
        // A locked group's lock stays with what is left of it, so dissolving it frees nothing that was locked.
        if (group.locked && !member.locked) member.locked = true;
      }
      draft.nodes.splice(index, 1);
    }
    byId = new Map(draft.nodes.map((n) => [n.id, n] as const));

    const members = membersByGroup(draft.nodes);
    const derived = new Map<NodeId, { page: PageId; z: number; x: number; y: number; right: number; bottom: number }>();
    const derive = (group: Node): void => {
      const list = members.get(group.id) ?? [];
      for (const m of list) if (isGroupNode(m)) derive(m);
      const zOf = (m: Node) => derived.get(m.id)?.z ?? m.z;
      // `sort` is stable, so members with the same `z` keep the document's order.
      const first = [...list].sort((a, b) => zOf(a) - zOf(b))[0];
      const box = { page: derived.get(first.id)?.page ?? first.page, z: -Infinity, x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity };
      for (const m of list) {
        const d = derived.get(m.id);
        box.z = Math.max(box.z, zOf(m));
        box.x = Math.min(box.x, d ? d.x : m.x);
        box.y = Math.min(box.y, d ? d.y : m.y);
        box.right = Math.max(box.right, d ? d.right : m.x + m.width);
        box.bottom = Math.max(box.bottom, d ? d.bottom : m.y + m.height);
      }
      derived.set(group.id, box);
    };
    const toPage = (id: NodeId, page: PageId): void => {
      for (const m of members.get(id) ?? []) {
        if (m.page !== page) {
          m.page = page;
          paged = true;
        }
        toPage(m.id, page);
      }
    };
    for (const group of draft.nodes) {
      if (group.parent !== undefined || !isGroupNode(group)) continue;
      derive(group);
      toPage(group.id, (derived.get(group.id) as { page: PageId }).page);
    }
    for (const [id, d] of derived) {
      const group = byId.get(id) as Node;
      const width = d.right - d.x;
      const height = d.bottom - d.y;
      if (group.page !== d.page && group.parent === undefined) group.page = d.page;
      if (group.x !== d.x) group.x = d.x;
      if (group.y !== d.y) group.y = d.y;
      if (group.width !== width) group.width = width;
      if (group.height !== height) group.height = height;
      if (group.z !== d.z) group.z = d.z;
      if (group.rotation !== 0) group.rotation = 0;
      if (group.opacity !== 1) group.opacity = 1;
    }
    return paged;
  };
}

/** Each group's members, by the group's id, in document order. */
function membersByGroup(nodes: Node[]): Map<NodeId, Node[]> {
  const out = new Map<NodeId, Node[]>();
  for (const node of nodes) {
    if (node.parent === undefined) continue;
    const list = out.get(node.parent);
    if (list) list.push(node);
    else out.set(node.parent, [node]);
  }
  return out;
}

/**
 * Removes one `parent` from each cycle of parents (every `parent` must name a node of `byId`). The one removed is one
 * this edit changed, compared with `before`, so the edit that closed the cycle is the one undone; when none was (a
 * loaded file), it is the last one met walking up from the node first in the document.
 */
function breakCycles(nodes: Node[], byId: Map<NodeId, Node>, before: Document): void {
  const was = new Map(before.nodes.map((n) => [n.id, n.parent] as const));
  // Nodes whose walk up is known to end at a node at top level.
  const settled = new Set<NodeId>();
  for (const start of nodes) {
    const path: Node[] = [];
    let node: Node | undefined = start;
    while (node && !settled.has(node.id)) {
      const at = path.indexOf(node);
      if (at >= 0) {
        const cycle = path.slice(at);
        const offending = cycle.find((n) => n.parent !== was.get(n.id)) ?? cycle[cycle.length - 1];
        delete offending.parent;
        break;
      }
      path.push(node);
      node = node.parent === undefined ? undefined : byId.get(node.parent);
    }
    // Every node met now ends at the top: the walk did, or it ran into the cycle, whose broken link is now the top.
    for (const n of path) settled.add(n.id);
  }
}
