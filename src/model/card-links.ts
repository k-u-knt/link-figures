/**
 * Obsidian's link syntax in a card's text: `[[target#subpath|alias]]` and the embed `![[…]]`. Pure: the card renderer,
 * the rename pass (`links/card-renames.ts`), the export and Open source all read links through this module. A link in
 * code (a fenced block or an inline code span, see `codeRanges`) is text, not a link.
 */

/**
 * One link in a card's text. `target` is the file part as written (trimmed), `subpath` the `#heading` or `#^block`
 * part with its `#` ("" when none), `alias` what follows the first `|` (an alias, or an image size such as `300`), or
 * null when there is no `|`. `start` and `end` are the offsets of the whole link, `!` included for an embed.
 */
export type CardLink = { embed: boolean; target: string; subpath: string; alias: string | null; start: number; end: number };

/**
 * Where `markdown` holds code, as [start, end) offsets: fenced blocks (``` or ~~~, from the opening fence line to the
 * closing one, or to the end when it is never closed) and inline code spans (a run of backticks to the next run of the
 * same length) outside them. What is in them is text, not Markdown.
 */
export function codeRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = [];
  const line = /[^\n]*(\n|$)/g;
  let open: { start: number; char: string; length: number } | null = null;
  for (let m = line.exec(markdown); m && m[0] !== ""; m = line.exec(markdown)) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(m[0]);
    if (!open) {
      if (fence) open = { start: m.index, char: fence[1][0], length: fence[1].length };
    } else if (fence && fence[1][0] === open.char && fence[1].length >= open.length && /^ {0,3}[`~]+\s*$/.test(m[0])) {
      ranges.push([open.start, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, markdown.length]);
  const inFence = (at: number) => ranges.some(([a, b]) => at >= a && at < b);
  const spans: [number, number][] = [];
  // An inline code span ends within its paragraph: a blank line closes it (a stray backtick pairs with nothing later).
  for (const m of markdown.matchAll(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g)) {
    if (!inFence(m.index)) spans.push([m.index, m.index + m[0].length]);
  }
  return [...ranges, ...spans].sort((a, b) => a[0] - b[0]);
}

/** A wikilink or an embed: `[[…]]` on one line, with no brackets inside. */
const WIKILINK = /(!?)\[\[([^[\]\n]+)\]\]/g;

/** A link as parsed, with where its target is written (for a rename, which replaces only that). */
interface ParsedLink extends CardLink {
  targetStart: number;
  targetEnd: number;
}

function parseLinks(text: string): ParsedLink[] {
  const code = codeRanges(text);
  const links: ParsedLink[] = [];
  for (const m of text.matchAll(WIKILINK)) {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const embed = m[1] === "!";
    const inner = m[2];
    const innerStart = m.index + m[1].length + 2;
    const bar = inner.indexOf("|");
    const link = bar === -1 ? inner : inner.slice(0, bar);
    const alias = bar === -1 ? null : inner.slice(bar + 1);
    const hash = link.indexOf("#");
    const rawTarget = hash === -1 ? link : link.slice(0, hash);
    const subpath = hash === -1 ? "" : link.slice(hash).trim();
    const lead = rawTarget.length - rawTarget.trimStart().length;
    const target = rawTarget.trim();
    const targetStart = innerStart + lead;
    links.push({ embed, target, subpath, alias, start: m.index, end: m.index + m[0].length, targetStart, targetEnd: targetStart + target.length });
  }
  return links;
}

const publicLink = ({ embed, target, subpath, alias, start, end }: ParsedLink): CardLink => ({ embed, target, subpath, alias, start, end });

/** The links and embeds in `text`, outside code, in the order they are written. */
export function cardLinks(text: string): CardLink[] {
  return parseLinks(text).map(publicLink);
}

/** The first link or embed in `text` that names a file (not `[[#heading]]` within the card), outside code; null when there is none. */
export function firstLink(text: string): CardLink | null {
  return cardLinks(text).find((link) => link.target !== "") ?? null;
}

/** One replacement in a text: [start, end) becomes `insert`. */
export interface TextEdit {
  start: number;
  end: number;
  insert: string;
}

/**
 * The edits that rename, in `text`, the target of each link that leads to `oldPath` (`resolve` gives the path a target
 * leads to, or null) to `newLinktext`. Only the target is replaced: the subpath, the alias or size, and links in code stay.
 */
export function renameEdits(text: string, resolve: (target: string) => string | null, oldPath: string, newLinktext: string): TextEdit[] {
  return parseLinks(text)
    .filter((link) => link.target !== "" && link.target !== newLinktext && resolve(link.target) === oldPath)
    .map((link) => ({ start: link.targetStart, end: link.targetEnd, insert: newLinktext }));
}

/** `text` with `edits` (in order, not overlapping) applied. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = "";
  let last = 0;
  for (const edit of edits) {
    out += text.slice(last, edit.start) + edit.insert;
    last = edit.end;
  }
  return out + text.slice(last);
}

/** Where `offset` in a text is once `edits` are applied: an offset inside an edit goes to the end of what replaced it. */
export function mapOffset(offset: number, edits: readonly TextEdit[]): number {
  let shift = 0;
  for (const edit of edits) {
    if (edit.end <= offset) shift += edit.insert.length - (edit.end - edit.start);
    else if (edit.start < offset) return edit.start + shift + edit.insert.length;
  }
  return offset + shift;
}

/**
 * `text` with every link that leads to `oldPath` (as `resolve` finds its target) pointing at `newLinktext` instead,
 * keeping its `#heading` or `#^block`, its `|alias` or `|size`, and whether it is an embed; links to other files and
 * links in code are left alone. The same string when nothing changes.
 */
export function renameInCardText(text: string, resolve: (target: string) => string | null, oldPath: string, newLinktext: string): string {
  const edits = renameEdits(text, resolve, oldPath, newLinktext);
  return edits.length === 0 ? text : applyEdits(text, edits);
}

/**
 * The text of a card holding the embed of `file` (a link as a node holds it: a path, or a name) and its `subpath`:
 * `![[<linktext><subpath>]]`, where `linktext` turns the file into the link text Obsidian would write (a file it
 * cannot find keeps its link verbatim).
 */
export function embedText(file: string, subpath: string, linktext: (file: string) => string = (f) => f): string {
  return `![[${linktext(file)}${subpath}]]`;
}

/**
 * `markdown` with each wikilink (not an embed) outside code written as the text Obsidian shows for it: its alias, else
 * its target and subpath as "Note > Heading" (a block's `^` dropped).
 */
export function linksAsText(markdown: string): string {
  const edits: TextEdit[] = parseLinks(markdown)
    .filter((link) => !link.embed)
    .map((link) => {
      const shown =
        link.alias !== null && link.alias.trim() !== ""
          ? link.alias.trim()
          : [link.target, ...link.subpath.split("#").map((part) => part.trim().replace(/^\^/, ""))].filter((part) => part !== "").join(" > ");
      return { start: link.start, end: link.end, insert: shown };
    });
  return applyEdits(markdown, edits);
}

/**
 * A block id as Obsidian reads one: `^` and an id of letters, digits and dashes at the very end of a line (before its
 * line break, `\n` or `\r\n`), after a space or a tab, or alone on its line. An id of digits only (`x ^2`) is taken for
 * prose, an exponent, as Obsidian's own ids always hold a letter in practice.
 */
const BLOCK_ID = /(^|[ \t])\^(?![0-9]+(?=\r?$))[A-Za-z0-9-]+(?=\r?$)/gm;

/**
 * `markdown` with its block-id markers left out (`BLOCK_ID`), outside code: ` ^id` at the end of a line goes, with the
 * spaces before it, and a line that held only `^id` (the id of a list or a table, on the line after it) goes with its
 * line break. For text read without Obsidian (an export), where the marker would show.
 */
export function stripBlockIds(markdown: string): string {
  const code = codeRanges(markdown);
  const edits: TextEdit[] = [];
  for (const m of markdown.matchAll(BLOCK_ID)) {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const end = m.index + m[0].length;
    if (m[1] === "") {
      // Alone on its line: the line goes, with its own line break, or with the one before it at the very end.
      const lineEnd = markdown.startsWith("\r\n", end) ? end + 2 : markdown[end] === "\n" ? end + 1 : end;
      if (lineEnd > end) edits.push({ start: m.index, end: lineEnd, insert: "" });
      else {
        const before = m.index >= 2 && markdown.startsWith("\r\n", m.index - 2) ? 2 : m.index >= 1 ? 1 : 0;
        edits.push({ start: m.index - before, end, insert: "" });
      }
      continue;
    }
    // The spaces before the marker go with it.
    let start = m.index;
    while (start > 0 && (markdown[start - 1] === " " || markdown[start - 1] === "\t")) start--;
    edits.push({ start, end, insert: "" });
  }
  return applyEdits(markdown, edits);
}
