/**
 * Block ids (`^id`) in a note, pure: which block a line is in (from Obsidian's metadata cache), whether it already has
 * an id, a new id, and where a new one is written. `note-block-id` (`noteBlockId`) is what reads and writes notes.
 *
 * A block id goes where Obsidian looks for one: at the end of a paragraph's or list item's last line after a space, or,
 * for a structured block (a table, a code or math block, a quote, a callout), on a line of its own after the block, set
 * off by blank lines. A list item whose last line cannot carry text (it closes a fence, or is a table row) gets it on a
 * line of its own inside the item. A heading is never given one: it is linked by its heading (`#Heading`).
 */

/** A place in a note as Obsidian's cache gives it: 0-based line, and (when given) column and offset in the text. */
export interface Loc {
  line: number;
  col?: number;
  offset?: number;
}

/** Lines `start.line`..`end.line` (0-based, inclusive), as Obsidian's cache gives a position. */
export interface LinePos {
  start: Loc;
  end: Loc;
}

/** A section of Obsidian's cache (`SectionCache`): its type, its lines, and its block id when it has one. */
export interface SectionLike {
  type: string;
  position: LinePos;
  id?: string;
}

/** A list item of Obsidian's cache (`ListItemCache`). */
export interface ListItemLike {
  position: LinePos;
  id?: string;
}

/** A block id of Obsidian's cache (`BlockCache`). */
export interface BlockLike {
  id: string;
  position: LinePos;
}

/** What `blockAt` reads of a note's cache (`CachedMetadata`). */
export interface BlocksCache {
  sections?: SectionLike[];
  listItems?: ListItemLike[];
}

/**
 * A block of a note: a section's type (`"listItem"` for one item of a list), its lines (`end` inclusive; for a list
 * item, its own lines, without the items nested in it), and the id the cache gives it, when it has one.
 */
export interface Block {
  type: string;
  start: number;
  end: number;
  id?: string;
  /** The cache's own places for the block (its section's, and its list item's), to check against the text (`blockMatchesText`). */
  locs?: Loc[];
}

/** Where a block's id is written: at the end of its last line, on a line of its own after it, or (null) nowhere. */
export type IdPlacement = "end" | "own-line" | null;

const END_TYPES = new Set(["paragraph", "listItem"]);
const OWN_LINE_TYPES = new Set(["table", "code", "math", "blockquote", "callout"]);

export function idPlacement(type: string): IdPlacement {
  if (END_TYPES.has(type)) return "end";
  if (OWN_LINE_TYPES.has(type)) return "own-line";
  return null;
}

const within = (line: number, pos: LinePos) => pos.start.line <= line && line <= pos.end.line;

/**
 * The block that holds `line` (0-based): the cache's section that holds it, or, in a list, the innermost list item that
 * does. Null for a line in no section (a blank line between blocks, a line past the end).
 */
export function blockAt(cache: BlocksCache, line: number): Block | null {
  const section = (cache.sections ?? []).find((s) => within(line, s.position));
  if (!section) return null;
  if (section.type === "list") {
    const items = (cache.listItems ?? []).filter((i) => within(i.position.start.line, section.position));
    const holding = items.filter((i) => within(line, i.position));
    if (holding.length > 0) {
      const item = holding.reduce((a, b) => (b.position.start.line > a.position.start.line ? b : a));
      const start = item.position.start.line;
      // An item's range may take in the items nested in it; its own lines end where the next item starts.
      const next = Math.min(...items.map((i) => i.position.start.line).filter((s) => s > start));
      const end = Math.min(item.position.end.line, next - 1);
      const locs = [section.position.start, section.position.end, item.position.start, item.position.end];
      return { type: "listItem", start, end, locs, ...(item.id ? { id: item.id } : {}) };
    }
  }
  const locs = [section.position.start, section.position.end];
  return { type: section.type, start: section.position.start.line, end: section.position.end.line, locs, ...(section.id ? { id: section.id } : {}) };
}

/**
 * Whether the cache's places for `block` still hold in `text`: each one's offset is where its line and column are,
 * within the text. False means the cache was made from other text (the note changed since it was indexed); a place
 * without a column or offset is not checked.
 */
export function blockMatchesText(text: string, block: Block): boolean {
  const lines = text.split("\n");
  // A block neither starts nor ends on a blank line.
  if (lines[block.start] === undefined || isBlank(lines[block.start]) || lines[block.end] === undefined || isBlank(lines[block.end])) return false;
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStarts.push(at);
    at += line.length + 1;
  }
  return (block.locs ?? []).every((loc) => {
    if (loc.col === undefined || loc.offset === undefined) return true;
    const line = lines[loc.line];
    return line !== undefined && loc.col <= line.length && lineStarts[loc.line] + loc.col === loc.offset;
  });
}

/** The id the cache has for `block`: its own, else a cached block id within its lines; null when it has none. */
export function existingBlockId(blocks: Record<string, BlockLike> | undefined, block: Block): string | null {
  if (block.id) return block.id;
  for (const cached of Object.values(blocks ?? {})) {
    if (cached.position.start.line <= block.end && cached.position.end.line >= block.start) return cached.id;
  }
  return null;
}

/** An id at the end of a line: after a space (or alone on the line), with nothing but spaces after it. */
const END_ID = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*\r?$/;
/** An id alone on its line. */
const OWN_LINE_ID = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*\r?$/;

const isBlank = (line: string | undefined) => line !== undefined && line.trim() === "";

/** A line that cannot carry an id at its end: one that closes a code or math fence, or a table row. */
const CLOSING_LINE = /^\s*(?:`{3,}|~{3,}|\$\$)\s*$|\$\$\s*$|^\s*\||\|\s*\r?$/;
/** A list item's first line: the indent, the marker and the spaces after it, which together give its content column. */
const LIST_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])( {1,4}|\t|$)/;

/** Whether `block`'s id goes on a line of its own: a structured block, or a block ending in a line that cannot carry it. */
function idOnOwnLine(lines: readonly string[], block: Block): boolean {
  if (idPlacement(block.type) === "own-line") return true;
  const last = lines[block.end];
  return last !== undefined && CLOSING_LINE.test(last);
}

/**
 * The id written in the note's `lines` for `block`: at the end of its last line, or, for a block whose id goes on a line
 * of its own, on the next line or the one after a blank line. Null when there is none (or the block is past the text).
 */
export function blockIdInText(lines: readonly string[], block: Block): string | null {
  const last = lines[block.end];
  if (last === undefined) return null;
  const atEnd = END_ID.exec(last)?.[1];
  if (atEnd) return atEnd;
  if (!idOnOwnLine(lines, block)) return null;
  const next = isBlank(lines[block.end + 1]) ? lines[block.end + 2] : lines[block.end + 1];
  return next === undefined ? null : (OWN_LINE_ID.exec(next)?.[1] ?? null);
}

/** The note's line ending: CRLF when most of its line breaks are, else LF. */
function dominantEol(lines: readonly string[]): string {
  let crlf = 0;
  for (let i = 0; i < lines.length - 1; i++) if (lines[i].endsWith("\r")) crlf++;
  return crlf * 2 > lines.length - 1 ? "\r\n" : "\n";
}

/** Every block id written in `text`, in order. */
export function idsInText(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const id = END_ID.exec(line)?.[1];
    return id ? [id] : [];
  });
}

const DEFAULT_PREFIX = "fig";

/** The setting's prefix as an id can hold it: letters, digits and dashes only; "fig" when nothing is left. */
export function blockIdPrefix(setting: string): string {
  const kept = setting.replace(/[^A-Za-z0-9-]/g, "");
  return kept === "" ? DEFAULT_PREFIX : kept;
}

const ID_SPACE = 36 ** 4;

/** A new id `<prefix>-<4 base36 chars>` that is not one of `taken` (compared without case). `random` is in [0, 1). */
export function newBlockId(prefix: string, taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(Array.from(taken, (id) => id.toLowerCase()));
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const n = Math.min(ID_SPACE - 1, Math.floor(random() * ID_SPACE));
    const id = `${prefix}-${n.toString(36).padStart(4, "0")}`;
    if (!used.has(id.toLowerCase())) return id;
  }
  throw new Error(`Could not find a free block id with the prefix "${prefix}"`);
}

/** One insertion into a note: `text` goes in at line `line`, column `ch` (as an editor counts them). */
export interface TextInsertion {
  line: number;
  ch: number;
  text: string;
}

/**
 * The insertion that gives `block` the id `id`: ` ^id` at the end of a paragraph's or list item's last line, or `^id` on a
 * line of its own after a structured block with a blank line before (and one after when text follows at once), in the
 * note's own line ending. A list item that ends in a fence or a table row gets it on a line of its own inside the item,
 * indented to the item's content. Throws for a heading (linked by its heading instead), a block that cannot hold an id,
 * and a block past the end of `lines`.
 */
export function blockIdInsertion(lines: readonly string[], block: Block, id: string): TextInsertion {
  const placement = idPlacement(block.type);
  if (block.type === "heading") throw new Error("A heading is linked by its heading, not given a block id");
  if (placement === null) throw new Error(`A ${block.type} block cannot hold a block id`);
  const last = lines[block.end];
  if (last === undefined) throw new Error("The note has changed since it was indexed; try again");
  const cr = last.endsWith("\r");
  const ch = cr ? last.length - 1 : last.length;
  if (!idOnOwnLine(lines, block)) return { line: block.end, ch, text: ` ^${id}` };
  const eol = dominantEol(lines);
  const next = lines[block.end + 1];
  let indent = "";
  let after = next !== undefined && !isBlank(next) ? eol : "";
  if (placement === "end") {
    // Inside the item, at its content column, so it stays the item's; text that follows at once and is not the next
    // item would run on into the id's paragraph, so it gets a blank line too.
    const marker = LIST_MARKER.exec(lines[block.start] ?? "");
    if (marker) indent = " ".repeat(marker[1].replace(/\t/g, "    ").length + marker[2].length + Math.max(1, marker[3].length));
    if (next !== undefined && LIST_MARKER.test(next)) after = "";
  }
  return { line: block.end, ch, text: `${eol}${eol}${indent}^${id}${after}` };
}

/** `text` with `block` given the id `id` (see `blockIdInsertion`); nothing else in it changes. */
export function insertBlockId(text: string, block: Block, id: string): string {
  const lines = text.split("\n");
  const at = blockIdInsertion(lines, block, id);
  const line = lines[at.line];
  lines[at.line] = line.slice(0, at.ch) + at.text + line.slice(at.ch);
  return lines.join("\n");
}
