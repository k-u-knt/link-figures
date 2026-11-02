import { createApi } from "../../src/api";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import { mmToPx, type PlacePoint } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import { DocumentStore } from "../../src/model/store";
import type { Document, Node, ShapeNode } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import type { CommandContext, DragTargets } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";
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
    plugin: { registries: createRegistries() },
    viewOption: () => undefined,
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

// Drag tools: the Rectangle and Ellipse tools with the real commands, through a view that does what the figure view does
// (`placeToolDrag` disarms and then calls the tool; `runCommandById` with args runs the call as the API runs it on an
// open figure).

function drawingRegistries(): Registries {
  const registries = createRegistries();
  registries.nodeTypes.register(shapeNodeType);
  registries.nodeTypes.register(connectorNodeType);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  for (const route of builtinRoutes) registries.routes.register(route);
  for (const cap of builtinCapKinds) registries.caps.register(cap);
  for (const paint of builtinPaintTypes) registries.paints.register(paint);
  for (const command of drawingCommands()) registries.commands.register(command);
  return registries;
}

function drawSetup(toolId: string) {
  const registries = drawingRegistries();
  const doc = createDocument("a4-portrait");
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  doc.pages.forEach((page, i) => (page.id = `pg-${i + 1}`));
  let t = 0;
  const store = createFigureStore(doc, registries, () => (t += 10_000));
  const labels: string[] = [];
  store.subscribe((ev) => {
    if (ev.kind === "commit") labels.push(ev.label);
  });
  const pending: Promise<unknown>[] = [];
  const view: any = {
    file: null,
    store,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    plugin: { registries },
    options: new Map<string, unknown>(),
    viewOption: (key: string) => view.options.get(key),
    setViewOption: (key: string, value: unknown) => view.options.set(key, value),
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: () => undefined },
    pageLayer: { overlayHost: () => { throw new Error("no overlay"); } },
    armedTool: registries.commands.get(toolId)!,
    selectedIds: () => [...view.selection.ids],
    setSelection: (ids: string[]) => view.selection.set(ids),
    currentPage: () => store.doc.pages[0],
    armTool: () => {},
    disarmTool: () => void (view.armedTool = null),
    commandContext: (): CommandContext => ({ app: {} as never, registries, view, store, selection: view.selectedIds(), page: store.doc.pages[0] }),
    placeToolDrag: (from: PlacePoint, to: PlacePoint, mods: { shift: boolean }, targets: DragTargets) => {
      const tool = view.armedTool;
      view.disarmTool();
      tool.placeDrag(view.commandContext(), from, to, mods, targets);
    },
    toolPreview: (from: PlacePoint | null, to: PlacePoint, targets: DragTargets) => view.armedTool?.preview?.(view.commandContext(), from, to, targets) ?? null,
    runCommandById: (id: string, args?: Record<string, unknown>) => {
      pending.push(runCall(store, view.commandContext(), prepareCall(registries, { id, args })));
    },
  };
  const stage = new FakeStage();
  new PointerController(view as never).attach(stage as never);
  const pointer = (type: string, clientX: number, clientY: number, shiftKey = false) => {
    const ev = { pointerId: 1, isPrimary: true, button: 0, shiftKey, clientX, clientY, target: {}, preventDefault: vi.fn() };
    stage.fire(type, ev);
    return ev;
  };
  /** Presses at `from`, moves through to `to` and releases there; the edit it makes is in once this resolves. */
  const drag = async (from: [number, number], to: [number, number], shift = false) => {
    pointer("pointerdown", ...from);
    pointer("pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, shift);
    pointer("pointermove", ...to, shift);
    pointer("pointerup", ...to, shift);
    await Promise.all(pending);
  };
  const shapes = () => store.doc.nodes.filter((n): n is ShapeNode => n.type === "shape");
  return { registries, doc, store, view, stage, labels, drag, pointer, shapes };
}

/** A node as the document has it, less its id (which is new each time). */
const withoutId = ({ id: _id, ...rest }: Node) => rest;

test("the Rectangle and Ellipse tools are toolbar tools of the insert group", () => {
  const registries = drawingRegistries();
  for (const [id, name, icon] of [["tool.rect", "Rectangle", "square"], ["tool.ellipse", "Ellipse", "circle"]]) {
    const tool = registries.commands.get(id)!;
    expect(tool).toMatchObject({ name, icon, group: "insert", needsView: true });
    expect(tool.hidden).toBeFalsy();
    expect(tool.placeDrag).toBeTypeOf("function");
  }
});

test("a drag with the Rectangle tool creates the dragged box by shape.create, selects it, and disarms the tool", async () => {
  const { stage, view, labels, drag, shapes, doc } = drawSetup("tool.rect");
  // Up and to the left: the box is the same whichever way the drag went.
  await drag([300, 200], [100, 120]);
  expect(labels).toEqual(["shape.create"]);
  const [shape] = shapes();
  expect(shape).toMatchObject({ kind: "rect", page: doc.pages[0].id, x: 100, y: 120, width: 200, height: 80 });
  expect(view.selection.ids).toEqual([shape.id]);
  expect(view.armedTool).toBeNull();
  expect(stage.setPointerCapture).toHaveBeenCalledWith(1);
  expect(stage.focused).toBe(0);
  // One undo step takes it away.
  view.store.undo();
  expect(shapes()).toEqual([]);
});

test("with Shift held, the drag gives a square (a circle with the Ellipse tool)", async () => {
  const { drag, shapes } = drawSetup("tool.ellipse");
  await drag([100, 100], [160, 300], true);
  expect(shapes()[0]).toMatchObject({ kind: "ellipse", x: 100, y: 100, width: 200, height: 200 });
});

test("a click (3 screen px or less) gives a 30 × 20 mm shape centred on the point", async () => {
  const { drag, shapes, view } = drawSetup("tool.rect");
  // At zoom 2, 3 screen px is 1.5 page px: still a click.
  view.viewport.zoom = 2;
  await drag([400, 400], [403, 400]);
  const [shape] = shapes();
  expect(shape.width).toBeCloseTo(mmToPx(30), 2);
  expect(shape.height).toBeCloseTo(mmToPx(20), 2);
  expect(shape.x + shape.width / 2).toBeCloseTo(200, 1);
  expect(shape.y + shape.height / 2).toBeCloseTo(200, 1);
});

test("a release on another page, or off every page, is clamped to the press page", async () => {
  const { drag, shapes, doc } = drawSetup("tool.rect");
  const page = doc.pages[0];
  // Onto the second page, below the first, and out to the right beyond the paper.
  await drag([100, 100], [mmToPx(page.width) + 500, mmToPx(page.height + 40)]);
  expect(shapes()[0]).toMatchObject({ page: page.id, x: 100, y: 100 });
  expect(shapes()[0].width).toBeCloseTo(mmToPx(page.width) - 100, 2);
  expect(shapes()[0].height).toBeCloseTo(mmToPx(page.height) - 100, 2);
});

test("a press off every page disarms the drag tool and draws nothing", async () => {
  const { drag, shapes, view, labels, doc } = drawSetup("tool.rect");
  await drag([50, mmToPx(doc.pages[0].height + 10)], [200, 200]);
  expect(view.armedTool).toBeNull();
  expect(shapes()).toEqual([]);
  expect(labels).toEqual([]);
});

test("UI = API: the tool's shape is the shape that shape.create makes through the API with the same arguments", async () => {
  const ui = drawSetup("tool.ellipse");
  await ui.drag([120, 80], [20, 260]);
  const drawn = ui.shapes()[0];

  const apiSide = drawSetup("tool.ellipse");
  const view = { store: apiSide.store, commandContext: () => apiSide.view.commandContext() };
  const api = createApi({ app: {} as never, registries: apiSide.registries, files: {} as never, normalizePath: (p) => p, openFigure: () => view });
  const { id } = (await api.run("fig.lnkfig.md", "shape.create", { kind: "ellipse", page: apiSide.doc.pages[0].id, x: 20, y: 80, width: 100, height: 180 })) as { id: string };
  const made = apiSide.store.doc.nodes.find((n) => n.id === id)!;

  expect(withoutId(drawn)).toEqual(withoutId(made));
  expect(apiSide.view.selection.ids).toEqual([id]);
});
