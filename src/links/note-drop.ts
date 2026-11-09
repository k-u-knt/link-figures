import type { DropFromNote } from "../settings/settings";
import { blockAt, blockIdInText, blockMatchesText, existingBlockId, idPlacement, type Block, type LinePos } from "./block-id";
import { MD_LINK, mdLinkTarget, type SelectionMatch } from "./intake-classify";
import type { BlockIdResult, NoteCache, NoteHost } from "./note-block-id";

/**
 * What a drop out of a note links to (spec `2026-11-10-drop-from-note-design.md` §2, §3, §6): the note whose editor has
 * the dropped text selected (`matchSelection`), and the place in it (`linkForText`, `linkForImage`). Only `"block-id"`
 * mode writes into a note, and only through `blockId` (`noteBlockId`), and only when there is an id to write; nothing
 * here saves an editor. `"heading"` mode reads. Pure but for the host.
 */

/** What the drop needs of Obsidian: the note's cache and text, its open editor, and the block-id writer (`api.blockId`). */
export type NoteDropHost = Pick<NoteHost, "cache" | "read" | "editor"> & {
  blockId(path: string, line: number): Promise<BlockIdResult>;
};

/** An open Markdown editor's selection: its note, its text (`editor.getSelection()`) and its ranges (`editor.listSelections()`). */
export interface OpenNoteSelection {
  path: string;
  selection: string;
  ranges: { anchor: { line: number; ch: number }; head: { line: number; ch: number } }[];
}

/**
 * Where a drop out of a note links: the subpath on the note (`""` for the whole note), and what to tell the user, as
 * one message (at most one Notice per drop), without the "Link Figures:" the Notice starts with.
 */
export interface NoteLink {
  subpath: string;
  notices: string[];
}

const lf = (text: string) => text.replace(/\r\n?/g, "\n");
const before = (a: { line: number; ch: number }, b: { line: number; ch: number }) => a.line < b.line || (a.line === b.line && a.ch < b.ch);

/**
 * Whether `note`'s selection (the editor the drag started in) is `text`, line endings aside: its path and the selection's
 * first and last lines. A selection that ends at the start of a line (a whole line taken with its break) ends on the
 * line before. Empty cursors are left out; more than one non-empty range (several pieces selected) is not matched. Null
 * when it does not match, for no note, and for blank text.
 */
export function matchSelection(note: OpenNoteSelection | null, text: string): SelectionMatch | null {
  const wanted = lf(text);
  if (!note || wanted.trim() === "" || lf(note.selection) !== wanted) return null;
  const ranges = note.ranges.filter(({ anchor, head }) => anchor.line !== head.line || anchor.ch !== head.ch);
  if (ranges.length !== 1) return null;
  const { anchor, head } = ranges[0];
  const [start, end] = before(head, anchor) ? [head, anchor] : [anchor, head];
  return { path: note.path, from: start.line, to: end.ch === 0 && end.line > start.line ? end.line - 1 : end.line };
}

// --- A small reader of a note's blocks, for when the cache is behind the editor ---------------------------------

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MATH = /^\s*\$\$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const INTERRUPTING_ITEM = /^\s*(?:[-*+]|0*1[.)])[ \t]+\S/;
const EMBED = /!\[\[([^[\]\r\n]*)\]\]/g;

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
  // A list item also ends a paragraph without a blank line (CommonMark: a list may interrupt a paragraph, when the item
  // is not empty and, ordered, starts at 1).
  const endsParagraph = (line: string) => startsBlock(line) || INTERRUPTING_ITEM.test(line);

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
    const isParagraph = !isTable && !first.startsWith(">") && !LIST_ITEM.test(line);
    let end = i;
    while (
      end + 1 < lines.length &&
      !blank(lines[end + 1]) &&
      !(isParagraph ? endsParagraph : startsBlock)(lines[end + 1]) &&
      (!isTable || lines[end + 1].includes("|"))
    )
      end++;
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
      // As Obsidian's cache: an item's range runs to the next item at its indent or less, taking in the items nested in it.
      const indent = (n: number) => lines[n].length - lines[n].trimStart().length;
      items.forEach((start, n) => {
        const next = items.slice(n + 1).find((j) => indent(j) <= indent(start));
        cache.listItems.push({ position: pos(start, next !== undefined ? next - 1 : end) });
      });
    }
    section(type, i, end);
    i = end + 1;
  }

  const code = cache.sections.filter((s) => s.type === "code" || s.type === "math" || s.type === "yaml");
  lines.forEach((line, n) => {
    if (code.some((s) => s.position.start.line <= n && n <= s.position.end.line)) return;
    const found: { link: string; col: number }[] = [];
    for (const m of line.matchAll(EMBED)) found.push({ link: m[1].split("|")[0].trim(), col: m.index ?? 0 });
    // Markdown embeds only (`![…](…)`), as Obsidian's cache has them; a plain `[…](…)` is a link, not an embed.
    for (const m of line.matchAll(MD_LINK)) if (m[0].startsWith("!")) found.push({ link: mdLinkTarget(m[1]), col: m.index ?? 0 });
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
 * The note's blocks as they are in the text the user sees: the editor's when the note is open, else the file's. The
 * cache when it was made from that text, else `parseNote` of the text. An open editor whose text differs from the
 * file's (`read`, what the cache is made from) is ahead of the cache, however well the cache's places still fit (text
 * typed after the last block, an embed edited out of a line made longer); a cache whose places do not hold is behind
 * too. Nothing is saved here: when an id is to be written, `blockId` saves the editor and waits for the cache itself,
 * and the lines are the same, since they are the editor's. Null when the note cannot be read.
 */
async function noteState(host: NoteDropHost, path: string): Promise<NoteState | null> {
  let text: string;
  let current: boolean;
  try {
    const editor = host.editor(path);
    if (editor) {
      text = editor.getValue();
      current = text === (await host.read(path));
    } else {
      text = await host.read(path);
      current = true;
    }
  } catch {
    return null;
  }
  const cache = current ? host.cache(path) : null;
  return { cache: cache !== null && cacheHolds(cache, text) ? cache : parseNote(text), lines: text.split("\n") };
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

/** `headings[index]` with the headings above it (each the nearest one of a higher level), as `#A#B#Heading`. */
function headingChain(headings: readonly HeadingAt[], index: number): string {
  const chain = [linkable(headings[index].heading)];
  let level = headings[index].level;
  for (let i = index - 1; i >= 0; i--) {
    if (headings[i].level < level) {
      chain.unshift(linkable(headings[i].heading));
      level = headings[i].level;
    }
  }
  return `#${chain.join("#")}`;
}

/**
 * The subpath that links `headings[index]`: `#Heading`, or, when another heading has the same text, through the
 * headings above it (`#A#Heading`). Null when an earlier heading has that same chain: a link would find the earlier one.
 */
function headingSubpath(headings: readonly HeadingAt[], index: number): string | null {
  const name = linkable(headings[index].heading);
  if (headings.filter((h) => linkable(h.heading) === name).length === 1) return `#${name}`;
  const chain = headingChain(headings, index);
  for (let i = 0; i < index; i++) if (linkable(headings[i].heading) === name && headingChain(headings, i) === chain) return null;
  return chain;
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
interface Placed {
  subpath: string;
  start: number;
}

const canHoldId = (block: Block) => block.type !== "heading" && idPlacement(block.type) !== null;

/** The block's id, from the cache or the text; null when it has none. */
const idOf = (state: NoteState, block: Block) => existingBlockId(state.cache.blocks, block) ?? blockIdInText(state.lines, block);

/** The block's id, written through `blockId` when it has none (which saves the editor first: only now is it needed). */
async function blockIdLink(host: NoteDropHost, path: string, state: NoteState, block: Block): Promise<Placed> {
  const id = idOf(state, block);
  return { subpath: id ? `#^${id}` : (await host.blockId(path, block.start)).subpath, start: block.start };
}

/**
 * The link to the section of `headings[index]`. A heading an earlier one cannot be told from (`headingSubpath` null):
 * in `"block-id"` mode the first of `candidates` (then of the section's blocks) that can hold an id, by its id; in
 * `"heading"` mode (or with no such block) the whole note, with a Notice.
 */
async function sectionLink(
  host: NoteDropHost,
  mode: DropFromNote,
  path: string,
  state: NoteState,
  headings: readonly HeadingAt[],
  index: number,
  candidates: readonly Block[],
  notices: string[],
): Promise<Placed> {
  const subpath = headingSubpath(headings, index);
  if (subpath !== null) return { subpath, start: headings[index].line };
  if (mode === "block-id") {
    const inSection: Block[] = [];
    const end = Math.min(sectionEnd(headings, index), state.lines.length - 1);
    for (let line = headings[index].line; line <= end; line++) {
      const block = blockAt(state.cache, line);
      if (block && !inSection.some((b) => b.start === block.start)) inSection.push(block);
    }
    const block = [...candidates, ...inSection].find(canHoldId);
    if (block) return blockIdLink(host, path, state, block);
  }
  notices.push(`The heading "${headings[index].heading}" in ${noteName(path)} is not unique, so the panel links the whole note.`);
  return { subpath: "", start: 0 };
}

/**
 * The link to `block`: its heading for a heading; its id when it has one (in the cache or in the text); in `"block-id"`
 * mode a new id through `blockId`; else (or for a block that cannot hold an id) the nearest heading above it, else the
 * whole note with a Notice. `what` names the dragged thing in the Notices.
 */
async function placeBlock(host: NoteDropHost, mode: DropFromNote, path: string, state: NoteState, block: Block, what: string, notices: string[]): Promise<Placed> {
  const headings = headingsOf(state.cache);
  if (block.type === "heading") {
    const index = headings.findIndex((h) => h.line === block.start);
    if (index >= 0) return sectionLink(host, mode, path, state, headings, index, [], notices);
  }
  const id = idOf(state, block);
  if (id) return { subpath: `#^${id}`, start: block.start };
  if (mode === "block-id" && canHoldId(block)) return blockIdLink(host, path, state, block);
  // A block that cannot hold an id (or heading mode): the heading above it, never another block. One message, for what is linked.
  const index = headingAbove(headings, block.start);
  const cannot = `A ${block.type} block cannot hold a block id`;
  if (index >= 0) {
    const subpath = headingSubpath(headings, index);
    if (subpath !== null) {
      if (mode === "block-id") notices.push(`${cannot}, so the panel links the heading above it.`);
      return { subpath, start: headings[index].line };
    }
    const heading = `the heading "${headings[index].heading}"`;
    notices.push(
      mode === "block-id"
        ? `${cannot}, and ${heading} above it in ${noteName(path)} is not unique, so the panel links the whole note.`
        : `The ${heading.slice(4)} in ${noteName(path)} is not unique, so the panel links the whole note.`,
    );
    return { subpath: "", start: 0 };
  }
  notices.push(mode === "block-id" ? `${cannot}, so the panel links the whole note.` : `There is no heading above ${what} in ${noteName(path)}, so the panel links the whole note.`);
  return { subpath: "", start: 0 };
}

/** The Notices of one drop as one message: at most one Notice per drop. */
const oneNotice = (notices: string[]) => (notices.length > 0 ? [notices.join(" ")] : []);

/**
 * The link for text selected on lines `from`..`to` of the note at `path` and dropped (mode `"block-id"` or
 * `"heading"`): the block that holds it (a list item with the items nested in it is one block, the item); over several blocks, the smallest heading section that holds them all, else
 * the first block with a Notice. Null when the lines hold no block (blank lines only) or the note cannot be read.
 * Rejects when `blockId` does (the note changed under the drop).
 */
export async function linkForText(host: NoteDropHost, mode: DropFromNote, path: string, from: number, to: number): Promise<NoteLink | null> {
  const state = await noteState(host, path);
  if (!state) return null;
  const blocks: Block[] = [];
  for (let line = from; line <= Math.min(to, state.lines.length - 1); line++) {
    const block = blockAt(state.cache, line);
    if (block && !blocks.some((b) => b.start === block.start)) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  // A list item with items nested in it is one block (its id covers them): a selection over it and them is the item.
  const [head] = blocks;
  if (head.type === "listItem" && head.itemEnd !== undefined && blocks.every((b) => b.start >= head.start && b.end <= head.itemEnd!)) blocks.splice(1);
  const notices: string[] = [];
  if (blocks.length > 1) {
    const headings = headingsOf(state.cache);
    const first = blocks[0].start;
    const last = Math.max(...blocks.map((b) => b.end));
    let holding = -1;
    headings.forEach((h, i) => {
      if (h.line <= first && sectionEnd(headings, i) >= last) holding = i;
    });
    if (holding >= 0) {
      const { subpath } = await sectionLink(host, mode, path, state, headings, holding, blocks, notices);
      return { subpath, notices: oneNotice(notices) };
    }
    notices.push(`The selection spans several blocks of ${noteName(path)} with no heading over them all, so the panel links its first block.`);
  }
  const { subpath } = await placeBlock(host, mode, path, state, blocks[0], "that text", notices);
  return { subpath, notices: oneNotice(notices) };
}

/**
 * The link for an image dragged out of the note at `path` (mode `"block-id"` or `"heading"`): the embed `isDragged`
 * picks, linked as `placeBlock` links its block, and `imageIndex`,
 * the embed's place among the images (`isImage`) of the linked range, which is how the panel finds it again. The embed
 * is the one on line `at.line` when the drag's place is known (of several there, the last that starts at or before
 * `at.offset`, else the first); otherwise, or when that line has none, the note's first, with a Notice when there are
 * several. Null when the note does not embed it or cannot be read. Rejects when `blockId` does.
 */
export async function linkForImage(
  host: NoteDropHost,
  mode: DropFromNote,
  path: string,
  isDragged: (link: string) => boolean,
  isImage: (link: string) => boolean,
  at?: { line: number; offset?: number | null },
): Promise<(NoteLink & { imageIndex: number }) | null> {
  const state = await noteState(host, path);
  if (!state) return null;
  const order = (e: { position: LinePos }) => e.position.start.offset ?? e.position.start.line * 1e6 + (e.position.start.col ?? 0);
  const embeds = [...(state.cache.embeds ?? [])].sort((a, b) => order(a) - order(b));
  const hits = embeds.filter((e) => isDragged(e.link));
  if (hits.length === 0) return null;
  const onLine = at ? hits.filter((e) => e.position.start.line === at.line) : [];
  const offset = at?.offset;
  const byOffset = typeof offset === "number" ? onLine.filter((e) => (e.position.start.offset ?? Infinity) <= offset).pop() : undefined;
  const target = byOffset ?? onLine[0] ?? hits[0];
  const line = target.position.start.line;
  const notices: string[] = [];
  if (onLine.length === 0 && hits.length > 1) notices.push(`${target.link} is embedded ${hits.length} times in ${noteName(path)}; the panel shows the first (line ${line + 1}).`);
  // An embed in no block of the cache (it should not happen) is placed as a block of its own line would be, by heading.
  const block = blockAt(state.cache, line) ?? { type: "unknown", start: line, end: line };
  const placed = await placeBlock(host, mode, path, state, block, "that image", notices);
  const imageIndex = embeds.filter((e) => e !== target && e.position.start.line >= placed.start && order(e) < order(target) && isImage(e.link)).length;
  return { subpath: placed.subpath, imageIndex, notices: oneNotice(notices) };
}
