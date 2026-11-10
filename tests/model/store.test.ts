import { DocumentStore, type ChangeEvent } from "../../src/model/store";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import { COALESCE_MS } from "../../src/constants";
import type { Document } from "../../src/model/types";

const doc = () => { const d = createDocument("a4-portrait"); d.nodes.push(fileNodeDefaults(d.pages[0], { file: "a.png", subpath: "", show: "image" }, [])); return d; };
test("commit changes doc and is undoable", () => { const s = new DocumentStore(doc()); const id = s.doc.nodes[0].id; s.commit("move", d => { d.nodes[0].x = 10; }); expect(s.doc.nodes[0].x).toBe(10); expect(s.undo()).toBe(true); expect(s.doc.nodes[0].x).toBe(0); expect(s.redo()).toBe(true); expect(s.doc.nodes[0].x).toBe(10); });
test("same label within COALESCE_MS merges into one undo step", () => { let t = 0; const s = new DocumentStore(doc(), () => t); s.commit("move", d => { d.nodes[0].x = 1; }); t = 100; s.commit("move", d => { d.nodes[0].x = 2; }); s.undo(); expect(s.doc.nodes[0].x).toBe(0); expect(s.canRedo()).toBe(true); });
test("different labels do not merge", () => { let t = 0; const s = new DocumentStore(doc(), () => t); s.commit("move", d => { d.nodes[0].x = 1; }); s.commit("resize", d => { d.nodes[0].width = 5; }); s.undo(); expect(s.doc.nodes[0].x).toBe(1); });
test("subscribe reports changed node ids and pagesChanged", () => { const s = new DocumentStore(doc()); const id = s.doc.nodes[0].id; const evs: ChangeEvent[] = []; s.subscribe(e => evs.push(e)); s.commit("move", d => { d.nodes[0].y = 3; }); s.commit("page", d => { d.pages[0].paper = "#000000"; }); expect([...evs[0].changedNodeIds]).toEqual([id]); expect(evs[0].pagesChanged).toBe(false); expect(evs[1].pagesChanged).toBe(true); });
test("removing a node reports its id", () => { const s = new DocumentStore(doc()); const id = s.doc.nodes[0].id; const evs: ChangeEvent[] = []; s.subscribe(e => evs.push(e)); s.commit("delete", d => { d.nodes.splice(0, 1); }); expect(evs[0].changedNodeIds.has(id)).toBe(true); });
test("replace clears history", () => { const s = new DocumentStore(doc()); s.commit("move", d => { d.nodes[0].x = 1; }); s.replace(createDocument("a4-portrait")); expect(s.canUndo()).toBe(false); expect(s.canRedo()).toBe(false); });

/** A document with `n` file nodes. */
function docWith(n: number): Document {
  const d = createDocument("a4-portrait");
  for (let i = 0; i < n; i++) d.nodes.push(fileNodeDefaults(d.pages[0], { file: `${i}.png`, subpath: "", show: "image" }, d.nodes.map(x => x.id)));
  return d;
}
function record(s: DocumentStore): ChangeEvent[] {
  const evs: ChangeEvent[] = [];
  s.subscribe(e => evs.push(e));
  return evs;
}
const ids = (e: ChangeEvent) => [...e.changedNodeIds].sort();

describe("history", () => {
  test("undo and redo are no-ops returning false when there is nothing to do", () => {
    const s = new DocumentStore(doc());
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
  });

  test("a new commit clears the redo stack", () => {
    const s = new DocumentStore(doc());
    s.commit("move", d => { d.nodes[0].x = 1; });
    s.undo();
    expect(s.canRedo()).toBe(true);
    s.commit("resize", d => { d.nodes[0].width = 5; });
    expect(s.canRedo()).toBe(false);
  });

  test("commits at or beyond COALESCE_MS apart do not merge; just inside do", () => {
    let t = 0;
    const s = new DocumentStore(doc(), () => t);
    s.commit("move", d => { d.nodes[0].x = 1; });
    t = COALESCE_MS - 1;
    s.commit("move", d => { d.nodes[0].x = 2; });
    t = 2 * COALESCE_MS - 1; // exactly COALESCE_MS after the merged entry's refreshed time
    s.commit("move", d => { d.nodes[0].x = 3; });
    s.undo();
    expect(s.doc.nodes[0].x).toBe(2);
    s.undo();
    expect(s.doc.nodes[0].x).toBe(0);
    expect(s.canUndo()).toBe(false);
  });

  test("merging refreshes the entry time, so a continuous drag stays one step", () => {
    let t = 0;
    const s = new DocumentStore(doc(), () => t);
    for (let i = 1; i <= 10; i++) { t = i * 200; s.commit("move", d => { d.nodes[0].x = i; }); }
    s.undo();
    expect(s.doc.nodes[0].x).toBe(0);
    expect(s.canUndo()).toBe(false);
    s.redo();
    expect(s.doc.nodes[0].x).toBe(10);
  });

  test("a merged step undoes every patch of the step, including structural ones", () => {
    let t = 0;
    const s = new DocumentStore(docWith(2), () => t);
    const before = structuredClone(s.doc);
    s.commit("edit", d => { d.nodes[1].x = 9; });
    t = 10;
    s.commit("edit", d => { d.nodes.splice(0, 1); });
    t = 20;
    s.commit("edit", d => { d.nodes[0].y = 4; });
    s.undo();
    expect(s.doc).toEqual(before);
    s.redo();
    expect(s.doc.nodes).toHaveLength(1);
    expect(s.doc.nodes[0]).toMatchObject({ x: 9, y: 4 });
  });

  test("a commit right after an undo is its own step, not merged into the entry just undone", () => {
    let t = 0;
    const s = new DocumentStore(doc(), () => t);
    s.commit("move", d => { d.nodes[0].x = 1; });
    s.undo();
    t = 10;
    s.commit("move", d => { d.nodes[0].y = 7; });
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(s.doc.nodes[0]).toMatchObject({ x: 0, y: 0 });
  });

  test("a commit right after a redo starts a new step instead of extending the redone one", () => {
    let t = 0;
    const s = new DocumentStore(doc(), () => t);
    s.commit("move", d => { d.nodes[0].x = 1; });
    s.undo();
    s.redo();
    t = 10;
    s.commit("move", d => { d.nodes[0].y = 7; });
    s.undo();
    expect(s.doc.nodes[0]).toMatchObject({ x: 1, y: 0 });
  });

  test("a commit that changes nothing leaves no history entry and emits nothing", () => {
    const s = new DocumentStore(doc());
    const evs = record(s);
    const before = s.doc;
    s.commit("noop", d => { d.nodes[0].x = d.nodes[0].x; });
    s.commit("noop", () => {});
    expect(s.doc).toBe(before);
    expect(s.canUndo()).toBe(false);
    expect(evs).toHaveLength(0);
  });

  test("a recipe that returns a value (e.g. an expression-bodied push) is allowed", () => {
    const s = new DocumentStore(docWith(1));
    const extra = docWith(1).nodes[0];
    expect(() => s.commit("add", d => d.nodes.push(extra))).not.toThrow();
    expect(s.doc.nodes).toHaveLength(2);
  });
});

describe("events", () => {
  test("discardRedo that drops steps emits a history event naming no node, so what shows the history follows; with nothing to drop it emits none", () => {
    const s = new DocumentStore(doc());
    s.commit("move", d => { d.nodes[0].x = 10; });
    s.undo();
    const evs = record(s);
    s.discardRedo();
    expect(s.canRedo()).toBe(false);
    expect(evs.map(e => [e.kind, e.label, ids(e), e.pagesChanged])).toEqual([["history", "discardRedo", [], false]]);
    s.discardRedo();
    expect(evs).toHaveLength(1);
  });

  test("commit, undo and redo each emit one event with kind and label", () => {
    const s = new DocumentStore(doc());
    const id = s.doc.nodes[0].id;
    const evs = record(s);
    s.commit("move", d => { d.nodes[0].x = 10; });
    s.undo();
    s.redo();
    expect(evs.map(e => [e.kind, e.label])).toEqual([["commit", "move"], ["undo", "move"], ["redo", "move"]]);
    for (const e of evs) { expect(ids(e)).toEqual([id]); expect(e.pagesChanged).toBe(false); }
  });

  test("a coalesced commit still emits an event naming the changed node", () => {
    let t = 0;
    const s = new DocumentStore(docWith(2), () => t);
    const [a, b] = s.doc.nodes.map(n => n.id);
    const evs = record(s);
    s.commit("move", d => { d.nodes[0].x = 1; });
    t = 50;
    s.commit("move", d => { d.nodes[1].x = 2; });
    expect(evs).toHaveLength(2);
    expect(ids(evs[0])).toEqual([a]);
    expect(ids(evs[1])).toEqual([b]);
  });

  test("undoing a page edit reports pagesChanged and no nodes", () => {
    const s = new DocumentStore(doc());
    const evs = record(s);
    s.commit("page", d => { d.pages[0].paper = "#000000"; });
    s.undo();
    expect(evs.map(e => e.pagesChanged)).toEqual([true, true]);
    expect(evs.map(e => e.changedNodeIds.size)).toEqual([0, 0]);
  });

  test("deleting the first of two nodes reports only the deleted node, not the sibling that shifted", () => {
    const s = new DocumentStore(docWith(2));
    const [a] = s.doc.nodes.map(n => n.id);
    const evs = record(s);
    s.commit("delete", d => { d.nodes.splice(0, 1); });
    s.undo();
    s.redo();
    expect(evs.map(ids)).toEqual([[a], [a], [a]]);
  });

  test("inserting a node reports only the new node", () => {
    const s = new DocumentStore(docWith(2));
    const extra = docWith(1).nodes[0];
    const evs = record(s);
    s.commit("add", d => { d.nodes.unshift(extra); });
    expect(ids(evs[0])).toEqual([extra.id]);
  });

  test("replacing the whole nodes array reports exactly the added, removed and edited nodes", () => {
    const s = new DocumentStore(docWith(3));
    const [a, b, c] = s.doc.nodes.map(n => n.id);
    const extra = docWith(1).nodes[0];
    const evs = record(s);
    s.commit("swap", d => { d.nodes = [{ ...d.nodes[1], x: 42 }, d.nodes[2], extra]; });
    expect(ids(evs[0])).toEqual([a, b, extra.id].sort());
    expect(evs[0].changedNodeIds.has(c)).toBe(false);
  });

  test("undoing a merged step that removed and edited nodes reports all of them", () => {
    let t = 0;
    const s = new DocumentStore(docWith(3), () => t);
    const [a, b, c] = s.doc.nodes.map(n => n.id);
    s.commit("edit", d => { d.nodes[2].x = 5; });
    t = 10;
    s.commit("edit", d => { d.nodes.splice(0, 2); });
    const evs = record(s);
    s.undo();
    s.redo();
    expect(ids(evs[0])).toEqual([a, b, c].sort());
    expect(ids(evs[1])).toEqual([a, b, c].sort());
  });

  test("an edit to one node does not report its untouched neighbours", () => {
    const s = new DocumentStore(docWith(3));
    const [, b] = s.doc.nodes.map(n => n.id);
    const evs = record(s);
    s.commit("move", d => { d.nodes[1].x = 1; });
    expect(ids(evs[0])).toEqual([b]);
  });

  test("unsubscribe stops delivery, and unsubscribing from inside a listener is safe", () => {
    const s = new DocumentStore(doc());
    const calls: string[] = [];
    const off = s.subscribe(() => calls.push("a"));
    const off2 = s.subscribe(() => { calls.push("b"); off2(); });
    s.subscribe(() => calls.push("c"));
    s.commit("move", d => { d.nodes[0].x = 1; });
    off();
    s.commit("resize", d => { d.nodes[0].width = 1; });
    expect(calls).toEqual(["a", "b", "c", "c"]);
  });
});

describe("replace", () => {
  test("emits a replace event naming nodes present in only one document", () => {
    const old = docWith(2);
    const next = structuredClone(old);
    const [a, b] = old.nodes.map(n => n.id);
    next.nodes.splice(0, 1);
    const added = docWith(1).nodes[0];
    next.nodes.push(added);
    const s = new DocumentStore(old);
    const evs = record(s);
    s.replace(next);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("replace");
    expect(evs[0].label).toBe("replace");
    expect(ids(evs[0])).toEqual([a, added.id].sort());
    expect(evs[0].changedNodeIds.has(b)).toBe(false);
    expect(s.doc.nodes.map(n => n.id)).toEqual([b, added.id]);
  });

  test("pagesChanged compares page content, not identity", () => {
    const old = docWith(1);
    const s = new DocumentStore(old);
    const evs = record(s);
    s.replace(structuredClone(old), "reload");
    const other = structuredClone(old);
    other.pages[0].paper = "#123456";
    s.replace(other);
    expect(evs.map(e => e.pagesChanged)).toEqual([false, true]);
    expect(evs[0].label).toBe("reload");
  });

  test("also names nodes that are in both documents but differ", () => {
    const old = docWith(3);
    const [a, b, c] = old.nodes.map(n => n.id);
    const next = structuredClone(old);
    (next.nodes[1] as { file: string }).file = "renamed.png";
    next.nodes[2].x = 40;
    const s = new DocumentStore(old);
    const evs = record(s);
    s.replace(next);
    expect(ids(evs[0])).toEqual([b, c].sort());
    expect(evs[0].changedNodeIds.has(a)).toBe(false);
  });

  test("clears undo and redo, and later commits start fresh history", () => {
    const s = new DocumentStore(doc());
    s.commit("move", d => { d.nodes[0].x = 1; });
    s.undo();
    s.replace(docWith(1));
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    s.commit("move", d => { d.nodes[0].x = 2; });
    expect(s.undo()).toBe(true);
    expect(s.doc.nodes[0].x).toBe(0);
    expect(s.canUndo()).toBe(false);
  });
});

describe("replace keeping history", () => {
  /** The document with the link of its first node renamed, which is all an external Links rewrite changes. */
  const relinked = (d: Document, file = "renamed.png"): Document => {
    const next = structuredClone(d);
    (next.nodes[0] as { file: string }).file = file;
    return next;
  };

  test("undo and redo go on working across the replacement, and leave the new link alone", () => {
    const s = new DocumentStore(docWith(2));
    s.commit("move", d => { d.nodes[1].x = 10; });
    s.commit("resize", d => { d.nodes[1].width = 99; });
    s.undo();
    s.replace(relinked(s.doc), "links", { keepHistory: true });
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.doc.nodes[1].x).toBe(0);
    expect(s.redo()).toBe(true);
    expect(s.redo()).toBe(true);
    expect(s.doc.nodes[1]).toMatchObject({ x: 10, width: 99 });
    expect((s.doc.nodes[0] as { file: string }).file).toBe("renamed.png");
  });

  test("emits one replace event naming only the nodes that differ, with the label given", () => {
    const old = docWith(3);
    const s = new DocumentStore(old);
    const evs = record(s);
    s.replace(relinked(old), "links", { keepHistory: true });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "replace", label: "links", pagesChanged: false });
    expect(ids(evs[0])).toEqual([old.nodes[0].id]);
  });

  test("a run of commits that was under way keeps merging into its undo step", () => {
    let t = 0;
    const s = new DocumentStore(docWith(2), () => t);
    s.commit("move", d => { d.nodes[1].x = 1; });
    s.replace(relinked(s.doc), "links", { keepHistory: true });
    t = 100;
    s.commit("move", d => { d.nodes[1].x = 2; });
    expect(s.undo()).toBe(true);
    expect(s.doc.nodes[1].x).toBe(0);
    expect(s.canUndo()).toBe(false);
  });

  test("without the option the history is still cleared", () => {
    const s = new DocumentStore(docWith(2));
    s.commit("move", d => { d.nodes[1].x = 1; });
    s.replace(relinked(s.doc), "links");
    expect(s.canUndo()).toBe(false);
  });
});

describe("replace keeping history: what history holds of a node follows the node's new link", () => {
  type Linked = { file: string; subpath: string };
  const linkOf = (d: Document, id: string): string => {
    const n = d.nodes.find(x => x.id === id) as unknown as Linked | undefined;
    return n ? `${n.file}${n.subpath}` : "(absent)";
  };
  /** `d` with the links of some nodes changed: all an external Links rewrite does. */
  const relinkedTo = (d: Document, links: Record<string, Linked>): Document => {
    const next = structuredClone(d);
    for (const n of next.nodes) if (links[n.id]) Object.assign(n, links[n.id]);
    return next;
  };

  test("a delete written as a filter: undo and redo give the survivor its new link", () => {
    const s = new DocumentStore(docWith(2));
    const [a, b] = s.doc.nodes.map(n => n.id);
    s.commit("delete", d => { d.nodes = d.nodes.filter(n => n.id !== b); });
    s.replace(relinkedTo(s.doc, { [a]: { file: "renamed.png", subpath: "" } }), "links", { keepHistory: true });

    expect(s.undo()).toBe(true);
    expect(s.doc.nodes.map(n => n.id)).toEqual([a, b]);
    expect(linkOf(s.doc, a)).toBe("renamed.png");
    // The node that was deleted is not in the file, so nobody renamed it.
    expect(linkOf(s.doc, b)).toBe("1.png");

    expect(s.redo()).toBe(true);
    expect(s.doc.nodes.map(n => n.id)).toEqual([a]);
    expect(linkOf(s.doc, a)).toBe("renamed.png");
  });

  test("a delete written as a splice, which shifts the nodes after it", () => {
    const s = new DocumentStore(docWith(3));
    const [a, b, c] = s.doc.nodes.map(n => n.id);
    s.commit("delete", d => { d.nodes.splice(0, 1); });
    s.replace(relinkedTo(s.doc, { [c]: { file: "renamed.png", subpath: "#Legend" } }), "links", { keepHistory: true });

    s.undo();
    expect(s.doc.nodes.map(n => n.id)).toEqual([a, b, c]);
    expect(linkOf(s.doc, c)).toBe("renamed.png#Legend");
    expect(linkOf(s.doc, b)).toBe("1.png");
    s.redo();
    expect(s.doc.nodes.map(n => n.id)).toEqual([b, c]);
    expect(linkOf(s.doc, c)).toBe("renamed.png#Legend");
    expect(linkOf(s.doc, b)).toBe("1.png");
  });

  test("an insertion: undo and redo bring back the inserted node with the link it has now", () => {
    const s = new DocumentStore(docWith(2));
    const [a, b] = s.doc.nodes.map(n => n.id);
    const copy = { ...structuredClone(s.doc.nodes[0]), id: "p-copy" };
    s.commit("duplicate", d => { d.nodes.push(copy); });
    s.replace(relinkedTo(s.doc, { [a]: { file: "renamed.png", subpath: "" }, "p-copy": { file: "renamed.png", subpath: "" } }), "links", { keepHistory: true });

    s.undo();
    expect(s.doc.nodes.map(n => n.id)).toEqual([a, b]);
    s.redo();
    expect(s.doc.nodes.map(n => n.id)).toEqual([a, b, "p-copy"]);
    expect(linkOf(s.doc, "p-copy")).toBe("renamed.png");
    expect(linkOf(s.doc, a)).toBe("renamed.png");
  });

  test("the redo stack is rebased too", () => {
    const s = new DocumentStore(docWith(2));
    const [a, b] = s.doc.nodes.map(n => n.id);
    s.commit("delete", d => { d.nodes = d.nodes.filter(n => n.id !== b); });
    s.undo();
    s.replace(relinkedTo(s.doc, { [a]: { file: "renamed.png", subpath: "" } }), "links", { keepHistory: true });

    s.redo();
    expect(s.doc.nodes.map(n => n.id)).toEqual([a]);
    expect(linkOf(s.doc, a)).toBe("renamed.png");
    s.undo();
    expect(s.doc.nodes.map(n => n.id)).toEqual([a, b]);
    expect(linkOf(s.doc, a)).toBe("renamed.png");
  });

  test("a delete page (nodes and pages replaced in one commit) is rebased as well", () => {
    const d0 = docWith(2);
    const s = new DocumentStore(d0);
    const [a] = s.doc.nodes.map(n => n.id);
    s.commit("delete-page", d => { d.nodes = d.nodes.filter(n => n.id !== d.nodes[1].id); d.pages = d.pages.slice(); });
    s.replace(relinkedTo(s.doc, { [a]: { file: "renamed.png", subpath: "" } }), "links", { keepHistory: true });
    s.undo();
    expect(linkOf(s.doc, a)).toBe("renamed.png");
  });

  test("two renames in a row: the second is rebased on the first", () => {
    const s = new DocumentStore(docWith(2));
    const [a, b] = s.doc.nodes.map(n => n.id);
    s.commit("delete", d => { d.nodes = d.nodes.filter(n => n.id !== b); });
    s.replace(relinkedTo(s.doc, { [a]: { file: "one.png", subpath: "" } }), "links", { keepHistory: true });
    s.replace(relinkedTo(s.doc, { [a]: { file: "two.png", subpath: "" } }), "links", { keepHistory: true });
    s.undo();
    expect(linkOf(s.doc, a)).toBe("two.png");
  });

  test("edits of other fields are untouched, and undoing them leaves the link as it is", () => {
    const s = new DocumentStore(docWith(2));
    const [a, b] = s.doc.nodes.map(n => n.id);
    s.commit("move", d => { d.nodes[0].x = 10; });
    s.commit("delete", d => { d.nodes = d.nodes.filter(n => n.id !== b); });
    s.replace(relinkedTo(s.doc, { [a]: { file: "renamed.png", subpath: "" } }), "links", { keepHistory: true });
    s.undo();
    s.undo();
    expect(s.doc.nodes[0].x).toBe(0);
    expect(linkOf(s.doc, a)).toBe("renamed.png");
    expect(s.doc.nodes.map(n => n.id)).toEqual([a, b]);
  });

  test("a replacement that changes no link leaves history as it was", () => {
    const s = new DocumentStore(docWith(2));
    const [, b] = s.doc.nodes.map(n => n.id);
    s.commit("delete", d => { d.nodes = d.nodes.filter(n => n.id !== b); });
    s.replace(structuredClone(s.doc), "links", { keepHistory: true });
    s.undo();
    expect(s.doc.nodes.map(n => linkOf(s.doc, n.id))).toEqual(["0.png", "1.png"]);
  });

  test("the document handed in is not touched by the rebase, nor the one before it", () => {
    const s = new DocumentStore(docWith(2));
    const [a, b] = s.doc.nodes.map(n => n.id);
    s.commit("delete", d => { d.nodes = d.nodes.filter(n => n.id !== b); });
    const next = relinkedTo(s.doc, { [a]: { file: "renamed.png", subpath: "" } });
    const snapshot = structuredClone(next);
    s.replace(next, "links", { keepHistory: true });
    s.undo();
    expect(next).toEqual(snapshot);
  });
});

describe("rebasePaths: a source renamed while a node that links to it is only in history", () => {
  type Linked = { file: string; subpath: string };
  const linkOf = (d: Document, id: string): string => {
    const n = d.nodes.find(x => x.id === id) as unknown as Linked | undefined;
    return n ? `${n.file}${n.subpath}` : "(absent)";
  };
  const deleted = (file: string, subpath = "") => {
    const d = docWith(2);
    Object.assign(d.nodes[1], { file, subpath });
    const s = new DocumentStore(d);
    const [a, b] = s.doc.nodes.map(n => n.id);
    s.commit("delete", d => { d.nodes = d.nodes.filter(n => n.id !== b); });
    return { s, a, b };
  };

  test("undo brings a deleted panel back with the renamed file", () => {
    const { s, b } = deleted("only-here.svg");
    s.rebasePaths(new Map([["only-here.svg", "only-here-2.svg"]]));
    s.undo();
    expect(linkOf(s.doc, b)).toBe("only-here-2.svg");
  });

  test("redo after undo after the rename keeps the new name", () => {
    const { s, a, b } = deleted("only-here.svg");
    s.rebasePaths(new Map([["only-here.svg", "only-here-2.svg"]]));
    s.undo();
    s.redo();
    expect(s.doc.nodes.map(n => n.id)).toEqual([a]);
    s.undo();
    expect(linkOf(s.doc, b)).toBe("only-here-2.svg");
  });

  test("the redo stack is rebased too, and an edit of the link itself", () => {
    const s = new DocumentStore(docWith(1));
    const [a] = s.doc.nodes.map(n => n.id);
    s.commit("relink", d => { (d.nodes[0] as unknown as Linked).file = "only-here.svg"; });
    s.undo();
    s.rebasePaths(new Map([["only-here.svg", "only-here-2.svg"]]));
    s.redo();
    expect(linkOf(s.doc, a)).toBe("only-here-2.svg");
  });

  test("the subpath is kept", () => {
    const { s, b } = deleted("analysis", "#Legend");
    s.rebasePaths(new Map([["analysis", "results"]]));
    s.undo();
    expect(linkOf(s.doc, b)).toBe("results#Legend");
  });

  test("a rename of an unrelated file changes nothing, and the current document is untouched", () => {
    const { s, a, b } = deleted("only-here.svg");
    const current = s.doc;
    const events = record(s);
    s.rebasePaths(new Map([["other.svg", "other-2.svg"]]));
    expect(s.doc).toBe(current);
    expect(linkOf(s.doc, a)).toBe("0.png");
    expect(events).toEqual([]);
    s.undo();
    expect(linkOf(s.doc, b)).toBe("only-here.svg");
  });
});

describe("revertMerge", () => {
  test("takes back the merging run as though never made: the document before it, no undo or redo step, an undo event", () => {
    let t = 0;
    const s = new DocumentStore(doc(), () => t);
    s.commit("width", d => { d.nodes[0].width = 50; });
    s.endMerge();
    s.commit("move", d => { d.nodes[0].x = 1; });
    t = 10;
    s.commit("move", d => { d.nodes[0].x = 2; });
    const evs = record(s);
    expect(s.revertMerge()).toBe(true);
    expect(s.doc.nodes[0].x).toBe(0);
    expect(s.doc.nodes[0].width).toBe(50);
    expect(s.canRedo()).toBe(false);
    expect(evs.map(e => e.kind)).toEqual(["undo"]);
    // The edit before the run is still one undo step, and the only one.
    expect(s.undo()).toBe(true);
    expect(s.doc.nodes[0].width).not.toBe(50);
    expect(s.canUndo()).toBe(false);
  });

  test("changes nothing with no run open: after endMerge, after an undo, or on a fresh store", () => {
    const fresh = new DocumentStore(doc());
    expect(fresh.revertMerge()).toBe(false);
    const s = new DocumentStore(doc());
    s.commit("move", d => { d.nodes[0].x = 1; });
    s.endMerge();
    expect(s.revertMerge()).toBe(false);
    expect(s.doc.nodes[0].x).toBe(1);
    s.commit("move", d => { d.nodes[0].x = 2; });
    s.undo();
    expect(s.revertMerge()).toBe(false);
    expect(s.doc.nodes[0].x).toBe(1);
    expect(s.canRedo()).toBe(true);
  });
});
