import type { DropFromNote } from "../settings/settings";
import { blockAt, blockIdInText, blockMatchesText, existingBlockId, idPlacement, type Block, type LinePos } from "./block-id";
import type { SelectionMatch } from "./intake-classify";
import { REINDEX_TIMEOUT_MS, type BlockIdResult, type NoteCache, type NoteHost } from "./note-block-id";

/**
 * What a drop out of a note links to (spec `2026-11-10-drop-from-note-design.md` §2, §3, §6): the note whose editor has
 * the dropped text selected (`matchSelection`), and the place in it (`linkForText`, `linkForImage`). Only `"block-id"`
 * mode writes into a note, and only through `blockId` (`noteBlockId`); `"heading"` mode reads. Pure but for the host.
 */

/** What the drop needs of Obsidian: the note's cache and text, its open editor, and the block-id writer (`api.blockId`). */
export type NoteDropHost = Pick<NoteHost, "cache" | "read" | "editor" | "saveAndReindex"> & {
  blockId(path: string, line: number): Promise<BlockIdResult>;
};

/** An open Markdown editor's selection: its note, its text (`editor.getSelection()`) and its ranges (`editor.listSelections()`). */
export interface OpenNoteSelection {
  path: string;
  selection: string;
  ranges: { anchor: { line: number; ch: number }; head: { line: number; ch: number } }[];
}

/** Where a drop out of a note links: the subpath on the note (`""` for the whole note), and what to tell the user. */
export interface NoteLink {
  subpath: string;
  notices: string[];
}

const lf = (text: string) => text.replace(/\r\n?/g, "\n");
const before = (a: { line: number; ch: number }, b: { line: number; ch: number }) => a.line < b.line || (a.line === b.line && a.ch < b.ch);

/**
 * The first of `notes` (the most recently active first) whose selection is `text`, line endings aside: its path and the
 * selection's first and last lines. A selection that ends at the start of a line (a whole line taken with its break)
 * ends on the line before. Null when none is, and for blank text.
 */
export function matchSelection(notes: readonly OpenNoteSelection[], text: string): SelectionMatch | null {
  const wanted = lf(text);
  if (wanted.trim() === "") return null;
  for (const note of notes) {
    if (note.ranges.length === 0 || lf(note.selection) !== wanted) continue;
    let from = Infinity;
    let to = -Infinity;
    for (const { anchor, head } of note.ranges) {
      const [start, end] = before(head, anchor) ? [head, anchor] : [anchor, head];
      from = Math.min(from, start.line);
      to = Math.max(to, end.ch === 0 && end.line > start.line ? end.line - 1 : end.line);
    }
    return { path: note.path, from, to };
  }
  return null;
}

// --- A small reader of a note's blocks, for when the cache is behind the editor ---------------------------------

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MATH = /^\s*\$\$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const EMBED = /!\[\[([^[\]\r\n]*)\]\]/g;
const MD_IMAGE = /!\[[^\]\r\n]*\]\(\s*(<[^>\r\n]*>|[^)\s]+)[^)\r\n]*\)/g;

const blank = (line: string) => line.trim() === "";

/**
 * Obsidian's cache, as near as a short reader can make it from `text`: sections (front matter, headings, fences, math,
 * tables, quotes and callouts, lists, paragraphs, split by blank lines), list items, headings, and embeds (`![[…]]`,
 * `![](…)`) outside code. Used when the cache is behind the editor (spec §3) and there is no time to wait for it.
 */
export function parseNote(text: string): NoteCache {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const starts: number[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    starts.push(at);
    at += line.length + 1;
  }
  const pos = (start: number, end: number): LinePos => ({
    start: { line: start, col: 0, offset: starts[start] },
    end: { line: end, col: lines[end].length, offset: starts[end] + lines[end].length },
  });
  const cache: Required<Pick<NoteCache, "sections" | "listItems" | "headings" | "embeds">> = { sections: [], listItems: [], headings: [], embeds: [] };
  const section = (type: string, start: number, end: number) => cache.sections.push({ type, position: pos(start, end) });
  const startsBlock = (line: string) => HEADING.test(line) || FENCE.test(line) || MATH.test(line);

  let i = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, n) => n > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (close > 0) {
      section("yaml", 0, close);
      i = close + 1;
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      cache.headings.push({ heading: (heading[2] ?? "").trim(), level: heading[1].length, position: pos(i, i) });
      section("heading", i, i);
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence || MATH.test(line)) {
      const closes = fence
        ? (l: string) => new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`).test(l)
        : (l: string) => /\$\$\s*$/.test(l);
      // `$$x$$` on one line is the whole block.
      let end = !fence && /^\s*\$\$.*\S.*\$\$\s*$/.test(line) ? i : -1;
      for (let j = i + 1; end < 0 && j < lines.length; j++) if (closes(lines[j])) end = j;
      if (end < 0) end = lines.length - 1;
      section(fence ? "code" : "math", i, end);
      i = end + 1;
      continue;
    }
    const first = line.trimStart();
    // A table runs while its lines are rows; anything else runs to a blank line or a heading, fence or math.
    const isTable = first.startsWith("|");
    let end = i;
    while (end + 1 < lines.length && !blank(lines[end + 1]) && !startsBlock(lines[end + 1]) && (!isTable || lines[end + 1].includes("|"))) end++;
    const type = isTable
      ? "table"
      : first.startsWith(">")
        ? /^>\s*\[!/.test(first)
          ? "callout"
          : "blockquote"
        : LIST_ITEM.test(line)
          ? "list"
          : "paragraph";
    if (type === "list") {
      const items: number[] = [];
      for (let j = i; j <= end; j++) if (LIST_ITEM.test(lines[j])) items.push(j);
      items.forEach((start, n) => cache.listItems.push({ position: pos(start, n + 1 < items.length ? items[n + 1] - 1 : end) }));
    }
    section(type, i, end);
    i = end + 1;
  }

  const code = cache.sections.filter((s) => s.type === "code" || s.type === "math" || s.type === "yaml");
  lines.forEach((line, n) => {
    if (code.some((s) => s.position.start.line <= n && n <= s.position.end.line)) return;
    const found: { link: string; col: number }[] = [];
    for (const m of line.matchAll(EMBED)) found.push({ link: m[1].split("|")[0].trim(), col: m.index ?? 0 });
    for (const m of line.matchAll(MD_IMAGE)) {
      const raw = m[1].replace(/^<|>$/g, "");
      let link = raw;
      try {
        link = decodeURI(raw);
      } catch {
        // Kept as written.
      }
      found.push({ link, col: m.index ?? 0 });
    }
    found.sort((a, b) => a.col - b.col);
    for (const { link, col } of found) {
      cache.embeds.push({ link, position: { start: { line: n, col, offset: starts[n] + col }, end: { line: n, col, offset: starts[n] + col } } });
    }
  });
  return cache;
}

// --- The note as the drop reads it ---------------------------------------------------------------------------------

interface NoteState {
  cache: NoteCache;
  lines: string[];
}

/** Whether every section of `cache` is where it says in `text`: the cache was made from this text. */
function cacheHolds(cache: NoteCache, text: string): boolean {
  return (cache.sections ?? []).every((s) =>
    blockMatchesText(text, { type: s.type, start: s.position.start.line, end: s.position.end.line, locs: [s.position.start, s.position.end] }),
  );
}

/**
 * The note's blocks as they are in the text the user sees: the editor's when the note is open, else the file's. In
 * `"block-id"` mode, which writes, an editor ahead of the file is saved and the cache waited for (`REINDEX_TIMEOUT_MS`),
 * as `noteBlockId` does too; in `"heading"` mode, which never writes, it is not saved. A cache that is behind, or whose
 * places do not hold in the text, is replaced by `parseNote` of the text. Null when the note cannot be read.
 */
async function noteState(host: NoteDropHost, mode: DropFromNote, path: string): Promise<NoteState | null> {
  let fileText: string;
  try {
    fileText = await host.read(path);
  } catch {
    return null;
  }
  const editor = host.editor(path);
  let text = editor ? editor.getValue() : fileText;
  let caughtUp = true;
  if (editor && text !== fileText) {
    caughtUp = mode === "block-id" && (await host.saveAndReindex(path, REINDEX_TIMEOUT_MS));
    text = editor.getValue();
  }
  const cache = host.cache(path);
  const fresh = cache !== null && caughtUp && cacheHolds(cache, text);
  return { cache: fresh ? cache : parseNote(text), lines: text.split("\n") };
}

interface HeadingAt {
  heading: string;
  level: number;
  line: number;
}

const headingsOf = (cache: NoteCache): HeadingAt[] =>
  (cache.headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line })).sort((a, b) => a.line - b.line);

/** The last line of the section `headings[index]` starts: before the next heading of its level or above; Infinity at the end. */
function sectionEnd(headings: readonly HeadingAt[], index: number): number {
  const next = headings.slice(index + 1).find((h) => h.level <= headings[index].level);
  return next ? next.line - 1 : Infinity;
}

/** A heading as a link holds it: what a link cannot hold (`# | ^ : % [ ] \`) made a space, as Obsidian does. */
const linkable = (heading: string) => heading.replace(/[#|^:%[\]\\]/g, " ").replace(/\s+/g, " ").trim();

/** The subpath that links `headings[index]`: `#Heading`, or, when another heading has the same text, through the headings above it (`#A#Heading`). */
function headingSubpath(headings: readonly HeadingAt[], index: number): string {
  const name = linkable(headings[index].heading);
  if (headings.filter((h) => linkable(h.heading) === name).length === 1) return `#${name}`;
  const chain = [name];
  let level = headings[index].level;
  for (let i = index - 1; i >= 0; i--) {
    if (headings[i].level < level) {
      chain.unshift(linkable(headings[i].heading));
      level = headings[i].level;
    }
  }
  return `#${chain.join("#")}`;
}

/** The index of the nearest heading at or above `line` (its section holds the line), or -1. */
function headingAbove(headings: readonly HeadingAt[], line: number): number {
  let found = -1;
  headings.forEach((h, i) => {
    if (h.line <= line) found = i;
  });
  return found;
}

const noteName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** Where a block is linked, and the line its linked range starts on (for counting images in it). */
type Placed = NoteLink & { start: number };

/**
 * The link to `block`: its heading for a heading; its id when it has one (in the cache or in the text); in `"block-id"`
 * mode a new id through `blockId`; else (or for a block that cannot hold an id) the nearest heading above it, else the
 * whole note with a Notice. `what` names the dragged thing in the Notices.
 */
async function placeBlock(host: NoteDropHost, mode: DropFromNote, path: string, state: NoteState, block: Block, what: string, notices: string[]): Promise<Placed> {
  const headings = headingsOf(state.cache);
  if (block.type === "heading") {
    const index = headings.findIndex((h) => h.line === block.start);
    if (index >= 0) return { subpath: headingSubpath(headings, index), start: block.start, notices };
  }
  const id = existingBlockId(state.cache.blocks, block) ?? blockIdInText(state.lines, block);
  if (id) return { subpath: `#^${id}`, start: block.start, notices };
  const canHold = block.type !== "heading" && idPlacement(block.type) !== null;
  if (mode === "block-id" && canHold) {
    const written = await host.blockId(path, block.start);
    return { subpath: written.subpath, start: block.start, notices };
  }
  const index = headingAbove(headings, block.start);
  if (mode === "block-id") {
    notices.push(`Link Figures: a ${block.type} block cannot hold a block id, so the panel links ${index >= 0 ? "the heading above it" : "the whole note"}.`);
  }
  if (index >= 0) return { subpath: headingSubpath(headings, index), start: headings[index].line, notices };
  if (mode !== "block-id") notices.push(`Link Figures: there is no heading above ${what} in ${noteName(path)}, so the panel links the whole note.`);
  return { subpath: "", start: 0, notices };
}

/**
 * The link for text selected on lines `from`..`to` of the note at `path` and dropped (mode `"block-id"` or
 * `"heading"`): the block that holds it; over several blocks, the smallest heading section that holds them all, else
 * the first block with a Notice. Null when the lines hold no block (blank lines only) or the note cannot be read.
 * Rejects when `blockId` does (the note changed under the drop).
 */
export async function linkForText(host: NoteDropHost, mode: DropFromNote, path: string, from: number, to: number): Promise<NoteLink | null> {
  const state = await noteState(host, mode, path);
  if (!state) return null;
  const blocks: Block[] = [];
  for (let line = from; line <= Math.min(to, state.lines.length - 1); line++) {
    const block = blockAt(state.cache, line);
    if (block && !blocks.some((b) => b.start === block.start)) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  const notices: string[] = [];
  if (blocks.length > 1) {
    const headings = headingsOf(state.cache);
    const first = blocks[0].start;
    const last = Math.max(...blocks.map((b) => b.end));
    let holding = -1;
    headings.forEach((h, i) => {
      if (h.line <= first && sectionEnd(headings, i) >= last) holding = i;
    });
    if (holding >= 0) return { subpath: headingSubpath(headings, holding), notices };
    notices.push(`Link Figures: the selection spans several blocks of ${noteName(path)} with no heading over them all, so the panel links its first block.`);
  }
  const { subpath } = await placeBlock(host, mode, path, state, blocks[0], "that text", notices);
  return { subpath, notices };
}

/**
 * The link for an image dragged out of the note at `path` (mode `"block-id"` or `"heading"`): the embed `isDragged`
 * picks (the first, with a Notice, when there are several), linked as `placeBlock` links its block, and `imageIndex`,
 * the embed's place among the images (`isImage`) of the linked range, which is how the panel finds it again. Null when
 * the note does not embed it or cannot be read. Rejects when `blockId` does.
 */
export async function linkForImage(
  host: NoteDropHost,
  mode: DropFromNote,
  path: string,
  isDragged: (link: string) => boolean,
  isImage: (link: string) => boolean,
): Promise<(NoteLink & { imageIndex: number }) | null> {
  const state = await noteState(host, mode, path);
  if (!state) return null;
  const order = (e: { position: LinePos }) => e.position.start.offset ?? e.position.start.line * 1e6 + (e.position.start.col ?? 0);
  const embeds = [...(state.cache.embeds ?? [])].sort((a, b) => order(a) - order(b));
  const hits = embeds.filter((e) => isDragged(e.link));
  if (hits.length === 0) return null;
  const target = hits[0];
  const line = target.position.start.line;
  const notices: string[] = [];
  if (hits.length > 1) {
    notices.push(`Link Figures: ${target.link} is embedded ${hits.length} times in ${noteName(path)}; the panel shows the first (line ${line + 1}).`);
  }
  // An embed in no block of the cache (it should not happen) is placed as a block of its own line would be, by heading.
  const block = blockAt(state.cache, line) ?? { type: "unknown", start: line, end: line };
  const placed = await placeBlock(host, mode, path, state, block, "that image", notices);
  const imageIndex = embeds.filter((e) => e !== target && e.position.start.line >= placed.start && order(e) < order(target) && isImage(e.link)).length;
  return { subpath: placed.subpath, imageIndex, notices: placed.notices };
}
