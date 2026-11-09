import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { createRegistries } from "../../src/registry";
import { createDocument, createPage, fileNodeDefaults, groupNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { DocumentStore } from "../../src/model/store";
import type { Document, Node, NodeId, PageId } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import type { CommandContext, MenuPlace, UndoStep } from "../../src/registry/command";
import { SelectionState } from "../../src/view/selection";
import { pageWorldRect, Viewport } from "../../src/view/viewport";
import { runCommandWith } from "./command-runner";

/** Every Obsidian `Menu` made, recording what was put in it and where it was shown. */
const menus: FakeMenu[] = [];
class FakeMenuItem {
  title = "";
  icon: string | null = null;
  disabled = false;
  click: (() => void) | null = null;
  setTitle(t: string) { this.title = t; return this; }
  setIcon(i: string | null) { this.icon = i; return this; }
  setDisabled(d: boolean) { this.disabled = d; return this; }
  onClick(fn: () => void) { this.click = fn; return this; }
}
class FakeMenu {
  entries: (FakeMenuItem | "|")[] = [];
  shownAt: { x: number; y: number } | null = null;
  private hideHandler: (() => void) | null = null;
  constructor() { menus.push(this); }
  addItem(fn: (item: FakeMenuItem) => void) { const item = new FakeMenuItem(); fn(item); this.entries.push(item); return this; }
  addSeparator() { this.entries.push("|"); return this; }
  onHide(fn: () => void) { this.hideHandler = fn; return this; }
  /** What the Menu does on Escape or an outside click. */
  hide() { this.hideHandler?.(); }
  showAtPosition(at: { x: number; y: number }) { this.shownAt = at; return this; }
  /** The titles, `|` for a separator, `(title)` for a disabled entry. */
  get titles(): string[] { return this.entries.map((e) => (e === "|" ? "|" : e.disabled ? `(${e.title})` : e.title)); }
  item(title: string): FakeMenuItem { return this.entries.find((e): e is FakeMenuItem => e !== "|" && e.title === title)!; }
}
const platform = vi.hoisted(() => ({ isMacOS: false }));
vi.mock("obsidian", () => ({ Menu: FakeMenu, Platform: platform }));

const { showContextMenu } = await import("../../src/view/context-menu");
const { PointerController } = await import("../../src/view/pointer");

class FakeStage {
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  addEventListener(type: string, fn: (ev: any) => void, options?: { signal?: AbortSignal }): void {
    const entry = (ev: any) => fn(ev);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), entry]);
    options?.signal?.addEventListener("abort", () => this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== entry)));
  }
  fire(type: string, ev: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  setPointerCapture = () => {};
  hasPointerCapture = () => false;
  releasePointerCapture = () => {};
  focus = () => {};
}

class FakeBox {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeBox[] = [];
  parentElement: FakeBox | null = null;
  readonly ownerDocument = { createElement: () => new FakeBox() };
  appendChild(child: FakeBox): void {
    child.parentElement = this;
    this.children.push(child);
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  replaceChildren(...children: FakeBox[]): void {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
}

const file = (doc: Document, partial: Partial<Node>): void => {
  doc.nodes.push({ ...fileNodeDefaults(doc.pages[0], { file: "a.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), width: 100, height: 40, ...partial } as Node);
};

/** g = {a, b}; x on its own. a (10, 20)–(110, 60), b (150, 20)–(250, 60), x (300, 300)–(350, 350). */
function build(d: Document): void {
  file(d, { id: "a", x: 10, y: 20, z: 0, parent: "g" });
  file(d, { id: "b", x: 150, y: 20, z: 1, parent: "g" });
  d.nodes.push({ ...groupNodeDefaults(d.pages[0], { id: "g" }, []) } as Node);
  file(d, { id: "x", x: 300, y: 300, width: 50, height: 50, z: 2 });
}

function setup() {
  menus.length = 0;
  const doc = createDocument("a4-portrait");
  build(doc);
  const overlay = new FakeBox();
  // In the order the plugin registers them.
  const registries = createRegistries();
  registries.nodeTypes.register(groupNodeType);
  registerBuiltinCommands({ registries, addCommand: () => undefined, activeFigureView: () => null } as never);
  for (const c of [...drawingCommands(), ...groupCommands()]) registries.commands.register(c);
  const ran: string[] = [];
  let disarmed = 0;
  /** Each menu the view was asked to open: where, at which client point, for which page, and what was selected then. */
  const opened: { where: MenuPlace; at: { x: number; y: number } | null; page: PageId | null; selection: NodeId[] }[] = [];
  const view = {
    store: undefined as unknown as DocumentStore,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    contextMenuOpen: false,
    enteredGroup: null as NodeId | null,
    plugin: { registries },
    viewOption: () => undefined,
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    clientPointOf: (world: { x: number; y: number }) => view.viewport.toScreen(world),
    armedTool: null as object | null,
    disarmTool: () => {
      view.armedTool = null;
      disarmed++;
    },
    nodeHost: { elementFor: () => ({ dispatchEvent: vi.fn() }) },
    index: { untrack: vi.fn() },
    pageLayer: { overlayHost: () => overlay },
    commandContext: (): CommandContext => ({ app: {} as never, registries, view: view as never, store: view.store, selection: [...view.selection.ids], page: view.store.doc.pages[0] }),
    runCommandById: (id: string, args?: Record<string, unknown>, step?: UndoStep) => {
      ran.push(id);
      // Without arguments, as the real view runs a toolbar button's command: on the current context, if it applies.
      if (args === undefined) {
        const command = registries.commands.get(id);
        const ctx = view.commandContext();
        if (command?.applies(ctx)) void command.run(ctx);
      } else run(id, args, step);
    },
    openContextMenu(where: MenuPlace, at: { x: number; y: number } | null, page: PageId | null) {
      opened.push({ where, at, page, selection: [...view.selection.ids] });
      showContextMenu(view as never, where, at ?? { x: 0, y: 0 });
    },
  };
  const run = runCommandWith(registries, view);
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  view.store = createFigureStore(doc, registries, () => controller.commitTime());
  controller.attach(stage as never);
  let prevented = 0;
  let stopped = 0;
  let stoppedImmediate = 0;
  const ev = (extra: object = {}) => ({ pointerId: 1, isPrimary: true, button: 0, shiftKey: false, target: {}, preventDefault: () => void prevented++, stopPropagation: () => void stopped++, stopImmediatePropagation: () => void stoppedImmediate++, ...extra });
  const pointer = (type: string, x: number, y: number, extra: object = {}) => stage.fire(type, ev({ clientX: x, clientY: y, ...extra }));
  /** A right-click as the browser sends it: the press and release of the right button, then the contextmenu event. */
  const rightClick = (x: number, y: number, extra: object = {}) => {
    pointer("pointerdown", x, y, { button: 2, ...extra });
    pointer("pointerup", x, y, { button: 2, ...extra });
    pointer("contextmenu", x, y, { button: 2, ...extra });
  };
  const key = (name: string, extra: object = {}) =>
    stage.fire("keydown", { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: {}, preventDefault: () => void prevented++, ...extra });
  return { view, controller, opened, ran, disarmed: () => disarmed, pointer, rightClick, key, prevented: () => prevented, stopped: () => stopped, stoppedImmediate: () => stoppedImmediate, nodeOf: (id: string) => view.store.doc.nodes.find((n) => n.id === id)! };
}

const ON_A: [number, number] = [50, 30];
const ON_B: [number, number] = [200, 30];
const ON_X: [number, number] = [320, 320];
const PAPER: [number, number] = [400, 600];
const CANVAS: [number, number] = [-200, -200];

describe("showContextMenu", () => {
  test("lists the model's entries with a separator between groups, shows it at the point, and each entry runs its command", () => {
    const { view, ran } = setup();
    view.selection.set(["x"]);
    const menu = showContextMenu(view as never, "item", { x: 5, y: 6 }) as unknown as FakeMenu;
    expect(menu.shownAt).toEqual({ x: 5, y: 6 });
    expect(menu.titles.slice(0, 6)).toEqual(["Delete", "Duplicate", "Open source", "Lock", "(Unlock)", "|"]);
    expect(menu.item("Lock").icon).toBe("lock");
    menu.item("Lock").click?.();
    expect(ran).toEqual(["lock"]);
  });

  test("a menu that hid does not clear the flag while a second menu is open", () => {
    vi.useFakeTimers();
    try {
      const { view } = setup();
      view.selection.set(["x"]);
      const first = showContextMenu(view as never, "item", { x: 0, y: 0 }) as unknown as FakeMenu;
      first.hide();
      const second = showContextMenu(view as never, "item", { x: 0, y: 0 }) as unknown as FakeMenu;
      vi.runAllTimers();
      expect(view.contextMenuOpen).toBe(true);
      second.hide();
      vi.runAllTimers();
      expect(view.contextMenuOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a menu with nothing in it is not shown", () => {
    const { view } = setup();
    const empty = { ...view, plugin: { registries: createRegistries() } };
    expect(showContextMenu(empty as never, "canvas", { x: 0, y: 0 })).toBeNull();
    expect(menus.every((m) => m.shownAt === null)).toBe(true);
  });
});

describe("a right-click on the stage", () => {
  test("over an item selects its unit, and opens the item menu there; the browser's own menu is suppressed", () => {
    const { view, opened, rightClick, prevented } = setup();
    rightClick(...ON_A);
    expect(view.selection.ids).toEqual(["g"]);
    expect(opened).toEqual([{ where: "item", at: { x: 50, y: 30 }, page: null, selection: ["g"] }]);
    expect(menus[0].shownAt).toEqual({ x: 50, y: 30 });
    expect(menus[0].titles).toContain("Ungroup");
    expect(prevented()).toBeGreaterThan(0);
  });

  test("over an item that is already selected keeps the whole selection", () => {
    const { view, opened, rightClick } = setup();
    view.selection.set(["g", "x"]);
    rightClick(...ON_X);
    expect(view.selection.ids).toEqual(["g", "x"]);
    expect(opened[0]).toMatchObject({ where: "item", selection: ["g", "x"] });
  });

  test("over an item that is not selected selects it alone", () => {
    const { view, rightClick } = setup();
    view.selection.set(["g"]);
    rightClick(...ON_X);
    expect(view.selection.ids).toEqual(["x"]);
  });

  test("over a member of the entered group selects that member, as a click does", () => {
    const { view, rightClick } = setup();
    view.enteredGroup = "g";
    view.selection.set(["a"]);
    rightClick(...ON_B);
    expect(view.selection.ids).toEqual(["b"]);
    expect(view.enteredGroup).toBe("g");
  });

  test("over an item outside the entered group leaves the group", () => {
    const { view, rightClick } = setup();
    view.enteredGroup = "g";
    view.selection.set(["a"]);
    rightClick(...ON_X);
    expect(view.enteredGroup).toBeNull();
    expect(view.selection.ids).toEqual(["x"]);
  });

  test("over paper clears the selection and opens the page menu for that page", () => {
    const { view, opened, rightClick } = setup();
    view.selection.set(["x"]);
    rightClick(...PAPER);
    expect(view.selection.ids).toEqual([]);
    expect(opened).toEqual([{ where: "page", at: { x: 400, y: 600 }, page: view.store.doc.pages[0].id, selection: [] }]);
    expect(menus[0].titles).toEqual(["Text", "Rectangle", "Ellipse", "Connector", "|", "Add page", "(Delete page)", "|", "Fit page", "|", "Export"]);
  });

  test("over paper of a second page names that page", () => {
    const { view, opened, rightClick } = setup();
    view.store.commit("add", (d) => void d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id))));
    const second = view.store.doc.pages[1];
    const paper = pageWorldRect(view.store.doc, second);
    rightClick(paper.x + 20, paper.y + 20);
    expect(opened[0]).toMatchObject({ where: "page", page: second.id });
  });

  test("over the canvas outside the pages opens the view menu", () => {
    const { view, opened, rightClick } = setup();
    view.selection.set(["x"]);
    rightClick(...CANVAS);
    expect(opened[0]).toMatchObject({ where: "canvas", page: null });
    expect(menus[0].titles).toEqual(["Add page", "|", "Fit page", "Zoom to 100%", "|", "Export"]);
  });

  test("does not start a drag or a marquee: the right button's press and moves change nothing", () => {
    const { view, pointer, nodeOf } = setup();
    pointer("pointerdown", ...ON_X, { button: 2 });
    pointer("pointermove", 400, 400, { button: 2 });
    pointer("pointerup", 400, 400, { button: 2 });
    expect(nodeOf("x")).toMatchObject({ x: 300, y: 300 });
    expect(view.selection.ids).toEqual([]);
  });

  test("on a Mac, a Control-click is a right-click: its left-button press neither selects nor drags", () => {
    platform.isMacOS = true;
    try {
      const { view, opened, pointer, nodeOf } = setup();
      pointer("pointerdown", ...ON_X, { ctrlKey: true });
      pointer("pointermove", 400, 400, { ctrlKey: true });
      pointer("contextmenu", ...ON_X, { ctrlKey: true });
      pointer("pointerup", 400, 400, { ctrlKey: true });
      expect(nodeOf("x")).toMatchObject({ x: 300, y: 300 });
      // The menu still selects what it was opened on.
      expect(opened[0]).toMatchObject({ where: "item", selection: ["x"] });
      expect(view.selection.ids).toEqual(["x"]);
    } finally {
      platform.isMacOS = false;
    }
  });

  test("disarms an armed tool before opening the menu, and the menu opens", () => {
    const { view, opened, disarmed, rightClick } = setup();
    view.armedTool = { id: "text" };
    rightClick(...ON_X);
    expect(disarmed()).toBe(1);
    expect(view.armedTool).toBeNull();
    expect(opened).toHaveLength(1);
  });

  test("in text being edited is left to the browser: no menu, and its own menu is not suppressed", () => {
    const { opened, pointer, prevented } = setup();
    pointer("contextmenu", ...ON_X, { button: 2, target: { isContentEditable: true, tagName: "DIV" } });
    expect(opened).toEqual([]);
    expect(prevented()).toBe(0);
  });

  test("during a crop session is ignored: no menu, the selection stays, and the browser's menu is suppressed", () => {
    const { view, controller, opened, rightClick, prevented } = setup();
    vi.spyOn(controller.cropSession, "active", "get").mockReturnValue(true);
    view.selection.set(["a"]);
    rightClick(...ON_X);
    expect(opened).toEqual([]);
    expect(view.selection.ids).toEqual(["a"]);
    expect(prevented()).toBeGreaterThan(0);
  });

  test("in a read-only view does nothing", () => {
    const { view, opened, rightClick } = setup();
    view.readOnly = true;
    rightClick(...ON_X);
    expect(opened).toEqual([]);
  });

  test("a menu entry runs its command on what the right-click selected", () => {
    const { rightClick, nodeOf } = setup();
    rightClick(...ON_X);
    menus[0].item("Lock").click?.();
    expect(nodeOf("x").locked).toBe(true);
  });
});

describe("the keyboard", () => {
  test("the Menu key opens the item menu at the centre of the selection", () => {
    const { view, opened, key, prevented } = setup();
    view.selection.set(["x"]);
    key("ContextMenu");
    expect(opened).toEqual([{ where: "item", at: { x: 325, y: 325 }, page: null, selection: ["x"] }]);
    expect(prevented()).toBe(1);
  });

  test("Shift+F10 opens the page menu when nothing is selected", () => {
    const { opened, key } = setup();
    key("F10", { shiftKey: true });
    expect(opened).toEqual([{ where: "page", at: null, page: null, selection: [] }]);
  });

  test("F10 without Shift does nothing", () => {
    const { opened, key } = setup();
    key("F10");
    expect(opened).toEqual([]);
  });

  test("the contextmenu event the Menu key sends after it does not open a second menu", () => {
    const { view, opened, key, pointer } = setup();
    view.selection.set(["x"]);
    key("ContextMenu");
    pointer("contextmenu", 0, 0, { button: 0 });
    expect(opened).toHaveLength(1);
  });

  test("the echo is swallowed without reaching the window, where the Menu hides on any contextmenu", () => {
    const { view, key, pointer, stopped, stoppedImmediate } = setup();
    view.selection.set(["x"]);
    key("ContextMenu");
    pointer("contextmenu", 0, 0, { button: 0 });
    expect(stopped()).toBe(1);
    expect(stoppedImmediate()).toBe(1);
  });

  test("Escape with a menu open leaves the selection alone, also for the keydown that closed it", () => {
    vi.useFakeTimers();
    try {
      const { view, key } = setup();
      view.selection.set(["x"]);
      key("ContextMenu");
      expect(view.contextMenuOpen).toBe(true);
      key("Escape");
      expect(view.selection.ids).toEqual(["x"]);
      // The Menu hides on that same keydown, before the stage sees it.
      menus[menus.length - 1].hide();
      key("Escape");
      expect(view.selection.ids).toEqual(["x"]);
      vi.runAllTimers();
      expect(view.contextMenuOpen).toBe(false);
      key("Escape");
      expect(view.selection.ids).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the echo is swallowed once: a real right-click right after it opens its own menu", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { view, opened, key, pointer, rightClick } = setup();
      view.selection.set(["x"]);
      key("ContextMenu");
      pointer("contextmenu", 0, 0, { button: 0 });
      expect(opened).toHaveLength(1);
      rightClick(...ON_A);
      expect(opened).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a contextmenu event 400 ms after the Menu key is not its echo", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { view, opened, key, pointer } = setup();
      view.selection.set(["x"]);
      key("ContextMenu");
      vi.advanceTimersByTime(400);
      pointer("contextmenu", ...ON_A, { button: 2 });
      expect(opened).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("not while typing into text", () => {
    const { opened, key } = setup();
    key("ContextMenu", { target: { isContentEditable: true, tagName: "DIV" } });
    expect(opened).toEqual([]);
  });
});
