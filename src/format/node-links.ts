import type { Node } from "../model/types";
import { joinLinktext, splitLinktext } from "./links-section";

/**
 * The built-in node types whose link target lives in the figure file's Links section, not in the JSON, so Obsidian
 * keeps it up to date when the target is renamed. `always`: every node of the type has a link, an empty one when it has
 * no entry (a file panel); otherwise only a node that has a `file` is linked, and one without an entry has no link (a
 * card: a note card is linked, a text card is not). Either way the link is the node's `file` and `subpath`.
 */
const LINKED_TYPES: Record<string, { always: boolean }> = {
  file: { always: true },
  card: { always: false },
};

/** The link a node has, for its Links entry; null for a node that has none (not of a linked type, or a text card). */
export function linkOf(node: Node): { file: string; subpath: string } | null {
  const kind = LINKED_TYPES[node.type];
  if (!kind) return null;
  const { file, subpath } = node as { file?: unknown; subpath?: unknown };
  if (typeof file !== "string") return kind.always ? { file: "", subpath: "" } : null;
  return { file, subpath: typeof subpath === "string" ? subpath : "" };
}

/** The node's linktext (`file` + `subpath`), or "" for one that has no link. */
export function linktextOf(node: Node): string {
  const link = linkOf(node);
  return link ? joinLinktext(link.file, link.subpath) : "";
}

/** The node as the JSON holds it: without `file` and `subpath` when its type keeps its link in the Links section. */
export function withoutLink(node: Node): Node {
  if (!LINKED_TYPES[node.type]) return node;
  const { file: _file, subpath: _subpath, ...onDisk } = node as Node & { file?: unknown; subpath?: unknown };
  return onDisk as Node;
}

/**
 * The node given the link `linktext` (its Links entry; undefined when it has none), when its type keeps its link in the
 * Links section; any other node as it is. A file panel without an entry gets an empty link. A card without an entry (or
 * with an empty one) has no `file` or `subpath`; with one it gets the `file`, and the `subpath` only when there is one.
 */
export function withLink(node: Node, linktext: string | undefined): Node {
  const kind = LINKED_TYPES[node.type];
  if (!kind) return node;
  if (kind.always) return { ...node, ...splitLinktext(linktext ?? "") } as Node;
  const bare = withoutLink(node);
  if (linktext === undefined || linktext === "") return bare;
  const { file, subpath } = splitLinktext(linktext);
  return (subpath === "" ? { ...bare, file } : { ...bare, file, subpath }) as Node;
}
