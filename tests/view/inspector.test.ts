import { createDocument, createPage, defaultBorder, fileNodeDefaults, groupNodeDefaults, shapeNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import { DEFAULT_PAGE_LIMIT_MM } from "../../src/constants";
import { createFigureStore } from "../../src/model/normalise";
import { DocumentStore } from "../../src/model/store";
import type { FileNode, Node, ShapeNode, Stroke } from "../../src/model/types";
import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import type { ConnectorNode } from "../../src/model/types";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { cropCommands } from "../../src/commands/crop";
import { fileNodeType } from "../../src/nodes/file-node";
import { drawingCommands } from "../../src/commands/drawing";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";
import { clampToField, colorInputValue, formatNumber, Inspector } from "../../src/view/inspector";
import { pageInFocus } from "../../src/view/viewport";
import { SelectionState } from "../../src/view/selection";
import { FakeEl } from "./fake-dom";

// `obsidian` ships only typings, so the file node type is loaded with it stubbed.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

/** A node type that, like the file node, offers a field of its own for PDFs only. */
const fileType = {
  type: "file",
  name: "Linked file",
  icon: "image",
  // The file node's own crop routes, with a crop inset offered on a panel that has a crop.
  fieldRoute: fileNodeType.fieldRoute,
  inspector: (node: any) => [
    ...(node.crop ? [{ kind: "number", key: "crop.left", label: "Crop left", unit: "%", min: 0, max: 100 }] : []),
    ...(String(node.file).endsWith(".pdf") ? [{ kind: "number", key: "pageIndex", label: "Page", min: 0, step: 1 }] : []),
    // A frame's fields, as a node type with a stroke offers them: dotted keys into the node.
    ...(node.frame ? [{ kind: "paint", key: "frame.paint", label: "Frame" }, { kind: "number", key: "frame.width", label: "Frame width", unit: "pt", min: 0 }] : []),
  ],
} as unknown as NodeType;

/**
 * An inspector on a figure that `build` fills. With `figure`, the connector node type, the routes and the caps are
 * registered and the store is a figure's (`createFigureStore`, with the connector normaliser), as the view's is.
 */
function setup(build: (doc: ReturnType<typeof createDocument>) => void = () => {}, options: { figure?: boolean } = {}) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const registries = createRegistries();
  registries.nodeTypes.register(fileType);
  for (const paint of builtinPaintTypes) registries.paints.register(paint);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  registries.nodeTypes.register(shapeNodeType);
  if (options.figure) {
    registries.nodeTypes.register(connectorNodeType);
    for (const route of builtinRoutes) registries.routes.register(route);
    for (const cap of builtinCapKinds) registries.caps.register(cap);
  }
  const store = options.figure ? createFigureStore(doc, registries) : new DocumentStore(doc);
  // The inspector's node writes run the node.update command.
  for (const command of drawingCommands()) registries.commands.register(command);
  for (const command of cropCommands()) registries.commands.register(command);
  const selection = new SelectionState();
  const pageLimits: number[] = [];
  // The stage is centred on the page at `pageIndex`; `focusPage` is the view's rule for the page that is acted on.
  const view = {
    readOnly: false,
    store,
    selection,
    plugin: { registries },
    pageIndex: 0,
    currentPage: () => store.doc.pages[view.pageIndex],
    focusPage: () => pageInFocus(store.doc, selection.ids, store.doc.pages[view.pageIndex])!,
    // What page.update asks of the view: the Maximum page size setting, and to say when a size was cut down to it.
    pageLimitMm: (): number => (view.plugin as { settings?: { maxPageSizeMm: number } }).settings?.maxPageSizeMm ?? DEFAULT_PAGE_LIMIT_MM,
    notePageLimit: (limitMm: number) => void pageLimits.push(limitMm),
    commandContext: () => ({ app: {} as never, registries, view, store, selection: selection.ids, page: view.focusPage() }),
  };
  const el = new FakeEl("div");
  // What the view shows as notices.
  const notices: string[] = [];
  const inspector = new Inspector(view as never, el as never, (message) => notices.push(message));
  // What the figure view does: render on every store change and every selection change.
  store.subscribe(() => inspector.render());
  selection.onChange(() => inspector.render());
  inspector.render();
  return { doc, store, selection, view, el, inspector, notices, pageLimits, labels: () => labelsOf(store) };
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

  test("a width over the page limit is shown, and kept, at the limit, and the view says so", () => {
    const { el, store, view, pageLimits } = setup();
    (view.plugin as any).settings = { maxPageSizeMm: 2000 };
    el.typeInto("width", "2500");
    expect(store.doc.pages[0].width).toBe(2000);
    expect(el.control("width").value).toBe("2000");
    expect(pageLimits).toEqual([2000]);
    // Typing it again when the page is already at the limit changes nothing in the model, yet the field is put right.
    el.typeInto("width", "2500");
    expect(el.control("width").value).toBe("2000");
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

  test("a selected group is titled with its number of direct members, which follows the document", () => {
    const { el, selection, store, view } = setup((d) => {
      addNode(d, { id: "p-a", parent: "p-g" });
      addNode(d, { id: "p-b", parent: "p-h" });
      addNode(d, { id: "p-c", parent: "p-h" });
      d.nodes.push(groupNodeDefaults(d.pages[0], { id: "p-h", parent: "p-g" }, []));
      d.nodes.push(groupNodeDefaults(d.pages[0], { id: "p-g" }, []));
    });
    view.plugin.registries.nodeTypes.register(groupNodeType);
    selection.set(["p-g"]);
    expect(titleOf(el)).toBe("Group (2 items)");
    store.commit("add", (d) => { d.nodes.push({ ...fileNodeDefaults(d.pages[0], { file: "x.png", subpath: "", show: "image" }, []), id: "p-d", parent: "p-g" } as Node); });
    expect(titleOf(el)).toBe("Group (3 items)");
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

  test("the page section is that of the view's focus page, not of the page the stage is centred on", () => {
    const { el, store, view } = setup((d) => { d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id), "Second")); });
    expect(el.find((e) => e.hasClass("lf-inspector-sub"))?.text).toBe("Page 1");
    view.focusPage = () => store.doc.pages[1];
    store.commit("edit", (d) => { d.pages[1].name = "Second!"; });
    expect(el.find((e) => e.hasClass("lf-inspector-sub"))?.text).toBe("Second!");
    el.typeInto("margins.left", "9");
    expect(store.doc.pages.map((p) => p.margins.left)).toEqual([0, 9]);
  });

  test("a selected node on another page than the one the stage is centred on is shown as a node, and with it deselected the page shown is the centred one", () => {
    const { el, selection } = setup((d) => {
      d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id), "Second"));
      addNode(d, { id: "p-on-2", page: d.pages[1].id });
    });
    selection.set(["p-on-2"]);
    expect(titleOf(el)).toBe("Node");
    selection.clear();
    expect(el.find((e) => e.hasClass("lf-inspector-sub"))?.text).toBe("Page 1");
  });

  test("with nothing selected, a render after the stage centres on another page shows that page", () => {
    const { el, view, inspector } = setup((d) => { d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id))); });
    const subtitle = () => el.find((e) => e.hasClass("lf-inspector-sub"))?.text;
    expect(subtitle()).toBe("Page 1");
    view.pageIndex = 1;
    inspector.render();
    expect(subtitle()).toBe("Page 2");
    view.pageIndex = 0;
    inspector.render();
    expect(subtitle()).toBe("Page 1");
  });

  describe("a field being typed into while the stage moves to another page", () => {
    const twoPages = (d: ReturnType<typeof createDocument>) => { d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id))); };
    const subtitleOf = (el: FakeEl) => el.find((e) => e.hasClass("lf-inspector-sub"))?.text;

    test("a section change waits while a field in the inspector is being typed into, and lands when it loses the focus", () => {
      const { el, view, inspector } = setup(twoPages);
      const width = el.typeOnly("width", "12");
      view.pageIndex = 1;
      inspector.render();
      // The page nearest the middle is now the second, but the field keeps its place and its text.
      expect(subtitleOf(el)).toBe("Page 1");
      expect(el.control("width")).toBe(width);
      expect(width.value).toBe("12");
      // The browser blurs the control (nothing committed, so the model's value is back), then `focusout` reaches the inspector.
      el.ownerDocument.activeElement = null;
      width.fire("blur");
      el.fire("focusout");
      expect(subtitleOf(el)).toBe("Page 2");
      expect(el.control("width").value).toBe("210");
    });

    test("committed with Enter, the held section lands at once, and the write went to the page the field belonged to", () => {
      const { el, view, inspector, store } = setup(twoPages);
      el.typeOnly("width", "150");
      view.pageIndex = 1;
      inspector.render();
      expect(subtitleOf(el)).toBe("Page 1");
      el.control("width").fire("change");
      expect(store.doc.pages.map((p) => p.width)).toEqual([150, 210]);
      expect(subtitleOf(el)).toBe("Page 2");
    });

    test("a field with the focus but nothing typed in it does not hold the section back, and a focusout with nothing held changes nothing", () => {
      const { el, view, inspector } = setup(twoPages);
      el.control("width").focus();
      const margin = el.control("margins.left");
      el.fire("focusout");
      expect(el.control("margins.left")).toBe(margin);
      view.pageIndex = 1;
      inspector.render();
      expect(subtitleOf(el)).toBe("Page 2");
    });

    test("a field typed into in another view's inspector does not hold this one back", () => {
      const { el, view, inspector } = setup(twoPages);
      // A second pane: its own inspector over its own element, in the same document, with the focus in one of its fields.
      const elsewhere = new FakeEl("div", el.ownerDocument);
      const second = new Inspector(view as never, elsewhere as never);
      second.render();
      elsewhere.typeOnly("width", "12");
      expect(el.ownerDocument.activeElement).toBe(elsewhere.control("width"));
      view.pageIndex = 1;
      inspector.render();
      expect(subtitleOf(el)).toBe("Page 2");
    });

    test("an element that has no ownerDocument is rendered as it always was", () => {
      const { el, view, inspector } = setup(twoPages);
      Object.defineProperty(el, "ownerDocument", { value: undefined });
      view.pageIndex = 1;
      expect(() => inspector.render()).not.toThrow();
      expect(subtitleOf(el)).toBe("Page 2");
    });
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

  test("a crop inset is not written on a locked panel, or one in a locked group; panel.crop would refuse it", () => {
    const crop = { x: 0, y: 0, w: 1, h: 1 };
    const { el, store, selection, notices } = setup((d) => {
      addNode(d, { id: "p-locked", locked: true, crop } as Partial<Node>);
      addNode(d, { id: "p-member", parent: "g", crop } as Partial<Node>);
      d.nodes.push(groupNodeDefaults(d.pages[0], { id: "g", locked: true }, d.nodes.map((n) => n.id)) as Node);
    });
    for (const id of ["p-locked", "p-member"]) {
      selection.set([id]);
      el.typeInto("crop.left", "10");
      expect((store.doc.nodes.find((n) => n.id === id) as FileNode).crop).toEqual(crop);
    }
    expect(store.canUndo()).toBe(false);
    // Nothing was offered to panel.crop, so nothing was refused.
    expect(notices).toEqual([]);
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

describe("paint fields", () => {
  const solidFrame = (): Stroke => ({ paint: { type: "solid", color: "#ff0000", opacity: 0.5 }, width: 1, dash: "solid" });
  const frameOf = (store: DocumentStore, i = 0) => (store.doc.nodes[i] as FileNode).frame!;
  const optionsOf = (select: FakeEl) => select.children.filter((c) => c.tag === "option").map((c) => c.value);
  const linearDefaults = () => builtinPaintTypes.find((t) => t.id === "linear")!.defaults();

  function framed() {
    const s = setup((d) => { addNode(d, { id: "p-img", frame: solidFrame() } as Partial<FileNode>); });
    s.selection.set(["p-img"]);
    return s;
  }

  test("a paint field is a select of the paint types, then the chosen type's own fields, read through dotted keys", () => {
    const { el } = framed();
    expect(keysOf(el)).toEqual([
      "x", "y", "width", "height", "rotation", "opacity", "name", "locked",
      "frame.paint", "frame.paint.type", "frame.paint.color", "frame.paint.opacity", "frame.width",
    ]);
    const select = el.control("frame.paint.type");
    expect(optionsOf(select)).toEqual(["none", "solid", "linear", "radial", "pattern"]);
    expect(select.value).toBe("solid");
    expect(el.control("frame.paint.color").value).toBe("#ff0000");
    expect(el.control("frame.paint.opacity").value).toBe("0.5");
    expect(el.control("frame.width").value).toBe("1");
  });

  test("a dotted field writes into the nested value and leaves the rest of it alone", () => {
    const { el, store, labels } = framed();
    const seen = labels();
    el.typeInto("frame.width", "2.5");
    el.control("frame.paint.color").value = "#00ff00";
    el.control("frame.paint.color").fire("input");
    expect(frameOf(store)).toEqual({ paint: { type: "solid", color: "#00ff00", opacity: 0.5 }, width: 2.5, dash: "solid" });
    expect(seen).toEqual(["inspect:frame.width", "inspect:frame.paint.color"]);
  });

  test("switching the type writes that type's defaults as one undo step, and its fields replace the old type's", () => {
    const { el, store, labels } = framed();
    const seen = labels();
    const select = el.control("frame.paint.type");
    select.value = "linear";
    select.fire("change");
    expect(frameOf(store).paint).toEqual(linearDefaults());
    expect(seen).toEqual(["inspect:frame.paint"]);
    expect(el.control("frame.paint.type").value).toBe("linear");
    expect(keysOf(el).filter((k) => k.startsWith("frame.paint."))).toEqual([
      "frame.paint.type", "frame.paint.angle", "frame.paint.stops",
      "frame.paint.stops.0.offset", "frame.paint.stops.0.color", "frame.paint.stops.0.opacity",
      "frame.paint.stops.1.offset", "frame.paint.stops.1.color", "frame.paint.stops.1.opacity",
    ]);
    store.undo();
    expect(frameOf(store).paint).toEqual(solidFrame().paint);
    expect(el.control("frame.paint.type").value).toBe("solid");
    expect(el.querySelector('[data-key="frame.paint.angle"]')).toBeNull();
  });

  test("a gradient's stops are a list: a stop is added, edited and removed, and the last two cannot be removed", () => {
    const { el, store } = framed();
    store.commit("paint", (d) => { (d.nodes[0] as FileNode).frame!.paint = linearDefaults(); });
    const removeButtons = () => el.findAll((e) => e.hasClass("lf-stop-remove"));
    expect(removeButtons().map((b) => b.disabled)).toEqual([true, true]);

    el.find((e) => e.hasClass("lf-stop-add"))!.fire("click");
    expect(frameOf(store).paint.stops).toEqual([
      { offset: 0, color: "#000000" },
      { offset: 0.5, color: "#ffffff" },
      { offset: 1, color: "#ffffff" },
    ]);
    expect(removeButtons().map((b) => b.disabled)).toEqual([false, false, false]);

    el.typeInto("frame.paint.stops.1.offset", "0.25");
    el.control("frame.paint.stops.1.color").value = "#ff0000";
    el.control("frame.paint.stops.1.color").fire("input");
    el.typeInto("frame.paint.stops.1.opacity", "0.5");
    expect((frameOf(store).paint.stops as unknown[])[1]).toEqual({ offset: 0.25, color: "#ff0000", opacity: 0.5 });

    removeButtons()[0].fire("click");
    expect(frameOf(store).paint.stops).toEqual([
      { offset: 0.25, color: "#ff0000", opacity: 0.5 },
      { offset: 1, color: "#ffffff" },
    ]);
    expect(el.control("frame.paint.stops.0.offset").value).toBe("0.25");
    expect(el.querySelector('[data-key="frame.paint.stops.2.offset"]')).toBeNull();
  });

  test("a stop's offset and opacity are kept within 0 to 1", () => {
    const { el, store } = framed();
    store.commit("paint", (d) => { (d.nodes[0] as FileNode).frame!.paint = linearDefaults(); });
    el.typeInto("frame.paint.stops.0.offset", "-2");
    el.typeInto("frame.paint.stops.0.opacity", "3");
    expect((frameOf(store).paint.stops as unknown[])[0]).toEqual({ offset: 0, color: "#000000", opacity: 1 });
  });

  test("a paint type that is not registered is shown as it is, with no fields, and nothing is written", () => {
    const { el, store, selection, labels } = setup((d) => {
      addNode(d, { id: "p-img", frame: { paint: { type: "x.future", amount: 3 }, width: 1, dash: "solid" } } as Partial<FileNode>);
    });
    const seen = labels();
    selection.set(["p-img"]);
    const select = el.control("frame.paint.type");
    expect(optionsOf(select)).toEqual(["none", "solid", "linear", "radial", "pattern", "x.future"]);
    expect(select.value).toBe("x.future");
    expect(keysOf(el).filter((k) => k.startsWith("frame.paint."))).toEqual(["frame.paint.type"]);
    expect(seen).toEqual([]);
    expect(frameOf(store).paint).toEqual({ type: "x.future", amount: 3 });
  });

  test("with several nodes selected, a paint's own field is not written onto a paint of another type", () => {
    const { el, store, selection } = setup((d) => {
      addNode(d, { id: "p-a", frame: solidFrame() } as Partial<FileNode>);
      addNode(d, { id: "p-b", frame: { ...solidFrame(), paint: linearDefaults() } } as Partial<FileNode>);
      addNode(d, { id: "p-c", frame: solidFrame() } as Partial<FileNode>);
    });
    selection.set(["p-a", "p-b", "p-c"]);
    el.typeInto("frame.paint.opacity", "0.25");
    expect(store.doc.nodes.map((n) => (n as FileNode).frame!.paint.opacity)).toEqual([0.25, undefined, 0.25]);
    // Choosing a type is for all of them, each with its own copy.
    el.control("frame.paint.type").value = "radial";
    el.control("frame.paint.type").fire("change");
    const paints = store.doc.nodes.map((n) => (n as FileNode).frame!.paint);
    expect(paints.map((p) => p.type)).toEqual(["radial", "radial", "radial"]);
    expect(paints[0]).not.toBe(paints[1]);
  });

  test("with several nodes selected, a dotted write skips a node that has nothing at the path", () => {
    const { el, store, selection } = setup((d) => {
      addNode(d, { id: "p-a", frame: solidFrame() } as Partial<FileNode>);
      addNode(d, { id: "p-b" });
    });
    selection.set(["p-a", "p-b"]);
    el.typeInto("frame.width", "3");
    expect(frameOf(store, 0).width).toBe(3);
    expect((store.doc.nodes[1] as FileNode).frame).toBeNull();
  });
});


describe("shape fields", () => {
  function shaped() {
    const s = setup((d) => { d.nodes.push(shapeNodeDefaults(d.pages[0], { id: "p-shp" }, [])); });
    s.selection.set(["p-shp"]);
    return s;
  }
  const shapeOf = (store: DocumentStore) => store.doc.nodes[0] as ShapeNode;
  const borderToggle = (el: FakeEl) => el.control("border");

  test("a rectangle shows its corner radius in mm, stored in px", () => {
    const { el, store } = shaped();
    expect(el.control("params.cornerRadius").value).toBe("0");
    el.typeInto("params.cornerRadius", "2");
    expect(shapeOf(store).params.cornerRadius).toBeCloseTo(mmToPx(2), 1);
    expect(el.control("params.cornerRadius").value).toBe("2");
  });

  test("turning the border off writes null and hides its fields; turning it on writes the default border", () => {
    const { el, store, labels } = shaped();
    const seen = labels();
    expect(borderToggle(el).checked).toBe(true);
    expect(keysOf(el)).toContain("border.width");

    borderToggle(el).checked = false;
    borderToggle(el).fire("change");
    expect(shapeOf(store).border).toBeNull();
    expect(keysOf(el).filter((k) => k.startsWith("border."))).toEqual([]);
    expect(borderToggle(el).checked).toBe(false);

    borderToggle(el).checked = true;
    borderToggle(el).fire("change");
    expect(shapeOf(store).border).toEqual(defaultBorder());
    expect(keysOf(el)).toEqual(expect.arrayContaining(["border.paint.type", "border.width", "border.dash"]));
    expect(seen).toEqual(["inspect:border", "inspect:border"]);

  });

  test("turning the border off is one undo step", () => {
    const { el, store } = shaped();
    store.commit("paint", (d) => { (d.nodes[0] as ShapeNode).border!.width = 3; });
    borderToggle(el).checked = false;
    borderToggle(el).fire("change");
    store.undo();
    expect(shapeOf(store).border).toEqual({ ...defaultBorder(), width: 3 });
    expect(borderToggle(el).checked).toBe(true);
    expect(el.control("border.width").value).toBe("3");
  });

  test("a border turned on twice on two shapes gives each its own copy", () => {
    const { el, store, selection } = setup((d) => {
      d.nodes.push(shapeNodeDefaults(d.pages[0], { id: "p-a", border: null }, []), shapeNodeDefaults(d.pages[0], { id: "p-b", border: null }, ["p-a"]));
    });
    selection.set(["p-a", "p-b"]);
    borderToggle(el).checked = true;
    borderToggle(el).fire("change");
    const [a, b] = store.doc.nodes as ShapeNode[];
    expect(a.border).toEqual(defaultBorder());
    expect(a.border).not.toBe(b.border);
  });

  test("a click on a nullable colour's row or label changes nothing: the row is not a label that would pass it to the checkbox", () => {
    const { el, store, labels } = shaped();
    const fill = el.control("fill.type");
    fill.value = "pattern";
    fill.fire("change");
    const seen = labels();
    const bg = el.control("fill.bg");
    /** The row of one field (not the paint's group row around it). */
    const rowOf = (control: FakeEl) => el.find((e) => e.hasClass("lf-field") && !e.hasClass("lf-field-group") && e.contains(control))!;
    const row = rowOf(bg);
    expect(row.tag).toBe("div");
    row.fire("click");
    row.find((e) => e.hasClass("lf-field-label"))!.fire("click");
    expect(seen).toEqual([]);
    expect(shapeOf(store).fill.bg).toBeNull();
    // Other rows are still labels.
    expect(rowOf(el.control("fill.fg")).tag).toBe("label");
  });

  test("a pattern's background is a colour that may be none: a checkbox beside it turns it on and off", () => {
    const { el, store } = shaped();
    const fill = el.control("fill.type");
    fill.value = "pattern";
    fill.fire("change");
    expect(shapeOf(store).fill).toMatchObject({ type: "pattern", bg: null });
    const bg = el.control("fill.bg");
    const toggle = el.find((e) => e.hasClass("lf-null-toggle"))!;
    expect(toggle.checked).toBe(false);
    expect(bg.disabled).toBe(true);

    toggle.checked = true;
    toggle.fire("change");
    expect(shapeOf(store).fill.bg).toBe("#000000");
    expect(bg.disabled).toBe(false);
    bg.value = "#336699";
    bg.fire("input");
    expect(shapeOf(store).fill.bg).toBe("#336699");

    toggle.checked = false;
    toggle.fire("change");
    expect(shapeOf(store).fill.bg).toBeNull();
    expect(bg.disabled).toBe(true);
    // The colour last shown stays, and comes back when the background is turned on again.
    expect(bg.value).toBe("#336699");
    toggle.checked = true;
    toggle.fire("change");
    expect(shapeOf(store).fill.bg).toBe("#336699");
  });
});

describe("connector fields", () => {
  /**
   * A rectangle `p-a` (10, 20, 100 × 50) and a connector `p-c` from its east anchor to a free point straight below its
   * centre, on a figure's store (the real connector normaliser), with the connector selected.
   */
  function connected() {
    const s = setup((d) => {
      // One page id, so two figures built this way are equal.
      d.pages[0].id = "pg-1";
      d.nodes.push({ ...shapeNodeDefaults(d.pages[0], { id: "p-a" }, []), x: 10, y: 20, width: 100, height: 50 });
      const c: ConnectorNode = {
        id: "p-c", type: "connector", page: d.pages[0].id, x: 0, y: 0, width: 0, height: 0, z: 1, rotation: 0, opacity: 1, locked: false,
        ends: [{ kind: "attached", node: "p-a", snap: "anchor", anchor: "e" }, { kind: "free", x: 60, y: 300 }],
        route: "straight", routeParams: {},
        stroke: { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" },
        caps: [{ kind: "none", size: 3 }, { kind: "arrow", size: 3 }],
      };
      d.nodes.push(c);
    }, { figure: true });
    s.selection.set(["p-c"]);
    return s;
  }
  const connectorOf = (store: DocumentStore) => store.doc.nodes[1] as ConnectorNode;

  test("no box or rotation is offered, and a cap and an end's snap are written through their numbered keys", () => {
    const { el, store } = connected();
    for (const key of ["x", "y", "width", "height", "rotation"]) expect(keysOf(el)).not.toContain(key);
    expect(keysOf(el)).toEqual(expect.arrayContaining(["opacity", "route", "caps.1.kind", "ends.0.snap"]));

    el.control("caps.1.kind").value = "circle";
    el.control("caps.1.kind").fire("change");
    expect(connectorOf(store).caps).toEqual([{ kind: "none", size: 3 }, { kind: "circle", size: 3 }]);

  });

  test("an end's snap switches from anchor to centre and back to the anchor nearest where it is drawn", () => {
    const { el, store, notices } = connected();
    const snap = () => el.control("ends.0.snap");
    snap().value = "center";
    snap().fire("change");
    // The figure's normaliser drops the anchor id of a centre-snapped end.
    expect(connectorOf(store).ends[0]).toEqual({ kind: "attached", node: "p-a", snap: "center" });
    expect(snap().value).toBe("center");

    // Snapped to the centre, the end is drawn where the line to (60, 300) leaves the box: its bottom middle, the south anchor.
    snap().value = "anchor";
    snap().fire("change");
    expect(connectorOf(store).ends[0]).toEqual({ kind: "attached", node: "p-a", snap: "anchor", anchor: "s" });
    expect(snap().value).toBe("anchor");
    expect(notices).toEqual([]);
  });

  test("a switch to anchor snap gives the document node.update gives for the same patch", () => {
    const ui = connected();
    const api = connected();
    for (const s of [ui, api]) {
      s.el.control("ends.0.snap").value = "center";
      s.el.control("ends.0.snap").fire("change");
    }
    ui.el.control("ends.0.snap").value = "anchor";
    ui.el.control("ends.0.snap").fire("change");
    const command = api.view.plugin.registries.commands.get("node.update")!;
    command.run(api.view.commandContext() as never, { id: "p-c", patch: { ends: [{ kind: "attached", node: "p-a", snap: "anchor" }, { kind: "free", x: 60, y: 300 }] } });
    expect(ui.store.doc).toEqual(api.store.doc);
  });

  test("a write node.update refuses changes nothing and is shown as a notice naming the field", () => {
    const { el, store, notices } = connected();
    const before = store.doc;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    el.control("ends.0.snap").value = "sideways";
    el.control("ends.0.snap").fire("change");
    expect(store.doc).toBe(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Link Figures: could not change Start snap: node\.update: "ends" must be two ends/);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test("choosing a route writes that route's default params, as node.update does", () => {
    const { el, store } = connected();
    el.control("route").value = "curved";
    el.control("route").fire("change");
    expect(connectorOf(store)).toMatchObject({ route: "curved", routeParams: { bend: 0.25 } });
    expect(keysOf(el)).toContain("routeParams.bend");
  });
});

describe("the inspector runs page.update", () => {
  const onePage = (d: ReturnType<typeof createDocument>) => {
    // One page id, so two documents built this way are equal.
    d.pages[0].id = "pg-1";
  };

  test("inspector page writes and page.update with the same patches give identical documents", () => {
    const ui = setup(onePage);
    const api = setup(onePage);
    const seen = ui.labels();
    ui.el.control("preset").value = "nature-double";
    ui.el.control("preset").fire("change");
    ui.el.typeInto("height", "120");
    ui.el.typeInto("margins.left", "15");
    ui.el.control("paper").value = "#f4f4f4";
    ui.el.control("paper").fire("input");
    const command = api.view.plugin.registries.commands.get("page.update")!;
    for (const patch of [{ preset: "nature-double" }, { height: 120 }, { margins: { left: 15 } }, { paper: "#f4f4f4" }]) {
      command.run(api.view.commandContext() as never, { id: "pg-1", patch });
    }
    expect(ui.store.doc).toEqual(api.store.doc);
    expect(ui.store.doc.pages[0]).toMatchObject({ preset: "custom", width: 183, height: 120, paper: "#f4f4f4" });
    expect(seen).toEqual(["inspect:preset", "inspect:height", "inspect:margins.left", "inspect:paper"]);
  });
});

describe("the inspector runs node.update", () => {
  /** Runs `node.update` as a script would, on the store of a second `setup` built the same way. */
  function viaCommand(s: ReturnType<typeof setup>, id: string, patch: Record<string, unknown>) {
    const command = s.view.plugin.registries.commands.get("node.update")!;
    command.run(s.view.commandContext() as never, { id, patch });
  }
  const twoShapes = (d: ReturnType<typeof createDocument>) => {
    // One page id, so two documents built this way are equal.
    d.pages[0].id = "pg-1";
    d.nodes.push(shapeNodeDefaults(d.pages[0], { id: "p-a" }, []), shapeNodeDefaults(d.pages[0], { id: "p-b" }, ["p-a"]));
  };

  test("an inspector write and node.update with the same patch give identical documents", () => {
    const ui = setup(twoShapes);
    const api = setup(twoShapes);
    ui.selection.set(["p-a", "p-b"]);
    ui.el.typeInto("border.width", "3");
    viaCommand(api, "p-a", { border: { width: 3 } });
    viaCommand(api, "p-b", { border: { width: 3 } });
    expect(ui.store.doc).toEqual(api.store.doc);

    const border = ui.el.control("border");
    border.checked = false;
    border.fire("change");
    viaCommand(api, "p-a", { border: null });
    viaCommand(api, "p-b", { border: null });
    expect(ui.store.doc).toEqual(api.store.doc);
    expect((ui.store.doc.nodes[0] as ShapeNode).border).toBeNull();
  });

  test("a write to several nodes is one commit, and a run of writes to one field merges into one undo step", () => {
    const { el, store, selection, labels } = setup(twoShapes);
    const seen = labels();
    selection.set(["p-a", "p-b"]);
    const before = store.doc;
    el.typeInto("border.width", "2");
    el.typeInto("border.width", "4");
    expect(seen).toEqual(["inspect:border.width", "inspect:border.width"]);
    expect(store.doc.nodes.map((n) => (n as ShapeNode).border!.width)).toEqual([4, 4]);
    store.undo();
    expect(store.doc).toEqual(before);
  });
});
