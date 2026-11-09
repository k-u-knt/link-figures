// @vitest-environment happy-dom
import { registerBuiltinCommands } from "../../src/commands/builtin";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall, runHeadless } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { buildPageSvg } from "../../src/export/svg-builder";
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
import type { NodeType, RenderContext } from "../../src/registry/node-type";
import { builtinShapeKinds } from "../../src/shapes/builtin";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

beforeAll(() => {
  (HTMLElement.prototype as unknown as { createDiv: unknown }).createDiv = function (this: HTMLElement, info: { cls?: string | string[] } = {}) {
    const el = this.ownerDocument.createElement("div");
    if (info.cls) el.classList.add(...(Array.isArray(info.cls) ? info.cls : [info.cls]));
    this.appendChild(el);
    return el;
  };
});

/**
 * Check 17: an item whose `migrate` hook threw is unreadable, and none of its type's hooks is called on it. Its type here
 * has a spy `attachable` (which would answer, so a call is not hidden by the fallback) that must never be called.
 */
function registries() {
  const r = createRegistries();
  for (const t of [shapeNodeType, groupNodeType, connectorNodeType] as NodeType[]) r.nodeTypes.register(t);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  registerBuiltinCommands({ registries: r, addCommand: () => undefined, activeFigureView: () => null } as never);
  for (const c of drawingCommands()) r.commands.register(c);
  const attachable = vi.fn((n: Node) => ({ outline: [], anchors: [{ id: "tip", x: n.x, y: n.y, dir: { x: 0, y: -1 } }] }));
  r.nodeTypes.register({
    type: "x.bad",
    name: "Bad",
    icon: "chart",
    mount: () => ({ update() {}, unmount() {} }),
    bounds: (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height }),
    inspector: () => [],
    toSvg: () => "<g/>",
    attachable,
    migrate: () => {
      throw new Error("boom");
    },
  } as unknown as NodeType);
  return { r, attachable };
}

/** A figure with an unreadable `u-1`, a shape `s1`, and a connector `k` from `s1` to `u-1`. */
function fileText(): string {
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  const bad = { id: "u-1", type: "x.bad", page: page.id, x: 100, y: 100, width: 40, height: 40, z: 0, rotation: 0, opacity: 1, locked: false };
  const shape = shapeNodeDefaults(page, { id: "s1", x: 10, y: 10, width: 20, height: 20, z: 1 }, []);
  const k = connectorNodeDefaults(page, { id: "k", z: 2, ends: [{ kind: "attached", node: "s1", snap: "center" }, { kind: "attached", node: "u-1", snap: "center" }] }, []);
  return serializeFigureFile({ ...doc, nodes: [bad, shape, k] as unknown as Node[] }, emptyParsed());
}

test("an unreadable item's attachable hook is never called: create, commit, move, duplicate, update, render and export", async () => {
  const { r, attachable } = registries();
  const text = fileText();
  const loaded = loadDocument(text, r);
  expect([...loaded.unreadable]).toEqual(["u-1"]);

  // Open, as the view holds it: the store keeps the set its normalisers read.
  const store = createFigureStore(loaded.doc, r, undefined, loaded.unreadable);
  expect([...store.unreadable]).toEqual(["u-1"]);
  const view = { file: { path: "f.lnkfig.md" }, unreadableNodes: store.unreadable, markUnreadable: (ids: NodeId[]) => ids.forEach((id) => store.unreadable.add(id)), selectedIds: () => [], setSelection: () => {} };
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: view as never, store, selection: [], page: store.doc.pages[0], unreadable: store.unreadable, markUnreadable: view.markUnreadable });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));

  await call("connector.create", { route: "straight", from: { kind: "attached", node: "s1", snap: "center" }, to: { kind: "attached", node: "u-1", snap: "anchor", anchor: "n" } });
  await call("node.update", { id: "s1", patch: { name: "x" } });
  await call("node.move", { ids: ["s1"], dx: 5, dy: 5 });
  await call("node.move", { ids: ["u-1"], dx: 5, dy: 5 });
  await call("duplicate", { ids: ["k", "u-1"] });
  await call("node.update", { id: "k", patch: { ends: [{ kind: "attached", node: "s1", snap: "center" }, { kind: "attached", node: "u-1", snap: "anchor" }] } });
  expect((store.doc.nodes.find((n) => n.id === "k") as ConnectorNode).ends[1]).toMatchObject({ kind: "attached", node: "u-1", snap: "anchor" });

  // The stage draws the connector.
  const host = document.createElement("div");
  const renderCtx = { registries: r, doc: () => store.doc, unreadable: store.unreadable } as unknown as RenderContext;
  connectorNodeType.mount(store.doc.nodes.find((n) => n.id === "k") as ConnectorNode, host, renderCtx).update(store.doc.nodes.find((n) => n.id === "k") as ConnectorNode);

  // An SVG export of it.
  buildPageSvg(store.doc, store.doc.pages[0], r, new Map(), { unreadable: store.unreadable });

  // Headless: the file read, edited and written back.
  let file = serializeFigureFile(store.doc, loaded.parsed);
  const files = { read: async () => file, process: async (_p: string, edit: (t: string) => string) => void (file = edit(file)) };
  await runHeadless({} as never, r, files, "f.lnkfig.md", prepareCall(r, { id: "node.move", args: { ids: ["s1"], dx: 3, dy: 0 } }));
  await runHeadless({} as never, r, files, "f.lnkfig.md", prepareCall(r, { id: "connector.create", args: { page: store.doc.pages[0].id, route: "straight", from: { kind: "free", x: 0, y: 0 }, to: { kind: "attached", node: "u-1", snap: "center" } } }));

  expect(attachable).not.toHaveBeenCalled();
});
