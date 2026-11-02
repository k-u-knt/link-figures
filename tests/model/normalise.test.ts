import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { createDocument, createPage, shapeNodeDefaults } from "../../src/model/defaults";
import { connectorNormaliser } from "../../src/model/normalise";
import { DocumentStore, type ChangeEvent } from "../../src/model/store";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { createRegistries } from "../../src/registry";
import { builtinShapeKinds } from "../../src/shapes/builtin";

const registries = createRegistries();
registries.nodeTypes.register(shapeNodeType);
registries.nodeTypes.register(connectorNodeType);
for (const k of builtinShapeKinds) registries.shapes.register(k);
for (const r of builtinRoutes) registries.routes.register(r);
for (const c of builtinCapKinds) registries.caps.register(c);

const page = createPage("a4-portrait", []);
const other = createPage("a4-portrait", [page.id]);
const shape = (id: string, x: number, y: number, width = 100, height = 50): Node => ({
  ...shapeNodeDefaults(page, { kind: "rect", params: {} }, []),
  id,
  x,
  y,
  width,
  height,
});
const free = (x: number, y: number): End => ({ kind: "free", x, y });
const anchor = (node: string, id: string): End => ({ kind: "attached", node, snap: "anchor", anchor: id });
const connector = (from: End, to: End, over: Partial<ConnectorNode> = {}): ConnectorNode => ({
  id: "c",
  type: "connector",
  page: page.id,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  z: 2,
  rotation: 0,
  opacity: 1,
  locked: false,
  ends: [from, to],
  route: "orthogonal",
  routeParams: { offset: 0.5 },
  stroke: { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" },
  caps: [
    { kind: "none", size: 3 },
    { kind: "arrow", size: 3 },
  ],
  ...over,
});

/** Shapes a and b side by side, and a connector from a's right edge to b's left edge, in a store that keeps it consistent. */
function setup(c: ConnectorNode = connector(anchor("a", "e"), anchor("b", "w"))) {
  const doc: Document = { ...createDocument("a4-portrait"), pages: [page, other], nodes: [shape("a", 10, 20), shape("b", 300, 200), c] };
  let t = 0;
  const store = new DocumentStore(doc, () => (t += 10_000));
  store.addNormaliser(connectorNormaliser(registries));
  const events: ChangeEvent[] = [];
  store.subscribe((e) => events.push(e));
  return { store, events };
}

const conn = (doc: Document) => doc.nodes.find((n) => n.id === "c") as ConnectorNode;
const boxOf = (n: Node) => ({ x: n.x, y: n.y, width: n.width, height: n.height });
const index = (doc: Document, id: string) => doc.nodes.findIndex((n) => n.id === id);

test("adding the normaliser brings the current document in line at once, without history", () => {
  const { store } = setup();
  expect(boxOf(conn(store.doc))).toEqual(resolveConnector(store.doc, conn(store.doc), registries).bounds);
  expect(conn(store.doc).width).toBeGreaterThan(0);
  expect(store.canUndo()).toBe(false);
});

test("moving an attached shape updates the connector's box in the same commit, and names it as changed", () => {
  const { store, events } = setup();
  const before = boxOf(conn(store.doc));
  store.commit("move", (d) => {
    d.nodes[index(d, "b")].x += 40;
    d.nodes[index(d, "b")].y += 30;
  });
  const after = conn(store.doc);
  expect(boxOf(after)).toEqual(resolveConnector(store.doc, after, registries).bounds);
  expect(boxOf(after)).not.toEqual(before);
  expect(events).toHaveLength(1);
  expect([...events[0].changedNodeIds].sort()).toEqual(["b", "c"]);
});

test("Review Focus 1: undo of a move or a resize restores the connector exactly, and redo brings it back", () => {
  const { store } = setup();
  const start = store.doc;
  store.commit("move", (d) => {
    d.nodes[index(d, "a")].x -= 25;
  });
  store.commit("resize", (d) => {
    d.nodes[index(d, "b")].height = 120;
  });
  const moved = store.doc;
  expect(conn(moved)).not.toEqual(conn(start));

  store.undo();
  store.undo();
  expect(store.doc).toEqual(start);
  const resolved = (doc: Document) => resolveConnector(doc, conn(doc), registries);
  expect(resolved(store.doc)).toEqual(resolved(start));
  store.redo();
  store.redo();
  expect(store.doc).toEqual(moved);
});

test("Review Focus 2: deleting a target frees that end at its last point in the same commit; undo re-attaches it", () => {
  const { store, events } = setup();
  const start = store.doc;
  // b's west anchor: the middle of its left edge.
  store.commit("delete", (d) => {
    d.nodes.splice(index(d, "b"), 1);
  });
  const c = conn(store.doc);
  expect(c.ends[0]).toEqual(anchor("a", "e"));
  expect(c.ends[1]).toEqual(free(300, 225));
  expect(boxOf(c)).toEqual(resolveConnector(store.doc, c, registries).bounds);
  expect(events[0].changedNodeIds.has("c")).toBe(true);

  store.undo();
  expect(store.doc).toEqual(start);
  expect(conn(store.doc).ends[1]).toEqual(anchor("b", "w"));
});

test("a target moved to another page frees that end where it was; a centre-snapped end is freed at the outline", () => {
  const { store } = setup(connector({ kind: "attached", node: "a", snap: "center" }, anchor("b", "w")));
  const clipped = resolveConnector(store.doc, conn(store.doc), registries).ends[0].pt;
  store.commit("move to page", (d) => {
    d.nodes[index(d, "a")].page = other.id;
  });
  expect(conn(store.doc).ends[0]).toEqual(free(clipped.x, clipped.y));
  expect(conn(store.doc).ends[1]).toEqual(anchor("b", "w"));
});

test("an end attached to a connector, or to an item that was never there, is freed; the connector's box follows", () => {
  const d0: Document = { ...createDocument("a4-portrait"), pages: [page], nodes: [] };
  const store = new DocumentStore(d0);
  store.addNormaliser(connectorNormaliser(registries));
  store.replace({
    ...d0,
    nodes: [
      connector(free(0, 0), free(100, 0), { id: "c0", route: "straight" }),
      connector({ kind: "attached", node: "c0", snap: "center" }, free(50, 50), { id: "c1", route: "straight" }),
    ],
  });
  const c1 = store.doc.nodes[1] as ConnectorNode;
  expect(c1.ends[0].kind).toBe("free");
  expect(boxOf(c1)).toEqual(resolveConnector(store.doc, c1, registries).bounds);
  expect(store.canUndo()).toBe(false);
});

test("a connector's rotation is kept at 0", () => {
  const { store } = setup();
  store.commit("rotate", (d) => {
    d.nodes[index(d, "c")].rotation = 30;
  });
  expect(conn(store.doc).rotation).toBe(0);
});

test("an end switched to anchor snap takes the anchor nearest where it was; one switched to centre drops its anchor", () => {
  const { store } = setup(connector({ kind: "attached", node: "a", snap: "center" }, free(400, 60), { route: "straight" }));
  store.commit("snap", (d) => {
    (d.nodes[index(d, "c")] as ConnectorNode).ends[0] = { kind: "attached", node: "a", snap: "anchor" } as End;
  });
  // The line from a's centre toward (400, 60) leaves through a's right edge.
  expect(conn(store.doc).ends[0]).toEqual(anchor("a", "e"));
  store.commit("snap", (d) => {
    (d.nodes[index(d, "c")] as ConnectorNode).ends[1] = { kind: "attached", node: "b", snap: "center", anchor: "w" } as End;
  });
  expect(conn(store.doc).ends[1]).toEqual({ kind: "attached", node: "b", snap: "center" });
});

test("a commit that touches nothing a connector depends on leaves it alone", () => {
  const { store, events } = setup();
  const before = conn(store.doc);
  store.commit("name", (d) => {
    d.nodes[index(d, "a")].name = "A";
  });
  expect(conn(store.doc)).toBe(before);
  expect([...events[0].changedNodeIds]).toEqual(["a"]);
});
