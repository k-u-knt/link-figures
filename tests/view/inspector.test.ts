import { createDocument, createPage, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import { DocumentStore } from "../../src/model/store";
import type { Node } from "../../src/model/types";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";
import { clampToField, colorInputValue, formatNumber, Inspector } from "../../src/view/inspector";
import { SelectionState } from "../../src/view/selection";
import { FakeEl } from "./fake-dom";

/** A node type that, like the file node, offers a field of its own for PDFs only. */
const fileType = {
  type: "file",
  name: "Linked file",
  icon: "image",
  inspector: (node: any) => (String(node.file).endsWith(".pdf") ? [{ kind: "number", key: "pageIndex", label: "Page", min: 0, step: 1 }] : []),
} as unknown as NodeType;

function setup(build: (doc: ReturnType<typeof createDocument>) => void = () => {}) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const store = new DocumentStore(doc);
  const registries = createRegistries();
  registries.nodeTypes.register(fileType);
  const selection = new SelectionState();
  const view = { readOnly: false, store, selection, plugin: { registries }, currentPage: () => store.doc.pages[0] };
  const el = new FakeEl("div");
  const inspector = new Inspector(view as never, el as never);
  // What the figure view does: render on every store change and every selection change.
  store.subscribe(() => inspector.render());
  selection.onChange(() => inspector.render());
  inspector.render();
  return { doc, store, selection, view, el, inspector, labels: () => labelsOf(store) };
}

const labelsOf = (store: DocumentStore) => {
  const seen: string[] = [];
  store.subscribe((ev) => seen.push(ev.label));
  return seen;
};

const addNode = (doc: ReturnType<typeof createDocument>, partial: Partial<Node> = {}): Node => {
  const node = { ...fileNodeDefaults(doc.pages[0], { file: "plot.png", subpath: "", show: "image" }, doc.nodes.map((n) => n.id)), ...partial } as Node;
  doc.nodes.push(node);
  return node;
};

const titleOf = (el: FakeEl) => el.find((e) => e.hasClass("lf-inspector-title"))?.text;
const keysOf = (el: FakeEl) => el.findAll((e) => "data-key" in e.attrs).map((e) => e.attrs["data-key"]);

describe("helpers", () => {
  test("numbers are shown to hundredths", () => {
    expect(formatNumber(12.3456)).toBe("12.35");
    expect(formatNumber(210)).toBe("210");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
  });

  test("clampToField keeps a number within min and max", () => {
    const f = { kind: "number", key: "k", label: "K", min: 1, max: 5 } as const;
    expect([clampToField(f, 0), clampToField(f, 3), clampToField(f, 9)]).toEqual([1, 3, 5]);
    expect(clampToField({ kind: "number", key: "k", label: "K" }, -7)).toBe(-7);
  });

  test("a colour input takes #rrggbb only", () => {
    expect(colorInputValue("#F4F4F4")).toBe("#f4f4f4");
    expect(colorInputValue("#abc")).toBe("#aabbcc");
    expect(colorInputValue("white")).toBe("#000000");
    expect(colorInputValue(undefined)).toBe("#000000");
  });
});

describe("page section", () => {
  test("with nothing selected it shows the page, one row per field, with the page's values", () => {
    const { el } = setup();
    expect(titleOf(el)).toBe("Page");
    expect(el.find((e) => e.hasClass("lf-inspector-sub"))?.text).toBe("Page 1");
    expect(keysOf(el)).toEqual(["preset", "width", "height", "paper", "margins.top", "margins.right", "margins.bottom", "margins.left"]);
    expect(el.findAll((e) => e.hasClass("lf-field"))).toHaveLength(8);
    expect(el.control("preset").value).toBe("a4-portrait");
    expect(el.control("width").value).toBe("210");
    expect(el.control("height").value).toBe("297");
    expect(el.control("paper").value).toBe("#ffffff");
    expect(el.control("margins.left").value).toBe("0");
    // Sizes carry their unit.
    expect(el.find((e) => e.hasClass("lf-unit"))?.text).toBe("mm");
  });

  test("choosing a preset resizes the page, and the size fields follow", () => {
    const { el, store } = setup();
    const select = el.control("preset");
    select.focus();
    select.value = "nature-double";
    select.fire("change");
    expect(store.doc.pages[0]).toMatchObject({ preset: "nature-double", width: 183, height: 170 });
    expect(el.control("width").value).toBe("183");
    expect(el.control("height").value).toBe("170");
    expect(select.value).toBe("nature-double");
  });

  test("choosing Custom leaves the size alone", () => {
    const { el, store } = setup();
    el.control("preset").value = "custom";
    el.control("preset").fire("change");
    expect(store.doc.pages[0]).toMatchObject({ preset: "custom", width: 210, height: 297 });
  });

  test("typing a width commits it as inspect:width, makes the page custom, and clamps below the minimum", () => {
    const { el, store, labels } = setup();
    const seen = labels();
    el.typeInto("width", "150");
    expect(store.doc.pages[0]).toMatchObject({ width: 150, preset: "custom" });
    expect(el.control("preset").value).toBe("custom");
    el.typeInto("height", "2");
    expect(store.doc.pages[0].height).toBe(10);
    expect(el.control("height").value).toBe("10");
    expect(seen).toEqual(["inspect:width", "inspect:height"]);
  });

  test("something that is not a number puts the old value back and writes nothing", () => {
    const { el, store } = setup();
    el.typeInto("width", "");
    expect(el.control("width").value).toBe("210");
    expect(store.canUndo()).toBe(false);
  });

  test("the paper colour is written as it is picked", () => {
    const { el, store } = setup();
    const paper = el.control("paper");
    paper.value = "#f4f4f4";
    paper.fire("input");
    expect(store.doc.pages[0].paper).toBe("#f4f4f4");
  });

  test("a margin is written through its dotted key", () => {
    const { el, store } = setup();
    el.typeInto("margins.left", "15");
    expect(store.doc.pages[0].margins).toEqual({ top: 0, right: 0, bottom: 0, left: 15 });
    el.typeInto("margins.top", "-3");
    expect(store.doc.pages[0].margins.top).toBe(0);
  });

  test("a preset that is not one of ours is shown as custom", () => {
    const { el, store } = setup();
    store.commit("edit", (d) => { d.pages[0].preset = "from-a-newer-version"; });
    expect(el.control("preset").value).toBe("custom");
  });

  test("an edit is undone from the history like any other", () => {
    const { el, store } = setup();
    el.typeInto("margins.left", "15");
    store.undo();
    expect(store.doc.pages[0].margins.left).toBe(0);
    expect(el.control("margins.left").value).toBe("0");
  });
});

describe("updating", () => {
  test("a change to the document updates the controls in place and does not build them again", () => {
    const { el, store } = setup();
    const width = el.control("width");
    store.commit("external", (d) => { d.pages[0].width = 120; });
    expect(el.control("width")).toBe(width);
    expect(width.value).toBe("120");
  });

  test("a control that is being typed into is left alone, until it is committed or left", () => {
    const { el, store } = setup();
    const width = el.typeOnly("width", "12");
    store.commit("external", (d) => { d.pages[0].margins.left = 5; });
    expect(width.value).toBe("12");
    expect(el.control("margins.left").value).toBe("5");
    // Left without a commit: the model's value is back, and the control follows the model again.
    width.fire("blur");
    expect(width.value).toBe("210");
    store.commit("external", (d) => { d.pages[0].width = 100; });
    expect(width.value).toBe("100");
  });

  test("a control that has the focus but nothing typed in it follows the model", () => {
    const { el, store } = setup();
    el.typeInto("margins.left", "15");
    store.undo();
    expect(el.control("margins.left").value).toBe("0");
  });

  test("a different selection builds the panel again", () => {
    const { el, selection } = setup((d) => { addNode(d, { id: "p-aaaa" }); });
    const page = el.control("width");
    selection.set(["p-aaaa"]);
    expect(titleOf(el)).toBe("Node");
    expect(el.querySelector('[data-key="width"]')).not.toBe(page);
    selection.clear();
    expect(titleOf(el)).toBe("Page");
  });

  test("a view that is read-only has an empty inspector", () => {
    const { el, view, inspector } = setup();
    expect(el.children.length).toBeGreaterThan(0);
    view.readOnly = true;
    inspector.render();
    expect(el.children).toEqual([]);
    view.readOnly = false;
    inspector.render();
    expect(titleOf(el)).toBe("Page");
  });

  test("a page that has gone from under the inspector shows the page that is there now", () => {
    const { el, store } = setup((d) => { d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id), "Second")); });
    expect(el.find((e) => e.hasClass("lf-inspector-sub"))?.text).toBe("Page 1");
    store.commit("delete-page", (d) => { d.pages.shift(); });
    expect(el.find((e) => e.hasClass("lf-inspector-sub"))?.text).toBe("Second");
  });
});

describe("node section", () => {
  const MM = mmToPx(1);

  test("a node shows its type's name and the base fields, then its own, with position and size in millimetres", () => {
    const { el, selection } = setup((d) => {
      addNode(d, { id: "p-img", x: 12 * MM, y: 7 * MM, width: 40 * MM, height: 25 * MM, rotation: 90, opacity: 0.5, name: "Plot" });
      addNode(d, { id: "p-pdf", file: "plot.pdf" });
    });
    selection.set(["p-img"]);
    expect(titleOf(el)).toBe("Node");
    expect(el.find((e) => e.hasClass("lf-inspector-sub"))?.text).toBe("Linked file");
    expect(keysOf(el)).toEqual(["x", "y", "width", "height", "rotation", "opacity", "name", "locked"]);
    expect(el.control("x").value).toBe("12");
    expect(el.control("y").value).toBe("7");
    expect(el.control("width").value).toBe("40");
    expect(el.control("height").value).toBe("25");
    expect(el.control("rotation").value).toBe("90");
    expect(el.control("opacity").value).toBe("0.5");
    expect(el.control("name").value).toBe("Plot");
    expect(el.control("locked").checked).toBe(false);
    selection.set(["p-pdf"]);
    expect(keysOf(el)).toEqual(["x", "y", "width", "height", "rotation", "opacity", "name", "locked", "pageIndex"]);
  });

  test("typing a width in millimetres resizes the node in pixels, and a long run of edits is one undo step", () => {
    const { el, store, selection, labels } = setup((d) => { addNode(d, { id: "p-img", width: 40 * MM }); });
    const seen = labels();
    selection.set(["p-img"]);
    el.typeInto("width", "50");
    expect(store.doc.nodes[0].width).toBeCloseTo(50 * MM, 1);
    el.typeInto("width", "55");
    expect(store.doc.nodes[0].width).toBeCloseTo(55 * MM, 1);
    expect(el.control("width").value).toBe("55");
    expect(seen).toEqual(["inspect:width", "inspect:width"]);
    store.undo();
    expect(store.doc.nodes[0].width).toBeCloseTo(40 * MM, 1);
  });

  test("a node is never made smaller than a millimetre", () => {
    const { el, store, selection } = setup((d) => { addNode(d, { id: "p-img" }); });
    selection.set(["p-img"]);
    el.typeInto("height", "0");
    expect(store.doc.nodes[0].height).toBeCloseTo(MM, 1);
  });

  test("x and y are millimetres too, rotation and opacity are as they are stored", () => {
    const { el, store, selection } = setup((d) => { addNode(d, { id: "p-img" }); });
    selection.set(["p-img"]);
    el.typeInto("x", "10");
    el.typeInto("rotation", "45");
    el.typeInto("opacity", "2");
    expect(store.doc.nodes[0].x).toBeCloseTo(10 * MM, 1);
    expect(store.doc.nodes[0]).toMatchObject({ rotation: 45, opacity: 1 });
  });

  test("a node's own field is written as it is", () => {
    const { el, store, selection } = setup((d) => { addNode(d, { id: "p-pdf", file: "plot.pdf" }); });
    selection.set(["p-pdf"]);
    el.typeInto("pageIndex", "1");
    expect((store.doc.nodes[0] as any).pageIndex).toBe(1);
  });

  test("locked is a checkbox, and a locked node can still be edited from the inspector", () => {
    const { el, store, selection } = setup((d) => { addNode(d, { id: "p-img", locked: true }); });
    selection.set(["p-img"]);
    expect(el.control("locked").checked).toBe(true);
    el.typeInto("x", "20");
    expect(store.doc.nodes[0].x).toBeCloseTo(20 * MM, 1);
    const locked = el.control("locked");
    locked.checked = false;
    locked.fire("change");
    expect(store.doc.nodes[0].locked).toBe(false);
  });

  test("an emptied name is removed, not kept as an empty string", () => {
    const { el, store, selection } = setup((d) => { addNode(d, { id: "p-img", name: "Plot" }); });
    selection.set(["p-img"]);
    el.typeInto("name", "");
    expect("name" in store.doc.nodes[0]).toBe(false);
  });

  test("with several nodes selected a write goes to every one, but a node type's own field only to nodes of that type", () => {
    const { el, store, selection } = setup((d) => {
      addNode(d, { id: "p-pdf", file: "plot.pdf" });
      addNode(d, { id: "p-pdf2", file: "other.pdf" });
      addNode(d, { id: "p-other", file: "plot.png", locked: true });
      d.nodes.push(textNodeDefaults(d.pages[0], { id: "p-text" }, d.nodes.map((n) => n.id)));
      addNode(d, { id: "p-unselected" });
    });
    selection.set(["p-pdf", "p-pdf2", "p-text", "p-other"]);
    expect(titleOf(el)).toBe("4 nodes");
    el.typeInto("opacity", "0.25");
    expect(store.doc.nodes.map((n) => [n.id, n.opacity])).toEqual([["p-pdf", 0.25], ["p-pdf2", 0.25], ["p-other", 0.25], ["p-text", 0.25], ["p-unselected", 1]]);
    el.typeInto("pageIndex", "3");
    const byId = new Map(store.doc.nodes.map((n) => [n.id, n as any]));
    expect(byId.get("p-pdf").pageIndex).toBe(3);
    expect(byId.get("p-pdf2").pageIndex).toBe(3);
    // Another type of node, and a node that is not selected: no stray field.
    expect("pageIndex" in byId.get("p-text")).toBe(false);
    expect(byId.get("p-unselected").pageIndex).toBe(0);
  });

  test("a selected node that is moved elsewhere shows its new position without the panel being built again", () => {
    const { el, store, selection } = setup((d) => { addNode(d, { id: "p-img", x: 0 }); });
    selection.set(["p-img"]);
    const x = el.control("x");
    store.commit("move", (d) => { d.nodes[0].x = 5 * MM; });
    expect(el.control("x")).toBe(x);
    expect(x.value).toBe("5");
  });

  test("a selected node that is deleted gives the page back", () => {
    const { el, store, selection } = setup((d) => { addNode(d, { id: "p-img" }); });
    selection.set(["p-img"]);
    store.commit("delete", (d) => { d.nodes = []; });
    // The view's pointer controller prunes the selection when the store changes; the inspector alone shows the page either way.
    expect(titleOf(el)).toBe("Page");
  });
});
