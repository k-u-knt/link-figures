/**
 * Block ids (`^id`) in a note, pure: which block a line is in (from Obsidian's metadata cache), whether it already has
 * an id, a new id, and where a new one is written. `note-block-id` (`noteBlockId`) is what reads and writes notes.
 *
 * A block id goes where Obsidian looks for one: at the end of the block's last line after a space, or, for a block
 * whose last line cannot carry text (a table, a code or math block), on a line of its own after the block, set off by
 * blank lines. A heading is never given one: it is linked by its heading (`#Heading`).
 */

/** Lines `start.line`..`end.line` (0-based, inclusive), as Obsidian's cache gives a position. */
export interface LinePos {
  start: { line: number };
  end: { line: number };
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
}

/** Where a block's id is written: at the end of its last line, on a line of its own after it, or (null) nowhere. */
export type IdPlacement = "end" | "own-line" | null;

const END_TYPES = new Set(["paragraph", "listItem", "blockquote", "callout"]);
const OWN_LINE_TYPES = new Set(["table", "code", "math"]);

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
      return { type: "listItem", start, end, ...(item.id ? { id: item.id } : {}) };
    }
  }
  return { type: section.type, start: section.position.start.line, end: section.position.end.line, ...(section.id ? { id: section.id } : {}) };
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

/**
 * The id written in the note's `lines` for `block`: at the end of its last line, or, for a block whose id goes on a line
 * of its own, on the next line or the one after a blank line. Null when there is none (or the block is past the text).
 */
export function blockIdInText(lines: readonly string[], block: Block): string | null {
  const last = lines[block.end];
  if (last === undefined) return null;
  if (idPlacement(block.type) === "own-line") {
    const next = isBlank(lines[block.end + 1]) ? lines[block.end + 2] : lines[block.end + 1];
    return next === undefined ? null : (OWN_LINE_ID.exec(next)?.[1] ?? null);
  }
  return END_ID.exec(last)?.[1] ?? null;
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
 * The insertion that gives `block` the id `id`: ` ^id` at the end of its last line, or, for a table, code or math block,
 * `^id` on a line of its own after it with a blank line before (and one after when text follows at once). Throws for a
 * heading (linked by its heading instead), a block that cannot hold an id, and a block past the end of `lines`.
 */
export function blockIdInsertion(lines: readonly string[], block: Block, id: string): TextInsertion {
  const placement = idPlacement(block.type);
  if (block.type === "heading") throw new Error("A heading is linked by its heading, not given a block id");
  if (placement === null) throw new Error(`A ${block.type} block cannot hold a block id`);
  const last = lines[block.end];
  if (last === undefined) throw new Error("The note has changed since it was indexed; try again");
  const cr = last.endsWith("\r");
  const ch = cr ? last.length - 1 : last.length;
  if (placement === "end") return { line: block.end, ch, text: ` ^${id}` };
  const eol = cr ? "\r\n" : "\n";
  const next = lines[block.end + 1];
  const after = next !== undefined && !isBlank(next) ? eol : "";
  return { line: block.end, ch, text: `${eol}${eol}^${id}${after}` };
}

/** `text` with `block` given the id `id` (see `blockIdInsertion`); nothing else in it changes. */
export function insertBlockId(text: string, block: Block, id: string): string {
  const lines = text.split("\n");
  const at = blockIdInsertion(lines, block, id);
  const line = lines[at.line];
  lines[at.line] = line.slice(0, at.ch) + at.text + line.slice(at.ch);
  return lines.join("\n");
}
