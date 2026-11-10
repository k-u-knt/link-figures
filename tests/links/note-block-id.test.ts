import { CommandError } from "../../src/registry/command";
import { BlockIdQueue, noteBlockId, REINDEX_TIMEOUT_MS, writableEditor, type NoteHost } from "../../src/links/note-block-id";
import { parseNote } from "../../src/links/note-drop";

const TEXT = ["# Results", "", "The cells divide.", "", "| a |", "| - |", "", "Has one ^old-1"].join("\n");

/** A cache position over lines `start`..`end` of `text`, with the columns and offsets Obsidian gives (end: the end of the last line). */
function posIn(text: string, start: number, end: number) {
  const lines = text.split("\n");
  const offset = (line: number) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  return {
    start: { line: start, col: 0, offset: offset(start) },
    end: { line: end, col: lines[end].length, offset: offset(end) + lines[end].length },
  };
}

/** The cache Obsidian would make of TEXT, with every line moved down by `shift` (lines added above). */
function cacheOf(text: string, shift = 0) {
  return {
    sections: [
      { type: "heading", position: posIn(text, 0 + shift, 0 + shift) },
      { type: "paragraph", position: posIn(text, 2 + shift, 2 + shift) },
      { type: "table", position: posIn(text, 4 + shift, 5 + shift) },
      { type: "paragraph", position: posIn(text, 7 + shift, 7 + shift), id: "old-1" },
    ],
    blocks: { "old-1": { id: "old-1", position: posIn(text, 7 + shift, 7 + shift) } },
  };
}

type Cache = ReturnType<typeof cacheOf>;

/**
 * A vault with one note, `Notes/a.md`, and its cache; with `open`, an editor has it open (holding `editorText`, else
 * the file's). Saving the editor writes its text to the file; the cache is then `reindexTo` (null: the wait times out).
 */
/**
 * With `lagging`, the cache follows the file as Obsidian's does: a moment after each write (and at once on a save of
 * the editor), and `nextIndex` resolves on that.
 */
function setup(options: { open?: boolean; editorText?: string; reindexTo?: Cache | null; indexed?: boolean; lagging?: boolean } = {}) {
  const files = new Map([["Notes/a.md", TEXT]]);
  let cache: Cache | ReturnType<typeof parseNote> | null = options.indexed === false ? null : cacheOf(TEXT);
  const indexListeners = new Set<() => void>();
  const reindex = () => {
    cache = parseNote(files.get("Notes/a.md")!);
    for (const listener of [...indexListeners]) listener();
  };
  const editor = options.open
    ? {
        text: options.editorText ?? TEXT,
        getValue() {
          return this.text;
        },
        transaction: vi.fn(function (this: { text: string }, tx: { changes: { from: { line: number; ch: number }; text: string }[] }) {
          const lines = this.text.split("\n");
          for (const c of tx.changes) lines[c.from.line] = lines[c.from.line].slice(0, c.from.ch) + c.text + lines[c.from.line].slice(c.from.ch);
          this.text = lines.join("\n");
        }),
      }
    : null;
  const process = vi.fn(async (path: string, edit: (t: string) => string) => {
    const before = files.get(path)!;
    files.set(path, edit(before));
    if (options.lagging && files.get(path) !== before) setTimeout(reindex, 5);
  });
  const saveAndReindex = vi.fn(async (path: string, _timeoutMs: number) => {
    files.set(path, editor!.text);
    if (options.lagging) {
      reindex();
      return true;
    }
    if (!options.reindexTo) return false;
    cache = options.reindexTo;
    return true;
  });
  const host: NoteHost = {
    resolve: (path) => (files.has(path) ? path : files.has(`${path}.md`) ? `${path}.md` : null),
    cache: (path) => (files.has(path) ? cache : null),
    read: async (path) => files.get(path)!,
    editor: () => editor,
    saveAndReindex,
    nextIndex: vi.fn((_path: string, _timeoutMs: number) => {
      let settle: (indexed: boolean) => void = () => undefined;
      const indexed = new Promise<boolean>((resolve) => (settle = resolve));
      const listener = () => {
        indexListeners.delete(listener);
        settle(true);
      };
      indexListeners.add(listener);
      return {
        indexed,
        cancel: () => {
          indexListeners.delete(listener);
          settle(false);
        },
      };
    }),
    process,
  };
  let n = 0;
  const random = () => [0.1, 0.2, 0.3][n++ % 3];
  return { host, files, editor, process, saveAndReindex, random, indexListeners, setCache: (c: Cache | null) => void (cache = c) };
}

describe("noteBlockId", () => {
  test("a figure file is refused, never written", async () => {
    const s = setup();
    s.files.set("Figs/plate.lnkfig.md", TEXT);
    await expect(noteBlockId(s.host, "Figs/plate.lnkfig", 2, "fig", s.random)).rejects.toThrow(
      new CommandError('note.block-id: "Figs/plate.lnkfig.md" is a figure, not a note'),
    );
    await expect(noteBlockId(s.host, "Figs/plate.lnkfig", 2, "fig", s.random)).rejects.toBeInstanceOf(CommandError);
    expect(s.process).not.toHaveBeenCalled();
    expect(s.files.get("Figs/plate.lnkfig.md")).toBe(TEXT);
  });

  test("a figure marked only by its front matter (no `.lnkfig.md` suffix) is refused too, never written", async () => {
    const s = setup();
    s.files.set("Figs/marked.md", TEXT);
    s.setCache({ ...cacheOf(TEXT), frontmatter: { "link-figures": "0.4.0" } } as Cache);
    await expect(noteBlockId(s.host, "Figs/marked", 2, "fig", s.random)).rejects.toThrow(new CommandError('note.block-id: "Figs/marked.md" is a figure, not a note'));
    // Through the queue, as `api.blockId` writes, the same.
    await expect(new BlockIdQueue(() => s.host, () => "fig", s.random).blockId("Figs/marked.md", 2)).rejects.toBeInstanceOf(CommandError);
    expect(s.process).not.toHaveBeenCalled();
    expect(s.editor).toBeNull();
    expect(s.files.get("Figs/marked.md")).toBe(TEXT);
  });

  test("a block without an id gets a new one, written into the file when the note is not open", async () => {
    const s = setup();
    const result = await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random);
    expect(result.id).toMatch(/^fig-[0-9a-z]{4}$/);
    expect(result.subpath).toBe(`#^${result.id}`);
    expect(s.files.get("Notes/a.md")!.split("\n")[2]).toBe(`The cells divide. ^${result.id}`);
  });

  test("a note named without .md is found", async () => {
    const s = setup();
    const { id } = await noteBlockId(s.host, "Notes/a", 2, "fig", s.random);
    expect(s.files.get("Notes/a.md")).toContain(`^${id}`);
  });

  test("an id the block has is returned and nothing is written", async () => {
    const s = setup();
    expect(await noteBlockId(s.host, "Notes/a.md", 7, "fig", s.random)).toEqual({ id: "old-1", subpath: "#^old-1" });
    expect(s.process).not.toHaveBeenCalled();
    expect(s.files.get("Notes/a.md")).toBe(TEXT);
  });

  test("a table gets its id on a line of its own after it", async () => {
    const s = setup();
    const { id } = await noteBlockId(s.host, "Notes/a.md", 5, "tab", s.random);
    expect(s.files.get("Notes/a.md")!.split("\n").slice(4, 9)).toEqual(["| a |", "| - |", "", `^${id}`, ""]);
  });

  test("when the note is open and saved, the id goes in through its editor, as one change, and the file is not written", async () => {
    const s = setup({ open: true });
    const { id } = await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random);
    expect(s.saveAndReindex).not.toHaveBeenCalled();
    expect(s.editor!.transaction).toHaveBeenCalledTimes(1);
    expect(s.editor!.transaction).toHaveBeenCalledWith({ changes: [{ from: { line: 2, ch: 17 }, text: ` ^${id}` }] });
    expect(s.editor!.text.split("\n")[2]).toBe(`The cells divide. ^${id}`);
    expect(s.process).not.toHaveBeenCalled();
  });

  test("a note open only in Reading view is written with process, not through that view's editor", async () => {
    const s = setup({ open: true });
    s.host.editor = () => writableEditor([{ getMode: () => "preview", editor: s.editor! }]);
    const { id } = await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random);
    expect(s.editor!.transaction).not.toHaveBeenCalled();
    expect(s.process).toHaveBeenCalledTimes(1);
    expect(s.files.get("Notes/a.md")!.split("\n")[2]).toBe(`The cells divide. ^${id}`);
  });

  test("an id in the editor's text is returned and nothing is written", async () => {
    const edited = TEXT.replace("The cells divide.", "The cells divide. ^ed-1");
    const s = setup({ open: true, editorText: edited, reindexTo: cacheOf(edited) });
    expect((await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random)).id).toBe("ed-1");
    expect(s.editor!.transaction).not.toHaveBeenCalled();
  });

  test("an editor ahead of the file, with a line more above the block: saved, and the cache waited for", async () => {
    const edited = `New first line\n${TEXT}`;
    const s = setup({ open: true, editorText: edited, reindexTo: cacheOf(edited, 1) });
    // Line 3 of the edited text is the paragraph that was line 2.
    const { id } = await noteBlockId(s.host, "Notes/a.md", 3, "fig", s.random);
    expect(s.saveAndReindex).toHaveBeenCalledWith("Notes/a.md", REINDEX_TIMEOUT_MS);
    expect(s.editor!.text.split("\n")[3]).toBe(`The cells divide. ^${id}`);
  });

  test("an editor ahead of the file whose cache does not catch up in time: refused, nothing written", async () => {
    const edited = `New first line\n${TEXT}`;
    const s = setup({ open: true, editorText: edited, reindexTo: null });
    await expect(noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random)).rejects.toThrow(/the note "Notes\/a.md" has changed; try again/);
    expect(s.saveAndReindex).toHaveBeenCalled();
    expect(s.editor!.transaction).not.toHaveBeenCalled();
    expect(s.editor!.text).toBe(edited);
  });

  test("an editor ahead of the file only below the block, whose cache does not catch up in time: refused at once, nothing written", async () => {
    // The block's places would still hold in the editor's text, so only the time-out can refuse this.
    const edited = TEXT.replace("Has one ^old-1", "Has one more ^old-1");
    const s = setup({ open: true, editorText: edited, reindexTo: null });
    await expect(noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random)).rejects.toThrow(/the note "Notes\/a.md" has changed; try again/);
    expect(s.editor!.transaction).not.toHaveBeenCalled();
    expect(s.editor!.text).toBe(edited);
  });

  test("a file newer than its cache (just after a write): refused, nothing written", async () => {
    const s = setup();
    s.files.set("Notes/a.md", `Added\n${TEXT}`);
    await expect(noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random)).rejects.toThrow(/has changed; try again/);
    expect(s.process).not.toHaveBeenCalled();
  });

  test("a file that changes between the read and the write: refused inside the write, nothing written", async () => {
    const s = setup();
    s.process.mockImplementationOnce(async (path: string, edit: (t: string) => string) => {
      s.files.set(path, edit(`Added\n${TEXT}`));
    });
    await expect(noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random)).rejects.toThrow(/has changed; try again/);
    expect(s.files.get("Notes/a.md")).toBe(TEXT);
  });

  test("a new id is not one the note has", async () => {
    const taken = `fig-${Math.floor(0.1 * 36 ** 4).toString(36).padStart(4, "0")}`;
    const text = TEXT.replace("Has one ^old-1", `Has one ^${taken}`);
    const s = setup();
    s.files.set("Notes/a.md", text);
    s.setCache(cacheOf(text));
    const { id } = await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random);
    expect(id).not.toBe(taken);
  });

  test.each([
    ["a heading line", 0, /heading/],
    ["a blank line", 1, /not in a block/],
    ["a line past the end", 50, /not in a block/],
    ["a negative line", -1, /line/],
    ["a fractional line", 1.5, /line/],
  ])("refuses %s, writing nothing", async (_what, line, message) => {
    const s = setup();
    await expect(noteBlockId(s.host, "Notes/a.md", line, "fig", s.random)).rejects.toThrow(message);
    expect(s.process).not.toHaveBeenCalled();
  });

  test("refuses a note that is not there, and one that is not indexed yet", async () => {
    await expect(noteBlockId(setup().host, "Notes/none.md", 2, "fig")).rejects.toThrow(/no note/);
    await expect(noteBlockId(setup({ indexed: false }).host, "Notes/a.md", 2, "fig")).rejects.toThrow(/not indexed yet/);
  });
});

describe("BlockIdQueue: one note's ids are written one after another", () => {
  const queue = (s: ReturnType<typeof setup>) => new BlockIdQueue(() => s.host, () => "fig", s.random);

  test("without the queue, a second id right after a write to a closed note is refused (the cache is behind the file)", async () => {
    const s = setup({ lagging: true });
    await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random);
    await expect(noteBlockId(s.host, "Notes/a.md", 4, "fig", s.random)).rejects.toThrow(/has changed; try again/);
  });

  test("a closed note: two calls in a row both write, the second once the cache has indexed the first", async () => {
    const s = setup({ lagging: true });
    const q = queue(s);
    const first = await q.blockId("Notes/a.md", 2);
    const second = await q.blockId("Notes/a.md", 4);
    expect(first.id).not.toBe(second.id);
    const lines = s.files.get("Notes/a.md")!.split("\n");
    expect(lines[2]).toBe(`The cells divide. ^${first.id}`);
    expect(lines.slice(4, 8)).toEqual(["| a |", "| - |", "", `^${second.id}`]);
    // The second write's listener goes once the cache has indexed it.
    await vi.waitFor(() => expect(s.indexListeners.size).toBe(0));
  });

  test("a closed note: two calls in one task (not awaited between) both write", async () => {
    const s = setup({ lagging: true });
    const q = queue(s);
    const [first, second] = await Promise.all([q.blockId("Notes/a.md", 2), q.blockId("Notes/a", 4)]);
    expect(s.files.get("Notes/a.md")).toContain(`The cells divide. ^${first.id}`);
    expect(s.files.get("Notes/a.md")).toContain(`\n^${second.id}`);
  });

  test("an open note: two drops in one task both write through the editor; the editor is saved and indexed after each write", async () => {
    const s = setup({ open: true, lagging: true });
    const q = queue(s);
    const [first, second] = await Promise.all([q.blockId("Notes/a.md", 2), q.blockId("Notes/a.md", 4)]);
    expect(s.editor!.transaction).toHaveBeenCalledTimes(2);
    expect(s.editor!.text.split("\n")[2]).toBe(`The cells divide. ^${first.id}`);
    expect(s.editor!.text).toContain(`\n^${second.id}`);
    expect(s.saveAndReindex).toHaveBeenCalledWith("Notes/a.md", REINDEX_TIMEOUT_MS);
  });

  test("a refusal does not hold up the next call, and a call that writes nothing does not wait for the cache", async () => {
    const s = setup({ lagging: true });
    const q = queue(s);
    await expect(q.blockId("Notes/a.md", 0)).rejects.toThrow(/heading/);
    expect(await q.blockId("Notes/a.md", 7)).toEqual({ id: "old-1", subpath: "#^old-1" });
    expect(s.indexListeners.size).toBe(0);
    expect((await q.blockId("Notes/a.md", 2)).id).toMatch(/^fig-/);
  });

  test("a paragraph typed at the end of an open note and given an id at once: saved, indexed, then written", async () => {
    const edited = `${TEXT}\n\nSecond fresh paragraph.`;
    const s = setup({ open: true, editorText: edited, lagging: true });
    const { id } = await queue(s).blockId("Notes/a.md", 9);
    expect(s.editor!.text.split("\n")[9]).toBe(`Second fresh paragraph. ^${id}`);
  });
});

describe("writableEditor", () => {
  test("the editor of the first view of the note that is not in Reading view; null when every one is", () => {
    const a = { getValue: () => "a", transaction: () => undefined };
    const b = { getValue: () => "b", transaction: () => undefined };
    expect(writableEditor([])).toBeNull();
    expect(writableEditor([{ getMode: () => "preview", editor: a }])).toBeNull();
    expect(writableEditor([{ getMode: () => "source", editor: a }])).toBe(a);
    expect(writableEditor([{ getMode: () => "preview", editor: a }, { getMode: () => "source", editor: b }])).toBe(b);
  });
});
