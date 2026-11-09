import { createApi } from "../../src/api";
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { buildPageSvg } from "../../src/export/svg-builder";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Node, NodeId } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";
import type { NodeType } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { normalizePath } from "../export/fake-vault";

const UNREADABLE = '"x.chart" item skipped: its plugin could not read it';

/** Registries with the built-in commands and an "x.chart" type whose migrate hook throws and whose toSvg is a spy. */
function registries() {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  for (const c of groupCommands()) r.commands.register(c);
  const toSvg = vi.fn(() => "<g/>");
  r.nodeTypes.register({
    type: "x.chart",
    name: "Chart",
    icon: "chart",
    mount: () => ({ update() {}, unmount() {} }),
    bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }),
    inspector: () => [],
    toSvg,
    migrate: () => {
      throw new Error("bad series");
    },
  } as unknown as NodeType);
  return { r, toSvg };
}

/** A figure file with an unreadable "x.chart" item `x-1` and a shape `s`. */
function fileText(): string {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const chart = { id: "x-1", type: "x.chart", page: page.id, x: 10, y: 10, width: 20, height: 20, z: 0, rotation: 0, opacity: 1, locked: false, series: "bad" };
  return serializeFigureFile({ ...doc, nodes: [chart, shapeNodeDefaults(page, { id: "s", x: 50, y: 50, width: 20, height: 20, z: 1 }, [])] as unknown as Node[] }, emptyParsed());
}

/** The figure open in a view that keeps the set as the figure view does (`unreadableNodes`, `markUnreadable`). */
function openFigure() {
  const { r, toSvg } = registries();
  const loaded = loadDocument(fileText(), r);
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
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: view as never, store, selection, page: store.doc.pages[0], unreadable: view.unreadableNodes, markUnreadable: view.markUnreadable });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const exportWarnings = () => buildPageSvg(store.doc, store.doc.pages[0], r, new Map(), { unreadable: unreadableNodes });
  return { r, store, view, call, exportWarnings, toSvg };
}

test("a duplicate of an unreadable item is unreadable too: drawn as a placeholder, skipped by an export", async () => {
  const { store, view, call, exportWarnings, toSvg } = openFigure();
  const { ids } = (await call("duplicate", { ids: ["x-1", "s"] })) as { ids: NodeId[] };
  const [chartCopy, shapeCopy] = ids;
  expect(store.doc.nodes.find((n) => n.id === chartCopy)?.type).toBe("x.chart");
  expect(view.unreadableNodes.has(chartCopy)).toBe(true);
  expect(view.unreadableNodes.has(shapeCopy)).toBe(false);
  const built = exportWarnings();
  expect(built.warnings).toEqual([UNREADABLE]);
  // The two shapes are drawn; neither chart is handed to its type.
  expect(built.drawn).toBe(2);
  expect(toSvg).not.toHaveBeenCalled();
});

test("after undo and redo of the duplicate, the copy is still unreadable", async () => {
  const { store, view, call, exportWarnings, toSvg } = openFigure();
  const { ids } = (await call("duplicate", { ids: ["x-1"] })) as { ids: NodeId[] };
  store.undo();
  expect(store.doc.nodes.some((n) => n.id === ids[0])).toBe(false);
  store.redo();
  expect(store.doc.nodes.some((n) => n.id === ids[0])).toBe(true);
  expect(view.unreadableNodes.has(ids[0])).toBe(true);
  expect(exportWarnings().warnings).toEqual([UNREADABLE]);
  expect(toSvg).not.toHaveBeenCalled();
});

test("a duplicate of a group holding an unreadable item: the item's copy is unreadable", async () => {
  const { store, view, call } = openFigure();
  const { id: group } = (await call("group.create", { ids: ["x-1", "s"] })) as { id: string };
  const { ids } = (await call("duplicate", { ids: [group] })) as { ids: NodeId[] };
  const copy = ids.find((id) => (store.doc.nodes.find((n) => n.id === id)?.type as string | undefined) === "x.chart")!;
  expect(view.unreadableNodes.has(copy)).toBe(true);
});

test("headless, a duplicate is saved as the item was, and is unreadable when the figure is next loaded", async () => {
  const { r } = registries();
  const text = new Map([["f.lnkfig.md", fileText()]]);
  const files = {
    read: async (path: string) => text.get(path)!,
    process: async (path: string, edit: (t: string) => string) => void text.set(path, edit(text.get(path)!)),
  };
  const api = createApi({ app: {} as never, registries: r, files, normalizePath, openFigure: () => null });
  const { ids } = (await api.run("f.lnkfig.md", "duplicate", { ids: ["x-1"] })) as { ids: NodeId[] };
  const loaded = loadDocument(text.get("f.lnkfig.md")!, r);
  expect([...loaded.unreadable].sort()).toEqual([ids[0], "x-1"].sort());
  expect((loaded.doc.nodes.find((n) => n.id === ids[0]) as unknown as { series: unknown }).series).toBe("bad");
});
