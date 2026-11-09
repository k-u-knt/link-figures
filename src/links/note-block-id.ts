import {
  blockAt,
  blockIdInsertion,
  blockIdInText,
  blockMatchesText,
  existingBlockId,
  idPlacement,
  idsInText,
  insertBlockId,
  newBlockId,
  type Block,
  type BlockLike,
  type BlocksCache,
  type LinePos,
} from "./block-id";

/** What `api.blockId` resolves to: the block's id and the subpath that links it (`#^id`). */
export interface BlockIdResult {
  id: string;
  subpath: string;
}

/** The slice of an Obsidian `Editor` that writes an id: its text, and one change made as an editor transaction. */
export interface NoteEditorLike {
  getValue(): string;
  transaction(tx: { changes: { from: { line: number; ch: number }; text: string }[] }): void;
}

/** The slice of a Markdown view `writableEditor` reads: its mode (`"source"` or `"preview"`) and its editor. */
export interface MarkdownViewLike<E> {
  getMode(): string;
  editor: E;
}

/**
 * The editor to write a note through, of the views that have it open: the first that is not in Reading view
 * (`"preview"`). A Reading view's editor is not what the user sees, so an id written through it may not be saved; null
 * then, and the file is written with `process`.
 */
export function writableEditor<E>(views: readonly MarkdownViewLike<E>[]): E | null {
  return views.find((view) => view.getMode() !== "preview")?.editor ?? null;
}

/** What `noteBlockId` needs of Obsidian, so that it can be tested without it. */
export interface NoteHost {
  /** The vault path of the note `path` names (with or without `.md`), or null when there is none. */
  resolve(path: string): string | null;
  /** The note's metadata cache (sections, list items, block ids), or null when it has not been indexed. */
  cache(path: string): NoteCache | null;
  /** The note's text as the vault last read or wrote it (`vault.cachedRead`): what the cache was made from, once it has caught up. */
  read(path: string): Promise<string>;
  /** The editor of a Markdown view that has the note open, not in Reading view (`writableEditor`), or null when none has. */
  editor(path: string): NoteEditorLike | null;
  /**
   * Saves the open view of the note and waits for the metadata cache to index it again (its "changed" event for the
   * note), at most `timeoutMs`. Resolves true when it did, false on the time-out.
   */
  saveAndReindex(path: string, timeoutMs: number): Promise<boolean>;
  /** Reads the note, passes its text to `edit` and writes what it returns, with no other write between (`vault.process`). */
  process(path: string, edit: (text: string) => string): Promise<void>;
}

/** What is read of a note's metadata cache (`CachedMetadata`): its blocks, block ids, headings and embeds. */
export type NoteCache = BlocksCache & {
  blocks?: Record<string, BlockLike>;
  headings?: { heading: string; level: number; position: LinePos }[];
  embeds?: { link: string; position: LinePos }[];
};

/** How long to wait for the metadata cache to index an open note that has just been saved. */
export const REINDEX_TIMEOUT_MS = 2000;

const result = (id: string): BlockIdResult => ({ id, subpath: `#^${id}` });

/**
 * The block id of the block that holds `line` (0-based) of the note at `notePath`: the one it has, or a new one
 * (`<prefix>-<4 base36>`, unique in the note) written into it. A note that is open in an editor gets the id through that
 * editor, as one transaction, so it is in the editor's undo history; otherwise the file is changed with `process`.
 *
 * The cache's line numbers are only used on the text the cache was made from: an open note whose editor is ahead of
 * the file is saved first and the cache waited for (`REINDEX_TIMEOUT_MS`), and the block's places in the cache are
 * checked against the text about to be changed (`blockMatchesText`); when they do not hold, nothing is written and it
 * throws "the note has changed; try again". Nothing is written when the block has an id already (in the cache or in the
 * text). Also throws for a line that is not a whole number from 0, a note that is not there or not indexed yet, a line
 * in no block, a heading (linked by its heading instead) and a block that cannot hold an id (front matter, a rule, HTML).
 */
export async function noteBlockId(host: NoteHost, notePath: string, line: number, prefix: string, random: () => number = Math.random): Promise<BlockIdResult> {
  if (!Number.isInteger(line) || line < 0) throw new Error(`blockId: "line" must be a whole number from 0, not ${String(line)}`);
  const path = host.resolve(notePath);
  if (path === null) throw new Error(`blockId: there is no note "${notePath}"`);

  /** The block at `line` by the cache as it is now, checked against `text`; and the cache's id for it, if any. */
  const locate = (text: string): { block: Block; cache: NoteCache; cached: string | null } => {
    const cache = host.cache(path);
    if (cache === null) throw new Error(`blockId: the note "${path}" is not indexed yet; try again`);
    const block = blockAt(cache, line);
    if (!block) throw new Error(`blockId: line ${line} of "${path}" is not in a block`);
    if (!blockMatchesText(text, block)) throw new Error(`blockId: the note "${path}" has changed; try again`);
    if (block.type === "heading") throw new Error(`blockId: line ${line} of "${path}" is a heading; link it by its heading (#Heading), not a block id`);
    if (idPlacement(block.type) === null) throw new Error(`blockId: line ${line} of "${path}" is in a ${block.type} block, which cannot hold a block id`);
    return { block, cache, cached: existingBlockId(cache.blocks, block) };
  };
  const taken = (cache: NoteCache, text: string) => [...Object.keys(cache.blocks ?? {}), ...idsInText(text)];

  const editor = host.editor(path);
  if (editor) {
    // Unsaved edits are newer than the cache: save them and let the cache catch up before its lines are trusted.
    // A cache that did not catch up in time cannot be trusted, even where its places happen to hold.
    if (editor.getValue() !== (await host.read(path)) && !(await host.saveAndReindex(path, REINDEX_TIMEOUT_MS))) {
      throw new Error(`blockId: the note "${path}" has changed; try again`);
    }
    const text = editor.getValue();
    const { block, cache, cached } = locate(text);
    if (cached) return result(cached);
    const lines = text.split("\n");
    const written = blockIdInText(lines, block);
    if (written) return result(written);
    const id = newBlockId(prefix, taken(cache, text), random);
    const at = blockIdInsertion(lines, block, id);
    editor.transaction({ changes: [{ from: { line: at.line, ch: at.ch }, text: at.text }] });
    return result(id);
  }

  const { cached } = locate(await host.read(path));
  if (cached) return result(cached);
  let id = "";
  await host.process(path, (text) => {
    // The file as it is now: checked again, since it may have changed while it was read.
    const { block, cache } = locate(text);
    const written = blockIdInText(text.split("\n"), block);
    if (written) {
      id = written;
      return text;
    }
    id = newBlockId(prefix, taken(cache, text), random);
    return insertBlockId(text, block, id);
  });
  return result(id);
}
