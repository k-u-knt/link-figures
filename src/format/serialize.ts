import { FENCE_LANG, FORMAT_VERSION, FRONTMATTER_KEY } from "../constants";
import type { Document } from "../model/types";
import { emitLinksSection, type LinkEntry } from "./links-section";
import { linktextOf, withoutLink } from "./node-links";
import type { ParsedFigureFile } from "./parse";

const MARKER = `${FRONTMATTER_KEY}: ${FORMAT_VERSION}`;
const MARKER_LINE = new RegExp(`^${FRONTMATTER_KEY}:.*$`, "m");

export function emptyParsed(): ParsedFigureFile {
  return { frontmatter: `---\n${MARKER}\n---\n`, preamble: "", links: [], bodyJson: null, trailing: "" };
}

const endWithNewline = (s: string): string => (s === "" || s.endsWith("\n") ? s : s + "\n");

/** Makes sure the frontmatter carries `link-figures: <version>`, leaving every other key as it is. */
function ensureMarker(frontmatter: string): string {
  if (frontmatter === "") return emptyParsed().frontmatter;
  const fm = endWithNewline(frontmatter);
  if (MARKER_LINE.test(fm)) return fm.replace(MARKER_LINE, (line) => (line.trimEnd() === MARKER ? line : MARKER));
  return fm.replace("---\n", `---\n${MARKER}\n`);
}

/**
 * Writes the file: the parts of `parsed` outside the Links and Figure sections are kept as they are;
 * the Links section and the JSON are regenerated from `doc`. Link targets live only in the Links section.
 */
export function serializeFigureFile(doc: Document, parsed: ParsedFigureFile): string {
  const entries: LinkEntry[] = [];
  const nodes = doc.nodes.map((n) => {
    const linktext = linktextOf(n);
    if (linktext !== "") entries.push({ id: n.id, linktext });
    return withoutLink(n);
  });
  const json = JSON.stringify({ ...doc, nodes }, null, 2);
  return (
    ensureMarker(parsed.frontmatter) +
    endWithNewline(parsed.preamble) +
    emitLinksSection(entries) +
    `## Figure\n\`\`\`${FENCE_LANG}\n${json}\n\`\`\`\n` +
    parsed.trailing
  );
}
