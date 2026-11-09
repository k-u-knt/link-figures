import type { UndoStep } from "../../src/registry/command";
import { registriesWithDrawing, runCommandWith } from "./command-runner";
import { createDocument, fileNodeDefaults, groupNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { DocumentStore } from "../../src/model/store";
import type { Document, Node, NodeId } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { Viewport } from "../../src/view/viewport";

// There is no DOM in this suite: a stage that only records its listeners, a page overlay that only keeps what is
// appended to it, and a view with just what a press, a drag, a double-click and the keys use.
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
  replaceChildren(...children: FakeBox[]): void {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  get classes(): string[] {
    return this.className.split(" ");
  }
}

/** A file node, 100 × 40 px unless said otherwise. */
const file = (doc: Document, partial: Partial<Node>): void => {
  doc.nodes.push({ ...fileNodeDefaults(doc.pages[0], { file: "a.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), width: 100, height: 40, ...partial } as Node);
};
const group = (doc: Document, id: string, extra: Partial<Node> = {}): void => {
  doc.nodes.push({ ...groupNodeDefaults(doc.pages[0], { id }, doc.nodes.map((n) => n.id)), ...extra } as Node);
};

/**
 * h = {g = {a, b}, c}, and x on its own:
 * a (10, 20)–(110, 60), b (150, 20)–(250, 60), so g is (10, 20)–(250, 60); c (10, 100)–(300, 140), so h is
 * (10, 20)–(300, 140); x (300, 300)–(350, 350).
 */
const nested = (extra: { hLocked?: boolean } = {}) => (d: Document) => {
  file(d, { id: "a", x: 10, y: 20, z: 0, parent: "g" });
  file(d, { id: "b", x: 150, y: 20, z: 1, parent: "g" });
  file(d, { id: "c", x: 10, y: 100, width: 290, z: 2, parent: "h" });
  group(d, "g", { parent: "h" });
  group(d, "h", { locked: extra.hLocked ?? false });
  file(d, { id: "x", x: 300, y: 300, width: 50, height: 50, z: 3 });
};

function setup(build: (doc: Document) => void) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const overlay = new FakeBox();
  const registries = registriesWithDrawing();
  registries.nodeTypes.register(groupNodeType);
  const els = new Map<string, { dispatchEvent: ReturnType<typeof vi.fn> }>();
  const ran: string[] = [];
  const view = {
    store: undefined as unknown as DocumentStore,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    enteredGroup: null as NodeId | null,
    plugin: { registries },
    viewOption: () => undefined,
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: {
      elementFor: (id: string) => {
        if (!els.has(id)) els.set(id, { dispatchEvent: vi.fn() });
        return els.get(id);
      },
    },
    index: { untrack: vi.fn() },
    pageLayer: { overlayHost: () => overlay },
    runCommandById: (id: string, args?: Record<string, unknown>, step?: UndoStep) => {
      ran.push(id);
      run(id, args, step);
    },
  };
  const run = runCommandWith(registries, view);
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  view.store = createFigureStore(doc, registries, () => controller.commitTime());
  controller.attach(stage as never);
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, extra: object = {}) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, clientX, clientY, target: {}, ...extra });
  const click = (x: number, y: number, extra: object = {}) => {
    pointer("pointerdown", x, y, extra);
    pointer("pointerup", x, y, extra);
  };
  /** A double-click as the browser sends it: two clicks, then the dblclick. */
  const dblclick = (x: number, y: number) => {
    click(x, y);
    click(x, y);
    stage.fire("dblclick", { clientX: x, clientY: y, target: stage });
  };
  const drag = (from: [number, number], to: [number, number]) => {
    pointer("pointerdown", ...from);
    pointer("pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    pointer("pointermove", ...to);
    pointer("pointerup", ...to);
  };
  const key = (name: string) =>
    stage.fire("keydown", { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: {}, preventDefault: () => {} });
  const nodeOf = (id: string) => view.store.doc.nodes.find((n) => n.id === id)!;
  /** What was told by a double-click, as `[node id, event type]`. */
  const told = () => [...els].flatMap(([id, el]) => el.dispatchEvent.mock.calls.map(([ev]) => [id, ev.type]));
  return { view, overlay, ran, click, dblclick, drag, key, nodeOf, told };
}

// On a, on c, on x, and on empty paper inside h's box (between a, b and c), and far from everything.
const ON_A: [number, number] = [50, 30];
const ON_C: [number, number] = [50, 120];
const ON_X: [number, number] = [320, 320];
const IN_H: [number, number] = [130, 80];
const PAPER: [number, number] = [400, 600];

describe("clicks select whole groups", () => {
  test("a click on a member of g, which is in h, selects h", () => {
    const { view, click } = setup(nested());
    click(...ON_A);
    expect(view.selection.ids).toEqual(["h"]);
  });

  test("a click inside a group's box but on none of its members selects nothing: a group's own box is not hit", () => {
    const { view, click } = setup(nested());
    click(...IN_H);
    expect(view.selection.ids).toEqual([]);
  });
});

describe("entering and leaving groups", () => {
  test("a double-click on a enters h, so a click on a selects g; a second double-click enters g, so a click selects a", () => {
    const { view, click, dblclick, told } = setup(nested());
    dblclick(...ON_A);
    expect(view.enteredGroup).toBe("h");
    expect(view.selection.ids).toEqual(["g"]);
    click(...ON_A);
    expect(view.selection.ids).toEqual(["g"]);
    click(...ON_C);
    expect(view.selection.ids).toEqual(["c"]);

    dblclick(...ON_A);
    expect(view.enteredGroup).toBe("g");
    expect(view.selection.ids).toEqual(["a"]);
    click(...ON_A);
    expect(view.selection.ids).toEqual(["a"]);
    // Entering is all a double-click on a member of a group that is not entered does.
    expect(told()).toEqual([]);
  });

  test("Escape leaves one level per press, selecting the group it leaves; then it clears the selection as before", () => {
    const { view, dblclick, key } = setup(nested());
    dblclick(...ON_A);
    dblclick(...ON_A);
    expect(view.enteredGroup).toBe("g");
    key("Escape");
    expect(view.enteredGroup).toBe("h");
    expect(view.selection.ids).toEqual(["g"]);
    key("Escape");
    expect(view.enteredGroup).toBe(null);
    expect(view.selection.ids).toEqual(["h"]);
    key("Escape");
    expect(view.selection.ids).toEqual([]);
  });

  test("a click on empty paper, or on a node outside the entered group, leaves it entirely", () => {
    const { view, click, dblclick } = setup(nested());
    dblclick(...ON_A);
    dblclick(...ON_A);
    click(...PAPER);
    expect(view.enteredGroup).toBe(null);
    expect(view.selection.ids).toEqual([]);

    dblclick(...ON_A);
    dblclick(...ON_A);
    click(...IN_H);
    expect(view.enteredGroup).toBe(null);

    dblclick(...ON_A);
    dblclick(...ON_A);
    click(...ON_C);
    expect(view.enteredGroup).toBe(null);
    expect(view.selection.ids).toEqual(["h"]);

    dblclick(...ON_A);
    click(...ON_X);
    expect(view.enteredGroup).toBe(null);
    expect(view.selection.ids).toEqual(["x"]);
  });

  test("the entered group is marked by a dashed outline in its page's overlay, gone once it is left", () => {
    const { overlay, dblclick, key } = setup(nested());
    const outlines = () => overlay.children.filter((c) => c.classes.includes("lf-group-entered"));
    expect(outlines()).toHaveLength(0);
    dblclick(...ON_A);
    expect(outlines()).toHaveLength(1);
    expect(outlines()[0].style).toMatchObject({ left: "10px", top: "20px", width: "290px", height: "120px" });
    key("Escape");
    expect(outlines()).toHaveLength(0);
  });

  test("an entered group that is deleted is left", () => {
    const { view, dblclick } = setup(nested());
    dblclick(...ON_A);
    expect(view.enteredGroup).toBe("h");
    // Its members go, so the group normaliser deletes g and h.
    view.store.commit("delete", (d) => { d.nodes = d.nodes.filter((n) => n.id === "x" || n.type === "group"); });
    expect(view.store.doc.nodes.map((n) => n.id)).toEqual(["x"]);
    expect(view.enteredGroup).toBe(null);
  });
});

describe("marquee", () => {
  test("a marquee around a and b selects h only when all of h is inside, and otherwise nothing from h", () => {
    const { view, drag } = setup(nested());
    drag([5, 10], [260, 70]);
    expect(view.selection.ids).toEqual([]);
    drag([5, 10], [310, 150]);
    expect(view.selection.ids).toEqual(["h"]);
  });

  test("inside h, the marquee selects children of h", () => {
    const { view, drag, dblclick } = setup(nested());
    dblclick(...ON_C);
    expect(view.enteredGroup).toBe("h");
    // From empty paper inside h: c is touched, g is not wholly inside.
    drag(IN_H, [5, 150]);
    expect(view.enteredGroup).toBe("h");
    expect(view.selection.ids).toEqual(["c"]);
    // g wholly inside, c not touched.
    drag(IN_H, [0, 10]);
    expect(view.selection.ids).toEqual([]);
    drag([305, 70], [0, 10]);
    // From outside h the marquee leaves it.
    expect(view.enteredGroup).toBe(null);
    expect(view.selection.ids).toEqual([]);
    dblclick(...ON_C);
    drag([280, 80], [0, 10]);
    expect(view.selection.ids).toEqual(["g"]);
  });
});

describe("moving and resizing groups", () => {
  test("dragging the selection moves the whole of h in one undo step", () => {
    const { view, drag, nodeOf } = setup(nested());
    drag(ON_A, [ON_A[0] + 10, ON_A[1] + 10]);
    expect(view.selection.ids).toEqual(["h"]);
    expect(["a", "b", "c"].map((id) => [nodeOf(id).x, nodeOf(id).y])).toEqual([[20, 30], [160, 30], [20, 110]]);
    expect(nodeOf("x")).toMatchObject({ x: 300, y: 300 });
    view.store.undo();
    expect(["a", "b", "c"].map((id) => [nodeOf(id).x, nodeOf(id).y])).toEqual([[10, 20], [150, 20], [10, 100]]);
    expect(view.store.undo()).toBe(false);
  });

  test("resizing g by its east handle doubles its members' widths: one undo step, by node.update", () => {
    const { view, ran, dblclick, drag, nodeOf } = setup(nested());
    dblclick(...ON_A);
    expect(view.selection.ids).toEqual(["g"]);
    ran.length = 0;
    // g is (10, 20)–(250, 60): its east handle is at (250, 40).
    drag([250, 40], [490, 40]);
    expect(nodeOf("a")).toMatchObject({ x: 10, width: 200 });
    expect(nodeOf("b")).toMatchObject({ x: 290, width: 200 });
    expect(nodeOf("g")).toMatchObject({ x: 10, width: 480 });
    expect(nodeOf("c")).toMatchObject({ x: 10, width: 290 });
    expect(new Set(ran)).toEqual(new Set(["node.update"]));
    view.store.undo();
    expect(nodeOf("a")).toMatchObject({ x: 10, width: 100 });
    expect(nodeOf("b")).toMatchObject({ x: 150, width: 100 });
    expect(view.store.undo()).toBe(false);
  });

  test("a node that is not a group is still resized as before", () => {
    const { view, ran, click, drag, nodeOf } = setup(nested());
    click(...ON_X);
    ran.length = 0;
    drag([350, 325], [400, 325]);
    expect(nodeOf("x")).toMatchObject({ x: 300, width: 100 });
    expect(ran).toEqual([]);
    view.store.undo();
    expect(nodeOf("x")).toMatchObject({ width: 50 });
  });
});

describe("locks are inherited", () => {
  test("in a locked group a selected member cannot be dragged or resized: the drag sweeps a marquee", () => {
    const { view, dblclick, drag, nodeOf, overlay } = setup(nested({ hLocked: true }));
    dblclick(...ON_A);
    expect(view.selection.ids).toEqual(["g"]);
    // No handles are drawn on g, which is locked through h.
    const box = overlay.children.find((c) => c.classes.includes("lf-selected"))!;
    expect(box.classes).toContain("is-locked");
    expect(box.children).toHaveLength(0);
    drag(ON_A, [ON_A[0] + 10, ON_A[1] + 10]);
    expect(nodeOf("a")).toMatchObject({ x: 10, y: 20 });
    // East handle of g: not grabbed.
    drag([250, 40], [490, 40]);
    expect(nodeOf("b")).toMatchObject({ x: 150, width: 100 });
    expect(view.store.canUndo()).toBe(false);
  });

  test("a locked group can be selected, and a drag from it sweeps a marquee", () => {
    const { view, click, drag, nodeOf } = setup(nested({ hLocked: true }));
    click(...ON_A);
    expect(view.selection.ids).toEqual(["h"]);
    drag(ON_A, [ON_A[0] + 10, ON_A[1] + 10]);
    expect(nodeOf("a")).toMatchObject({ x: 10, y: 20 });
  });
});

describe("double-click on text", () => {
  const labelled = (d: Document) => {
    d.nodes.push({ ...textNodeDefaults(d.pages[0], { id: "t", x: 10, y: 20, width: 100, height: 40, z: 0 }, []), parent: "k" } as Node);
    file(d, { id: "m", x: 150, y: 20, z: 1, parent: "k" });
    group(d, "k");
  };

  test("on a text label in a group that is not entered it enters the group; in the entered group it starts editing", () => {
    const { view, dblclick, told } = setup(labelled);
    dblclick(50, 30);
    expect(view.enteredGroup).toBe("k");
    expect(view.selection.ids).toEqual(["t"]);
    expect(told()).toEqual([]);
    dblclick(50, 30);
    expect(view.enteredGroup).toBe("k");
    expect(told()).toEqual([["t", "lf-activate"]]);
  });
});
