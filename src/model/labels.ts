import type { Document, Node } from "./types";

/** Words of a text node's content that its label quotes. */
const LABEL_WORDS = 4;

/**
 * A node as a person would name it, for messages: a panel by its file's name, a text node by its first words, a shape
 * by its kind, a connector or a group as such, a node of another type by its type, each followed by its page's name (left out when the node's page is not in the document).
 */
export function nodeLabel(doc: Document, node: Node): string {
  const page = doc.pages.find((p) => p.id === node.page);
  const where = page ? ` (${page.name})` : "";
  if (node.type === "file") {
    const name = node.file.split("/").pop() ?? "";
    return name === "" ? `Panel (no link)${where}` : `Panel "${name}"${where}`;
  }
  if (node.type === "shape") return `Shape "${node.kind}"${where}`;
  if (node.type === "connector") return `Connector${where}`;
  if (node.type === "group") return `Group${where}`;
  // A node of a type another plugin registered has no text to quote: it is named by its type.
  if (node.type !== "text" || typeof node.text !== "string") return `Item "${(node as { type: string }).type}"${where}`;
  const words = node.text.split(/\s+/).filter((w) => w !== "");
  const quoted = words.slice(0, LABEL_WORDS).join(" ") + (words.length > LABEL_WORDS ? "…" : "");
  return `Text "${quoted}"${where}`;
}
