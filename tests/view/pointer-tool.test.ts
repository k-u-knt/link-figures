import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import { mmToPx, type PlacePoint } from "../../src/model/geometry";
import { DocumentStore } from "../../src/model/store";
import type { Document, Node } from "../../src/model/types";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { Viewport } from "../../src/view/viewport";

// There is no DOM in this suite: a stage that only records its listeners, the pointer it captures and whether it was
// given the focus, and a view with just what a press and the keys use, whose tool methods record their calls.
class FakeStage {
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  focused = 0;
  addEventListener(type: string, fn: (ev: any) => void, options?: { signal?: AbortSignal }): void {
    const entry = (ev: any) => fn(ev);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), entry]);
    options?.signal?.addEventListener("abort", () => this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== entry)));
  }
  fire(type: string, ev: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  setPointerCapture = vi.fn();
  hasPointerCapture = () => false;
  releasePointerCapture = () => {};
  focus = () => void this.focused++;
}

/** What the tool is to the controller: something armed, or nothing. */
const TOOL = { id: "tool" };

function setup(build: (doc: Document) => void = () => {}) {
  const doc = createDocument("a4-portrait");
  build(doc);
  /** The tool calls, in order: `place` with the point, or `disarm`. */
  const calls: (["place", PlacePoint] | ["disarm"])[] = [];
  const view = {
    store: new DocumentStore(doc),
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: () => undefined },
    index: { untrack: vi.fn() },
    pageLayer: { overlayHost: () => { throw new Error("no overlay"); } },
    armedTool: TOOL as typeof TOOL | null,
    placeTool: (at: PlacePoint) => void calls.push(["place", at]),
    disarmTool: () => {
      calls.push(["disarm"]);
      view.armedTool = null;
    },
  };
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  controller.attach(stage as never);
  const press = (clientX: number, clientY: number, extra: object = {}) => {
    const ev = { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, clientX, clientY, target: {}, preventDefault: vi.fn(), ...extra };
    stage.fire("pointerdown", ev);
    return ev;
  };
  const key = (name: string) => {
    const ev = { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: {}, preventDefault: vi.fn() };
    stage.fire("keydown", ev);
    return ev;
  };
  return { doc, view, stage, calls, press, key };
}

/** A file node at (x, y), 100 × 40 px, unless said otherwise. */
const file = (doc: Document, partial: Partial<Node>): Node => {
  const node = { ...fileNodeDefaults(doc.pages[0], { file: "a.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), x: 10, y: 20, width: 100, height: 40, ...partial } as Node;
  doc.nodes.push(node);
  return node;
};

test("with a tool armed, a press on a page places it there (page pixels) and selects nothing", () => {
  const { doc, view, stage, calls, press } = setup((d) => {
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
    file(d, { id: "p-under", page: d.pages[1].id, x: 0, y: 0, width: 200, height: 200 });
  });
  // A press inside text being edited is the text's, tool or no tool.
  press(50, 30, { target: { isContentEditable: true } });
  expect(calls).toEqual([]);

  // Through the viewport's pan and zoom, onto the second page, over a node there: world (50, top + 30).
  view.viewport.tx = 10;
  view.viewport.zoom = 2;
  const top = mmToPx(doc.pages[0].height + 20);
  const ev = press(10 + 50 * 2, (top + 30) * 2);

  expect(calls).toHaveLength(1);
  const [kind, at] = calls[0] as ["place", PlacePoint];
  expect(kind).toBe("place");
  expect(at.page).toBe(doc.pages[1]);
  expect(at.x).toBeCloseTo(50);
  expect(at.y).toBeCloseTo(30);
  // Not the node under the pointer, nor any gesture: nothing selected, captured or changed.
  expect(view.selection.ids).toEqual([]);
  expect(stage.setPointerCapture).not.toHaveBeenCalled();
  expect(view.store.canUndo()).toBe(false);
  // The focus stays where the tool put it (the label it starts editing): the stage does not take it, nor does the mousedown that follows.
  expect(stage.focused).toBe(0);
  expect(ev.preventDefault).toHaveBeenCalled();
});

test("with a tool armed, a press off every page disarms it, and Escape disarms it", () => {
  const { doc, view, calls, press, key } = setup((d) => {
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
    file(d, { id: "p-a" });
  });
  // In the gap between the two pages.
  const ev = press(50, mmToPx(doc.pages[0].height + 10));
  expect(calls).toEqual([["disarm"]]);
  expect(ev.preventDefault).toHaveBeenCalled();
  expect(view.selection.ids).toEqual([]);

  // Armed again, with a node selected: Escape disarms the tool, and the selection stays.
  view.selection.set(["p-a"]);
  view.armedTool = TOOL;
  const esc = key("Escape");
  expect(calls).toEqual([["disarm"], ["disarm"]]);
  expect(esc.preventDefault).toHaveBeenCalled();
  expect(view.selection.ids).toEqual(["p-a"]);

  // With nothing armed, Escape clears the selection as before.
  key("Escape");
  expect(calls).toHaveLength(2);
  expect(view.selection.ids).toEqual([]);
});

test("with no tool armed, a press selects as before", () => {
  const { view, stage, calls, press } = setup((d) => { file(d, { id: "p-a" }); });
  view.armedTool = null;
  const ev = press(50, 30);
  expect(view.selection.ids).toEqual(["p-a"]);
  expect(stage.focused).toBe(1);
  expect(stage.setPointerCapture).toHaveBeenCalledWith(1);
  expect(ev.preventDefault).not.toHaveBeenCalled();
  // Bare paper clears it.
  press(400, 400);
  expect(view.selection.ids).toEqual([]);
  expect(calls).toEqual([]);
});
