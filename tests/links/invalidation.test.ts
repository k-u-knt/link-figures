import { InvalidationIndex, missingNodeIds } from "../../src/links/invalidation";
import type { Resolved } from "../../src/links/types";
import { createDocument, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";

test("tracks and finds nodes by dependency path", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md", "b.png"]); i.track("p-2", ["b.png"]); expect(i.nodesFor("b.png").sort()).toEqual(["p-1", "p-2"]); expect(i.nodesFor("a.md")).toEqual(["p-1"]); });
test("untrack removes stale deps", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md"]); i.track("p-1", ["c.md"]); expect(i.nodesFor("a.md")).toEqual([]); i.untrack("p-1"); expect(i.nodesFor("c.md")).toEqual([]); });
test("rename moves deps", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md"]); i.rename("a.md", "z.md"); expect(i.nodesFor("z.md")).toEqual(["p-1"]); });
test("rename keeps the node's other deps and drops the old path", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md", "b.png"]); i.rename("a.md", "z.md"); expect(i.nodesFor("a.md")).toEqual([]); expect(i.nodesFor("b.png")).toEqual(["p-1"]); i.track("p-1", ["b.png"]); expect(i.nodesFor("z.md")).toEqual([]); });
test("rename merges into a path that already has nodes", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md"]); i.track("p-2", ["z.md"]); i.rename("a.md", "z.md"); expect(i.nodesFor("z.md").sort()).toEqual(["p-1", "p-2"]); });
test("unknown paths and nodes are harmless", () => { const i = new InvalidationIndex(); expect(i.nodesFor("nope.md")).toEqual([]); i.untrack("p-9"); i.rename("nope.md", "x.md"); expect(i.nodesFor("x.md")).toEqual([]); });
test("duplicate deps are tracked once", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md", "a.md"]); expect(i.nodesFor("a.md")).toEqual(["p-1"]); });

describe("missingNodeIds", () => {
  const doc = createDocument("a4-portrait");
  const [page] = doc.pages;
  const file = (name: string) => fileNodeDefaults(page, { file: name, subpath: "", show: "image" }, doc.nodes.map((n) => n.id));
  const nodes = ["a", "b", "c", "d", "e", "f"].map((name) => {
    const node = file(name);
    doc.nodes.push(node);
    return node;
  });
  const label = textNodeDefaults(page, {}, doc.nodes.map((n) => n.id));
  doc.nodes.push(label);
  const [a, b, c, d, e] = nodes;
  const image: Resolved = { kind: "image", file: { path: "a.png", extension: "png" }, src: "", source: "raster", pageCount: 1, deps: ["a.png"] };
  const missing = (reason: "file" | "subpath" | "no-image" | "decode"): Resolved => ({ kind: "missing", reason, deps: [] });

  test("lists the nodes whose file, or whose image within a note, was not found, in document order", () => {
    const cache = new Map<string, Resolved>([
      [a.id, missing("file")],
      [b.id, image],
      [c.id, missing("no-image")],
      [label.id, missing("file")],
    ]);
    expect(missingNodeIds(doc.nodes, cache)).toEqual([a.id, c.id]);
  });

  test("leaves out what a new file cannot mend, and what is not resolved yet", () => {
    const cache = new Map<string, Resolved>([[d.id, missing("subpath")], [e.id, missing("decode")]]);
    expect(missingNodeIds(doc.nodes, cache)).toEqual([]);
  });

  test("ignores text nodes, and nodes that are gone from the document", () => {
    const cache = new Map<string, Resolved>([[label.id, missing("file")], ["p-gone", missing("file")]]);
    expect(missingNodeIds(doc.nodes, cache)).toEqual([]);
  });
});
