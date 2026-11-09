import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { endAt, snapMarks } from "../../src/model/attach";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Node, NodeId } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";
import { nodeTypeFor, type NodeType } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

const boom = () => {
  throw new Error("bad series");
};

/**
 * Registries with the built-in commands and an "x.chart" type whose migrate hook throws, and whose edit-time hooks
 * (translate, scale, pageAfterMove, completeUpdate, checkField, attachable) are spies that throw: none may be called
 * for an unreadable node.
 */
function registries() {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  for (const c of [...drawingCommands(), ...groupCommands()]) r.commands.register(c);
  const hooks = {
    translate: vi.fn(boom),
    scale: vi.fn(boom),
    pageAfterMove: vi.fn(boom),
    completeUpdate: vi.fn(boom),
    checkField: vi.fn(boom),
    attachable: vi.fn(boom),
  };
  r.nodeTypes.register({
    type: "x.chart",
    name: "Chart",
    icon: "chart",
    mount: () => ({ update() {}, unmount() {} }),
    bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }),
    inspector: () => [],
    toSvg: () => "<g/>",
    ...hooks,
    migrate: boom,
  } as unknown as NodeType);
  return { r, hooks };
}

/** An open figure with an unreadable "x.chart" item `x-1` and a shape `s`, in a view that holds the set. */
function openFigure() {
  const { r, hooks } = registries();
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const chart = { id: "x-1", type: "x.chart", page: page.id, x: 10, y: 10, width: 20, height: 20, z: 0, rotation: 0, opacity: 1, locked: false, series: "bad" };
  const text = serializeFigureFile({ ...doc, nodes: [chart, shapeNodeDefaults(page, { id: "s", x: 50, y: 50, width: 20, height: 20, z: 1 }, [])] as unknown as Node[] }, emptyParsed());
  const loaded = loadDocument(text, r);
  const store = createFigureStore(loaded.doc, r);
  const unreadableNodes = new Set<NodeId>(loaded.unreadable);
  let selection: NodeId[] = [];
  const view = {
    file: { path: "f.lnkfig.md" },
    unreadableNodes,
    markUnreadable: (ids: NodeId[]) => ids.forEach((id) => unreadableNodes.add(id)),
    selectedIds: () => selection,
    setSelection: (ids: NodeId[]) => void (selection = ids),
  };
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: view as never, store, selection, page: store.doc.pages[0] });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const chartNode = () => store.doc.nodes.find((n) => n.id === "x-1") as Node;
  return { r, store, call, hooks, unreadableNodes, chartNode };
}

test("nodeTypeFor: the registered type, but none for an unreadable node", () => {
  const { r, store, unreadableNodes } = openFigure();
  const chart = store.doc.nodes.find((n) => n.id === "x-1") as Node;
  expect(nodeTypeFor(r, chart, unreadableNodes)).toBeUndefined();
  expect(nodeTypeFor(r, chart)?.type).toBe("x.chart");
});

test("node.move of an unreadable item moves its box, without its translate or pageAfterMove", async () => {
  const { call, hooks, chartNode } = openFigure();
  await call("node.move", { ids: ["x-1"], dx: 5, dy: 7 });
  expect(chartNode()).toMatchObject({ x: 15, y: 17 });
  expect(hooks.translate).not.toHaveBeenCalled();
  expect(hooks.pageAfterMove).not.toHaveBeenCalled();
});

test("resizing and moving a group that holds an unreadable item scales and moves its box, without its scale or pageAfterMove", async () => {
  const { call, store, hooks, chartNode } = openFigure();
  const { id } = (await call("group.create", { ids: ["x-1", "s"] })) as { id: NodeId };
  const group = store.doc.nodes.find((n) => n.id === id) as Node;
  await call("node.update", { id, patch: { width: group.width * 2 } });
  expect(chartNode().width).toBe(40);
  await call("node.move", { ids: [id], dx: 3, dy: 0 });
  for (const hook of [hooks.scale, hooks.translate, hooks.pageAfterMove]) expect(hook).not.toHaveBeenCalled();
});

test("node.update of an unreadable item checks and writes the base fields only, without its type's update hooks", async () => {
  const { call, hooks, chartNode } = openFigure();
  await call("node.update", { id: "x-1", patch: { x: 30, width: 25 } });
  expect(chartNode()).toMatchObject({ x: 30, width: 25 });
  expect(hooks.completeUpdate).not.toHaveBeenCalled();
  expect(hooks.checkField).not.toHaveBeenCalled();
});

test("a new connector end attaches to an unreadable item as its box, and its attachable is never called", () => {
  const { r, store, hooks, unreadableNodes } = openFigure();
  const doc = store.doc;
  const page = doc.pages[0].id;
  // The box of x-1 (10, 10, 20 × 20): its "e" anchor is (30, 20).
  expect(endAt(doc, r, page, { x: 29, y: 20 }, ["x-1"], "anchor", undefined, 8, unreadableNodes)).toEqual({ kind: "attached", node: "x-1", snap: "anchor", anchor: "e" });
  expect(snapMarks(doc, r, page, { x: 29, y: 20 }, ["x-1"], "anchor", undefined, 8, unreadableNodes)).toHaveLength(4);
  expect(hooks.attachable).not.toHaveBeenCalled();
});
