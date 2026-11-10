import type { Node } from "../model/types";
import { joinLinktext, splitLinktext } from "./links-section";

/**
 * How a node type keeps a link (`NodeType.linkField`): its target lives in the figure file's Links section, not in the
 * JSON, so Obsidian keeps it up to date when the target is renamed. `always`: every node of the type has a link, an
 * empty one when it has no entry (a file panel); otherwise only a node that has a `file` is linked, and one without an
 * entry has no link (a card: a note card is linked, a text card is not). Either way the link is the node's `file` and
 * `subpath`.
 */
export interface LinkField {
  always: boolean;
}

/**
 * The types that keep a link, by type id: fed by `NodeTypeRegistry.register` from each type's `linkField`, so the file
 * format (`serializeFigureFile`, `loadDocument`) needs no registries. The built-in kinds are known from the start (a
 * figure written before its types are registered, or headless): a file panel's link has been in the Links section since
 * the first format version, and a note card's since cards exist. Their types declare the same `linkField`.
 */
const linkedTypes = new Map<string, LinkField>([
  ["file", { always: true }],
  ["card", { always: false }],
]);

/** Whether nodes of `type` keep their link in the Links section (a type registered with `linkField`, or a built-in). */
export function isLinkedType(type: string): boolean {
  return linkedTypes.has(type);
}

/**
 * Records how nodes of `type` keep their link (`NodeType.linkField`). A type registered without one changes nothing:
 * where a node's link is written is part of the file format, so it is never taken back once known (a stand-in "file"
 * type in a test, say, leaves file panels' links where they are).
 */
export function registerLinkedType(type: string, field: LinkField | undefined): void {
  if (field) linkedTypes.set(type, field);
}

/** The link a node has, for its Links entry; null for a node that has none (not of a linked type, or a text card). */
export function linkOf(node: Node): { file: string; subpath: string } | null {
  const kind = linkedTypes.get(node.type);
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
  if (!linkedTypes.has(node.type)) return node;
  const { file: _file, subpath: _subpath, ...onDisk } = node as Node & { file?: unknown; subpath?: unknown };
  return onDisk as Node;
}

/**
 * The node given the link `linktext` (its Links entry; undefined when it has none), when its type keeps its link in the
 * Links section; any other node as it is. A file panel without an entry gets an empty link. A card without an entry (or
 * with an empty one) has no `file` or `subpath`; with one it gets the `file`, and the `subpath` only when there is one.
 */
export function withLink(node: Node, linktext: string | undefined): Node {
  const kind = linkedTypes.get(node.type);
  if (!kind) return node;
  if (kind.always) return { ...node, ...splitLinktext(linktext ?? "") } as Node;
  const bare = withoutLink(node);
  if (linktext === undefined || linktext === "") return bare;
  const { file, subpath } = splitLinktext(linktext);
  return (subpath === "" ? { ...bare, file } : { ...bare, file, subpath }) as Node;
}
