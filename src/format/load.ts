import { createDocument } from "../model/defaults";
import type { Document } from "../model/types";
import type { Registries } from "../registry";
import { FormatError } from "./errors";
import { splitLinktext } from "./links-section";
import { migrate, type HookFailure } from "./migrate";
import { parseFigureFile, type ParsedFigureFile } from "./parse";

/**
 * Parses a figure file into a document. The Links section is the only copy of link targets: it wins over
 * anything in the JSON, a file node without an entry gets an empty link, and an entry without a node is dropped.
 * A node of a type a plugin registers is validated by that type's `migrate` hook, found in `registries`; the nodes whose
 * hook failed are kept as they are and listed in `hookFailures`.
 */
export function loadDocument(
  text: string,
  registries?: Pick<Registries, "nodeTypes">,
): { doc: Document; parsed: ParsedFigureFile; hookFailures: HookFailure[] } {
  const parsed = parseFigureFile(text);
  const hookFailures: HookFailure[] = [];
  if (parsed.bodyJson === null) return { doc: createDocument("nature-double"), parsed, hookFailures };

  let json: unknown;
  try {
    json = JSON.parse(parsed.bodyJson);
  } catch (e) {
    throw new FormatError(`The figure JSON is not valid: ${e instanceof Error ? e.message : String(e)}`);
  }

  const doc = migrate(json, registries ? (type) => registries.nodeTypes.get(type) : undefined, hookFailures);
  const linktexts = new Map(parsed.links.map((l) => [l.id, l.linktext]));
  doc.nodes = doc.nodes.map((n) => (n.type === "file" ? { ...n, ...splitLinktext(linktexts.get(n.id) ?? "") } : n));
  return { doc, parsed, hookFailures };
}

/**
 * What to tell the user about `failures` when the figure opens: one line per type, with the first failure's message.
 * The view shows each as a Notice and logs it to the console.
 */
export function hookFailureReports(failures: readonly HookFailure[]): string[] {
  const byType = new Map<string, HookFailure>();
  for (const failure of failures) if (!byType.has(failure.type)) byType.set(failure.type, failure);
  return [...byType.values()].map(
    (f) => `Link Figures: the plugin that draws "${f.type}" items could not read them (${f.message}). They are shown as placeholders and saved unchanged.`,
  );
}
