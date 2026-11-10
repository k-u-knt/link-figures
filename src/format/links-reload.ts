import type { Document, Node, NodeId } from "../model/types";
import type { LinkEntry } from "./links-section";
import { linktextOf, withLink } from "./node-links";
import type { ParsedFigureFile } from "./parse";
import { serializeFigureFile } from "./serialize";

/** A figure file as `loadDocument` reads it. */
export interface LoadedFigure {
  doc: Document;
  parsed: ParsedFigureFile;
}

/**
 * `doc` with the link of every linked node (a file panel, a note card: see `node-links.ts`) set from `entries`, the Links section of a figure file, and the ids of the
 * nodes whose link that changed. A node without an entry ends up with an empty link, as it does when a file is loaded.
 * Nodes that did not change are kept as the same objects; when none did, so is the document.
 */
export function applyLinkEntries(doc: Document, entries: LinkEntry[]): { doc: Document; changedIds: NodeId[] } {
  const linktexts = new Map(entries.map((e) => [e.id, e.linktext]));
  const changedIds: NodeId[] = [];
  const nodes = doc.nodes.map((node) => {
    const next = withLink(node, linktexts.get(node.id));
    if (next === node || linktextOf(next) === linktextOf(node)) return node;
    changedIds.push(node.id);
    return next;
  });
  return changedIds.length === 0 ? { doc, changedIds } : { doc: { ...doc, nodes }, changedIds };
}

/**
 * `doc` with each node of `type` that has an entry in `entries` given that link (`withLink`), and the ids of those whose
 * link changed: for a type that keeps its link in the Links section (`NodeType.linkField`) registered after the figure
 * was loaded, whose nodes were read without their links. A node of the type without an entry is left as it is, so a
 * `file` key it was read with (the type kept none in the Links section then) is not lost. Nodes that did not change
 * are kept as the same objects; when none did, so is the document.
 */
export function applyLinkEntriesOfType(doc: Document, entries: LinkEntry[], type: string): { doc: Document; changedIds: NodeId[] } {
  const linktexts = new Map(entries.map((e) => [e.id, e.linktext]));
  const changedIds: NodeId[] = [];
  const nodes = doc.nodes.map((node) => {
    if (node.type !== type || !linktexts.has(node.id)) return node;
    const next = withLink(node, linktexts.get(node.id));
    if (next === node || linktextOf(next) === linktextOf(node)) return node;
    changedIds.push(node.id);
    return next;
  });
  return changedIds.length === 0 ? { doc, changedIds } : { doc: { ...doc, nodes }, changedIds };
}

/**
 * What a figure file that has just been read amounts to, compared with the figure that is open:
 * `same` for no difference, `links` when the link targets of linked nodes (file panels, note cards) are the only difference (what Obsidian does to
 * the Links section when a source is renamed), `other` for anything else. Both sides are compared as the plugin would
 * write them, so the formatting the file happens to have, the order of the Links entries and their block ids do not count.
 */
export function classifyReload(current: LoadedFigure, next: LoadedFigure): "same" | "links" | "other" {
  const written = serializeFigureFile(current.doc, current.parsed);
  if (serializeFigureFile(next.doc, next.parsed) === written) return "same";

  const own = new Map<NodeId, Node>(current.doc.nodes.map((node) => [node.id, node]));
  // The new figure with this one's links: it is the same figure again exactly when nothing but the links differed.
  const neutral: Document = {
    ...next.doc,
    nodes: next.doc.nodes.map((node) => {
      const mine = own.get(node.id);
      return mine && mine.type === node.type ? withLink(node, linktextOf(mine)) : node;
    }),
  };
  return serializeFigureFile(neutral, next.parsed) === written ? "links" : "other";
}
