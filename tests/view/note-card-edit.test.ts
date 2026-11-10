// @vitest-environment happy-dom
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { cardCommands } from "../../src/commands/cards";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { EDITING_CLASS } from "../../src/constants";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { InvalidationIndex } from "../../src/links/invalidation";
import type { Resolved } from "../../src/links/types";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import { nodeWorldRect } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import type { CardNode, Document, Node } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import type { CommandContext, UndoStep } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { FakeAccess } from "../links/fake-access";
import { fakeEmbedRegistry, type FakeEmbed } from "../support/fake-embed";

const render = vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
  if (el) el.textContent = markdown;
});
vi.mock("obsidian", () => ({
  Menu: class {},
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

const { PointerController } = await import("../../src/view/pointer");
const { SelectionState } = await import("../../src/view/selection");
const { Viewport } = await import("../../src/view/viewport");
const { NodeHost } = await import("../../src/view/node-host");

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

beforeEach(() => render.mockClear());
afterEach(() => vi.restoreAllMocks());

function registries(): Registries {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  r.nodeTypes.register(cardNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const kind of builtinShapeKinds) r.shapes.register(kind);
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  for (const paint of builtinPaintTypes) r.paints.register(paint);
  for (const command of [...drawingCommands(), ...cardCommands(), ...groupCommands()]) r.commands.register(command);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  return r;
}

/** One A4 page with shape A on it; note cards N and M (both on Notes/a.md#Legend) and text card C beside it. */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  page.id = "pg-1";
  doc.nodes.push(shapeNodeDefaults(page, { id: "A", kind: "rect", x: 50, y: 50, width: 100, height: 80, z: 0 }, []));
  const note = (id: string, y: number): CardNode => {
    const card: CardNode = { ...cardNodeDefaults(page, -400, y, ["A", "N", "M", "C"]), id, file: "Notes/a.md", subpath: "#Legend" };
    delete card.text;
    return card;
  };
  doc.nodes.push(note("N", 100), note("M", 400));
  doc.nodes.push({ ...cardNodeDefaults(page, -400, 700, ["A", "N", "M"]), id: "C", text: "Text card" });
  return doc;
}

class FakeStage {
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  addEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, ev: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  setPointerCapture = vi.fn();
  hasPointerCapture = () => false;
  releasePointerCapture = () => {};
  focus = () => {};
}

async function setup(options: { registry?: boolean } = {}) {
  const r = registries();
  let controller: { commitTime(): number } | null = null;
  const store = createFigureStore(figure(), r, () => controller?.commitTime() ?? Date.now());
  const pending: Promise<unknown>[] = [];
  const { registry, embeds } = fakeEmbedRegistry();
  // The vault's files, by path: one object per file, which a rename keeps (as Obsidian's TFile).
  const tfiles = new Map<string, { path: string; extension: string; basename: string }>([["Notes/a.md", { path: "Notes/a.md", extension: "md", basename: "a" }]]);
  const vaultFiles: Record<string, string> = { "Notes/a.md": "# A\n## Legend\nBody" };
  const headings: Record<string, Record<string, { start: number; end: number | null }>> = { "Notes/a.md": { Legend: { start: 4, end: null } } };
  const access = new FakeAccess({ files: vaultFiles, headings });
  const app: Record<string, unknown> = { vault: { getFileByPath: (p: string) => tfiles.get(p) ?? null } };
  if (options.registry !== false) app.embedRegistry = registry;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view: any = {
    app,
    file: { path: "fig.lnkfig.md" },
    store,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    resolvedCache: new Map<string, Resolved>(),
    index: new InvalidationIndex(),
    plugin: { registries: { ...r, adjustments: { get: () => undefined } }, access, decoders: {} },
    openLink: vi.fn(),
    samplesLanded: vi.fn(),
    viewOption: () => undefined,
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    pageLayer: { overlayHost: () => { throw new Error("no overlay"); } },
    armedTool: null,
    selectedIds: () => [...view.selection.ids],
    setSelection: (ids: string[]) => view.selection.set(ids),
    addChild: vi.fn(),
    removeChild: vi.fn(),
    disarmTool: () => void (view.armedTool = null),
    commandContext: (): CommandContext => ({ app: {} as never, registries: r, view, store, selection: view.selectedIds(), page: store.doc.pages[0] }),
    runCommandById: (id: string, args?: Record<string, unknown>, step?: UndoStep) => {
      pending.push(runCall(store, view.commandContext(), prepareCall(r, { id, args }), step));
    },
    contextMenuOpen: false,
  };
  const nodeHost = new NodeHost(view, { nodesHost: () => host } as never, r);
  view.nodeHost = nodeHost;
  store.subscribe((ev) => nodeHost.applyChange(store.doc, ev.changedNodeIds, ev.pagesChanged));
  const stage = new FakeStage();
  const pointerController = new PointerController(view);
  controller = pointerController;
  pointerController.attach(stage as never);
  nodeHost.renderAll(store.doc);
  await nodeHost.resolveStale();

  const node = <T extends Node = Node>(id: string) => store.doc.nodes.find((n) => n.id === id) as T;
  const el = (id: string) => nodeHost.elementFor(id)!;
  /** A point inside the card's body, in client (= world) px, and the element there. */
  const inside = (id: string): { at: [number, number]; target: Element } => {
    const box = nodeWorldRect(store.doc, node(id));
    return { at: [box.x + 20, box.y + 20], target: el(id).querySelector(".lf-card-body")!.firstElementChild ?? el(id) };
  };
  const pointer = (type: string, [clientX, clientY]: [number, number], target: unknown = {}) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, clientX, clientY, target, preventDefault: vi.fn() });
  const click = async (id: string) => {
    const { at, target } = inside(id);
    pointer("pointerdown", at, target);
    pointer("pointerup", at, target);
    await Promise.all(pending);
  };
  const key = (name: string, target: unknown) => stage.fire("keydown", { key: name, target, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, preventDefault: vi.fn() });
  const embedOf = (id: string): FakeEmbed => embeds.find((e) => el(id).contains(e.containerEl))!;
  return { r, store, view, nodeHost, embeds, embedOf, tfiles, vaultFiles, headings, node, el, inside, pointer, click, key, settled: () => Promise.all(pending) };
}

describe("a note card's body is Obsidian's editable embed", () => {
  test("a note card mounts one embed of its note; moves and resizes reuse it", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    expect(embed.ctx.linktext).toBe("Notes/a.md#Legend");
    expect(embed.ctx.sourcePath).toBe("fig.lnkfig.md");
    expect(embed.file).toBe(s.tfiles.get("Notes/a.md"));
    expect(embed.subpath).toBe("#Legend");
    expect(embed.editable).toBe(true);
    // One per note card; a text card is still rendered Markdown.
    expect(s.embeds).toHaveLength(2);
    expect(render).toHaveBeenCalledWith(expect.anything(), "Text card", expect.anything(), "fig.lnkfig.md", expect.anything());

    s.view.runCommandById("node.update", { id: "N", patch: { x: -500, width: 300 } });
    await s.settled();
    expect(s.el("N").style.left).toBe("-500px");
    expect(s.embeds).toHaveLength(2);
    expect(embed.unloaded).toBe(false);
    expect(s.el("N").contains(embed.containerEl)).toBe(true);
  });

  test("a press on an unselected card selects it; a click on the selected card edits, at the click", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    expect(s.view.selection.ids).toEqual(["N"]);
    expect(embed.editMode).toBeNull();
    await s.click("N");
    expect(embed.editMode).not.toBeNull();
    const { at } = s.inside("N");
    expect(embed.editorCalls).toEqual([{ x: at[0], y: at[1] }]);
    expect(s.el("N").classList.contains(EDITING_CLASS)).toBe(true);
    // A press outside the card ends the edit, with a save.
    embed.type("Typed");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(embed.editMode).toBeNull();
    expect(embed.writes).toEqual(["Typed"]);
    expect(s.el("N").classList.contains(EDITING_CLASS)).toBe(false);
  });

  test("a drag from the body of a selected card moves it and does not edit", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    const before = nodeWorldRect(s.store.doc, s.node("N"));
    const { at, target } = s.inside("N");
    s.pointer("pointerdown", at, target);
    s.pointer("pointermove", [at[0] - 50, at[1] + 30], target);
    s.pointer("pointerup", [at[0] - 50, at[1] + 30], target);
    await s.settled();
    expect(nodeWorldRect(s.store.doc, s.node("N")).x).toBeCloseTo(before.x - 50, 5);
    expect(embed.editMode).toBeNull();
  });

  test("a locked card, a card in a multi-selection, and a read-only view do not edit on a click", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    s.view.selection.set(["N", "M"]);
    await s.click("N");
    expect(embed.editMode).toBeNull();
    s.view.runCommandById("node.update", { id: "N", patch: { locked: true } });
    await s.settled();
    s.view.selection.set(["N"]);
    await s.click("N");
    expect(embed.editMode).toBeNull();
    // The embed's own request to edit (requestEdit) is refused too.
    embed.requestEdit!();
    expect(embed.editMode).toBeNull();
  });

  test("keys inside the editor do not reach the stage", async () => {
    const s = await setup();
    await s.click("N");
    await s.click("N");
    const editor = s.embedOf("N").editMode!.editorEl;
    s.key("Delete", editor);
    await s.settled();
    expect(s.node("N")).toBeDefined();
    // A press inside the editor is the editor's, not a press on the card.
    const before = nodeWorldRect(s.store.doc, s.node("N"));
    const { at } = s.inside("N");
    s.pointer("pointerdown", at, editor);
    s.pointer("pointermove", [at[0] + 80, at[1]], editor);
    s.pointer("pointerup", [at[0] + 80, at[1]], editor);
    await s.settled();
    expect(nodeWorldRect(s.store.doc, s.node("N"))).toEqual(before);
    // Outside an edit, Delete deletes the selected card as before.
    s.embedOf("N").showPreview(true);
    s.key("Delete", {});
    await s.settled();
    expect(s.node("N")).toBeUndefined();
  });
});

describe("Review Focus", () => {
  test("1: a stage commit while editing (another item moved, undone) leaves the editor alone", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    await s.click("N");
    const editor = embed.editMode!.editorEl;
    s.view.runCommandById("node.update", { id: "A", patch: { x: 80 } });
    await s.settled();
    s.store.undo();
    s.view.runCommandById("node.update", { id: "N", patch: { y: 150 } });
    await s.settled();
    expect(embed.editMode?.editorEl).toBe(editor);
    expect(embed.calls.filter((c) => c.startsWith("showPreview") || c === "unload")).toEqual([]);
    expect(embed.editorCalls).toHaveLength(1);
    expect(s.embeds).toHaveLength(2);
  });

  test("2: the note renamed while editing keeps the editor; deleted, the card says so, with no exception", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    await s.click("N");
    embed.type("Typed");
    // Obsidian renames the file object in place, and rewrites the figure's link to it.
    const file = s.tfiles.get("Notes/a.md")!;
    file.path = "Notes/b.md";
    s.tfiles.delete("Notes/a.md");
    s.tfiles.set("Notes/b.md", file);
    s.vaultFiles["Notes/b.md"] = s.vaultFiles["Notes/a.md"];
    delete s.vaultFiles["Notes/a.md"];
    s.headings["Notes/b.md"] = s.headings["Notes/a.md"];
    s.view.runCommandById("node.update", { id: "N", patch: { file: "Notes/b.md" } });
    await s.settled();
    await s.nodeHost.drawn();
    expect(embed.editMode).not.toBeNull();
    expect(embed.unloaded).toBe(false);
    expect(s.embeds).toHaveLength(2);

    // Deleted: the watcher's invalidation reaches the card (it no longer follows a file), which unloads its embed.
    s.tfiles.delete("Notes/b.md");
    delete s.vaultFiles["Notes/b.md"];
    await expect(s.nodeHost.invalidate(["N"])).resolves.toBeUndefined();
    expect(embed.writes).toEqual(["Typed"]);
    expect(embed.unloaded).toBe(true);
    expect(s.el("N").textContent).toContain("Note not found");
  });

  test("3: flushAll writes what was typed in every open editor", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    await s.click("N");
    embed.type("Just typed");
    expect(embed.writes).toEqual([]);
    await s.nodeHost.flushAll();
    expect(embed.writes).toEqual(["Just typed"]);
    expect(embed.editMode).not.toBeNull();
  });

  test("4: two cards on one note each have their own embed; the watcher leaves both alone while they follow the note", async () => {
    const s = await setup();
    const n = s.embedOf("N");
    const m = s.embedOf("M");
    expect(n).not.toBe(m);
    await s.click("N");
    await s.click("N");
    n.type("Typed in N");
    s.vaultFiles["Notes/a.md"] = "# A\n## Legend\nChanged elsewhere";
    await s.nodeHost.invalidate(["N", "M"]);
    expect(n.editMode).not.toBeNull();
    expect(n.unloaded || m.unloaded).toBe(false);
    expect(s.embeds).toHaveLength(2);
    expect(m.editMode).toBeNull();
  });

  test("5: no registry gives the 0.5.0 read-only rendering, with one warning and no exception", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ registry: false });
    expect(render).toHaveBeenCalledWith(expect.anything(), "## Legend\nBody", expect.anything(), "Notes/a.md", expect.anything());
    expect(warn).toHaveBeenCalledTimes(1);
    await s.click("N");
    await s.click("N");
    expect(s.el("N").classList.contains(EDITING_CLASS)).toBe(false);
    expect(s.view.selection.ids).toEqual(["N"]);
  });
});

describe("ending and unloading", () => {
  test("deleting the card while editing saves, then unloads", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    await s.click("N");
    embed.type("Typed");
    s.view.runCommandById("delete", { ids: ["N"] });
    await s.settled();
    expect(embed.writes).toEqual(["Typed"]);
    expect(embed.calls.slice(-2)).toEqual(["showPreview(true)", "unload"]);
  });

  test("converting the card while editing saves, then unloads, and the text card renders its embed text", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    await s.click("N");
    embed.type("Typed");
    s.view.runCommandById("card.convert", { id: "N" });
    await s.settled();
    expect(embed.writes).toEqual(["Typed"]);
    expect(embed.calls.slice(-2)).toEqual(["showPreview(true)", "unload"]);
    expect(s.node<CardNode>("N").text).toMatch(/^!\[\[.*#Legend\]\]$/);
  });

  test("endEdits (before the pages' sheets move) ends every open edit with a save, and keeps the embeds", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    await s.click("N");
    embed.type("Typed");
    s.nodeHost.endEdits();
    expect(embed.writes).toEqual(["Typed"]);
    expect(embed.editMode).toBeNull();
    expect(embed.unloaded).toBe(false);
    expect(s.el("N").classList.contains(EDITING_CLASS)).toBe(false);
    // Nothing being edited: nothing done.
    s.nodeHost.endEdits();
    expect(embed.calls.filter((c) => c.startsWith("showPreview"))).toHaveLength(1);
  });

  test("closing the figure flushes, then unloads every embed", async () => {
    const s = await setup();
    const embed = s.embedOf("N");
    await s.click("N");
    await s.click("N");
    embed.type("Typed");
    await s.nodeHost.flushAll();
    s.nodeHost.unmountAll();
    expect(embed.writes).toEqual(["Typed"]);
    expect(s.embeds.every((e) => e.unloaded)).toBe(true);
  });
});
