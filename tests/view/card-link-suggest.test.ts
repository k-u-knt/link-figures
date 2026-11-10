// @vitest-environment happy-dom
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { createPage } from "../../src/model/defaults";
import type { CardNode } from "../../src/model/types";
import { attachLinkSuggest, headingLinktext, linkQueryAt } from "../../src/view/card-link-suggest";

// `obsidian` ships only typings. Its fuzzy search is stood in for by a subsequence match whose score is better (higher)
// the tighter the match, as Obsidian's is.
vi.mock("obsidian", () => ({
  prepareFuzzySearch: (query: string) => (text: string) => {
    const q = query.toLowerCase().replace(/\s+/g, "");
    const t = text.toLowerCase();
    let at = -1;
    let first = -1;
    for (const ch of q) {
      at = t.indexOf(ch, at + 1);
      if (at === -1) return null;
      if (first === -1) first = at;
    }
    return { score: q === "" ? 0 : -(at - first) - first / 100, matches: [] };
  },
  Component: class {},
  MarkdownRenderer: { render: async () => {} },
}));

interface FakeFile { path: string; name: string; basename: string; extension: string; stat: { mtime: number } }
const file = (path: string, mtime = 0): FakeFile => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return { path, name, basename: name.slice(0, dot), extension: name.slice(dot + 1), stat: { mtime } };
};
const files = [file("Projects/analysis.md", 3), file("anatomy.md", 2), file("zebra.md", 1), file("plots/analysis plot.png", 0)];

/** The note `Projects/analysis.md`: lines 0-18, with the sections and list items its cache gives. */
const NOTE = [
  "---", "aliases: [Study A]", "---", "# Methods", "We measured mice.", "", "- first item", "- second item ^item2", "",
  "> a quote", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "```py", "print(1)", "```", "^code1",
].join("\n");
const at = (start: number, end = start) => ({ start: { line: start }, end: { line: end } });
const NOTE_CACHE = {
  frontmatter: { aliases: ["Study A"] },
  headings: [
    { heading: "Methods", level: 2, position: at(3) },
    { heading: "Results: mice", level: 2, position: at(3) },
  ],
  sections: [
    { type: "yaml", position: at(0, 2) },
    { type: "heading", position: at(3) },
    { type: "paragraph", position: at(4) },
    { type: "list", position: at(6, 7) },
    { type: "blockquote", position: at(9) },
    { type: "table", position: at(11, 13) },
    { type: "code", position: at(15, 17), id: "code1" },
  ],
  listItems: [{ position: at(6) }, { position: at(7), id: "item2" }],
  blocks: { item2: { id: "item2", position: at(7) }, code1: { id: "code1", position: at(18) } },
};

function fakeApp(lastOpen: string[] = []) {
  return {
    vault: {
      getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
      getFiles: () => files,
      cachedRead: async (f: FakeFile) => (f.path === "Projects/analysis.md" ? NOTE : ""),
    },
    workspace: { getLastOpenFiles: () => lastOpen },
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) =>
        files.find((f) => f.basename === linkpath || f.path === linkpath || f.path === `${linkpath}.md` || f.name === linkpath) ?? null,
      fileToLinktext: (f: FakeFile) => (f.extension === "md" ? f.basename : f.name),
      getFileCache: (f: FakeFile) => (f.path === "Projects/analysis.md" ? NOTE_CACHE : {}),
    },
  };
}

/** Lets the list's reads of a note (`cachedRead`) and a block id's write settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const notes = () => Array.from(document.querySelectorAll(".suggestion-container .suggestion-item")).map((e) => e.querySelector(".suggestion-note")?.textContent ?? null);

/** Types `text` into `area` as if at the caret (which ends up at the end of what was typed), firing `input`. */
function typeInto(area: HTMLTextAreaElement, text: string, caret = text.length) {
  area.value = text;
  area.setSelectionRange(caret, caret);
  area.dispatchEvent(new Event("input", { bubbles: true }));
}
const key = (el: Element, name: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
const list = () => document.querySelector<HTMLElement>(".suggestion-container");
const titles = () => Array.from(document.querySelectorAll(".suggestion-container .suggestion-item .suggestion-title")).map((e) => e.textContent);
const selected = () => document.querySelector(".suggestion-container .suggestion-item.is-selected .suggestion-title")?.textContent;

function textarea(): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  document.body.appendChild(area);
  area.focus();
  return area;
}

// Obsidian's element helpers, which the renderers use; happy-dom has the rest of the DOM.
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.createEl = function (this: HTMLElement, tag: string, info: { cls?: string | string[]; text?: string } = {}) {
    const el = this.ownerDocument.createElement(tag);
    for (const c of Array.isArray(info.cls) ? info.cls : info.cls ? [info.cls] : []) el.classList.add(c);
    if (info.text !== undefined) el.textContent = info.text;
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: { createEl(tag: string, info?: unknown): unknown }, info?: unknown) {
    return this.createEl("div", info);
  };
  proto.empty = function (this: HTMLElement) {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("link suggestions in a card's editor", () => {
  test("typing `[[ana` lists notes matching like Obsidian's suggester; Enter inserts `[[analysis]]`", () => {
    const area = textarea();
    const detach = attachLinkSuggest(area, fakeApp() as never, "fig.lnkfig.md");
    typeInto(area, "See [[ana");
    expect(list()).not.toBeNull();
    // Notes only (no attachment for a plain link), the tighter match first; zebra does not match.
    expect(titles()).toEqual(["analysis", "anatomy"]);
    expect(selected()).toBe("analysis");
    key(area, "ArrowDown");
    expect(selected()).toBe("anatomy");
    key(area, "ArrowUp");
    expect(selected()).toBe("analysis");
    key(area, "Enter");
    expect(area.value).toBe("See [[analysis]]");
    expect(area.selectionStart).toBe(area.value.length);
    expect(list()).toBeNull();

    // `![[` lists attachments too; Tab accepts; text after the caret is kept, and a `]]` already there is not doubled.
    typeInto(area, "![[plot]] after", 7);
    expect(titles()).toEqual(["analysis plot.png"]);
    key(area, "Tab");
    expect(area.value).toBe("![[analysis plot.png]] after");
    expect(area.selectionStart).toBe("![[analysis plot.png]]".length);

    // A click accepts, and the press does not take the focus from the editor.
    typeInto(area, "[[zeb");
    const item = document.querySelector<HTMLElement>(".suggestion-item")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    item.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(area.value).toBe("[[zebra]]");
    expect(list()).toBeNull();

    detach();
    typeInto(area, "[[ana");
    expect(list()).toBeNull();
  });

  test("`[[analysis#` lists its headings; `^` lists its blocks", () => {
    const area = textarea();
    attachLinkSuggest(area, fakeApp() as never, "fig.lnkfig.md");
    typeInto(area, "[[analysis#");
    expect(titles()).toEqual(["Methods", "Results: mice"]);
    typeInto(area, "[[analysis#res");
    expect(titles()).toEqual(["Results: mice"]);
    key(area, "Enter");
    // As Obsidian writes a heading into a link: the characters a link cannot hold become spaces.
    expect(area.value).toBe("[[analysis#Results mice]]");

    // A note that is not there has nothing to list; neither has an alias being typed.
    typeInto(area, "[[nothing#");
    expect(list()).toBeNull();
    typeInto(area, "[[analysis|sh");
    expect(list()).toBeNull();
  });

  test("`^` lists every block of the note with a one-line preview; one without an id is given one", async () => {
    const area = textarea();
    const blockId = vi.fn(async (_path: string, _line: number) => ({ id: "fig-ab12", subpath: "#^fig-ab12" }));
    attachLinkSuggest(area, fakeApp() as never, "fig.lnkfig.md", { blockId });
    typeInto(area, "[[analysis^");
    await settle();
    // Paragraphs, list items, quotes, tables and code, in the note's order; not the front matter or headings.
    expect(titles()).toEqual(["We measured mice.", "first item", "second item", "a quote", "| a | b | |---|---| | 1 | 2 |", "print(1)"]);
    // A block that has an id shows it.
    expect(notes()).toEqual([null, null, "^item2", null, null, "^code1"]);

    typeInto(area, "[[analysis#^second");
    await settle();
    expect(titles()).toEqual(["second item"]);
    key(area, "Enter");
    expect(area.value).toBe("[[analysis#^item2]]");
    expect(blockId).not.toHaveBeenCalled();

    // No id yet: one is written into the note (the drop-from-note machinery), then the link is inserted.
    typeInto(area, "See [[analysis^first");
    await settle();
    expect(titles()).toEqual(["first item"]);
    key(area, "Enter");
    expect(list()).toBeNull();
    await settle();
    expect(blockId).toHaveBeenCalledWith("Projects/analysis.md", 6);
    expect(area.value).toBe("See [[analysis#^fig-ab12]]");
    expect(area.selectionStart).toBe(area.value.length);

    // Without a way to write ids (no block-id writer), only the blocks that have one are offered.
    const other = textarea();
    attachLinkSuggest(other, fakeApp() as never, "fig.lnkfig.md");
    typeInto(other, "[[analysis^");
    await settle();
    expect(titles()).toEqual(["second item", "print(1)"]);
  });

  test("a note is found by its alias too, and inserted as `[[<linktext>|<alias>]]`", () => {
    const area = textarea();
    attachLinkSuggest(area, fakeApp() as never, "fig.lnkfig.md");
    typeInto(area, "[[study");
    expect(titles()).toEqual(["Study A"]);
    expect(notes()).toEqual(["Projects/analysis"]);
    key(area, "Enter");
    expect(area.value).toBe("[[analysis|Study A]]");
  });

  test("an empty `[[` lists the recently opened notes first, then the rest by last change", () => {
    const area = textarea();
    attachLinkSuggest(area, fakeApp(["zebra.md", "gone.md", "plots/analysis plot.png"]) as never, "fig.lnkfig.md");
    typeInto(area, "[[");
    expect(titles()).toEqual(["zebra", "analysis", "anatomy"]);
    typeInto(area, "![[");
    expect(titles()).toEqual(["zebra", "analysis plot.png", "analysis", "anatomy"]);
  });

  test("a heading is written into a link as Obsidian's `stripHeadingForLink` documents it", () => {
    // The example in obsidian.d.ts: stripHeadingForLink('foo:#|^\\\r\n%%[[]]bar') is 'foo bar'.
    expect(headingLinktext("foo:#|^\\\r\n%%[[]]bar")).toBe("foo bar");
  });

  test("the card editor writes a new block id through the plugin's API", async () => {
    const page = createPage("a4-portrait", []);
    const card: CardNode = { ...cardNodeDefaults(page, 0, 0), id: "C", text: "" };
    const blockId = vi.fn(async () => ({ id: "fig-zz00", subpath: "#^fig-zz00" }));
    const component = { readOnly: false, runCommandById: vi.fn(), addChild() {}, removeChild() {}, plugin: { api: { blockId } } };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ctx = { app: fakeApp(), figurePath: "fig.lnkfig.md", resolved: () => undefined, openLink: vi.fn(), component };
    cardNodeType.mount(card, host, ctx as never);
    const el = host.firstElementChild as HTMLElement;
    el.dispatchEvent(new CustomEvent("lf-activate"));
    const area = el.querySelector("textarea")!;
    typeInto(area, "[[analysis^quote");
    await settle();
    expect(titles()).toEqual(["a quote"]);
    key(area, "Enter");
    await settle();
    expect(blockId).toHaveBeenCalledWith("Projects/analysis.md", 9);
    expect(area.value).toBe("[[analysis#^fig-zz00]]");
  });

  test("Escape closes the list and keeps the edit open", () => {
    const page = createPage("a4-portrait", []);
    const card: CardNode = { ...cardNodeDefaults(page, 0, 0), id: "C", text: "" };
    const runCommandById = vi.fn();
    const component = { readOnly: false, runCommandById, addChild() {}, removeChild() {} };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ctx = { app: fakeApp(), figurePath: "fig.lnkfig.md", resolved: () => undefined, openLink: vi.fn(), component };
    const renderer = cardNodeType.mount(card, host, ctx as never);
    const el = host.firstElementChild as HTMLElement;
    el.dispatchEvent(new CustomEvent("lf-activate"));
    const area = el.querySelector("textarea")!;
    typeInto(area, "[[ana");
    expect(list()).not.toBeNull();

    const stage = vi.fn();
    document.addEventListener("keydown", stage);
    key(area, "Escape");
    expect(list()).toBeNull();
    expect(el.querySelector("textarea")).toBe(area);
    expect(runCommandById).not.toHaveBeenCalled();
    // The keys of the list are its own: the stage never sees them.
    expect(stage).not.toHaveBeenCalled();

    // With the list closed, Escape ends the edit as before.
    key(area, "Escape");
    expect(el.querySelector("textarea")).toBeNull();
    expect(runCommandById).toHaveBeenCalledWith("node.update", { id: "C", patch: { text: "[[ana" } });

    // An edit ended any other way takes its list with it.
    el.dispatchEvent(new CustomEvent("lf-activate"));
    typeInto(el.querySelector("textarea")!, "[[ana");
    expect(list()).not.toBeNull();
    renderer.unmount();
    expect(list()).toBeNull();
    document.removeEventListener("keydown", stage);
  });

  test("no list inside a code fence", () => {
    const area = textarea();
    attachLinkSuggest(area, fakeApp() as never, "fig.lnkfig.md");
    typeInto(area, "```\n[[ana");
    expect(list()).toBeNull();
    typeInto(area, "`[[ana`", 6);
    expect(list()).toBeNull();
    // After the fence closes, links are links again.
    typeInto(area, "```\ncode\n```\n[[ana");
    expect(list()).not.toBeNull();
    expect(linkQueryAt("```\n[[ana", 9)).toBeNull();
  });

  test("the list uses class `suggestion-container`", () => {
    const area = textarea();
    attachLinkSuggest(area, fakeApp() as never, "fig.lnkfig.md");
    typeInto(area, "[[");
    const container = list()!;
    expect(container.parentElement).toBe(document.body);
    const items = container.querySelectorAll(".suggestion-item");
    // Every note, the most recently changed first.
    expect(Array.from(items).map((i) => i.querySelector(".suggestion-title")!.textContent)).toEqual(["analysis", "anatomy", "zebra"]);
    expect(items[0].classList.contains("is-selected")).toBe(true);
    expect(container.querySelector(".suggestion-item .suggestion-note")?.textContent).toBe("Projects");
    // Moving the caret out of the link closes it; a blur too.
    typeInto(area, "[[an]] x");
    expect(list()).toBeNull();
    typeInto(area, "[[an");
    area.dispatchEvent(new FocusEvent("blur"));
    expect(list()).toBeNull();
  });
});

describe("linkQueryAt", () => {
  test("reads the link being typed at the caret", () => {
    expect(linkQueryAt("a [[no", 6)).toEqual({ embed: false, from: 4, to: 6, kind: "file", target: "no", query: "no" });
    expect(linkQueryAt("![[n#h", 6)).toEqual({ embed: true, from: 3, to: 6, kind: "heading", target: "n", query: "h" });
    expect(linkQueryAt("[[n#^b", 6)).toEqual({ embed: false, from: 2, to: 6, kind: "block", target: "n", query: "b" });
    expect(linkQueryAt("[[n^b", 5)).toEqual({ embed: false, from: 2, to: 5, kind: "block", target: "n", query: "b" });
    expect(linkQueryAt("[[a]] b", 7)).toBeNull();
    expect(linkQueryAt("[[a\nb", 5)).toBeNull();
  });
});
