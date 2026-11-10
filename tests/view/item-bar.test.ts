// @vitest-environment happy-dom
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { cardCommands } from "../../src/commands/cards";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { isAssociation } from "../../src/model/attach";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { nodeWorldRect } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import type { CardNode, ConnectorNode, Document } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import type { Command, CommandContext, UndoStep } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";

vi.mock("obsidian", () => ({
  Menu: class {},
  Component: class {
    addChild() {}
    removeChild() {}
  },
  MarkdownRenderer: { render: async (_app: unknown, markdown: string, el: HTMLElement) => void (el.textContent = markdown) },
  Keymap: { isModEvent: () => false },
  Notice: class {},
  Platform: { isMacOS: false },
  normalizePath: (p: string) => p,
  setIcon: () => {},
  // For the figure view's module, whose `runCommand` the fake view runs.
  TextFileView: class {},
  TFile: class {},
  Modal: class {},
  Setting: class {},
  PluginSettingTab: class {},
}));

const { PointerController } = await import("../../src/view/pointer");
const { SelectionState } = await import("../../src/view/selection");
const { Viewport } = await import("../../src/view/viewport");
const { ItemBar, wireItemBar } = await import("../../src/view/item-bar");
const { LinkFiguresView } = await import("../../src/view/figure-view");

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

function registries(extra: Command[] = []): Registries {
  const r = createRegistries();
  for (const t of [shapeNodeType, connectorNodeType, cardNodeType, groupNodeType]) r.nodeTypes.register(t);
  for (const kind of builtinShapeKinds) r.shapes.register(kind);
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  for (const paint of builtinPaintTypes) r.paints.register(paint);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  for (const command of [...drawingCommands(), ...cardCommands(), ...groupCommands(), ...extra]) r.commands.register(command);
  return r;
}

/** Pages "Figure 1" (pg-1) and "Figure 2" (pg-2); shape A on pg-1; text card C and note card N beside it, D below. */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  doc.pages[0].id = "pg-1";
  doc.pages[1].id = "pg-2";
  doc.pages[0].name = "Figure 1";
  doc.pages[1].name = "Figure 2";
  const page = doc.pages[0];
  doc.nodes.push(shapeNodeDefaults(page, { id: "A", kind: "rect", x: 50, y: 50, width: 100, height: 80, z: 0 }, []));
  doc.nodes.push({ ...cardNodeDefaults(page, -400, 100, ["A"]), id: "C", text: "See [[Notes/a]]" });
  const note: CardNode = { ...cardNodeDefaults(page, -400, 400, ["A", "C"]), id: "N", file: "Notes/a", subpath: "#Legend" };
  delete note.text;
  doc.nodes.push(note);
  doc.nodes.push({ ...cardNodeDefaults(page, -400, 700, ["A", "C", "N"]), id: "D", text: "Plain" });
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

/** The figure view's methods that run commands, called on the fake view below. */
const real = LinkFiguresView.prototype as unknown as {
  runCommandById(this: unknown, id: string, args?: Record<string, unknown>, step?: UndoStep): void;
  runCommand(this: unknown, command: Command): void;
  attempt(this: unknown, command: Command, action: () => unknown): void;
};

function setup(extra: Command[] = []) {
  const r = registries(extra);
  let controller: { commitTime(): number } | null = null;
  const store = createFigureStore(figure(), r, () => controller?.commitTime() ?? Date.now());
  const pending: Promise<unknown>[] = [];
  const elements = new Map<string, HTMLElement>();
  const view: any = {
    app: {},
    file: { path: "fig.lnkfig.md" },
    store,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    enteredGroup: null,
    plugin: { registries: r },
    viewOption: () => undefined,
    pageLimitMm: () => 2000,
    notePageLimit: () => {},
    setViewOption: () => {},
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: (id: string) => elements.get(id) },
    pageLayer: { overlayHost: () => { throw new Error("no overlay"); } },
    armedTool: null,
    selectedIds: () => [...view.selection.ids],
    setSelection: (ids: string[]) => view.selection.set(ids),
    currentPage: () => store.doc.pages[0],
    activateNode: vi.fn(),
    addChild: vi.fn(),
    removeChild: vi.fn(),
    commandContext: (): CommandContext => ({ app: {} as never, registries: r, view, store, selection: view.selectedIds(), page: store.doc.pages[0] }),
    // The figure view's own `runCommandById` and `runCommand`, gates and all (read-only runs only `readOnlySafe`
    // commands); its `attempt` too, with what it runs recorded so that a test can wait for it and see a failure.
    runCommandById: vi.fn((id: string, args?: Record<string, unknown>, step?: UndoStep) => real.runCommandById.call(view, id, args, step)),
    runCommand: real.runCommand,
    attempt: (command: Command, action: () => unknown) =>
      real.attempt.call(view, command, () => {
        const result = action();
        pending.push(Promise.resolve(result).catch((error) => (view.failures.push(error), null)));
        return result;
      }),
    failures: [] as unknown[],
  };
  const stage = new FakeStage();
  const pointer = new PointerController(view);
  controller = pointer;
  pointer.attach(stage as never);
  view.gestureUnderWay = () => pointer.busy();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const bar = new ItemBar(host);
  // As the figure view does: the bar is brought in line on every change of the store, the selection and the gesture.
  // The same wiring the figure view uses: a pan or zoom (`viewportApplied`), a card's edit (`EDITING_EVENT` on the
  // stage) and a gesture's start and end (the pointer controller) each bring the bar in line.
  const wiring = wireItemBar(view, bar, { stage: host, gestures: pointer });
  view.applyViewport = () => wiring.viewportApplied();
  const sync = () => wiring.sync();
  // As the figure view's `renderChrome` does, on every change of the store and the selection.
  store.subscribe(sync);
  view.selection.onChange(sync);
  const fire = (type: string, [clientX, clientY]: [number, number]) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, clientX, clientY, target: {}, preventDefault: vi.fn() });
  const settled = () => Promise.all(pending);
  const select = (ids: string[]) => {
    view.selection.set(ids);
    sync();
  };
  const buttons = () => Array.from(bar.el.querySelectorAll<HTMLButtonElement>("button")).map((b) => b.getAttribute("aria-label"));
  const dropdown = () => bar.el.querySelector<HTMLSelectElement>("select")!;
  const options = () => Array.from(dropdown().options).map((o) => o.textContent);
  const chosen = () => dropdown().selectedOptions[0]?.textContent;
  const press = (label: string) => bar.el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  const choose = (label: string) => {
    const select = dropdown();
    const option = Array.from(select.options).find((o) => o.textContent === label)!;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const ties = (card: string) =>
    store.doc.nodes.filter((n): n is ConnectorNode => n.type === "connector" && isAssociation(store.doc, n as ConnectorNode, r) && (n as ConnectorNode).ends.some((e) => e.kind === "attached" && e.node === card));
  const call = (id: string, args: Record<string, unknown>) => runCall(store, view.commandContext(), prepareCall(r, { id, args }));
  return { r, store, view, bar, host, sync, wiring, fire, settled, select, buttons, dropdown, options, chosen, press, choose, ties, call, elements, pointer };
}

describe("the item bar", () => {
  test("the bar shows for one selected card, at the current group level only", async () => {
    const s = setup();
    expect(s.bar.el.hidden).toBe(true);
    s.select(["C"]);
    expect(s.bar.el.hidden).toBe(false);
    expect(s.bar.el.parentElement).toBe(s.host);
    // Not for a shape.
    s.select(["A"]);
    expect(s.bar.el.hidden).toBe(true);
    // A card inside a group that has not been entered: no bar; the group entered, the bar.
    await s.call("group.create", { ids: ["C", "D"] });
    const group = s.store.doc.nodes.find((n) => n.id === "C")!.parent!;
    s.select(["C"]);
    expect(s.bar.el.hidden).toBe(true);
    s.select([group]);
    expect(s.bar.el.hidden).toBe(true);
    s.view.enteredGroup = group;
    s.select(["C"]);
    expect(s.bar.el.hidden).toBe(false);
  });

  test("a read-only view shows the bar with Open source only, and Open source runs there", () => {
    const s = setup();
    s.view.openLink = vi.fn();
    s.view.readOnly = true;
    s.select(["C"]);
    expect(s.bar.el.hidden).toBe(false);
    expect(s.buttons()).toEqual(["Open source"]);
    expect(s.bar.el.querySelector("select")).toBeNull();
    s.press("Open source");
    expect(s.view.runCommandById).toHaveBeenCalledWith("open-source");
    expect(s.view.openLink).toHaveBeenCalledWith("Notes/a", "tab");
    // A card with no link: nothing to show at all.
    s.select(["D"]);
    expect(s.buttons()).toEqual(["Open source"]);
    s.select(["A"]);
    expect(s.bar.el.hidden).toBe(true);
  });

  test("in a read-only view the figure view's runCommandById runs only readOnlySafe commands", async () => {
    const mark = vi.fn();
    const extra: Command = { id: "other.mark", name: "Mark", group: "edit", hidden: true, itemBar: ["card"], applies: () => true, run: mark };
    const s = setup([extra]);
    s.view.openLink = vi.fn();
    s.view.readOnly = true;
    s.select(["C"]);
    const before = JSON.stringify(s.store.doc);
    // Not safe: refused by the view, with or without arguments, whatever a bar or a script asks.
    for (const id of ["delete", "other.mark", "card.convert"]) s.view.runCommandById(id);
    s.view.runCommandById("card.tie", { id: "C", page: "pg-2" });
    s.view.runCommandById("node.update", { id: "C", patch: { text: "x" } });
    await s.settled();
    expect(mark).not.toHaveBeenCalled();
    expect(JSON.stringify(s.store.doc)).toBe(before);
    expect(s.r.commands.get("delete")!.readOnlySafe).toBeFalsy();
    // Safe: Open source runs.
    expect(s.r.commands.get("open-source")!.readOnlySafe).toBe(true);
    s.view.runCommandById("open-source");
    expect(s.view.openLink).toHaveBeenCalledWith("Notes/a", "tab");
    // Writable again, the same calls run.
    s.view.readOnly = false;
    s.view.runCommandById("other.mark");
    expect(mark).toHaveBeenCalledTimes(1);
    s.view.runCommandById("delete");
    await s.settled();
    expect(s.store.doc.nodes.some((n) => n.id === "C")).toBe(false);
  });

  test("the bar is hidden for a multi-selection, during a drag, during a resize and while editing", async () => {
    const s = setup();
    s.select(["C", "D"]);
    expect(s.bar.el.hidden).toBe(true);

    s.select(["C"]);
    const card = nodeWorldRect(s.store.doc, s.store.doc.nodes.find((n) => n.id === "C")!);
    // A drag of the card: hidden while it is under way, back when it ends.
    s.fire("pointerdown", [card.x + 20, card.y + 20]);
    expect(s.bar.el.hidden).toBe(false);
    s.fire("pointermove", [card.x + 60, card.y + 20]);
    expect(s.pointer.busy()).toBe(true);
    expect(s.bar.el.hidden).toBe(true);
    s.fire("pointerup", [card.x + 60, card.y + 20]);
    expect(s.bar.el.hidden).toBe(false);

    // A resize by its east handle.
    const moved = nodeWorldRect(s.store.doc, s.store.doc.nodes.find((n) => n.id === "C")!);
    const handle: [number, number] = [moved.x + moved.width, moved.y + moved.height / 2];
    s.fire("pointerdown", handle);
    s.fire("pointermove", [handle[0] - 40, handle[1]]);
    expect(s.bar.el.hidden).toBe(true);
    s.fire("pointerup", [handle[0] - 40, handle[1]]);
    expect(s.bar.el.hidden).toBe(false);

    // Editing: the card's element says so, and tells the stage.
    const host = document.createElement("div");
    s.host.appendChild(host);
    const component = { ...s.view, runCommandById: s.view.runCommandById };
    const ctx = { app: {}, registries: s.r, figurePath: "fig.lnkfig.md", doc: () => s.store.doc, resolved: () => undefined, openLink: vi.fn(), component };
    const renderer = cardNodeType.mount(s.store.doc.nodes.find((n) => n.id === "C") as CardNode, host, ctx as never);
    const el = host.firstElementChild as HTMLElement;
    s.elements.set("C", el);
    const told = vi.fn();
    s.host.addEventListener("lf-editing", told);
    el.dispatchEvent(new CustomEvent("lf-activate"));
    expect(el.classList.contains("is-editing")).toBe(true);
    expect(told).toHaveBeenCalledTimes(1);
    expect(s.bar.el.hidden).toBe(true);
    el.querySelector("textarea")!.dispatchEvent(new FocusEvent("blur"));
    expect(el.classList.contains("is-editing")).toBe(false);
    expect(told).toHaveBeenCalledTimes(2);
    expect(s.bar.el.hidden).toBe(false);
    renderer.unmount();
  });

  test("the dropdown lists pages by name plus None, and reads 'Several pages' when there are several ties", async () => {
    const s = setup();
    s.select(["C"]);
    expect(s.options()).toEqual(["None", "Figure 1", "Figure 2"]);
    expect(s.chosen()).toBe("None");
    await s.call("card.tie", { id: "C", page: "pg-2" });
    expect(s.chosen()).toBe("Figure 2");
    await s.call("connector.create", { page: "pg-1", from: { kind: "attached", node: "C", snap: "center" }, to: { kind: "page", page: "pg-1" } });
    // connector.create selects the line it drew.
    s.select(["C"]);
    expect(s.bar.el.hidden).toBe(false);
    expect(s.chosen()).toBe("Several pages");
    expect(s.options()).toEqual(["Several pages", "None", "Figure 1", "Figure 2"]);
    expect(s.dropdown().selectedOptions[0].disabled).toBe(true);
    // A rename shows at once.
    await s.call("page.update", { id: "pg-1", patch: { name: "Overview" } });
    expect(s.bar.el.hidden).toBe(false);
    expect(s.options()).toContain("Overview");
  });

  test("choosing a page runs card.tie", async () => {
    const s = setup();
    s.select(["C"]);
    s.choose("Figure 2");
    await s.settled();
    expect(s.view.runCommandById).toHaveBeenCalledWith("card.tie", { id: "C", page: "pg-2" });
    expect(s.ties("C")).toHaveLength(1);
    expect(s.chosen()).toBe("Figure 2");
    // The card stays selected, and the bar stays.
    expect(s.view.selectedIds()).toEqual(["C"]);
    expect(s.bar.el.hidden).toBe(false);
    s.choose("None");
    await s.settled();
    expect(s.view.runCommandById).toHaveBeenLastCalledWith("card.tie", { id: "C", page: null });
    expect(s.ties("C")).toHaveLength(0);
  });

  test("the dropdown is rebuilt after a page is deleted while open", async () => {
    const s = setup();
    s.select(["C"]);
    const select = s.dropdown();
    const stale = Array.from(select.options).find((o) => o.textContent === "Figure 2")!.cloneNode(true) as HTMLOptionElement;
    await s.call("delete-page", { page: "pg-2" });
    expect(s.options()).toEqual(["None", "Figure 1"]);
    // The choice the open dropdown still showed lands after the page went: card.tie refuses, and nothing changes.
    const before = JSON.stringify(s.store.doc);
    const dropdown = s.dropdown();
    dropdown.appendChild(stale);
    dropdown.value = stale.value;
    dropdown.dispatchEvent(new Event("change", { bubbles: true }));
    await s.settled();
    expect(s.view.runCommandById).toHaveBeenLastCalledWith("card.tie", { id: "C", page: "pg-2" });
    expect(s.view.failures).toHaveLength(1);
    expect(String(s.view.failures[0])).toContain('card.tie: there is no page "pg-2"');
    expect(JSON.stringify(s.store.doc)).toBe(before);
    // Rebuilt again from the figure: the stale entry is gone, and what is shown is the card's tie.
    expect(s.options()).toEqual(["None", "Figure 1"]);
    expect(s.chosen()).toBe("None");
  });

  test("a locked card shows only Page and Open source", async () => {
    const s = setup();
    s.select(["C"]);
    expect(s.buttons()).toEqual(["Edit", "Open source", "Delete"]);
    await s.call("node.update", { id: "C", patch: { locked: true } });
    expect(s.bar.el.hidden).toBe(false);
    expect(s.dropdown()).not.toBeNull();
    expect(s.buttons()).toEqual(["Open source"]);
    // Open source is there and disabled when the card holds no link.
    await s.call("node.update", { id: "C", patch: { locked: false } });
    s.select(["D"]);
    expect(s.buttons()).toEqual(["Edit", "Open source", "Delete"]);
    const open = s.bar.el.querySelector<HTMLButtonElement>('button[aria-label="Open source"]')!;
    expect(open.disabled).toBe(true);
    s.press("Delete");
    await s.settled();
    expect(s.store.doc.nodes.some((n) => n.id === "D")).toBe(false);
    expect(s.bar.el.hidden).toBe(true);
  });

  test("Convert to text shows only for 0.4.0 note cards", async () => {
    const s = setup();
    s.select(["C"]);
    expect(s.buttons()).not.toContain("Convert to text");
    s.press("Edit");
    expect(s.view.activateNode).toHaveBeenCalledWith("C");
    s.select(["N"]);
    expect(s.buttons()).toEqual(["Open source", "Delete", "Convert to text"]);
    s.press("Convert to text");
    await s.settled();
    expect(s.view.runCommandById).toHaveBeenCalledWith("card.convert", { id: "N" });
    expect(s.store.doc.nodes.find((n) => n.id === "N")).toMatchObject({ text: "![[Notes/a#Legend]]" });
    expect(s.buttons()).toEqual(["Edit", "Open source", "Delete"]);
  });

  test("the bar keeps its size when zoomed", () => {
    const s = setup();
    s.select(["C"]);
    const card = nodeWorldRect(s.store.doc, s.store.doc.nodes.find((n) => n.id === "C")!);
    const at = (zoom: number) => {
      s.view.viewport.zoom = zoom;
      s.view.viewport.tx = 300;
      s.view.viewport.ty = 400;
      s.sync();
      return { left: parseFloat(s.bar.el.style.left), top: parseFloat(s.bar.el.style.top), transform: s.bar.el.style.transform };
    };
    const one = at(1);
    const two = at(2);
    // Placed at the card's top middle in stage px, which follows the zoom; never scaled itself.
    expect(one.left).toBeCloseTo((card.x + card.width / 2) * 1 + 300, 6);
    expect(two.left).toBeCloseTo((card.x + card.width / 2) * 2 + 300, 6);
    expect(two.top).toBeCloseTo(card.y * 2 + 400, 6);
    expect(two.transform).toBe(one.transform);
    expect(two.transform).not.toMatch(/scale/);
    expect(s.bar.el.closest(".lf-viewport")).toBeNull();
  });

  test("a plugin command with itemBar ['card'] appears", () => {
    const run = vi.fn();
    const extra: Command = { id: "other.mark", name: "Mark", icon: "star", group: "edit", hidden: true, itemBar: ["card"], applies: (ctx) => ctx.selection.length === 1, run };
    const s = setup([extra]);
    s.select(["C"]);
    expect(s.buttons()).toContain("Mark");
    s.press("Mark");
    expect(s.view.runCommandById).toHaveBeenCalledWith("other.mark");
    expect(run).toHaveBeenCalledTimes(1);
    // Not on a shape: it lists cards only.
    s.select(["A"]);
    expect(s.bar.el.hidden).toBe(true);
  });

  test("two ties to the same page read 'Several pages', and choosing that page collapses them", async () => {
    const s = setup();
    await s.call("connector.create", { page: "pg-1", from: { kind: "attached", node: "C", snap: "center" }, to: { kind: "page", page: "pg-2" } });
    await s.call("connector.create", { page: "pg-1", from: { kind: "attached", node: "C", snap: "center" }, to: { kind: "page", page: "pg-2", anchor: "n" } });
    s.select(["C"]);
    expect(s.chosen()).toBe("Several pages");
    s.choose("Figure 2");
    await s.settled();
    expect(s.ties("C")).toHaveLength(1);
    expect(s.chosen()).toBe("Figure 2");
  });

  test("the dropdown follows every change of the document while the card stays selected: a second tie reads 'Several pages' at once", async () => {
    const s = setup();
    s.select(["C"]);
    await s.call("card.tie", { id: "C", page: "pg-1" });
    expect(s.chosen()).toBe("Figure 1");
    // A second tie to the same page, made while the card stays selected (the selection is not touched).
    const first = s.ties("C")[0];
    s.store.commit("add", (d) => void d.nodes.push({ ...first, id: "tie-2", z: first.z + 1 }));
    expect(s.view.selectedIds()).toEqual(["C"]);
    expect(s.ties("C")).toHaveLength(2);
    expect(s.chosen()).toBe("Several pages");
    // And back: one of them deleted, the dropdown reads the page again.
    s.store.commit("delete", (d) => void (d.nodes = d.nodes.filter((n) => n.id !== "tie-2")));
    expect(s.chosen()).toBe("Figure 1");
  });

  test("a hidden bar keeps no stale dropdown: shown again, it reads the figure as it is now", async () => {
    const s = setup();
    s.select(["C"]);
    await s.call("card.tie", { id: "C", page: "pg-1" });
    expect(s.chosen()).toBe("Figure 1");
    // The selection moves on (a line drawn from the card selects the line), and a second tie is made meanwhile.
    s.select(["A"]);
    expect(s.bar.el.hidden).toBe(true);
    const first = s.ties("C")[0];
    s.store.commit("add", (d) => void d.nodes.push({ ...first, id: "tie-2", z: first.z + 1 }));
    expect(s.bar.el.querySelector("select")).toBeNull();
    s.select(["C"]);
    expect(s.chosen()).toBe("Several pages");
  });

  test("on every change of the document the dropdown is set to what the figure says, even when its entries are unchanged", async () => {
    const s = setup();
    s.select(["C"]);
    await s.call("card.tie", { id: "C", page: "pg-1" });
    const select = s.dropdown();
    // Its value left as something the figure does not say (a choice that never ran).
    select.value = "none";
    await s.call("node.move", { ids: ["D"], dx: 10, dy: 0 });
    expect(s.dropdown()).toBe(select);
    expect(s.chosen()).toBe("Figure 1");
  });

  test("the wiring brings the bar in line on a pan, an edit, and the end of a gesture", () => {
    const s = setup();
    s.select(["C"]);
    // A pan: the bar follows at once.
    const left = parseFloat(s.bar.el.style.left);
    s.view.viewport.tx += 100;
    s.view.applyViewport();
    expect(parseFloat(s.bar.el.style.left)).toBeCloseTo(left + 100, 6);
    // An edit begins and ends (nothing committed): the stage hears of it.
    const el = document.createElement("div");
    s.host.appendChild(el);
    s.elements.set("C", el);
    el.classList.add("is-editing");
    el.dispatchEvent(new CustomEvent("lf-editing", { bubbles: true }));
    expect(s.bar.el.hidden).toBe(true);
    el.classList.remove("is-editing");
    el.dispatchEvent(new CustomEvent("lf-editing", { bubbles: true }));
    expect(s.bar.el.hidden).toBe(false);
    // A drag of the card: its moves commit (and hide the bar); its end commits nothing, and only the gesture's end
    // brings the bar back.
    const card = nodeWorldRect(s.store.doc, s.store.doc.nodes.find((n) => n.id === "C")!);
    // Stage px, after the pan.
    const at = s.view.viewport.toScreen({ x: card.x + 20, y: card.y + 20 });
    s.fire("pointerdown", [at.x, at.y]);
    s.fire("pointermove", [at.x + 40, at.y]);
    expect(s.bar.el.hidden).toBe(true);
    s.fire("pointerup", [at.x + 40, at.y]);
    expect(s.bar.el.hidden).toBe(false);
    s.wiring.detach();
  });

  test("the bar is kept inside the stage: left and right by half its width, and at the bottom when below the card", () => {
    const s = setup();
    Object.defineProperty(s.host, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(s.host, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(s.bar.el, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(s.bar.el, "offsetHeight", { configurable: true, value: 30 });
    s.select(["C"]);
    const card = nodeWorldRect(s.store.doc, s.store.doc.nodes.find((n) => n.id === "C")!);
    const place = (tx: number, ty: number) => {
      s.view.viewport.tx = tx;
      s.view.viewport.ty = ty;
      s.view.applyViewport();
      return { left: parseFloat(s.bar.el.style.left), top: parseFloat(s.bar.el.style.top), below: s.bar.el.classList.contains("is-below") };
    };
    const middle = card.x + card.width / 2;
    // Off the left edge: held at half its width.
    expect(place(-middle - 50, 300 - card.y).left).toBe(100);
    // Off the right edge: held at the stage's width less half its width.
    expect(place(900 - middle, 300 - card.y).left).toBe(700);
    // Inside: where the card is.
    expect(place(400 - middle, 300 - card.y).left).toBeCloseTo(400, 6);
    // No room above: below the card; a stage too short for that holds the bar's bottom inside it.
    Object.defineProperty(s.host, "clientHeight", { configurable: true, value: 100 });
    const low = place(400 - middle, 10 - card.y);
    expect(low.below).toBe(true);
    // Its top is given before the 8 px gap below the card; 30 px tall, so at most 100 - 30 - 8.
    expect(low.top).toBe(62);
    // With room, it sits right under the card.
    Object.defineProperty(s.host, "clientHeight", { configurable: true, value: 600 });
    expect(place(400 - middle, 10 - card.y).top).toBeCloseTo(10 + card.height, 6);
  });

  test("the bar goes below the card when there is less room above it than the bar's height and its gap", () => {
    const s = setup();
    Object.defineProperty(s.host, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(s.host, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(s.bar.el, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(s.bar.el, "offsetHeight", { configurable: true, value: 50 });
    s.select(["C"]);
    const card = nodeWorldRect(s.store.doc, s.store.doc.nodes.find((n) => n.id === "C")!);
    const below = (top: number) => {
      s.view.viewport.tx = 400 - (card.x + card.width / 2);
      s.view.viewport.ty = top - card.y;
      s.view.applyViewport();
      return s.bar.el.classList.contains("is-below");
    };
    // A 50 px bar and its 8 px gap need 58 px above the card.
    expect(below(57)).toBe(true);
    expect(below(58)).toBe(false);
    expect(below(200)).toBe(false);
  });

  test("the bar hides while its card is off the stage, and shows again when the card is back", () => {
    const s = setup();
    Object.defineProperty(s.host, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(s.host, "clientHeight", { configurable: true, value: 600 });
    s.select(["C"]);
    const card = nodeWorldRect(s.store.doc, s.store.doc.nodes.find((n) => n.id === "C")!);
    const at = (left: number, top: number) => {
      s.view.viewport.tx = left - card.x;
      s.view.viewport.ty = top - card.y;
      s.view.applyViewport();
      return s.bar.el.hidden;
    };
    expect(at(300, 300)).toBe(false);
    // Wholly above, below, left of or right of the stage.
    expect(at(300, -card.height - 1)).toBe(true);
    expect(at(300, 601)).toBe(true);
    expect(at(-card.width - 1, 300)).toBe(true);
    expect(at(801, 300)).toBe(true);
    // Partly in: shown.
    expect(at(-card.width + 10, 300)).toBe(false);
    expect(at(300, 590)).toBe(false);
    // A stage not yet laid out (no size) hides nothing.
    Object.defineProperty(s.host, "clientWidth", { configurable: true, value: 0 });
    Object.defineProperty(s.host, "clientHeight", { configurable: true, value: 0 });
    expect(at(5000, 5000)).toBe(false);
  });

  test("the wheel is not stopped on the bar, so zoom and pan work over it", () => {
    const s = setup();
    s.select(["C"]);
    const heard = vi.fn();
    s.host.addEventListener("wheel", heard);
    s.bar.el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 }));
    expect(heard).toHaveBeenCalledTimes(1);
    const pressed = vi.fn();
    s.host.addEventListener("pointerdown", pressed);
    s.bar.el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pressed).not.toHaveBeenCalled();
  });
});
