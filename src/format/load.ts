import { createDocument } from "../model/defaults";
import type { Document } from "../model/types";
import { FormatError } from "./errors";
import { splitLinktext } from "./links-section";
import { migrate } from "./migrate";
import { parseFigureFile, type ParsedFigureFile } from "./parse";

/**
 * Parses a figure file into a document. The Links section is the only copy of link targets: it wins over
 * anything in the JSON, a file node without an entry gets an empty link, and an entry without a node is dropped.
 */
export function loadDocument(text: string): { doc: Document; parsed: ParsedFigureFile } {
  const parsed = parseFigureFile(text);
  if (parsed.bodyJson === null) return { doc: createDocument("nature-double"), parsed };

  let json: unknown;
  try {
    json = JSON.parse(parsed.bodyJson);
  } catch (e) {
    throw new FormatError(`The figure JSON is not valid: ${e instanceof Error ? e.message : String(e)}`);
  }

  const doc = migrate(json);
  const linktexts = new Map(parsed.links.map((l) => [l.id, l.linktext]));
  doc.nodes = doc.nodes.map((n) => (n.type === "file" ? { ...n, ...splitLinktext(linktexts.get(n.id) ?? "") } : n));
  return { doc, parsed };
}
