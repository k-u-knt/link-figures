import { registerBuiltinCommands } from "../../src/commands/builtin";
import { cardCommands } from "../../src/commands/cards";
import { drawingCommands } from "../../src/commands/drawing";
import { groupCommands } from "../../src/commands/groups";
import { prepareCall, runCall } from "../../src/commands/headless";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import { resolveConnector } from "../../src/connectors/geometry";
import { applyLinkEntries, classifyReload } from "../../src/format/links-reload";
import { loadDocument } from "../../src/format/load";
import { parseFigureFile } from "../../src/format/parse";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { isAssociation } from "../../src/model/attach";
import { paperRectsWorld } from "../../src/model/card-space";
import { connectorNodeDefaults, createDocument, createPage, shapeNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { mmToPx, nodeWorldRect, rectIntersects } from "../../src/model/geometry";
import { createFigureStore } from "../../src/model/normalise";
import type { ConnectorNode, Document, End, Node } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { textNodeType } from "../../src/nodes/text-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries, type Registries } from "../../src/registry";
import { CommandError, type CommandContext } from "../../src/registry/command";
import { builtinShapeKinds } from "../../src/shapes/builtin";

// The text node type imports the real Obsidian API for its DOM; these tests never mount anything.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

function registries(): Registries {
  const r = createRegistries();
  for (const t of [shapeNodeType, connectorNodeType, groupNodeType, textNodeType, cardNodeType]) r.nodeTypes.register(t);
  for (const p of builtinPaintTypes) r.paints.register(p);
  for (const k of builtinShapeKinds) r.shapes.register(k);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  for (const c of [...drawingCommands(), ...groupCommands(), ...cardCommands()]) r.commands.register(c);
  const plugin = { registries: r, addCommand: () => undefined, activeFigureView: () => null };
  registerBuiltinCommands(plugin as never);
  return r;
}

/** A figure with page `pg-1` (A4) and, with `second`, page `pg-2` 20 mm below it. */
function figure(second = false, nodes: (doc: Document) => Node[] = () => []): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  if (second) doc.pages.push({ ...createPage("a4-portrait", ["pg-1"]), id: "pg-2" });
  doc.nodes.push(...nodes(doc));
  return doc;
}

function setup(doc: Document) {
  const r = registries();
  let t = 0;
  const store = createFigureStore(doc, r, () => (t += 10_000));
  const ctx = (): CommandContext => ({ app: {} as never, registries: r, view: null, store, selection: [], page: undefined });
  const call = (id: string, args: Record<string, unknown>) => runCall(store, ctx(), prepareCall(r, { id, args }));
  const node = <N extends Node = Node>(id: string) => store.doc.nodes.find((n) => n.id === id) as N | undefined;
  return { r, store, call, node };
}

const MM = mmToPx(1);
const clearOfPapers = (doc: Document, n: Node) => paperRectsWorld(doc).every((p) => !rectIntersects(nodeWorldRect(doc, n), p));
const cardEnd = (node: string, anchor = "w"): End => ({ kind: "attached", node, snap: "anchor", anchor });

describe("card.create", () => {
  test("card.create on paper places the card outside the nearest edge", async () => {
    const { call, node, store } = setup(figure());
    const { id } = (await call("card.create", { page: "pg-1", x: 180 * MM, y: 100 * MM, text: "Legend" })) as { id: string };
    const card = node(id)!;
    expect(card).toMatchObject({ type: "card", page: "pg-1", text: "Legend" });
    expect(card.width).toBeCloseTo(60 * MM, 6);
    expect(card.height).toBeCloseTo(40 * MM, 6);
    // Right is nearest: 4 mm beyond the 210 mm edge.
    expect(card.x).toBeCloseTo(214 * MM, 1);
    expect(card.y).toBeCloseTo(100 * MM, 6);
    expect(clearOfPapers(store.doc, card)).toBe(true);
    // One undo step.
    store.undo();
    expect(node(id)).toBeUndefined();
  });

  test("card.create makes a text card by default, or a note card with a subpath", async () => {
    const { call, node } = setup(figure());
    const a = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 0 })) as { id: string };
    expect(node(a.id)).toMatchObject({ text: "" });
    expect("file" in node(a.id)!).toBe(false);
    const b = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 60 * MM, file: "Notes/Fig 1.md", subpath: "#Legend", id: "c-b" })) as { id: string };
    expect(b.id).toBe("c-b");
    expect(node(b.id)).toMatchObject({ file: "Notes/Fig 1.md", subpath: "#Legend" });
    expect("text" in node(b.id)!).toBe(false);
  });

  test("card.create refuses text and file together: `card.create: give text or file, not both`", async () => {
    const { call } = setup(figure());
    const done = call("card.create", { page: "pg-1", x: 0, y: 0, text: "a", file: "b.md" });
    await expect(done).rejects.toBeInstanceOf(CommandError);
    await expect(call("card.create", { page: "pg-1", x: 0, y: 0, text: "a", file: "b.md" })).rejects.toThrow(/^card\.create: give text or file, not both$/);
    await expect(call("card.create", { page: "pg-1", x: 0, y: 0, subpath: "#x" })).rejects.toThrow(/^card\.create:/);
  });

  test("cardNodeDefaults is a 60 × 40 mm text card with empty text", () => {
    const page = figure().pages[0];
    const card = cardNodeDefaults(page, 5, 6);
    expect(card).toMatchObject({ type: "card", page: "pg-1", x: 5, y: 6, text: "", rotation: 0, opacity: 1, locked: false });
    expect(card.width).toBeCloseTo(60 * MM, 6);
    expect(card.height).toBeCloseTo(40 * MM, 6);
  });
});

describe("keeping cards off the paper", () => {
  test("node.move of a card onto paper pushes it out", async () => {
    const { call, node, store } = setup(figure());
    const { id } = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 100 * MM })) as { id: string };
    await call("node.move", { ids: [id], dx: -30 * MM, dy: 10 * MM });
    const card = node(id)!;
    expect(card.x).toBeCloseTo(214 * MM, 1);
    expect(card.y).toBeCloseTo(110 * MM, 1);
    expect(card.page).toBe("pg-1");
    expect(clearOfPapers(store.doc, card)).toBe(true);
  });

  test("node.update of a card onto paper pushes it out", async () => {
    const { call, node, store } = setup(figure());
    const { id } = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 100 * MM })) as { id: string };
    await call("node.update", { id, patch: { x: 100 * MM } });
    expect(clearOfPapers(store.doc, node(id)!)).toBe(true);
  });

  test("a group with a card moved onto paper: other members move as asked, the card stays off paper", async () => {
    const { call, node, store } = setup(figure(false, (doc) => [shapeNodeDefaults(doc.pages[0], { id: "s", x: 50 * MM, y: 10 * MM, width: 20 * MM, height: 20 * MM, z: 0 }, [])]));
    const { id } = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 10 * MM })) as { id: string };
    const group = (await call("group.create", { ids: ["s", id] })) as { id: string };
    await call("node.move", { ids: [group.id], dx: -20 * MM, dy: 0 });
    expect(node("s")!.x).toBeCloseTo(30 * MM, 1);
    expect(node(id)!.x).toBeCloseTo(214 * MM, 1);
    expect(clearOfPapers(store.doc, node(id)!)).toBe(true);
    // The group's box is its members' as they are now.
    const g = node(group.id)!;
    expect(g.x + g.width).toBeCloseTo(node(id)!.x + node(id)!.width, 1);
  });

  test("page.update growing a page under a card pushes the card out in the same commit; one undo restores both", async () => {
    const { call, node, store } = setup(figure());
    const { id } = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 100 * MM })) as { id: string };
    const before = node(id)!.x;
    await call("page.update", { id: "pg-1", patch: { width: 250 } });
    expect(store.doc.pages[0].width).toBe(250);
    expect(node(id)!.x).toBeCloseTo(254 * MM, 1);
    expect(clearOfPapers(store.doc, node(id)!)).toBe(true);
    store.undo();
    expect(store.doc.pages[0].width).toBe(210);
    expect(node(id)!.x).toBe(before);
  });

  test("add-page under a card pushes it out", async () => {
    const { call, node, store } = setup(figure());
    // Below page 1, where a page added after it will be.
    const { id } = (await call("card.create", { page: "pg-1", x: 10 * MM, y: 330 * MM })) as { id: string };
    expect(node(id)!.y).toBeCloseTo(330 * MM, 6);
    await call("add-page", { page: "pg-1" });
    expect(store.doc.pages).toHaveLength(2);
    const card = node(id)!;
    expect(clearOfPapers(store.doc, card)).toBe(true);
    // Left is the shortest way out of the new page that does not land on page 1.
    expect(card.x).toBeCloseTo(-64 * MM, 1);
    expect(card.y).toBeCloseTo(330 * MM, 6);
    store.undo();
    expect(store.doc.pages).toHaveLength(1);
    expect(node(id)!.x).toBeCloseTo(10 * MM, 6);
  });

  test("a figure that holds a card over the paper is brought clear as it is loaded", () => {
    const doc = figure(false, (d) => [{ ...cardNodeDefaults(d.pages[0], 100 * MM, 100 * MM), id: "c" } as Node]);
    const { store, node } = setup(doc);
    expect(clearOfPapers(store.doc, node("c")!)).toBe(true);
  });
});

describe("associations", () => {
  async function withCard(second = false, nodes: (doc: Document) => Node[] = () => []) {
    const s = setup(figure(second, nodes));
    const { id } = (await s.call("card.create", { page: "pg-1", x: 220 * MM, y: 100 * MM, id: "c" })) as { id: string };
    return { ...s, card: id };
  }

  test('connector.create from a card to `{kind:"page", page, anchor:"w"}` attaches, resolving to the paper\'s west midpoint', async () => {
    const { call, node, store, r, card } = await withCard();
    const { id } = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-1", anchor: "w" } })) as { id: string };
    const c = node<ConnectorNode>(id)!;
    expect(c.ends[1]).toEqual({ kind: "page", page: "pg-1", anchor: "w" });
    const resolved = resolveConnector(store.doc, c, r);
    expect(resolved.detached).toEqual([false, false]);
    expect(resolved.ends[1].pt.x).toBeCloseTo(0, 6);
    expect(resolved.ends[1].pt.y).toBeCloseTo(148.5 * MM, 6);
    expect(isAssociation(store.doc, c, r)).toBe(true);
    // Without an anchor, the end is at the paper's centre (clipped to its edge as a centre-snapped end is).
    await call("connector.setEnd", { id, which: 1, end: { kind: "page", page: "pg-1" } });
    expect(node<ConnectorNode>(id)!.ends[1]).toEqual({ kind: "page", page: "pg-1" });
    expect(resolveConnector(store.doc, node<ConnectorNode>(id)!, r).detached).toEqual([false, false]);
  });

  test("a page end from a shape is refused: `connector.create: only a card can be tied to a page`", async () => {
    const { call } = await withCard(false, (doc) => [shapeNodeDefaults(doc.pages[0], { id: "s", x: 10, y: 10, width: 50, height: 50 }, [])]);
    const shapeEnd: End = { kind: "attached", node: "s", snap: "center" };
    await expect(call("connector.create", { page: "pg-1", from: shapeEnd, to: { kind: "page", page: "pg-1" } })).rejects.toThrow(
      /^connector\.create: only a card can be tied to a page$/,
    );
    // Page to page, and a free end to a page, are refused too.
    await expect(call("connector.create", { page: "pg-1", from: { kind: "page", page: "pg-1" }, to: { kind: "page", page: "pg-1" } })).rejects.toThrow(
      /^connector\.create: only a card can be tied to a page$/,
    );
    await expect(call("connector.create", { page: "pg-1", from: { kind: "free", x: 0, y: 0 }, to: { kind: "page", page: "pg-1" } })).rejects.toThrow(
      /^connector\.create: only a card can be tied to a page$/,
    );
    // A page that is not one of the figure's.
    await expect(call("connector.create", { page: "pg-1", from: cardEnd("c"), to: { kind: "page", page: "pg-9" } })).rejects.toThrow(/^connector\.create: /);
  });

  test("delete-page removes associations ending on it in the same undo step; the card stays", async () => {
    const { call, node, store, card } = await withCard(true);
    const { id } = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-2", anchor: "n" } })) as { id: string };
    const kept = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-1", anchor: "e" } })) as { id: string };
    await call("delete-page", { page: "pg-2" });
    expect(store.doc.pages.map((p) => p.id)).toEqual(["pg-1"]);
    expect(node(id)).toBeUndefined();
    expect(node(kept.id)).toBeDefined();
    expect(node(card)).toBeDefined();
    store.undo();
    expect(store.doc.pages.map((p) => p.id)).toEqual(["pg-1", "pg-2"]);
    expect(node<ConnectorNode>(id)!.ends[1]).toEqual({ kind: "page", page: "pg-2", anchor: "n" });
  });

  test("deleting a card deletes its associations in the same undo step; a connector between two cards is freed as before", async () => {
    const { call, node, store, card } = await withCard(true);
    const a = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-1", anchor: "e" } })) as { id: string };
    const b = (await call("connector.create", { page: "pg-1", from: { kind: "page", page: "pg-2", anchor: "n" }, to: cardEnd(card) })) as { id: string };
    const other = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 200 * MM, id: "c2" })) as { id: string };
    const between = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: cardEnd(other.id) })) as { id: string };
    await call("delete", { ids: [card] });
    expect(node(card)).toBeUndefined();
    expect(node(a.id)).toBeUndefined();
    expect(node(b.id)).toBeUndefined();
    // Not an association: it is freed at the deleted card's end, as for any item.
    expect(node<ConnectorNode>(between.id)!.ends[0].kind).toBe("free");
    // One undo brings back the card and both associations.
    store.undo();
    expect(node(card)).toBeDefined();
    expect(node<ConnectorNode>(a.id)!.ends).toEqual([cardEnd(card), { kind: "page", page: "pg-1", anchor: "e" }]);
    expect(node<ConnectorNode>(b.id)!.ends).toEqual([{ kind: "page", page: "pg-2", anchor: "n" }, cardEnd(card)]);
    store.redo();
    expect(node(a.id)).toBeUndefined();
    expect(node(b.id)).toBeUndefined();
  });

  test("an association whose card is missing as the figure loads is freed, not deleted", () => {
    const doc = figure(false, (d) => [
      connectorNodeDefaults(d.pages[0], { id: "k", ends: [cardEnd("gone"), { kind: "page", page: "pg-1", anchor: "e" }] }, []),
    ]);
    const { node } = setup(doc);
    expect(node<ConnectorNode>("k")).toBeDefined();
  });

  test("an association across pages is accepted by node.update and moves with node.move of its card", async () => {
    const { call, node, store, r, card } = await withCard(true);
    const { id } = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-1", anchor: "e" } })) as { id: string };
    await call("node.update", { id, patch: { ends: [cardEnd(card), { kind: "page", page: "pg-2", anchor: "n" }] } });
    const c = node<ConnectorNode>(id)!;
    expect(c.page).toBe("pg-1");
    expect(c.ends[1]).toEqual({ kind: "page", page: "pg-2", anchor: "n" });
    const at = resolveConnector(store.doc, c, r);
    // Page 2's north midpoint, in page 1's pixels.
    expect(at.ends[1].pt.x).toBeCloseTo(105 * MM, 6);
    expect(at.ends[1].pt.y).toBeCloseTo((297 + 20) * MM, 6);
    const start = at.ends[0].pt;
    const box = { x: c.x, y: c.y };
    await call("node.move", { ids: [card], dx: 0, dy: 30 * MM });
    const moved = node<ConnectorNode>(id)!;
    const after = resolveConnector(store.doc, moved, r);
    expect(after.ends[0].pt.y).toBeCloseTo(start.y + 30 * MM, 1);
    expect(after.ends[1].pt).toEqual(at.ends[1].pt);
    expect(moved.ends[1]).toEqual({ kind: "page", page: "pg-2", anchor: "n" });
    expect({ x: moved.x, y: moved.y }).not.toEqual(box);
    expect(node(card)!.page).toBe("pg-1");
  });

  test("existing figures round-trip byte-identically", () => {
    const r = registries();
    const doc = figure(true, (d) => [
      shapeNodeDefaults(d.pages[0], { id: "s", x: 10, y: 10, width: 50, height: 50, z: 0 }, []),
      textNodeDefaults(d.pages[0], { id: "t", x: 70, y: 10, z: 1 }, []),
      connectorNodeDefaults(d.pages[0], { id: "k", z: 2, ends: [{ kind: "attached", node: "s", snap: "anchor", anchor: "e" }, { kind: "free", x: 300, y: 300 }] }, []),
    ]);
    // As saved by the plugin: normalised.
    const text = serializeFigureFile(createFigureStore(doc, r).doc, emptyParsed());
    const loaded = loadDocument(text, r);
    expect(serializeFigureFile(createFigureStore(loaded.doc, r).doc, loaded.parsed)).toBe(text);
  });

  test("a figure with cards and associations round-trips byte-identically", async () => {
    const { call, store, r, card } = await withCard(true);
    await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-2", anchor: "n" } });
    await call("card.create", { page: "pg-2", x: -70 * MM, y: 0, file: "Notes/a.md", subpath: "#Legend" });
    const text = serializeFigureFile(store.doc, emptyParsed());
    const loaded = loadDocument(text, r);
    expect(loaded.unreadable.size).toBe(0);
    expect(serializeFigureFile(createFigureStore(loaded.doc, r).doc, loaded.parsed)).toBe(text);
  });
});

describe("node.update of a card", () => {
  test("edits text, file and subpath; giving one kind of content drops the other", async () => {
    const { call, node } = setup(figure());
    const { id } = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 0, text: "a" })) as { id: string };
    await call("node.update", { id, patch: { text: "b" } });
    expect(node(id)).toMatchObject({ text: "b" });
    await call("node.update", { id, patch: { file: "n.md", subpath: "#H" } });
    expect(JSON.parse(JSON.stringify(node(id)))).toMatchObject({ file: "n.md", subpath: "#H" });
    expect(JSON.parse(JSON.stringify(node(id))).text).toBeUndefined();
    await call("node.update", { id, patch: { text: "c" } });
    const now = JSON.parse(JSON.stringify(node(id)));
    expect(now.text).toBe("c");
    expect(now.file).toBeUndefined();
    expect(now.subpath).toBeUndefined();
    await expect(call("node.update", { id, patch: { text: "x", file: "y.md" } })).rejects.toThrow(/^node\.update: give text or file, not both$/);
    await expect(call("node.update", { id, patch: { text: 3 } })).rejects.toThrow(/^node\.update: /);
    await expect(call("node.update", { id, patch: { subpath: "#x" } })).rejects.toThrow(/^node\.update: /);
  });
});

describe("delete-page and cards placed against it", () => {
  test("a card placed against the deleted page moves to the nearest page, keeping its world position, pushed off the paper, in one undo step", async () => {
    const doc = figure(true);
    // Page 2 is wider, so once it moves up into page 1's place the card beside page 1 is over its paper.
    Object.assign(doc.pages[1], { preset: "custom", width: 250 });
    const { call, node, store } = setup(doc);
    const { id: card } = (await call("card.create", { page: "pg-1", x: 220 * MM, y: 10 * MM, id: "c" })) as { id: string };
    const toOld = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-1", anchor: "e" } })) as { id: string };
    const toOther = (await call("connector.create", { page: "pg-1", from: cardEnd(card), to: { kind: "page", page: "pg-2", anchor: "n" } })) as { id: string };
    await call("delete-page", { page: "pg-1" });
    expect(store.doc.pages.map((p) => p.id)).toEqual(["pg-2"]);
    const moved = node(card)!;
    expect(moved.page).toBe("pg-2");
    // Its world position (page 2 now starts at the top) is kept, then pushed clear of the 250 mm paper.
    expect(moved.x).toBeCloseTo(254 * MM, 1);
    expect(moved.y).toBeCloseTo(10 * MM, 1);
    expect(clearOfPapers(store.doc, moved)).toBe(true);
    // Its association to the deleted page goes; the one to page 2 stays with the card.
    expect(node(toOld.id)).toBeUndefined();
    expect(node<ConnectorNode>(toOther.id)).toMatchObject({ page: "pg-2", ends: [cardEnd(card), { kind: "page", page: "pg-2", anchor: "n" }] });
    store.undo();
    expect(store.doc.pages.map((p) => p.id)).toEqual(["pg-1", "pg-2"]);
    expect(node(card)).toMatchObject({ page: "pg-1" });
    expect(node(card)!.x).toBeCloseTo(220 * MM, 1);
    expect(node(toOld.id)).toBeDefined();
    expect(node(toOther.id)).toMatchObject({ page: "pg-1" });
  });

  test("a card keeps its world position on the remaining page nearest it", async () => {
    const doc = figure(true);
    doc.pages.push({ ...createPage("a4-portrait", ["pg-1", "pg-2"]), id: "pg-3" });
    const { call, node, store } = setup(doc);
    // Beside the bottom of page 2: page 3 is nearer than page 1.
    await call("card.create", { page: "pg-2", x: -70 * MM, y: 280 * MM, id: "c" });
    const world = nodeWorldRect(store.doc, node("c")!);
    await call("delete-page", { page: "pg-2" });
    const card = node("c")!;
    expect(card.page).toBe("pg-3");
    expect(nodeWorldRect(store.doc, card).x).toBeCloseTo(world.x, 1);
    expect(nodeWorldRect(store.doc, card).y).toBeCloseTo(world.y, 1);
  });
});

describe("note cards keep their link in the Links section", () => {
  async function noteFigure() {
    const s = setup(figure());
    await s.call("card.create", { page: "pg-1", x: 220 * MM, y: 0, file: "Notes/a.md", subpath: "#Legend", id: "n" });
    await s.call("card.create", { page: "pg-1", x: 220 * MM, y: 60 * MM, text: "typed", id: "t" });
    return s;
  }

  test("the link is written as a Links entry, not in the JSON, and read back from it", async () => {
    const { store, r } = await noteFigure();
    const text = serializeFigureFile(store.doc, emptyParsed());
    expect(text).toContain("- n: ![[Notes/a.md#Legend]] ^n");
    const json = text.slice(text.indexOf("```lnkfig"));
    expect(json).not.toContain("Notes/a.md");
    expect(text).not.toContain("- t:");
    const loaded = loadDocument(text, r);
    expect(loaded.unreadable.size).toBe(0);
    expect(loaded.doc.nodes.find((n) => n.id === "n")).toMatchObject({ file: "Notes/a.md", subpath: "#Legend" });
    expect(loaded.doc.nodes.find((n) => n.id === "t")).toMatchObject({ text: "typed" });
    expect("file" in loaded.doc.nodes.find((n) => n.id === "t")!).toBe(false);
    expect(serializeFigureFile(createFigureStore(loaded.doc, r).doc, loaded.parsed)).toBe(text);
  });

  test("a rename of the linked note, made by Obsidian in the Links section, is a links-only reload that relinks the card", async () => {
    const { store, r } = await noteFigure();
    const text = serializeFigureFile(store.doc, emptyParsed());
    const current = loadDocument(text, r);
    const renamedText = text.replace("![[Notes/a.md#Legend]]", "![[Notes/b.md#Legend]]");
    const next = loadDocument(renamedText, r);
    expect(classifyReload(current, next)).toBe("links");
    const { doc, changedIds } = applyLinkEntries(current.doc, parseFigureFile(renamedText).links);
    expect(changedIds).toEqual(["n"]);
    expect(doc.nodes.find((n) => n.id === "n")).toMatchObject({ file: "Notes/b.md", subpath: "#Legend" });
    expect(doc.nodes.find((n) => n.id === "t")).toBe(current.doc.nodes.find((n) => n.id === "t"));
    // A link without a subpath leaves none.
    const plain = applyLinkEntries(current.doc, parseFigureFile(text.replace("![[Notes/a.md#Legend]]", "![[Notes/c]]")).links);
    const relinked = plain.doc.nodes.find((n) => n.id === "n")!;
    expect(relinked).toMatchObject({ file: "Notes/c" });
    expect("subpath" in relinked).toBe(false);
  });

  test("a note card that is only in the undo history is relinked by a rename, so undo brings it back linked to the new name", async () => {
    const { store, call, node } = await noteFigure();
    await call("delete", { ids: ["n"] });
    store.rebasePaths(new Map([["Notes/a.md", "Notes/b.md"]]));
    store.undo();
    expect(node("n")).toMatchObject({ file: "Notes/b.md", subpath: "#Legend" });
  });
});

describe("review fixes", () => {
  test("a card does not rotate: node.update refuses a rotation but 0, and rotation is derived", async () => {
    const { call, node } = setup(figure());
    await call("card.create", { page: "pg-1", x: 220 * MM, y: 0, id: "c" });
    await expect(call("node.update", { id: "c", patch: { rotation: 15 } })).rejects.toThrow(/^node\.update: a card does not rotate$/);
    await call("node.update", { id: "c", patch: { rotation: 0 } });
    expect(node("c")!.rotation).toBe(0);
    expect(cardNodeType.derivedFields).toContain("rotation");
  });

  test("delete-page re-homes a connector whose items all go to the same page, keeping its free end's canvas place", async () => {
    const { call, node, store, r } = setup(figure(true));
    await call("card.create", { page: "pg-2", x: 220 * MM, y: 10 * MM, id: "a" });
    await call("card.create", { page: "pg-2", x: 220 * MM, y: 60 * MM, id: "b" });
    const both = (await call("connector.create", { page: "pg-2", from: cardEnd("a", "s"), to: cardEnd("b", "n") })) as { id: string };
    const loose = (await call("connector.create", { page: "pg-2", from: cardEnd("a", "e"), to: { kind: "free", x: 300 * MM, y: 20 * MM } })) as { id: string };
    const freeWorld = () => {
      const c = node<ConnectorNode>(loose.id)!;
      const end = resolveConnector(store.doc, c, r).ends[1].pt;
      return nodeWorldRect(store.doc, { ...c, x: end.x, y: end.y, width: 0, height: 0 } as Node);
    };
    const before = freeWorld();
    await call("delete-page", { page: "pg-2" });
    expect(node("a")!.page).toBe("pg-1");
    expect(node(both.id)).toMatchObject({ page: "pg-1", ends: [cardEnd("a", "s"), cardEnd("b", "n")] });
    expect(node(loose.id)).toMatchObject({ page: "pg-1" });
    expect(node<ConnectorNode>(loose.id)!.ends[0]).toEqual(cardEnd("a", "e"));
    const after = freeWorld();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });
});

