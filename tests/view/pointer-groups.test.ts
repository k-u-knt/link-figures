import type { UndoStep } from "../../src/registry/command";
import { registriesWithDrawing, runCommandWith } from "./command-runner";
import { createDocument, fileNodeDefaults, groupNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { DocumentStore } from "../../src/model/store";
import type { Document, Node, NodeId } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { isAddingToSelection, PointerController } from "../../src/view/pointer";
import { Platform } from "obsidian";
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
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientX: number, clientY: number, extra: object = {}) =>
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
  return { view, overlay, ran, pointer, click, dblclick, drag, key, nodeOf, told };
}

// On a, on c, on x, and on empty paper inside h's box (between a, b and c), and far from everything.
const ON_A: [number, number] = [50, 30];
const ON_C: [number, number] = [50, 120];
const ON_X: [number, number] = [320, 320];
const IN_H: [number, number] = [130, 80];
const PAPER: [number, number] = [400, 600];

describe("Cmd-click (Mac) and Ctrl-click (elsewhere) add to the selection, as Shift-click does", () => {
  afterEach(() => {
    Platform.isMacOS = false;
  });

  test("elsewhere, a Ctrl-click on x adds it to h, and a second takes it away", () => {
    const { view, click } = setup(nested());
    click(...ON_A);
    click(...ON_X, { ctrlKey: true });
    expect([...view.selection.ids].sort()).toEqual(["h", "x"]);
    click(...ON_X, { ctrlKey: true });
    expect(view.selection.ids).toEqual(["h"]);
  });

  test("on a Mac, a Cmd-click on x adds it to h", () => {
    Platform.isMacOS = true;
    const { view, click } = setup(nested());
    click(...ON_A);
    click(...ON_X, { metaKey: true });
    expect([...view.selection.ids].sort()).toEqual(["h", "x"]);
  });

  test("on a Mac, Cmd held while sweeping empty paper keeps what was selected", () => {
    Platform.isMacOS = true;
    const { view, click, pointer } = setup(nested());
    click(...ON_X);
    pointer("pointerdown", ...PAPER, { metaKey: true });
    pointer("pointermove", 450, 650, { metaKey: true });
    pointer("pointerup", 450, 650, { metaKey: true });
    expect(view.selection.ids).toEqual(["x"]);
  });

  test("elsewhere, Cmd (the Windows key) does not add: a click selects x alone", () => {
    const { view, click } = setup(nested());
    click(...ON_A);
    click(...ON_X, { metaKey: true });
    expect(view.selection.ids).toEqual(["x"]);
  });
});

describe("isAddingToSelection", () => {
  test("Shift on every platform; Cmd on a Mac; Ctrl elsewhere", () => {
    const none = { shiftKey: false, metaKey: false, ctrlKey: false };
    expect(isAddingToSelection({ ...none, shiftKey: true }, false)).toBe(true);
    expect(isAddingToSelection({ ...none, shiftKey: true }, true)).toBe(true);
    expect(isAddingToSelection({ ...none, metaKey: true }, true)).toBe(true);
    expect(isAddingToSelection({ ...none, ctrlKey: true }, true)).toBe(false);
    expect(isAddingToSelection({ ...none, ctrlKey: true }, false)).toBe(true);
    expect(isAddingToSelection({ ...none, metaKey: true }, false)).toBe(false);
    expect(isAddingToSelection(none, false)).toBe(false);
  });
});

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

  test("a shift-press on empty paper outside the entered group leaves it, and keeps the selection as top-level units", () => {
    const { view, pointer, dblclick } = setup(nested());
    dblclick(...ON_C);
    expect(view.selection.ids).toEqual(["c"]);
    pointer("pointerdown", ...PAPER, { shiftKey: true });
    expect(view.enteredGroup).toBe(null);
    expect(view.selection.ids).toEqual(["h"]);
    pointer("pointermove", 290, 290, { shiftKey: true });
    pointer("pointerup", 290, 290, { shiftKey: true });
    expect(view.selection.ids).toEqual(["h", "x"]);
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

describe("the selection after a store change is of units at the entered level", () => {
  /** What `group.ungroup` does to `id`: its members take its parent, it goes, and they are selected. */
  const ungroup = (view: ReturnType<typeof setup>["view"], id: string) => {
    const members = view.store.doc.nodes.filter((n) => n.parent === id).map((n) => n.id);
    view.store.commit("group.ungroup", (d) => {
      const parent = d.nodes.find((n) => n.id === id)!.parent;
      for (const n of d.nodes) if (n.parent === id) n.parent = parent;
      d.nodes = d.nodes.filter((n) => n.id !== id);
    });
    view.selection.set(members);
    return members;
  };

  test("ungroup h (holding g and c), then undo: the selection is h again, not g and c", () => {
    const { view, click, overlay } = setup(nested());
    click(...ON_A);
    expect(view.selection.ids).toEqual(["h"]);
    expect(ungroup(view, "h")).toEqual(["c", "g"]);
    view.store.undo();
    expect(view.selection.ids).toEqual(["h"]);
    expect(overlay.children.filter((c) => c.classes.includes("lf-selected"))).toHaveLength(1);
    view.store.redo();
    expect(view.selection.ids).toEqual([]);
  });

  test("ungroup a two-member group, then undo: the selection is the group", () => {
    const { view, click } = setup((d) => {
      file(d, { id: "p", x: 10, y: 300, z: 0, parent: "pq" });
      file(d, { id: "q", x: 150, y: 300, z: 1, parent: "pq" });
      group(d, "pq");
    });
    click(30, 310);
    expect(view.selection.ids).toEqual(["pq"]);
    ungroup(view, "pq");
    expect(view.selection.ids).toEqual(["p", "q"]);
    view.store.undo();
    expect(view.selection.ids).toEqual(["pq"]);
  });

  test("the entered group itself (g, inside h), when selected, stays selected after a store change", () => {
    const { view, dblclick } = setup(nested());
    dblclick(...ON_A);
    dblclick(...ON_A);
    expect(view.enteredGroup).toBe("g");
    view.selection.set(["g"]);
    view.store.commit("touch", (d) => { d.nodes.find((n) => n.id === "x")!.x = 301; });
    expect(view.selection.ids).toEqual(["g"]);
  });

  test("inside an entered group the selection is mapped to its direct children, in order and once each", () => {
    const { view, dblclick } = setup(nested());
    dblclick(...ON_A);
    expect(view.enteredGroup).toBe("h");
    view.selection.set(["c", "a", "b"]);
    view.store.commit("touch", (d) => { d.nodes.find((n) => n.id === "x")!.x = 301; });
    expect(view.selection.ids).toEqual(["c", "g"]);
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

  test("a group is not changed during its resize drag, which is outlined; the release scales its members in one undo step", () => {
    const { view, overlay, ran, pointer, dblclick, nodeOf } = setup(nested());
    dblclick(...ON_A);
    const before = view.store.doc;
    ran.length = 0;
    const previews = () => overlay.children.filter((c) => c.classes.includes("lf-draw-preview"));
    pointer("pointerdown", 250, 40);
    pointer("pointermove", 370, 40);
    pointer("pointermove", 490, 40);
    expect(view.store.doc).toBe(before);
    expect(ran).toEqual([]);
    expect(previews()).toHaveLength(1);
    expect(previews()[0].style).toMatchObject({ left: "10px", top: "20px", width: "480px", height: "40px" });
    pointer("pointerup", 490, 40);
    expect(previews()).toHaveLength(0);
    expect(ran).toEqual(["node.update"]);
    expect(nodeOf("b")).toMatchObject({ x: 290, width: 200 });
    view.store.undo();
    expect(view.store.doc.nodes).toEqual(before.nodes);
    expect(view.store.undo()).toBe(false);
  });

  test("a group's resize drag taken far left and back to its start size leaves its members as they were", () => {
    const { view, pointer, dblclick, nodeOf } = setup(nested());
    dblclick(...ON_A);
    const a = { ...nodeOf("a") };
    const b = { ...nodeOf("b") };
    pointer("pointerdown", 250, 40);
    pointer("pointermove", 0, 40);
    pointer("pointermove", -200, 40);
    pointer("pointermove", 120, 40);
    pointer("pointerup", 250, 40);
    expect(nodeOf("a")).toEqual(a);
    expect(nodeOf("b")).toEqual(b);
    expect(view.store.canUndo()).toBe(false);
  });

  test("Escape or a cancelled pointer during a group's resize leaves the document as it was, and the outline goes", () => {
    const { view, overlay, pointer, dblclick, key } = setup(nested());
    dblclick(...ON_A);
    const before = view.store.doc;
    const previews = () => overlay.children.filter((c) => c.classes.includes("lf-draw-preview"));
    pointer("pointerdown", 250, 40);
    pointer("pointermove", 490, 40);
    key("Escape");
    pointer("pointerup", 490, 40);
    expect(view.store.doc).toBe(before);
    expect(previews()).toHaveLength(0);
    expect(view.enteredGroup).toBe("h");
    pointer("pointerdown", 250, 40);
    pointer("pointermove", 490, 40);
    pointer("pointercancel", 490, 40);
    expect(view.store.doc).toBe(before);
    expect(previews()).toHaveLength(0);
  });

  test("Shift keeps a group's aspect as it is resized", () => {
    const { pointer, dblclick, nodeOf } = setup(nested());
    dblclick(...ON_A);
    // g is 240 × 40; its south-east handle, at (250, 60), dragged to twice the width.
    pointer("pointerdown", 250, 60, { shiftKey: true });
    pointer("pointermove", 490, 60, { shiftKey: true });
    pointer("pointerup", 490, 60, { shiftKey: true });
    expect(nodeOf("g")).toMatchObject({ x: 10, y: 20, width: 480, height: 80 });
    expect(nodeOf("a")).toMatchObject({ width: 200, height: 80 });
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

describe("a member's own lock (spec §8.1)", () => {
  const aLocked = (d: Document) => {
    nested()(d);
    d.nodes.find((n) => n.id === "a")!.locked = true;
  };

  test("a drag from a locked member of an unlocked group, at top level, moves the group, the member with it", () => {
    const { view, drag, nodeOf } = setup(aLocked);
    drag(ON_A, [ON_A[0] + 10, ON_A[1] + 10]);
    expect(view.selection.ids).toEqual(["h"]);
    expect(["a", "b", "c"].map((id) => [nodeOf(id).x, nodeOf(id).y])).toEqual([[20, 30], [160, 30], [20, 110]]);
  });

  test("locked by node.update after the group was dragged by another member, a drag from it still moves the group", () => {
    const { view, drag, nodeOf, ran } = setup(nested());
    const ON_B: [number, number] = [200, 30];
    drag(ON_B, [ON_B[0] + 10, ON_B[1]]);
    expect(view.selection.ids).toEqual(["h"]);
    view.store.commit("lock", (d) => { d.nodes.find((n) => n.id === "a")!.locked = true; });
    ran.length = 0;
    drag([ON_A[0] + 10, ON_A[1]], [ON_A[0] + 20, ON_A[1]]);
    expect(view.selection.ids).toEqual(["h"]);
    expect(["a", "b", "c"].map((id) => nodeOf(id).x)).toEqual([30, 170, 30]);
  });

  test("inside the entered group, a drag from the locked member moves nothing: it sweeps a marquee", () => {
    const { view, dblclick, drag, nodeOf } = setup(aLocked);
    dblclick(...ON_A);
    dblclick(...ON_A);
    expect(view.enteredGroup).toBe("g");
    drag(ON_A, [ON_A[0] + 10, ON_A[1] + 10]);
    expect(nodeOf("a")).toMatchObject({ x: 10, y: 20 });
    expect(nodeOf("b")).toMatchObject({ x: 150, y: 20 });
    expect(view.store.canUndo()).toBe(false);
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

describe("a group of placeholders (check 11)", () => {
  /** g = {p1, p2}: two items of a type no plugin registers, p1 (10, 20)–(110, 60) and p2 (150, 20)–(250, 60). */
  const placeholders = (d: Document) => {
    const foreign = (id: string, x: number, z: number) =>
      d.nodes.push({ id, type: "x.chart", page: d.pages[0].id, x, y: 20, width: 100, height: 40, z, rotation: 0, opacity: 1, locked: false, parent: "g", series: [1] } as unknown as Node);
    foreign("p1", 10, 0);
    foreign("p2", 150, 1);
    group(d, "g");
  };

  test("a drag of the selected group moves both members", () => {
    const { view, click, drag, nodeOf } = setup(placeholders);
    click(...ON_A);
    expect(view.selection.ids).toEqual(["g"]);
    drag(ON_A, [90, 70]);
    expect(nodeOf("p1")).toMatchObject({ x: 50, y: 60 });
    expect(nodeOf("p2")).toMatchObject({ x: 190, y: 60 });
    expect(nodeOf("g")).toMatchObject({ x: 50, y: 60 });
  });

  test("a drag that starts on a member of the group, not yet selected, moves it too", () => {
    const { drag, nodeOf } = setup(placeholders);
    drag(ON_A, [90, 70]);
    expect(nodeOf("p1")).toMatchObject({ x: 50, y: 60 });
    expect(nodeOf("p2")).toMatchObject({ x: 190, y: 60 });
  });

  test("unreadable members: a drag of the selected group moves both by their boxes, and their type's hooks are not called", () => {
    const { view, click, drag, nodeOf } = setup(placeholders);
    const translate = vi.fn((n: Node) => n);
    view.plugin.registries.nodeTypes.register({ type: "x.chart", name: "Chart", icon: "x", mount: () => ({ update() {}, unmount() {} }), bounds: (n: Node) => n, inspector: () => [], toSvg: () => "", translate, hitTest: () => false } as never);
    // As the figure view holds them: its `unreadableNodes` is its store's own set.
    for (const id of ["p1", "p2"]) view.store.unreadable.add(id);
    (view as unknown as { unreadableNodes: Set<NodeId> }).unreadableNodes = view.store.unreadable;
    click(...ON_A);
    expect(view.selection.ids).toEqual(["g"]);
    drag(ON_A, [90, 70]);
    expect(nodeOf("p1")).toMatchObject({ x: 50, y: 60 });
    expect(nodeOf("p2")).toMatchObject({ x: 190, y: 60 });
    expect(translate).not.toHaveBeenCalled();
  });
});
