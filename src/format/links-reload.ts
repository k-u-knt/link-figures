import type { Document, NodeId } from "../model/types";
import { splitLinktext, type LinkEntry } from "./links-section";
import type { ParsedFigureFile } from "./parse";
import { serializeFigureFile } from "./serialize";

/** A figure file as `loadDocument` reads it. */
export interface LoadedFigure {
  doc: Document;
  parsed: ParsedFigureFile;
}

/**
 * `doc` with the link of every file node set from `entries`, the Links section of a figure file, and the ids of the
 * nodes whose link that changed. A node without an entry ends up with an empty link, as it does when a file is loaded.
 * Nodes that did not change are kept as the same objects; when none did, so is the document.
 */
export function applyLinkEntries(doc: Document, entries: LinkEntry[]): { doc: Document; changedIds: NodeId[] } {
  const linktexts = new Map(entries.map((e) => [e.id, e.linktext]));
  const changedIds: NodeId[] = [];
  const nodes = doc.nodes.map((node) => {
    if (node.type !== "file") return node;
    const link = splitLinktext(linktexts.get(node.id) ?? "");
    if (link.file === node.file && link.subpath === node.subpath) return node;
    changedIds.push(node.id);
    return { ...node, ...link };
  });
  return changedIds.length === 0 ? { doc, changedIds } : { doc: { ...doc, nodes }, changedIds };
}

/**
 * What a figure file that has just been read amounts to, compared with the figure that is open:
 * `same` for no difference, `links` when the link targets of file nodes are the only difference (what Obsidian does to
 * the Links section when a source is renamed), `other` for anything else. Both sides are compared as the plugin would
 * write them, so the formatting the file happens to have, the order of the Links entries and their block ids do not count.
 */
export function classifyReload(current: LoadedFigure, next: LoadedFigure): "same" | "links" | "other" {
  const written = serializeFigureFile(current.doc, current.parsed);
  if (serializeFigureFile(next.doc, next.parsed) === written) return "same";

  const own = new Map<NodeId, { file: string; subpath: string }>();
  for (const node of current.doc.nodes) if (node.type === "file") own.set(node.id, node);
  // The new figure with this one's links: it is the same figure again exactly when nothing but the links differed.
  const neutral: Document = {
    ...next.doc,
    nodes: next.doc.nodes.map((node) => {
      const link = node.type === "file" ? own.get(node.id) : undefined;
      return node.type === "file" && link ? { ...node, file: link.file, subpath: link.subpath } : node;
    }),
  };
  return serializeFigureFile(neutral, next.parsed) === written ? "links" : "other";
}
