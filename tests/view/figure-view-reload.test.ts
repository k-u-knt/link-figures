import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, createPage, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import type { ChangeEvent } from "../../src/model/store";
import type { Document, FileNode } from "../../src/model/types";
import type { Command, CommandContext } from "../../src/registry/command";
import { LinkFiguresView } from "../../src/view/figure-view";
import { TFile } from "obsidian";

// The view's base class and everything it draws with are stubs: what is tested is how the view takes up a changed file.
vi.mock("obsidian", () => {
  class TextFileView {
    app: unknown;
    file: { path: string } | null = null;
    data = "";
    registered: unknown[] = [];
    constructor(public leaf: { app: unknown }) {
      this.app = leaf.app;
    }
    registerEvent(ref: unknown): void {
      this.registered.push(ref);
    }
    registerDomEvent(): void {}
    register(): void {}
    requestSave = vi.fn();
  }
  return {
    TextFileView,
    Notice: class {},
    TFile: class {},
    Component: class {},
    Modal: class {},
    Setting: class {},
    PluginSettingTab: class {},
    Keymap: {},
    MarkdownRenderer: {},
    setIcon: () => {},
    normalizePath: (p: string) => p,
  };
});
vi.mock("../../src/view/context-menu", () => ({ showContextMenu: vi.fn() }));
vi.mock("../../src/export/export-modal", () => ({ ExportModal: class {} }));
vi.mock("../../src/links/intake", () => ({ Intake: class {} }));
vi.mock("../../src/view/inspector", () => ({ Inspector: class {} }));
vi.mock("../../src/view/toolbar", () => ({ Toolbar: class {} }));

const FIGURE_PATH = "figs/fig.lnkfig.md";

function figure(): Document {
  const doc = createDocument("nature-double");
  const [page] = doc.pages;
  const a = fileNodeDefaults(page, { file: "plot.png", subpath: "", show: "image" }, []);
  const b = fileNodeDefaults(page, { file: "analysis", subpath: "#Figure 2 legend", show: "content" }, [a.id]);
  const label = textNodeDefaults(page, { text: "A" }, [a.id, b.id]);
  doc.nodes.push(a, b, label);
  return doc;
}

const textOf = (doc: Document) => serializeFigureFile(doc, { ...emptyParsed(), preamble: "Notes.\n" });

/** A view as Obsidian would have built it, with the parts that need a browser replaced by recorders. */
function setup(initial: Document = figure()) {
  const vaultHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const on = (name: string, cb: (...args: unknown[]) => void) => {
    vaultHandlers.set(name, [...(vaultHandlers.get(name) ?? []), cb]);
    return { name, cb };
  };
  const disk = { text: "" };
  // Obsidian's own linktext for a file: its name alone, as when the name is unique in the vault.
  const fileToLinktext = vi.fn((file: { name: string }, _from: string, omitMd = true) => (omitMd ? file.name.replace(/\.md$/, "") : file.name));
  const app = { vault: { on, cachedRead: vi.fn(async () => disk.text) }, metadataCache: { on, fileToLinktext } };
  /** The files that a linktext finds, the figure's own folder aside: by default none. */
  const resolveLink = vi.fn((_path: string, _from: string): { path: string; extension: string } | null => null);
  const plugin = { app, registries: { nodeTypes: { get: () => undefined } }, access: { resolveLink }, decoders: {} };
  const view = new LinkFiguresView({ app } as never, plugin as never);
  const internals = view as unknown as Record<string, unknown>;

  const nodeHost = { reset: vi.fn(), renderAll: vi.fn(), resolveStale: vi.fn(async () => {}), applyChange: vi.fn() };
  const pointer = { commitTime: () => 0, rebind: vi.fn(), attach: vi.fn(), detach: vi.fn(), finishCrop: vi.fn() };
  const selection = { clear: vi.fn(), onChange: vi.fn(), ids: [] as string[] };
  const toolbar = { render: vi.fn() };
  const inspector = { render: vi.fn() };
  Object.assign(internals, {
    stageEl: {
      clientWidth: 0,
      clientHeight: 0,
      createDiv: () => ({ createDiv: () => ({}), createEl: () => ({}), remove: () => {} }),
      classList: { toggle: vi.fn() },
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
    },
    viewportEl: { show: () => {}, hide: () => {}, style: { transform: "", setProperty: vi.fn() } },
    nodeHost,
    pageLayer: { render: vi.fn() },
    pointer,
    intake: { attach: vi.fn() },
    selection,
    toolbar,
    inspector,
  });
  view.file = { path: FIGURE_PATH } as never;

  const open = (doc: Document) => {
    const text = textOf(doc);
    disk.text = text;
    view.data = text;
    view.setViewData(text, true);
    return text;
  };
  const text0 = open(initial);
  const events: ChangeEvent[] = [];
  const watch = () => view.store.subscribe((ev) => void events.push(ev));
  let unwatch = watch();

  /** Obsidian saw the file change: it records the text in `data` and calls `setViewData`. */
  const obsidianLoads = (text: string) => {
    disk.text = text;
    view.data = text;
    view.setViewData(text, false);
  };
  /** The vault says the figure file was modified. */
  const vaultModifies = async (path = FIGURE_PATH) => {
    for (const cb of vaultHandlers.get("modify") ?? []) cb({ path });
    await vi.waitFor(() => expect(view.app.vault.cachedRead).toHaveBeenCalled(), { timeout: 200 }).catch(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const resetCalls = () => {
    for (const fn of [nodeHost.reset, nodeHost.renderAll, nodeHost.resolveStale, nodeHost.applyChange, pointer.rebind, selection.clear]) fn.mockClear();
    (view.app.vault.cachedRead as ReturnType<typeof vi.fn>).mockClear();
    events.length = 0;
  };
  return { resolveLink, view, nodeHost, pointer, selection, toolbar, inspector, disk, text0, events, obsidianLoads, vaultModifies, resetCalls, vaultHandlers, rewatch: () => { unwatch(); unwatch = watch(); } };
}

const link = (view: LinkFiguresView, index: number) => {
  const node = view.store.doc.nodes[index] as FileNode;
  return `${node.file}${node.subpath}`;
};

beforeEach(() => {
  vi.stubGlobal("window", { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, setTimeout, clearTimeout });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("opening", () => {
  test("a figure that was opened is loaded, with nothing of an earlier one kept", () => {
    const t = setup();
    expect(t.view.store.doc.nodes).toHaveLength(3);
    expect(t.nodeHost.reset).toHaveBeenCalled();
    expect(t.nodeHost.renderAll).toHaveBeenCalledTimes(2); // the blank stand-in, then the figure
    expect(t.nodeHost.resolveStale).toHaveBeenCalled();
    expect(t.view.getViewData()).toBe(t.text0);
  });
});

describe("an untouched figure is saved back as it was read", () => {
  test("even when the store's normalisers would change it (a group whose box is stale): opening and closing never rewrites it", async () => {
    const { groupNodeType } = await import("../../src/nodes/group-node");
    const doc = figure();
    const [a, b] = doc.nodes;
    a.parent = "g";
    b.parent = "g";
    // A box no member gives: the group normaliser puts it right in the store.
    doc.nodes.push({ id: "g", type: "group", page: doc.pages[0].id, x: 0, y: 0, width: 1, height: 1, z: 9, rotation: 0, opacity: 1, locked: false } as never);
    const t = setup(doc);
    const plugin = (t.view as unknown as { plugin: { registries: { nodeTypes: { get: (type: string) => unknown } } } }).plugin;
    plugin.registries.nodeTypes.get = (type: string) => (type === "group" ? groupNodeType : undefined);
    const text = textOf(doc);
    t.disk.text = text;
    t.view.data = text;
    t.view.setViewData(text, true);
    expect(t.view.store.doc.nodes.find((n) => n.id === "g")!.width).not.toBe(1);
    // What Obsidian's save (and the save on closing a tab) writes: the text as it was read, so nothing is written.
    expect(t.view.getViewData()).toBe(text);
    // An edit is saved, normalised.
    t.view.store.commit("move", (d) => void (d.nodes[2].x = 5));
    expect(t.view.getViewData()).not.toBe(text);
  });
});

describe("a source renamed: Obsidian rewrites the Links section and hands the text to setViewData", () => {
  test("the open figure is kept: same store, history, selection and drawing; only the renamed panel is told", () => {
    const t = setup();
    const store = t.view.store;
    store.commit("move", (d) => void (d.nodes[1].x = 40));
    const edited = serializeFigureFile(store.doc, t.view.parsed);
    t.resetCalls();

    t.obsidianLoads(edited.replace("![[plot.png]]", "![[plot2.png]]"));

    expect(t.view.store).toBe(store);
    expect(link(t.view, 0)).toBe("plot2.png");
    expect(link(t.view, 1)).toBe("analysis#Figure 2 legend");
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ kind: "replace", label: "links", pagesChanged: false });
    expect([...t.events[0].changedNodeIds]).toEqual([store.doc.nodes[0].id]);
    // Nothing was loaded anew.
    expect(t.nodeHost.reset).not.toHaveBeenCalled();
    expect(t.nodeHost.renderAll).not.toHaveBeenCalled();
    expect(t.pointer.rebind).not.toHaveBeenCalled();
    expect(t.selection.clear).not.toHaveBeenCalled();
    // Undo still takes the move back, and leaves the link as it now is.
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.doc.nodes[1].x).toBe(0);
    expect(link(t.view, 0)).toBe("plot2.png");
  });

  test("delete, then a rename, then undo: the panel that was never deleted keeps the new link, in the figure and in what is saved", () => {
    const t = setup();
    const store = t.view.store;
    const [, legend] = store.doc.nodes;
    // What the Delete key does (the `delete` command): the nodes filtered out in one commit.
    store.commit("delete", (d) => void (d.nodes = d.nodes.filter((n) => n.id !== legend.id)));
    t.obsidianLoads(serializeFigureFile(store.doc, t.view.parsed).replace("![[plot.png]]", "![[plot2.png]]"));
    expect(link(t.view, 0)).toBe("plot2.png");

    store.undo();
    expect(store.doc.nodes.map((n) => n.id)).toContain(legend.id);
    expect(link(t.view, 0)).toBe("plot2.png");
    const saved = t.view.getViewData();
    expect(saved).toContain("![[plot2.png]]");
    expect(saved).not.toContain("![[plot.png]]");
    expect(saved).toContain("![[analysis#Figure 2 legend]]");

    store.redo();
    expect(store.doc.nodes.map((n) => n.id)).not.toContain(legend.id);
    expect(link(t.view, 0)).toBe("plot2.png");
    expect(t.view.getViewData()).toContain("![[plot2.png]]");
    expect(t.view.getViewData()).not.toContain("![[plot.png]]");
  });

  test("it is not an edit: nothing is saved, and what is saved afterwards carries the new link", () => {
    const t = setup();
    const renamed = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    t.obsidianLoads(renamed);
    expect((t.view as unknown as { requestSave: ReturnType<typeof vi.fn> }).requestSave).not.toHaveBeenCalled();
    // Untouched, the figure goes back byte for byte as the file now is.
    expect(t.view.getViewData()).toBe(renamed);
    t.view.store.commit("move", (d) => void (d.nodes[1].x = 5));
    expect(t.view.getViewData()).toContain("![[plot2.png]]");
    expect(t.view.getViewData()).not.toContain("![[plot.png]]");
  });

  test("a heading renamed in the note, and a file moved to another folder, are handled the same way", () => {
    const t = setup();
    t.obsidianLoads(t.text0.replace("![[analysis#Figure 2 legend]]", "![[analysis#Legend]]").replace("![[plot.png]]", "![[plots/plot.png]]"));
    expect(link(t.view, 0)).toBe("plots/plot.png");
    expect(link(t.view, 1)).toBe("analysis#Legend");
  });

  test("a rename that is undone outside brings the old link back", () => {
    const t = setup();
    t.obsidianLoads(t.text0.replace("![[plot.png]]", "![[plot2.png]]"));
    t.obsidianLoads(t.text0);
    expect(link(t.view, 0)).toBe("plot.png");
  });

  test("the same text again changes nothing and draws nothing", () => {
    const t = setup();
    const store = t.view.store;
    t.resetCalls();
    t.obsidianLoads(t.text0);
    expect(t.view.store).toBe(store);
    expect(t.nodeHost.renderAll).not.toHaveBeenCalled();
    expect(t.nodeHost.applyChange).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  test("with unsaved edits in the figure, Obsidian's merged text is taken up without losing them", () => {
    const t = setup();
    const store = t.view.store;
    store.commit("move", (d) => void (d.nodes[2].x = 77));
    const merged = serializeFigureFile(store.doc, t.view.parsed).replace("![[plot.png]]", "![[plot2.png]]");
    t.obsidianLoads(merged);
    expect(t.view.store).toBe(store);
    expect(store.doc.nodes[2].x).toBe(77);
    expect(link(t.view, 0)).toBe("plot2.png");
    expect(t.view.getViewData()).toBe(merged);
  });

  test("a file in an odd format (minified JSON) is still told apart by what it says, not how it is written", () => {
    const t = setup();
    const store = t.view.store;
    const written = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    const json = /```lnkfig\n([\s\S]*?)\n```/.exec(written)![1];
    t.obsidianLoads(written.replace(json, JSON.stringify(JSON.parse(json))));
    expect(t.view.store).toBe(store);
    expect(link(t.view, 0)).toBe("plot2.png");
  });
});

describe("any other change to the file is loaded anew", () => {
  test("a figure that differs in more than its links gets a new store, and keeps what is still valid of what was resolved", () => {
    const t = setup();
    const store = t.view.store;
    store.commit("move", (d) => void (d.nodes[1].x = 1));
    t.resetCalls();
    const other = structuredClone(figure());
    other.nodes = structuredClone(t.view.store.doc.nodes);
    other.pages = structuredClone(t.view.store.doc.pages);
    (other.nodes[2] as { text: string }).text = "B";

    t.obsidianLoads(textOf(other).replace("![[plot.png]]", "![[plot2.png]]"));

    expect(t.view.store).not.toBe(store);
    expect(t.view.store.canUndo()).toBe(false);
    expect(link(t.view, 0)).toBe("plot2.png");
    expect(t.pointer.rebind).toHaveBeenCalled();
    expect(t.selection.clear).toHaveBeenCalled();
    expect(t.nodeHost.renderAll).toHaveBeenCalledTimes(1);
    // The same file read again: resolutions of unchanged links are kept for `renderAll` to find.
    expect(t.nodeHost.reset).not.toHaveBeenCalled();
    expect(t.nodeHost.resolveStale).toHaveBeenCalledTimes(1);
  });

  test("a different file (clear) forgets every resolution", () => {
    const t = setup();
    t.resetCalls();
    t.view.setViewData(textOf(figure()), true);
    expect(t.nodeHost.reset).toHaveBeenCalled();
  });

  test("a file that cannot be read is shown as it is, and not touched", () => {
    const t = setup();
    t.obsidianLoads("---\nlink-figures: 1\n---\n## Figure\n```lnkfig\n{ not json\n```\n");
    expect(t.view.readOnly).toBe(true);
    expect(t.view.getViewData()).toContain("{ not json");
  });
});

describe("the armed tool", () => {
  const tool = (): Command => ({ id: "tool", name: "Tool", group: "insert", applies: () => true, run() {}, place: vi.fn() });
  const corrupt = "---\nlink-figures: 1\n---\n## Figure\n```lnkfig\n{ not json\n```\n";

  test("a reload from disk disarms the tool, and a read-only file cannot arm one", () => {
    const t = setup();
    const stage = t.view.stageEl as unknown as { classList: { toggle: ReturnType<typeof vi.fn> }; style: { setProperty: ReturnType<typeof vi.fn> } };
    const armed = tool();
    t.view.armTool(armed);
    expect(t.view.armedTool).toBe(armed);
    // The stage shows it: the class, and the tool's cursor (a crosshair when it names none).
    expect(stage.classList.toggle).toHaveBeenLastCalledWith("lf-tool-armed", true);
    expect(stage.style.setProperty).toHaveBeenLastCalledWith("--lf-tool-cursor", "crosshair");

    t.view.setViewData(textOf(figure()), true);
    expect(t.view.armedTool).toBeNull();
    expect(stage.classList.toggle).toHaveBeenLastCalledWith("lf-tool-armed", false);

    t.view.armTool(armed);
    t.obsidianLoads(corrupt);
    expect(t.view.readOnly).toBe(true);
    expect(t.view.armedTool).toBeNull();
    t.view.armTool(armed);
    expect(t.view.armedTool).toBeNull();
    expect(armed.place).not.toHaveBeenCalled();
  });

  test("arming the armed tool again disarms it; placing disarms it first, and a failure is reported rather than thrown", () => {
    const t = setup();
    const armed = tool();
    t.view.armTool(armed);
    t.view.armTool(armed);
    expect(t.view.armedTool).toBeNull();

    const page = t.view.store.doc.pages[0];
    let armedWhilePlacing: Command | null | undefined;
    vi.mocked(armed.place!).mockImplementation((ctx) => {
      armedWhilePlacing = (ctx.view as typeof t.view).armedTool;
      throw new Error("no room");
    });
    t.view.armTool(armed);
    expect(() => t.view.placeTool({ page, x: 5, y: 6 })).not.toThrow();
    expect(armed.place).toHaveBeenCalledWith(expect.objectContaining({ view: t.view, store: t.view.store }), { page, x: 5, y: 6 });
    expect(armedWhilePlacing).toBeNull();
    expect(t.view.armedTool).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("the chrome follows the stage", () => {
  /** `requestAnimationFrame` as a queue the test runs by hand, with `cancelAnimationFrame` taking a callback out of it. */
  function frames() {
    const queue = new Map<number, () => void>();
    let last = 0;
    vi.stubGlobal("window", {
      requestAnimationFrame: (cb: () => void) => {
        queue.set(++last, cb);
        return last;
      },
      cancelAnimationFrame: vi.fn((id: number) => void queue.delete(id)),
      setTimeout,
      clearTimeout,
    });
    return queue;
  }

  test("applyViewport renders the chrome once per animation frame", () => {
    const queue = frames();
    const t = setup();
    // What loading the figure asked for (the fit) is none of this test's business.
    queue.clear();
    t.toolbar.render.mockClear();
    t.inspector.render.mockClear();

    t.view.applyViewport();
    t.view.applyViewport();
    expect(queue.size).toBe(1);
    expect(t.inspector.render).not.toHaveBeenCalled();

    [...queue.values()][0]();
    expect(t.toolbar.render).toHaveBeenCalledTimes(1);
    expect(t.inspector.render).toHaveBeenCalledTimes(1);

    // The frame has run, so the next pan or zoom asks for another.
    queue.clear();
    t.view.applyViewport();
    expect(queue.size).toBe(1);
  });

  test("a chrome that cannot draw does not break the pan", () => {
    const queue = frames();
    const t = setup();
    queue.clear();
    t.inspector.render.mockImplementation(() => {
      throw new Error("no room");
    });
    t.view.applyViewport();
    expect(() => [...queue.values()][0]()).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  test("closing the view cancels the frame that was waiting", async () => {
    const queue = frames();
    const t = setup();
    queue.clear();
    t.inspector.render.mockClear();
    t.view.applyViewport();
    expect(queue.size).toBe(1);
    await t.view.onClose();
    expect(queue.size).toBe(0);
    expect(t.inspector.render).not.toHaveBeenCalled();
  });
});

describe("reloadLinks", () => {
  test("does nothing before a figure is loaded, and for a file that could not be read", () => {
    const t = setup();
    t.obsidianLoads("---\nlink-figures: 1\n---\n## Figure\n```lnkfig\n{ not json\n```\n");
    t.resetCalls();
    t.view.reloadLinks(t.text0.replace("![[plot.png]]", "![[plot2.png]]"));
    expect(t.events).toEqual([]);
  });

  test("ignores text that is not a figure file, or whose code block is open", () => {
    const t = setup();
    t.resetCalls();
    t.view.reloadLinks("just a note\n");
    t.view.reloadLinks("---\nlink-figures: 1\n---\n## Figure\n```lnkfig\n{");
    expect(link(t.view, 0)).toBe("plot.png");
    expect(t.events).toEqual([]);
  });

  test("a Links section with the same targets is no event at all", () => {
    const t = setup();
    t.resetCalls();
    t.view.reloadLinks(t.text0);
    expect(t.events).toEqual([]);
  });

  test("reads the Links section only: the rest of the text is not applied", () => {
    const t = setup();
    const moved = figure();
    moved.nodes = structuredClone(t.view.store.doc.nodes);
    moved.pages = structuredClone(t.view.store.doc.pages);
    moved.nodes[0].x = 999;
    t.view.reloadLinks(textOf(moved).replace("![[plot.png]]", "![[plot2.png]]"));
    expect(link(t.view, 0)).toBe("plot2.png");
    expect(t.view.store.doc.nodes[0].x).toBe(0);
  });
});

describe("the figure file modified (the fallback for a change setViewData is not told of)", () => {
  async function opened() {
    const t = setup();
    await t.view.onOpen();
    t.resetCalls();
    return t;
  }

  test("onOpen listens for modifications of the file", async () => {
    const t = await opened();
    expect(t.vaultHandlers.get("modify")?.length).toBe(2); // the link watcher, and the view's own
  });

  test("a rewritten Links section is applied when setViewData never hears of it", async () => {
    const t = await opened();
    const reload = vi.spyOn(t.view, "reloadLinks");
    t.disk.text = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    await t.vaultModifies();
    expect(reload).toHaveBeenCalledWith(t.disk.text);
    expect(link(t.view, 0)).toBe("plot2.png");
  });

  test("keeps the history and the figure it had", async () => {
    const t = await opened();
    const store = t.view.store;
    store.commit("move", (d) => void (d.nodes[1].x = 3));
    t.disk.text = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    await t.vaultModifies();
    expect(t.view.store).toBe(store);
    expect(store.canUndo()).toBe(true);
    expect(store.doc.nodes[1].x).toBe(3);
    expect(link(t.view, 0)).toBe("plot2.png");
  });

  test("the view's own save is left alone, whether Obsidian has recorded it in data or it is what the view would write", async () => {
    const t = await opened();
    const store = t.view.store;
    store.commit("move", (d) => void (d.nodes[1].x = 3));
    const reload = vi.spyOn(t.view, "reloadLinks");
    const saved = t.view.getViewData();
    t.disk.text = saved;
    t.view.data = saved;
    await t.vaultModifies();
    // And the case where an edit came in between the save and the event.
    store.commit("move", (d) => void (d.nodes[1].x = 4));
    await t.vaultModifies();
    expect(reload).not.toHaveBeenCalled();
    // What the view would write as it stands is no news either, whatever `data` holds.
    t.view.data = "";
    t.disk.text = t.view.getViewData();
    await t.vaultModifies();
    expect(reload).not.toHaveBeenCalled();
    expect(link(t.view, 0)).toBe("plot.png");
    expect(store.doc.nodes[1].x).toBe(4);
    expect(t.view.getViewData()).toContain('"x": 4');
  });

  test("a change setViewData already took up is not applied twice", async () => {
    const t = await opened();
    t.rewatch();
    const renamed = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    t.obsidianLoads(renamed);
    expect(t.events).toHaveLength(1);
    const reload = vi.spyOn(t.view, "reloadLinks");
    await t.vaultModifies();
    expect(reload).not.toHaveBeenCalled();
    expect(t.events).toHaveLength(1);
  });

  test("and when the fallback gets there first, setViewData finds nothing left to do", async () => {
    const t = await opened();
    t.rewatch();
    const renamed = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    t.disk.text = renamed;
    await t.vaultModifies();
    expect(t.events).toHaveLength(1);
    t.obsidianLoads(renamed);
    expect(t.events).toHaveLength(1);
    expect(t.nodeHost.renderAll).not.toHaveBeenCalled();
    expect(t.view.getViewData()).toBe(renamed);
  });

  test("another file's modification is not ours", async () => {
    const t = await opened();
    t.disk.text = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    await t.vaultModifies("figs/other.lnkfig.md");
    expect(t.view.app.vault.cachedRead).not.toHaveBeenCalled();
    expect(link(t.view, 0)).toBe("plot.png");
  });

  test("follows the figure file when it is renamed", async () => {
    const t = await opened();
    t.view.file = { path: "moved/fig.lnkfig.md" } as never;
    t.disk.text = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    await t.vaultModifies(FIGURE_PATH);
    expect(link(t.view, 0)).toBe("plot.png");
    await t.vaultModifies("moved/fig.lnkfig.md");
    expect(link(t.view, 0)).toBe("plot2.png");
  });

  test("a figure that has since been switched to another file is left alone", async () => {
    const t = await opened();
    t.disk.text = t.text0.replace("![[plot.png]]", "![[plot2.png]]");
    const read = t.view.app.vault.cachedRead as ReturnType<typeof vi.fn>;
    read.mockImplementationOnce(async () => {
      t.view.file = { path: "figs/another.lnkfig.md" } as never;
      return t.disk.text;
    });
    await t.vaultModifies();
    expect(link(t.view, 0)).toBe("plot.png");
  });

  test("a failing read, and a file that could not be read as a figure, are left alone", async () => {
    const t = await opened();
    (t.view.app.vault.cachedRead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    await t.vaultModifies();
    expect(link(t.view, 0)).toBe("plot.png");
    t.disk.text = "no longer a figure";
    await t.vaultModifies();
    expect(link(t.view, 0)).toBe("plot.png");
  });
});

describe("the nodes the watcher is told are missing", () => {
  test("are the file nodes whose resolution says the file, or the image in the note, was not found", () => {
    const t = setup();
    const [a, b] = t.view.store.doc.nodes;
    t.view.resolvedCache.set(a.id, { kind: "missing", reason: "file", deps: [] });
    t.view.resolvedCache.set(b.id, { kind: "missing", reason: "subpath", deps: [] });
    // The watcher's provider is the last constructor argument; what it asks is answered from the view's own state.
    const watcher = t.view.watcher as unknown as { missingIds: () => string[] };
    expect(watcher.missingIds()).toEqual([a.id]);
    t.view.resolvedCache.set(b.id, { kind: "missing", reason: "no-image", deps: [] });
    expect(watcher.missingIds()).toEqual([a.id, b.id]);
  });
});

test("the node a text label stands for is never reloaded as a file", () => {
  const t = setup();
  const label = t.view.store.doc.nodes[2];
  t.obsidianLoads(t.text0.replace("![[plot.png]]", "![[plot2.png]]"));
  expect(t.view.store.doc.nodes[2]).toBe(label);
  expect(loadDocument(t.view.getViewData()).doc.nodes[2]).toEqual(label);
});

describe("a source renamed while a panel that links to it is deleted", () => {
  /** A vault file as the rename event hands it over: already at its new path. */
  const vaultFile = (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return Object.assign(new TFile(), { path, name, extension: name.slice(name.lastIndexOf(".") + 1) });
  };
  async function deleted(file: string, subpath = "", show: "image" | "content" = "image") {
    const doc = figure();
    doc.nodes.push(fileNodeDefaults(doc.pages[0], { file, subpath, show }, doc.nodes.map((n) => n.id)));
    const t = setup(doc);
    await t.view.onOpen();
    const store = t.view.store;
    const gone = store.doc.nodes[3];
    store.commit("delete", (d) => void (d.nodes = d.nodes.filter((n) => n.id !== gone.id)));
    const renames = (newPath: string, oldPath: string) => {
      for (const cb of t.vaultHandlers.get("rename") ?? []) cb(vaultFile(newPath), oldPath);
    };
    return { ...t, store, gone, renames };
  }
  const restored = (t: { store: LinkFiguresView["store"] }, id: string) => {
    const node = t.store.doc.nodes.find((n) => n.id === id) as FileNode | undefined;
    return node ? `${node.file}${node.subpath}` : "(absent)";
  };

  test("undo brings the panel back with the new name, in the figure and in what is saved", async () => {
    const t = await deleted("only-here.svg");
    t.renames("only-here-2.svg", "only-here.svg");
    t.store.undo();
    expect(restored(t, t.gone.id)).toBe("only-here-2.svg");
    expect(t.view.getViewData()).toContain("![[only-here-2.svg]]");
    expect(t.view.getViewData()).not.toContain("![[only-here.svg]]");
  });

  test("redo after undo after the rename keeps the new name", async () => {
    const t = await deleted("only-here.svg");
    t.renames("only-here-2.svg", "only-here.svg");
    t.store.undo();
    t.store.redo();
    expect(restored(t, t.gone.id)).toBe("(absent)");
    t.store.undo();
    expect(restored(t, t.gone.id)).toBe("only-here-2.svg");
  });

  test("a rename of an unrelated file changes nothing", async () => {
    const t = await deleted("only-here.svg");
    t.renames("other-2.svg", "other.svg");
    t.store.undo();
    expect(restored(t, t.gone.id)).toBe("only-here.svg");
    expect(link(t.view, 0)).toBe("plot.png");
  });

  test("a link written as the full path keeps that form, and a note's subpath stays", async () => {
    const t = await deleted("notes/results", "#Legend", "content");
    t.renames("notes/findings.md", "notes/results.md");
    t.store.undo();
    expect(restored(t, t.gone.id)).toBe("notes/findings#Legend");
  });

  test("a short name is matched against the renamed file's own path, and given Obsidian's linktext for the new one", async () => {
    const t = await deleted("only-here.svg");
    t.renames("plots/only-here-2.svg", "plots/only-here.svg");
    t.store.undo();
    expect(restored(t, t.gone.id)).toBe("only-here-2.svg");
  });

  test("a name that still finds another file is not taken for the renamed one", async () => {
    const t = await deleted("only-here.svg");
    t.resolveLink.mockImplementation((path) => (path === "only-here.svg" ? { path: "elsewhere/only-here.svg", extension: "svg" } : null));
    t.renames("plots/only-here-2.svg", "plots/only-here.svg");
    t.store.undo();
    expect(restored(t, t.gone.id)).toBe("only-here.svg");
  });
});

describe("the right-click menu and the commands it runs", () => {
  test("a page menu focuses its page only until the next menu: a canvas menu after it acts on the nearest page again", () => {
    const t = setup();
    (t.view as unknown as { stageEl: object }).stageEl = { ...(t.view as unknown as { stageEl: object }).stageEl, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
    t.view.store.commit("add", (d) => void d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id))));
    const [first, second] = t.view.store.doc.pages;
    t.view.openContextMenu("page", { x: 1, y: 1 }, second.id);
    expect(t.view.focusPage().id).toBe(second.id);
    t.view.openContextMenu("canvas", { x: 1, y: 1 }, null);
    expect(t.view.focusPage().id).toBe(first.id);
  });

  test("a command run from the toolbar or the menu is an undo step of its own, though it follows an edit of the same label at once", () => {
    const t = setup();
    const lock = { id: "lock", name: "Lock", applies: () => true, run: (ctx: CommandContext) => ctx.store.commit("node.update", (d: Document) => void (d.nodes[0].locked = true)) } as unknown as Command;
    (t.view.plugin.registries as unknown as { commands: object }).commands = { get: (id: string) => (id === "lock" ? lock : undefined) };
    t.view.store.commit("node.update", (d) => void (d.nodes[0].x = 40));
    t.view.runCommandById("lock");
    expect(t.view.store.doc.nodes[0]).toMatchObject({ x: 40, locked: true });
    t.view.store.undo();
    expect(t.view.store.doc.nodes[0]).toMatchObject({ x: 40 });
    expect(t.view.store.doc.nodes[0].locked).toBeFalsy();
    t.view.store.undo();
    expect(t.view.store.doc.nodes[0].x).not.toBe(40);
  });
});
