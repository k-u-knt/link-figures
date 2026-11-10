// @vitest-environment happy-dom
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { cardCommands } from "../../src/commands/cards";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { panelCommands } from "../../src/commands/panels";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { InvalidationIndex } from "../../src/links/invalidation";
import type { Resolved } from "../../src/links/types";
import { paperRectsWorld } from "../../src/model/card-space";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { mmToPx, nodeWorldRect, pageOriginsPx, rectIntersects, type PlacePoint } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import type { CardNode, ConnectorNode, Document, FileNode, Node } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { fileNodeType } from "../../src/nodes/file-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import type { CommandContext, DragTargets, UndoStep } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { FakeAccess } from "../links/fake-access";

// `obsidian` ships only typings: the renderer is a spy that writes the Markdown it is given as text.
const render = vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
  if (el) el.textContent = markdown;
});
/** An Obsidian `Menu` that records its entries, so a test can click one. */
class FakeMenuItem {
  title = "";
  click: (() => void) | null = null;
  setTitle(t: string) { this.title = t; return this; }
  setIcon() { return this; }
  setDisabled() { return this; }
  onClick(fn: () => void) { this.click = fn; return this; }
}
const menus = vi.hoisted(() => [] as { items: { title: string; click: (() => void) | null }[] }[]);
vi.mock("obsidian", () => ({
  Menu: class {
    items: FakeMenuItem[] = [];
    constructor() { menus.push(this); }
    addItem(fn: (item: FakeMenuItem) => void) { const item = new FakeMenuItem(); fn(item); this.items.push(item); return this; }
    addSeparator() { return this; }
    onHide() { return this; }
    showAtPosition() { return this; }
  },
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

const { PointerController, isPanPress } = await import("../../src/view/pointer");
const { SelectionState } = await import("../../src/view/selection");
const { Viewport } = await import("../../src/view/viewport");
const { Intake } = await import("../../src/links/intake");
const { menuModel } = await import("../../src/view/menu-model");
const { NodeHost } = await import("../../src/view/node-host");
const { showContextMenu } = await import("../../src/view/context-menu");

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

beforeEach(() => render.mockClear());

const CARD_W = mmToPx(60);
const CARD_H = mmToPx(40);
const GAP = mmToPx(4);

function registries(): Registries {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  r.nodeTypes.register(cardNodeType);
  r.nodeTypes.register(fileNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const kind of builtinShapeKinds) r.shapes.register(kind);
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  for (const paint of builtinPaintTypes) r.paints.register(paint);
  for (const command of [...drawingCommands(), ...cardCommands(), ...panelCommands(), ...groupCommands()]) r.commands.register(command);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  return r;
}

/**
 * Two A4 pages, "pg-1" and "pg-2" below it. Shape A at (50, 50) on pg-1, 100 × 80 px. Text card "C" placed against pg-1
 * at (-400, 100), off its paper to the left; note card "N" against pg-1 at (-400, 400).
 */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  doc.pages[0].id = "pg-1";
  doc.pages[1].id = "pg-2";
  const page = doc.pages[0];
  doc.nodes.push(shapeNodeDefaults(page, { id: "A", kind: "rect", x: 50, y: 50, width: 100, height: 80, z: 0 }, []));
  doc.nodes.push({ ...cardNodeDefaults(page, -400, 100, ["A"]), id: "C", text: "Legend **one**" });
  const note: CardNode = { ...cardNodeDefaults(page, -400, 400, ["A", "C"]), id: "N", file: "Notes/a", subpath: "#Legend" };
  delete note.text;
  doc.nodes.push(note);
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

function setup(armed: string | null = null) {
  const r = registries();
  let controller: { commitTime(): number } | null = null;
  const store = createFigureStore(figure(), r, () => controller?.commitTime() ?? Date.now());
  const labels: string[] = [];
  store.subscribe((ev) => {
    if (ev.kind === "commit") labels.push(ev.label);
  });
  const pending: Promise<unknown>[] = [];
  const options = new Map<string, unknown>();
  const view: any = {
    app: {},
    file: { path: "fig.lnkfig.md" },
    store,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    plugin: { registries: r },
    viewOption: (key: string) => options.get(key),
    setViewOption: (key: string, value: unknown) => options.set(key, value),
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: () => undefined },
    pageLayer: { overlayHost: () => { throw new Error("no overlay"); } },
    armedTool: armed ? r.commands.get(armed)! : null,
    selectedIds: () => [...view.selection.ids],
    setSelection: (ids: string[]) => view.selection.set(ids),
    currentPage: () => store.doc.pages[0],
    activateNode: vi.fn(),
    // The view is the Component that a rendered card's own components are children of.
    addChild: vi.fn(),
    removeChild: vi.fn(),
    armTool: (c: unknown) => void (view.armedTool = c),
    disarmTool: () => void (view.armedTool = null),
    commandContext: (): CommandContext => ({ app: {} as never, registries: r, view, store, selection: view.selectedIds(), page: store.doc.pages[0] }),
    placeTool: (at: PlacePoint) => {
      const tool = view.armedTool;
      view.disarmTool();
      tool.place(view.commandContext(), at);
    },
    placeToolDrag: (from: PlacePoint, to: PlacePoint, mods: { shift: boolean }, targets: DragTargets) => {
      const tool = view.armedTool;
      view.disarmTool();
      tool.placeDrag(view.commandContext(), from, to, mods, targets);
    },
    toolPreview: (from: PlacePoint | null, to: PlacePoint, targets: DragTargets) => view.armedTool?.preview?.(view.commandContext(), from, to, targets) ?? null,
    runCommandById: (id: string, args?: Record<string, unknown>, step?: UndoStep) => {
      pending.push(runCall(store, view.commandContext(), prepareCall(r, { id, args }), step));
    },
  };
  const stage = new FakeStage();
  const pointerController = new PointerController(view);
  // As the figure view does: a tool chosen from a context menu is placed at the menu's point (see `placeToolAt`).
  view.placeToolAt = (id: string, client: { x: number; y: number }) => {
    const tool = r.commands.get(id)!;
    const at = pointerController.toolPointAt(tool, view.viewport.toWorld(view.stagePoint({ clientX: client.x, clientY: client.y })));
    if (!at) return;
    view.armedTool = tool;
    view.placeTool(at);
  };
  view.contextMenuOpen = false;
  const fire = (type: string, ev: object) => stage.fire(type, ev);
  controller = pointerController;
  pointerController.attach(stage as never);
  const pointer = (type: string, [clientX, clientY]: [number, number]) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, clientX, clientY, target: {}, preventDefault: vi.fn() });
  const drag = async (from: [number, number], ...through: [number, number][]) => {
    pointer("pointerdown", from);
    for (const p of through) pointer("pointermove", p);
    pointer("pointerup", through[through.length - 1]);
    await Promise.all(pending);
  };
  const click = async (at: [number, number]) => {
    pointer("pointerdown", at);
    pointer("pointerup", at);
    await Promise.all(pending);
  };
  const node = <T extends Node = Node>(id: string) => store.doc.nodes.find((n) => n.id === id) as T;
  const connectors = () => store.doc.nodes.filter((n): n is ConnectorNode => n.type === "connector");
  const call = (id: string, args: Record<string, unknown>) => runCall(store, view.commandContext(), prepareCall(r, { id, args }));
  return { r, store, view, labels, drag, click, node, connectors, fire, call, controller: pointerController, settled: () => Promise.all(pending) };
}

/** A card mounted in a host element, drawn again on every change of the store as the node host draws it. */
function mountCard(s: ReturnType<typeof setup>, id: string, resolved: (id: string) => Resolved | undefined = () => undefined) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const ctx = {
    app: {},
    registries: s.r,
    figurePath: "fig.lnkfig.md",
    doc: () => s.store.doc,
    resolved,
    openLink: vi.fn(),
    component: s.view,
  };
  (s as unknown as { lastCtx: typeof ctx }).lastCtx = ctx;
  const renderer = cardNodeType.mount(s.node<CardNode>(id), host, ctx as never);
  s.store.subscribe(() => {
    const now = s.node(id);
    if (now) renderer.update(now);
  });
  const el = host.firstElementChild as HTMLElement;
  return { el, renderer, host };
}

const key = (el: Element, name: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

describe("card rendering and editing", () => {
  test("a text card renders its Markdown, a note card the resolved section, with a distinct card look", async () => {
    const s = setup();
    const text = mountCard(s, "C");
    expect(text.el.classList.contains("lf-node")).toBe(true);
    expect(text.el.classList.contains("lf-card")).toBe(true);
    expect(render).toHaveBeenCalledWith({}, "Legend **one**", expect.anything(), "fig.lnkfig.md", expect.anything());
    const content: Resolved = { kind: "content", file: { path: "Notes/a.md", extension: "md" }, markdown: "## Legend\nBody", deps: ["Notes/a.md"] };
    render.mockClear();
    mountCard(s, "N", () => content);
    expect(render).toHaveBeenCalledWith({}, "## Legend\nBody", expect.anything(), "Notes/a.md", expect.anything());
  });

  test("a double-click on a text card opens a textarea with its text; typing then Escape commits one undo step", async () => {
    const s = setup();
    const { el } = mountCard(s, "C");
    el.dispatchEvent(new CustomEvent("lf-activate"));
    const area = el.querySelector("textarea")!;
    expect(area).not.toBeNull();
    expect(area.value).toBe("Legend **one**");
    expect(document.activeElement).toBe(area);
    area.value = "Figure 1. *Mice*";
    key(area, "Escape");
    await s.settled();
    expect(el.querySelector("textarea")).toBeNull();
    expect(s.node<CardNode>("C").text).toBe("Figure 1. *Mice*");
    expect(s.labels).toHaveLength(1);
    s.store.undo();
    expect(s.node<CardNode>("C").text).toBe("Legend **one**");
    // Drawn again from the model, not left as what was typed.
    expect(el.textContent).toContain("Legend **one**");
  });

  test("a click away also commits; an unchanged text writes nothing", async () => {
    const s = setup();
    const { el } = mountCard(s, "C");
    el.dispatchEvent(new CustomEvent("lf-activate"));
    let area = el.querySelector("textarea")!;
    area.value = "Changed";
    area.dispatchEvent(new FocusEvent("blur"));
    await s.settled();
    expect(s.node<CardNode>("C").text).toBe("Changed");
    expect(s.labels).toHaveLength(1);

    el.dispatchEvent(new CustomEvent("lf-activate"));
    area = el.querySelector("textarea")!;
    area.dispatchEvent(new FocusEvent("blur"));
    key(el, "Escape");
    await s.settled();
    expect(s.labels).toHaveLength(1);
  });

  test("only the pointer controller's lf-activate starts an edit: a double-click on a card in a group enters the group", async () => {
    const s = setup();
    const { el } = mountCard(s, "C");
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(el.querySelector("textarea")).toBeNull();

    s.view.selection.set(["C", "N"]);
    s.view.runCommandById("group.create", { ids: ["C", "N"] });
    await s.settled();
    s.view.nodeHost = { elementFor: (id: string) => (id === "C" ? el : undefined) };
    const card = nodeWorldRect(s.store.doc, s.node("C"));
    s.fire("dblclick", { clientX: card.x + 10, clientY: card.y + 10, target: {} });
    expect(s.view.enteredGroup).toBe(s.node("C").parent);
    expect(el.querySelector("textarea")).toBeNull();
    // Inside the entered group, the same double-click edits it.
    s.fire("dblclick", { clientX: card.x + 10, clientY: card.y + 10, target: {} });
    expect(el.querySelector("textarea")).not.toBeNull();
  });

  test("a note card is not edited in place", () => {
    const s = setup();
    const { el } = mountCard(s, "N");
    el.dispatchEvent(new CustomEvent("lf-activate"));
    expect(el.querySelector("textarea")).toBeNull();
  });
});

describe("dragging a card", () => {
  test("dragging a card onto paper stops it at the gap and slides it along the edge", async () => {
    const s = setup();
    const start = nodeWorldRect(s.store.doc, s.node("C"));
    const press: [number, number] = [start.x + 20, start.y + 20];
    // Right across the paper's edge, and down: x stops at the gap, y keeps going.
    await s.drag(press, [press[0] + 100, press[1] + 10], [press[0] + 300, press[1] + 40], [press[0] + 600, press[1] + 80]);
    const card = nodeWorldRect(s.store.doc, s.node("C"));
    expect(card.x + card.width).toBeCloseTo(-GAP, 1);
    expect(card.y).toBeCloseTo(start.y + 80, 1);
    expect(paperRectsWorld(s.store.doc).some((p) => rectIntersects(p, card))).toBe(false);
    expect(s.node("C").page).toBe("pg-1");
    // One undo step puts it back.
    s.store.undo();
    expect(nodeWorldRect(s.store.doc, s.node("C"))).toEqual(start);
  });
});

describe("resizing a card", () => {
  test("a resize stops at the paper's gap", async () => {
    const s = setup();
    s.view.selection.set(["C"]);
    const start = nodeWorldRect(s.store.doc, s.node("C"));
    // The east handle, dragged far onto the paper.
    const handle: [number, number] = [start.x + start.width, start.y + start.height / 2];
    await s.drag(handle, [handle[0] + 100, handle[1]], [handle[0] + 500, handle[1]]);
    const card = nodeWorldRect(s.store.doc, s.node("C"));
    expect(card.x).toBeCloseTo(start.x, 5);
    expect(card.x + card.width).toBeCloseTo(-GAP, 1);
    expect(paperRectsWorld(s.store.doc).some((p) => rectIntersects(p, card))).toBe(false);
  });
});

describe("the Card tool", () => {
  test("the Card tool click on the canvas places a 60 × 40 mm card there and starts editing; on paper, outside the nearest edge", async () => {
    const s = setup("tool.card");
    await s.click([-600, 300]);
    const made = s.store.doc.nodes.filter((n) => n.type === "card" && !["C", "N"].includes(n.id));
    expect(made).toHaveLength(1);
    const card = made[0] as CardNode;
    expect(card.text).toBe("");
    expect(card.width).toBeCloseTo(CARD_W, 5);
    expect(card.height).toBeCloseTo(CARD_H, 5);
    const at = nodeWorldRect(s.store.doc, card);
    expect(at.x + at.width / 2).toBeCloseTo(-600, 1);
    expect(at.y + at.height / 2).toBeCloseTo(300, 1);
    expect(s.view.selection.ids).toEqual([card.id]);
    expect(s.view.activateNode).toHaveBeenCalledWith(card.id);
    expect(s.view.armedTool).toBeNull();

    // On paper, near its left edge: the card goes just outside that edge.
    s.view.armedTool = s.r.commands.get("tool.card");
    await s.click([60, 500]);
    const second = s.store.doc.nodes.find((n) => n.type === "card" && !["C", "N", card.id].includes(n.id))!;
    const box = nodeWorldRect(s.store.doc, second);
    expect(box.x + box.width).toBeCloseTo(-GAP, 1);
    expect(box.y + box.height / 2).toBeCloseTo(500, 1);
  });

  test("Card chosen from the canvas or page menu places a card at the menu's point and starts editing it", async () => {
    const s = setup();
    for (const [where, at] of [["canvas", { x: -600, y: 300 }], ["page", { x: 60, y: 700 }]] as const) {
      menus.length = 0;
      showContextMenu(s.view, where, at);
      menus[0].items.find((i) => i.title === "Card")!.click!();
      await s.settled();
      const id = s.view.selection.ids[0];
      expect(s.node(id).type).toBe("card");
      expect(s.view.activateNode).toHaveBeenLastCalledWith(id);
      const box = nodeWorldRect(s.store.doc, s.node(id));
      expect(box.y + box.height / 2).toBeCloseTo(at.y, 1);
      if (where === "canvas") expect(box.x + box.width / 2).toBeCloseTo(at.x, 1);
      else expect(box.x + box.width).toBeCloseTo(-GAP, 1);
      expect(s.view.armedTool).toBeNull();
    }
  });

  test("the Card tool is in the insert group, and in the canvas and page menus", () => {
    const tool = registries().commands.get("tool.card")!;
    expect(tool.group).toBe("insert");
    expect(tool.menu).toEqual(expect.arrayContaining(["canvas", "page"]));
    expect(tool.hidden).toBeFalsy();
  });
});

describe("drops", () => {
  function dropSetup(onPaper: boolean, files?: { path: string }[], link?: { type: "link"; linktext: string }) {
    const s = setup();
    const handlers = new Map<string, (ev: any) => void>();
    const access = new FakeAccess({ files: { "Notes/a.md": "# A\nText", "Notes/b.md": "# B\nText", "fig.lnkfig.md": "" }, headings: { "Notes/a.md": { Legend: { start: 0, end: null } } } });
    const draggable = link ?? (files ? { type: "files", files } : { type: "file", file: { path: "Notes/a.md" } });
    // The view's link text: Obsidian's shortest form, the base name.
    const context = s.view.commandContext;
    s.view.commandContext = () => ({ ...context(), linktext: (file: string) => file.slice(file.lastIndexOf("/") + 1) });
    s.view.app = { dragManager: { draggable } };
    Object.assign(s.view.plugin, { settings: { dropFromNote: "direct" }, editorDrag: { source: null, embed: null }, access, decoders: {} });
    s.view.stageEl = { focus: () => {} };
    s.view.registerDomEvent = (_el: unknown, type: string, fn: (ev: any) => void) => handlers.set(type, fn);
    new Intake(s.view).attach({} as never);
    const at: [number, number] = onPaper ? [300, 600] : [-700, 300];
    handlers.get("drop")!({ preventDefault: () => {}, dataTransfer: { files: [], getData: () => "" }, clientX: at[0], clientY: at[1] });
    return s;
  }

  test("a note dropped off the paper makes a note card of it, as Canvas makes a file card; on paper, still a content panel", async () => {
    const off = dropSetup(false);
    await vi.waitFor(() => expect(off.store.doc.nodes).toHaveLength(4));
    const card = off.store.doc.nodes[3] as CardNode;
    expect(card.type).toBe("card");
    expect(card.text).toBeUndefined();
    // Linked as a content panel links its note.
    expect(card.file).toBe("Notes/a");
    expect(card.subpath ?? "").toBe("");
    const box = nodeWorldRect(off.store.doc, card);
    expect([box.x, box.y]).toEqual([-700, 300]);
    expect(off.view.selection.ids).toEqual([card.id]);

    // Two notes off the paper: two note cards, one below the other, a 4 mm gap between them.
    const two = dropSetup(false, [{ path: "Notes/a.md" }, { path: "Notes/b.md" }]);
    await vi.waitFor(() => expect(two.store.doc.nodes).toHaveLength(5));
    const [first, second] = two.store.doc.nodes.slice(3) as CardNode[];
    expect([first.file, second.file]).toEqual(["Notes/a", "Notes/b"]);
    expect(first.text).toBeUndefined();
    expect(second.text).toBeUndefined();
    expect(second.y).toBeCloseTo(first.y + first.height + GAP, 1);

    // A heading makes a note card of that section.
    const heading = dropSetup(false, undefined, { type: "link", linktext: "Notes/a#Legend" });
    await vi.waitFor(() => expect(heading.store.doc.nodes).toHaveLength(4));
    const section = heading.store.doc.nodes[3] as CardNode;
    expect([section.file, section.subpath, section.text]).toEqual(["Notes/a", "#Legend", undefined]);

    const on = dropSetup(true);
    await vi.waitFor(() => expect(on.store.doc.nodes).toHaveLength(4));
    const panel = on.store.doc.nodes[3] as FileNode;
    expect(panel.type).toBe("file");
    expect(panel.show).toBe("content");
  });
});

describe("the connector tool and pages", () => {
  test("the connector tool from a card released over a page's paper makes an association, drawn with class `lf-association` (dashed)", async () => {
    const s = setup("tool.connector");
    const card = nodeWorldRect(s.store.doc, s.node("C"));
    const press: [number, number] = [card.x + card.width / 2, card.y + card.height / 2];
    await s.drag(press, [0, 400], [30, 500]);
    const [line] = s.connectors();
    expect(line.page).toBe("pg-1");
    expect(line.ends[0]).toMatchObject({ kind: "attached", node: "C" });
    expect(line.ends[1]).toEqual({ kind: "page", page: "pg-1", anchor: "w" });

    // Across pages: released over pg-2's paper, near its top.
    s.view.armedTool = s.r.commands.get("tool.connector");
    const pg2 = pageOriginsPx(s.store.doc).get("pg-2")!;
    await s.drag(press, [200, pg2.y + 10], [400, pg2.y + 20]);
    const second = s.connectors()[1];
    expect(second.ends[1]).toEqual({ kind: "page", page: "pg-2", anchor: "n" });

    // Drawn dashed, as an association; a connector between items is not.
    const host = document.createElement("div");
    const ctx = { registries: s.r, doc: () => s.store.doc };
    connectorNodeType.mount(line, host, ctx as never);
    expect((host.firstElementChild as HTMLElement).classList.contains("lf-association")).toBe(true);
  });

  test("a press off the paper that is not on a card puts the Connector tool down and draws nothing", async () => {
    const s = setup("tool.connector");
    await s.drag([-700, 300], [-300, 300], [100, 100]);
    expect(s.connectors()).toHaveLength(0);
    expect(s.view.armedTool).toBeNull();
    expect(s.controller.toolPointAt(s.r.commands.get("tool.connector")!, { x: -700, y: 300 })).toBeNull();
    expect(s.controller.toolPointAt(s.r.commands.get("tool.card")!, { x: -700, y: 300 })).not.toBeNull();
  });

  test("released over paper from a shape, the end stays free", async () => {
    const s = setup("tool.connector");
    const pg2 = pageOriginsPx(s.store.doc).get("pg-2")!;
    await s.drag([100, 90], [300, 400], [500, 600]);
    expect(s.connectors()[0].ends[1]).toEqual({ kind: "free", x: 500, y: 600 });
    s.view.armedTool = s.r.commands.get("tool.connector");
    await s.drag([100, 90], [300, pg2.y], [300, pg2.y + 100]);
    expect(s.connectors()[1].ends[1].kind).toBe("free");

    const host = document.createElement("div");
    connectorNodeType.mount(s.connectors()[0], host, { registries: s.r, doc: () => s.store.doc } as never);
    expect((host.firstElementChild as HTMLElement).classList.contains("lf-association")).toBe(false);
  });

  test("an association is drawn again when its page changes", () => {
    const s = setup();
    // The node host redraws a node tied to pages on any change of the pages.
    const hosts = new Map(s.store.doc.pages.map((p) => [p.id, document.createElement("div")]));
    const view: any = {
      app: {},
      file: { path: "fig.lnkfig.md" },
      store: s.store,
      resolvedCache: new Map(),
      index: new InvalidationIndex(),
      plugin: { access: new FakeAccess({ files: {} }), decoders: {}, registries: s.r },
      openLink: vi.fn(),
      samplesLanded: vi.fn(),
      addChild: vi.fn(),
      removeChild: vi.fn(),
    };
    const nodeHost = new NodeHost(view, { nodesHost: (id: string) => hosts.get(id)! } as never, s.r);
    void runCall(s.store, s.view.commandContext(), prepareCall(s.r, { id: "connector.create", args: { page: "pg-1", from: { kind: "attached", node: "C", snap: "center" }, to: { kind: "page", page: "pg-1", anchor: "w" } } }));
    nodeHost.renderAll(s.store.doc);
    const el = hosts.get("pg-1")!.querySelector(".lf-association") as HTMLElement;
    const before = el.querySelector("path")!.getAttribute("d");
    s.store.commit("page", (draft) => {
      draft.pages[0].height = 200;
    });
    nodeHost.applyChange(s.store.doc, new Set(), true);
    expect(el.querySelector("path")!.getAttribute("d")).not.toBe(before);
  });
});

describe("links in a card", () => {
  test("a click on a rendered link opens a new tab and does not select the card", async () => {
    const s = setup();
    render.mockImplementationOnce(async (_app, _markdown, el) => {
      el.innerHTML = 'See <a class="internal-link" data-href="Notes/a#Legend" href="Notes/a#Legend">a</a>.';
    });
    const { el } = mountCard(s, "C");
    const link = el.querySelector("a")!;
    expect(link).not.toBeNull();
    // The press on the link is the link's: the stage neither selects the card nor captures the pointer.
    const card = nodeWorldRect(s.store.doc, s.node("C"));
    s.fire("pointerdown", { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, clientX: card.x + 5, clientY: card.y + 5, target: link, preventDefault: vi.fn() });
    s.fire("pointerup", { pointerId: 1, isPrimary: true, button: 0, clientX: card.x + 5, clientY: card.y + 5, target: link });
    expect(s.view.selection.ids).toEqual([]);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const ctx = (s as unknown as { lastCtx: { openLink: ReturnType<typeof vi.fn> } }).lastCtx;
    expect(ctx.openLink).toHaveBeenCalledWith("Notes/a#Legend", click, "tab");
    // A middle-click does the same.
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(middle);
    expect(ctx.openLink).toHaveBeenLastCalledWith("Notes/a#Legend", middle, "tab");
    // A double-click on the link starts no edit.
    s.fire("dblclick", { clientX: card.x + 5, clientY: card.y + 5, target: link });
    expect(el.querySelector("textarea")).toBeNull();
  });

  test("a link opens once: Obsidian's own handler inside the card never also runs, and a click it already took is left to it", () => {
    const s = setup();
    render.mockImplementationOnce(async (_app, _markdown, el) => {
      el.innerHTML = '<div class="markdown-embed"><div class="markdown-embed-link">open</div><a class="internal-link" data-href="Notes/a">a</a></div>';
    });
    const { el } = mountCard(s, "C");
    const ctx = (s as unknown as { lastCtx: { openLink: ReturnType<typeof vi.fn> } }).lastCtx;
    const link = el.querySelector("a")!;
    // Obsidian's handler on the embed, in the bubbling phase.
    const inner = vi.fn((ev: Event) => ev.preventDefault());
    el.querySelector(".markdown-embed")!.addEventListener("click", inner);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(ctx.openLink).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();

    // A click a handler further out already took (default prevented) is not opened again.
    const outer = (ev: Event) => ev.preventDefault();
    document.addEventListener("click", outer, { capture: true });
    try {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener("click", outer, { capture: true });
    }
    expect(ctx.openLink).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  test("a middle press on a card link is the link's, not a canvas pan: it opens the link once in a new tab", () => {
    const s = setup();
    render.mockImplementationOnce(async (_app, _markdown, el) => {
      el.innerHTML = 'See <a class="internal-link" data-href="Notes/a">a</a> and plain text.';
    });
    const { el } = mountCard(s, "C");
    const link = el.querySelector("a")!;
    const ctx = (s as unknown as { lastCtx: { openLink: ReturnType<typeof vi.fn> } }).lastCtx;
    // The view pans with the middle button anywhere but on a link in a card.
    expect(isPanPress({ button: 1, target: link }, false)).toBe(false);
    expect(isPanPress({ button: 1, target: el.querySelector(".lf-card-content")! }, false)).toBe(true);
    expect(isPanPress({ button: 0, target: link }, true)).toBe(true);
    expect(isPanPress({ button: 0, target: link }, false)).toBe(false);
    // The press is not taken by the stage either, so the auxclick that follows reaches the link: one new tab.
    const card = nodeWorldRect(s.store.doc, s.node("C"));
    s.fire("pointerdown", { pointerId: 1, isPrimary: true, button: 1, shiftKey: false, altKey: false, clientX: card.x + 5, clientY: card.y + 5, target: link, preventDefault: vi.fn() });
    s.fire("pointerup", { pointerId: 1, isPrimary: true, button: 1, clientX: card.x + 5, clientY: card.y + 5, target: link });
    link.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(ctx.openLink).toHaveBeenCalledTimes(1);
    expect(ctx.openLink).toHaveBeenCalledWith("Notes/a", expect.anything(), "tab");
    expect(s.view.selection.ids).toEqual([]);
  });

  test("a press on a link that travels past the click threshold moves the card like any press on it; one that stays is the link's click", async () => {
    const s = setup();
    render.mockImplementationOnce(async (_app, _markdown, el) => {
      el.innerHTML = 'See <a class="internal-link" data-href="Notes/a">a</a>.';
    });
    const { el } = mountCard(s, "C");
    const link = el.querySelector("a")!;
    const start = nodeWorldRect(s.store.doc, s.node("C"));
    const at = { x: start.x + 5, y: start.y + 5 };
    const ev = (x: number, y: number) => ({ pointerId: 1, isPrimary: true, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, clientX: x, clientY: y, target: link, preventDefault: vi.fn() });
    // Within the threshold: nothing selected, nothing moved, no pointer capture (the click is the link's).
    s.fire("pointerdown", ev(at.x, at.y));
    // The press is the controller's while it waits: its mousedown is no native drag of the link (nor a text selection).
    const mousedown = { button: 0, preventDefault: vi.fn() };
    s.fire("mousedown", mousedown);
    expect(mousedown.preventDefault).toHaveBeenCalled();
    s.fire("pointermove", ev(at.x + 1, at.y + 1));
    s.fire("pointerup", ev(at.x + 1, at.y + 1));
    await s.settled();
    expect(s.view.selection.ids).toEqual([]);
    expect(nodeWorldRect(s.store.doc, s.node("C"))).toEqual(start);
    expect(s.labels).toEqual([]);
    // Past it: the card is selected and moves with the pointer, one undo step, and no marquee.
    s.fire("pointerdown", ev(at.x, at.y));
    s.fire("pointermove", ev(at.x + 40, at.y + 30));
    s.fire("pointermove", ev(at.x + 80, at.y + 60));
    s.fire("pointerup", ev(at.x + 80, at.y + 60));
    await s.settled();
    expect(s.view.selection.ids).toEqual(["C"]);
    const moved = nodeWorldRect(s.store.doc, s.node("C"));
    expect(moved.x).toBeCloseTo(start.x + 80, 1);
    expect(moved.y).toBeCloseTo(start.y + 60, 1);
    expect(s.labels.every((l) => l === "node.move")).toBe(true);
    // One undo step puts it back.
    s.store.undo();
    expect(nodeWorldRect(s.store.doc, s.node("C"))).toEqual(start);
  });

  test("a link press let go outside the stage does not stay pending: a later hover, with no button held, drags nothing", async () => {
    const s = setup();
    render.mockImplementationOnce(async (_app, _markdown, el) => {
      el.innerHTML = 'See <a class="internal-link" data-href="Notes/a">a</a>.';
    });
    const { el } = mountCard(s, "C");
    const link = el.querySelector("a")!;
    const start = nodeWorldRect(s.store.doc, s.node("C"));
    const at = { x: start.x + 5, y: start.y + 5 };
    const ev = (x: number, y: number, buttons: number) => ({ pointerId: 1, isPrimary: true, button: 0, buttons, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, clientX: x, clientY: y, target: link, preventDefault: vi.fn() });
    // Released outside the stage (no pointerup reaches it), then hovering back with no button: not a drag.
    s.fire("pointerdown", ev(at.x, at.y, 1));
    s.fire("pointermove", ev(at.x + 80, at.y + 60, 0));
    await s.settled();
    expect(s.view.selection.ids).toEqual([]);
    expect(nodeWorldRect(s.store.doc, s.node("C"))).toEqual(start);
    // Leaving the stage with the press pending ends it too: coming back with the button up moves nothing.
    s.fire("pointerdown", ev(at.x, at.y, 1));
    s.fire("pointerleave", ev(at.x, at.y, 1));
    s.fire("pointermove", ev(at.x + 80, at.y + 60, 1));
    await s.settled();
    expect(s.view.selection.ids).toEqual([]);
    expect(nodeWorldRect(s.store.doc, s.node("C"))).toEqual(start);
    expect(s.labels).toEqual([]);
  });

  test("the embed's open icon takes its own press: the stage does not select the card", () => {
    const s = setup();
    render.mockImplementationOnce(async (_app, _markdown, el) => {
      el.innerHTML = '<div class="markdown-embed"><div class="markdown-embed-link"><svg></svg></div>Text</div>';
    });
    const { el } = mountCard(s, "C");
    const icon = el.querySelector(".markdown-embed-link svg")!;
    const card = nodeWorldRect(s.store.doc, s.node("C"));
    s.fire("pointerdown", { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, clientX: card.x + 5, clientY: card.y + 5, target: icon, preventDefault: vi.fn() });
    s.fire("pointerup", { pointerId: 1, isPrimary: true, button: 0, clientX: card.x + 5, clientY: card.y + 5, target: icon });
    expect(s.view.selection.ids).toEqual([]);
    // Elsewhere on the embed, a press selects the card as before.
    const text = el.querySelector(".markdown-embed")!;
    s.fire("pointerdown", { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, clientX: card.x + 5, clientY: card.y + 5, target: text, preventDefault: vi.fn() });
    s.fire("pointerup", { pointerId: 1, isPrimary: true, button: 0, clientX: card.x + 5, clientY: card.y + 5, target: text });
    expect(s.view.selection.ids).toEqual(["C"]);
  });

  test("Open source opens the first link; it is disabled with none", async () => {
    const s = setup();
    await s.call("node.update", { id: "C", patch: { text: "`[[Not this]]` see [[Notes/b#^blk|b]] and ![[Notes/a#Legend]]" } });
    const openLink = vi.fn();
    s.view.openLink = openLink;
    const ctx = (selection: string[]): CommandContext => ({ ...s.view.commandContext(), selection });
    const entry = (selection: string[]) => menuModel(s.r, ctx(selection), "item").groups.flat().find((e) => e.id === "open-source");
    expect(entry(["C"])).toMatchObject({ disabled: false });
    s.r.commands.get("open-source")!.run(ctx(["C"]), undefined as never);
    expect(openLink).toHaveBeenCalledWith("Notes/b#^blk", "tab");
    await s.call("node.update", { id: "C", patch: { text: "No link, `[[only code]]`" } });
    expect(entry(["C"])).toMatchObject({ disabled: true });
  });
});

describe("a card follows the files it links and embeds", () => {
  test("a text card, and a note card's section, are drawn again when a note they link or embed (or one embedded in it) changes", async () => {
    const s = setup();
    await s.call("node.update", { id: "C", patch: { text: "Fig ![[Notes/a#Legend]], [[Notes/c|c]], `[[Notes/d]]` and [[Nope]]" } });
    const hosts = new Map(s.store.doc.pages.map((p) => [p.id, document.createElement("div")]));
    const access = new FakeAccess({
      files: { "Notes/a.md": "# A\n## Legend\nBody ![[Notes/b]]", "Notes/b.md": "Nested", "Notes/c.md": "C", "Notes/d.md": "D" },
      headings: { "Notes/a.md": { Legend: { start: 4, end: null } } },
      embeds: { "Notes/a.md": [{ link: "Notes/b", offset: 19 }] },
    });
    const view: any = {
      app: {},
      file: { path: "fig.lnkfig.md" },
      store: s.store,
      resolvedCache: new Map<string, Resolved>(),
      index: new InvalidationIndex(),
      plugin: { access, decoders: {}, registries: { ...s.r, adjustments: { get: () => undefined } } },
      openLink: vi.fn(),
      samplesLanded: vi.fn(),
      addChild: vi.fn(),
      removeChild: vi.fn(),
    };
    const nodeHost = new NodeHost(view, { nodesHost: (id: string) => hosts.get(id)! } as never, s.r);
    nodeHost.renderAll(s.store.doc);
    await nodeHost.resolveStale();
    // What each card's drawing reads: its links and embeds (not those in code), and what an embedded note embeds.
    expect(view.index.nodesFor("Notes/a.md").sort()).toEqual(["C", "N"]);
    expect(view.index.nodesFor("Notes/b.md").sort()).toEqual(["C", "N"]);
    expect(view.index.nodesFor("Notes/c.md")).toEqual(["C"]);
    expect(view.index.nodesFor("Notes/d.md")).toEqual([]);
    // A link that finds no file yet may be mended by a file that appears: the card is looked at again only once one of
    // its links finds a file it did not find before, not on every file made in the vault.
    expect(nodeHost.unresolvedLinkers()).toEqual([]);
    access["vault"].files["Elsewhere.md"] = "unrelated";
    expect(nodeHost.unresolvedLinkers()).toEqual([]);
    access["vault"].files["Nope.md"] = "now here";
    expect(nodeHost.unresolvedLinkers()).toEqual(["C"]);
    delete access["vault"].files["Nope.md"];

    // A move (every frame of a drag) changes nothing the card reads: its links are not listed again.
    const listed = vi.spyOn(cardNodeType, "linkedPaths");
    try {
      await s.call("node.move", { ids: ["C"], dx: 5, dy: 0 });
      nodeHost.applyChange(s.store.doc, new Set(["C"]));
      expect(listed).not.toHaveBeenCalled();
      await s.call("node.update", { id: "C", patch: { text: "Fig ![[Notes/a#Legend]], [[Notes/c|c]], `[[Notes/d]]` and [[Nope]] edited" } });
      nodeHost.applyChange(s.store.doc, new Set(["C"]));
      expect(listed).toHaveBeenCalledTimes(1);
    } finally {
      listed.mockRestore();
    }

    // The watcher says a note changed: the text card is drawn again (its embeds rendered afresh)...
    render.mockClear();
    await nodeHost.invalidate(["C"]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenLastCalledWith({}, "Fig ![[Notes/a#Legend]], [[Notes/c|c]], `[[Notes/d]]` and [[Nope]] edited", expect.anything(), "fig.lnkfig.md", expect.anything());
    // ...and the note card's section is read again and drawn from what it says now.
    access["vault"].files["Notes/a.md"] = "# A\n## Legend\nNew body";
    render.mockClear();
    await nodeHost.invalidate(["N"]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenLastCalledWith({}, "## Legend\nNew body", expect.anything(), "Notes/a.md", expect.anything());
    // Its section no longer embeds Notes/b, so it no longer follows it.
    expect(view.index.nodesFor("Notes/b.md")).toEqual(["C"]);
  });
});

describe("note cards", () => {
  test("a note card shows Open source in its menu", () => {
    const s = setup();
    const ctx = (selection: string[]): CommandContext => ({ ...s.view.commandContext(), selection });
    const entry = (selection: string[]) => menuModel(s.r, ctx(selection), "item").groups.flat().find((e) => e.id === "open-source");
    expect(entry(["N"])).toMatchObject({ disabled: false });
    expect(entry(["C"])).toMatchObject({ disabled: true });
  });

  test("a note card's link is resolved as a content panel's is", async () => {
    const s = setup();
    const hosts = new Map(s.store.doc.pages.map((p) => [p.id, document.createElement("div")]));
    const access = new FakeAccess({ files: { "Notes/a.md": "# A\n## Legend\nBody" }, headings: { "Notes/a.md": { Legend: { start: 4, end: null } } } });
    const view: any = {
      app: {},
      file: { path: "fig.lnkfig.md" },
      store: s.store,
      resolvedCache: new Map<string, Resolved>(),
      index: new InvalidationIndex(),
      plugin: { access, decoders: {}, registries: { ...s.r, adjustments: { get: () => undefined } } },
      openLink: vi.fn(),
      samplesLanded: vi.fn(),
      addChild: vi.fn(),
      removeChild: vi.fn(),
    };
    const nodeHost = new NodeHost(view, { nodesHost: (id: string) => hosts.get(id)! } as never, s.r);
    nodeHost.renderAll(s.store.doc);
    await nodeHost.resolveStale();
    expect(view.resolvedCache.get("N")).toMatchObject({ kind: "content", markdown: "## Legend\nBody" });
    expect(view.resolvedCache.has("C")).toBe(false);
    expect(render).toHaveBeenLastCalledWith({}, "## Legend\nBody", expect.anything(), "Notes/a.md", expect.anything());
  });
});
