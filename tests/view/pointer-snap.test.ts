import type { UndoStep } from "../../src/registry/command";
import { registriesWithDrawing, runCommandWith } from "./command-runner";
import { snapToggle } from "../../src/commands/builtin";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import { mmToPx, type PlacePoint } from "../../src/model/geometry";
import { builtinSnapSources, SNAP_OPTION } from "../../src/model/snap";
import { DocumentStore } from "../../src/model/store";
import type { Document, Node } from "../../src/model/types";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { Viewport } from "../../src/view/viewport";
import { NUDGE_MM } from "../../src/constants";

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

function setup(build: (doc: Document) => void) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const overlay = new FakeBox();
  const registries = registriesWithDrawing();
  for (const source of builtinSnapSources) registries.snaps.register(source);
  const options = new Map<string, unknown>();
  const placed: { from: PlacePoint; to: PlacePoint }[] = [];
  const view = {
    store: undefined as unknown as DocumentStore,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    plugin: { registries },
    viewOption: (key: string) => options.get(key),
    setViewOption: (key: string, value: unknown) => void options.set(key, value),
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: () => undefined },
    index: { untrack: vi.fn() },
    pageLayer: { overlayHost: () => overlay },
    armedTool: null as object | null,
    disarmTool: () => void (view.armedTool = null),
    placeToolDrag: (from: PlacePoint, to: PlacePoint) => void placed.push({ from, to }),
    runCommandById: (id: string, args?: Record<string, unknown>, step?: UndoStep) => run(id, args, step),
  };
  const run = runCommandWith(registries, view);
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  view.store = new DocumentStore(doc, () => controller.commitTime());
  controller.attach(stage as never);
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, extra: object = {}) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, clientX, clientY, target: {}, preventDefault: () => {}, ...extra });
  const nodeOf = (id: string) => view.store.doc.nodes.find((n) => n.id === id)!;
  const key = (name: string) =>
    stage.fire("keydown", { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: {}, preventDefault: () => {} });
  const guides = () => overlay.children.filter((c) => c.className.split(" ").includes("lf-snap-guide"));
  return { doc, view, options, placed, pointer, nodeOf, key, guides };
}

const file = (doc: Document, partial: Partial<Node>): void => {
  doc.nodes.push({ ...fileNodeDefaults(doc.pages[0], { file: "a.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), width: 100, height: 40, ...partial } as Node);
};

/** a (10, 20)–(110, 60), b (200, 200)–(300, 240). */
const twoNodes = (d: Document) => {
  file(d, { id: "a", x: 10, y: 20, z: 0 });
  file(d, { id: "b", x: 200, y: 200, z: 1 });
};

test("a drag whose top meets a's top as its middle meets c's middle draws both guides, the same at every move (finding 4)", () => {
  // a (10, 20)–(110, 120): its top is 20. c (500, 30)–(550, 50): its middle is 40. b (250, 200)–(350, 240) is dragged up.
  const { pointer, nodeOf, guides } = setup((d) => {
    file(d, { id: "a", x: 10, y: 20, height: 100, z: 0 });
    file(d, { id: "c", x: 500, y: 30, width: 50, height: 20, z: 1 });
    file(d, { id: "b", x: 250, y: 200, z: 2 });
  });
  pointer("pointerdown", 300, 220);
  for (const dy of [-178, -177.7, -178.3, -178.1, -177.9]) {
    pointer("pointermove", 300, 220 + dy);
    expect(nodeOf("b").y).toBe(20);
    expect(guides().map((g) => [g.className, g.style.top])).toEqual([
      ["lf-snap-guide is-horizontal", "20px"],
      ["lf-snap-guide is-horizontal", "40px"],
    ]);
  }
  pointer("pointerup", 300, 42);
  expect(guides()).toHaveLength(0);
});

test("at zoom 1, a drag that would leave a's left 4 px short of b's left lands it on b's left, with guides while dragging, in one undo step", () => {
  const { view, pointer, nodeOf, guides } = setup(twoNodes);
  pointer("pointerdown", 50, 30);
  pointer("pointermove", 50 + 186, 30 + 100);
  expect(nodeOf("a").x).toBe(200);
  expect(nodeOf("a").y).toBe(120);
  // a is as wide as b, so its left, centre and right all land on b's: a guide for each.
  expect(guides().map((g) => g.style.left)).toEqual(["200px", "250px", "300px"]);
  pointer("pointerup", 50 + 186, 30 + 100);
  expect(nodeOf("a")).toMatchObject({ x: 200, y: 120 });
  expect(guides()).toHaveLength(0);

  view.store.undo();
  expect(nodeOf("a")).toMatchObject({ x: 10, y: 20 });
  expect(view.store.undo()).toBe(false);
});

test("the same drag with Alt held lands where the pointer put it, with no guide", () => {
  const { pointer, nodeOf, guides } = setup(twoNodes);
  pointer("pointerdown", 50, 30);
  pointer("pointermove", 50 + 186, 30 + 100, { altKey: true });
  expect(guides()).toHaveLength(0);
  pointer("pointerup", 50 + 186, 30 + 100, { altKey: true });
  expect(nodeOf("a")).toMatchObject({ x: 196, y: 120 });
});

test("Escape clears the guides of a drag under way", () => {
  const { pointer, key, guides } = setup(twoNodes);
  pointer("pointerdown", 50, 30);
  pointer("pointermove", 50 + 186, 30 + 100);
  expect(guides()).toHaveLength(3);
  key("Escape");
  expect(guides()).toHaveLength(0);
});

test("at zoom 0.25 the reach is 24 page px: a line 30 px away does not snap, one 20 px away does", () => {
  // a (10, 100)–(110, 140), b (500, 300)–(600, 340): b's right is at 600.
  const build = (d: Document) => {
    file(d, { id: "a", x: 10, y: 100 });
    file(d, { id: "b", x: 500, y: 300 });
  };
  const far = setup(build);
  far.view.viewport.zoom = 0.25;
  // Press at world (50, 120); move a's left to 630, 30 px right of b's right.
  far.pointer("pointerdown", 12.5, 30);
  far.pointer("pointermove", 12.5 + 620 * 0.25, 30);
  far.pointer("pointerup", 12.5 + 620 * 0.25, 30);
  expect(far.nodeOf("a")).toMatchObject({ x: 630, y: 100 });

  const near = setup(build);
  near.view.viewport.zoom = 0.25;
  near.pointer("pointerdown", 12.5, 30);
  near.pointer("pointermove", 12.5 + 610 * 0.25, 30);
  near.pointer("pointerup", 12.5 + 610 * 0.25, 30);
  expect(near.nodeOf("a")).toMatchObject({ x: 600, y: 100 });
});

test("the east resize handle snaps the right edge to the page's right margin", () => {
  const { doc, view, pointer, nodeOf, guides } = setup((d) => {
    d.pages[0].margins.right = 20;
    file(d, { id: "a", x: 500, y: 100 });
  });
  const margin = mmToPx(doc.pages[0].width) - mmToPx(20);
  view.selection.set(["a"]);
  pointer("pointerdown", 600, 120);
  pointer("pointermove", margin - 3, 120);
  expect(guides()).toHaveLength(1);
  pointer("pointerup", margin - 3, 120);
  const a = nodeOf("a");
  expect(a.x).toBe(500);
  expect(a.x + a.width).toBeCloseTo(margin, 1);
  expect(guides()).toHaveLength(0);
});

test("with snapping toggled off, nothing snaps; the toggle names its state", () => {
  const { view, options, pointer, nodeOf, guides } = setup(twoNodes);
  const ctx = { view } as never;
  expect(snapToggle).toMatchObject({ id: "snap.toggle", group: "view", needsView: true });
  expect(snapToggle.state!(ctx)).toEqual({ name: "Snap: on", icon: "magnet", active: true });
  snapToggle.run(ctx);
  expect(options.get(SNAP_OPTION)).toBe(false);
  expect(snapToggle.state!(ctx)).toEqual({ name: "Snap: off", icon: "magnet", active: false });

  pointer("pointerdown", 50, 30);
  pointer("pointermove", 50 + 186, 30 + 100);
  expect(guides()).toHaveLength(0);
  pointer("pointerup", 50 + 186, 30 + 100);
  expect(nodeOf("a")).toMatchObject({ x: 196, y: 120 });

  snapToggle.run(ctx);
  expect(options.get(SNAP_OPTION)).toBe(true);
});

test("a nudge never snaps", () => {
  const { view, key, nodeOf } = setup((d) => {
    file(d, { id: "a", x: 192, y: 120 });
    file(d, { id: "b", x: 200, y: 200 });
  });
  view.selection.set(["a"]);
  key("ArrowRight");
  expect(nodeOf("a").x).toBeCloseTo(192 + mmToPx(NUDGE_MM), 2);
});

test("a box-drawing tool's dragged corner snaps", () => {
  const { view, placed, pointer, guides } = setup((d) => file(d, { id: "b", x: 200, y: 200 }));
  view.armedTool = { id: "tool.rect", placeDrag: () => {} };
  pointer("pointerdown", 100, 400);
  pointer("pointermove", 196, 450);
  expect(guides()).toHaveLength(1);
  pointer("pointerup", 196, 450);
  expect(placed).toHaveLength(1);
  expect(placed[0].to.x).toBe(200);
  expect(placed[0].to.y).toBe(450);
  expect(guides()).toHaveLength(0);
});
