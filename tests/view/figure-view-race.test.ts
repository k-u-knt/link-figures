import { createApi } from "../../src/api";
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { cardCommands } from "../../src/commands/cards";
import { drawingCommands } from "../../src/commands/drawing";
import { FigureWrites } from "../../src/commands/figure-writes";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { loadDocument } from "../../src/format/load";
import { serializeFigureFile } from "../../src/format/serialize";
import { newFigureText } from "../../src/format/new-figure";
import { shapeNodeDefaults } from "../../src/model/defaults";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { createRegistries } from "../../src/registry";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { createDocument } from "../../src/model/defaults";
import { emptyParsed } from "../../src/format/serialize";
import { TFile } from "obsidian";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { LinkFiguresView } from "../../src/view/figure-view";

const notices = vi.hoisted(() => [] as string[]);

/**
 * Obsidian's TextFileView as 1.15 has it (read from its app.js): `requestSave` marks the view dirty and saves after 2 s;
 * a save writes `getViewData()` when it differs from `lastSavedData`; a vault `modify` of the file reads it and, while the
 * view is dirty with text of its own, merges base, ours and theirs as plain text when `isPlaintext` (true by default).
 */
vi.mock("obsidian", () => {
  /** What Obsidian's merge does to two insertions at one place: both, theirs first, with nothing between them. */
  const merge = (base: string, ours: string, theirs: string): string => {
    let p = 0;
    while (p < base.length && base[p] === ours[p] && base[p] === theirs[p]) p++;
    let s = 0;
    const at = (t: string, i: number) => t[t.length - 1 - i];
    while (s < base.length - p && at(base, s) === at(ours, s) && at(base, s) === at(theirs, s)) s++;
    return theirs.slice(0, theirs.length - s) + ours.slice(p, ours.length - s) + theirs.slice(theirs.length - s);
  };
  class TextFileView {
    app: any;
    file: any = null;
    data: string | null = null;
    lastSavedData: string | null = null;
    savePromise: Promise<void> | null = null;
    isPlaintext = true;
    dirty = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    requestSave: () => void;
    constructor(public leaf: { app: any }) {
      this.app = leaf.app;
      this.requestSave = () => {
        this.dirty = true;
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          void this.save();
        }, 2000);
      };
      this.app.vault.on("modify", (file: unknown) => this.onModify(file));
    }
    get saving(): boolean {
      return this.savePromise !== null;
    }
    registerEvent(): void {}
    registerDomEvent(): void {}
    register(): void {}
    async onLoadFile(file: unknown): Promise<void> {
      await this.loadFileInternal(file, true);
    }
    async onUnloadFile(): Promise<void> {
      await this.save(true);
    }
    async save(clear?: boolean): Promise<void> {
      this.dirty = false;
      while (this.savePromise !== null) await this.savePromise.catch(() => {});
      const file = this.file;
      if (!file) return;
      const text = (this as any).getViewData();
      if (this.lastSavedData !== text && this.lastSavedData !== null) {
        this.data = text;
        this.lastSavedData = text;
        this.savePromise = this.app.vault.modify(file, text);
        try {
          await this.savePromise;
        } finally {
          this.savePromise = null;
        }
        if (clear) {
          this.data = null;
          this.lastSavedData = null;
          (this as any).clear();
        }
      }
    }
    onModify(file: unknown): void {
      if (this.saving || file !== this.file) return;
      void this.loadFileInternal(file, false);
    }
    async loadFileInternal(file: unknown, initial: boolean): Promise<void> {
      let text: string = await this.app.vault.read(file);
      const base = this.lastSavedData;
      this.lastSavedData = text;
      if (!initial && base) {
        if (base === text) return;
        if (this.dirty) {
          const ours = (this as any).getViewData();
          if (ours === text) return;
          if (ours !== base && this.isPlaintext) text = merge(base, ours, text);
        }
      }
      if (this.data === text && !initial) return;
      this.data = text;
      (this as any).setViewData(text, initial);
    }
  }
  return {
    TextFileView,
    Notice: class {
      constructor(message: string) {
        notices.push(message);
      }
    },
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
vi.mock("../../src/format/serialize", async (original) => {
  const actual = await original<typeof import("../../src/format/serialize")>();
  return { ...actual, serializeFigureFile: vi.fn(actual.serializeFigureFile) };
});
vi.mock("../../src/view/context-menu", () => ({ showContextMenu: vi.fn() }));
vi.mock("../../src/export/export-modal", () => ({ ExportModal: class {} }));
vi.mock("../../src/links/intake", () => ({ Intake: class {} }));
vi.mock("../../src/view/inspector", () => ({ Inspector: class {} }));
vi.mock("../../src/view/toolbar", () => ({ Toolbar: class {} }));

const PATH = "Notes/M2i OpenN.lnkfig.md";

const parses = (text: string): boolean => {
  try {
    loadDocument(text);
    return true;
  } catch {
    return false;
  }
};
const ids = (text: string) => loadDocument(text).doc.nodes.map((n) => n.id).sort();

/** A vault holding one figure file, as Obsidian's behaves for what the view and the API do with it. */
function setup(initialText = newFigureText("a4-portrait", 1), options: { linkQueue?: boolean } = {}) {
  const registries = createRegistries();
  registerBuiltinCommands({ registries, addCommand: () => undefined, activeFigureView: () => null } as never);
  registries.nodeTypes.register(shapeNodeType);
  registries.nodeTypes.register(connectorNodeType);
  registries.nodeTypes.register(cardNodeType);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  for (const route of builtinRoutes) registries.routes.register(route);
  for (const cap of builtinCapKinds) registries.caps.register(cap);
  for (const command of [...drawingCommands(), ...cardCommands()]) registries.commands.register(command);

  type FakeFile = { path: string; name: string; saving: boolean };
  const texts = new Map<string, string>();
  const fileObjs = new Map<string, FakeFile>();
  /** A figure file in the vault (made on first use, with `text`). */
  const fileAt = (path: string, text = newFigureText("a4-portrait", 1)): FakeFile => {
    let f = fileObjs.get(path);
    if (!f) {
      f = { path, name: path.split("/").pop()!, saving: false };
      fileObjs.set(path, f);
      texts.set(path, text);
    }
    return f;
  };
  const file = fileAt(PATH, initialText);
  /** The figure file's text (PATH's). */
  const disk = {
    get text() {
      return texts.get(PATH)!;
    },
    set text(t: string) {
      texts.set(PATH, t);
    },
  };
  /** Every text written to a file, by whom. */
  const writes: { by: string; path: string; text: string }[] = [];
  const handlers: ((f: unknown) => void)[] = [];
  const modified = (f: FakeFile) => handlers.forEach((h) => h(f));
  const hooks = {
    /** Runs while the view's `vault.modify` is under way, after its write (a sync landing then). */
    duringModify: null as null | ((f: FakeFile) => void),
    /** While set, `process` never finishes. */
    stuck: false,
    /** While set, `create` fails (a backup cannot be written). */
    createFails: false,
  };
  const vault = {
    on: (name: string, cb: (f: unknown) => void) => {
      if (name === "modify") handlers.push(cb);
      return {};
    },
    offref: () => {},
    read: vi.fn(async (f: FakeFile) => {
      await new Promise((r) => setTimeout(r, 1));
      return texts.get(f.path)!;
    }),
    cachedRead: vi.fn(async (f: FakeFile) => texts.get(f.path)!),
    create: vi.fn(async (path: string, text: string) => {
      if (hooks.createFails || texts.has(path)) throw new Error(`cannot create "${path}"`);
      texts.set(path, text);
      writes.push({ by: "create", path, text });
    }),
    modify: vi.fn(async (f: FakeFile, text: string) => {
      texts.set(f.path, text);
      writes.push({ by: "view", path: f.path, text });
      modified(f);
      await new Promise((r) => setTimeout(r, 5));
      const hook = hooks.duringModify;
      hooks.duringModify = null;
      hook?.(f);
    }),
    /** Reads, then (some time later) writes what `edit` gives, as one step of its own; the modify event comes with the write. */
    process: vi.fn(async (f: FakeFile, edit: (t: string) => string) => {
      const before = texts.get(f.path)!;
      if (hooks.stuck) await new Promise(() => {});
      await new Promise((r) => setTimeout(r, 150));
      const after = edit(before);
      if (after !== before) {
        texts.set(f.path, after);
        writes.push({ by: "process", path: f.path, text: after });
        modified(f);
      }
      return after;
    }),
  };
  const metadataCache = { on: () => ({}), fileToLinktext: (f: { path: string }) => f.path.replace(/\.md$/, "") };
  /** Obsidian's queue of link updates (`FileManager.updateQueue`), as 1.15 has it. */
  const updateQueue = {
    promise: Promise.resolve() as Promise<unknown>,
    queue(job: () => Promise<unknown>) {
      const next = this.promise.then(job, job);
      this.promise = next;
      return next;
    },
  };
  const fileManager: Record<string, unknown> = options.linkQueue === false ? {} : { updateQueue, inProgressUpdates: null };
  const app = { vault, metadataCache, workspace: {}, fileManager };
  const figureWrites = new FigureWrites();
  const plugin = { app, registries, access: { resolveLink: () => null }, decoders: {}, figureWrites, settings: undefined };

  let view: LinkFiguresView | null = null;
  const makeView = () => {
    const v = new LinkFiguresView({ app } as never, plugin as never);
    Object.assign(v as unknown as Record<string, unknown>, {
      stageEl: {
        clientWidth: 0,
        clientHeight: 0,
        createDiv: () => ({ createDiv: () => ({}), createEl: () => ({}), remove: () => {} }),
        classList: { toggle: vi.fn() },
        style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      },
      viewportEl: { show: () => {}, hide: () => {}, style: { transform: "", setProperty: vi.fn() } },
      nodeHost: { reset: vi.fn(), renderAll: vi.fn(), resolveStale: vi.fn(async () => {}), applyChange: vi.fn() },
      pageLayer: { render: vi.fn() },
      pointer: { commitTime: () => 0, select: vi.fn(), rebind: vi.fn(), attach: vi.fn(), detach: vi.fn(), finishCrop: vi.fn() },
      intake: { attach: vi.fn() },
      selection: { clear: vi.fn(), onChange: vi.fn(), ids: [] as string[] },
      toolbar: { render: vi.fn() },
      inspector: { render: vi.fn() },
    });
    return v;
  };
  /** What `leaf.openFile(file)` does: the view gets the file, then loads it. */
  const openFile = () => {
    view = makeView();
    view.file = file as never;
    return view.onLoadFile(file as never);
  };
  /** What Obsidian's FileView.loadFile does when the leaf switches the open view to `next`: unload, set the file, load. */
  const switchTo = async (next: FakeFile) => {
    const v = view!;
    await v.onUnloadFile(v.file!);
    v.file = next as never;
    await v.onLoadFile(next as never);
  };

  const files = figureWrites.wrap({
    read: (p) => vault.read(fileAt(p)),
    process: async (p, edit) => void (await vault.process(fileAt(p), edit)),
  });
  const viewOf = (p: string) => (view && view.file?.path === p ? view : null);
  const api = createApi({
    app: app as never,
    registries,
    files,
    normalizePath: (p) => p,
    openFigure: (p) => {
      const v = viewOf(p);
      return v && v.hasDocument() ? v : null;
    },
    loadingFigure: (p) => {
      const v = viewOf(p);
      return v && v.isLoading() ? v.whenLoaded() : null;
    },
  });
  const shape = (id: string, x: number, text = initialText) => ({ kind: "rect", page: loadDocument(text).doc.pages[0].id, x, y: 10, width: 20, height: 20, id });
  /** Someone else (a sync, another plugin) writes the file at `path`. */
  const externalWrite = (text: string, path = PATH) => {
    texts.set(path, text);
    writes.push({ by: "external", path, text });
    modified(fileAt(path));
  };
  /** Opens the figure in a view and waits for it to load. */
  const opened = async () => {
    const opening = openFile();
    await vi.advanceTimersByTimeAsync(10);
    await opening;
    return view!;
  };
  /**
   * `fileManager.renameFile(note, to)` as Obsidian 1.15 does it for the figure file (read from its app.js:
   * `runAsyncLinkUpdate`, `updateAllLinks`, `updateInternalLinks`, `ux`): one job of the update queue that collects each
   * link to the note in the figure's text as it is now, with its offsets; renames (the vault's `rename` event, which
   * the view takes as it does from `vault.on("rename")`); waits for `prompt` (the "Update links" dialog); then splices
   * the new links in at the offsets it collected, into the text the file has then, checking nothing.
   */
  const renameNote = (from: string, to: string, prompt: Promise<void | "do not update">): Promise<unknown> => {
    const job = async () => {
      const name = from.replace(/\.md$/, "");
      const refs = [...disk.text.matchAll(/\[\[([^\]|#]*)([^\]]*)\]\]/g)]
        .filter((m) => m[1] === name)
        .map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: `[[${to.replace(/\.md$/, "")}${m[2]}]]` }));
      fileManager.inProgressUpdates = [];
      const note = Object.assign(new TFile(), { path: to, name: to.split("/").pop() });
      (view as unknown as { onVaultRename(f: unknown, old: string): void } | null)?.onVaultRename(note, from);
      fileManager.inProgressUpdates = null;
      if ((await prompt) === "do not update" || refs.length === 0) return;
      await vault.process(file, (text) => {
        let out = text;
        for (const r of [...refs].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.text + out.slice(r.end);
        return out;
      });
    };
    return options.linkQueue === false ? job() : updateQueue.queue(job);
  };
  return { api, files, figureWrites, registries, disk, texts, fileAt, writes, vault, hooks, openFile, switchTo, opened, externalWrite, shape, renameNote, get view() { return view!; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, setTimeout, clearTimeout });
  notices.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a figure opened while API calls write it", () => {
  test("a call that went to the file while the view was opening is not merged as text into the view's own edit", async () => {
    const t = setup();
    // The script: createFigure (done), openFile not awaited, then two awaited shape.create calls.
    const a1 = t.api.run(PATH, "shape.create", t.shape("a1", 10));
    await vi.advanceTimersByTimeAsync(0); // a1 has gone to the file: no view yet
    void t.openFile();
    // The script awaits a1 and makes the next call at once.
    const a2 = a1.then(() => t.api.run(PATH, "shape.create", t.shape("a2", 40)));
    await vi.advanceTimersByTimeAsync(400);
    await a2;
    await vi.advanceTimersByTimeAsync(5000); // the view's save

    for (const w of t.writes) expect(parses(w.text), `a write by ${w.by} must parse`).toBe(true);
    expect(parses(t.disk.text)).toBe(true);
    expect(ids(t.disk.text)).toEqual(["a1", "a2"]);
    expect(t.view.readOnly).toBe(false);
    expect(t.view.store.doc.nodes.map((n) => n.id).sort()).toEqual(["a1", "a2"]);
  });

  test("with openFile awaited, both calls run in the view and the save writes both", async () => {
    const t = setup();
    const opening = t.openFile();
    await vi.advanceTimersByTimeAsync(10);
    await opening;
    const a1 = t.api.run(PATH, "shape.create", t.shape("a1", 10));
    const a2 = t.api.run(PATH, "shape.create", t.shape("a2", 40));
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([a1, a2]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ids(t.disk.text)).toEqual(["a1", "a2"]);
    expect(t.view.store.doc.nodes.map((n) => n.id).sort()).toEqual(["a1", "a2"]);
  });

  test("a figure only opened and closed again is not rewritten", async () => {
    // Hand-formatted: what the serializer would write differs from it.
    const hand = newFigureText("a4-portrait", 1).replace('"version"', '"version"   ');
    const t = setup(hand);
    const opening = t.openFile();
    await vi.advanceTimersByTimeAsync(10);
    await opening;
    t.view.requestSave();
    await vi.advanceTimersByTimeAsync(5000);
    await t.view.onUnloadFile(t.view.file!);
    expect(t.writes).toEqual([]);
    expect(t.disk.text).toBe(hand);
  });
});

describe("the plugin never writes a figure it cannot read back", () => {
  test("a change made to the file elsewhere while the view has an unsaved edit is never merged with it as text", async () => {
    const t = setup();
    const view = await t.opened();
    await t.api.run(PATH, "shape.create", t.shape("mine", 10));
    expect(view.dirty).toBe(true);
    // Another writer adds a shape of its own to the file as it was.
    const theirs = loadDocument(t.disk.text).doc;
    theirs.nodes.push({ ...view.store.doc.nodes[0], id: "theirs" });
    t.externalWrite(serializeFigureFile(theirs, loadDocument(t.disk.text).parsed));
    await vi.advanceTimersByTimeAsync(5000);
    for (const w of t.writes) expect(parses(w.text), `a write by ${w.by} must parse`).toBe(true);
    expect(view.readOnly).toBe(false);
    expect(parses(t.disk.text)).toBe(true);
  });

  test("a save whose text does not parse writes nothing, keeps the file and says so", async () => {
    const t = setup();
    const view = await t.opened();
    const before = t.disk.text;
    await t.api.run(PATH, "shape.create", t.shape("a1", 10));
    vi.spyOn(view, "getViewData").mockReturnValue(before.replace('"nodes": []', '"nodes": [ { } { } ]'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.writes).toEqual([]);
    expect(t.disk.text).toBe(before);
    expect(notices.some((n) => n.includes("not saved"))).toBe(true);
  });

  test("a view that could not read its file never writes it", async () => {
    const bad = newFigureText("a4-portrait", 1).replace('"nodes": []', '"nodes": [ { } { } ]');
    const t = setup(bad);
    const view = await t.opened();
    expect(view.readOnly).toBe(true);
    // Obsidian's idea of what is on disk differs from what the view holds (as after a merge it did): still nothing is written.
    (view as unknown as { lastSavedData: string }).lastSavedData = "something else";
    view.requestSave();
    await vi.advanceTimersByTimeAsync(5000);
    await view.onUnloadFile(view.file!);
    expect(t.writes).toEqual([]);
    expect(t.disk.text).toBe(bad);
  });

  test("a headless call whose result would not parse writes nothing and is refused", async () => {
    const t = setup();
    t.registries.commands.register({
      id: "test.break",
      name: "Break",
      group: "edit",
      applies: () => true,
      run: (ctx) => ctx.store.commit("break", (draft) => void (draft.pages[0].width = Number.NaN)),
    });
    const before = t.disk.text;
    const call = t.api.run(PATH, "test.break");
    const settled = call.then(() => "resolved", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(200);
    expect(await settled).toMatch(/could not be read back/);
    expect(t.writes).toEqual([]);
    expect(t.disk.text).toBe(before);
  });
});

describe("unsaved edits replaced by the file's version", () => {
  const DROPPED = `Link Figures: "${PATH}" was changed outside this view; your unsaved edits were replaced by the file's version.`;
  /** The figure's text with one more shape, `id`, copied from the view's first node. */
  const withShape = (t: ReturnType<typeof setup>, id: string) => {
    const { doc, parsed } = loadDocument(t.disk.text);
    doc.nodes.push(shapeNodeDefaults(doc.pages[0], { id, kind: "rect", x: 0, y: 0, width: 10, height: 10 }, doc.nodes.map((n) => n.id)));
    return serializeFigureFile(doc, parsed);
  };

  test("a change from outside the plugin that replaces unsaved edits says so, in a Notice and the console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    await t.opened();
    await t.api.run(PATH, "shape.create", t.shape("mine", 10));
    t.externalWrite(withShape(t, "theirs"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual(["theirs"]);
    expect(notices).toContain(DROPPED);
    expect(warn).toHaveBeenCalledWith(DROPPED);
    warn.mockRestore();
  });

  test("a change from outside with no unsaved edits in the view says nothing", async () => {
    const t = setup();
    await t.opened();
    await t.api.run(PATH, "shape.create", t.shape("mine", 10));
    await vi.advanceTimersByTimeAsync(5000); // saved
    t.externalWrite(withShape(t, "theirs"));
    await vi.advanceTimersByTimeAsync(100);
    expect(notices).not.toContain(DROPPED);
  });

  test("a write by the plugin itself that replaces unsaved edits says so too (it should not happen: calls go to the view)", async () => {
    const t = setup();
    await t.opened();
    await t.api.run(PATH, "shape.create", t.shape("mine", 10));
    const next = withShape(t, "plugin");
    const write = t.files.process(PATH, () => next);
    await vi.advanceTimersByTimeAsync(5000);
    await write;
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual(["plugin"]);
    expect(notices).toContain(DROPPED);
  });

  test("a write by the plugin itself on a view with nothing unsaved says nothing", async () => {
    const t = setup();
    await t.opened();
    const write = t.files.process(PATH, () => withShape(t, "plugin"));
    await vi.advanceTimersByTimeAsync(500);
    await write;
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual(["plugin"]);
    expect(notices).not.toContain(DROPPED);
  });

  test("a text the plugin wrote before, arriving again later over unsaved edits (a sync, a revert), says so", async () => {
    const t = setup();
    await t.opened();
    const pluginText = withShape(t, "plugin");
    const write = t.files.process(PATH, () => pluginText);
    await vi.advanceTimersByTimeAsync(500);
    await write;
    expect(notices).not.toContain(DROPPED);
    await t.api.run(PATH, "shape.create", t.shape("mine", 40));
    await vi.advanceTimersByTimeAsync(5000); // saved
    await t.api.run(PATH, "shape.create", t.shape("mine2", 70));
    t.externalWrite(pluginText); // the same text as the plugin's write, back again
    await vi.advanceTimersByTimeAsync(100);
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual(["plugin"]);
    expect(notices).toContain(DROPPED);
  });

  test("the plugin keeps nothing per file once its writes have landed", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      const path = `Notes/M2i Many ${i}.lnkfig.md`;
      t.fileAt(path);
      const w = t.files.process(path, (text) => text.replace('"nodes": []', '"nodes": [ ]'));
      await vi.advanceTimersByTimeAsync(200);
      await w;
    }
    expect(t.figureWrites.size()).toBe(0);
  });

  test("a sync that lands while the view's own save is being written is taken up, and the user told", async () => {
    const t = setup();
    await t.opened();
    await t.api.run(PATH, "shape.create", t.shape("mine", 10));
    let theirs = "";
    t.hooks.duringModify = () => {
      const { doc, parsed } = loadDocument(newFigureText("a4-portrait", 1));
      doc.nodes.push(shapeNodeDefaults(doc.pages[0], { id: "theirs", kind: "rect", x: 0, y: 0, width: 10, height: 10 }, []));
      theirs = serializeFigureFile(doc, parsed);
      t.externalWrite(theirs);
    };
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.disk.text).toBe(theirs);
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual(["theirs"]);
    expect(notices).toContain(DROPPED);
  });
});

describe("loading, switching and saving", () => {
  const B = "Notes/M2i Other.lnkfig.md";

  test("a leaf switched to another figure while it waits for a write of the first shows and saves only the second", async () => {
    const t = setup();
    const { doc, parsed } = loadDocument(newFigureText("a4-portrait", 1));
    const bText0 = serializeFigureFile(doc, parsed);
    const bFile = t.fileAt(B, bText0);
    const a1 = t.api.run(PATH, "shape.create", t.shape("a1", 10));
    await vi.advanceTimersByTimeAsync(0); // a1 is being written to A
    const opening = t.openFile(); // waits for a1's write
    await vi.advanceTimersByTimeAsync(1);
    const switching = t.switchTo(bFile);
    await vi.advanceTimersByTimeAsync(10);
    await switching;
    expect(t.view.isLoading()).toBe(false); // A's wait does not hold B up
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([a1, opening]);
    expect(t.view.file!.path).toBe(B);
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual([]);
    await t.api.run(B, "shape.create", t.shape("b1", 10, bText0));
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual(["b1"]);
    expect(t.writes.filter((w) => w.by === "view").map((w) => w.path)).toEqual([B]);
    expect(ids(t.texts.get(B)!)).toEqual(["b1"]);
    expect(ids(t.disk.text)).toEqual(["a1"]);
  });

  test("a view waits at most 5 s for a write of its file that never finishes", async () => {
    const t = setup();
    t.hooks.stuck = true;
    void t.api.run(PATH, "shape.create", t.shape("a1", 10)).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const opening = t.openFile();
    await vi.advanceTimersByTimeAsync(4900);
    expect(t.view.hasDocument()).toBe(false);
    expect(t.view.isLoading()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    await opening;
    expect(t.view.hasDocument()).toBe(true);
    expect(t.view.isLoading()).toBe(false);
  });

  test("a save serialises the figure once", async () => {
    const t = setup();
    const view = await t.opened();
    await t.api.run(PATH, "shape.create", t.shape("a1", 10));
    const serialize = vi.mocked(serializeFigureFile);
    serialize.mockClear();
    const saving = view.save();
    await vi.advanceTimersByTimeAsync(50);
    await saving;
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(ids(t.disk.text)).toEqual(["a1"]);
  });
});

describe("a rename's link update in Obsidian, and the view's own save", () => {
  const LEGEND = "Notes/Cards legend";
  /** A figure with two note cards on the legend, `c-0` (its Links entry first) and `c-1`. */
  const twoNoteCards = (): string => {
    const doc = createDocument("a4-portrait");
    const page = doc.pages[0];
    const card = (id: string, y: number) => ({ ...cardNodeDefaults(page, -300, y), id, text: undefined, file: LEGEND, subpath: "#Fig 2" });
    doc.nodes.push(card("c-0", 0) as never, card("c-1", 200) as never);
    return serializeFigureFile(doc, emptyParsed());
  };
  const linkOf = (text: string, id: string) => (loadDocument(text).doc.nodes.find((n) => n.id === id) as { file?: string } | undefined)?.file;

  test("a card deleted 300 ms before a rename whose prompt stays open: the save waits for the link update, the file stays a figure", async () => {
    const t = setup(twoNoteCards());
    await t.opened();
    expect(linkOf(t.disk.text, "c-1")).toBe(LEGEND);
    await t.api.run(PATH, "delete", { ids: ["c-0"] });
    await vi.advanceTimersByTimeAsync(300);
    let answer!: () => void;
    const renaming = t.renameNote(`${LEGEND}.md`, "Notes/Cards legend 2.md", new Promise<void>((r) => (answer = r)));
    // The view's save comes due while the prompt is open.
    await vi.advanceTimersByTimeAsync(3000);
    answer();
    await vi.advanceTimersByTimeAsync(1000);
    await renaming;
    await vi.advanceTimersByTimeAsync(3000);

    for (const w of t.writes) expect(parses(w.text), `a write by ${w.by} must parse:\n${w.text}`).toBe(true);
    expect(ids(t.disk.text)).toEqual(["c-1"]);
    expect(linkOf(t.disk.text, "c-1")).toBe("Notes/Cards legend 2");
    // The deleted card is not brought back by the link update.
    expect(notices).toEqual([]);
  });

  test("without Obsidian's queue to wait on, a link update spliced at stale offsets is repaired, not left in the file", async () => {
    const t = setup(twoNoteCards(), { linkQueue: false });
    await t.opened();
    await t.api.run(PATH, "delete", { ids: ["c-0"] });
    await vi.advanceTimersByTimeAsync(300);
    let answer!: () => void;
    const renaming = t.renameNote(`${LEGEND}.md`, "Notes/Cards legend 2.md", new Promise<void>((r) => (answer = r)));
    await vi.advanceTimersByTimeAsync(3000);
    answer();
    await vi.advanceTimersByTimeAsync(1000);
    await renaming;
    await vi.advanceTimersByTimeAsync(3000);

    // The splice did damage the file (the model is right), and the view wrote its figure back over it, after backing
    // the damaged text up beside the figure.
    const damaged = t.writes.findIndex((w) => !parses(w.text));
    expect(damaged).toBeGreaterThanOrEqual(0);
    const backup = t.writes.findIndex((w) => w.by === "create");
    const repaired = t.writes.findIndex((w, i) => i > damaged && w.by === "view" && w.path === PATH);
    expect(backup).toBeGreaterThan(damaged);
    expect(repaired).toBeGreaterThan(backup);
    expect(t.writes[backup].path).toMatch(/^Notes\/M2i OpenN \(damaged \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\)\.md$/);
    expect(t.writes[backup].text).toBe(t.writes[damaged].text);
    expect(parses(t.disk.text)).toBe(true);
    expect(ids(t.disk.text)).toEqual(["c-1"]);
    expect(linkOf(t.disk.text, "c-1")).toBe("Notes/Cards legend 2");
    expect(t.view.hasDocument()).toBe(true);
    expect(notices.some((n) => n.includes("repaired") && n.includes(t.writes[backup].path))).toBe(true);
  });

  test("a damaged file that cannot be backed up is never overwritten: it is shown as it is", async () => {
    const t = setup(twoNoteCards(), { linkQueue: false });
    await t.opened();
    t.hooks.createFails = true;
    await t.api.run(PATH, "delete", { ids: ["c-0"] });
    await vi.advanceTimersByTimeAsync(300);
    let answer!: () => void;
    const renaming = t.renameNote(`${LEGEND}.md`, "Notes/Cards legend 2.md", new Promise<void>((r) => (answer = r)));
    await vi.advanceTimersByTimeAsync(3000);
    answer();
    await vi.advanceTimersByTimeAsync(1000);
    await renaming;
    await vi.advanceTimersByTimeAsync(3000);
    const damaged = t.writes.findIndex((w) => !parses(w.text));
    expect(damaged).toBeGreaterThanOrEqual(0);
    expect(t.writes.slice(damaged + 1)).toEqual([]);
    expect(parses(t.disk.text)).toBe(false);
    expect(t.view.hasDocument()).toBe(false);
    expect(notices.some((n) => n.includes("could not be backed up"))).toBe(true);
  });

  test('"Do not update" closes the window: a damaged file that comes later is left alone', async () => {
    const t = setup(twoNoteCards());
    await t.opened();
    const renaming = t.renameNote(`${LEGEND}.md`, "Notes/Cards legend 2.md", Promise.resolve("do not update" as const));
    await vi.advanceTimersByTimeAsync(500);
    await renaming;
    await vi.advanceTimersByTimeAsync(500);
    const broken = t.disk.text.replace("\"pages\"", "\"pages\",,");
    expect(parses(broken)).toBe(false);
    t.externalWrite(broken);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.disk.text).toBe(broken);
    expect(t.writes.filter((w) => w.by !== "external")).toEqual([]);
    expect(t.view.hasDocument()).toBe(false);
  });

  test("a card made and not saved yet when its note is renamed (Obsidian's cache knows no link to it) takes the new name", async () => {
    for (const prompt of [Promise.resolve(), new Promise<void>((r) => setTimeout(r, 800))]) {
      const t = setup(twoNoteCards());
      await t.opened();
      const page = loadDocument(t.disk.text).doc.pages[0].id;
      await t.api.run(PATH, "card.create", { page, x: -300, y: 400, file: "Notes/Cards legend", subpath: "#Fig 1", id: "c-new" });
      // Renamed before the view's save: the file has no link of c-new for Obsidian to rewrite.
      const renaming = t.renameNote(`${LEGEND}.md`, "Notes/Cards legend 2.md", prompt);
      await vi.advanceTimersByTimeAsync(1000);
      await renaming;
      await vi.advanceTimersByTimeAsync(5000);
      expect(linkOf(t.disk.text, "c-new")).toBe("Notes/Cards legend 2");
      expect(linkOf(t.disk.text, "c-1")).toBe("Notes/Cards legend 2");
      expect((t.view.store.doc.nodes.find((n) => n.id === "c-new") as { file?: string }).file).toBe("Notes/Cards legend 2");
    }
  });

  test("a relink the user made before the link update landed is kept, not taken from the file", async () => {
    const t = setup(twoNoteCards());
    await t.opened();
    // c-0 relinked by the user (unsaved), then the note renamed: the file's c-0 gets the renamed old link.
    await t.api.run(PATH, "node.update", { id: "c-0", patch: { file: "Notes/Other" } });
    const renaming = t.renameNote(`${LEGEND}.md`, "Notes/Cards legend 2.md", Promise.resolve());
    await vi.advanceTimersByTimeAsync(500);
    await renaming;
    await vi.advanceTimersByTimeAsync(3000);
    expect(linkOf(t.disk.text, "c-0")).toBe("Notes/Other");
    expect(linkOf(t.disk.text, "c-1")).toBe("Notes/Cards legend 2");
  });

  test("a link update that lands while the view has an unsaved edit keeps the edit and takes the new links", async () => {
    const t = setup(twoNoteCards());
    await t.opened();
    await t.api.run(PATH, "delete", { ids: ["c-0"] });
    // Renamed at once, the prompt answered at once: the update lands before the view's save.
    const renaming = t.renameNote(`${LEGEND}.md`, "Notes/Cards legend 2.md", Promise.resolve());
    await vi.advanceTimersByTimeAsync(500);
    await renaming;
    expect(linkOf(t.disk.text, "c-0")).toBe("Notes/Cards legend 2");
    await vi.advanceTimersByTimeAsync(3000);
    expect(ids(t.disk.text)).toEqual(["c-1"]);
    expect(linkOf(t.disk.text, "c-1")).toBe("Notes/Cards legend 2");
    expect(notices).toEqual([]);
  });
});
