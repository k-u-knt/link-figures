import {
  blockAt,
  blockIdInsertion,
  blockIdInText,
  existingBlockId,
  idPlacement,
  idsInText,
  insertBlockId,
  newBlockId,
  type BlockLike,
  type BlocksCache,
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

/** What `noteBlockId` needs of Obsidian, so that it can be tested without it. */
export interface NoteHost {
  /** The vault path of the note `path` names (with or without `.md`), or null when there is none. */
  resolve(path: string): string | null;
  /** The note's metadata cache (sections, list items, block ids), or null when it has none. */
  cache(path: string): (BlocksCache & { blocks?: Record<string, BlockLike> }) | null;
  /** The editor of a Markdown view that has the note open, or null when none has. */
  editor(path: string): NoteEditorLike | null;
  /** Reads the note, passes its text to `edit` and writes what it returns, with no other write between (`vault.process`). */
  process(path: string, edit: (text: string) => string): Promise<void>;
}

const result = (id: string): BlockIdResult => ({ id, subpath: `#^${id}` });

/**
 * The block id of the block that holds `line` (0-based) of the note at `notePath`: the one it has, or a new one
 * (`<prefix>-<4 base36>`, unique in the note) written into it. A note that is open in an editor gets the id through that
 * editor, as one transaction, so it is in the editor's undo history; otherwise the file is changed with `process`.
 * Nothing is written when the block has an id already (in the cache or in the text). Throws for a line that is not a
 * whole number from 0, a note that is not there, a line in no block, a heading (linked by its heading instead) and a
 * block that cannot hold an id (front matter, a rule, HTML).
 */
export async function noteBlockId(host: NoteHost, notePath: string, line: number, prefix: string, random: () => number = Math.random): Promise<BlockIdResult> {
  if (!Number.isInteger(line) || line < 0) throw new Error(`blockId: "line" must be a whole number from 0, not ${String(line)}`);
  const path = host.resolve(notePath);
  const cache = path === null ? null : host.cache(path);
  if (path === null || cache === null) throw new Error(`blockId: there is no note "${notePath}"`);
  const block = blockAt(cache, line);
  if (!block) throw new Error(`blockId: line ${line} of "${path}" is not in a block`);
  if (block.type === "heading") throw new Error(`blockId: line ${line} of "${path}" is a heading; link it by its heading (#Heading), not a block id`);
  if (idPlacement(block.type) === null) throw new Error(`blockId: line ${line} of "${path}" is in a ${block.type} block, which cannot hold a block id`);

  const cached = existingBlockId(cache.blocks, block);
  if (cached) return result(cached);
  const taken = (text: string) => [...Object.keys(cache.blocks ?? {}), ...idsInText(text)];

  const editor = host.editor(path);
  if (editor) {
    const text = editor.getValue();
    const lines = text.split("\n");
    const written = blockIdInText(lines, block);
    if (written) return result(written);
    const id = newBlockId(prefix, taken(text), random);
    const at = blockIdInsertion(lines, block, id);
    editor.transaction({ changes: [{ from: { line: at.line, ch: at.ch }, text: at.text }] });
    return result(id);
  }

  let id = "";
  await host.process(path, (text) => {
    const written = blockIdInText(text.split("\n"), block);
    if (written) {
      id = written;
      return text;
    }
    id = newBlockId(prefix, taken(text), random);
    return insertBlockId(text, block, id);
  });
  return result(id);
}
