import { createApi } from "../../src/api";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes, orthogonalRoute } from "../../src/connectors/builtin";
import { NUDGE_MM } from "../../src/constants";
import { SNAP_MODE_OPTION } from "../../src/model/attach";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { mmToPx, pageOriginsPx, type PlacePoint } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import type { CommandContext, DragTargets, UndoStep } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { roundPx } from "../../src/view/pointer-math";
import { Viewport } from "../../src/view/viewport";

// The Connector tool and a selected connector's handles, with the real commands and node types, through a view that
// does what the figure view does (`placeToolDrag` disarms and then calls the tool; `runCommandById` with args runs the
// call as the API runs it on an open figure). There is no DOM: the stage only records its listeners and what it captures.

class FakeStage {
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  focused = 0;
  addEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, ev: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  setPointerCapture = vi.fn();
  hasPointerCapture = () => false;
  releasePointerCapture = () => {};
  focus = () => void this.focused++;
}

function connectorRegistries(): Registries {
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

/**
 * Shape A at (50, 50) and shape B at (300, 50), each 100 × 80 px: A's `e` anchor is (150, 90), B's `w` anchor (300, 90).
 * A second page, "pg-2", below the first.
 */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  doc.pages[0].id = "pg-1";
  doc.pages[1].id = "pg-2";
  const page = doc.pages[0];
  for (const [id, x] of [["A", 50], ["B", 300]] as const) {
    doc.nodes.push(shapeNodeDefaults(page, { id, kind: "rect", x, y: 50, width: 100, height: 80, z: doc.nodes.length }, doc.nodes.map((n) => n.id)));
  }
  return doc;
}

function setup(armed: string | null = "tool.connector") {
  const registries = connectorRegistries();
  const doc = figure();
  // Commits are stamped as the figure view stamps them, so a drag's moves merge into one undo step.
  let controller: PointerController | null = null;
  const store = createFigureStore(doc, registries, () => controller?.commitTime() ?? Date.now());
  const labels: string[] = [];
  store.subscribe((ev) => {
    if (ev.kind === "commit") labels.push(ev.label);
  });
  const pending: Promise<unknown>[] = [];
  const options = new Map<string, unknown>();
  const view: any = {
    file: null,
    store,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    plugin: { registries },
    viewOption: (key: string) => options.get(key),
    setViewOption: (key: string, value: unknown) => options.set(key, value),
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: () => undefined },
    pageLayer: { overlayHost: () => { throw new Error("no overlay"); } },
    armedTool: armed ? registries.commands.get(armed)! : null,
    selectedIds: () => [...view.selection.ids],
    setSelection: (ids: string[]) => view.selection.set(ids),
    currentPage: () => store.doc.pages[0],
    armTool: (c: unknown) => void (view.armedTool = c),
    disarmTool: () => void (view.armedTool = null),
    commandContext: (): CommandContext => ({ app: {} as never, registries, view, store, selection: view.selectedIds(), page: store.doc.pages[0] }),
    placeToolDrag: (from: PlacePoint, to: PlacePoint, mods: { shift: boolean }, targets: DragTargets) => {
      const tool = view.armedTool;
      view.disarmTool();
      tool.placeDrag(view.commandContext(), from, to, mods, targets);
    },
    toolPreview: (from: PlacePoint | null, to: PlacePoint, targets: DragTargets) => view.armedTool?.preview?.(view.commandContext(), from, to, targets) ?? null,
    runCommandById: (id: string, args?: Record<string, unknown>, step?: UndoStep) => {
      pending.push(runCall(store, view.commandContext(), prepareCall(registries, { id, args }), step));
    },
  };
  const stage = new FakeStage();
  controller = new PointerController(view);
  controller.attach(stage as never);
  const pointer = (type: string, [clientX, clientY]: [number, number]) => {
    const ev = { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, clientX, clientY, target: {}, preventDefault: vi.fn() };
    stage.fire(type, ev);
    return ev;
  };
  /** Presses at `from`, moves through to `to` and releases there; the edit it makes is in once this resolves. */
  const drag = async (from: [number, number], to: [number, number]) => {
    pointer("pointerdown", from);
    pointer("pointermove", [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
    pointer("pointermove", to);
    pointer("pointerup", to);
    await Promise.all(pending);
  };
  const connectors = () => store.doc.nodes.filter((n): n is ConnectorNode => n.type === "connector");
  /** Adds a connector by the API's command, as a script would, and selects it; returns it. */
  const addConnector = async (from: End, to: End, extra: Record<string, unknown> = {}): Promise<ConnectorNode> => {
    await runCall(store, view.commandContext(), prepareCall(registries, { id: "connector.create", args: { page: "pg-1", from, to, ...extra } }));
    labels.length = 0;
    return connectors()[0];
  };
  const key = (name: string) => {
    const ev = { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: {}, preventDefault: vi.fn() };
    stage.fire("keydown", ev);
    return ev;
  };
  return { registries, store, view, stage, labels, options, pointer, drag, key, connectors, addConnector, settled: () => Promise.all(pending) };
}

/** A node as the document has it, less its id (which is new each time). */
const withoutId = ({ id: _id, ...rest }: Node) => rest;

const attached = (node: string, anchor: string): End => ({ kind: "attached", node, snap: "anchor", anchor });

test("the Connector tool and the snap toggle are toolbar commands of the insert group", () => {
  const registries = connectorRegistries();
  const tool = registries.commands.get("tool.connector")!;
  expect(tool).toMatchObject({ name: "Connector", icon: "spline", group: "insert", needsView: true });
  expect(tool.hidden).toBeFalsy();
  expect(tool.placeDrag).toBeTypeOf("function");
  const toggle = registries.commands.get("connector.snap-mode")!;
  expect(toggle).toMatchObject({ group: "insert", needsView: true });
  expect(toggle.hidden).toBeFalsy();
});

test("the snap toggle switches the view's snap mode between anchor and centre, and its button names the current one", () => {
  const { registries, view, options } = setup(null);
  const toggle = registries.commands.get("connector.snap-mode")!;
  expect(toggle.state!(view.commandContext())).toMatchObject({ name: "Connector snap: anchor" });
  toggle.run(view.commandContext());
  expect(options.get(SNAP_MODE_OPTION)).toBe("center");
  expect(toggle.state!(view.commandContext())).toMatchObject({ name: "Connector snap: centre" });
  toggle.run(view.commandContext());
  expect(options.get(SNAP_MODE_OPTION)).toBe("anchor");
  // Headless there is no view to hold the mode.
  expect(toggle.applies({ ...view.commandContext(), view: null })).toBe(false);
});

test("in anchor mode, a drag from shape A to shape B attaches each end to the anchor nearest the press and the release", async () => {
  const { drag, connectors, labels, view, stage } = setup();
  // Near A's right edge, then near B's top edge.
  await drag([140, 85], [340, 60]);
  expect(labels).toEqual(["connector.create"]);
  const [c] = connectors();
  expect(c.ends).toEqual([attached("A", "e"), attached("B", "n")]);
  expect(c.page).toBe("pg-1");
  expect(view.selection.ids).toEqual([c.id]);
  expect(view.armedTool).toBeNull();
  expect(stage.setPointerCapture).toHaveBeenCalledWith(1);
  // One undo step takes it away.
  view.store.undo();
  expect(connectors()).toEqual([]);
});

test("in centre mode the ends attach to the centres", async () => {
  const { drag, connectors, options } = setup();
  options.set(SNAP_MODE_OPTION, "center");
  await drag([140, 85], [340, 60]);
  expect(connectors()[0].ends).toEqual([
    { kind: "attached", node: "A", snap: "center" },
    { kind: "attached", node: "B", snap: "center" },
  ]);
});

test("a press or a release on bare paper gives a free end there; a click draws nothing", async () => {
  const { drag, connectors, view, labels, registries } = setup();
  await drag([140, 90], [500.004, 400]);
  expect(connectors()[0].ends).toEqual([attached("A", "e"), { kind: "free", x: 500, y: 400 }]);

  view.armedTool = registries.commands.get("tool.connector");
  await drag([600, 600], [120, 100]);
  expect(connectors()[1].ends).toEqual([{ kind: "free", x: 600, y: 600 }, attached("A", "e")]);

  view.armedTool = registries.commands.get("tool.connector");
  labels.length = 0;
  await drag([600, 600], [602, 600]);
  expect(labels).toEqual([]);
  expect(view.armedTool).toBeNull();
});

test("while armed, the item under the pointer shows its anchors (its centre in centre mode), and a drag previews the line", () => {
  const { registries, view, options } = setup();
  const tool = registries.commands.get("tool.connector")!;
  const page = view.store.doc.pages[0];
  const ctx = view.commandContext();
  expect(tool.preview!(ctx, null, { page, x: 100, y: 90 }, { from: [], to: ["A"] })).toEqual({
    marks: [{ x: 100, y: 50 }, { x: 150, y: 90 }, { x: 100, y: 130 }, { x: 50, y: 90 }],
  });
  expect(tool.preview!(ctx, null, { page, x: 600, y: 600 }, { from: [], to: [] })).toEqual({ marks: [] });
  options.set(SNAP_MODE_OPTION, "center");
  expect(tool.preview!(ctx, null, { page, x: 100, y: 90 }, { from: [], to: ["A"] })!.marks).toEqual([{ x: 100, y: 90 }]);
  // A drag from A's centre to bare paper: a line from A's edge (centre snap clips at the outline) to the release.
  const drawn = tool.preview!(ctx, { page, x: 100, y: 90 }, { page, x: 400, y: 90 }, { from: ["A"], to: [] })!;
  expect(drawn.path![0]).toMatchObject({ op: "M", x: 150, y: 90 });
});

test("UI = API: the tool's connector is the connector that connector.create makes through the API with the same arguments", async () => {
  const ui = setup();
  await ui.drag([140, 85], [500, 400]);
  const drawn = ui.connectors()[0];

  const apiSide = setup(null);
  const view = { store: apiSide.store, commandContext: () => apiSide.view.commandContext() };
  const api = createApi({ app: {} as never, registries: apiSide.registries, files: {} as never, normalizePath: (p) => p, openFigure: () => view });
  const { id } = (await api.run("fig.lnkfig.md", "connector.create", { page: "pg-1", from: attached("A", "e"), to: { kind: "free", x: 500, y: 400 } })) as { id: string };
  const made = apiSide.store.doc.nodes.find((n) => n.id === id)!;

  expect(withoutId(drawn)).toEqual(withoutId(made));
  expect(apiSide.view.selection.ids).toEqual([id]);
});

test("a selected connector's end handle dragged off its shape frees the end there, by connector.setEnd", async () => {
  const { addConnector, view, drag, connectors, labels } = setup(null);
  const c = await addConnector(attached("A", "e"), attached("B", "w"));
  view.selection.set([c.id]);
  // B's w anchor, where the end handle is drawn.
  await drag([300, 90], [450, 300]);
  expect(labels).toEqual(["connector.setEnd"]);
  expect(connectors()[0].ends).toEqual([attached("A", "e"), { kind: "free", x: 450, y: 300 }]);
  // And back onto B, near its bottom edge: attached again, one more undo step.
  await drag([450, 300], [350, 128]);
  expect(connectors()[0].ends[1]).toEqual(attached("B", "s"));
  expect(labels).toEqual(["connector.setEnd", "connector.setEnd"]);
  view.store.undo();
  expect(connectors()[0].ends[1]).toEqual({ kind: "free", x: 450, y: 300 });
});

test("a selected connector shows its own handles instead of the resize handles", async () => {
  const { addConnector, view, drag, connectors, labels } = setup(null);
  const c = await addConnector({ kind: "free", x: 100, y: 300 }, { kind: "free", x: 300, y: 400 });
  view.selection.set([c.id]);
  const before = structuredClone(connectors()[0]);
  // The box's top-right corner (where a resize handle would be): a press there is on no handle, and off the line it selects nothing.
  await drag([c.x + c.width, c.y], [c.x + c.width + 50, c.y - 50]);
  expect(labels).toEqual([]);
  expect(connectors()[0]).toEqual(before);
});

test("the bend handle of a curved connector sets routeParams.bend, and the middle handle of an orthogonal one routeParams.offset, by node.update", async () => {
  const { addConnector, view, drag, connectors, labels, registries, store } = setup(null);
  const c = await addConnector({ kind: "free", x: 100, y: 300 }, { kind: "free", x: 300, y: 300 }, { route: "curved" });
  view.selection.set([c.id]);
  const ctx = { registries, doc: store.doc, viewOption: () => undefined };
  const bend = connectorNodeType.handles!(c, ctx).find((h) => h.id === "route.bend")!;
  // Bend 0.25 over a 200 px line: the curve's middle is 0.75 × 50 px below it.
  expect(bend).toMatchObject({ x: 200, y: 337.5 });
  // Dragged to 60 px above the line: bend = −60 / (0.75 × 200).
  await drag([bend.x, bend.y], [200, 240]);
  expect(labels).toEqual(["node.update"]);
  expect(connectors()[0].routeParams).toEqual({ bend: -0.4 });

  await runCall(store, view.commandContext(), prepareCall(registries, { id: "node.update", args: { id: c.id, patch: { route: "orthogonal" } } }));
  await runCall(store, view.commandContext(), prepareCall(registries, { id: "connector.setEnd", args: { id: c.id, which: 1, end: { kind: "free", x: 300, y: 500 } } }));
  labels.length = 0;
  const elbow = connectors()[0];
  const middle = connectorNodeType.handles!(elbow, { ...ctx, doc: store.doc }).find((h) => h.id === "route.offset")!;
  // From (100, 300) to (300, 500), offset 0.5: the upright middle segment at x 200.
  expect(middle).toMatchObject({ x: 200, y: 400 });
  await drag([middle.x, middle.y], [250, 380]);
  expect(labels).toEqual(["node.update"]);
  expect(connectors()[0].routeParams).toEqual({ offset: 0.75 });
});

test("a body drag of a connector with both ends attached changes nothing", async () => {
  const { addConnector, view, pointer, connectors, labels, store } = setup(null);
  const c = await addConnector(attached("A", "e"), attached("B", "w"));
  const before = store.doc;
  // On the line between the shapes: it is selected, and dragging it moves neither end.
  pointer("pointerdown", [225, 90]);
  expect(view.selection.ids).toEqual([c.id]);
  pointer("pointermove", [245, 120]);
  pointer("pointerup", [245, 120]);
  expect(labels).toEqual([]);
  expect(store.doc).toBe(before);
  expect(connectors()[0].ends).toEqual([attached("A", "e"), attached("B", "w")]);
});

test("a body drag of a connector with one free end moves only that end, as one undo step", async () => {
  const { addConnector, pointer, connectors, labels, store } = setup(null);
  await addConnector(attached("A", "e"), { kind: "free", x: 350, y: 300 });
  // Half way along the line from (150, 90) to (350, 300).
  pointer("pointerdown", [250, 195]);
  pointer("pointermove", [260, 200]);
  pointer("pointermove", [270, 205]);
  pointer("pointerup", [270, 205]);
  expect(connectors()[0].ends).toEqual([attached("A", "e"), { kind: "free", x: 370, y: 310 }]);
  expect(labels).toEqual(["node.move", "node.move"]);
  store.undo();
  expect(store.canUndo()).toBe(true);
  expect(connectors()[0].ends[1]).toEqual({ kind: "free", x: 350, y: 300 });
});

test("a connector is hit within 4 screen px of its line, and not at 6", async () => {
  const { addConnector, view, pointer } = setup(null);
  const c = await addConnector({ kind: "free", x: 100, y: 500 }, { kind: "free", x: 300, y: 500 }, { caps: [{ kind: "none", size: 3 }, { kind: "none", size: 3 }] });
  const at = (x: number, y: number) => {
    view.selection.clear();
    pointer("pointerdown", [x, y]);
    pointer("pointerup", [x, y]);
    return view.selection.ids;
  };
  expect(at(200, 504)).toEqual([c.id]);
  expect(at(200, 506)).toEqual([]);
  // Screen px: at zoom 2, 4 screen px are 2 page px.
  view.viewport.zoom = 2;
  expect(at(400, 1004)).toEqual([c.id]);
  expect(at(400, 1006)).toEqual([]);
});

test("a connector over a shape is hit only near its line; elsewhere the shape under it is", async () => {
  const { addConnector, view, pointer } = setup(null);
  // Across A, above it in z.
  const c = await addConnector({ kind: "free", x: 40, y: 70 }, { kind: "free", x: 160, y: 70 });
  pointer("pointerdown", [100, 71]);
  pointer("pointerup", [100, 71]);
  expect(view.selection.ids).toEqual([c.id]);
  pointer("pointerdown", [100, 110]);
  pointer("pointerup", [100, 110]);
  expect(view.selection.ids).toEqual(["A"]);
});

test("a body drag that takes a connector's centre over another page keeps it on its page while an end is attached to an item left behind", async () => {
  const { addConnector, drag, connectors, store } = setup(null);
  await addConnector(attached("A", "e"), { kind: "free", x: 350, y: 300 });
  const gap = pageOriginsPx(store.doc).get("pg-2")!.y;
  // Down by twice the second page's offset: the line then runs from A down into the second page, its centre there.
  await drag([250, 195], [250, 195 + 2 * gap]);
  const [c] = connectors();
  const centre = c.y + c.height / 2;
  expect(centre).toBeGreaterThan(gap);
  expect(centre).toBeLessThan(gap + mmToPx(store.doc.pages[1].height));
  expect(c.page).toBe("pg-1");
  expect(c.ends).toEqual([attached("A", "e"), { kind: "free", x: 350, y: roundPx(300 + 2 * gap) }]);
});

test("a body drag of a shape with its connector to the other page takes both, the end still attached", async () => {
  const { addConnector, pointer, connectors, store, view, settled } = setup(null);
  const c = await addConnector(attached("A", "e"), { kind: "free", x: 250, y: 200 });
  const gap = pageOriginsPx(store.doc).get("pg-2")!.y;
  view.selection.set(["A", c.id]);
  pointer("pointerdown", [100, 90]);
  pointer("pointermove", [100, 140]);
  pointer("pointermove", [100, 90 + gap]);
  pointer("pointerup", [100, 90 + gap]);
  await settled();
  const a = store.doc.nodes.find((n) => n.id === "A")!;
  expect(a).toMatchObject({ page: "pg-2", x: 50, y: 50 });
  expect(connectors()[0]).toMatchObject({ page: "pg-2", ends: [attached("A", "e"), { kind: "free", x: 250, y: 200 }] });
  // One undo step takes the whole drag back.
  store.undo();
  expect(store.doc.nodes.find((n) => n.id === "A")).toMatchObject({ page: "pg-1", x: 50, y: 50 });
  expect(connectors()[0]).toMatchObject({ page: "pg-1", ends: [attached("A", "e"), { kind: "free", x: 250, y: 200 }] });
});

test("a shape dragged with its connector onto the other page takes the connector along though the connector's centre stays behind", async () => {
  const { addConnector, pointer, connectors, store, view, settled } = setup(null);
  // From A's east anchor (150, 90) up to near the top of the page: the connector's centre is well above A's.
  const c = await addConnector(attached("A", "e"), { kind: "free", x: 150, y: 5 });
  const gap = pageOriginsPx(store.doc).get("pg-2")!.y;
  const dy = gap - 70;
  view.selection.set(["A", c.id]);
  pointer("pointerdown", [100, 90]);
  pointer("pointermove", [100, 140]);
  pointer("pointermove", [100, 90 + dy]);
  pointer("pointerup", [100, 90 + dy]);
  await settled();
  // A's centre (y 90 + dy) is over the second page; the connector's (about 47 + dy) is over the gap between the pages.
  const a = store.doc.nodes.find((n) => n.id === "A")!;
  expect(a).toMatchObject({ page: "pg-2", y: roundPx(50 + dy - gap) });
  expect(connectors()[0]).toMatchObject({ page: "pg-2", ends: [attached("A", "e"), { kind: "free", x: 150, y: roundPx(5 + dy - gap) }] });
});

test("a connector whose items land on different pages goes by its own centre, and the end on the other page comes free", async () => {
  const { addConnector, connectors, store, view, registries } = setup(null);
  // B lower down, so a move takes B's centre onto the second page and leaves A's on the first.
  store.commit("edit", (d) => {
    d.nodes.find((n) => n.id === "B")!.y = 250;
  });
  const c = await addConnector(attached("A", "e"), attached("B", "w"));
  const gap = pageOriginsPx(store.doc).get("pg-2")!.y;
  const dy = gap - 250;
  await runCall(store, view.commandContext(), prepareCall(registries, { id: "node.move", args: { ids: ["A", "B", c.id], dx: 0, dy } }));
  const page = (id: string) => store.doc.nodes.find((n) => n.id === id)!.page;
  expect([page("A"), page("B")]).toEqual(["pg-1", "pg-2"]);
  // Its centre is over the gap between the pages, so it keeps its page, and A's end stays attached.
  const [moved] = connectors();
  expect(moved.page).toBe("pg-1");
  expect(moved.ends[0]).toEqual(attached("A", "e"));
  expect(moved.ends[1].kind).toBe("free");
});

test("UI = API: a body drag gives the document that node.move gives with the same ids and delta", async () => {
  const ui = setup(null);
  const c = await ui.addConnector(attached("A", "e"), { kind: "free", x: 350, y: 300 }, { id: "C" });
  ui.view.selection.set(["A", c.id]);
  ui.pointer("pointerdown", [100, 90]);
  ui.pointer("pointermove", [117.3, 101]);
  ui.pointer("pointermove", [130.25, 110.5]);
  ui.pointer("pointerup", [130.25, 110.5]);
  await ui.settled();
  expect(ui.labels.every((l) => l === "node.move")).toBe(true);

  const apiSide = setup(null);
  await apiSide.addConnector(attached("A", "e"), { kind: "free", x: 350, y: 300 }, { id: "C" });
  const view = { store: apiSide.store, commandContext: () => apiSide.view.commandContext() };
  const api = createApi({ app: {} as never, registries: apiSide.registries, files: {} as never, normalizePath: (p) => p, openFigure: () => view });
  await api.run("fig.lnkfig.md", "node.move", { ids: ["A", c.id], dx: 30.25, dy: 20.5 });
  expect(ui.store.doc.nodes).toEqual(apiSide.store.doc.nodes);
});

test("arrow keys nudge through node.move, consecutive nudges being one undo step; a connector moves only its free end", async () => {
  const { addConnector, key, connectors, store, view, labels, settled } = setup(null);
  const c = await addConnector(attached("A", "e"), { kind: "free", x: 350, y: 300 });
  view.selection.set(["A", c.id]);
  key("ArrowRight");
  key("ArrowRight");
  await settled();
  const step = mmToPx(NUDGE_MM);
  expect(labels).toEqual(["node.move", "node.move"]);
  expect(store.doc.nodes.find((n) => n.id === "A")!.x).toBeCloseTo(50 + 2 * step, 1);
  expect(connectors()[0].ends[1]).toMatchObject({ kind: "free", y: 300 });
  expect((connectors()[0].ends[1] as { x: number }).x).toBeCloseTo(350 + 2 * step, 1);
  store.undo();
  expect(store.doc.nodes.find((n) => n.id === "A")!.x).toBe(50);
  expect(connectors()[0].ends[1]).toEqual({ kind: "free", x: 350, y: 300 });
});

test("the orthogonal offset handle shows only where offset moves the route: not for an L, nor for a U", () => {
  const dir = (x: number, y: number) => ({ x, y });
  // A Z between two free ends: offset moves its upright middle segment.
  expect(orthogonalRoute.handles!({ pt: { x: 0, y: 0 }, dir: null, lead: 0 }, { pt: { x: 200, y: 100 }, dir: null, lead: 0 }, { offset: 0.5 })).toEqual([{ id: "offset", pt: { x: 100, y: 50 } }]);
  // An L: leaving east, arriving into a north anchor below and to the right.
  expect(orthogonalRoute.handles!({ pt: { x: 0, y: 0 }, dir: dir(1, 0), lead: 0 }, { pt: { x: 200, y: 200 }, dir: dir(0, -1), lead: 0 }, { offset: 0.5 })).toEqual([]);
  // A U: both ends facing east, one above the other; it goes round the far side whatever the offset.
  expect(orthogonalRoute.handles!({ pt: { x: 0, y: 0 }, dir: dir(1, 0), lead: 0 }, { pt: { x: 0, y: 200 }, dir: dir(1, 0), lead: 0 }, { offset: 0.5 })).toEqual([]);
});

test("an end handle dragged beyond the paper looks for an item at the clamped point it is given", async () => {
  const { addConnector, view, drag, connectors } = setup(null);
  // A shape at the paper's right edge, and the end dragged out past the edge level with it.
  const page = view.store.doc.pages[0];
  const right = mmToPx(page.width);
  await runCall(view.store, view.commandContext(), prepareCall(view.plugin.registries, { id: "shape.create", args: { id: "E", page: "pg-1", kind: "rect", x: right - 60, y: 400, width: 60, height: 40 } }));
  const c = await addConnector(attached("A", "e"), { kind: "free", x: 300, y: 300 });
  view.selection.set([c.id]);
  await drag([300, 300], [right + 80, 420]);
  expect(connectors()[0].ends[1]).toEqual(attached("E", "e"));
});
