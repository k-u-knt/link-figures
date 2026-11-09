import { noteBlockId, type NoteHost } from "../../src/links/note-block-id";

const pos = (start: number, end: number) => ({ start: { line: start }, end: { line: end } });

const TEXT = ["# Results", "", "The cells divide.", "", "| a |", "| - |", "", "Has one ^old-1"].join("\n");
const CACHE = {
  sections: [
    { type: "heading", position: pos(0, 0) },
    { type: "paragraph", position: pos(2, 2) },
    { type: "table", position: pos(4, 5) },
    { type: "paragraph", position: pos(7, 7), id: "old-1" },
  ],
  blocks: { "old-1": { id: "old-1", position: pos(7, 7) } },
};

/** A vault with one note, `Notes/a.md`; with `open`, an editor has it open (holding `editorText`, else the file's). */
function setup(options: { open?: boolean; editorText?: string } = {}) {
  const files = new Map([["Notes/a.md", TEXT]]);
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
  const host: NoteHost = {
    resolve: (path) => (files.has(path) ? path : files.has(`${path}.md`) ? `${path}.md` : null),
    cache: (path) => (files.has(path) ? CACHE : null),
    editor: () => editor,
    process,
  };
  let n = 0;
  const random = () => [0.1, 0.2, 0.3][n++ % 3];
  return { host, files, editor, process, random };
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

  test("an id already written in the text (the cache not yet caught up) is returned and nothing is written", async () => {
    const s = setup();
    s.files.set("Notes/a.md", TEXT.replace("The cells divide.", "The cells divide. ^new-9"));
    expect((await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random)).id).toBe("new-9");
    expect(s.files.get("Notes/a.md")).toBe(TEXT.replace("The cells divide.", "The cells divide. ^new-9"));
  });

  test("a table gets its id on a line of its own after it", async () => {
    const s = setup();
    const { id } = await noteBlockId(s.host, "Notes/a.md", 5, "tab", s.random);
    expect(s.files.get("Notes/a.md")!.split("\n").slice(4, 9)).toEqual(["| a |", "| - |", "", `^${id}`, ""]);
  });

  test("when the note is open, the id goes in through its editor, as one change, and the file is not written", async () => {
    const s = setup({ open: true });
    const { id } = await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random);
    expect(s.editor!.transaction).toHaveBeenCalledTimes(1);
    expect(s.editor!.transaction).toHaveBeenCalledWith({ changes: [{ from: { line: 2, ch: 17 }, text: ` ^${id}` }] });
    expect(s.editor!.text.split("\n")[2]).toBe(`The cells divide. ^${id}`);
    expect(s.process).not.toHaveBeenCalled();
  });

  test("an id in the editor's text is returned and nothing is written", async () => {
    const s = setup({ open: true, editorText: TEXT.replace("The cells divide.", "The cells divide. ^ed-1") });
    expect((await noteBlockId(s.host, "Notes/a.md", 2, "fig", s.random)).id).toBe("ed-1");
    expect(s.editor!.transaction).not.toHaveBeenCalled();
  });

  test("a new id is not one the note has", async () => {
    const s = setup();
    // The first draw would be the id the note has.
    const taken = `fig-${Math.floor(0.1 * 36 ** 4).toString(36).padStart(4, "0")}`;
    s.files.set("Notes/a.md", TEXT.replace("Has one ^old-1", `Has one ^${taken}`));
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

  test("refuses a note that is not there", async () => {
    const s = setup();
    await expect(noteBlockId(s.host, "Notes/none.md", 2, "fig", s.random)).rejects.toThrow(/no note/);
  });
});
