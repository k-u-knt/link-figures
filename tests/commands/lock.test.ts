import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { createDocument, createPage, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { isLocked } from "../../src/model/groups";
import { createFigureStore } from "../../src/model/normalise";
import type { Document, Node } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import { CommandError, type CommandContext } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";

const page = createPage("a4-portrait", []);
const shape = (id: string, x: number, z: number, extra: { parent?: string; locked?: boolean } = {}): Node => ({
  ...shapeNodeDefaults(page, { id, x, y: 0, width: 10, height: 10, z }, []),
  ...extra,
});
const grp = (id: string, extra: { parent?: string; locked?: boolean } = {}): Node => ({ ...groupNodeDefaults(page, { id }, []), ...extra });
const make = (nodes: Node[]): Document => ({ ...createDocument("a4-portrait"), pages: [page], nodes });

function setup(nodes: Node[]) {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  const plugin = { registries: r, addCommand: () => undefined, activeFigureView: () => null };
  registerBuiltinCommands(plugin as never);
  for (const c of drawingCommands()) r.commands.register(c);
  const store = createFigureStore(make(nodes), r);
  // A view is there (the selection is what the command acts on); it is not asked for anything.
  const ctx = (selection: string[]): CommandContext => ({ app: {} as never, registries: r, view: {} as never, store, selection, page });
  const lock = r.commands.get("lock")!;
  const unlock = r.commands.get("unlock")!;
  const own = (id: string) => store.doc.nodes.find((n) => n.id === id)?.locked === true;
  return { r, store, ctx, lock, unlock, own };
}

test("lock and unlock are edit commands with the lock icons, shown in the toolbar", () => {
  const { lock, unlock } = setup([]);
  expect([lock.group, lock.icon, lock.name, lock.hidden]).toEqual(["edit", "lock", "Lock", undefined]);
  expect([unlock.group, unlock.icon, unlock.name, unlock.hidden]).toEqual(["edit", "unlock", "Unlock", undefined]);
});

test("Lock applies while a selected unit is unlocked, Unlock while one is locked, both when mixed", () => {
  const { ctx, lock, unlock } = setup([shape("a", 0, 0), shape("b", 20, 1, { locked: true })]);
  expect([lock.applies(ctx([])), unlock.applies(ctx([]))]).toEqual([false, false]);
  expect([lock.applies(ctx(["a"])), unlock.applies(ctx(["a"]))]).toEqual([true, false]);
  expect([lock.applies(ctx(["b"])), unlock.applies(ctx(["b"]))]).toEqual([false, true]);
  expect([lock.applies(ctx(["a", "b"])), unlock.applies(ctx(["a", "b"]))]).toEqual([true, true]);
});

test("Lock sets locked on the selection's units in one undo step; Unlock clears it", async () => {
  const { store, ctx, lock, unlock, own } = setup([shape("a", 0, 0), shape("b", 20, 1), shape("c", 40, 2)]);
  await lock.run(ctx(["a", "b"]));
  expect([own("a"), own("b"), own("c")]).toEqual([true, true, false]);
  store.undo();
  expect([own("a"), own("b")]).toEqual([false, false]);
  expect(store.canUndo()).toBe(false);
  store.redo();
  await unlock.run(ctx(["a", "b", "c"]));
  expect([own("a"), own("b"), own("c")]).toEqual([false, false, false]);
});

test("a selected group is locked as a whole: its own flag, which locks its members", async () => {
  const { store, ctx, lock, unlock, own } = setup([shape("a", 0, 0, { parent: "g" }), shape("b", 20, 1, { parent: "g" }), grp("g")]);
  await lock.run(ctx(["g"]));
  expect([own("g"), own("a"), own("b")]).toEqual([true, false, false]);
  expect(isLocked(store.doc, "a")).toBe(true);
  expect([lock.applies(ctx(["g"])), unlock.applies(ctx(["g"]))]).toEqual([false, true]);
  await unlock.run(ctx(["g"]));
  expect(own("g")).toBe(false);
  expect(isLocked(store.doc, "a")).toBe(false);
});

test("a member of a locked group is locked by its group: neither Lock nor Unlock acts on it", () => {
  const { ctx, lock, unlock } = setup([shape("a", 0, 0, { parent: "g" }), shape("b", 20, 1, { parent: "g" }), grp("g", { locked: true })]);
  expect([lock.applies(ctx(["a"])), unlock.applies(ctx(["a"]))]).toEqual([false, false]);
});

test("ids name the nodes in place of the selection; headless they must be given", async () => {
  const { r, store, own } = setup([shape("a", 0, 0), shape("b", 20, 1)]);
  const headless: CommandContext = { app: {} as never, registries: r, view: null, store, selection: [], page: undefined };
  await runCall(store, headless, prepareCall(r, { id: "lock", args: { ids: ["b"] } }));
  expect([own("a"), own("b")]).toEqual([false, true]);
  await runCall(store, headless, prepareCall(r, { id: "unlock", args: { ids: ["b"] } }));
  expect(own("b")).toBe(false);
  await expect(runCall(store, headless, prepareCall(r, { id: "lock", args: {} }))).rejects.toBeInstanceOf(CommandError);
});
