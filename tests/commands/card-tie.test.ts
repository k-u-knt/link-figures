import { registerBuiltinCommands } from "../../src/commands/builtin";
import { cardCommands } from "../../src/commands/cards";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { isAssociation } from "../../src/model/attach";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { ConnectorNode, Document, End } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { textNodeType } from "../../src/nodes/text-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import { CommandError, type CommandContext } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

function registries(): Registries {
  const r = createRegistries();
  for (const t of [shapeNodeType, connectorNodeType, groupNodeType, textNodeType, cardNodeType]) r.nodeTypes.register(t);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  for (const c of [...drawingCommands(), ...groupCommands(), ...cardCommands()]) r.commands.register(c);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  return r;
}

/** Pages pg-1, pg-2 and pg-3; card "c" beside pg-1, card "d" below it, shape "s" on pg-1. */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  doc.pages.push({ ...createPage("a4-portrait", ["pg-1"]), id: "pg-2" });
  doc.pages.push({ ...createPage("a4-portrait", ["pg-1", "pg-2"]), id: "pg-3" });
  const page = doc.pages[0];
  doc.nodes.push({ ...cardNodeDefaults(page, -400, 100, []), id: "c", text: "Legend" });
  doc.nodes.push({ ...cardNodeDefaults(page, -400, 500, ["c"]), id: "d", text: "Other" });
  doc.nodes.push(shapeNodeDefaults(page, { id: "s", kind: "rect", x: 50, y: 50, width: 100, height: 80, z: 0 }, []));
  return doc;
}

function setup(clock?: () => number) {
  const r = registries();
  let t = 0;
  const store = createFigureStore(figure(), r, clock ?? (() => (t += 10_000)));
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: null, store, selection: [], page: undefined });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const connectors = () => store.doc.nodes.filter((n): n is ConnectorNode => n.type === "connector");
  const ties = (card: string) =>
    connectors().filter((c) => isAssociation(store.doc, c, r) && c.ends.some((e) => e.kind === "attached" && e.node === card));
  return { r, store, ctx, call, connectors, ties };
}

const centre = (node: string): End => ({ kind: "attached", node, snap: "center" });

describe("card.tie", () => {
  test("card.tie to a page makes one association, centre to centre, with no page anchor", async () => {
    const { call, ties, r, store } = setup();
    const result = (await call("card.tie", { id: "c", page: "pg-2" })) as { connector: string };
    const made = ties("c");
    expect(made).toHaveLength(1);
    expect(result).toEqual({ connector: made[0].id });
    expect(made[0].ends).toEqual([centre("c"), { kind: "page", page: "pg-2" }]);
    expect(made[0].page).toBe("pg-1");
    expect(isAssociation(store.doc, made[0], r)).toBe(true);
  });

  test("to another page it moves the tie; null removes it", async () => {
    const { call, ties, connectors } = setup();
    await call("card.tie", { id: "c", page: "pg-1" });
    const first = ties("c")[0].id;
    const moved = (await call("card.tie", { id: "c", page: "pg-3" })) as { connector: string };
    expect(ties("c")).toHaveLength(1);
    expect(ties("c")[0].ends).toEqual([centre("c"), { kind: "page", page: "pg-3" }]);
    // The same line, re-aimed.
    expect(moved.connector).toBe(first);
    // The same page again changes nothing.
    expect(await call("card.tie", { id: "c", page: "pg-3" })).toEqual({ connector: first });
    expect(await call("card.tie", { id: "c", page: null })).toEqual({ connector: null });
    expect(ties("c")).toHaveLength(0);
    expect(connectors()).toHaveLength(0);
  });

  test("with several ties it replaces them with one, leaving other connectors", async () => {
    const { call, ties, connectors } = setup();
    const a = (await call("connector.create", { page: "pg-1", from: { kind: "attached", node: "c", snap: "anchor", anchor: "e" }, to: { kind: "page", page: "pg-1", anchor: "w" } })) as { id: string };
    await call("connector.create", { page: "pg-1", from: { kind: "page", page: "pg-2", anchor: "n" }, to: { kind: "attached", node: "c", snap: "anchor", anchor: "s" } });
    const between = (await call("connector.create", { page: "pg-1", from: centre("c"), to: centre("d") })) as { id: string };
    const toShape = (await call("connector.create", { page: "pg-1", from: centre("c"), to: centre("s") })) as { id: string };
    const other = (await call("card.tie", { id: "d", page: "pg-1" })) as { connector: string };
    expect(ties("c")).toHaveLength(2);

    const { connector } = (await call("card.tie", { id: "c", page: "pg-3" })) as { connector: string };
    expect(ties("c")).toHaveLength(1);
    expect(connector).toBe(a.id);
    expect(ties("c")[0].ends).toEqual([centre("c"), { kind: "page", page: "pg-3" }]);
    const ids = connectors().map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining([between.id, toShape.id, other.connector]));
    expect(ids).toHaveLength(4);
  });

  test("an unknown page is refused", async () => {
    const { call, store } = setup();
    await call("card.tie", { id: "c", page: "pg-2" });
    const before = JSON.stringify(store.doc);
    await expect(call("card.tie", { id: "c", page: "pg-9" })).rejects.toThrow(new CommandError('card.tie: there is no page "pg-9"'));
    // A page deleted while the bar's dropdown was open: the choice is refused and the figure is left as it was.
    await call("delete-page", { page: "pg-3" });
    const after = JSON.stringify(store.doc);
    await expect(call("card.tie", { id: "c", page: "pg-3" })).rejects.toBeInstanceOf(CommandError);
    expect(JSON.stringify(store.doc)).toBe(after);
    expect(before).not.toBe(after);
    await expect(call("card.tie", { id: "nope", page: "pg-1" })).rejects.toThrow(new CommandError('card.tie: there is no node "nope"'));
    await expect(call("card.tie", { id: "s", page: "pg-1" })).rejects.toThrow(new CommandError('card.tie: "s" cannot be tied to a page'));
  });

  test("each call is one undo step", () => {
    // A clock that never moves: every commit is within the merge window.
    const { r, store, ctx, ties } = setup(() => 0);
    const tie = r.commands.get("card.tie")!;
    tie.run(ctx(), { id: "c", page: "pg-1" } as never);
    tie.run(ctx(), { id: "c", page: "pg-2" } as never);
    tie.run(ctx(), { id: "c", page: "pg-1" } as never);
    tie.run(ctx(), { id: "c", page: null } as never);
    expect(ties("c")).toHaveLength(0);
    store.undo();
    expect(ties("c")[0].ends[1]).toEqual({ kind: "page", page: "pg-1" });
    store.undo();
    expect(ties("c")[0].ends[1]).toEqual({ kind: "page", page: "pg-2" });
    store.undo();
    expect(ties("c")[0].ends[1]).toEqual({ kind: "page", page: "pg-1" });
    store.undo();
    expect(ties("c")).toHaveLength(0);
    expect(store.canUndo()).toBe(false);
  });
});

