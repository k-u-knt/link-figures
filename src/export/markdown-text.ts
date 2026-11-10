/**
 * Markdown as plain text, for what shows text without markup (PowerPoint's presenter notes). A small line-based pass,
 * not a Markdown parser: headings, emphasis, inline code, links and wikilinks become their text; list items become
 * "• item" (ordered ones keep their number); embeds, comments, block ids, front matter, rules and code fences are
 * dropped (the code inside is kept); quote and callout markers go. Lines are kept as lines, and paragraphs are
 * separated by one blank line.
 */
export function markdownToPlainText(md: string): string {
  let text = md.replace(/\r\n?/g, "\n");
  // Front matter, only at the very start.
  text = text.replace(/^---\n[\s\S]*?\n---(\n|$)/, "");
  // Comments, which may span lines.
  text = text.replace(/%%[\s\S]*?%%/g, "");

  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    // Code fences and rules end a paragraph and leave nothing.
    if (/^\s*(```|~~~)/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("");
      continue;
    }
    // Quote and callout markers.
    line = line.replace(/^(\s*>)+\s?/, "");
    line = line.replace(/^\[!\w+\][+-]?\s*/, "");
    // Headings.
    line = line.replace(/^\s{0,3}#{1,6}\s+/, "");
    // List items (a task's box goes too).
    line = line.replace(/^(\s*)[-*+]\s+(\[.\]\s+)?/, "$1• ");
    line = line.replace(/^(\s*\d+[.)]\s+)\[.\]\s+/, "$1");
    const plain = inline(line).replace(/(^|\s+)\^[\w-]+\s*$/, "").replace(/[ \t]+$/, "");
    // A line that held only markup (an embed, a comment) goes; a blank line stays, as a paragraph break.
    if (plain.trim() === "" && raw.trim() !== "") continue;
    out.push(plain);
  }

  // Blank lines (and lines left empty) collapse to one paragraph break.
  return out
    .join("\n")
    .replace(/\n[ \t]*\n(\s*\n)*/g, "\n\n")
    .trim();
}

/** A line's inline markup as its text. */
function inline(line: string): string {
  return (
    line
      // Embeds, both kinds, with the space before them when they sit mid-line.
      .replace(/\s*!\[\[[^\]]*\]\]/g, "")
      .replace(/\s*!\[[^\]]*\]\((<[^>]*>|[^)]*)\)/g, "")
      // Wikilinks: the alias, else the target as Obsidian shows it ("Note > Heading").
      .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
      .replace(/\[\[([^\]]*)\]\]/g, (_, target: string) =>
        target
          .split("#")
          .filter((part) => part !== "")
          .map((part) => part.replace(/^\^/, ""))
          .join(" > "),
      )
      // Links: their text.
      .replace(/\[([^\]]*)\]\((<[^>]*>|[^)]*)\)/g, "$1")
      // Inline code, then emphasis, strikethrough and highlights.
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1$2")
      .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1")
      .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, "$1$2")
      .replace(/(~~|==)(?=\S)([\s\S]*?\S)\1/g, "$2")
      // HTML tags, and backslash escapes.
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/\\([\\`*_{}[\]()#+\-.!~=|>])/g, "$1")
      .replace(/^\s+$/, "")
  );
}
