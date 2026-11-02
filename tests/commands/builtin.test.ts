import { registerBuiltinCommands, restack, type EditorView } from "../../src/commands/builtin";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { MIN_NODE_PX } from "../../src/constants";
import { createDocument, createPage, fileNodeDefaults, shapeNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import { DocumentStore } from "../../src/model/store";
import type { ConnectorNode, Document, End, Node, NodeId, Page } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { createRegistries, type Registries } from "../../src/registry";
import { CommandError, type Command, type CommandContext } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { pageInFocus } from "../../src/view/viewport";

/** A view that records what the commands ask of it. */
class FakeView implements EditorView {
  file = { path: "fig.lnkfig.md" };
  selection: NodeId[] = [];
  readOnly = false;
  calls: string[] = [];
  /** The natural size of the image each node shows; a node without an entry shows no image. */
  sizes: Record<NodeId, { width: number; height: number }> = {};
  constructor(public store: DocumentStore, public pageIndex = 0) {}
  selectedIds(): NodeId[] { return [...this.selection]; }
  /** The page the stage is centred on (`pageIndex`). */
  currentPage() { return this.store.doc.pages[this.pageIndex]; }
  /** What the real view's `focusPage` does. */
  focusPage() { return pageInFocus(this.store.doc, this.selection, this.currentPage())!; }
  setSelection(ids: NodeId[]): void { this.selection = ids; }
  fitPage(): void { this.calls.push("fit"); }
  zoomTo(z: number): void { this.calls.push(`zoom:${z}`); }
  requestExport(): void { this.calls.push("export"); }
  openLink(linktext: string): void { this.calls.push(`open:${linktext}`); }
  imageSize = (id: NodeId) => (this.sizes[id] ? Promise.resolve(this.sizes[id]) : Promise.reject(new Error("no image")));
  armedTool: Command | null = null;
  /** What the real view does: arming the armed tool again disarms it. */
  armTool(command: Command): void { this.armedTool = this.armedTool?.id === command.id ? null : command; }
  disarmTool(): void { this.armedTool = null; }
  activateNode(id: NodeId): void { this.calls.push(`activate:${id}`); }
  /** The Maximum page size setting. */
  limitMm = 2000;
  pageLimitMm(): number { return this.limitMm; }
  notePageLimit(limitMm: number): void { this.calls.push(`page-limit:${limitMm}`); }
  registries: Registries = createRegistries();
  commandContext(): CommandContext { return { app: {} as never, registries: this.registries, view: this, store: this.store, selection: this.selectedIds(), page: this.focusPage() }; }
  runCommand(command: Command): void { command.run(this.commandContext()); }
}

/** Registries with the shape and connector node types, shape kinds, routes and caps, which connectors are resolved through. */
function builtinRegistries(): Registries {
  const registries = createRegistries();
  registries.nodeTypes.register(shapeNodeType);
  registries.nodeTypes.register(connectorNodeType);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  for (const route of builtinRoutes) registries.routes.register(route);
  for (const cap of builtinCapKinds) registries.caps.register(cap);
  return registries;
}

function setup(build: (doc: Document) => void = () => {}) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const registries = builtinRegistries();
  // The store a figure view has, with its normalisers.
  const view = new FakeView(createFigureStore(doc, registries));
  view.registries = registries;
  const plugin = { registries, commands: [] as any[], addCommand(c: any) { this.commands.push(c); return c; }, activeFigureView: () => view as FakeView | null };
  registerBuiltinCommands(plugin as never);
  const command = (id: string): Command => plugin.registries.commands.get(id)!;
  const ctx = () => view.commandContext();
  /** What the API gives a command when the figure is not open. */
  const headless = (): CommandContext => ({ app: {} as never, registries, view: null, store: view.store, selection: [], page: undefined });
  return { view, plugin, command, ctx, headless, store: view.store };
}

const fileNode = (doc: Document, partial: Partial<Node> = {}): Node => {
  const node = { ...fileNodeDefaults(doc.pages[0], { file: "plot.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), ...partial } as Node;
  doc.nodes.push(node);
  return node;
};

test("the built-in commands, in toolbar order, with the icons and groups of the brief", () => {
  const { plugin } = setup();
  expect(plugin.registries.commands.all().map((c) => `${c.group}/${c.id}/${c.icon}`)).toEqual([
    "edit/undo/undo",
    "edit/redo/redo",
    "edit/delete/trash",
    "edit/duplicate/copy",
    "edit/open-source/link",
    "insert/insert-text/type",
    "arrange/bring-forward/arrow-up",
    "arrange/send-backward/arrow-down",
    "arrange/reset-aspect/ratio",
    "page/add-page/file-plus",
    "page/delete-page/file-minus",
    "view/fit-page/maximize",
    "view/zoom-100/search",
    "export/export/download",
  ]);
});

test("every command is in the palette as lf-<id> with its own name, and none has a hotkey", () => {
  const { plugin } = setup();
  expect(plugin.commands.map((c) => c.id).sort()).toEqual(plugin.registries.commands.all().map((c) => `lf-${c.id}`).sort());
  const fit = plugin.commands.find((c) => c.id === "lf-fit-page");
  expect(fit.name).toBe("Fit page");
  for (const c of plugin.commands) expect(c.hotkeys).toBeUndefined();
  for (const c of plugin.registries.commands.all()) expect(c.hotkeys).toBeUndefined();
});

test("a palette command acts on the active figure view, and only when it applies", () => {
  const { plugin, view } = setup((d) => { fileNode(d, { id: "p-xxxx" }); });
  const fit = plugin.commands.find((c) => c.id === "lf-fit-page");
  const del = plugin.commands.find((c) => c.id === "lf-delete");
  // Checking is not acting.
  expect(fit.checkCallback(true)).toBe(true);
  expect(view.calls).toEqual([]);
  expect(fit.checkCallback(false)).toBe(true);
  expect(view.calls).toEqual(["fit"]);
  // Nothing selected: Delete is hidden from the palette.
  expect(del.checkCallback(true)).toBe(false);
  view.selection = ["p-xxxx"];
  expect(del.checkCallback(true)).toBe(true);
});

test("palette commands are hidden when no figure view is active, and when the view is read-only", () => {
  const { plugin, view } = setup();
  const fit = plugin.commands.find((c) => c.id === "lf-fit-page");
  view.readOnly = true;
  expect(fit.checkCallback(true)).toBe(false);
  expect(fit.checkCallback(false)).toBe(false);
  view.readOnly = false;
  plugin.activeFigureView = () => null;
  expect(fit.checkCallback(true)).toBe(false);
});

test("undo and redo apply with history, and act on the store", () => {
  const { command, ctx, store } = setup();
  expect(command("undo").applies(ctx())).toBe(false);
  expect(command("redo").applies(ctx())).toBe(false);
  store.commit("rename", (d) => { d.pages[0].name = "Renamed"; });
  expect(command("undo").applies(ctx())).toBe(true);
  command("undo").run(ctx());
  expect(store.doc.pages[0].name).toBe("Page 1");
  expect(command("redo").applies(ctx())).toBe(true);
  command("redo").run(ctx());
  expect(store.doc.pages[0].name).toBe("Renamed");
});

test("selection commands apply only with a selection; an empty figure runs every command without throwing", () => {
  const { command, ctx, view } = setup();
  for (const id of ["delete", "duplicate", "bring-forward", "send-backward", "open-source"]) expect(command(id).applies(ctx())).toBe(false);
  for (const id of ["duplicate", "bring-forward", "send-backward", "open-source"]) expect(() => command(id).run(ctx())).not.toThrow();
  expect(command("reset-aspect").applies(ctx())).toBe(false);
  expect(view.store.doc.nodes).toEqual([]);
});

test("delete applies only when the selection holds an unlocked node", () => {
  const { command, ctx, view } = setup((d) => { fileNode(d, { id: "p-locked", locked: true }); fileNode(d, { id: "p-free" }); });
  view.selection = ["p-locked"];
  expect(command("delete").applies(ctx())).toBe(false);
  view.selection = ["p-locked", "p-free"];
  expect(command("delete").applies(ctx())).toBe(true);
});

test("delete removes the selected nodes that are not locked, as one undo step, and returns their ids", () => {
  const { command, ctx, view, store } = setup((d) => { fileNode(d, { id: "p-free" }); fileNode(d, { id: "p-locked", locked: true }); fileNode(d, { id: "p-other" }); });
  view.selection = ["p-free", "p-locked"];
  expect(command("delete").run(ctx())).toEqual({ ids: ["p-free"] });
  expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-locked", "p-other"]);
  store.undo();
  expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-free", "p-locked", "p-other"]);
});

describe("commands that act on nodes take ids", () => {
  test("delete {ids} works without a view, and leaves the selection alone in one", () => {
    const { command, headless, ctx, view, store } = setup((d) => { fileNode(d, { id: "p-aaaa" }); fileNode(d, { id: "p-bbbb" }); });
    expect(command("delete").run(headless(), { ids: ["p-bbbb"] })).toEqual({ ids: ["p-bbbb"] });
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-aaaa"]);
    view.selection = ["p-aaaa"];
    command("delete").run(ctx(), { ids: [] });
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-aaaa"]);
  });

  test("headless, a command that acts on nodes needs ids; a given id must be a node", () => {
    const { command, headless, store } = setup((d) => { fileNode(d, { id: "p-aaaa" }); });
    for (const id of ["delete", "duplicate", "bring-forward", "send-backward"]) {
      expect(() => command(id).run(headless())).toThrow(new CommandError(`${id} needs "ids" when the figure is not open`));
      expect(() => command(id).run(headless(), { ids: ["p-none"] })).toThrow(CommandError);
    }
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-aaaa"]);
  });

  test("bring forward {ids} restacks the nodes named, not the selection", () => {
    const { command, headless, store } = setup((d) => { fileNode(d, { id: "p-aaaa", z: 0 }); fileNode(d, { id: "p-bbbb", z: 1 }); });
    command("bring-forward").run(headless(), { ids: ["p-aaaa"] });
    expect(Object.fromEntries(store.doc.nodes.map((n) => [n.id, n.z]))).toEqual({ "p-aaaa": 1, "p-bbbb": 0 });
  });

  test("duplicate {ids} copies the nodes named and does not change the selection", () => {
    const { command, ctx, view, store } = setup((d) => { fileNode(d, { id: "p-aaaa" }); fileNode(d, { id: "p-bbbb" }); });
    view.selection = ["p-aaaa"];
    const result = command("duplicate").run(ctx(), { ids: ["p-bbbb"] }) as { ids: NodeId[] };
    expect(result.ids).toHaveLength(1);
    expect(store.doc.nodes.find((n) => n.id === result.ids[0])).toMatchObject({ type: "file" });
    expect(view.selection).toEqual(["p-aaaa"]);
  });
});

test("the commands that need a view are flagged, and the rest are not", () => {
  const { plugin } = setup();
  const needsView = plugin.registries.commands.all().filter((c) => c.needsView).map((c) => c.id).sort();
  expect(needsView).toEqual(["export", "fit-page", "insert-text", "open-source", "reset-aspect", "zoom-100"]);
});

describe("duplicating connectors", () => {
  const offset = mmToPx(5);
  const round = (v: number) => Math.round(v * 100) / 100;
  const connector = (page: Page, id: string, z: number, ends: [End, End]): ConnectorNode => ({
    id, type: "connector", page: page.id, x: 0, y: 0, width: 0, height: 0, z, rotation: 0, opacity: 1, locked: false, ends,
    route: "straight", routeParams: {}, stroke: { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" },
    caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 3 }],
  });
  function build(d: Document) {
    const page = d.pages[0];
    d.nodes.push({ ...shapeNodeDefaults(page, { kind: "rect", params: {} }, []), id: "p-a", x: 0, y: 0, width: 100, height: 50, z: 0 } as Node);
    d.nodes.push({ ...shapeNodeDefaults(page, { kind: "rect", params: {} }, []), id: "p-b", x: 300, y: 0, width: 100, height: 50, z: 1 } as Node);
    d.nodes.push(connector(page, "p-line", 2, [{ kind: "attached", node: "p-a", snap: "anchor", anchor: "e" }, { kind: "attached", node: "p-b", snap: "anchor", anchor: "w" }]));
    d.nodes.push(connector(page, "p-loose", 3, [{ kind: "free", x: 10, y: 200 }, { kind: "attached", node: "p-a", snap: "center" }]));
  }

  test("ends on items copied in the same call follow the copies; the rest become free where they are drawn, offset", () => {
    const { command, headless, store, view } = setup(build);
    const before = store.doc;
    const lineEndB = resolveConnector(before, before.nodes.find((n) => n.id === "p-line") as ConnectorNode, view.registries).ends[1].pt;
    const { ids } = command("duplicate").run(headless(), { ids: ["p-a", "p-line"] }) as { ids: NodeId[] };
    const [copyA, copyLine] = ids.map((id) => store.doc.nodes.find((n) => n.id === id)!);
    expect((copyLine as ConnectorNode).ends).toEqual([
      { kind: "attached", node: copyA.id, snap: "anchor", anchor: "e" },
      { kind: "free", x: round(lineEndB.x + offset), y: round(lineEndB.y + offset) },
    ]);
    // The originals are as they were.
    expect(store.doc.nodes.find((n) => n.id === "p-line")).toEqual(before.nodes.find((n) => n.id === "p-line"));
  });

  test("a copied connector's free ends move with the copy, and its box follows its ends", () => {
    const { command, headless, store, view } = setup(build);
    const { ids } = command("duplicate").run(headless(), { ids: ["p-loose", "p-a"] }) as { ids: NodeId[] };
    const copy = store.doc.nodes.find((n) => n.id === ids[1]) as ConnectorNode;
    expect(copy.type).toBe("connector");
    expect(copy.ends).toEqual([{ kind: "free", x: round(10 + offset), y: round(200 + offset) }, { kind: "attached", node: ids[0], snap: "center" }]);
    expect(store.doc.nodes.find((n) => n.id === ids[0])).toMatchObject({ type: "shape", x: round(offset) });
    const resolved = resolveConnector(store.doc, copy, view.registries);
    expect({ x: copy.x, y: copy.y, width: copy.width, height: copy.height }).toEqual(resolved.bounds);
  });
});

test("duplicate offsets copies by 5 mm, gives them new ids, puts them on top, and selects them", () => {
  const { command, ctx, view, store } = setup((d) => {
    fileNode(d, { id: "p-aaaa", x: 10, y: 20, z: 0 });
    fileNode(d, { id: "p-bbbb", x: 30, y: 40, z: 1 });
    fileNode(d, { id: "p-cccc", x: 50, y: 60, z: 2 });
  });
  view.selection = ["p-bbbb", "p-aaaa"];
  command("duplicate").run(ctx());

  const nodes = store.doc.nodes;
  expect(nodes).toHaveLength(5);
  const copies = nodes.slice(3);
  expect(new Set(nodes.map((n) => n.id)).size).toBe(5);
  expect(copies.map((c) => c.id)).toEqual(view.selection);
  expect(view.selection).not.toContain("p-aaaa");
  // Copies keep the stacking order of their originals (a below b), above everything that was on the page.
  expect(copies.map((c) => [c.x, c.y, c.z])).toEqual([
    [+(10 + mmToPx(5)).toFixed(2), +(20 + mmToPx(5)).toFixed(2), 3],
    [+(30 + mmToPx(5)).toFixed(2), +(40 + mmToPx(5)).toFixed(2), 4],
  ]);
  // Everything else about a copy is its original's, and the originals have not moved.
  expect(copies[0]).toMatchObject({ type: "file", file: "plot.png", page: nodes[0].page, width: nodes[0].width });
  expect(nodes.slice(0, 3).map((n) => [n.x, n.y])).toEqual([[10, 20], [30, 40], [50, 60]]);
});

test("duplicate is one undo step", () => {
  const { command, ctx, view, store } = setup((d) => { fileNode(d, { id: "p-aaaa" }); });
  view.selection = ["p-aaaa"];
  command("duplicate").run(ctx());
  expect(store.doc.nodes).toHaveLength(2);
  store.undo();
  expect(store.doc.nodes).toHaveLength(1);
});

test("duplicate keeps a text node's font, and copies do not share objects with the originals", () => {
  const { command, ctx, view, store } = setup((d) => { d.nodes.push(textNodeDefaults(d.pages[0], { id: "p-text" }, [])); });
  view.selection = ["p-text"];
  command("duplicate").run(ctx());
  const [original, copy] = store.doc.nodes as any[];
  expect(copy.font).toEqual(original.font);
  expect(copy.font).not.toBe(original.font);
});

describe("insert-text", () => {
  test("Text arms the tool from the toolbar and the palette; running it again disarms", () => {
    const { plugin, command, ctx, view, store } = setup();
    const text = command("insert-text");
    expect(text.applies(ctx())).toBe(true);
    // The toolbar runs the command.
    text.run(ctx());
    expect(view.armedTool).toBe(text);
    text.run(ctx());
    expect(view.armedTool).toBeNull();
    // The palette entry runs it through the view, as the toolbar does.
    const palette = plugin.commands.find((c) => c.id === "lf-insert-text");
    expect(palette.checkCallback(false)).toBe(true);
    expect(view.armedTool).toBe(text);
    // Arming adds nothing: the label comes with the press on the page.
    expect(store.doc.nodes).toEqual([]);
    expect(store.canUndo()).toBe(false);
  });

  test("placing Text puts the label's top-left at the point, above everything on that page, selected and editing, in one undo step", () => {
    const { command, ctx, view, store } = setup((d) => {
      d.pages.push(createPage("a4-landscape", d.pages.map((p) => p.id)));
      fileNode(d, { id: "p-low", z: 2, page: d.pages[0].id });
      fileNode(d, { id: "p-high", z: 7, page: d.pages[0].id });
      fileNode(d, { id: "p-other", z: 40, page: d.pages[1].id });
    });
    const text = command("insert-text");
    expect(text.cursor).toBe("text");
    // The point's page decides, not the page of the selection or the one in the middle of the stage.
    view.selection = ["p-low"];
    text.place!(ctx(), { page: store.doc.pages[1], x: 12.346, y: 67.891 });

    expect(store.doc.nodes).toHaveLength(4);
    const label = store.doc.nodes[3];
    expect(label).toMatchObject({ type: "text", text: "Text", page: store.doc.pages[1].id, x: 12.35, y: 67.89, z: 41, rotation: 0, locked: false });
    expect(view.selection).toEqual([label.id]);
    expect(view.calls).toEqual([`activate:${label.id}`]);

    store.undo();
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-low", "p-high", "p-other"]);
    expect(store.canUndo()).toBe(false);

    // On the first page it goes above the nodes of that page, whatever the second holds.
    text.place!(ctx(), { page: store.doc.pages[0], x: 0, y: 0 });
    expect(store.doc.nodes.at(-1)).toMatchObject({ page: store.doc.pages[0].id, x: 0, y: 0, z: 8 });
  });

  test("a second one gets its own id", () => {
    const { command, ctx, store } = setup();
    const at = { page: store.doc.pages[0], x: 10, y: 10 };
    command("insert-text").place!(ctx(), at);
    command("insert-text").place!(ctx(), at);
    expect(new Set(store.doc.nodes.map((n) => n.id)).size).toBe(2);
    expect(store.doc.nodes.map((n) => n.z)).toEqual([0, 1]);
  });

  test("is in the palette, and the toolbar's insert group", () => {
    const { plugin } = setup();
    expect(plugin.commands.find((c) => c.id === "lf-insert-text").name).toBe("Text");
    expect(plugin.registries.commands.get("insert-text")).toMatchObject({ group: "insert", icon: "type" });
    expect(plugin.registries.commands.get("insert-text")!.hotkeys).toBeUndefined();
  });
});

describe("restack", () => {
  const nodes = (...zs: number[]) => zs.map((z, i) => ({ id: `n${i}`, z }));
  const apply = (list: { id: string; z: number }[], changes: Map<string, number>) =>
    list.map((n) => ({ ...n, z: changes.get(n.id) ?? n.z })).sort((a, b) => a.z - b.z).map((n) => n.id);

  test("bring forward swaps z with the neighbour above", () => {
    const list = nodes(0, 1, 2);
    const changes = restack(list, new Set(["n0"]), "forward");
    expect(Object.fromEntries(changes)).toEqual({ n0: 1, n1: 0 });
    expect(apply(list, changes)).toEqual(["n1", "n0", "n2"]);
  });

  test("send backward swaps z with the neighbour below", () => {
    const list = nodes(0, 1, 2);
    expect(Object.fromEntries(restack(list, new Set(["n2"]), "backward"))).toEqual({ n2: 1, n1: 2 });
  });

  test("the nearest neighbour is by z, not by position in the document", () => {
    const list = [{ id: "a", z: 5 }, { id: "b", z: 1 }, { id: "c", z: 9 }];
    expect(Object.fromEntries(restack(list, new Set(["b"]), "forward"))).toEqual({ b: 5, a: 1 });
  });

  test("at the end of the stack nothing moves", () => {
    expect(restack(nodes(0, 1, 2), new Set(["n2"]), "forward").size).toBe(0);
    expect(restack(nodes(0, 1, 2), new Set(["n0"]), "backward").size).toBe(0);
    expect(restack(nodes(0, 0, 0), new Set(["n2"]), "forward").size).toBe(0);
  });

  test("a selected block moves up one place as a block", () => {
    const list = nodes(0, 1, 2, 3);
    expect(apply(list, restack(list, new Set(["n1", "n2"]), "forward"))).toEqual(["n0", "n3", "n1", "n2"]);
    expect(apply(list, restack(list, new Set(["n1", "n2"]), "backward"))).toEqual(["n1", "n2", "n0", "n3"]);
  });

  test("nodes that share a z are told apart by their place in the document, so moving past a tie shows", () => {
    const list = nodes(0, 0, 0);
    // n0 is lowest by document order; bringing it forward puts it over n1.
    expect(apply(list, restack(list, new Set(["n0"]), "forward"))).toEqual(["n1", "n0", "n2"]);
  });
});

test("bring forward and send backward swap with the nearest node on the same page, and leave other pages alone", () => {
  const { command, ctx, view, store } = setup((d) => {
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
    fileNode(d, { id: "p-low", z: 0 });
    fileNode(d, { id: "p-mid", z: 1 });
    // Higher than both, but on the other page: not a neighbour.
    fileNode(d, { id: "p-other", z: 2, page: d.pages[1].id });
    fileNode(d, { id: "p-top", z: 5 });
  });
  const z = () => Object.fromEntries(store.doc.nodes.map((n) => [n.id, n.z]));
  view.selection = ["p-mid"];
  command("bring-forward").run(ctx());
  expect(z()).toEqual({ "p-low": 0, "p-mid": 5, "p-other": 2, "p-top": 1 });
  command("send-backward").run(ctx());
  expect(z()).toEqual({ "p-low": 0, "p-mid": 1, "p-other": 2, "p-top": 5 });
  // Already at the bottom: nothing changes, and no history entry is made.
  view.selection = ["p-low"];
  const doc = store.doc;
  command("send-backward").run(ctx());
  expect(store.doc).toBe(doc);
});

describe("reset-aspect", () => {
  const crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
  const heights = (store: DocumentStore) => Object.fromEntries(store.doc.nodes.map((n) => [n.id, n.height]));

  test("is in the palette and the toolbar's arrange group, after Send backward, with no hotkey", () => {
    const { plugin } = setup();
    expect(plugin.commands.find((c) => c.id === "lf-reset-aspect").name).toBe("Reset aspect ratio");
    expect(plugin.registries.commands.get("reset-aspect")).toMatchObject({ name: "Reset aspect ratio", group: "arrange", icon: "ratio" });
    expect(plugin.registries.commands.get("reset-aspect")!.hotkeys).toBeUndefined();
  });

  test("keeps the width and sets the height from the image and its crop", async () => {
    const { command, ctx, view, store } = setup((d) => { fileNode(d, { id: "p-a", width: 100, height: 100 }); });
    view.sizes = { "p-a": { width: 200, height: 100 } };
    view.selection = ["p-a"];

    await command("reset-aspect").run(ctx());
    expect(store.doc.nodes[0]).toMatchObject({ width: 100, height: 50 });

    // The same node cropped to the right half of the image: 100 × 100 px of it, a square.
    store.commit("crop", (d) => { (d.nodes[0] as Extract<Node, { type: "file" }>).crop = crop; });
    await command("reset-aspect").run(ctx());
    expect(store.doc.nodes[0]).toMatchObject({ width: 100, height: 100 });
  });

  test("rounds the height to hundredths and never takes it under the least a node may be", async () => {
    const { command, ctx, view, store } = setup((d) => {
      fileNode(d, { id: "p-odd", width: 100, height: 10 });
      fileNode(d, { id: "p-thin", width: 100, height: 10 });
    });
    view.sizes = { "p-odd": { width: 3, height: 2 }, "p-thin": { width: 100000, height: 1 } };
    view.selection = ["p-odd", "p-thin"];
    await command("reset-aspect").run(ctx());
    expect(store.doc.nodes[0].height).toBe(66.67);
    expect(store.doc.nodes[1].height).toBe(MIN_NODE_PX);
  });

  test("applies to unlocked image panels only, skips a node whose size is unknown, and is one undo step", async () => {
    const { command, ctx, view, store } = setup((d) => {
      fileNode(d, { id: "p-a", width: 100, height: 100 });
      fileNode(d, { id: "p-b", width: 80, height: 100 });
      fileNode(d, { id: "p-unknown", width: 100, height: 100 });
      fileNode(d, { id: "p-locked", width: 100, height: 100, locked: true });
      fileNode(d, { id: "p-content", width: 100, height: 100, show: "content" } as Partial<Node>);
      d.nodes.push(textNodeDefaults(d.pages[0], { id: "p-text", width: 100, height: 100 }, d.nodes.map((n) => n.id)));
    });
    view.sizes = {
      "p-a": { width: 200, height: 100 },
      "p-b": { width: 100, height: 100 },
      "p-locked": { width: 200, height: 100 },
      "p-content": { width: 200, height: 100 },
      "p-text": { width: 200, height: 100 },
    };
    const reset = command("reset-aspect");

    // Nothing selected, or only what it does not apply to.
    expect(reset.applies(ctx())).toBe(false);
    for (const only of ["p-locked", "p-content", "p-text"]) {
      view.selection = [only];
      expect(reset.applies(ctx())).toBe(false);
    }
    // One image panel among others is enough; a node of unknown size is still an image panel.
    view.selection = ["p-locked", "p-content", "p-text", "p-a"];
    expect(reset.applies(ctx())).toBe(true);
    view.selection = ["p-unknown"];
    expect(reset.applies(ctx())).toBe(true);

    view.selection = ["p-a", "p-b", "p-unknown", "p-locked", "p-content", "p-text"];
    await reset.run(ctx());
    expect(heights(store)).toEqual({ "p-a": 50, "p-b": 80, "p-unknown": 100, "p-locked": 100, "p-content": 100, "p-text": 100 });

    // One commit for all of them.
    store.undo();
    expect(heights(store)).toEqual({ "p-a": 100, "p-b": 100, "p-unknown": 100, "p-locked": 100, "p-content": 100, "p-text": 100 });
    expect(store.canUndo()).toBe(false);
  });

  test("leaves a panel whose crop has no area as it is, rather than writing a height that is not a number", async () => {
    const { command, ctx, view, store } = setup((d) => {
      fileNode(d, { id: "p-flat", width: 100, height: 70, crop: { x: 0.2, y: 0.2, w: 0, h: 0.5 } } as Partial<Node>);
    });
    view.sizes = { "p-flat": { width: 200, height: 100 } };
    view.selection = ["p-flat"];
    await command("reset-aspect").run(ctx());
    expect(store.doc.nodes[0].height).toBe(70);
    expect(store.canUndo()).toBe(false);
  });

  test("leaves a panel that was locked while its size was awaited as it was", async () => {
    const { command, ctx, view, store } = setup((d) => { fileNode(d, { id: "p-a", width: 100, height: 100 }); });
    view.sizes = { "p-a": { width: 200, height: 100 } };
    view.selection = ["p-a"];
    const done = command("reset-aspect").run(ctx());
    store.commit("inspector", (d) => { d.nodes[0].locked = true; });
    await done;
    expect(store.doc.nodes[0].height).toBe(100);
  });

  test("makes no commit when no height changes, or when no size is known", async () => {
    const { command, ctx, view, store } = setup((d) => {
      fileNode(d, { id: "p-fits", width: 100, height: 50 });
      fileNode(d, { id: "p-unknown", width: 100, height: 100 });
    });
    view.sizes = { "p-fits": { width: 200, height: 100 } };
    const doc = store.doc;
    view.selection = ["p-fits", "p-unknown"];
    await command("reset-aspect").run(ctx());
    expect(store.doc).toBe(doc);
    expect(store.canUndo()).toBe(false);
  });

  test("leaves out a node that went from the document while its size was awaited", async () => {
    const { command, ctx, view, store } = setup((d) => {
      fileNode(d, { id: "p-gone", width: 100, height: 100 });
      fileNode(d, { id: "p-here", width: 100, height: 100 });
    });
    view.sizes = { "p-gone": { width: 200, height: 100 }, "p-here": { width: 200, height: 100 } };
    view.selection = ["p-gone", "p-here"];
    const done = command("reset-aspect").run(ctx());
    store.commit("delete", (d) => { d.nodes = d.nodes.filter((n) => n.id !== "p-gone"); });
    await done;
    expect(heights(store)).toEqual({ "p-here": 50 });
  });
});

test("add page puts a page of the same preset after the current one", () => {
  const { command, ctx, view, store } = setup((d) => {
    d.pages.push(createPage("nature-single", d.pages.map((p) => p.id)));
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
  });
  view.pageIndex = 1;
  command("add-page").run(ctx());
  const pages = store.doc.pages;
  expect(pages).toHaveLength(4);
  expect(pages[2]).toMatchObject({ preset: "nature-single", width: 89, height: 170 });
  expect(pages[3]).toMatchObject({ preset: "a4-portrait" });
  expect(new Set(pages.map((p) => p.id)).size).toBe(4);
});

test("add page after a page of a custom size copies the size", () => {
  const { command, ctx, store } = setup((d) => { Object.assign(d.pages[0], { preset: "custom", width: 123, height: 45 }); });
  command("add-page").run(ctx());
  expect(store.doc.pages[1]).toMatchObject({ preset: "custom", width: 123, height: 45 });
});

test("add page after a page over the size limit cuts the copy down to the limit, and says so", () => {
  const { command, ctx, store, view } = setup((d) => { Object.assign(d.pages[0], { preset: "custom", width: 2500, height: 45 }); });
  command("add-page").run(ctx());
  expect(store.doc.pages[1]).toMatchObject({ preset: "custom", width: 2000, height: 45 });
  expect(view.calls).toEqual(["page-limit:2000"]);
});

test("add page after a preset larger than a lowered limit makes a custom page at the limit", () => {
  const { command, ctx, store, view } = setup();
  view.limitMm = 200;
  command("add-page").run(ctx());
  expect(store.doc.pages[1]).toMatchObject({ preset: "custom", width: 200, height: 200 });
  expect(view.calls).toEqual(["page-limit:200"]);
});

test("add page within the limit says nothing", () => {
  const { command, ctx, view } = setup();
  command("add-page").run(ctx());
  expect(view.calls).toEqual([]);
});

test("add page on a document that has no pages makes the first one", () => {
  const { command, ctx, store } = setup((d) => { d.pages = []; });
  expect(() => command("add-page").run(ctx())).not.toThrow();
  expect(store.doc.pages).toHaveLength(1);
});

test("delete page needs more than one page, and removes the page with its nodes in one undo step", () => {
  const { command, ctx, view, store } = setup((d) => {
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
    fileNode(d, { id: "p-here", page: d.pages[0].id });
    fileNode(d, { id: "p-locked", page: d.pages[0].id, locked: true });
    fileNode(d, { id: "p-there", page: d.pages[1].id });
  });
  const [first, second] = store.doc.pages.map((p) => p.id);
  expect(command("delete-page").applies(ctx())).toBe(true);
  command("delete-page").run(ctx());
  expect(store.doc.pages.map((p) => p.id)).toEqual([second]);
  expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-there"]);
  expect(command("delete-page").applies(ctx())).toBe(false);
  // The last page is never deleted, even by a command that is run anyway.
  view.pageIndex = 0;
  command("delete-page").run(ctx());
  expect(store.doc.pages).toHaveLength(1);

  store.undo();
  expect(store.doc.pages.map((p) => p.id)).toEqual([first, second]);
  expect(store.doc.nodes.map((n) => n.id).sort()).toEqual(["p-here", "p-locked", "p-there"]);
});

test("fit page, zoom to 100% and export go through the view", () => {
  const { command, ctx, view } = setup();
  command("fit-page").run(ctx());
  command("zoom-100").run(ctx());
  command("export").run(ctx());
  expect(view.calls).toEqual(["fit", "zoom:1", "export"]);
  for (const id of ["fit-page", "zoom-100", "export", "add-page"]) expect(command(id).applies(ctx())).toBe(true);
});

test("open source applies to one selected file node that has a link, and opens that link", () => {
  const { command, ctx, view } = setup((d) => {
    fileNode(d, { id: "p-img", file: "plot.png", subpath: "" });
    fileNode(d, { id: "p-sec", file: "analysis.md", subpath: "#^fig2b" });
    fileNode(d, { id: "p-none", file: "", subpath: "" });
    d.nodes.push(textNodeDefaults(d.pages[0], { id: "p-text" }, d.nodes.map((n) => n.id)));
  });
  const open = command("open-source");
  view.selection = ["p-sec"];
  expect(open.applies(ctx())).toBe(true);
  open.run(ctx());
  expect(view.calls).toEqual(["open:analysis.md#^fig2b"]);
  view.selection = ["p-img", "p-sec"];
  expect(open.applies(ctx())).toBe(false);
  view.selection = ["p-text"];
  expect(open.applies(ctx())).toBe(false);
  view.selection = ["p-none"];
  expect(open.applies(ctx())).toBe(false);
});

describe("page-level commands with a selection on a page the stage is not centred on", () => {
  // Two pages; the stage is centred on page 1 (pageIndex 0) and a node of page 2 is selected.
  const twoPages = () => setup((d) => {
    d.pages.push(createPage("nature-single", d.pages.map((p) => p.id)));
    fileNode(d, { id: "p-on-1", page: d.pages[0].id });
    fileNode(d, { id: "p-on-2", page: d.pages[1].id });
  });

  test("the command context's page is the selection's page, else the page the stage is centred on", () => {
    const { ctx, view, store } = twoPages();
    expect(ctx().page).toBe(store.doc.pages[0]);
    view.selection = ["p-on-2"];
    expect(ctx().page).toBe(store.doc.pages[1]);
    view.selection = [];
    expect(ctx().page).toBe(store.doc.pages[0]);
  });

  test("add page goes after the selection's page", () => {
    const { command, ctx, view, store } = twoPages();
    const [first, second] = store.doc.pages.map((p) => p.id);
    view.selection = ["p-on-2"];
    command("add-page").run(ctx());
    const pages = store.doc.pages;
    expect(pages.map((p) => p.id).slice(0, 2)).toEqual([first, second]);
    expect(pages).toHaveLength(3);
    // Same preset as the page it follows (page 2, not the page in the middle of the stage).
    expect(pages[2]).toMatchObject({ preset: "nature-single", width: 89 });
  });

  test("delete page removes the selection's page and its nodes, not the page in the middle of the stage", () => {
    const { command, ctx, view, store } = twoPages();
    const first = store.doc.pages[0].id;
    view.selection = ["p-on-2"];
    command("delete-page").run(ctx());
    expect(store.doc.pages.map((p) => p.id)).toEqual([first]);
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["p-on-1"]);
  });
});

test("a text placed right after a drop is an undo step of its own, not merged with the drop's insert", () => {
  const { command, ctx, store } = setup();
  // What a drop commits (`Intake`), a moment before a Text label is placed.
  store.commit("insert", (draft) => {
    draft.nodes.push(fileNodeDefaults(draft.pages[0], { file: "plot.png", subpath: "", show: "image" }, []));
  });
  command("insert-text").place!(ctx(), { page: store.doc.pages[0], x: 10, y: 10 });
  expect(store.doc.nodes.map((n) => n.type)).toEqual(["file", "text"]);
  store.undo();
  expect(store.doc.nodes.map((n) => n.type)).toEqual(["file"]);
});
