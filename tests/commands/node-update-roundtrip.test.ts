import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { connectorNodeDefaults, createDocument, fileNodeDefaults, shapeNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Document } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { textNodeType } from "../../src/nodes/text-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";
import type { NodeType } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));
const { fileNodeType } = await import("../../src/nodes/file-node");

/**
 * Whatever `node.update` accepts must save and load again: the file format (`migrate`) refuses less than node.update
 * does, never more. Each node type is given a set of patches, good and bad; every one node.update accepts is saved and
 * loaded, and must load as the document node.update made.
 */

function registries() {
  const r = createRegistries();
  for (const t of [fileNodeType, textNodeType, shapeNodeType, connectorNodeType] as NodeType[]) r.nodeTypes.register(t);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  for (const c of drawingCommands()) r.commands.register(c);
  return r;
}

/** One of each node type on page `pg-1`: a file panel `f`, a label `t`, a rectangle `s` and a connector `c` from `s` to a free point. */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  page.id = "pg-1";
  doc.nodes.push(
    fileNodeDefaults(page, { id: "f", file: "plot.png", subpath: "", show: "image" }, []),
    textNodeDefaults(page, { id: "t" }, []),
    shapeNodeDefaults(page, { id: "s", x: 100, y: 100, width: 100, height: 50 }, []),
    connectorNodeDefaults(page, { id: "c", ends: [{ kind: "free", x: 0, y: 0 }, { kind: "attached", node: "s", snap: "anchor", anchor: "w" }] }, []),
  );
  return doc;
}

/** Runs `node.update` on a fresh figure; the document it left, or null when it refused the patch. */
async function update(id: string, patch: Record<string, unknown>): Promise<Document | null> {
  const r = registries();
  const store = createFigureStore(figure(), r);
  const ctx: CommandContext = { app: {} as never, registries: r, view: null, store, selection: [], page: undefined };
  try {
    await runCall(store, ctx, prepareCall(r, { id: "node.update", args: { id, patch } }));
  } catch {
    return null;
  }
  return store.doc;
}

/** Values of every JSON kind, sensible and not, that a patch may put anywhere. */
const ANY: unknown[] = [
  0, -1, 0.5, 7, 2.5, "x", "", "#ff0000", "auto", "bold", "center", "cover", "content", null, true, false,
  {}, [], [1, 2], { x: 0, y: 0, w: 1, h: 1 }, { min: 0, max: 1 }, { type: "solid", color: "#000000" }, [{ type: "x" }], [{ type: 1 }],
];

/** The keys each node gets patched at: its own top-level keys and, for a label, its font's. */
const NODES: { id: string; keys: string[]; nested?: Record<string, string[]> }[] = [
  { id: "f", keys: ["x", "width", "opacity", "rotation", "z", "locked", "name", "show", "imageIndex", "crop", "fit", "pageIndex", "range", "scale", "frame", "adjustments"] },
  { id: "t", keys: ["height", "opacity", "text", "font"], nested: { font: ["family", "size", "weight", "italic", "color", "align", "lineHeight"] } },
  { id: "s", keys: ["width", "kind", "params", "fill", "border"] },
  { id: "c", keys: ["route", "routeParams", "stroke", "caps", "ends"] },
];

test.each(NODES)("every patch node.update accepts for node $id saves and loads as it was", async ({ id, keys, nested }) => {
  const patches = [
    ...keys.flatMap((key) => ANY.map((value) => ({ [key]: value }))),
    ...Object.entries(nested ?? {}).flatMap(([outer, inner]) => inner.flatMap((key) => ANY.map((value) => ({ [outer]: { [key]: value } })))),
  ];
  let accepted = 0;
  const broken: string[] = [];
  for (const patch of patches) {
    const doc = await update(id, patch);
    if (doc === null) continue;
    accepted++;
    try {
      expect(loadDocument(serializeFigureFile(doc, emptyParsed())).doc).toEqual(doc);
    } catch (error) {
      broken.push(`${JSON.stringify(patch)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  expect(broken).toEqual([]);
  // The values are a mix: some patches are accepted and some refused, or the check would say nothing.
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(patches.length);
});

test.each([
  ["t", { font: { size: "big" } }, /"font.size" must be a finite number/],
  ["t", { font: "x" }, /"font" must be an object/],
  ["t", { font: { color: "red" } }, /"font.color" must match/],
  ["t", { font: { weight: "heavy" } }, /"font.weight" must be one of/],
  ["t", { font: { lineHeight: 0 } }, /"font.lineHeight" must be more than 0/],
  ["f", { crop: 5 }, /"crop" must be an object or null/],
  ["f", { crop: { x: 0, y: 0, w: 1 } }, /"crop.h" is required/],
  ["f", { pageIndex: "two" }, /"pageIndex" must be a whole number/],
  ["f", { imageIndex: -1 }, /"imageIndex" must be at least 0/],
  ["f", { fit: "stretch" }, /"fit" must be one of/],
  ["f", { range: { min: 0 } }, /"range" must be "auto" or/],
  ["f", { scale: 0 }, /"scale" must be more than 0/],
  ["f", { adjustments: [1, 2] }, /"adjustments.0" must be an object/],
  ["f", { adjustments: [{ type: "levels", enabled: "yes" }] }, /"adjustments.0.enabled" must be true or false/],
  ["t", { width: -10 }, /"width" must be at least 0/],
  ["t", { opacity: 7 }, /"opacity" must be at most 1/],
  ["t", { rotation: "45" }, /"rotation" must be a finite number/],
])("node %s refuses %j", async (id, patch, message) => {
  const r = registries();
  const store = createFigureStore(figure(), r);
  const ctx: CommandContext = { app: {} as never, registries: r, view: null, store, selection: [], page: undefined };
  const before = store.doc;
  await expect(runCall(store, ctx, prepareCall(r, { id: "node.update", args: { id, patch } }))).rejects.toThrow(message);
  expect(store.doc).toBe(before);
});

test.each([
  ["t", { font: { size: 12, weight: "bold", italic: true, color: "#336699", align: "center", lineHeight: 1.5, family: "Helvetica" } }],
  ["f", { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, fit: "contain", pageIndex: 2, imageIndex: 1, range: { min: 10, max: 4000 }, scale: 2 }],
  ["f", { crop: null, range: "auto", adjustments: [{ type: "levels" }, { type: "future", enabled: false, params: { a: 1 } }] }],
  ["t", { width: 0, opacity: 0, rotation: -30, z: 4, locked: true, name: "A" }],
])("node %s accepts %j, and it saves and loads", async (id, patch) => {
  const doc = await update(id, patch);
  expect(doc).not.toBeNull();
  expect(loadDocument(serializeFigureFile(doc!, emptyParsed())).doc).toEqual(doc);
});
