import { createApi, type OpenFigure } from "../../src/api";
import { MIN_NODE_PX } from "../../src/constants";
import { drawingCommands } from "../../src/commands/drawing";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, createPage, defaultBorder, shapeNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { DocumentStore } from "../../src/model/store";
import type { ConnectorNode, Document, ShapeNode } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { textNodeType } from "../../src/nodes/text-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import { CommandError, type CommandContext } from "../../src/registry/command";
import type { ShapeOperation } from "../../src/registry/shape-operation";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { normalizePath } from "../export/fake-vault";

const PATH = "figs/fig.lnkfig.md";

/**
 * A test-only shape operation: the shapes named are replaced by one rectangle over the box they cover together, on the
 * first one's page. It applies to two shapes or more.
 */
const coverOperation: ShapeOperation = {
  id: "test.cover",
  name: "Cover",
  applies: (nodes) => nodes.length >= 2,
  run(nodes) {
    const x = Math.min(...nodes.map((n) => n.x));
    const y = Math.min(...nodes.map((n) => n.y));
    const right = Math.max(...nodes.map((n) => n.x + n.width));
    const bottom = Math.max(...nodes.map((n) => n.y + n.height));
    const page = { id: nodes[0].page } as never;
    const cover = shapeNodeDefaults(page, { id: "p-cover", x, y, width: right - x, height: bottom - y }, []);
    return { add: [cover], remove: nodes.map((n) => n.id) };
  },
};

function registriesForDrawing(): Registries {
  const registries = createRegistries();
  registries.nodeTypes.register(shapeNodeType);
  registries.nodeTypes.register(connectorNodeType);
  registries.nodeTypes.register(textNodeType);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  for (const route of builtinRoutes) registries.routes.register(route);
  for (const cap of builtinCapKinds) registries.caps.register(cap);
  for (const paint of builtinPaintTypes) registries.paints.register(paint);
  for (const command of drawingCommands()) registries.commands.register(command);
  registries.shapeOperations.register(coverOperation);
  return registries;
}

/** A figure with one page (`pg-1`) and a label `t` on it; with `secondPage`, an empty page `pg-2` after it. */
function figure(secondPage = false): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  if (secondPage) doc.pages.push({ ...createPage("a4-portrait", ["pg-1"]), id: "pg-2" });
  doc.nodes.push(textNodeDefaults(doc.pages[0], { id: "t" }, []));
  return doc;
}

/** An open view of `doc`, as the API sees one: its store (a figure's, with its normalisers), the context its commands get, and its selection. */
function openView(doc: Document, registries: Registries): OpenFigure & { store: DocumentStore; selection: string[] } {
  let t = 0;
  // Commits far apart in time, so none merges into the one before.
  const store = createFigureStore(doc, registries, () => (t += 10_000));
  const view = {
    store,
    selection: [] as string[],
    commandContext: (): CommandContext => ({
      app: {} as never,
      registries,
      view: { file: { path: PATH }, selectedIds: () => view.selection, setSelection: (ids: string[]) => void (view.selection = ids) } as never,
      store,
      selection: view.selection,
      page: store.doc.pages[0],
    }),
  };
  return view;
}

/** The API on one figure file, kept in memory; with `open`, an open view of the figure too. */
function setup(options: { open?: boolean; secondPage?: boolean } = {}) {
  const registries = registriesForDrawing();
  const text = new Map([[PATH, serializeFigureFile(figure(options.secondPage), emptyParsed())]]);
  const files = {
    read: async (path: string) => text.get(path)!,
    async process(path: string, edit: (t: string) => string) {
      text.set(path, edit(text.get(path)!));
    },
  };
  const view = options.open ? openView(figure(options.secondPage), registries) : null;
  const api = createApi({ app: {} as never, registries, files, normalizePath, openFigure: (path) => (path === PATH ? view : null) });
  /** The figure as the API reads it: the view's document, else the file's. */
  const doc = () => api.read(PATH);
  return { api, registries, view, doc, saved: () => loadDocument(text.get(PATH)!).doc };
}

const nodeOf = async <N,>(doc: Promise<Document>, id: string) => (await doc).nodes.find((n) => n.id === id) as N;

describe("shape.create", () => {
  test("headless, adds a shape of the kind with the kind's default params, white fill and the default border, and saves the file", async () => {
    const { api, saved } = setup();
    const result = (await api.run(PATH, "shape.create", { page: "pg-1", x: 10, y: 20, width: 100, height: 50 })) as { id: string };
    expect(result.id).toMatch(/^p-[a-z0-9]{4}$/);
    const shape = saved().nodes.find((n) => n.id === result.id) as ShapeNode;
    expect(shape).toMatchObject({ type: "shape", page: "pg-1", kind: "rect", x: 10, y: 20, width: 100, height: 50, params: { cornerRadius: 0 }, fill: { type: "solid", color: "#ffffff" }, border: defaultBorder() });
    // Above the label already on the page.
    expect(shape.z).toBe(1);
  });

  test("the kind's defaults with the given params over them; a given fill, and a null border for none", async () => {
    const { api, doc } = setup();
    const fill = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
    const { id } = (await api.run(PATH, "shape.create", { id: "e", page: "pg-1", kind: "ellipse", x: 0, y: 0, width: 10, height: 10, fill, border: null })) as { id: string };
    expect(id).toBe("e");
    expect(await nodeOf<ShapeNode>(doc(), "e")).toMatchObject({ kind: "ellipse", params: {}, fill, border: null });
    await api.run(PATH, "shape.create", { id: "r", page: "pg-1", x: 0, y: 0, width: 10, height: 10, params: { cornerRadius: 4, extra: true } });
    expect((await nodeOf<ShapeNode>(doc(), "r")).params).toEqual({ cornerRadius: 4, extra: true });
  });

  test("in an open view the page defaults to the view's, the new shape is selected, and it is one undo step", async () => {
    const { api, view } = setup({ open: true });
    const { id } = (await api.run(PATH, "shape.create", { x: 0, y: 0, width: 10, height: 10 })) as { id: string };
    expect(view!.store.doc.nodes.find((n) => n.id === id)?.page).toBe("pg-1");
    expect(view!.selection).toEqual([id]);
    view!.store.undo();
    expect(view!.store.doc).toEqual(figure());
  });

  test.each([
    ["an unknown kind", { page: "pg-1", kind: "x.star", x: 0, y: 0, width: 1, height: 1 }, /no shape kind "x.star"/],
    ["an id the figure has", { id: "t", page: "pg-1", x: 0, y: 0, width: 1, height: 1 }, /already has a node "t"/],
    ["an empty id", { id: "", page: "pg-1", x: 0, y: 0, width: 1, height: 1 }, /"id" must not be empty/],
    ["no page, headless", { x: 0, y: 0, width: 1, height: 1 }, /needs "page"/],
    ["an unknown page", { page: "pg-9", x: 0, y: 0, width: 1, height: 1 }, /no page "pg-9"/],
    ["a negative width", { page: "pg-1", x: 0, y: 0, width: -1, height: 1 }, /may not be negative/],
    ["a malformed border", { page: "pg-1", x: 0, y: 0, width: 1, height: 1, border: { width: 1 } }, /parameter "border" must be a stroke/],
    ["a fill with a number that is not finite", { page: "pg-1", x: 0, y: 0, width: 1, height: 1, fill: { type: "solid", color: "#000000", opacity: NaN } }, /not finite/],
  ])("%s is an error that changes nothing", async (_name, args, message) => {
    const { api, saved } = setup();
    const before = saved();
    await expect(api.run(PATH, "shape.create", args)).rejects.toThrow(CommandError);
    await expect(api.run(PATH, "shape.create", args)).rejects.toThrow(message);
    expect(saved()).toEqual(before);
  });
});

describe("connector.create", () => {
  test("a straight 1 pt black arrow by default, with the box the normaliser gives it", async () => {
    const { api, doc, registries } = setup();
    const { id } = (await api.run(PATH, "connector.create", { page: "pg-1", from: { kind: "free", x: 10, y: 10 }, to: { kind: "free", x: 110, y: 10 } })) as { id: string };
    const current = await doc();
    const c = current.nodes.find((n) => n.id === id) as ConnectorNode;
    expect(c).toMatchObject({
      type: "connector",
      route: "straight",
      routeParams: {},
      stroke: { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" },
      caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 3 }],
      rotation: 0,
    });
    expect({ x: c.x, y: c.y, width: c.width, height: c.height }).toEqual(resolveConnector(current, c, registries).bounds);
    expect(c.width).toBeGreaterThan(99);
  });

  test("the route's default params with the given ones over them, and given stroke and caps", async () => {
    const { api, doc } = setup();
    const stroke = { paint: { type: "solid", color: "#ff0000" }, width: 2, dash: "dash" };
    const caps = [{ kind: "circle", size: 2 }, { kind: "bar", size: 4 }];
    const { id } = (await api.run(PATH, "connector.create", { page: "pg-1", from: { kind: "free", x: 0, y: 0 }, to: { kind: "free", x: 50, y: 50 }, route: "curved", stroke, caps })) as { id: string };
    expect(await nodeOf<ConnectorNode>(doc(), id)).toMatchObject({ route: "curved", routeParams: { bend: 0.25 }, stroke, caps });
  });

  test.each([
    ["an unknown route", { route: "x.wiggle" }, /no route "x.wiggle"/],
    ["an end attached to a node that is not there", { to: { kind: "attached", node: "p-none", snap: "center" } }, /not a node of the figure/],
    ["one cap", { caps: [{ kind: "arrow", size: 3 }] }, /"caps" must be two caps/],
    ["an unknown cap kind", { caps: [{ kind: "none", size: 3 }, { kind: "x.star", size: 3 }] }, /no cap kind "x.star"/],
  ])("%s is an error", async (_name, args, message) => {
    const { api } = setup();
    await expect(api.run(PATH, "connector.create", { page: "pg-1", from: { kind: "free", x: 0, y: 0 }, to: { kind: "free", x: 9, y: 9 }, ...args })).rejects.toThrow(message);
  });
});

test("a batch of two shapes with given ids and a connector between them is one undo step", async () => {
  const { api, view } = setup({ open: true });
  const results = await api.batch(PATH, [
    { id: "shape.create", args: { id: "a", x: 0, y: 0, width: 50, height: 30 } },
    { id: "shape.create", args: { id: "b", kind: "ellipse", x: 200, y: 0, width: 50, height: 30 } },
    { id: "connector.create", args: { id: "c", from: { kind: "attached", node: "a", snap: "anchor", anchor: "e" }, to: { kind: "attached", node: "b", snap: "anchor", anchor: "w" } } },
  ]);
  expect(results).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  const store = view!.store;
  const c = store.doc.nodes.find((n) => n.id === "c") as ConnectorNode;
  // Attached, and drawn from a's east edge (x 50) to b's west edge (x 200).
  expect(c.ends.map((e) => e.kind)).toEqual(["attached", "attached"]);
  expect(c.x).toBeLessThanOrEqual(50);
  expect(c.x + c.width).toBeGreaterThanOrEqual(200);
  expect(view!.selection).toEqual(["c"]);
  store.undo();
  expect(store.doc).toEqual(figure());
  expect(store.canUndo()).toBe(false);
});

describe("node.update", () => {
  /** A figure with a rectangle `s` and a straight connector `c` from free (0, 0) to the rectangle's west anchor. */
  async function withShapeAndConnector(options: { open?: boolean; secondPage?: boolean } = {}) {
    const s = setup(options);
    await s.api.batch(PATH, [
      { id: "shape.create", args: { id: "s", page: "pg-1", x: 100, y: 100, width: 100, height: 50 } },
      { id: "connector.create", args: { id: "c", page: "pg-1", from: { kind: "free", x: 0, y: 0 }, to: { kind: "attached", node: "s", snap: "anchor", anchor: "w" } } },
    ]);
    return s;
  }

  test("deep-merges the patch, keeps unknown keys, and the rest of the node as it was", async () => {
    const { api, doc } = await withShapeAndConnector();
    const before = await nodeOf<ShapeNode>(doc(), "s");
    expect(await api.run(PATH, "node.update", { id: "s", patch: { border: { width: 3 }, params: { cornerRadius: 5 }, futureKey: { a: [1] } } })).toEqual({ id: "s" });
    const after = await nodeOf<ShapeNode & { futureKey: unknown }>(doc(), "s");
    expect(after).toEqual({ ...before, border: { ...before.border!, width: 3 }, params: { cornerRadius: 5 }, futureKey: { a: [1] } });
  });

  test("a paint of another type replaces the old one whole; a paint of the same type is merged", async () => {
    const { api, doc } = await withShapeAndConnector();
    await api.run(PATH, "node.update", { id: "s", patch: { fill: { opacity: 0.5 } } });
    expect((await nodeOf<ShapeNode>(doc(), "s")).fill).toEqual({ type: "solid", color: "#ffffff", opacity: 0.5 });
    const linear = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };
    await api.run(PATH, "node.update", { id: "s", patch: { fill: linear } });
    expect((await nodeOf<ShapeNode>(doc(), "s")).fill).toEqual(linear);
  });

  test("replace names top-level keys whose patch value replaces what is there whole, with no key-by-key merge", async () => {
    const { api, doc } = await withShapeAndConnector();
    await api.run(PATH, "node.update", { id: "s", patch: { fill: { opacity: 0.5, note: 1 } } });
    await api.run(PATH, "node.update", { id: "s", patch: { fill: { type: "solid", color: "#ff0000" }, border: { width: 2 } }, replace: ["fill"] });
    const s = await nodeOf<ShapeNode>(doc(), "s");
    expect(s.fill).toEqual({ type: "solid", color: "#ff0000" });
    // A key not named is merged as before.
    expect(s.border).toEqual({ ...defaultBorder(), width: 2 });
    // A replaced value is still checked.
    await expect(api.run(PATH, "node.update", { id: "s", patch: { border: { paint: { type: "solid", color: "#000000" }, width: -1, dash: "solid" } }, replace: ["border"] })).rejects.toThrow();
    await expect(api.run(PATH, "node.update", { id: "s", patch: {}, replace: [3] })).rejects.toThrow(/replace/);
  });

  test("replace takes only keys that hold a paint or a stroke, and that the patch gives; a replaced paint has its type's keys", async () => {
    const { api, doc } = await withShapeAndConnector();
    const before = await nodeOf<ShapeNode>(doc(), "s");
    const refused = async (args: object, ...words: string[]) => {
      const run = api.run(PATH, "node.update", { id: "s", ...args });
      await expect(run).rejects.toBeInstanceOf(CommandError);
      await expect(api.run(PATH, "node.update", { id: "s", ...args })).rejects.toThrow(/^node\.update: /);
      for (const word of words) await expect(api.run(PATH, "node.update", { id: "s", ...args })).rejects.toThrow(word);
    };
    // Not a paint or a stroke.
    await refused({ patch: { name: "Box" }, replace: ["name"] }, '"name"');
    await refused({ patch: { params: { cornerRadius: 2 } }, replace: ["params"] }, '"params"');
    // Not in the patch.
    await refused({ patch: { name: "Box" }, replace: ["fill"] }, '"fill"');
    // A paint without its type's keys.
    await refused({ patch: { fill: { type: "solid" } }, replace: ["fill"] }, '"fill"', '"color"');
    await refused({ patch: { fill: { type: "linear", angle: 0 } }, replace: ["fill"] }, '"stops"');
    await refused({ patch: { border: { paint: { type: "radial", stops: [] }, width: 1, dash: "solid" } }, replace: ["border"] }, '"border"', '"cx"');
    // A paint's own number outside its field's range.
    await refused({ patch: { fill: { type: "solid", color: "#ff0000", opacity: 2 } }, replace: ["fill"] }, '"fill"', '"opacity"');
    expect(await nodeOf<ShapeNode>(doc(), "s")).toEqual(before);
    // A stroke, and a paint of a type no plugin registers, are taken.
    await api.run(PATH, "node.update", { id: "s", patch: { border: { paint: { type: "solid", color: "#00ff00" }, width: 2, dash: "dash" } }, replace: ["border"] });
    await api.run(PATH, "node.update", { id: "s", patch: { fill: { type: "x.future", amount: 1 } }, replace: ["fill"] });
    const after = await nodeOf<ShapeNode>(doc(), "s");
    expect(after.border).toEqual({ paint: { type: "solid", color: "#00ff00" }, width: 2, dash: "dash" });
    expect(after.fill).toEqual({ type: "x.future", amount: 1 });
    // A connector's line.
    await api.run(PATH, "node.update", { id: "c", patch: { stroke: { paint: { type: "solid", color: "#0000ff" }, width: 1, dash: "solid" } }, replace: ["stroke"] });
    expect((await nodeOf<ConnectorNode>(doc(), "c")).stroke).toEqual({ paint: { type: "solid", color: "#0000ff" }, width: 1, dash: "solid" });
  });

  test("null turns a border off, a stroke turns it back on; an empty name removes the name", async () => {
    const { api, doc } = await withShapeAndConnector();
    await api.run(PATH, "node.update", { id: "s", patch: { border: null, name: "Box" } });
    expect(await nodeOf<ShapeNode>(doc(), "s")).toMatchObject({ border: null, name: "Box" });
    await api.run(PATH, "node.update", { id: "s", patch: { border: defaultBorder(), name: "" } });
    const s = await nodeOf<ShapeNode>(doc(), "s");
    expect(s.border).toEqual(defaultBorder());
    expect("name" in s).toBe(false);
  });

  test("moving a shape is followed by its connector in the same commit", async () => {
    const { api, view } = await withShapeAndConnector({ open: true });
    const store = view!.store;
    const before = store.doc;
    await api.run(PATH, "node.update", { id: "s", patch: { x: 300 } });
    const c = store.doc.nodes.find((n) => n.id === "c") as ConnectorNode;
    expect(c.x + c.width).toBeGreaterThanOrEqual(300);
    store.undo();
    expect(store.doc).toEqual(before);
  });

  test("a route change re-computes the connector's bounds and brings the route's default params", async () => {
    const { api, doc, registries } = await withShapeAndConnector();
    await api.run(PATH, "node.update", { id: "c", patch: { route: "curved" } });
    const current = await doc();
    const c = current.nodes.find((n) => n.id === "c") as ConnectorNode;
    expect(c.routeParams).toEqual({ bend: 0.25 });
    const bounds = resolveConnector(current, c, registries).bounds;
    expect({ x: c.x, y: c.y, width: c.width, height: c.height }).toEqual(bounds);
    // A curve bends away from the straight line, so its box is not the straight one's.
    const straight = resolveConnector(current, { ...c, route: "straight", routeParams: {} }, registries).bounds;
    expect(bounds).not.toEqual(straight);
    // Given params are kept.
    await api.run(PATH, "node.update", { id: "c", patch: { route: "orthogonal", routeParams: { offset: 0.2 } } });
    expect((await nodeOf<ConnectorNode>(doc(), "c")).routeParams).toEqual({ offset: 0.2 });
  });

  test("a width or height under a millimetre is a millimetre, as a resize by a handle keeps it; a connector's box stays its own", async () => {
    const { api, doc } = await withShapeAndConnector();
    await api.run(PATH, "node.update", { id: "s", patch: { width: 0, height: 0.5 } });
    expect(await nodeOf<ShapeNode>(doc(), "s")).toMatchObject({ width: MIN_NODE_PX, height: MIN_NODE_PX });
    await api.run(PATH, "node.update", { id: "s", patch: { width: 40 } });
    expect((await nodeOf<ShapeNode>(doc(), "s")).width).toBe(40);
    const c = await nodeOf<ConnectorNode>(doc(), "c");
    await api.run(PATH, "node.update", { id: "c", patch: { height: 0 } });
    expect((await nodeOf<ConnectorNode>(doc(), "c")).height).toBe(c.height);
  });

  test("an end snapped to an anchor without naming one takes the anchor nearest where it is drawn", async () => {
    const { api, doc } = await withShapeAndConnector();
    // The box is (100, 100, 100 × 50). Snapped to its centre, the end is drawn where the line from the other end leaves
    // the box: from (150, 0), straight above, that is the top middle, the north anchor.
    await api.run(PATH, "node.update", { id: "c", patch: { ends: [{ kind: "free", x: 0, y: 125 }, { kind: "attached", node: "s", snap: "center" }] } });
    expect((await nodeOf<ConnectorNode>(doc(), "c")).ends[1]).toEqual({ kind: "attached", node: "s", snap: "center" });
    await api.run(PATH, "node.update", { id: "c", patch: { ends: [{ kind: "free", x: 150, y: 0 }, { kind: "attached", node: "s", snap: "anchor" }] } });
    expect((await nodeOf<ConnectorNode>(doc(), "c")).ends[1]).toEqual({ kind: "attached", node: "s", snap: "anchor", anchor: "n" });
  });

  test.each([
    ["a missing node", { id: "p-none", patch: {} }, /no node "p-none"/],
    ["a new id", { id: "s", patch: { id: "s2" } }, /"id" cannot change/],
    ["a new type", { id: "s", patch: { type: "text" } }, /"type" cannot change/],
    ["a stroke without a dash", { id: "s", patch: { border: { dash: "wavy" } } }, /"border" must be a stroke/],
    ["a paint without a type", { id: "s", patch: { fill: { type: 3 } } }, /"fill" must be a paint/],
    ["a number that is not finite", { id: "s", patch: { x: Infinity } }, /not finite/],
    ["a base field of the wrong type", { id: "s", patch: { locked: "yes" } }, /"locked" must be true or false/],
    ["an unknown page", { id: "s", patch: { page: "pg-9" } }, /no page "pg-9"/],
    ["one end", { id: "c", patch: { ends: [{ kind: "free", x: 0, y: 0 }] } }, /"ends" must be two ends/],
    ["an end on a missing node", { id: "c", patch: { ends: [{ kind: "free", x: 0, y: 0 }, { kind: "attached", node: "nope", snap: "center" }] } }, /"ends.1" is attached to "nope", which is not a node/],
    ["an end on a connector", { id: "c", patch: { ends: [{ kind: "attached", node: "c", snap: "center" }, { kind: "free", x: 0, y: 0 }] } }, /"ends.0" cannot attach to "c" \(a connector\)/],
    ["an end on a node of another page", { id: "c", patch: { page: "pg-2", ends: [{ kind: "free", x: 0, y: 0 }, { kind: "attached", node: "s", snap: "center" }] } }, /"ends.1" is attached to "s", which is on another page/],
    ["a prototype key", { id: "s", patch: JSON.parse('{"__proto__": {"x": 1}}') }, /may not have a key "__proto__"/],
  ])("%s is an error that changes nothing", async (_name, args, message) => {
    const { api, saved } = await withShapeAndConnector({ secondPage: true });
    const before = saved();
    await expect(api.run(PATH, "node.update", args)).rejects.toThrow(message);
    expect(saved()).toEqual(before);
  });
});

describe("page.update", () => {
  const pageOf = async (doc: Promise<Document>) => (await doc).pages[0];

  test("merges the patch into the page, keeping unknown keys; a preset sets the size, and a size of its own makes it custom", async () => {
    const { api, doc } = setup();
    expect(await api.run(PATH, "page.update", { id: "pg-1", patch: { name: "Main", margins: { left: 15 }, futureKey: 1 } })).toEqual({ id: "pg-1" });
    expect(await pageOf(doc())).toMatchObject({ name: "Main", margins: { top: 0, right: 0, bottom: 0, left: 15 }, futureKey: 1 });
    await api.run(PATH, "page.update", { id: "pg-1", patch: { preset: "nature-double" } });
    expect(await pageOf(doc())).toMatchObject({ preset: "nature-double", width: 183, height: 170 });
    // The preset first, then the size given with it: the page is that size, and custom.
    await api.run(PATH, "page.update", { id: "pg-1", patch: { height: 100, preset: "a4-portrait" } });
    expect(await pageOf(doc())).toMatchObject({ preset: "custom", width: 210, height: 100 });
    await api.run(PATH, "page.update", { id: "pg-1", patch: { grid: { show: true } } });
    expect((await pageOf(doc())).grid).toEqual({ spacing: 5, show: true });
  });

  test("in an open view it is one undo step, and a size over the page limit is cut down to it and said", async () => {
    const { api, view } = setup({ open: true });
    const store = view!.store;
    const limits: number[] = [];
    const ctx = view!.commandContext;
    view!.commandContext = () => {
      const c = ctx();
      return { ...c, view: { ...c.view!, pageLimitMm: () => 1000, notePageLimit: (mm: number) => void limits.push(mm) } as never };
    };
    const before = store.doc;
    await api.run(PATH, "page.update", { id: "pg-1", patch: { width: 1500, paper: "#eeeeee" } });
    expect(store.doc.pages[0]).toMatchObject({ width: 1000, paper: "#eeeeee", preset: "custom" });
    expect(limits).toEqual([1000]);
    store.undo();
    expect(store.doc).toEqual(before);
  });

  test('the paper may be "transparent" (the exporters flatten it onto white where they must)', async () => {
    const { api, doc } = setup();
    await api.run(PATH, "page.update", { id: "pg-1", patch: { paper: "transparent" } });
    expect((await pageOf(doc())).paper).toBe("transparent");
    await api.run(PATH, "page.update", { id: "pg-1", patch: { paper: "#eeeeee" } });
    expect((await pageOf(doc())).paper).toBe("#eeeeee");
  });

  test.each([
    ["a missing page", { id: "pg-9", patch: {} }, /no page "pg-9"/],
    ["a new id", { id: "pg-1", patch: { id: "pg-2" } }, /"id" cannot change/],
    ["a width of 0", { id: "pg-1", patch: { width: 0 } }, /"width" must be more than 0/],
    ["a paper that is not #rrggbb", { id: "pg-1", patch: { paper: "red" } }, /"paper" must match/],
    ["a paper of \"none\" (only \"transparent\" says there is none)", { id: "pg-1", patch: { paper: "none" } }, /"paper" must match/],
    ["a negative margin", { id: "pg-1", patch: { margins: { top: -1 } } }, /"margins.top" must be at least 0/],
    ["a grid without spacing", { id: "pg-1", patch: { grid: { spacing: 0 } } }, /"grid.spacing" must be more than 0/],
    ["a name that is not a string", { id: "pg-1", patch: { name: 3 } }, /"name" must be a string/],
  ])("%s is an error that changes nothing", async (_name, args, message) => {
    const { api, saved } = setup();
    const before = saved();
    await expect(api.run(PATH, "page.update", args)).rejects.toThrow(message);
    expect(saved()).toEqual(before);
  });
});

describe("connector.setEnd", () => {
  test("attaches an end, then frees it", async () => {
    const { api, doc } = setup();
    await api.batch(PATH, [
      { id: "shape.create", args: { id: "s", page: "pg-1", x: 100, y: 100, width: 100, height: 50 } },
      { id: "connector.create", args: { id: "c", page: "pg-1", from: { kind: "free", x: 0, y: 0 }, to: { kind: "free", x: 50, y: 0 } } },
    ]);
    const attached = { kind: "attached", node: "s", snap: "center" } as const;
    expect(await api.run(PATH, "connector.setEnd", { id: "c", which: 1, end: attached })).toEqual({ id: "c" });
    expect((await nodeOf<ConnectorNode>(doc(), "c")).ends).toEqual([{ kind: "free", x: 0, y: 0 }, attached]);
    await api.run(PATH, "connector.setEnd", { id: "c", which: 0, end: { kind: "free", x: 5, y: 6 } });
    expect((await nodeOf<ConnectorNode>(doc(), "c")).ends[0]).toEqual({ kind: "free", x: 5, y: 6 });
  });

  test("a node that is not a connector, an end on a missing node, and which 2 are errors", async () => {
    const { api } = setup();
    await api.run(PATH, "connector.create", { id: "c", page: "pg-1", from: { kind: "free", x: 0, y: 0 }, to: { kind: "free", x: 50, y: 0 } });
    await expect(api.run(PATH, "connector.setEnd", { id: "t", which: 0, end: { kind: "free", x: 0, y: 0 } })).rejects.toThrow(/"t" is not a connector/);
    await expect(api.run(PATH, "connector.setEnd", { id: "c", which: 0, end: { kind: "attached", node: "p-none", snap: "center" } })).rejects.toThrow(/not a node/);
    await expect(api.run(PATH, "connector.setEnd", { id: "c", which: 2, end: { kind: "free", x: 0, y: 0 } })).rejects.toThrow(/"which" must be one of 0, 1/);
    // A connector cannot attach to a connector.
    await api.run(PATH, "connector.create", { id: "d", page: "pg-1", from: { kind: "free", x: 0, y: 9 }, to: { kind: "free", x: 50, y: 9 } });
    await expect(api.run(PATH, "connector.setEnd", { id: "c", which: 0, end: { kind: "attached", node: "d", snap: "center" } })).rejects.toThrow(/cannot attach to "d"/);
  });
});

describe("shape.operate", () => {
  async function twoShapes() {
    const s = setup({ open: true });
    await s.api.batch(PATH, [
      { id: "shape.create", args: { id: "a", x: 0, y: 0, width: 50, height: 30 } },
      { id: "shape.create", args: { id: "b", x: 100, y: 10, width: 50, height: 30 } },
    ]);
    return s;
  }

  test("commits what the operation returns, adding and removing, as one undo step", async () => {
    const { api, view } = await twoShapes();
    const store = view!.store;
    const before = store.doc;
    expect(await api.run(PATH, "shape.operate", { operation: "test.cover", ids: ["a", "b"] })).toEqual({ added: ["p-cover"], removed: ["a", "b"] });
    expect(store.doc.nodes.map((n) => n.id)).toEqual(["t", "p-cover"]);
    expect(store.doc.nodes[1]).toMatchObject({ type: "shape", x: 0, y: 0, width: 150, height: 40 });
    store.undo();
    expect(store.doc).toEqual(before);
  });

  test("an unknown operation, one that does not apply, and an id that is not a shape are errors", async () => {
    const { api, view } = await twoShapes();
    const before = view!.store.doc;
    await expect(api.run(PATH, "shape.operate", { operation: "x.union", ids: ["a", "b"] })).rejects.toThrow(/no shape operation "x.union"/);
    await expect(api.run(PATH, "shape.operate", { operation: "test.cover", ids: ["a"] })).rejects.toThrow(/does not apply/);
    await expect(api.run(PATH, "shape.operate", { operation: "test.cover", ids: ["a", "t"] })).rejects.toThrow(/"t" is not a shape/);
    expect(view!.store.doc).toBe(before);
  });

  test("the registry is on the API", () => {
    const { api } = setup();
    expect(api.registries.shapeOperations.get("test.cover")).toBe(coverOperation);
  });
});

test("the drawing commands are listed with their params and need no view; all but the tools and the snap toggle are hidden from the toolbar", () => {
  const { api } = setup();
  const ids = ["shape.create", "connector.create", "node.update", "connector.setEnd", "shape.operate"];
  for (const id of ids) expect(api.commands().find((c) => c.id === id)).toMatchObject({ id, needsView: false, params: expect.any(Object) });
  // The tools (and the connector tool's snap toggle) are the toolbar's way to them; every command that takes arguments is hidden.
  expect(drawingCommands().filter((c) => !c.hidden).map((c) => c.id)).toEqual(["tool.rect", "tool.ellipse", "tool.connector", "connector.snap-mode"]);
  expect(drawingCommands().filter((c) => c.params).every((c) => c.hidden)).toBe(true);
});

test("a figure with a shape and a connector saves and reopens unchanged", async () => {
  const { api, saved } = setup();
  await api.batch(PATH, [
    { id: "shape.create", args: { id: "s", page: "pg-1", x: 100, y: 100, width: 100, height: 50 } },
    { id: "connector.create", args: { id: "c", page: "pg-1", route: "orthogonal", from: { kind: "free", x: 0, y: 0 }, to: { kind: "attached", node: "s", snap: "anchor", anchor: "w" } } },
  ]);
  // Headless, so the batch was saved to the file and `saved` reads it back as a view would open it.
  const doc = saved();
  expect(doc.nodes.find((n) => n.id === "c")).toMatchObject({ route: "orthogonal", routeParams: { offset: 0.5 }, ends: [{ kind: "free" }, { kind: "attached", node: "s" }] });
  const again = loadDocument(serializeFigureFile(doc, emptyParsed())).doc;
  expect(again).toEqual(doc);
  expect(again.nodes.map((n) => n.type)).toEqual(["text", "shape", "connector"]);
});
