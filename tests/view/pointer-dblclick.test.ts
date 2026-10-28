import { createDocument, createPage, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import { DocumentStore } from "../../src/model/store";
import type { Document, Node } from "../../src/model/types";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { Viewport } from "../../src/view/viewport";

// There is no DOM in this suite: a stage that only records its listeners, and a view with just what a double-click uses.
// (Whether the stage really is where the browser sends the double-click after a press that captured the pointer can only be seen in Obsidian.)
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
  hasPointerCapture = () => false;
  releasePointerCapture = () => {};
  focus = () => {};
}

/** The element a node type mounted: it only records what is dispatched on it. */
const element = () => ({ dispatchEvent: vi.fn() });

function setup(build: (doc: Document) => void = () => {}) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const els = new Map<string, ReturnType<typeof element>>();
  for (const node of doc.nodes) els.set(node.id, element());
  const view = {
    store: new DocumentStore(doc),
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: (id: string) => els.get(id) },
    pageLayer: { overlayHost: () => { throw new Error("no overlay"); } },
  };
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  controller.attach(stage as never);
  /** Double-clicks the stage at a point (stage pixels), as the browser reports it. */
  const dblclick = (clientX: number, clientY: number, target: unknown = stage) => stage.fire("dblclick", { clientX, clientY, target });
  /** What was told, as `[node id, event type, bubbles]`. */
  const told = () => [...els].flatMap(([id, el]) => el.dispatchEvent.mock.calls.map(([ev]) => [id, ev.type, ev.bubbles]));
  return { doc, view, stage, controller, els, dblclick, told };
}

const text = (doc: Document, partial: Partial<Node>): Node => {
  const node = { ...textNodeDefaults(doc.pages[0], {}, doc.nodes.map((n) => n.id)), ...partial } as Node;
  doc.nodes.push(node);
  return node;
};

test("a double-click on a node tells that node's element, with a non-bubbling lf-activate", () => {
  const { dblclick, told } = setup((d) => { text(d, { id: "p-aaaa", x: 10, y: 20, width: 100, height: 40 }); });
  dblclick(50, 30);
  expect(told()).toEqual([["p-aaaa", "lf-activate", false]]);
});

test("the point is found through the viewport's pan and zoom", () => {
  const { view, dblclick, told } = setup((d) => { text(d, { id: "p-aaaa", x: 10, y: 20, width: 100, height: 40 }); });
  view.viewport.tx = 100;
  view.viewport.zoom = 2;
  dblclick(50, 30); // world (-25, 15): outside
  expect(told()).toEqual([]);
  dblclick(250, 100); // world (75, 50): inside
  expect(told()).toEqual([["p-aaaa", "lf-activate", false]]);
});

test("of nodes that overlap, only the topmost is told", () => {
  const { dblclick, told } = setup((d) => {
    text(d, { id: "p-low", x: 0, y: 0, width: 100, height: 100, z: 0 });
    text(d, { id: "p-high", x: 0, y: 0, width: 100, height: 100, z: 5 });
  });
  dblclick(50, 50);
  expect(told()).toEqual([["p-high", "lf-activate", false]]);
});

test("nodes are found on every page, wherever that page is on the canvas", () => {
  const { doc, dblclick, told } = setup((d) => {
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
    text(d, { id: "p-second", page: d.pages[1].id, x: 10, y: 20, width: 100, height: 40 });
  });
  // The second page starts below the first and the gap between them.
  const top = mmToPx(doc.pages[0].height + 20);
  dblclick(50, top + 30);
  expect(told()).toEqual([["p-second", "lf-activate", false]]);
});

test("a file node is told as well: what a double-click does is its type's business", () => {
  const { dblclick, told } = setup((d) => {
    d.nodes.push({ ...fileNodeDefaults(d.pages[0], { file: "a.png", subpath: "", show: "image" }, []), id: "p-file", x: 0, y: 0, width: 50, height: 50 });
  });
  dblclick(10, 10);
  expect(told()).toEqual([["p-file", "lf-activate", false]]);
});

test("nothing is told for a double-click on empty canvas or paper", () => {
  const { dblclick, told } = setup((d) => { text(d, { id: "p-aaaa", x: 10, y: 20, width: 100, height: 40 }); });
  dblclick(500, 20);
  dblclick(-30, -30);
  expect(told()).toEqual([]);
});

test("a locked node is told like any other: whether it edits is its type's business (the text node refuses)", () => {
  const { dblclick, told } = setup((d) => { text(d, { id: "p-lock", x: 300, y: 300, width: 50, height: 50, locked: true }); });
  dblclick(320, 320);
  expect(told()).toEqual([["p-lock", "lf-activate", false]]);
});

test("nothing is told in a read-only view, or for a double-click inside text being edited", () => {
  const { view, dblclick, told } = setup((d) => { text(d, { id: "p-aaaa", x: 10, y: 20, width: 100, height: 40 }); });
  dblclick(50, 30, { isContentEditable: true });
  dblclick(50, 30, { tagName: "INPUT" });
  expect(told()).toEqual([]);
  view.readOnly = true;
  dblclick(50, 30);
  expect(told()).toEqual([]);
});

test("a node that is not drawn (no element) is skipped without a fuss", () => {
  const { els, dblclick, told } = setup((d) => { text(d, { id: "p-aaaa", x: 10, y: 20, width: 100, height: 40 }); });
  els.delete("p-aaaa");
  expect(() => dblclick(50, 30)).not.toThrow();
  expect(told()).toEqual([]);
});

test("it follows the document as it is now, and stops when the controller is detached", () => {
  const { view, controller, dblclick, told } = setup((d) => { text(d, { id: "p-aaaa", x: 10, y: 20, width: 100, height: 40 }); });
  view.store.commit("move", (d) => { d.nodes[0].x = 400; });
  dblclick(50, 30);
  expect(told()).toEqual([]);
  dblclick(450, 30);
  expect(told()).toHaveLength(1);
  controller.detach();
  dblclick(450, 30);
  expect(told()).toHaveLength(1);
});
