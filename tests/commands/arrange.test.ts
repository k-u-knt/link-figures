import { arrangeCommands } from "../../src/commands/arrange";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { visualBounds } from "../../src/model/arrange";
import { connectorNodeDefaults, createDocument, createPage, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { mmToPx, pageSizePx } from "../../src/model/geometry";
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
  for (const c of arrangeCommands()) r.commands.register(c);
  return r;
}

const page = { ...createPage("a4-portrait", []), margins: { top: 10, right: 20, bottom: 30, left: 15 } };
const other = createPage("a4-portrait", [page.id]);
type Extra = { parent?: string; page?: string; locked?: boolean; rotation?: number };
const box = (id: string, x: number, y: number, width = 10, height = 10, extra: Extra = {}): Node => ({
  ...shapeNodeDefaults(page, { id, x, y, width, height, z: 0 }, []),
  ...extra,
});
const grp = (id: string): Node => groupNodeDefaults(page, { id }, []);
const line = (id: string, ends: [End, End]): Node => connectorNodeDefaults(page, { id, ends, z: 9 }, []);
const make = (nodes: Node[]): Document => ({ ...createDocument("a4-portrait"), pages: [page, other], nodes });
const at = (doc: Document, id: string) => doc.nodes.find((n) => n.id === id) as Node;

function setup(nodes: Node[]) {
  const r = registries();
  const store = createFigureStore(make(nodes), r);
  const ctx = (selection: string[] = [], view: CommandContext["view"] = null): CommandContext => ({ app: {} as never, registries: r, view, store, selection, page: undefined });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const vb = (id: string) => visualBounds(store.doc, id, r);
  return { r, store, ctx, call, vb };
}

describe("align", () => {
  test("left sets every unit's visual left to the minimum left", async () => {
    const { call, vb } = setup([box("a", 30, 0), box("b", 50, 20, 30), box("c", 40, 40, 100, 50, { rotation: 90 })]);
    await call("align", { ids: ["a", "b", "c"], edge: "left" });
    expect(vb("a").x).toBe(30);
    expect(vb("b").x).toBe(30);
    expect(vb("c").x).toBe(30);
  });
  test("hcenter sets every centre to the selection's centre", async () => {
    const { call, vb } = setup([box("a", 0, 0), box("b", 50, 20, 30), box("c", 100, 40, 20)]);
    await call("align", { ids: ["a", "b", "c"], edge: "hcenter" });
    for (const id of ["a", "b", "c"]) expect(vb(id).x + vb(id).width / 2).toBe(60);
  });
  test("one unit aligns to the margin box", async () => {
    const { store, call } = setup([box("a", 30, 30)]);
    await call("align", { ids: ["a"], edge: "right" });
    expect(at(store.doc, "a").x + 10).toBeCloseTo(pageSizePx(page).width - mmToPx(20), 1);
  });
  test("to page uses the page edge", async () => {
    const { store, call } = setup([box("a", 30, 30), box("b", 60, 60)]);
    await call("align", { ids: ["a", "b"], edge: "bottom", to: "page" });
    expect(at(store.doc, "a").y + 10).toBeCloseTo(pageSizePx(page).height, 1);
    expect(at(store.doc, "b").y + 10).toBeCloseTo(pageSizePx(page).height, 1);
  });
  test("locked units are ignored", async () => {
    const { store, call } = setup([box("a", 30, 0), box("b", 50, 0), box("c", 10, 0, 10, 10, { locked: true })]);
    await call("align", { ids: ["a", "b", "c"], edge: "left" });
    expect(at(store.doc, "a").x).toBe(30);
    expect(at(store.doc, "b").x).toBe(30);
    expect(at(store.doc, "c").x).toBe(10);
  });
  test("a group aligns as one unit", async () => {
    const { store, call, vb } = setup([box("a", 20, 0, 10, 10, { parent: "g" }), box("b", 60, 0, 10, 10, { parent: "g" }), grp("g"), box("x", 5, 50)]);
    await call("align", { ids: ["a", "x"], edge: "right" });
    expect(vb("g").x + vb("g").width).toBe(70);
    expect(at(store.doc, "x").x).toBe(60);
    expect(at(store.doc, "a").x).toBe(20);
    expect(at(store.doc, "b").x).toBe(60);
  });
  test("an attached connector follows its item", async () => {
    const { store, call, vb } = setup([box("a", 0, 0), box("b", 100, 0), line("c", [{ kind: "attached", node: "a", snap: "center" }, { kind: "free", x: 50, y: 100 }])]);
    expect(vb("c").x + vb("c").width).toBeLessThan(60);
    await call("align", { ids: ["a", "b"], edge: "right" });
    expect(at(store.doc, "a").x).toBe(100);
    expect((at(store.doc, "c") as ConnectorNode).ends[0]).toEqual({ kind: "attached", node: "a", snap: "center" });
    // The attached end is clipped to a's outline, which now starts at x = 100.
    expect(vb("c").x + vb("c").width).toBeGreaterThan(100);
    // The connector's box was re-resolved in the same commit.
    expect(at(store.doc, "c").x + at(store.doc, "c").width).toBeCloseTo(vb("c").x + vb("c").width, 1);
  });
  test("one undo step", async () => {
    const { store, call } = setup([box("a", 30, 0), box("b", 50, 20)]);
    const before = store.doc;
    await call("align", { ids: ["a", "b"], edge: "top" });
    expect(store.doc).not.toBe(before);
    store.undo();
    expect(store.doc.nodes).toEqual(before.nodes);
    expect(store.canUndo()).toBe(false);
  });
  test("units on different pages refuse", async () => {
    const { call } = setup([box("a", 30, 0), box("b", 50, 0, 10, 10, { page: other.id })]);
    await expect(call("align", { ids: ["a", "b"], edge: "left" })).rejects.toBeInstanceOf(CommandError);
    await expect(call("align", { ids: ["a", "b"], edge: "left" })).rejects.toThrow(/^align:/);
  });
});

describe("distribute", () => {
  const four = () => [box("a", 0, 0, 10), box("b", 15, 0, 20), box("c", 40, 0, 5), box("d", 100, 0, 10)];
  test("horizontal: the outer two stay, the gaps are equal", async () => {
    const { store, call, vb } = setup(four());
    await call("distribute", { ids: ["a", "b", "c", "d"], axis: "horizontal" });
    expect(at(store.doc, "a").x).toBe(0);
    expect(at(store.doc, "d").x).toBe(100);
    const order = ["a", "b", "c", "d"].map(vb).sort((p, q) => p.x - q.x);
    const gaps = order.slice(1).map((rect, i) => rect.x - (order[i].x + order[i].width));
    for (const gap of gaps) expect(Math.abs(gap - gaps[0])).toBeLessThanOrEqual(0.5);
  });
  test("by center spaces the centres evenly", async () => {
    const { call, vb } = setup([box("a", 0, 0, 10, 10), box("b", 0, 5, 10, 30), box("c", 0, 90, 10, 10)]);
    await call("distribute", { ids: ["a", "b", "c"], axis: "vertical", by: "center" });
    const centres = ["a", "b", "c"].map((id) => vb(id).y + vb(id).height / 2);
    expect(centres).toEqual([5, 50, 95]);
  });
  test("fewer than three units refuses", async () => {
    const { call } = setup(four());
    await expect(call("distribute", { ids: ["a", "b"], axis: "horizontal" })).rejects.toThrow("distribute: needs at least three items");
  });
  test("one undo step", async () => {
    const { store, call } = setup(four());
    const before = store.doc;
    await call("distribute", { ids: ["a", "b", "c", "d"], axis: "horizontal" });
    store.undo();
    expect(store.doc.nodes).toEqual(before.nodes);
    expect(store.canUndo()).toBe(false);
  });
});

describe("toolbar commands", () => {
  const view = {} as CommandContext["view"];
  test("align applies with one unit; distribute with three", () => {
    const { r, ctx } = setup([box("a", 0, 0, 10, 10, { parent: "g" }), box("b", 20, 0, 10, 10, { parent: "g" }), grp("g"), box("x", 50, 0), box("y", 80, 0)]);
    const applies = (id: string, sel: string[]) => r.commands.get(id)!.applies(ctx(sel, view));
    for (const id of ["align.left", "align.hcenter", "align.right", "align.top", "align.vcenter", "align.bottom"]) {
      expect(applies(id, [])).toBe(false);
      expect(applies(id, ["x"])).toBe(true);
    }
    for (const id of ["distribute.horizontal", "distribute.vertical"]) {
      expect(applies(id, ["a", "b", "x"])).toBe(false);
      expect(applies(id, ["a", "x", "y"])).toBe(true);
    }
  });
  test("they are named for the toolbar and in their groups", () => {
    const { r } = setup([]);
    expect(r.commands.get("align.hcenter")).toMatchObject({ name: "Align centre", group: "align", icon: "align-center-vertical" });
    expect(r.commands.get("distribute.vertical")).toMatchObject({ name: "Distribute vertically", group: "distribute" });
    expect(r.commands.get("align")?.hidden).toBe(true);
    expect(r.commands.get("distribute")?.hidden).toBe(true);
  });
  test("align.left runs align on the selection", async () => {
    const { r, store, ctx } = setup([box("a", 30, 0), box("b", 50, 0)]);
    await r.commands.get("align.left")!.run(ctx(["a", "b"], view));
    expect(at(store.doc, "b").x).toBe(30);
  });
});
