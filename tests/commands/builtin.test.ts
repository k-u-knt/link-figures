import { registerBuiltinCommands, restack, type EditorView } from "../../src/commands/builtin";
import { createDocument, createPage, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import { DocumentStore } from "../../src/model/store";
import type { Document, Node, NodeId } from "../../src/model/types";
import { createRegistries } from "../../src/registry";
import type { Command, CommandContext } from "../../src/registry/command";
import { pageInFocus } from "../../src/view/viewport";

/** A view that records what the commands ask of it. */
class FakeView implements EditorView {
  file = { path: "fig.lnkfig.md" };
  selection: NodeId[] = [];
  readOnly = false;
  calls: string[] = [];
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
  deleteSelection(): boolean { this.calls.push("delete"); return true; }
  openLink(linktext: string): void { this.calls.push(`open:${linktext}`); }
  commandContext(): CommandContext { return { app: {} as never, view: this, store: this.store, selection: this.selectedIds(), page: this.focusPage() }; }
  runCommand(command: Command): void { command.run(this.commandContext()); }
}

function setup(build: (doc: Document) => void = () => {}) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const view = new FakeView(new DocumentStore(doc));
  const plugin = { registries: createRegistries(), commands: [] as any[], addCommand(c: any) { this.commands.push(c); return c; }, activeFigureView: () => view as FakeView | null };
  registerBuiltinCommands(plugin as never);
  const command = (id: string): Command => plugin.registries.commands.get(id)!;
  const ctx = () => view.commandContext();
  return { view, plugin, command, ctx, store: view.store };
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
  const { plugin, view } = setup();
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
  expect(view.store.doc.nodes).toEqual([]);
});

test("delete is the view's own deletion", () => {
  const { command, ctx, view } = setup((d) => { fileNode(d); });
  view.selection = [view.store.doc.nodes[0].id];
  command("delete").run(ctx());
  expect(view.calls).toEqual(["delete"]);
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
  test("adds a text node centred on the current page, selects it, and is one undo step", () => {
    const { command, ctx, view, store } = setup();
    expect(command("insert-text").applies(ctx())).toBe(true);
    command("insert-text").run(ctx());

    const [node] = store.doc.nodes;
    expect(store.doc.nodes).toHaveLength(1);
    expect(node).toMatchObject({ type: "text", text: "Text", page: store.doc.pages[0].id, z: 0, rotation: 0, locked: false });
    const page = store.doc.pages[0];
    expect(node.x + node.width / 2).toBeCloseTo(mmToPx(page.width) / 2, 1);
    expect(node.y + node.height / 2).toBeCloseTo(mmToPx(page.height) / 2, 1);
    expect(view.selection).toEqual([node.id]);

    store.undo();
    expect(store.doc.nodes).toEqual([]);
  });

  test("goes on top of the nodes of the page it is for, whatever other pages hold", () => {
    const { command, ctx, view, store } = setup((d) => {
      d.pages.push(createPage("a4-landscape", d.pages.map((p) => p.id)));
      fileNode(d, { id: "p-low", z: 2, page: d.pages[0].id });
      fileNode(d, { id: "p-high", z: 7, page: d.pages[0].id });
      fileNode(d, { id: "p-other", z: 40, page: d.pages[1].id });
    });
    command("insert-text").run(ctx());
    expect(store.doc.nodes.at(-1)!.z).toBe(8);

    // Nothing selected, the stage centred on the second page: it gets the node, centred on its own size.
    view.selection = [];
    view.pageIndex = 1;
    command("insert-text").run(ctx());
    const second = store.doc.nodes.at(-1)!;
    expect(second).toMatchObject({ page: store.doc.pages[1].id, z: 41 });
    expect(second.x + second.width / 2).toBeCloseTo(mmToPx(store.doc.pages[1].width) / 2, 1);
    expect(second.y + second.height / 2).toBeCloseTo(mmToPx(store.doc.pages[1].height) / 2, 1);
  });

  test("a second one gets its own id", () => {
    const { command, ctx, store } = setup();
    command("insert-text").run(ctx());
    command("insert-text").run(ctx());
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
