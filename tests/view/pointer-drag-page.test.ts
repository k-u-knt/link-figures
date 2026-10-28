import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import { DocumentStore } from "../../src/model/store";
import type { Document, Node } from "../../src/model/types";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { mmToPx } from "../../src/model/geometry";
import { PAGE_GAP_MM } from "../../src/constants";
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


/** A two-page document, A4 portrait each, with `build` run on it. Page 2 starts `PAGE2_Y` px below page 1. */
function setup(build: (doc: Document) => void) {
  const doc = createDocument("a4-portrait");
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  build(doc);
  const overlay = new FakeBox();
  const view = {
    store: undefined as unknown as DocumentStore,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: () => undefined },
    index: { untrack: vi.fn() },
    pageLayer: { overlayHost: () => overlay },
  };
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  view.store = new DocumentStore(doc, () => controller.commitTime());
  controller.attach(stage as never);
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, extra: object = {}) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, clientX, clientY, target: {}, ...extra });
  const nodeOf = (id: string) => view.store.doc.nodes.find((n) => n.id === id)!;
  return { doc, view, pointer, nodeOf };
}

const PAGE2_Y = mmToPx(297 + PAGE_GAP_MM);

/** A file node on `page`, 100 × 40 px at (10, 20) unless said otherwise. */
const file = (doc: Document, partial: Partial<Node>): Node => {
  const node = { ...fileNodeDefaults(doc.pages[0], { file: "a.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), x: 10, y: 20, width: 100, height: 40, ...partial } as Node;
  doc.nodes.push(node);
  return node;
};

test("a node dragged so that its centre ends over page 2 moves to page 2 where it was dropped, in one undo step", () => {
  const { doc, view, pointer, nodeOf } = setup((d) => { file(d, { id: "p-a" }); });
  const [, page2] = doc.pages;
  const start = nodeOf("p-a");
  const worldTop = start.y;

  pointer("pointerdown", 50, 30);
  pointer("pointermove", 60, 30 + PAGE2_Y / 2);
  pointer("pointermove", 60, 30 + PAGE2_Y);
  pointer("pointerup", 60, 30 + PAGE2_Y);

  const moved = nodeOf("p-a");
  expect(moved.page).toBe(page2.id);
  expect(moved.x).toBeCloseTo(20, 1);
  expect(moved.y).toBeCloseTo(worldTop, 1);
  expect(view.selection.ids).toEqual(["p-a"]);

  view.store.undo();
  expect(nodeOf("p-a")).toMatchObject({ page: doc.pages[0].id, x: 10, y: 20 });
  expect(view.store.undo()).toBe(false);
});

test("a node whose centre ends over no page keeps its page", () => {
  const { doc, pointer, nodeOf } = setup((d) => { file(d, { id: "p-a" }); });
  pointer("pointerdown", 50, 30);
  // Into the gap between the pages: below page 1's bottom edge, above page 2's top.
  pointer("pointermove", 50, 30 + mmToPx(297) + 10);
  pointer("pointerup", 50, 30 + mmToPx(297) + 10);
  expect(nodeOf("p-a").page).toBe(doc.pages[0].id);
});

test("a multi-selection moves each node by its own centre, and the selection keeps the first node's page", () => {
  const { doc, view, pointer, nodeOf } = setup((d) => {
    file(d, { id: "p-a", y: 20 });
    file(d, { id: "p-b", y: mmToPx(297) - 50 });
  });
  view.selection.set(["p-a", "p-b"]);
  pointer("pointerdown", 50, 30);
  pointer("pointermove", 50, 30 + PAGE2_Y);
  pointer("pointerup", 50, 30 + PAGE2_Y);

  expect(nodeOf("p-a").page).toBe(doc.pages[1].id);
  expect(nodeOf("p-b").page).toBe(doc.pages[1].id);
  expect(view.selection.ids).toEqual(["p-a", "p-b"]);
});

test("nodes landing on different pages narrow the selection to the first one's page", () => {
  const { doc, view, pointer, nodeOf } = setup((d) => {
    file(d, { id: "p-a", y: 20 });
    file(d, { id: "p-b", y: mmToPx(297) - 50 });
  });
  view.selection.set(["p-a", "p-b"]);
  // The top node's centre ends in the gap between the pages; the lower one's reaches page 2.
  const drop = 30 + PAGE2_Y - 100;
  pointer("pointerdown", 50, 30);
  pointer("pointermove", 50, drop);
  pointer("pointerup", 50, drop);

  expect(nodeOf("p-a").page).toBe(doc.pages[0].id);
  expect(nodeOf("p-b").page).toBe(doc.pages[1].id);
  expect(view.selection.ids).toEqual(["p-a"]);
});
