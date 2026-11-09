import type { Document, Node } from "./types";

/**
 * A node as messages (export reports and warnings) name it: by its `name` when it has one, else by its id, quoted,
 * followed by its page's name (left out when the node's page is not in the document). The name or id is what the
 * layers and the inspector show, so a line can be matched to its item, and two panels of one file are told apart.
 */
export function nodeLabel(doc: Document, node: Node): string {
  const page = doc.pages.find((p) => p.id === node.page);
  const where = page ? ` (${page.name})` : "";
  const name = typeof node.name === "string" && node.name.trim() !== "" ? node.name : node.id;
  return `${JSON.stringify(name)}${where}`;
}
