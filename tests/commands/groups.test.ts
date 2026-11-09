import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { drawingCommands } from "../../src/commands/drawing";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { createDocument, createPage, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Document, Node } from "../../src/model/types";
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
  return r;
}

const page = createPage("a4-portrait", []);
const other = createPage("a4-portrait", [page.id]);
const shape = (id: string, x: number, y: number, z: number, extra: { parent?: string; page?: string; locked?: boolean } = {}): Node => ({
  ...shapeNodeDefaults(page, { id, x, y, width: 10, height: 10, z }, []),
  ...extra,
});
const grp = (id: string, extra: { parent?: string; locked?: boolean } = {}): Node => ({ ...groupNodeDefaults(page, { id }, []), ...extra });
const make = (nodes: Node[]): Document => ({ ...createDocument("a4-portrait"), pages: [page, other], nodes });
const at = (doc: Document, id: string) => doc.nodes.find((n) => n.id === id) as Node | undefined;

function setup(nodes: Node[]) {
  const r = registries();
  const store = createFigureStore(make(nodes), r);
  const ctx = (selection: string[] = [], view: CommandContext["view"] = null): CommandContext => ({ app: {} as never, registries: r, view, store, selection, page: undefined });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const command = (id: string) => r.commands.get(id)!;
  return { r, store, ctx, call, command };
}

describe("group.create", () => {
  test("groups two nodes in one undo step, contiguous below the topmost", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0), shape("x", 30, 0, 1), shape("b", 20, 0, 2), shape("y", 50, 0, 3)]);
    const { id } = (await call("group.create", { ids: ["a", "b"] })) as { id: string };
    expect(at(store.doc, "a")?.parent).toBe(id);
    expect(at(store.doc, "b")?.parent).toBe(id);
    expect(at(store.doc, id)).toMatchObject({ type: "group", x: 0, width: 30 });
    const z = (n: string) => (at(store.doc, n) as Node).z;
    expect(z("x")).toBeLessThan(z("a"));
    expect(z("a")).toBeLessThan(z("b"));
    expect(z("b")).toBeLessThan(z("y"));
    expect(at(store.doc, id)?.parent).toBeUndefined();
    store.undo();
    expect(store.doc.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "x", "y"]);
    expect(store.canUndo()).toBe(false);
  });
  test("refuses one unit, two pages, a locked unit, a duplicate id", async () => {
    const { call } = setup([shape("a", 0, 0, 0), shape("b", 20, 0, 1, { page: other.id }), shape("c", 40, 0, 2, { locked: true }), shape("d", 60, 0, 3)]);
    for (const args of [{ ids: ["a"] }, { ids: ["a", "b"] }, { ids: ["a", "c"] }, { ids: ["a", "d"], id: "a" }]) {
      await expect(call("group.create", args)).rejects.toThrow(/^group\.create:/);
      await expect(call("group.create", args)).rejects.toBeInstanceOf(CommandError);
    }
  });
  test("a member of a group stands for its outermost unit", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g"), shape("c", 50, 0, 2)]);
    const { id } = (await call("group.create", { ids: ["a", "c"] })) as { id: string };
    expect(at(store.doc, "g")?.parent).toBe(id);
    expect(at(store.doc, "c")?.parent).toBe(id);
    expect(at(store.doc, "a")?.parent).toBe("g");
  });
  test("inside a group, the new group is its member", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), shape("c", 40, 0, 2, { parent: "g" }), grp("g")]);
    const { id } = (await call("group.create", { ids: ["a", "b"] })) as { id: string };
    expect(at(store.doc, id)?.parent).toBe("g");
    expect(at(store.doc, "a")?.parent).toBe(id);
  });
  test("from the selection it selects the group once committed; applies needs two units", async () => {
    const { store, ctx, command } = setup([shape("a", 0, 0, 0), shape("b", 20, 0, 1)]);
    const sel: string[][] = [];
    const view = { setSelection: (ids: string[]) => sel.push(ids) } as never;
    expect(command("group.create").applies(ctx(["a"]))).toBe(false);
    expect(command("group.create").applies(ctx(["a", "b"]))).toBe(true);
    const { id } = (await command("group.create").run(ctx(["a", "b"], view), {})) as { id: string };
    expect(sel).toEqual([[id]]);
    expect(store.doc.nodes).toHaveLength(3);
  });
});

describe("group.create within a group", () => {
  test("refuses units that are all the members of their group", async () => {
    const { call, command, ctx } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g")]);
    await expect(call("group.create", { ids: ["a", "b"] })).rejects.toThrow(/^group\.create: .*already a group/);
    expect(command("group.create").applies(ctx(["a", "b"]))).toBe(false);
  });
  test("a strict subset of a group's members still groups (nested)", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), shape("c", 40, 0, 2, { parent: "g" }), grp("g")]);
    const { id } = (await call("group.create", { ids: ["a", "b"] })) as { id: string };
    expect(at(store.doc, id)?.parent).toBe("g");
    expect(at(store.doc, "g")).toBeDefined();
  });
});

describe("group.ungroup", () => {
  test("from the selection it selects the freed children once committed", async () => {
    const { ctx, command } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g")]);
    const sel: string[][] = [];
    const view = { setSelection: (ids: string[]) => sel.push(ids) } as never;
    await command("group.ungroup").run(ctx(["g"], view), {});
    expect(sel).toEqual([["a", "b"]]);
  });
  test("children take the group's parent; one undo restores it", async () => {
    const { store, call, ctx, command } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g"), shape("c", 50, 0, 2)]);
    expect(command("group.ungroup").applies(ctx(["g"]))).toBe(true);
    expect(command("group.ungroup").applies(ctx(["a"]))).toBe(false);
    expect(await call("group.ungroup", { ids: ["g"] })).toEqual({ ids: ["a", "b"] });
    expect(at(store.doc, "g")).toBeUndefined();
    expect(at(store.doc, "a")?.parent).toBeUndefined();
    store.undo();
    expect(at(store.doc, "g")).toBeDefined();
    expect(at(store.doc, "a")?.parent).toBe("g");
  });
  test("a nested group's children go to its parent group", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g", { parent: "h" }), shape("c", 50, 0, 2, { parent: "h" }), grp("h")]);
    await call("group.ungroup", { ids: ["g"] });
    expect(at(store.doc, "a")?.parent).toBe("h");
    expect(at(store.doc, "h")).toBeDefined();
  });
});

describe("group.add and group.remove", () => {
  const nodes = () => [shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g"), shape("c", 50, 0, 2), shape("p2", 0, 0, 3, { page: other.id }), shape("l", 80, 0, 4, { locked: true })];
  test("add puts a node in the group", async () => {
    const { store, call } = setup(nodes());
    await call("group.add", { group: "g", ids: ["c"] });
    expect(at(store.doc, "c")?.parent).toBe("g");
  });
  test("add refuses a cycle, another page, a locked target", async () => {
    const { call } = setup(nodes());
    await expect(call("group.add", { group: "g", ids: ["g"] })).rejects.toThrow(/^group\.add:/);
    await expect(call("group.add", { group: "g", ids: ["p2"] })).rejects.toThrow(/^group\.add:/);
    const locked = setup([...nodes().filter((n) => n.id !== "g"), grp("g", { locked: true })]);
    await expect(locked.call("group.add", { group: "g", ids: ["c"] })).rejects.toThrow(/^group\.add:/);
  });
  test("add refuses an ancestor going into its descendant", async () => {
    const { call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g", { parent: "h" }), shape("c", 50, 0, 2, { parent: "h" }), grp("h")]);
    await expect(call("group.add", { group: "g", ids: ["h"] })).rejects.toThrow(/cycle/);
  });
  test("remove from a two-member group dissolves it, the other keeps the outer parent", async () => {
    const { store, call } = setup([shape("a", 0, 0, 0, { parent: "g" }), shape("b", 20, 0, 1, { parent: "g" }), grp("g", { parent: "h" }), shape("c", 50, 0, 2, { parent: "h" }), grp("h")]);
    await call("group.remove", { ids: ["a"] });
    expect(at(store.doc, "g")).toBeUndefined();
    expect(at(store.doc, "a")?.parent).toBe("h");
    expect(at(store.doc, "b")?.parent).toBe("h");
  });
});
