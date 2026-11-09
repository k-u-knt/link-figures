import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { connectorNodeDefaults, createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { ConnectorNode, Node, NodeId } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";
import type { NodeType } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

afterEach(() => vi.restoreAllMocks());

type Chart = "unreadable" | "foreign" | "throws";

/**
 * Registries with the built-in commands and node types, and an "x.chart" type as `chart` says: one whose migrate hook
 * throws (its items are unreadable), none at all (its items are foreign), or a readable one whose `attachable` throws.
 */
function registries(chart: Chart, type: string) {
  const r = createRegistries();
  for (const t of [shapeNodeType, groupNodeType, connectorNodeType] as NodeType[]) r.nodeTypes.register(t);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  for (const c of drawingCommands()) r.commands.register(c);
  const attachable = vi.fn(() => {
    throw new Error("bad series");
  });
  if (chart !== "foreign") {
    r.nodeTypes.register({
      type,
      name: "Chart",
      icon: "chart",
      mount: () => ({ update() {}, unmount() {} }),
      bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }),
      inspector: () => [],
      toSvg: () => "<g/>",
      attachable,
      ...(chart === "unreadable"
        ? {
            migrate: () => {
              throw new Error("bad series");
            },
          }
        : {}),
    } as unknown as NodeType);
  }
  return { r, attachable };
}

/**
 * A figure file with an "x.chart" item `x-1`, a shape `s`, and a connector `c` from `x-1` (snapped to its own anchor
 * "tip", which a box does not have) to a free point. The connector's box is as the chart's plugin worked it out, not as
 * its box would give it: a commit that rewrote it would show.
 */
function fileText(type: string): string {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const chart = { id: "x-1", type, page: page.id, x: 10, y: 10, width: 20, height: 20, z: 0, rotation: 0, opacity: 1, locked: false, series: "bad" };
  const shape = shapeNodeDefaults(page, { id: "s", x: 50, y: 50, width: 20, height: 20, z: 1 }, []);
  const connector = connectorNodeDefaults(
    page,
    { id: "c", z: 2, x: 27, y: 18, width: 73, height: 82, ends: [{ kind: "attached", node: "x-1", snap: "anchor", anchor: "tip" }, { kind: "free", x: 100, y: 100 }] },
    [],
  );
  return serializeFigureFile({ ...doc, nodes: [chart, shape, connector] as unknown as Node[] }, emptyParsed());
}

function openFigure(chart: Chart) {
  // Its own type name for the throwing hook: a type's failure is reported once per session, whichever test saw it first.
  const type = chart === "throws" ? "x.throwing" : "x.chart";
  const { r, attachable } = registries(chart, type);
  const text = fileText(type);
  const loaded = loadDocument(text, r);
  const store = createFigureStore(loaded.doc, r);
  const view = { file: { path: "f.lnkfig.md" }, unreadableNodes: new Set<NodeId>(loaded.unreadable), markUnreadable: () => {}, selectedIds: () => [], setSelection: () => {} };
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: view as never, store, selection: [], page: store.doc.pages[0] });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const save = () => serializeFigureFile(store.doc, loaded.parsed);
  const connector = () => store.doc.nodes.find((n) => n.id === "c") as ConnectorNode;
  const original = loaded.doc.nodes.find((n) => n.id === "c") as ConnectorNode;
  return { text, store, call, save, connector, original, attachable, loaded };
}

describe.each(["unreadable", "foreign"] as const)("a connector attached to a %s item", (chart) => {
  test("keeps its end through a commit, and the file round-trips byte for byte", async () => {
    const f = openFigure(chart);
    if (chart === "unreadable") expect([...f.loaded.unreadable]).toEqual(["x-1"]);
    expect(f.save()).toBe(f.text);
    await f.call("node.move", { ids: ["s"], dx: 5, dy: 0 });
    expect(f.connector()).toEqual(f.original);
    await f.call("node.move", { ids: ["s"], dx: -5, dy: 0 });
    expect(f.save()).toBe(f.text);
  });

  test("its stroke can be edited, and its end stays attached", async () => {
    const f = openFigure(chart);
    await f.call("node.update", { id: "c", patch: { stroke: { width: 3 } } });
    expect(f.connector().stroke.width).toBe(3);
    expect(f.connector().ends[0]).toEqual({ kind: "attached", node: "x-1", snap: "anchor", anchor: "tip" });
  });

  test("a new connector can be attached to it, as its box", async () => {
    const f = openFigure(chart);
    const { id } = (await f.call("connector.create", { route: "straight", from: { kind: "attached", node: "x-1", snap: "center" }, to: { kind: "free", x: 200, y: 200 } })) as { id: NodeId };
    expect((f.store.doc.nodes.find((n) => n.id === id) as ConnectorNode).ends[0]).toEqual({ kind: "attached", node: "x-1", snap: "center" });
  });
});

test("an attachable hook that throws breaks no commit: the item is attached to as its box, with one warning per type", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = openFigure("throws");
  await f.call("node.move", { ids: ["s"], dx: 5, dy: 0 });
  await f.call("node.update", { id: "c", patch: { stroke: { width: 3 } } });
  expect(f.attachable).toHaveBeenCalled();
  expect(f.connector().ends[0]).toEqual({ kind: "attached", node: "x-1", snap: "anchor", anchor: "tip" });
  expect(warn.mock.calls.filter((c) => String(c[0]).includes("x.throwing"))).toHaveLength(1);
});
