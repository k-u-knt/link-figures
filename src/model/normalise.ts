import { current, isDraft } from "immer";
import { resolveConnector } from "../connectors/geometry";
import type { Registries } from "../registry";
import { attachTarget } from "./attach";
import { pageOriginsPx, type Pt } from "./geometry";
import { DocumentStore } from "./store";
import type { ConnectorNode, Document, End } from "./types";

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
  return store;
}

const isConnector = (n: { type: string }): n is ConnectorNode => n.type === "connector";

const squaredDistance = (a: Pt, b: Pt): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

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
      const resolved = resolveConnector(now, snapshot, registries);
      let ends: [End, End] = snapshot.ends;
      for (const i of [0, 1] as const) {
        const end = ends[i];
        if (end.kind !== "attached") continue;
        if (resolved.detached[i]) {
          const pt = lastPoint(before, snapshot, i, registries) ?? resolved.ends[i].pt;
          ends = withEnd(ends, i, { kind: "free", x: pt.x, y: pt.y });
        } else if (end.snap === "anchor") {
          const anchors = attachTarget(now, registries, end.node)?.anchors ?? [];
          if (anchors.length > 0 && !anchors.some((a) => a.id === end.anchor)) {
            const at = resolved.ends[i].pt;
            const nearest = anchors.reduce((a, b) => (squaredDistance(b, at) < squaredDistance(a, at) ? b : a));
            ends = withEnd(ends, i, { kind: "attached", node: end.node, snap: "anchor", anchor: nearest.id });
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
