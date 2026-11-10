import { connectorNodeDefaults, createDocument } from "../../src/model/defaults";
import { mmToPx, nodeWorldRect, rectIntersects } from "../../src/model/geometry";
import { paperRectsWorld } from "../../src/model/card-space";
import { createFigureStore } from "../../src/model/normalise";
import type { ConnectorNode, Node } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

const MM = mmToPx(1);

function setup() {
  const r = createRegistries();
  r.nodeTypes.register(cardNodeType as unknown as NodeType);
  r.nodeTypes.register(connectorNodeType as unknown as NodeType);
  for (const route of builtinRoutes) r.routes.register(route);
  for (const cap of builtinCapKinds) r.caps.register(cap);
  const doc = createDocument("a4-portrait");
  const page = doc.pages[0];
  doc.nodes.push(
    { ...cardNodeDefaults(page, 230 * MM, 10 * MM), id: "c", z: 0 } as Node,
    connectorNodeDefaults(page, { id: "assoc", z: 1, ends: [{ kind: "attached", node: "c", snap: "center" }, { kind: "page", page: page.id, anchor: "e" }] }, []),
  );
  return { r, doc };
}

test("a card its plugin could not read keeps its association, as its type's flag says it may", () => {
  const { r, doc } = setup();
  const store = createFigureStore(doc, r, undefined, ["c"]);
  const assoc = store.doc.nodes.find((n) => n.id === "assoc") as ConnectorNode;
  expect(assoc.ends[1]).toMatchObject({ kind: "page" });
});

test("a card its plugin could not read is still kept off the paper, by its box", () => {
  const { r, doc } = setup();
  const store = createFigureStore(doc, r, undefined, ["c"]);
  store.commit("move", (d) => {
    const c = d.nodes.find((n) => n.id === "c")!;
    c.x = 100 * MM;
  });
  const card = store.doc.nodes.find((n) => n.id === "c")!;
  const world = nodeWorldRect(store.doc, card);
  for (const p of paperRectsWorld(store.doc)) expect(rectIntersects(world, p)).toBe(false);
  // And its association stays one through the commit.
  const assoc = store.doc.nodes.find((n) => n.id === "assoc") as ConnectorNode;
  expect(assoc.ends[1]).toMatchObject({ kind: "page" });
});
