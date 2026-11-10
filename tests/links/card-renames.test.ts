// @vitest-environment happy-dom
import { cardCommands } from "../../src/commands/cards";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { CardNode, Document, Node } from "../../src/model/types";
import { createRegistries, type Registries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";

const render = vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
  if (el) el.textContent = markdown;
});
vi.mock("obsidian", () => ({
  Component: class {
    addChild() {}
    removeChild() {}
  },
  MarkdownRenderer: { render: (...args: [unknown, string, HTMLElement]) => render(...args) },
  Keymap: { isModEvent: () => false },
  Notice: class {},
  Platform: { isMacOS: false },
  normalizePath: (p: string) => p,
  setIcon: () => {},
}));

const { cardNodeDefaults, cardNodeType } = await import("../../src/nodes/card-node");
const { renameInCardText } = await import("../../src/model/card-links");
const { followRenames, linkRenameFor, renameLinksInFigures, renameLinksInStore } = await import("../../src/links/card-renames");

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

function registries(): Registries {
  const r = createRegistries();
  r.nodeTypes.register(cardNodeType);
  for (const c of [...drawingCommands(), ...cardCommands()]) r.commands.register(c);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  return r;
}

/** One A4 page `pg-1`, with text cards and note cards as given (id → text, or a `{ file, subpath }` note link). */
function figure(cards: Record<string, string | { file: string; subpath?: string }>): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  let y = 0;
  for (const [id, content] of Object.entries(cards)) {
    const card: CardNode = { ...cardNodeDefaults(doc.pages[0], -400, y), id };
    y += 200;
    if (typeof content === "string") card.text = content;
    else {
      delete card.text;
      card.file = content.file;
      if (content.subpath) card.subpath = content.subpath;
    }
    doc.nodes.push(card);
  }
  return doc;
}

/** The vault after `Notes/Results.md` was renamed to `Notes/Final.md`: what a link finds now. */
const resolveNow = (link: string) => (["Final", "Notes/Final", "Notes/Final.md", "Final.md"].includes(link) ? "Notes/Final.md" : link === "Other" ? "Other.md" : null);
const RENAME = linkRenameFor("Notes/Results.md", "Notes/Final.md", "fig.lnkfig.md", "Final", resolveNow);

const text = (doc: Document, id: string) => (doc.nodes.find((n) => n.id === id) as CardNode | undefined)?.text;

describe("an open figure", () => {
  test("an open figure's card text is renamed with no undo step, and its history is rewritten", async () => {
    const r = registries();
    const store = createFigureStore(figure({ C: "![[Results#h]] and [[Other]]", D: "See [[Notes/Results|the results]]" }), r);
    const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: null, store, selection: [], page: undefined });
    const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
    await call("node.update", { id: "C", patch: { text: "![[Results#h]] edited `[[Results]]`" } });
    await call("delete", { ids: ["D"] });
    const steps = () => {
      let n = 0;
      while (store.undo()) n++;
      for (let i = 0; i < n; i++) store.redo();
      return n;
    };
    expect(steps()).toBe(2);
    const events: string[] = [];
    store.subscribe((ev) => events.push(ev.kind));

    expect(renameLinksInStore(store, r, RENAME)).toBe(true);
    expect(text(store.doc, "C")).toBe("![[Final#h]] edited `[[Results]]`");
    expect(events).toEqual(["replace"]);
    // No undo step of its own; the history now holds the new name.
    expect(steps()).toBe(2);
    store.undo();
    expect(text(store.doc, "D")).toBe("See [[Final|the results]]");
    store.undo();
    expect(text(store.doc, "C")).toBe("![[Final#h]] and [[Other]]");
    store.redo();
    expect(text(store.doc, "C")).toBe("![[Final#h]] edited `[[Results]]`");
    // Nothing left to rename: nothing changes.
    expect(renameLinksInStore(store, r, RENAME)).toBe(false);
  });

  test("an open editor's textarea is rewritten and typed text kept", async () => {
    const r = registries();
    const store = createFigureStore(figure({ C: "![[Results#h]]" }), r);
    const pending: Promise<unknown>[] = [];
    const view = {
      readOnly: false,
      addChild: vi.fn(),
      removeChild: vi.fn(),
      runCommandById: (id: string, args?: Record<string, unknown>) =>
        pending.push(runCall(store, { app: {} as never, registries: r, view: null, store, selection: [], page: undefined }, prepareCall(r, { id, args }))),
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ctx = { app: {}, registries: r, figurePath: "fig.lnkfig.md", doc: () => store.doc, resolved: () => undefined, openLink: vi.fn(), component: view };
    const renderer = cardNodeType.mount(store.doc.nodes[0] as CardNode, host, ctx as never);
    store.subscribe(() => renderer.update(store.doc.nodes[0]));
    const el = host.firstElementChild as HTMLElement;
    el.dispatchEvent(new CustomEvent("lf-activate"));
    const area = el.querySelector("textarea")!;
    area.value = "Typed first. ![[Results#h]] and [[Results]] typed last";
    area.setSelectionRange(area.value.length, area.value.length);

    // The rename lands while the editor is open: the store and the editor both take it.
    renameLinksInStore(store, r, RENAME);
    renderer.renameLinks!(RENAME);
    expect(text(store.doc, "C")).toBe("![[Final#h]]");
    expect(area.value).toBe("Typed first. ![[Final#h]] and [[Final]] typed last");
    expect(area.selectionStart).toBe(area.value.length);
    expect(el.querySelector("textarea")).toBe(area);

    area.dispatchEvent(new FocusEvent("blur"));
    await Promise.all(pending);
    expect(text(store.doc, "C")).toBe("Typed first. ![[Final#h]] and [[Final]] typed last");

    // An edit with nothing typed writes nothing after a rename.
    store.commit("set", (d) => void ((d.nodes[0] as CardNode).text = "[[Results]]"));
    el.dispatchEvent(new CustomEvent("lf-activate"));
    const again = el.querySelector("textarea")!;
    expect(again.value).toBe("[[Results]]");
    renameLinksInStore(store, r, RENAME);
    renderer.renameLinks!(RENAME);
    expect(again.value).toBe("[[Final]]");
    const commits: string[] = [];
    store.subscribe((ev) => ev.kind === "commit" && commits.push(ev.label));
    again.dispatchEvent(new FocusEvent("blur"));
    await Promise.all(pending);
    expect(commits).toEqual([]);
    expect(text(store.doc, "C")).toBe("[[Final]]");
  });
});

describe("what a link led to before the rename", () => {
  test("a relative link (`./`, `../`) is resolved against the figure's folder", () => {
    const rename = linkRenameFor("Notes/Results.md", "Notes/Final.md", "Figs/sub/fig.lnkfig.md", "../../Notes/Final", () => null);
    expect(rename.resolve("../../Notes/Results")).toBe("Notes/Results.md");
    expect(rename.resolve("../../Notes/Results.md")).toBe("Notes/Results.md");
    expect(rename.resolve("./../../Notes/Results")).toBe("Notes/Results.md");
    expect(rename.resolve("../Notes/Results")).toBeNull();
    const local = linkRenameFor("Figs/notes/a.md", "Figs/notes/b.md", "Figs/fig.lnkfig.md", "b", () => null);
    expect(local.resolve("./notes/a")).toBe("Figs/notes/a.md");
    expect(renameInCardText("See [[../../Notes/Results#h|x]]", rename.resolve, rename.oldPath, rename.linktext)).toBe("See [[../../Notes/Final#h|x]]");
  });

  test("a shortest-name link shadowed after the rename still counts as the renamed file's, as Obsidian resolved it before", () => {
    // `a/foo.md` was renamed to `a/bar.md`; `b/foo.md` exists, so `foo` finds it now.
    const now = (link: string) => (link === "foo" ? "b/foo.md" : link === "bar" ? "a/bar.md" : null);
    // From a figure in `a/`, `foo` led to the file beside it.
    expect(linkRenameFor("a/foo.md", "a/bar.md", "a/fig.lnkfig.md", "bar", now).resolve("foo")).toBe("a/foo.md");
    // From a figure in `b/`, it led to `b/foo.md`, which is not renamed.
    expect(linkRenameFor("a/foo.md", "a/bar.md", "b/fig.lnkfig.md", "bar", now).resolve("foo")).toBe("b/foo.md");
    // From elsewhere: neither beside it, the one with the shorter path.
    expect(linkRenameFor("x/y/foo.md", "x/y/bar.md", "fig.lnkfig.md", "bar", now).resolve("foo")).toBe("b/foo.md");
    expect(linkRenameFor("foo.md", "bar.md", "x/fig.lnkfig.md", "bar", now).resolve("foo")).toBe("foo.md");
    // A tie (as deep, neither beside it): which one the link led to cannot be told, so it is left alone.
    const tie = linkRenameFor("a/foo.md", "a/bar.md", "fig.lnkfig.md", "bar", now);
    expect(tie.resolve("foo")).toBe("b/foo.md");
    expect(renameInCardText("See [[foo]]", tie.resolve, tie.oldPath, tie.linktext)).toBe("See [[foo]]");
    // A folder move whose name still finds the moved file needs no rename.
    const moved = linkRenameFor("a/b/plot.png", "a/c/plot.png", "fig.lnkfig.md", "plot.png", (link) => (link === "plot.png" ? "a/c/plot.png" : null));
    expect(moved.resolve("plot.png")).toBe("a/c/plot.png");
  });
});

/** Obsidian 1.15's `FileManager.updateQueue` (a promise chain) and `inProgressUpdates`. */
function fileManager() {
  return {
    inProgressUpdates: null as unknown[] | null,
    updateQueue: {
      promise: Promise.resolve() as Promise<unknown>,
      queue(job: () => Promise<unknown>) {
        const next = this.promise.then(job, job);
        this.promise = next;
        return next;
      },
    },
  };
}

/** Figure files in memory, with what was read and processed. */
function host(r: Registries, files: Map<string, string>, open: Record<string, { renameLinks: (rename: unknown) => void } | "held"> = {}) {
  const processed: string[] = [];
  return {
    processed,
    host: {
      registries: r,
      figurePaths: () => [...files.keys()].filter((p) => p.endsWith(".lnkfig.md")),
      openFigure: (path: string) => (open[path] ?? null) as never,
      read: async (path: string) => files.get(path)!,
      process: async (path: string, edit: (text: string) => string) => {
        processed.push(path);
        files.set(path, edit(files.get(path)!));
      },
      linktext: (newPath: string) => newPath.slice(newPath.lastIndexOf("/") + 1).replace(/\.md$/, ""),
      resolve: (link: string) => resolveNow(link),
    },
  };
}

describe("closed figures", () => {
  test("a closed figure is rewritten through the queue, filtered by a text search; a figure that doesn't mention the file is not parsed", async () => {
    const r = registries();
    const files = new Map<string, string>([
      ["a.lnkfig.md", serializeFigureFile(figure({ C: "Legend ![[Results#h|x]]", N: { file: "Other" } }), emptyParsed())],
      // Not a figure that could be parsed: the text search keeps it from being read as one.
      ["b.lnkfig.md", "---\nlink-figures: 1\n---\nNothing about it here"],
      ["c.lnkfig.md", serializeFigureFile(figure({ C: "[[Other]]" }), emptyParsed())],
    ]);
    const openView = { renameLinks: vi.fn() };
    const { host: h, processed } = host(r, files, { "open.lnkfig.md": openView, "held.lnkfig.md": "held" });
    files.set("open.lnkfig.md", serializeFigureFile(figure({ C: "[[Results]]" }), emptyParsed()));
    files.set("held.lnkfig.md", serializeFigureFile(figure({ C: "[[Results]]" }), emptyParsed()));
    const fm = fileManager();
    fm.inProgressUpdates = [];
    let ran = false;
    // Obsidian's link update is under way: the rename waits for it.
    void fm.updateQueue.queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ran = true;
    });
    const follow = followRenames({ fileManager: fm } as never, h);
    const done = follow("Notes/Final.md", "Notes/Results.md");
    expect(processed).toEqual([]);
    fm.inProgressUpdates = null;
    await done;
    expect(ran).toBe(true);
    expect(processed).toEqual(["a.lnkfig.md"]);
    expect(text(loadDocument(files.get("a.lnkfig.md")!, r).doc, "C")).toBe("Legend ![[Final#h|x]]");
    expect(files.get("b.lnkfig.md")).toBe("---\nlink-figures: 1\n---\nNothing about it here");
    // The open figure takes the rename in its store; a held one is left alone.
    expect(openView.renameLinks).toHaveBeenCalledTimes(1);
    expect(text(loadDocument(files.get("held.lnkfig.md")!, r).doc, "C")).toBe("[[Results]]");
    expect(text(loadDocument(files.get("open.lnkfig.md")!, r).doc, "C")).toBe("[[Results]]");
    // A figure that mentions the name but holds no link to the file is processed and left byte for byte.
    files.set("d.lnkfig.md", serializeFigureFile(figure({ C: "Results, `[[Results]]`" }), emptyParsed()));
    const d = files.get("d.lnkfig.md");
    await renameLinksInFigures(h, "Notes/Results.md", "Notes/Final.md");
    expect(files.get("d.lnkfig.md")).toBe(d);
  });

  test("a closed figure with a pending link-update job stays valid, and both links are updated", async () => {
    const r = registries();
    const files = new Map<string, string>([["a.lnkfig.md", serializeFigureFile(figure({ C: "Text ![[Results#h]]", N: { file: "Notes/Results", subpath: "#h" } }), emptyParsed())]]);
    const { host: h } = host(r, files);
    const fm = fileManager();
    const follow = followRenames({ fileManager: fm } as never, h);
    let answer!: () => void;
    let followed!: Promise<void>;
    // Obsidian's job: it collects the Links section's link offsets, renames (the vault's rename event), waits for the
    // "Update links" prompt, then splices the new links in at the offsets it collected.
    const job = fm.updateQueue.queue(async () => {
      fm.inProgressUpdates = [];
      const before = files.get("a.lnkfig.md")!;
      const at = before.indexOf("![[Notes/Results#h]]") + 3;
      followed = follow("Notes/Final.md", "Notes/Results.md");
      await new Promise<void>((resolve) => (answer = resolve));
      const now = files.get("a.lnkfig.md")!;
      files.set("a.lnkfig.md", now.slice(0, at) + "Notes/Final" + now.slice(at + "Notes/Results".length));
      fm.inProgressUpdates = null;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    answer();
    await job;
    await followed;
    const loaded = loadDocument(files.get("a.lnkfig.md")!, r);
    expect(text(loaded.doc, "C")).toBe("Text ![[Final#h]]");
    expect(loaded.doc.nodes.find((n: Node) => n.id === "N")).toMatchObject({ file: "Notes/Final", subpath: "#h" });
  });
});
