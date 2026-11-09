import { createApi, type ApiHost } from "../../src/api";
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { panelCommands } from "../../src/commands/panels";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { DEFAULT_PAGE_LIMIT_MM, MIN_NODE_PX } from "../../src/constants";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, createPage, textNodeDefaults } from "../../src/model/defaults";
import { pageOriginsPx } from "../../src/model/geometry";
import type { ConnectorNode, Document } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { textNodeType } from "../../src/nodes/text-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import { CommandError } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { normalizePath } from "../export/fake-vault";

// The panel node type is not needed: `panel.create` only builds a file node.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

const PATH = "figs/fig.lnkfig.md";

function registries(): Registries {
  const r = createRegistries();
  r.nodeTypes.register(shapeNodeType);
  r.nodeTypes.register(connectorNodeType);
  r.nodeTypes.register(textNodeType);
  for (const kind of builtinShapeKinds) r.shapes.register(kind);
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  for (const paint of builtinPaintTypes) r.paints.register(paint);
  for (const command of drawingCommands()) r.commands.register(command);
  for (const command of panelCommands()) r.commands.register(command);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  return r;
}

/** Two A4 pages, `pg-1` and `pg-2`, and a label `t` on the first. */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  doc.pages.push({ ...createPage("a4-portrait", ["pg-1"]), id: "pg-2" });
  doc.nodes.push(textNodeDefaults(doc.pages[0], { id: "t" }, []));
  return doc;
}

/** The API on one figure file kept in memory, headless; `host` adds to what the API is given. */
function setup(host: Partial<ApiHost> = {}) {
  const r = registries();
  const text = new Map([[PATH, serializeFigureFile(figure(), emptyParsed())]]);
  const files = {
    read: async (path: string) => text.get(path)!,
    async process(path: string, edit: (t: string) => string) {
      text.set(path, edit(text.get(path)!));
    },
  };
  const api = createApi({ app: {} as never, registries: r, files, normalizePath, openFigure: () => null, ...host });
  const saved = () => loadDocument(text.get(PATH)!).doc;
  return { api, saved };
}

const refuses = async (run: Promise<unknown>, message: RegExp) => {
  await expect(run).rejects.toThrow(CommandError);
  await expect(run).rejects.toThrow(message);
};

describe("page size: headless page.update keeps to the page-size limit setting, as the inspector does", () => {
  test("a width or height over the setting is cut down to it, and the page is custom", async () => {
    const { api, saved } = setup({ pageLimitMm: () => 1000 });
    await api.run(PATH, "page.update", { id: "pg-1", patch: { width: 1500, height: 1200 } });
    expect(saved().pages[0]).toMatchObject({ width: 1000, height: 1000, preset: "custom" });
  });

  test("without the setting, the default limit", async () => {
    const { api, saved } = setup();
    await api.run(PATH, "page.update", { id: "pg-1", patch: { width: DEFAULT_PAGE_LIMIT_MM + 500 } });
    expect(saved().pages[0].width).toBe(DEFAULT_PAGE_LIMIT_MM);
  });

  test("add-page with a preset larger than the setting gets the setting's size", async () => {
    const { api, saved } = setup({ pageLimitMm: () => 200 });
    const { id } = (await api.run(PATH, "add-page", { page: "pg-1", preset: "a4-portrait" })) as { id: string };
    expect(saved().pages.find((p) => p.id === id)).toMatchObject({ width: 200, height: 200, preset: "custom" });
  });
});

describe("minimum size: a millimetre (MIN_NODE_PX)", () => {
  test.each([
    ["a width", { width: MIN_NODE_PX - 0.5, height: 10 }],
    ["a height", { width: 10, height: 1 }],
    ["a zero size", { width: 0, height: 0 }],
  ])("shape.create refuses %s under it, naming the command and the minimum", async (_name, size) => {
    const { api, saved } = setup();
    const before = saved();
    await refuses(api.run(PATH, "shape.create", { page: "pg-1", x: 0, y: 0, ...size }), /^shape\.create: .*at least 1 mm/);
    expect(saved()).toEqual(before);
  });

  test("shape.create takes exactly the minimum", async () => {
    const { api, saved } = setup();
    const { id } = (await api.run(PATH, "shape.create", { page: "pg-1", x: 0, y: 0, width: MIN_NODE_PX, height: MIN_NODE_PX })) as { id: string };
    expect(saved().nodes.find((n) => n.id === id)).toMatchObject({ width: MIN_NODE_PX, height: MIN_NODE_PX });
  });

  test("panel.create refuses a width or height under it", async () => {
    const { api } = setup();
    await refuses(api.run(PATH, "panel.create", { page: "pg-1", file: "a.png", x: 0, y: 0, width: 1 }), /^panel\.create: .*at least 1 mm/);
    await refuses(api.run(PATH, "panel.create", { page: "pg-1", file: "a.png", x: 0, y: 0, width: 50, height: 2 }), /^panel\.create: .*at least 1 mm/);
  });

  test("node.update keeps a size under it to it", async () => {
    const { api, saved } = setup();
    await api.run(PATH, "node.update", { id: "t", patch: { width: 1, height: 0 } });
    expect(saved().nodes[0]).toMatchObject({ width: MIN_NODE_PX, height: MIN_NODE_PX });
  });
});

describe("presets: an id that is not a page preset is refused", () => {
  test("by page.update; the custom preset is fine", async () => {
    const { api, saved } = setup();
    const before = saved();
    await refuses(api.run(PATH, "page.update", { id: "pg-1", patch: { preset: "x.poster" } }), /^page\.update: there is no page preset "x\.poster"/);
    expect(saved()).toEqual(before);
    await api.run(PATH, "page.update", { id: "pg-1", patch: { preset: "custom" } });
    expect(saved().pages[0]).toMatchObject({ preset: "custom", width: 210, height: 297 });
  });

  test("by add-page; a known one gives the new page that preset", async () => {
    const { api, saved } = setup();
    await refuses(api.run(PATH, "add-page", { page: "pg-1", preset: "x.poster" }), /^add-page: there is no page preset "x\.poster"/);
    expect(saved().pages).toHaveLength(2);
    const { id } = (await api.run(PATH, "add-page", { page: "pg-1", preset: "a4-landscape" })) as { id: string };
    const pages = saved().pages;
    expect(pages.map((p) => p.id)).toEqual(["pg-1", id, "pg-2"]);
    expect(pages[1]).toMatchObject({ preset: "a4-landscape", width: 297, height: 210 });
  });
});

/** A rectangle `s` on pg-1 and a connector `c` from free (0, 0) to its west anchor. */
async function withConnector(host: Partial<ApiHost> = {}) {
  const s = setup(host);
  await s.api.batch(PATH, [
    { id: "shape.create", args: { id: "s", page: "pg-1", x: 100, y: 100, width: 100, height: 50 } },
    { id: "connector.create", args: { id: "c", page: "pg-1", from: { kind: "free", x: 10, y: 20 }, to: { kind: "attached", node: "s", snap: "anchor", anchor: "w" } } },
  ]);
  const connector = () => s.saved().nodes.find((n) => n.id === "c") as ConnectorNode;
  return { ...s, connector };
}

describe("moving a connector", () => {
  test("node.update {page} on a connector attached to items on its page is refused, naming node.move", async () => {
    const { api, saved } = await withConnector();
    const before = saved();
    await refuses(api.run(PATH, "node.update", { id: "c", patch: { page: "pg-2" } }), /^node\.update: .*node\.move/);
    expect(saved()).toEqual(before);
  });

  test("a connector with free ends only goes to another page by node.update", async () => {
    const { api, connector } = await withConnector();
    await api.run(PATH, "node.update", { id: "c", patch: { ends: [{ kind: "free", x: 10, y: 20 }, { kind: "free", x: 50, y: 60 }] } });
    await api.run(PATH, "node.update", { id: "c", patch: { page: "pg-2" } });
    expect(connector().page).toBe("pg-2");
  });

  test("so does one whose ends the same patch frees", async () => {
    const { api, connector } = await withConnector();
    await api.run(PATH, "node.update", { id: "c", patch: { page: "pg-2", ends: [{ kind: "free", x: 10, y: 20 }, { kind: "free", x: 50, y: 60 }] } });
    expect(connector().page).toBe("pg-2");
  });

  test("a free end that follows its items onto another page is moved by the drag, then by the page-origin delta, as they are", async () => {
    const { api, saved, connector } = await withConnector();
    const origins = pageOriginsPx(saved());
    const delta = origins.get("pg-2")!.y - origins.get("pg-1")!.y;
    // Down by the second page's offset and 30 px more: s lands 30 px lower than it was, on the second page, and the
    // connector goes with it, its free end 30 px lower too (a free end left where it was would still be at y 20).
    await api.run(PATH, "node.move", { ids: ["s", "c"], dx: 0, dy: delta + 30 });
    expect(saved().nodes.find((n) => n.id === "s")).toMatchObject({ page: "pg-2", x: 100, y: 130 });
    expect(connector()).toMatchObject({ page: "pg-2", ends: [{ kind: "free", x: 10, y: 50 }, { kind: "attached", node: "s", anchor: "w" }] });
  });
});

describe("a malformed sibling field next to an end that needs its nearest anchor", () => {
  const anchorless = { kind: "attached", node: "s", snap: "anchor" };
  test.each([
    ["caps", 5, /"caps" must be two caps/],
    ["stroke", "thick", /stroke/],
    ["routeParams", 3, /routeParams/],
    ["stroke", null, /stroke/],
    ["caps", [{ kind: "none", size: 1 }], /"caps" must be two caps/],
  ])("%s: no TypeError; the command reports the malformed field", async (key, value, message) => {
    const { api, saved } = await withConnector();
    const before = saved();
    const run = api.run(PATH, "node.update", { id: "c", patch: { ends: [{ kind: "free", x: 0, y: 0 }, anchorless], [key]: value } });
    await refuses(run, /^node\.update: /);
    await expect(run).rejects.toThrow(message);
    expect(saved()).toEqual(before);
  });
});

test("an error in drawing the line that is not a malformed field is not swallowed", async () => {
  const s = await withConnector();
  // A registered route that fails: its error reaches the caller rather than being taken for a malformed field.
  const r = (s.api as unknown as { registries: Registries }).registries;
  const straight = r.routes.get("straight")!;
  let calls = 0;
  // It fails the first time only, which is when the nearest anchor is looked for: a later draw (the normaliser's) works.
  r.routes.register({ ...straight, id: "x.broken", path: (...args: Parameters<typeof straight.path>) => {
    if (calls++ === 0) throw new Error("route exploded");
    return straight.path(...args);
  } } as never);
  const run = s.api.run(PATH, "node.update", { id: "c", patch: { route: "x.broken", ends: [{ kind: "free", x: 0, y: 0 }, { kind: "attached", node: "s", snap: "anchor" }] } });
  await expect(run).rejects.toThrow("route exploded");
});

describe("a stroke with a key no stroke has is refused (check 16), the same for connectors and shapes", () => {
  const KNOWN = /"stroke\.color" is not a stroke key: a stroke has paint, width, dash, cap and join/;
  test("node.update of a connector's stroke with {color}", async () => {
    const { api, saved } = await withConnector();
    const before = saved();
    const run = api.run(PATH, "node.update", { id: "c", patch: { stroke: { color: "#ff0000" } } });
    await refuses(run, /^node\.update: /);
    await expect(run).rejects.toThrow(KNOWN);
    expect(saved()).toEqual(before);
  });

  test("node.update of a shape's border, shape.create and connector.create say the same", async () => {
    const { api, saved } = await withConnector();
    const before = saved();
    await refuses(api.run(PATH, "node.update", { id: "s", patch: { border: { color: "#ff0000" } } }), /"border\.color" is not a stroke key: a stroke has paint, width, dash, cap and join/);
    const stroke = { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid", color: "#ff0000" };
    await refuses(api.run(PATH, "shape.create", { page: "pg-1", x: 0, y: 0, width: 50, height: 50, border: stroke }), /^shape\.create: .*"border\.color" is not a stroke key/);
    await refuses(api.run(PATH, "connector.create", { page: "pg-1", from: { kind: "free", x: 0, y: 0 }, to: { kind: "free", x: 9, y: 9 }, stroke }), /^connector\.create: .*"stroke\.color" is not a stroke key/);
    expect(saved()).toEqual(before);
  });

  test("a whole stroke, with a cap and a join, is still taken; and a file with such strokes still loads", async () => {
    const { api, connector, saved } = await withConnector();
    const stroke = { paint: { type: "solid", color: "#ff0000" }, width: 2, dash: "dash", cap: "round", join: "bevel" };
    await api.run(PATH, "node.update", { id: "c", patch: { stroke } });
    await api.run(PATH, "node.update", { id: "s", patch: { border: stroke } });
    expect(connector().stroke).toEqual(stroke);
    expect(saved().nodes.find((n) => n.id === "s")).toMatchObject({ border: stroke });
    // A file is read as it always was: a key it has beside a stroke's own (written before this check) is kept, not refused.
    const doc = saved();
    const c = doc.nodes.find((n) => n.id === "c") as ConnectorNode;
    (c.stroke as unknown as Record<string, unknown>).color = "#00ff00";
    expect((loadDocument(serializeFigureFile(doc, emptyParsed())).doc.nodes.find((n) => n.id === "c") as ConnectorNode).stroke).toEqual({ ...stroke, color: "#00ff00" });
  });
});

