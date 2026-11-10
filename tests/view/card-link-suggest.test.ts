// @vitest-environment happy-dom
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { createPage } from "../../src/model/defaults";
import type { CardNode } from "../../src/model/types";
import { attachLinkSuggest, linkQueryAt } from "../../src/view/card-link-suggest";

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

function fakeApp() {
  return {
    vault: {
      getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
      getFiles: () => files,
    },
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) =>
        files.find((f) => f.basename === linkpath || f.path === linkpath || f.path === `${linkpath}.md` || f.name === linkpath) ?? null,
      fileToLinktext: (f: FakeFile) => (f.extension === "md" ? f.basename : f.name),
      getFileCache: (f: FakeFile) =>
        f.path === "Projects/analysis.md"
          ? {
              headings: [
                { heading: "Methods", level: 2 },
                { heading: "Results: mice", level: 2 },
              ],
              blocks: { abc123: { id: "abc123" }, fig2: { id: "fig2" } },
            }
          : {},
    },
  };
}

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

    typeInto(area, "[[analysis^");
    expect(titles()).toEqual(["^abc123", "^fig2"]);
    typeInto(area, "[[analysis#^fi");
    expect(titles()).toEqual(["^fig2"]);
    key(area, "Enter");
    expect(area.value).toBe("[[analysis#^fig2]]");

    // A note that is not there has nothing to list; neither has an alias being typed.
    typeInto(area, "[[nothing#");
    expect(list()).toBeNull();
    typeInto(area, "[[analysis|sh");
    expect(list()).toBeNull();
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
