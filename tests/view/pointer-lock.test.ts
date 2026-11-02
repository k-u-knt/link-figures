import type { UndoStep } from "../../src/registry/command";
import { registriesWithDrawing, runCommandWith } from "./command-runner";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import { DocumentStore } from "../../src/model/store";
import type { Document, Node } from "../../src/model/types";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { Viewport } from "../../src/view/viewport";

// There is no DOM in this suite: a stage that only records its listeners, a page overlay that only keeps what is
// appended to it, and a view with just what a press, a drag and the keys use.
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

/** The part of an element that selection boxes use: a class name, children, a style and a place in its parent. */
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
  get classes(): string[] {
    return this.className.split(" ");
  }
}

function setup(build: (doc: Document) => void = () => {}) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const overlay = new FakeBox();
  const registries = registriesWithDrawing();
  const view = {
    store: new DocumentStore(doc),
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    plugin: { registries },
    viewOption: () => undefined,
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: () => undefined },
    index: { untrack: vi.fn() },
    pageLayer: { overlayHost: () => overlay },
    runCommandById: vi.fn((id: string, args?: Record<string, unknown>, step?: UndoStep) => run(id, args, step)),
  };
  const run = runCommandWith(registries, view);
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  controller.attach(stage as never);
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, extra: object = {}) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, clientX, clientY, target: {}, ...extra });
  const key = (name: string) => {
    const ev = { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: {}, preventDefault: vi.fn() };
    stage.fire("keydown", ev);
    return ev;
  };
  /** The marquees drawn in the page's overlay: one while a marquee is being swept, none otherwise. */
  const marquees = () => overlay.children.filter((c) => c.classes.includes("lf-marquee"));
  /** The selection boxes drawn in the page's overlay. */
  const boxes = () => overlay.children.filter((c) => c.classes.includes("lf-selection"));
  const nodeOf = (id: string) => view.store.doc.nodes.find((n) => n.id === id)!;
  return { doc, view, stage, controller, pointer, key, boxes, marquees, nodeOf };
}

/** A file node at (x, y), 100 × 40 px, unless said otherwise. */
const file = (doc: Document, partial: Partial<Node>): Node => {
  const node = { ...fileNodeDefaults(doc.pages[0], { file: "a.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), x: 10, y: 20, width: 100, height: 40, ...partial } as Node;
  doc.nodes.push(node);
  return node;
};

test("a press on a locked node selects it, and a drag past the threshold moves nothing", () => {
  const { view, pointer, nodeOf } = setup((d) => { file(d, { id: "p-lock", locked: true }); });
  const before = view.store.doc;

  pointer("pointerdown", 50, 30);
  expect(view.selection.ids).toEqual(["p-lock"]);
  // A click that goes nowhere leaves it selected.
  pointer("pointerup", 50, 30);
  expect(view.selection.ids).toEqual(["p-lock"]);

  pointer("pointerdown", 50, 30);
  pointer("pointermove", 90, 70);
  pointer("pointermove", 200, 200);
  pointer("pointerup", 200, 200);
  expect(nodeOf("p-lock")).toMatchObject({ x: 10, y: 20, width: 100, height: 40 });
  // Not even an undo step was made.
  expect(view.store.doc).toBe(before);
  expect(view.store.canUndo()).toBe(false);
});

test("a drag from a locked node sweeps a marquee on its page, which starts afresh: the locked node drops out and the unlocked nodes it touches are selected", () => {
  const { view, pointer, marquees, nodeOf } = setup((d) => {
    file(d, { id: "p-lock", locked: true });
    file(d, { id: "p-free", x: 200, y: 20 });
    file(d, { id: "p-far", x: 200, y: 400 });
  });
  pointer("pointerdown", 50, 30);
  expect(view.selection.ids).toEqual(["p-lock"]);
  expect(marquees()).toHaveLength(0);

  // Past the threshold: a marquee, which has not touched an unlocked node yet, so nothing is selected.
  pointer("pointermove", 60, 40);
  expect(marquees()).toHaveLength(1);
  expect(marquees()[0].style).toMatchObject({ left: "50px", top: "30px", width: "10px", height: "10px" });
  expect(view.selection.ids).toEqual([]);

  // Over the unlocked node it selects that node, and still not the locked one the sweep began on.
  pointer("pointermove", 250, 50);
  expect(marquees()).toHaveLength(1);
  expect(view.selection.ids).toEqual(["p-free"]);

  pointer("pointerup", 250, 50);
  expect(marquees()).toHaveLength(0);
  expect(view.selection.ids).toEqual(["p-free"]);
  expect(nodeOf("p-lock")).toMatchObject({ x: 10, y: 20 });
  expect(nodeOf("p-free")).toMatchObject({ x: 200, y: 20 });
  expect(view.store.canUndo()).toBe(false);
});

test("a marquee from a locked full-page background still selects what lies over it", () => {
  const { doc, view, pointer } = setup((d) => {
    file(d, { id: "p-bg", x: 0, y: 0, width: 400, height: 400, z: 0, locked: true });
    file(d, { id: "p-a", x: 20, y: 20, width: 50, height: 50, z: 1 });
    file(d, { id: "p-b", x: 120, y: 20, width: 50, height: 50, z: 1 });
  });
  expect(doc.nodes).toHaveLength(3);
  pointer("pointerdown", 5, 5);
  expect(view.selection.ids).toEqual(["p-bg"]);
  pointer("pointermove", 100, 100);
  expect(view.selection.ids).toEqual(["p-a"]);
  pointer("pointermove", 150, 100);
  expect(view.selection.ids).toEqual(["p-a", "p-b"]);
  pointer("pointerup", 150, 100);
  expect(view.selection.ids).toEqual(["p-a", "p-b"]);
});

test("a press where a handle would be, on a locked node, resizes nothing either", () => {
  const { view, pointer, nodeOf } = setup((d) => { file(d, { id: "p-lock", locked: true }); });
  // The south-east corner.
  pointer("pointerdown", 110, 60);
  expect(view.selection.ids).toEqual(["p-lock"]);
  pointer("pointermove", 160, 100);
  pointer("pointerup", 160, 100);
  expect(nodeOf("p-lock")).toMatchObject({ x: 10, y: 20, width: 100, height: 40 });
  expect(view.store.canUndo()).toBe(false);
});

test("a press selects whichever of a locked and an unlocked node is on top", () => {
  const { view, pointer } = setup((d) => {
    file(d, { id: "p-low", z: 0 });
    file(d, { id: "p-lock", z: 1, locked: true });
  });
  pointer("pointerdown", 50, 30);
  pointer("pointerup", 50, 30);
  expect(view.selection.ids).toEqual(["p-lock"]);

  view.store.commit("restack", (d) => { d.nodes[0].z = 2; });
  pointer("pointerdown", 50, 30);
  pointer("pointerup", 50, 30);
  expect(view.selection.ids).toEqual(["p-low"]);
});

test("in a mixed selection a drag moves the unlocked node and leaves the locked one", () => {
  const { view, pointer, nodeOf } = setup((d) => {
    file(d, { id: "p-free", x: 10, y: 20 });
    file(d, { id: "p-lock", x: 300, y: 20, locked: true });
  });
  pointer("pointerdown", 50, 30);
  pointer("pointerup", 50, 30);
  pointer("pointerdown", 330, 30, { shiftKey: true });
  pointer("pointerup", 330, 30);
  expect(view.selection.ids).toEqual(["p-free", "p-lock"]);

  pointer("pointerdown", 330, 30);
  pointer("pointermove", 350, 60);
  pointer("pointerup", 350, 60);
  expect(nodeOf("p-free")).toMatchObject({ x: 30, y: 50 });
  expect(nodeOf("p-lock")).toMatchObject({ x: 300, y: 20 });
});

test("Delete leaves a locked node in the document; the selection box of a locked node has no handles and the class is-locked", () => {
  const { view, pointer, key, boxes, nodeOf } = setup((d) => { file(d, { id: "p-lock", locked: true }); });
  pointer("pointerdown", 50, 30);
  pointer("pointerup", 50, 30);

  const [box] = boxes();
  expect(boxes()).toHaveLength(1);
  expect(box.classes).toEqual(expect.arrayContaining(["lf-selection", "lf-selected", "is-locked"]));
  expect(box.children).toEqual([]);
  expect(box.style).toMatchObject({ left: "10px", top: "20px", width: "100px", height: "40px" });

  const ev = key("Delete");
  expect(ev.preventDefault).not.toHaveBeenCalled();
  key("Backspace");
  expect(nodeOf("p-lock")).toBeDefined();
  expect(view.store.doc.nodes).toHaveLength(1);
  expect(view.index.untrack).not.toHaveBeenCalled();
  expect(view.runCommandById).not.toHaveBeenCalled();
  expect(view.selection.ids).toEqual(["p-lock"]);
});

test("Delete and Backspace run the delete command when an unlocked node is selected, as the toolbar does", () => {
  const { view, pointer, key } = setup((d) => { file(d, { id: "p-free" }); });
  pointer("pointerdown", 50, 30);
  pointer("pointerup", 50, 30);
  expect(key("Delete").preventDefault).toHaveBeenCalled();
  expect(key("Backspace").preventDefault).toHaveBeenCalled();
  expect(view.runCommandById.mock.calls).toEqual([["delete"], ["delete"]]);
});

test("the selection box of an unlocked node has the eight handles and no is-locked class", () => {
  const { pointer, boxes } = setup((d) => { file(d, { id: "p-free" }); });
  pointer("pointerdown", 50, 30);
  pointer("pointerup", 50, 30);
  const [box] = boxes();
  expect(box.classes).not.toContain("is-locked");
  expect(box.children.map((h) => h.dataset.handle).sort()).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
});

test("unlocking a selected node in the inspector gives its box the handles back, and locking takes them away", () => {
  const { view, pointer, boxes } = setup((d) => { file(d, { id: "p-lock", locked: true }); });
  pointer("pointerdown", 50, 30);
  pointer("pointerup", 50, 30);
  expect(boxes()[0].classes).toContain("is-locked");

  view.store.commit("inspector", (d) => { d.nodes[0].locked = false; });
  expect(boxes()).toHaveLength(1);
  expect(boxes()[0].classes).not.toContain("is-locked");
  expect(boxes()[0].children).toHaveLength(8);

  view.store.commit("inspector", (d) => { d.nodes[0].locked = true; });
  expect(boxes()).toHaveLength(1);
  expect(boxes()[0].classes).toContain("is-locked");
  expect(boxes()[0].children).toEqual([]);
});
