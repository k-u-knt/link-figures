import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { connectorNodeDefaults, createDocument, createPage, groupNodeDefaults, shapeNodeDefaults } from "../../src/model/defaults";
import { childrenOf, descendantsOf, expandUnits, isGroup, isLocked, outermostUnit, parentOf, unitsOf } from "../../src/model/groups";
import { createFigureStore } from "../../src/model/normalise";
import type { ConnectorNode, Document, Node } from "../../src/model/types";
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
  return r;
}

const page = createPage("a4-portrait", []);
const other = createPage("a4-portrait", [page.id]);
const shape = (id: string, x: number, y: number, z: number, parent?: string): Node => ({
  ...shapeNodeDefaults(page, { id, x, y, width: 10, height: 10, z }, []),
  ...(parent ? { parent } : {}),
});
const group = (id: string, parent?: string): Node => ({ ...groupNodeDefaults(page, { id }, []), ...(parent ? { parent } : {}) });

/** `a`, `b` in group `g`; `g` and `c` in group `h`; `d` at top level. The groups' boxes are left for the normaliser. */
function figure(): Document {
  return {
    ...createDocument("a4-portrait"),
    pages: [page, other],
    nodes: [shape("a", 0, 0, 0, "g"), shape("b", 20, 0, 1, "g"), group("g", "h"), shape("c", 50, 50, 3, "h"), group("h"), shape("d", 200, 200, 4)],
  };
}

const nodeOf = (doc: Document, id: string) => doc.nodes.find((n) => n.id === id);

describe("helpers", () => {
  const doc = figure();
  test("parentOf and childrenOf", () => {
    expect(parentOf(doc, "a")).toBe("g");
    expect(parentOf(doc, "h")).toBeNull();
    expect(parentOf(doc, "nope")).toBeNull();
    expect(childrenOf(doc, "h")).toEqual(["g", "c"]);
  });
  test("childrenOf is in z order", () => {
    const d = figure();
    (nodeOf(d, "a") as Node).z = 5;
    expect(childrenOf(d, "g")).toEqual(["b", "a"]);
  });
  test("descendantsOf(h) is a, b, g and c", () => expect(new Set(descendantsOf(doc, "h"))).toEqual(new Set(["a", "b", "g", "c"])));
  test("outermostUnit(a) is h at top level, and g within h", () => {
    expect(outermostUnit(doc, "a", null)).toBe("h");
    expect(outermostUnit(doc, "a", "h")).toBe("g");
    expect(outermostUnit(doc, "d", null)).toBe("d");
  });
  test("outermostUnit of the entered group itself is that group, not a group it is in", () => {
    expect(outermostUnit(doc, "g", "g")).toBe("g");
    expect(outermostUnit(doc, "h", "h")).toBe("h");
  });
  test("expandUnits([h]) holds every node of h, in document order", () => expect(expandUnits(doc, ["h"])).toEqual(["a", "b", "g", "c", "h"]));
  test("expandUnits deduplicates", () => expect(expandUnits(doc, ["g", "a", "d"])).toEqual(["a", "b", "g", "d"]));
  test("isLocked follows the ancestors", () => {
    const d = figure();
    expect(isLocked(d, "a")).toBe(false);
    (nodeOf(d, "h") as Node).locked = true;
    expect(isLocked(d, "a")).toBe(true);
    expect(isLocked(d, "d")).toBe(false);
  });
  test("unitsOf([a, c]) is [h]", () => {
    expect(unitsOf(doc, ["a", "c"], null)).toEqual(["h"]);
    expect(unitsOf(doc, ["a", "c", "d"], "h")).toEqual(["g", "c", "d"]);
  });
  test("isGroup is true for a type with members", () => {
    const r = registries();
    expect(isGroup(doc, "g", r)).toBe(true);
    expect(isGroup(doc, "a", r)).toBe(false);
    expect(isGroup(doc, "nope", r)).toBe(false);
  });
});

describe("groupNormaliser", () => {
  function setup(doc = figure()) {
    const r = registries();
    const store = createFigureStore(doc, r);
    return { store, r };
  }
  const at = (store: { doc: Document }, id: string) => nodeOf(store.doc, id) as Node | undefined;

  test("a loaded figure gets its groups' boxes and z", () => {
    const { store } = setup();
    expect(at(store, "g")).toMatchObject({ x: 0, y: 0, width: 30, height: 10, z: 1 });
    expect(at(store, "h")).toMatchObject({ x: 0, y: 0, width: 60, height: 60, z: 3 });
  });
  test("a commit the groups have nothing to say about leaves them as they were", () => {
    const { store } = setup();
    const g = at(store, "g");
    const h = at(store, "h");
    store.commit("rename", (d) => void ((nodeOf(d, "d") as Node).name = "x"));
    expect(at(store, "g")).toBe(g);
    expect(at(store, "h")).toBe(h);
  });
  test("a dangling parent is removed", () => {
    const { store } = setup();
    store.commit("t", (d) => void ((nodeOf(d, "d") as Node).parent = "zzz"));
    expect(at(store, "d")).not.toHaveProperty("parent");
  });
  test("a parent that is not a group is removed", () => {
    const { store } = setup();
    store.commit("t", (d) => void ((nodeOf(d, "d") as Node).parent = "b"));
    expect(at(store, "d")).not.toHaveProperty("parent");
  });
  test("a cycle is broken", () => {
    const doc: Document = {
      ...createDocument("a4-portrait"),
      pages: [page],
      nodes: [shape("a", 0, 0, 0, "g"), shape("b", 20, 0, 1, "g"), group("g"), shape("c", 50, 50, 2, "g2"), shape("d", 80, 50, 3, "g2"), group("g2")],
    };
    const { store } = setup(doc);
    store.commit("t", (d) => {
      (nodeOf(d, "g") as Node).parent = "g2";
      (nodeOf(d, "g2") as Node).parent = "g";
    });
    const parents = [at(store, "g")?.parent, at(store, "g2")?.parent];
    expect(parents.filter((p) => p !== undefined)).toHaveLength(1);
    expect(at(store, "g")).toBeDefined();
    expect(at(store, "g2")).toBeDefined();
  });
  test("an empty group is deleted", () => {
    const { store } = setup();
    store.commit("t", (d) => void d.nodes.push(group("e")));
    expect(at(store, "e")).toBeUndefined();
  });
  test("a group with one member is dissolved, and the member takes its parent", () => {
    const { store } = setup();
    store.commit("t", (d) => void d.nodes.splice(d.nodes.findIndex((n) => n.id === "b"), 1));
    expect(at(store, "g")).toBeUndefined();
    expect(at(store, "a")?.parent).toBe("h");
    expect(childrenOf(store.doc, "h")).toEqual(["a", "c"]);
  });
  test("dissolving a group can leave the group above with one member, which is dissolved in turn", () => {
    const { store } = setup();
    store.commit("t", (d) => void (d.nodes = d.nodes.filter((n) => n.id !== "b" && n.id !== "c")));
    expect(at(store, "g")).toBeUndefined();
    expect(at(store, "h")).toBeUndefined();
    expect(at(store, "a")).not.toHaveProperty("parent");
  });
  test("the group's box is the union of its members' after a member moves", () => {
    const { store } = setup();
    store.commit("t", (d) => {
      const a = nodeOf(d, "a") as Node;
      a.x = -5;
      a.y = 100;
    });
    expect(at(store, "g")).toMatchObject({ x: -5, y: 0, width: 35, height: 110 });
    expect(at(store, "h")).toMatchObject({ x: -5, y: 0, width: 65, height: 110 });
  });
  test("the group's z is its highest member's", () => {
    const { store } = setup();
    store.commit("t", (d) => void ((nodeOf(d, "b") as Node).z = 9));
    expect(at(store, "g")?.z).toBe(9);
    expect(at(store, "h")?.z).toBe(9);
  });
  test("a group's rotation is 0 and its opacity 1", () => {
    const { store } = setup();
    store.commit("t", (d) => {
      const g = nodeOf(d, "g") as Node;
      g.rotation = 30;
      g.opacity = 0.5;
    });
    expect(at(store, "g")).toMatchObject({ rotation: 0, opacity: 1 });
  });
  test("members follow the page of the group's first member by z", () => {
    const { store } = setup();
    store.commit("t", (d) => void ((nodeOf(d, "a") as Node).page = other.id));
    for (const id of ["a", "b", "g", "c", "h"]) expect(at(store, id)?.page).toBe(other.id);
    expect(at(store, "d")?.page).toBe(page.id);
  });
  test("a member on another page than the group's first member goes back to it", () => {
    const { store } = setup();
    store.commit("t", (d) => void ((nodeOf(d, "c") as Node).page = other.id));
    expect(at(store, "c")?.page).toBe(page.id);
  });
  test("a connector member's box is resolved before the group's (connector normaliser first)", () => {
    const conn: ConnectorNode = connectorNodeDefaults(page, { id: "k", z: 5, ends: [{ kind: "attached", node: "d", snap: "center" }, { kind: "free", x: 300, y: 300 }] }, []);
    const doc: Document = {
      ...createDocument("a4-portrait"),
      pages: [page],
      nodes: [shape("a", 0, 0, 0, "g"), { ...conn, parent: "g" } as Node, group("g"), shape("d", 200, 200, 4)],
    };
    const { store } = setup(doc);
    store.commit("t", (d) => void ((nodeOf(d, "k") as ConnectorNode).ends[1] = { kind: "free", x: 800, y: 900 }));
    const g = at(store, "g") as Node;
    expect(g.x + g.width).toBeGreaterThanOrEqual(800);
    expect(g.y + g.height).toBeGreaterThanOrEqual(900);
    expect(g.z).toBe(5);
  });
});

describe("node.update", () => {
  test("refuses a parent, naming group.add and group.remove", async () => {
    const r = registries();
    const store = createFigureStore(figure(), r);
    const ctx: CommandContext = { app: {} as never, registries: r, view: null, store, selection: [], page: undefined };
    const run = () => runCall(store, ctx, prepareCall(r, { id: "node.update", args: { id: "a", patch: { parent: "x" } } }));
    await expect(run()).rejects.toThrow(CommandError);
    await expect(run()).rejects.toThrow(/group\.add.*group\.remove/);
  });
  test("still takes a patch that gives the parent the node already has", async () => {
    const r = registries();
    const store = createFigureStore(figure(), r);
    const ctx: CommandContext = { app: {} as never, registries: r, view: null, store, selection: [], page: undefined };
    await runCall(store, ctx, prepareCall(r, { id: "node.update", args: { id: "a", patch: { parent: "g", name: "A" } } }));
    expect(nodeOf(store.doc, "a")).toMatchObject({ parent: "g", name: "A" });
  });
});
