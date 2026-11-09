import { groupCommands } from "../../src/commands/groups";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall, withHeadlessFigure } from "../../src/commands/headless";
import { FormatError } from "../../src/format/errors";
import { loadDocument } from "../../src/format/load";
import { parseFigureFile } from "../../src/format/parse";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Document, Node } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";

/** A node of a type no plugin here registers, with keys of its own (nested ones among them). */
const foreign = (pageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "x-1",
  type: "x.chart",
  page: pageId,
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  z: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  series: [{ name: "a", values: [1, 2, 3] }],
  style: { theme: "dark", nested: { deep: true } },
  ...extra,
});

/** A figure file holding `nodes` (raw JSON) on one page, as the plugin writes it. */
function fileWith(nodes: Record<string, unknown>[]): string {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const raw = nodes.map((n) => ({ ...n, page: n.page ?? page.id }));
  return serializeFigureFile({ ...doc, nodes: raw as unknown as Node[] }, emptyParsed());
}

function registries() {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(groupNodeType);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const c of drawingCommands()) r.commands.register(c);
  for (const c of groupCommands()) r.commands.register(c);
  return r;
}

describe("loading a node of a type no plugin registers", () => {
  test("it is kept as it is, every unknown key included", () => {
    const doc = createDocument("a4-portrait");
    const text = fileWith([foreign(doc.pages[0].id)]);
    const node = loadDocument(text).doc.nodes[0] as unknown as Record<string, unknown>;
    expect(node).toEqual(foreign(node.page as string));
  });

  test("a file holding one saves byte for byte as it was", () => {
    const doc = createDocument("a4-portrait");
    const text = fileWith([foreign(doc.pages[0].id), shapeNodeDefaults(doc.pages[0], { id: "s-1" }, []) as unknown as Record<string, unknown>]);
    const { doc: loaded, parsed } = loadDocument(text);
    expect(serializeFigureFile(loaded, parsed)).toBe(text);
  });

  test("z, rotation, opacity and locked are filled in when missing; nothing else is", () => {
    const doc = createDocument("a4-portrait");
    const { z: _z, rotation: _r, opacity: _o, locked: _l, ...bare } = foreign(doc.pages[0].id);
    const node = loadDocument(fileWith([bare])).doc.nodes[0];
    expect(node).toEqual({ ...bare, z: 0, rotation: 0, opacity: 1, locked: false });
  });

  test("it still needs the base fields", () => {
    const doc = createDocument("a4-portrait");
    for (const key of ["x", "y", "width", "height"]) {
      const { [key]: _gone, ...without } = foreign(doc.pages[0].id);
      expect(() => loadDocument(fileWith([without]))).toThrow(FormatError);
    }
    expect(() => loadDocument(fileWith([{ ...foreign(doc.pages[0].id), id: "" }]))).toThrow(/no id/);
    expect(() => loadDocument(fileWith([{ ...foreign(doc.pages[0].id), page: 3 }]))).toThrow(/no page/);
  });

  test("a figure store keeps it unchanged, and a headless call on another node leaves it byte for byte", async () => {
    const doc = createDocument("a4-portrait");
    const shape = shapeNodeDefaults(doc.pages[0], { id: "s-1" }, []) as unknown as Record<string, unknown>;
    const text = fileWith([foreign(doc.pages[0].id), shape]);
    const r = registries();
    let file = text;
    const files = { read: async () => file, process: async (_p: string, edit: (t: string) => string) => void (file = edit(file)) };
    await withHeadlessFigure({} as never, r, files, "f.lnkfig.md", (ctx, store) =>
      runCall(store, ctx, prepareCall(r, { id: "node.update", args: { id: "s-1", patch: { x: 5 } } })),
    );
    const body = JSON.parse(parseFigureFile(file).bodyJson!);
    expect(body.nodes[0]).toEqual(foreign(doc.pages[0].id));
    expect(body.nodes[1].x).toBe(5);
  });
});

describe("editing a node of a type no plugin registers", () => {
  function setup() {
    const doc = createDocument("a4-portrait");
    const page = doc.pages[0];
    const nodes = [foreign(page.id) as unknown as Node, shapeNodeDefaults(page, { id: "s-1", x: 200, y: 20, width: 10, height: 10, z: 1 }, [])];
    const r = registries();
    const store = createFigureStore({ ...doc, nodes } as Document, r);
    const ctx = { app: {} as never, registries: r, view: null, store, selection: [], page: undefined };
    const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx, prepareCall(r, { id, args }));
    return { store, call };
  }

  test("it can be moved and resized, and its own keys stay", async () => {
    const { store, call } = setup();
    await call("node.update", { id: "x-1", patch: { x: 30, width: 120 } });
    expect(store.doc.nodes[0]).toEqual({ ...foreign(store.doc.pages[0].id), x: 30, width: 120 });
  });

  test("it can be grouped, and the group's box takes it in", async () => {
    const { store, call } = setup();
    const { id } = (await call("group.create", { ids: ["x-1", "s-1"] })) as { id: string };
    const group = store.doc.nodes.find((n) => n.id === id)!;
    expect(group).toMatchObject({ type: "group", x: 10, y: 20, width: 200, height: 50 });
    expect((store.doc.nodes.find((n) => n.id === "x-1") as unknown as Record<string, unknown>).series).toEqual(foreign("").series);
  });
});

describe("a type a plugin registers: its NodeType's migrate hook", () => {
  const chartType = (migrate?: NodeType["migrate"]): NodeType =>
    ({
      type: "x.chart",
      name: "Chart",
      icon: "chart",
      mount: () => ({ update() {}, unmount() {} }),
      bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }),
      inspector: () => [],
      toSvg: () => "",
      ...(migrate ? { migrate } : {}),
    }) as unknown as NodeType;

  test("validates and completes the type's own nodes", () => {
    const doc = createDocument("a4-portrait");
    const r = registries();
    const seen: Record<string, unknown>[] = [];
    r.nodeTypes.register(
      chartType((raw) => {
        seen.push(raw);
        return { ...raw, series: raw.series ?? [] } as unknown as Node;
      }),
    );
    const { series: _s, ...bare } = foreign(doc.pages[0].id);
    const node = loadDocument(fileWith([bare]), r).doc.nodes[0] as unknown as Record<string, unknown>;
    expect(seen).toEqual([bare]);
    expect(node.series).toEqual([]);
  });

  test("a hook that throws refuses the file, naming the node", () => {
    const doc = createDocument("a4-portrait");
    const r = registries();
    r.nodeTypes.register(
      chartType(() => {
        throw new Error('"series" must be a list');
      }),
    );
    expect(() => loadDocument(fileWith([foreign(doc.pages[0].id)]), r)).toThrow(FormatError);
    expect(() => loadDocument(fileWith([foreign(doc.pages[0].id)]), r)).toThrow('Node x-1: "series" must be a list');
  });

  test("a hook that changes the node's id or type refuses the file", () => {
    const doc = createDocument("a4-portrait");
    const r = registries();
    r.nodeTypes.register(chartType((raw) => ({ ...raw, id: "other" }) as Node));
    expect(() => loadDocument(fileWith([foreign(doc.pages[0].id)]), r)).toThrow(FormatError);
  });

  test("without the hook, the node is accepted as it is", () => {
    const doc = createDocument("a4-portrait");
    const r = registries();
    r.nodeTypes.register(chartType());
    const text = fileWith([foreign(doc.pages[0].id)]);
    const { doc: loaded, parsed } = loadDocument(text, r);
    expect(loaded.nodes[0]).toEqual(foreign(doc.pages[0].id));
    expect(serializeFigureFile(loaded, parsed)).toBe(text);
  });

  test("a built-in type is migrated by this plugin, whatever is registered", () => {
    const doc = createDocument("a4-portrait");
    const r = registries();
    const hook = vi.fn((raw: Record<string, unknown>) => raw as unknown as Node);
    r.nodeTypes.register({ ...shapeNodeType, migrate: hook } as unknown as NodeType);
    loadDocument(fileWith([shapeNodeDefaults(doc.pages[0], { id: "s-1" }, []) as unknown as Record<string, unknown>]), r);
    expect(hook).not.toHaveBeenCalled();
  });
});
