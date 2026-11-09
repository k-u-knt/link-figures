import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { MIN_NODE_PX } from "../../src/constants";
import { connectorNodeDefaults, createDocument, createPage, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { pageOriginsPx } from "../../src/model/geometry";
import { scaleUnits } from "../../src/model/groups";
import { createFigureStore } from "../../src/model/normalise";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import { CommandError, type CommandContext } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";

function registries() {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  for (const c of drawingCommands()) r.commands.register(c);
  for (const c of groupCommands()) r.commands.register(c);
  registerBuiltinCommands({ registries: r, addCommand: (c: unknown) => c, activeFigureView: () => null } as never);
  return r;
}

const page = createPage("a4-portrait", []);
const other = createPage("a4-portrait", [page.id]);
type Extra = { parent?: string; page?: string; locked?: boolean; width?: number; height?: number };
const shape = (id: string, x: number, y: number, z: number, extra: Extra = {}): Node => ({
  ...shapeNodeDefaults(page, { id, x, y, width: 10, height: 10, z }, []),
  ...extra,
});
const grp = (id: string, extra: { parent?: string; locked?: boolean } = {}): Node => ({ ...groupNodeDefaults(page, { id }, []), ...extra });
const line = (id: string, ends: [End, End], z: number, extra: { parent?: string } = {}): Node => ({
  ...connectorNodeDefaults(page, { id, ends, z }, []),
  ...extra,
});
const attached = (node: string): End => ({ kind: "attached", node, snap: "center" });
const free = (x: number, y: number): End => ({ kind: "free", x, y });
const make = (nodes: Node[]): Document => ({ ...createDocument("a4-portrait"), pages: [page, other], nodes });
const at = (doc: Document, id: string) => doc.nodes.find((n) => n.id === id) as Node;

function setup(nodes: Node[]) {
  const r = registries();
  const store = createFigureStore(make(nodes), r);
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: null, store, selection: [], page: undefined });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  return { r, store, call };
}

/** g = {a, b, h = {c, d}}, with x outside. */
const nested = (extra: { aLocked?: boolean; gLocked?: boolean } = {}) => [
  shape("a", 0, 0, 0, { parent: "g", locked: extra.aLocked }),
  shape("b", 20, 0, 1, { parent: "g" }),
  shape("c", 40, 0, 2, { parent: "h" }),
  shape("d", 60, 0, 3, { parent: "h" }),
  grp("h", { parent: "g" }),
  grp("g", { locked: extra.gLocked }),
  shape("x", 100, 100, 4),
];

describe("node.move on groups", () => {
  test("moving a group moves every descendant, a locked member too", async () => {
    const { store, call } = setup(nested({ aLocked: true }));
    await call("node.move", { ids: ["g"], dx: 10, dy: 0 });
    expect(["a", "b", "c", "d"].map((id) => at(store.doc, id).x)).toEqual([10, 30, 50, 70]);
    expect(at(store.doc, "g").x).toBe(10);
    expect(at(store.doc, "x").x).toBe(100);
  });
  test("a member locked itself is not moved alone", async () => {
    const { store, call } = setup(nested({ aLocked: true }));
    await call("node.move", { ids: ["a"], dx: 10, dy: 0 });
    expect(at(store.doc, "a").x).toBe(0);
  });
  test("a locked group, and a member of one, do not move", async () => {
    const { store, call } = setup(nested({ gLocked: true }));
    await call("node.move", { ids: ["g"], dx: 10, dy: 0 });
    await call("node.move", { ids: ["b"], dx: 10, dy: 0 });
    expect(at(store.doc, "a").x).toBe(0);
    expect(at(store.doc, "b").x).toBe(20);
    expect(store.canUndo()).toBe(false);
  });
  test("a connector member attached to an outside item keeps that end on it; its free end moves", async () => {
    const { store, call } = setup([
      shape("a", 0, 0, 0, { parent: "g" }),
      line("c", [attached("x"), free(50, 50)], 1, { parent: "g" }),
      grp("g"),
      shape("x", 200, 200, 2),
    ]);
    await call("node.move", { ids: ["g"], dx: 10, dy: 0 });
    const c = at(store.doc, "c") as ConnectorNode;
    expect(c.ends[0]).toEqual(attached("x"));
    expect(c.ends[1]).toEqual(free(60, 50));
    // The group's box takes in the connector as it now resolves (Review Focus 1).
    const g = at(store.doc, "g");
    expect(g.x + g.width).toBe(c.x + c.width);
    expect(g.y + g.height).toBe(c.y + c.height);
    expect(c.x + c.width).toBeGreaterThan(200);
  });
  test("a group dragged so its centre is over page 2 takes every descendant there, at the same canvas place", async () => {
    const { store, call } = setup(nested());
    const origins = pageOriginsPx(store.doc);
    const from = origins.get(page.id)!;
    const to = origins.get(other.id)!;
    await call("node.move", { ids: ["g"], dx: to.x - from.x, dy: to.y - from.y + 5, pages: true });
    for (const id of ["a", "b", "c", "d", "h", "g"]) expect(at(store.doc, id).page).toBe(other.id);
    expect(["a", "b", "c", "d"].map((id) => [at(store.doc, id).x, at(store.doc, id).y])).toEqual([[0, 5], [20, 5], [40, 5], [60, 5]]);
    expect(at(store.doc, "x").page).toBe(page.id);
  });
});

describe("a member moved alone across the page boundary", () => {
  const twoMembers = () => [shape("a", 0, 0, 0, { parent: "g" }), shape("b", 40, 0, 1, { parent: "g" }), grp("g")];
  const offset = (doc: Document) => {
    const origins = pageOriginsPx(doc);
    const round = (v: number) => Math.round(v * 100) / 100;
    return { x: round(origins.get(other.id)!.x - origins.get(page.id)!.x), y: round(origins.get(other.id)!.y - origins.get(page.id)!.y) };
  };
  test("stays on its group's page at the canvas place it was dropped", async () => {
    const { store, call } = setup(twoMembers());
    const d = offset(store.doc);
    await call("node.move", { ids: ["b"], dx: d.x, dy: d.y + 5 });
    expect(at(store.doc, "b")).toMatchObject({ page: page.id, x: 40 + d.x, y: d.y + 5 });
    expect(at(store.doc, "g").page).toBe(page.id);
  });
  test("the member that decides the group's page leaves the others and the group where they are", async () => {
    const { store, call } = setup(twoMembers());
    const d = offset(store.doc);
    await call("node.move", { ids: ["a"], dx: d.x, dy: d.y + 5 });
    expect(at(store.doc, "a")).toMatchObject({ page: page.id, y: d.y + 5 });
    expect(at(store.doc, "b")).toMatchObject({ page: page.id, x: 40, y: 0 });
    expect(at(store.doc, "g").page).toBe(page.id);
  });
});

describe("delete, duplicate and restack on groups", () => {
  test("deleting a group deletes its descendants in one undo step", async () => {
    const { store, call } = setup(nested({ aLocked: true }));
    await call("delete", { ids: ["g"] });
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["x"]);
    store.undo();
    expect(store.doc.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d", "g", "h", "x"]);
    expect(store.canUndo()).toBe(false);
  });
  test("a locked group is not deleted", async () => {
    const { store, call } = setup(nested({ gLocked: true }));
    await call("delete", { ids: ["g"] });
    await call("delete", { ids: ["b"] });
    expect(store.doc.nodes).toHaveLength(7);
  });
  test("duplicating a group copies it with new ids, remapped parents and connector ends", async () => {
    const { store, call } = setup([
      shape("a", 0, 0, 0, { parent: "g" }),
      shape("b", 40, 0, 1, { parent: "g" }),
      line("c", [attached("a"), attached("b")], 2, { parent: "g" }),
      grp("g"),
    ]);
    const { ids } = (await call("duplicate", { ids: ["g"] })) as { ids: string[] };
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(["a", "b", "c", "g"]).not.toContain(id);
    const copies = ids.map((id) => at(store.doc, id));
    const group = copies.find((n) => n.type === "group")!;
    expect(group.parent).toBeUndefined();
    for (const n of copies) if (n !== group) expect(n.parent).toBe(group.id);
    const conn = copies.find((n) => n.type === "connector") as ConnectorNode;
    const shapes = copies.filter((n) => n.type === "shape").map((n) => n.id);
    expect(conn.ends.map((e) => (e.kind === "attached" ? e.node : null)).sort()).toEqual([...shapes].sort());
    expect(at(store.doc, "a").parent).toBe("g");
  });
  test("a member duplicated alone joins its own group", async () => {
    const { store, call } = setup(nested());
    const { ids } = (await call("duplicate", { ids: ["c"] })) as { ids: string[] };
    expect(at(store.doc, ids[0]).parent).toBe("h");
  });
  test("bring-forward on a group raises its whole block above the next unit, keeping member order", async () => {
    const { store, call } = setup([
      shape("a", 0, 0, 0, { parent: "g" }),
      shape("x", 0, 0, 1),
      shape("b", 0, 0, 2, { parent: "g" }),
      shape("y", 0, 0, 3),
      grp("g"),
    ]);
    await call("bring-forward", { ids: ["g"] });
    const order = store.doc.nodes.filter((n) => n.type !== "group").sort((p, q) => p.z - q.z).map((n) => n.id);
    expect(order).toEqual(["x", "y", "a", "b"]);
  });
  test("send-backward on a group lowers its whole block below the previous unit", async () => {
    const { store, call } = setup([
      shape("y", 0, 0, 0),
      shape("a", 0, 0, 1, { parent: "g" }),
      shape("x", 0, 0, 2),
      shape("b", 0, 0, 3, { parent: "g" }),
      grp("g"),
    ]);
    await call("send-backward", { ids: ["g"] });
    const order = store.doc.nodes.filter((n) => n.type !== "group").sort((p, q) => p.z - q.z).map((n) => n.id);
    // g's top is b (above x), so g is the topmost unit: one place down puts it below x, as one block.
    expect(order).toEqual(["y", "a", "b", "x"]);
  });
  test("a member restacked alone moves among its siblings, not out of its group", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 0, 0, 1, { parent: "g" }), grp("g"), shape("x", 0, 0, 2)]);
    await call("bring-forward", { ids: ["b"] });
    expect(store.canUndo()).toBe(false);
    await call("bring-forward", { ids: ["a"] });
    const order = store.doc.nodes.filter((n) => n.type !== "group").sort((p, q) => p.z - q.z).map((n) => n.id);
    expect(order).toEqual(["b", "a", "x"]);
  });
  test("a locked group is not restacked", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 0, 0, 1, { parent: "g" }), grp("g", { locked: true }), shape("x", 0, 0, 2)]);
    await call("bring-forward", { ids: ["g"] });
    expect(store.canUndo()).toBe(false);
  });
});

describe("node.update on a group", () => {
  test("x and y move the members", async () => {
    const { store, call } = setup(nested());
    await call("node.update", { id: "g", patch: { x: 100, y: 7 } });
    expect(["a", "b", "c", "d"].map((id) => [at(store.doc, id).x, at(store.doc, id).y])).toEqual([[100, 7], [120, 7], [140, 7], [160, 7]]);
    expect(at(store.doc, "g")).toMatchObject({ x: 100, y: 7 });
    // A move by less than roundPx keeps is no move at all.
    const steps = store.doc;
    await call("node.update", { id: "g", patch: { x: 100.001 } });
    expect(store.doc).toBe(steps);
  });
  test("width scales the members' x and width about the group's left", async () => {
    const { store, call } = setup([shape("a", 10, 0, 0, { parent: "g" }), shape("b", 30, 0, 1, { parent: "g", height: 20 }), grp("g")]);
    const w = at(store.doc, "g").width;
    await call("node.update", { id: "g", patch: { width: 2 * w } });
    expect(at(store.doc, "a")).toMatchObject({ x: 10, width: 20, height: 10 });
    expect(at(store.doc, "b")).toMatchObject({ x: 50, width: 20, height: 20 });
    expect(at(store.doc, "g")).toMatchObject({ x: 10, width: 2 * w });
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(at(store.doc, "b")).toMatchObject({ x: 30, width: 10 });
  });
  test("name and locked are written; rotation, opacity and z are refused", async () => {
    const { store, call } = setup(nested());
    await call("node.update", { id: "g", patch: { name: "Panel A", locked: true } });
    expect(at(store.doc, "g")).toMatchObject({ name: "Panel A", locked: true });
    for (const patch of [{ rotation: 10 }, { opacity: 0.5 }, { z: 9 }, { fill: { color: "#ff0000" } }]) {
      await expect(call("node.update", { id: "g", patch })).rejects.toThrow(/^node\.update:.*group/);
      await expect(call("node.update", { id: "g", patch })).rejects.toBeInstanceOf(CommandError);
    }
  });
  test("parent is still refused", async () => {
    const { call } = setup(nested());
    await expect(call("node.update", { id: "g", patch: { parent: "x" } })).rejects.toThrow(/group\.add/);
  });
});

describe("scaleUnits", () => {
  test("scales boxes about the origin, keeping the least size, and a connector's free end only", () => {
    const r = registries();
    const doc = make([
      shape("a", 10, 10, 0, { parent: "g" }),
      line("c", [attached("x"), free(30, 30)], 1, { parent: "g" }),
      grp("g"),
      shape("x", 200, 200, 2),
    ]);
    scaleUnits(doc, ["g"], 2, 0.01, { x: 10, y: 10 }, r);
    expect(at(doc, "a")).toMatchObject({ x: 10, y: 10, width: 20, height: MIN_NODE_PX });
    const c = at(doc, "c") as ConnectorNode;
    expect(c.ends[0]).toEqual(attached("x"));
    expect(c.ends[1]).toEqual(free(50, 10.2));
    expect(at(doc, "x")).toMatchObject({ x: 200, width: 10 });
  });
});

describe("normaliser follow-ups", () => {
  test("a connector attached to a member the group normaliser moved to another page is freed in the same commit", () => {
    const { store } = setup([
      shape("b", 20, 0, 0, { parent: "g" }),
      shape("a", 0, 0, 1, { parent: "g" }),
      grp("g"),
      shape("x", 100, 100, 2),
      line("c", [attached("a"), attached("x")], 3),
    ]);
    // b is the lowest member: putting it on page 2 takes the group, and so a, there.
    store.commit("test", (d) => {
      at(d, "b").page = other.id;
    });
    expect(at(store.doc, "a").page).toBe(other.id);
    const c = at(store.doc, "c") as ConnectorNode;
    expect(c.page).toBe(page.id);
    expect(c.ends[0].kind).toBe("free");
    expect(c.ends[1]).toEqual(attached("x"));
  });
  test("a locked group dissolved down to one member leaves that member locked", () => {
    const { store } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g", { locked: true })]);
    store.commit("test", (d) => {
      d.nodes = d.nodes.filter((n) => n.id !== "b");
    });
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(at(store.doc, "a")).toMatchObject({ locked: true });
    expect(at(store.doc, "a").parent).toBeUndefined();
  });
});
