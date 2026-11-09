import { linkForImage, linkForText, matchSelection, parseNote, type NoteDropHost } from "../../src/links/note-drop";

const TEXT = [
  "Intro line with no heading.", // 0
  "", // 1
  "# Results", // 2
  "", // 3
  "The cells divide.", // 4
  "", // 5
  "## Growth", // 6
  "", // 7
  "- one", // 8
  "- two ^li-2", // 9
  "", // 10
  "![[a.png]] and ![[b.png]]", // 11
  "", // 12
  "# Discussion", // 13
  "", // 14
  "Plain paragraph.", // 15
  "![[a.png]]", // 16
].join("\n");

const PATH = "Notes/a.md";

/** A note with its cache (as `parseNote` makes it, else `cache`); with `editorText`, open in an editor holding that text. */
function setup(options: { text?: string; cache?: ReturnType<typeof parseNote> | null; editorText?: string; reindexes?: boolean } = {}) {
  const text = options.text ?? TEXT;
  const cache = options.cache === undefined ? parseNote(text) : options.cache;
  const editor = options.editorText === undefined ? null : { getValue: () => options.editorText!, transaction: vi.fn() };
  const host: NoteDropHost & { blockId: ReturnType<typeof vi.fn>; saveAndReindex: ReturnType<typeof vi.fn> } = {
    cache: () => cache,
    read: async () => text,
    editor: () => editor,
    saveAndReindex: vi.fn(async () => options.reindexes ?? false),
    blockId: vi.fn(async () => ({ id: "fig-new1", subpath: "#^fig-new1" })),
  };
  return host;
}

/** Obsidian's cache for a list: each item's range takes in the items nested in it (by indent). */
function obsidianNested(text: string): ReturnType<typeof parseNote> {
  const cache = parseNote(text);
  const lines = text.split("\n");
  const indent = (n: number) => lines[n].length - lines[n].trimStart().length;
  for (const item of cache.listItems ?? []) {
    const start = item.position.start.line;
    let end = start;
    while (end + 1 < lines.length && lines[end + 1].trim() !== "" && indent(end + 1) > indent(start)) end++;
    item.position = { start: item.position.start, end: { line: end, col: lines[end].length, offset: text.split("\n").slice(0, end).join("\n").length + (end > 0 ? 1 : 0) + lines[end].length } };
  }
  return cache;
}

describe("matchSelection", () => {
  const range = (fromLine: number, fromCh: number, toLine: number, toCh: number) => ({ anchor: { line: fromLine, ch: fromCh }, head: { line: toLine, ch: toCh } });

  test("the note whose selection is the dropped text, line endings aside, with its first and last lines", () => {
    const note = { path: "B.md", selection: "The cells\r\ndivide.", ranges: [range(5, 3, 4, 0)] };
    expect(matchSelection(note, "The cells\ndivide.")).toEqual({ path: "B.md", from: 4, to: 5 });
    expect(matchSelection(note, "nothing")).toBeNull();
    expect(matchSelection(null, "The cells\ndivide.")).toBeNull();
  });

  test("a selection that ends at the start of a line ends on the line before it", () => {
    expect(matchSelection({ path: "A.md", selection: "whole line\n", ranges: [range(3, 0, 4, 0)] }, "whole line\n")).toEqual({ path: "A.md", from: 3, to: 3 });
  });

  test("an empty selection, or blank text, never matches", () => {
    expect(matchSelection({ path: "A.md", selection: "", ranges: [range(1, 0, 1, 0)] }, "")).toBeNull();
    expect(matchSelection({ path: "A.md", selection: "  ", ranges: [range(1, 0, 1, 2)] }, "  ")).toBeNull();
  });

  test("multi-cursor: empty cursors are left out; more than one non-empty range is not matched", () => {
    const one = { path: "A.md", selection: "cells", ranges: [range(0, 0, 0, 0), range(7, 2, 7, 7), range(9, 1, 9, 1)] };
    expect(matchSelection(one, "cells")).toEqual({ path: "A.md", from: 7, to: 7 });
    const two = { path: "A.md", selection: "cells\ncells", ranges: [range(2, 0, 2, 5), range(7, 2, 7, 7)] };
    expect(matchSelection(two, "cells\ncells")).toBeNull();
  });
});

describe("parseNote", () => {
  test("finds the blocks, list items, headings and embeds Obsidian's cache would", () => {
    const cache = parseNote(TEXT);
    expect(cache.sections!.map((s) => [s.type, s.position.start.line, s.position.end.line])).toEqual([
      ["paragraph", 0, 0],
      ["heading", 2, 2],
      ["paragraph", 4, 4],
      ["heading", 6, 6],
      ["list", 8, 9],
      ["paragraph", 11, 11],
      ["heading", 13, 13],
      ["paragraph", 15, 16],
    ]);
    expect(cache.listItems!.map((i) => i.position.start.line)).toEqual([8, 9]);
    expect(cache.headings!.map((h) => [h.heading, h.level, h.position.start.line])).toEqual([
      ["Results", 1, 2],
      ["Growth", 2, 6],
      ["Discussion", 1, 13],
    ]);
    expect(cache.embeds!.map((e) => [e.link, e.position.start.line, e.position.start.col])).toEqual([
      ["a.png", 11, 0],
      ["b.png", 11, 15],
      ["a.png", 16, 0],
    ]);
    expect(cache.embeds![1].position.start.offset).toBe(TEXT.indexOf("![[b.png]]"));
  });

  test("code, tables, quotes and front matter are blocks of their own; nothing in a fence is a heading or an embed", () => {
    const text = ["---", "a: 1", "---", "```", "# not", "![[x.png]]", "```", "| a |", "| - |", "> quote", "> more", "", "$$", "x", "$$"].join("\n");
    expect(parseNote(text).sections!.map((s) => [s.type, s.position.start.line, s.position.end.line])).toEqual([
      ["yaml", 0, 2],
      ["code", 3, 6],
      ["table", 7, 8],
      ["blockquote", 9, 10],
      ["math", 12, 14],
    ]);
    expect(parseNote(text).headings).toEqual([]);
    expect(parseNote(text).embeds).toEqual([]);
  });

  test("a list item's range takes in the items nested in it, as Obsidian's cache does", () => {
    const text = ["- a", "  - b", "    - c", "  - d", "- e"].join("\n");
    expect(parseNote(text).listItems!.map((i) => [i.position.start.line, i.position.end.line])).toEqual([
      [0, 3],
      [1, 2],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });

  test("a list item starts a new block after a paragraph line, without a blank line", () => {
    for (const marker of ["- ", "* ", "1. ", "1) "]) {
      const text = ["Para line.", `${marker}item`, `${marker}item`].join("\n");
      const cache = parseNote(text);
      expect(cache.sections!.map((s) => [s.type, s.position.start.line, s.position.end.line])).toEqual([
        ["paragraph", 0, 0],
        ["list", 1, 2],
      ]);
      expect(cache.listItems!.map((i) => i.position.start.line)).toEqual([1, 2]);
    }
    // As CommonMark has it: an ordered item from another number, or an empty item, goes on the paragraph.
    for (const line of ["2020. was a year", "-"]) expect(parseNote(`Para line.\n${line}`).sections!.map((s) => s.type)).toEqual(["paragraph"]);
  });
});

describe("linkForText", () => {
  test("block-id: a paragraph without an id gets one through blockId, at its first line", async () => {
    const host = setup();
    expect(await linkForText(host, "block-id", PATH, 4, 4)).toEqual({ subpath: "#^fig-new1", notices: [] });
    expect(host.blockId).toHaveBeenCalledWith(PATH, 4);
  });

  test("an id the block has wins, in 'block-id' and in 'heading' mode; nothing is written", async () => {
    for (const mode of ["block-id", "heading"] as const) {
      const host = setup();
      expect(await linkForText(host, mode, PATH, 9, 9)).toEqual({ subpath: "#^li-2", notices: [] });
      expect(host.blockId).not.toHaveBeenCalled();
    }
  });

  test("heading: the nearest heading above the block, and nothing is written", async () => {
    const host = setup();
    expect(await linkForText(host, "heading", PATH, 4, 4)).toEqual({ subpath: "#Results", notices: [] });
    expect(await linkForText(host, "heading", PATH, 8, 8)).toEqual({ subpath: "#Growth", notices: [] });
    expect(host.blockId).not.toHaveBeenCalled();
  });

  test("heading: a block with no heading above it links the whole note, with a Notice", async () => {
    const host = setup();
    const link = await linkForText(host, "heading", PATH, 0, 0);
    expect(link?.subpath).toBe("");
    expect(link?.notices).toEqual([expect.stringMatching(/no heading above .* so the panel links the whole note/)]);
    expect(host.blockId).not.toHaveBeenCalled();
  });

  test("a heading line links its heading, in both modes", async () => {
    for (const mode of ["block-id", "heading"] as const) {
      const host = setup();
      expect(await linkForText(host, mode, PATH, 6, 6)).toEqual({ subpath: "#Growth", notices: [] });
      expect(host.blockId).not.toHaveBeenCalled();
    }
  });

  test("a selection over several blocks links the smallest heading section that holds them all", async () => {
    const host = setup();
    expect((await linkForText(host, "block-id", PATH, 4, 9))?.subpath).toBe("#Results");
    expect((await linkForText(host, "block-id", PATH, 8, 11))?.subpath).toBe("#Growth");
    // From the heading's own line: that heading's section.
    expect((await linkForText(host, "heading", PATH, 6, 9))?.subpath).toBe("#Growth");
    expect(host.blockId).not.toHaveBeenCalled();
  });

  test("several blocks under no one heading: the first block, with a Notice", async () => {
    const host = setup();
    const link = await linkForText(host, "block-id", PATH, 0, 4);
    expect(link?.subpath).toBe("#^fig-new1");
    expect(host.blockId).toHaveBeenCalledWith(PATH, 0);
    expect(link?.notices).toEqual([expect.stringMatching(/spans several blocks.*links its first block/)]);
  });

  test("a heading whose text another heading has too is linked through the headings above it", async () => {
    const text = ["# A", "## Fig", "x", "# B", "## Fig", "y"].join("\n");
    const host = setup({ text });
    expect((await linkForText(host, "heading", PATH, 5, 5))?.subpath).toBe("#B#Fig");
    expect((await linkForText(host, "heading", PATH, 2, 2))?.subpath).toBe("#A#Fig");
  });

  test("a heading not told apart from an earlier one by its chain (siblings with one text): block-id links its first block, heading links the note", async () => {
    const text = ["# A", "## Fig", "x", "## Fig", "y", "", "z"].join("\n");
    const blockId = setup({ text });
    expect((await linkForText(blockId, "block-id", PATH, 3, 3))?.subpath).toBe("#^fig-new1");
    expect(blockId.blockId).toHaveBeenCalledWith(PATH, 4);
    // A selection over its section, too: the first block of the selection.
    expect((await linkForText(blockId, "block-id", PATH, 4, 6))?.subpath).toBe("#^fig-new1");
    expect(blockId.blockId).toHaveBeenLastCalledWith(PATH, 4);
    const heading = setup({ text });
    const link = await linkForText(heading, "heading", PATH, 4, 4);
    expect(link?.subpath).toBe("");
    expect(link?.notices).toEqual([expect.stringMatching(/heading "Fig" .* is not unique, so the panel links the whole note/)]);
    expect(heading.blockId).not.toHaveBeenCalled();
    // The first of the two is still linked by its heading.
    expect((await linkForText(heading, "heading", PATH, 2, 2))?.subpath).toBe("#A#Fig");
  });

  test("top-level headings with one text: the later one is not unique either", async () => {
    const text = ["# Fig", "x", "# Fig", "y"].join("\n");
    expect((await linkForText(setup({ text }), "heading", PATH, 3, 3))?.subpath).toBe("");
    expect((await linkForText(setup({ text }), "heading", PATH, 1, 1))?.subpath).toBe("#Fig");
    const host = setup({ text });
    expect((await linkForText(host, "block-id", PATH, 2, 2))?.subpath).toBe("#^fig-new1");
    expect(host.blockId).toHaveBeenCalledWith(PATH, 3);
  });

  test("block-id: a block that cannot hold an id, under a heading that is not unique: one message, the outcome's", async () => {
    const text = ["# Fig", "x", "# Fig", "<div>a</div>"].join("\n");
    const cache = parseNote(text);
    cache.sections![3].type = "html";
    const host = setup({ text, cache });
    const link = await linkForText(host, "block-id", PATH, 3, 3);
    expect(link?.subpath).toBe("");
    expect(link?.notices).toEqual([expect.stringMatching(/html block cannot hold a block id, and the heading "Fig" above it .* is not unique, so the panel links the whole note\.$/)]);
    expect(link?.notices[0]).not.toMatch(/the heading above it/);
    expect(host.blockId).not.toHaveBeenCalled();
  });

  test("heading mode gives at most one Notice per drop", async () => {
    // Several blocks under no heading, and no heading above the first: two things to say, in one Notice.
    const link = await linkForText(setup({ text: "a\n\nb" }), "heading", PATH, 0, 2);
    expect(link?.subpath).toBe("");
    expect(link?.notices).toEqual([expect.stringMatching(/spans several blocks.*no heading above/)]);
  });

  test("an image under a heading that is not unique, in heading mode: the whole note, counted across it", async () => {
    const text = ["# Fig", "![[a.png]]", "# Fig", "![[b.png]]"].join("\n");
    const link = await linkForImage(setup({ text }), "heading", PATH, (l) => l === "b.png", () => true);
    expect([link?.subpath, link?.imageIndex, link?.notices.length]).toEqual(["", 1, 1]);
  });

  test("a heading's characters that a link cannot hold are made spaces, as Obsidian does", async () => {
    const host = setup({ text: "# Fig. 2: a|b [c]\n\ntext" });
    expect((await linkForText(host, "heading", PATH, 2, 2))?.subpath).toBe("#Fig. 2 a b c");
  });

  test("a list item with its own nested items is one block: the parent item, by its own line", async () => {
    const text = ["# Fig", "", "- parent", "  - child", "  - child two", "- sibling"].join("\n");
    for (const cache of [parseNote(text), obsidianNested(text)]) {
      const host = setup({ text, cache });
      const link = await linkForText(host, "block-id", PATH, 2, 4);
      expect(link).toEqual({ subpath: "#^fig-new1", notices: [] });
      expect(host.blockId).toHaveBeenCalledWith(PATH, 2);
    }
    // In heading mode it is one block too: the heading above it, without the several-blocks message.
    expect(await linkForText(setup({ text }), "heading", PATH, 2, 3)).toEqual({ subpath: "#Fig", notices: [] });
  });

  test("a list item with its nested items: the parent's id, when it has one", async () => {
    const text = ["- parent ^p1", "  - child"].join("\n");
    const host = setup({ text });
    expect(await linkForText(host, "block-id", PATH, 0, 1)).toEqual({ subpath: "#^p1", notices: [] });
    expect(host.blockId).not.toHaveBeenCalled();
  });

  test("a list item and its sibling are still several blocks", async () => {
    const text = ["- parent", "  - child", "- sibling"].join("\n");
    const host = setup({ text });
    const link = await linkForText(host, "block-id", PATH, 0, 2);
    expect(link?.notices).toEqual([expect.stringMatching(/spans several blocks/)]);
    expect(host.blockId).toHaveBeenCalledWith(PATH, 0);
  });

  test("a selection of blank lines only links nothing", async () => {
    expect(await linkForText(setup(), "block-id", PATH, 1, 1)).toBeNull();
  });

  test("an editor ahead of the file is read from its own text, and not saved by the drop: only blockId, which writes, saves it", async () => {
    const edited = `New\n\n${TEXT}`;
    // The cache is still the old text's: line 6 there is "## Growth", in the edited text it is "The cells divide.".
    for (const mode of ["block-id", "heading"] as const) {
      const host = setup({ editorText: edited, reindexes: true });
      expect(await linkForText(host, mode, PATH, 6, 6)).toEqual({ subpath: mode === "block-id" ? "#^fig-new1" : "#Results", notices: [] });
      expect(host.saveAndReindex).not.toHaveBeenCalled();
    }
  });

  test("block-id: when no id has to be written (an id, a heading, a heading section), blockId is not called, so nothing is saved", async () => {
    const host = setup({ editorText: `${TEXT}\nmore`, reindexes: true });
    await linkForText(host, "block-id", PATH, 9, 9);
    await linkForText(host, "block-id", PATH, 6, 6);
    await linkForText(host, "block-id", PATH, 4, 9);
    expect(host.blockId).not.toHaveBeenCalled();
    expect(host.saveAndReindex).not.toHaveBeenCalled();
  });

  test("a cache whose places do not hold in the text is not used either", async () => {
    const host = setup({ text: `New\n\n${TEXT}`, cache: parseNote(TEXT) });
    expect((await linkForText(host, "heading", PATH, 6, 6))?.subpath).toBe("#Results");
  });

  test("an editor ahead of the file whose cache still fits (a paragraph typed at the end): read with parseNote, so the new paragraph is linked", async () => {
    // Every cached section still holds in the editor's text; only the new lines are unknown to the cache.
    const edited = `${TEXT}\n\nSecond fresh paragraph.`;
    const host = setup({ editorText: edited });
    expect(await linkForText(host, "block-id", PATH, 18, 18)).toEqual({ subpath: "#^fig-new1", notices: [] });
    expect(host.blockId).toHaveBeenCalledWith(PATH, 18);
    expect(host.saveAndReindex).not.toHaveBeenCalled();
  });

  test("a note with no cache and no text links nothing", async () => {
    const host = setup({ cache: null });
    host.read = async () => {
      throw new Error("no file");
    };
    expect(await linkForText(host, "block-id", PATH, 4, 4)).toBeNull();
  });

  test("blockId's refusal is passed on", async () => {
    const host = setup();
    host.blockId.mockRejectedValueOnce(new Error('blockId: the note "Notes/a.md" has changed; try again'));
    await expect(linkForText(host, "block-id", PATH, 4, 4)).rejects.toThrow(/changed; try again/);
  });
});

describe("linkForImage", () => {
  const named = (name: string) => (link: string) => link === name;
  const isImage = (link: string) => /\.png$/.test(link);

  test("block-id: the block holding the embed, by its id, and the embed's index among the block's images", async () => {
    const host = setup();
    expect(await linkForImage(host, "block-id", PATH, named("b.png"), isImage)).toEqual({ subpath: "#^fig-new1", imageIndex: 1, notices: [] });
    expect(host.blockId).toHaveBeenCalledWith(PATH, 11);
  });

  test("an image embedded more than once: the first, with a Notice saying which", async () => {
    const host = setup();
    const link = await linkForImage(host, "block-id", PATH, named("a.png"), isImage);
    expect([link?.subpath, link?.imageIndex]).toEqual(["#^fig-new1", 0]);
    expect(link?.notices).toEqual([expect.stringMatching(/a\.png is embedded 2 times .* the first \(line 12\)/)]);
  });

  test("heading: the nearest heading, with the index counted within its section; nothing is written", async () => {
    const host = setup();
    expect(await linkForImage(host, "heading", PATH, named("b.png"), isImage)).toEqual({ subpath: "#Growth", imageIndex: 1, notices: [] });
    expect(host.blockId).not.toHaveBeenCalled();
  });

  test("heading: images that are not images (a note's embed) are not counted", async () => {
    const host = setup({ text: "# H\n\n![[other]] ![[c.png]]" });
    expect(await linkForImage(host, "heading", PATH, named("c.png"), isImage)).toEqual({ subpath: "#H", imageIndex: 0, notices: [] });
  });

  test("heading: an image under no heading links the whole note, counted across it, with a Notice", async () => {
    const host = setup({ text: "![[c.png]] ![[d.png]]\n\n# H" });
    const link = await linkForImage(host, "heading", PATH, named("d.png"), isImage);
    expect([link?.subpath, link?.imageIndex]).toEqual(["", 1]);
    expect(link?.notices).toEqual([expect.stringMatching(/no heading above .* the whole note/)]);
  });

  test("an id the embed's block has wins in 'heading' mode too", async () => {
    const host = setup({ text: "# H\n\nSee ![[x.png]] ![[c.png]] ^pic-1" });
    expect(await linkForImage(host, "heading", PATH, named("c.png"), isImage)).toEqual({ subpath: "#^pic-1", imageIndex: 1, notices: [] });
  });

  test("an embed edited away in the editor (its line made longer, the cache's places still fit): not found, nothing written", async () => {
    // Line 16 "![[a.png]]" becomes longer text with no embed; the stale cache still names a.png there.
    const edited = TEXT.replace(/!\[\[a\.png\]\]$/, "No image here any more, just words.");
    const host = setup({ editorText: edited });
    const cached = host.cache(PATH)!;
    expect(cached.embeds!.filter((e) => e.link === "a.png")).toHaveLength(2);
    // Only the first a.png is left: line 11's, in the Growth block.
    expect(await linkForImage(host, "heading", PATH, named("a.png"), isImage)).toEqual({ subpath: "#Growth", imageIndex: 0, notices: [] });
    const gone = setup({ text: "Para.\n\n![[c.png]]", editorText: "Para.\n\nNo image here any more." });
    expect(await linkForImage(gone, "block-id", PATH, named("c.png"), isImage)).toBeNull();
    expect(gone.blockId).not.toHaveBeenCalled();
  });

  test("the embed on the line the drag started from is the one linked, without a Notice, though the image is embedded more than once", async () => {
    const host = setup();
    // a.png is on line 11 (Growth) and line 16 (Discussion): the drag was of the one on line 16.
    expect(await linkForImage(host, "heading", PATH, named("a.png"), isImage, { line: 16 })).toEqual({ subpath: "#Discussion", imageIndex: 0, notices: [] });
    // Two on one line: the one that starts at (or last before) the drag's offset.
    const text = "# H\n\n![[c.png]] ![[c.png]]";
    const second = text.lastIndexOf("![[c.png]]");
    expect(await linkForImage(setup({ text }), "heading", PATH, named("c.png"), isImage, { line: 2, offset: second })).toEqual({ subpath: "#H", imageIndex: 1, notices: [] });
    expect(await linkForImage(setup({ text }), "heading", PATH, named("c.png"), isImage, { line: 2, offset: null })).toEqual({ subpath: "#H", imageIndex: 0, notices: [] });
  });

  test("a line that holds no such embed falls back to the first, with the Notice", async () => {
    const link = await linkForImage(setup(), "heading", PATH, named("a.png"), isImage, { line: 4 });
    expect([link?.subpath, link?.imageIndex]).toEqual(["#Growth", 0]);
    expect(link?.notices).toEqual([expect.stringMatching(/a\.png is embedded 2 times .* the first \(line 12\)/)]);
  });

  test("an image the note does not embed links nothing", async () => {
    expect(await linkForImage(setup(), "block-id", PATH, named("z.png"), isImage)).toBeNull();
  });
});
