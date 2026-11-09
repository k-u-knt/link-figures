import {
  blockAt,
  blockIdInText,
  blockIdPrefix,
  blockMatchesText,
  existingBlockId,
  idPlacement,
  idsInText,
  insertBlockId,
  newBlockId,
  type Block,
  type SectionLike,
} from "../../src/links/block-id";

/** A cache position over lines `start`..`end` (0-based, inclusive). */
const pos = (start: number, end: number) => ({ start: { line: start, col: 0, offset: 0 }, end: { line: end, col: 0, offset: 0 } });
const section = (type: string, start: number, end: number, id?: string): SectionLike => ({ type, position: pos(start, end), ...(id ? { id } : {}) });

const NOTE = [
  "# Title", // 0
  "", // 1
  "First paragraph", // 2
  "goes on here.", // 3
  "", // 4
  "- one", // 5
  "- two", // 6
  "  - nested", // 7
  "- three", // 8
  "", // 9
  "| a | b |", // 10
  "| - | - |", // 11
  "| 1 | 2 |", // 12
  "", // 13
  "```js", // 14
  "x = 1", // 15
  "```", // 16
  "Next paragraph right after the fence.", // 17
].join("\n");

const CACHE = {
  sections: [
    section("heading", 0, 0),
    section("paragraph", 2, 3),
    section("list", 5, 8),
    section("table", 10, 12),
    section("code", 14, 16),
    section("paragraph", 17, 17),
  ],
  listItems: [
    { position: pos(5, 5), parent: -5 },
    // Obsidian may give an item a range that takes in its children: its own lines end where the next item starts.
    { position: pos(6, 7), parent: -5 },
    { position: pos(7, 7), parent: 6 },
    { position: pos(8, 8), parent: -5 },
  ],
};

describe("blockAt", () => {
  test.each([
    [0, { type: "heading", start: 0, end: 0 }],
    [2, { type: "paragraph", start: 2, end: 3 }],
    [3, { type: "paragraph", start: 2, end: 3 }],
    [10, { type: "table", start: 10, end: 12 }],
    [15, { type: "code", start: 14, end: 16 }],
  ])("line %i is in %o", (line, block) => {
    expect(blockAt(CACHE, line)).toMatchObject(block);
  });

  test("in a list, the block is the list item that holds the line, without its children", () => {
    expect(blockAt(CACHE, 5)).toMatchObject({ type: "listItem", start: 5, end: 5 });
    expect(blockAt(CACHE, 6)).toMatchObject({ type: "listItem", start: 6, end: 6 });
    expect(blockAt(CACHE, 7)).toMatchObject({ type: "listItem", start: 7, end: 7 });
    expect(blockAt(CACHE, 8)).toMatchObject({ type: "listItem", start: 8, end: 8 });
  });

  test("a blank line between blocks, a line past the end, and a cache without sections are in no block", () => {
    expect(blockAt(CACHE, 1)).toBeNull();
    expect(blockAt(CACHE, 99)).toBeNull();
    expect(blockAt({}, 2)).toBeNull();
  });

  test("the section's and the list item's own ids come along", () => {
    const cache = { sections: [section("paragraph", 0, 0, "p1"), section("list", 2, 2)], listItems: [{ position: pos(2, 2), id: "li1" }] };
    expect(blockAt(cache, 0)?.id).toBe("p1");
    expect(blockAt(cache, 2)?.id).toBe("li1");
  });
});

describe("idPlacement", () => {
  test.each([
    ["paragraph", "end"],
    ["listItem", "end"],
    ["blockquote", "own-line"],
    ["callout", "own-line"],
    ["table", "own-line"],
    ["code", "own-line"],
    ["math", "own-line"],
    ["heading", null],
    ["yaml", null],
    ["thematicBreak", null],
  ])("%s → %s", (type, placement) => {
    expect(idPlacement(type)).toBe(placement);
  });
});

describe("existingBlockId", () => {
  const para: Block = { type: "paragraph", start: 2, end: 3 };
  test("the block's own id first", () => {
    expect(existingBlockId({ x: { id: "x", position: pos(2, 3) } }, { ...para, id: "own" })).toBe("own");
  });
  test("a cached block id inside the block's lines", () => {
    expect(existingBlockId({ "fig-ab12": { id: "fig-ab12", position: pos(2, 3) } }, para)).toBe("fig-ab12");
    expect(existingBlockId({ other: { id: "other", position: pos(5, 5) } }, para)).toBeNull();
    expect(existingBlockId(undefined, para)).toBeNull();
  });
});

describe("blockIdInText", () => {
  const lines = (text: string) => text.split("\n");
  test("an id at the end of the block's last line", () => {
    expect(blockIdInText(lines("a\nb ^fig-1x2y"), { type: "paragraph", start: 0, end: 1 })).toBe("fig-1x2y");
    expect(blockIdInText(lines("a\nb ^fig-1x2y\r"), { type: "paragraph", start: 0, end: 1 })).toBe("fig-1x2y");
    expect(blockIdInText(lines("a\nb"), { type: "paragraph", start: 0, end: 1 })).toBeNull();
    // A caret inside the text is not an id.
    expect(blockIdInText(lines("x^2 is ^big y"), { type: "paragraph", start: 0, end: 0 })).toBeNull();
  });
  test("for a table or code block, an id on its own line after it, past at most one blank line", () => {
    const table: Block = { type: "table", start: 0, end: 1 };
    expect(blockIdInText(lines("| a |\n| - |\n\n^tab-1"), table)).toBe("tab-1");
    expect(blockIdInText(lines("| a |\n| - |\n^tab-1"), table)).toBe("tab-1");
    expect(blockIdInText(lines("| a |\n| - |\n\nText ^p-1"), table)).toBeNull();
    expect(blockIdInText(lines("| a |\n| - |\n\n\n^far"), table)).toBeNull();
  });
});

describe("idsInText", () => {
  test("every block id written in the note", () => {
    expect(idsInText("a ^one\n\n| x |\n\n^two\nx^2 and ^not-end here\n- item ^Three")).toEqual(["one", "two", "Three"]);
  });
});

describe("newBlockId", () => {
  test("is <prefix>-<4 base36 chars>", () => {
    expect(newBlockId("fig", [], () => 0)).toBe("fig-0000");
    expect(newBlockId("fig", [], () => 0.999999)).toMatch(/^fig-[0-9a-z]{4}$/);
  });
  test("is not one the note already has, compared without case", () => {
    const values = [0, 0, 0.5];
    let i = 0;
    const random = () => values[i++ % values.length];
    const id = newBlockId("fig", ["FIG-0000"], random);
    expect(id).not.toBe("fig-0000");
    expect(id).toMatch(/^fig-[0-9a-z]{4}$/);
  });
});

describe("blockIdPrefix", () => {
  test("keeps letters, digits and dashes; an empty prefix is the default", () => {
    expect(blockIdPrefix("fig")).toBe("fig");
    expect(blockIdPrefix(" my fig_1! ")).toBe("myfig1");
    expect(blockIdPrefix("")).toBe("fig");
    expect(blockIdPrefix("^^")).toBe("fig");
  });
});

describe("insertBlockId", () => {
  test("a paragraph gets ' ^id' at the end of its last line, and nothing else changes", () => {
    const out = insertBlockId(NOTE, { type: "paragraph", start: 2, end: 3 }, "fig-ab12");
    expect(out.split("\n")[3]).toBe("goes on here. ^fig-ab12");
    expect(out.replace(" ^fig-ab12", "")).toBe(NOTE);
  });

  test("a list item gets it at the end of its own line, not after its children", () => {
    const out = insertBlockId(NOTE, { type: "listItem", start: 6, end: 6 }, "fig-0001");
    expect(out.split("\n").slice(5, 9)).toEqual(["- one", "- two ^fig-0001", "  - nested", "- three"]);
  });

  test("a quote or a callout gets it on a line of its own after it", () => {
    expect(insertBlockId("> a\n> b\n\nnext", { type: "blockquote", start: 0, end: 1 }, "q-1")).toBe("> a\n> b\n\n^q-1\n\nnext");
    expect(insertBlockId("> [!note]\n> b\nnext", { type: "callout", start: 0, end: 1 }, "c-1")).toBe("> [!note]\n> b\n\n^c-1\n\nnext");
  });

  test("a list item that ends in a code fence gets it on its own line inside the item, at the item's content column", () => {
    const text = ["- item", "  ```js", "  x = 1", "  ```", "- next"].join("\n");
    expect(insertBlockId(text, { type: "listItem", start: 0, end: 3 }, "fig-1")).toBe(["- item", "  ```js", "  x = 1", "  ```", "", "  ^fig-1", "- next"].join("\n"));
  });

  test("a numbered item that ends in a table, followed by text, gets a blank line after the id too", () => {
    const text = ["1. item", "   | a |", "   | - |", "   | 1 |", "After."].join("\n");
    expect(insertBlockId(text, { type: "listItem", start: 0, end: 3 }, "fig-2")).toBe(["1. item", "   | a |", "   | - |", "   | 1 |", "", "   ^fig-2", "", "After."].join("\n"));
  });

  test("a nested item that ends in display math, at the end of the note", () => {
    const text = ["- a", "  - b", "    $$", "    x^2", "    $$"].join("\n");
    expect(insertBlockId(text, { type: "listItem", start: 1, end: 4 }, "fig-3")).toBe([...text.split("\n"), "", "    ^fig-3"].join("\n"));
  });

  test("a list item in a quote that ends in a fence keeps the quote's prefix on the id's lines, at the item's content column", () => {
    const text = ["> - item", ">   ```", ">   x", ">   ```", "> - next"].join("\n");
    const out = insertBlockId(text, { type: "listItem", start: 0, end: 3 }, "fig-q");
    expect(out).toBe(["> - item", ">   ```", ">   x", ">   ```", ">", ">   ^fig-q", "> - next"].join("\n"));
    expect(blockIdInText(out.split("\n"), { type: "listItem", start: 0, end: 3 })).toBe("fig-q");
  });

  test("a list item in a quote that ends in a table, followed by quoted text, gets a quoted blank line after the id too", () => {
    const text = ["> 1. item", ">    | a |", ">    | - |", "> After."].join("\n");
    expect(insertBlockId(text, { type: "listItem", start: 0, end: 2 }, "fig-r")).toBe(
      ["> 1. item", ">    | a |", ">    | - |", ">", ">    ^fig-r", ">", "> After."].join("\n"),
    );
  });

  test("an id on its own line inside an item that ends in a fence is found", () => {
    const lines = ["- item", "  ```", "  x", "  ```", "", "  ^fig-9", "- next"];
    expect(blockIdInText(lines, { type: "listItem", start: 0, end: 3 })).toBe("fig-9");
    expect(blockIdInText(lines, { type: "listItem", start: 0, end: 5 })).toBe("fig-9");
  });

  test("Windows line endings are kept", () => {
    expect(insertBlockId("a\r\nb\r\n", { type: "paragraph", start: 0, end: 1 }, "x-1")).toBe("a\r\nb ^x-1\r\n");
  });

  test("a table gets '^id' on its own line after it, a blank line before; the blank line after is the one there was", () => {
    const out = insertBlockId(NOTE, { type: "table", start: 10, end: 12 }, "fig-t001");
    expect(out.split("\n").slice(10, 17)).toEqual(["| a | b |", "| - | - |", "| 1 | 2 |", "", "^fig-t001", "", "```js"]);
  });

  test("a code block followed straight by text gets a blank line after the id too", () => {
    const out = insertBlockId(NOTE, { type: "code", start: 14, end: 16 }, "fig-c001");
    expect(out.split("\n").slice(14)).toEqual(["```js", "x = 1", "```", "", "^fig-c001", "", "Next paragraph right after the fence."]);
  });

  test("an id on its own line takes the note's own line ending, even after a last line without one", () => {
    expect(insertBlockId("```\r\nx\r\n```", { type: "code", start: 0, end: 2 }, "c-1")).toBe("```\r\nx\r\n```\r\n\r\n^c-1");
    expect(insertBlockId("| a |\r\n| - |\r\n\r\nnext\r\n", { type: "table", start: 0, end: 1 }, "t-1")).toBe("| a |\r\n| - |\r\n\r\n^t-1\r\n\r\nnext\r\n");
  });

  test("a code block at the very end of the note", () => {
    expect(insertBlockId("```\nx\n```", { type: "code", start: 0, end: 2 }, "c-1")).toBe("```\nx\n```\n\n^c-1");
    expect(insertBlockId("```\nx\n```\n", { type: "code", start: 0, end: 2 }, "c-1")).toBe("```\nx\n```\n\n^c-1\n");
  });

  test("a heading, or a block that cannot hold an id, is refused", () => {
    expect(() => insertBlockId(NOTE, { type: "heading", start: 0, end: 0 }, "h-1")).toThrow(/heading/);
    expect(() => insertBlockId("---\na: 1\n---", { type: "yaml", start: 0, end: 2 }, "y-1")).toThrow(/yaml/);
  });

  test("a block past the end of the text is refused", () => {
    expect(() => insertBlockId("one line", { type: "paragraph", start: 3, end: 4 }, "x-1")).toThrow(/changed/);
  });
});

describe("blockMatchesText", () => {
  const at = (line: number, col: number, offset: number) => ({ line, col, offset });
  const text = "# T\n\nPara one.\n";
  const block = { type: "paragraph", start: 2, end: 2, locs: [at(2, 0, 5), at(2, 9, 14)] };
  test("holds when each place's offset is its line and column in the text", () => {
    expect(blockMatchesText(text, block)).toBe(true);
  });
  test("fails for text with a line more above the block, or text too short", () => {
    expect(blockMatchesText("# T\n\n\nPara one.\n", block)).toBe(false);
    expect(blockMatchesText("# T", block)).toBe(false);
  });
  test("places without offsets are not checked", () => {
    expect(blockMatchesText("x", { type: "paragraph", start: 0, end: 0, locs: [{ line: 0 }] })).toBe(true);
  });
  test("blockAt gives the section's places, and the list item's", () => {
    const cache = {
      sections: [{ type: "list", position: { start: at(0, 0, 0), end: at(1, 5, 11) } }],
      listItems: [{ position: { start: at(0, 0, 0), end: at(0, 5, 5) } }, { position: { start: at(1, 0, 6), end: at(1, 5, 11) } }],
    };
    expect(blockAt(cache, 1)?.locs).toEqual([at(0, 0, 0), at(1, 5, 11), at(1, 0, 6), at(1, 5, 11)]);
    expect(blockMatchesText("- one\n- two", blockAt(cache, 1)!)).toBe(true);
  });
});
