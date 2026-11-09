import { noteBlockId, REINDEX_TIMEOUT_MS, type NoteHost } from "../../src/links/note-block-id";

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
function setup(options: { open?: boolean; editorText?: string; reindexTo?: Cache | null; indexed?: boolean } = {}) {
  const files = new Map([["Notes/a.md", TEXT]]);
  let cache: Cache | null = options.indexed === false ? null : cacheOf(TEXT);
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
    files.set(path, edit(files.get(path)!));
  });
  const saveAndReindex = vi.fn(async (path: string, _timeoutMs: number) => {
    files.set(path, editor!.text);
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
    process,
  };
  let n = 0;
  const random = () => [0.1, 0.2, 0.3][n++ % 3];
  return { host, files, editor, process, saveAndReindex, random, setCache: (c: Cache | null) => void (cache = c) };
}

describe("noteBlockId", () => {
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
