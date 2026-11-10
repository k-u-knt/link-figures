// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { Resolved } from "../../src/links/types";
import { createDocument } from "../../src/model/defaults";
import type { CardNode } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import type { RenderContext } from "../../src/registry/node-type";
import { cardLabel, LABEL_SEPARATOR } from "../../src/view/card-label";

vi.mock("obsidian", () => ({
  Component: class {
    addChild() {}
    removeChild() {}
  },
  MarkdownRenderer: { render: async () => {} },
  Keymap: { isModEvent: () => false },
  setIcon: () => {},
}));

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

/** Obsidian's cache of a note: its headings and blocks, with the line each starts on. */
const at = (line: number) => ({ start: { line, col: 0, offset: 0 }, end: { line, col: 0, offset: 0 } });

describe("cardLabel: the breadcrumb segments", () => {
  test("a whole note: its folders, then the note's name without .md", () => {
    expect(cardLabel("Notes/Legends/Fig2.md", "", null)).toEqual(["Notes", "Legends", "Fig2"]);
  });

  test("a note at the vault's root: only its name", () => {
    expect(cardLabel("Fig2.md", "", null)).toEqual(["Fig2"]);
  });

  test("a heading: the segments end with the heading", () => {
    expect(cardLabel("Notes/Legends/Fig2.md", "#Figure 2 legend", null)).toEqual(["Notes", "Legends", "Fig2", "Figure 2 legend"]);
  });

  test("a nested heading subpath: each heading in turn", () => {
    expect(cardLabel("Fig2.md", "#Results#Figure 2", null)).toEqual(["Fig2", "Results", "Figure 2"]);
  });

  test("a block with no heading above it: the note, then ^id", () => {
    const cache = { blocks: { abc: { id: "abc", position: at(3) } } };
    expect(cardLabel("Fig2.md", "#^abc", cache)).toEqual(["Fig2", "^abc"]);
    // Without the cache, the same.
    expect(cardLabel("Fig2.md", "#^abc", null)).toEqual(["Fig2", "^abc"]);
  });

  test("a block under a heading: the heading it is under", () => {
    const cache = {
      headings: [
        { heading: "Intro", level: 1, position: at(0) },
        { heading: "Legend", level: 2, position: at(4) },
        { heading: "Later", level: 2, position: at(20) },
      ],
      blocks: { abc: { id: "abc", position: at(7) } },
    };
    expect(cardLabel("Notes/Fig2.md", "#^abc", cache)).toEqual(["Notes", "Fig2", "Legend"]);
  });

  test("emoji and dots in names and headings are kept as written (as Canvas shows them)", () => {
    expect(cardLabel("Lab Notes.md", "#🧪 Exp 1 · first comparison · 2026-10-14", null)).toEqual([
      "Lab Notes",
      "🧪 Exp 1 · first comparison · 2026-10-14",
    ]);
  });

  test("a file that is not a note keeps its extension (Obsidian's short name)", () => {
    expect(cardLabel("Data/plot.pdf", "", null)).toEqual(["Data", "plot.pdf"]);
  });

  test("the separator is Canvas's", () => {
    expect(LABEL_SEPARATOR).toBe(" › ");
  });
});

describe("the label above a note card", () => {
  function mount(card: Partial<CardNode>, resolved: Resolved | undefined, app: Record<string, unknown> = {}) {
    const doc = createDocument("a4-portrait");
    const node = { ...cardNodeDefaults(doc.pages[0], -400, 100), id: "N", ...card } as CardNode;
    if (card.file !== undefined) delete node.text;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const openLink = vi.fn();
    const ctx = {
      app,
      registries: {},
      figurePath: "fig.lnkfig.md",
      doc: () => doc,
      resolved: () => resolved,
      openLink,
      component: { addChild() {}, removeChild() {} },
    } as unknown as RenderContext;
    const renderer = cardNodeType.mount(node, host, ctx);
    const el = host.lastElementChild as HTMLElement;
    const label = () => el.querySelector<HTMLElement>(".lf-card-label");
    return { node, renderer, el, label, openLink };
  }
  const content = (path: string): Resolved => ({ kind: "content", file: { path, extension: "md" }, markdown: "Body", deps: [path] });

  test("a note card shows Folder › Note › Heading above it", () => {
    const { label } = mount({ file: "Notes/Legends/Fig2.md", subpath: "#Figure 2 legend" }, content("Notes/Legends/Fig2.md"));
    expect(label()?.textContent).toBe("Notes › Legends › Fig2 › Figure 2 legend");
    expect(label()?.classList.contains("is-missing")).toBe(false);
  });

  test("a block's label reads the note's cache for the heading it is under", () => {
    const cache = { headings: [{ heading: "Legend", level: 2, position: at(1) }], blocks: { abc: { id: "abc", position: at(3) } } };
    const app = { metadataCache: { getCache: (p: string) => (p === "Notes/Fig2.md" ? cache : null) } };
    const { label } = mount({ file: "Notes/Fig2.md", subpath: "#^abc" }, content("Notes/Fig2.md"), app);
    expect(label()?.textContent).toBe("Notes › Fig2 › Legend");
  });

  test("a text card has no label", () => {
    const { label } = mount({ text: "Hello" }, undefined);
    expect(label()).toBeNull();
  });

  test("turning a note card into a text card takes its label away", () => {
    const { renderer, node, label } = mount({ file: "Notes/Fig2.md" }, content("Notes/Fig2.md"));
    expect(label()).not.toBeNull();
    renderer.update({ ...node, file: undefined, subpath: undefined, text: "Now text" } as CardNode);
    expect(label()).toBeNull();
  });

  test("a missing note shows its stored linktext, greyed out", () => {
    const { label } = mount({ file: "Old/Gone", subpath: "#Legend" }, { kind: "missing", reason: "file", deps: [] });
    expect(label()?.textContent).toBe("Old/Gone#Legend");
    expect(label()?.classList.contains("is-missing")).toBe(true);
  });

  test("a click on the label opens the note at that place in a new tab", () => {
    const { label, openLink } = mount({ file: "Notes/Fig2.md", subpath: "#Legend" }, content("Notes/Fig2.md"));
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    label()!.dispatchEvent(ev);
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith("Notes/Fig2.md#Legend", ev, "tab");
  });

  test("the label is a grip of the card (a drag from it moves the card), outside the body", () => {
    const { el, label } = mount({ file: "Notes/Fig2.md" }, content("Notes/Fig2.md"));
    expect(label()!.classList.contains("lf-node-grip")).toBe(true);
    expect(el.querySelector(".lf-card-body")!.contains(label())).toBe(false);
  });

  test("the label is never exported: a note card draws nothing in SVG or PowerPoint", () => {
    const doc = createDocument("a4-portrait");
    const node = { ...cardNodeDefaults(doc.pages[0], -400, 100), file: "Notes/Fig2.md", subpath: "#Legend" } as CardNode;
    delete node.text;
    expect(cardNodeType.exportable).toBe(false);
    expect(cardNodeType.toSvg!(node, {} as never)).toBe("");
    expect(cardNodeType.toPptx!(node, {} as never)).toBeNull();
  });
});

test("the label keeps its size on screen at any zoom, and sits above the card, which does not clip it", () => {
  const window = new Window();
  const document = window.document;
  const style = document.createElement("style");
  style.textContent = readFileSync(join(process.cwd(), "styles.css"), "utf8");
  document.head.appendChild(style);
  // The stage's viewport sets --lf-zoom (see `FigureView.applyViewport`): at 2× the label is drawn at half size.
  document.body.innerHTML =
    '<div style="--lf-zoom: 2"><div class="lf-node lf-card is-note"><div class="lf-card-label">A › B</div><div class="lf-card-body"></div></div></div>';
  const css = (sel: string) => window.getComputedStyle(document.querySelector(sel) as never);
  const label = css(".lf-card-label");
  expect(label.position).toBe("absolute");
  expect(label.transform.replace(/\s+/g, "")).toContain("scale(calc(1/2))");
  expect(label.transform).toContain("translateY(-100%)");
  expect(label.transformOrigin).toContain("bottom");
  expect(label.whiteSpace).toBe("nowrap");
  expect(css(".lf-card").overflow).toBe("visible");
});
