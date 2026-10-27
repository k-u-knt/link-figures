import { InvalidationIndex } from "../../src/links/invalidation";

test("tracks and finds nodes by dependency path", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md", "b.png"]); i.track("p-2", ["b.png"]); expect(i.nodesFor("b.png").sort()).toEqual(["p-1", "p-2"]); expect(i.nodesFor("a.md")).toEqual(["p-1"]); });
test("untrack removes stale deps", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md"]); i.track("p-1", ["c.md"]); expect(i.nodesFor("a.md")).toEqual([]); i.untrack("p-1"); expect(i.nodesFor("c.md")).toEqual([]); });
test("rename moves deps", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md"]); i.rename("a.md", "z.md"); expect(i.nodesFor("z.md")).toEqual(["p-1"]); });
test("rename keeps the node's other deps and drops the old path", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md", "b.png"]); i.rename("a.md", "z.md"); expect(i.nodesFor("a.md")).toEqual([]); expect(i.nodesFor("b.png")).toEqual(["p-1"]); i.track("p-1", ["b.png"]); expect(i.nodesFor("z.md")).toEqual([]); });
test("rename merges into a path that already has nodes", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md"]); i.track("p-2", ["z.md"]); i.rename("a.md", "z.md"); expect(i.nodesFor("z.md").sort()).toEqual(["p-1", "p-2"]); });
test("unknown paths and nodes are harmless", () => { const i = new InvalidationIndex(); expect(i.nodesFor("nope.md")).toEqual([]); i.untrack("p-9"); i.rename("nope.md", "x.md"); expect(i.nodesFor("x.md")).toEqual([]); });
test("duplicate deps are tracked once", () => { const i = new InvalidationIndex(); i.track("p-1", ["a.md", "a.md"]); expect(i.nodesFor("a.md")).toEqual(["p-1"]); });
