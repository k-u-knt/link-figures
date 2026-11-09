import { createApi } from "../../src/api";
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { FigureWrites } from "../../src/commands/figure-writes";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { loadDocument } from "../../src/format/load";
import { serializeFigureFile } from "../../src/format/serialize";
import { newFigureText } from "../../src/format/new-figure";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { createRegistries } from "../../src/registry";
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
function setup(initialText = newFigureText("a4-portrait", 1)) {
  const registries = createRegistries();
  registerBuiltinCommands({ registries, addCommand: () => undefined, activeFigureView: () => null } as never);
  registries.nodeTypes.register(shapeNodeType);
  registries.nodeTypes.register(connectorNodeType);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  for (const route of builtinRoutes) registries.routes.register(route);
  for (const cap of builtinCapKinds) registries.caps.register(cap);
  for (const command of drawingCommands()) registries.commands.register(command);

  const file = { path: PATH, name: "M2i OpenN.lnkfig.md", saving: false };
  const disk = { text: initialText };
  /** Every text written to the file, by whom. */
  const writes: { by: string; text: string }[] = [];
  const handlers: ((f: unknown) => void)[] = [];
  const modified = () => handlers.forEach((h) => h(file));
  const vault = {
    on: (name: string, cb: (f: unknown) => void) => {
      if (name === "modify") handlers.push(cb);
      return {};
    },
    offref: () => {},
    read: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return disk.text;
    }),
    cachedRead: vi.fn(async () => disk.text),
    modify: vi.fn(async (_f: unknown, text: string) => {
      disk.text = text;
      writes.push({ by: "view", text });
      modified();
    }),
    /** Reads, then (some time later) writes what `edit` gives, as one step of its own; the modify event comes with the write. */
    process: vi.fn(async (_f: unknown, edit: (t: string) => string) => {
      const before = disk.text;
      await new Promise((r) => setTimeout(r, 150));
      const after = edit(before);
      if (after !== before) {
        disk.text = after;
        writes.push({ by: "process", text: after });
        modified();
      }
      return after;
    }),
  };
  const metadataCache = { on: () => ({}), fileToLinktext: () => "" };
  const app = { vault, metadataCache, workspace: {} };
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

  const files = figureWrites.wrap({
    read: () => vault.read(),
    process: async (_p, edit) => void (await vault.process(file, edit)),
  });
  const api = createApi({
    app: app as never,
    registries,
    files,
    normalizePath: (p) => p,
    openFigure: () => (view && view.hasDocument() ? view : null),
    loadingFigure: () => (view && view.isLoading() ? view.whenLoaded() : null),
  });
  const shape = (id: string, x: number) => ({ kind: "rect", page: loadDocument(initialText).doc.pages[0].id, x, y: 10, width: 20, height: 20, id });
  /** Someone else (a sync, another plugin) writes the file. */
  const externalWrite = (text: string) => {
    disk.text = text;
    writes.push({ by: "external", text });
    modified();
  };
  /** Opens the figure in a view and waits for it to load. */
  const opened = async () => {
    const opening = openFile();
    await vi.advanceTimersByTimeAsync(10);
    await opening;
    return view!;
  };
  return { api, files, registries, disk, writes, vault, openFile, opened, externalWrite, shape, get view() { return view!; } };
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
    doc.nodes.push({ ...t.view.store.doc.nodes[0], id });
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

  test("a write by the plugin itself (FigureWrites) that replaces unsaved edits says nothing", async () => {
    const t = setup();
    await t.opened();
    await t.api.run(PATH, "shape.create", t.shape("mine", 10));
    const next = withShape(t, "plugin");
    const write = t.files.process(PATH, () => next);
    await vi.advanceTimersByTimeAsync(5000);
    await write;
    expect(t.view.store.doc.nodes.map((n) => n.id)).toEqual(["plugin"]);
    expect(notices).not.toContain(DROPPED);
  });
});
