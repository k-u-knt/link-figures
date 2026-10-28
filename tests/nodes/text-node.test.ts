import { DEFAULT_FONT } from "../../src/constants";
import { createDocument, textNodeDefaults } from "../../src/model/defaults";
import { DocumentStore } from "../../src/model/store";
import type { TextNode } from "../../src/model/types";
import { CURATED_FONT_OPTIONS, textNodeSvg, textNodeType } from "../../src/nodes/text-node";
import { textNodeSvg as pureTextNodeSvg } from "../../src/nodes/text-node-svg";
import { readValue } from "../../src/view/page-fields";

// There is no DOM in this suite. This is just enough of an element, a document and a selection to drive the renderer:
// focus moves blur to the element that had it, as in a browser, and `innerText` is whatever the test "typed".
class FakeSelection {
  anchorNode: FakeEl | null = null;
  removeAllRanges(): void {
    this.anchorNode = null;
  }
  addRange(range: { node: FakeEl }): void {
    this.anchorNode = range.node;
  }
}

class FakeDoc {
  activeElement: FakeEl | null = null;
  selection = new FakeSelection();
  defaultView = { getSelection: () => this.selection };
  createRange() {
    return { node: null as FakeEl | null, selectNodeContents(node: FakeEl) { this.node = node; } };
  }
}

class FakeEl {
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  textContent = "";
  innerText = "";
  cls: string[] = [];
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  constructor(readonly ownerDocument: FakeDoc = new FakeDoc()) {}

  set innerHTML(_: string) {
    throw new Error("text must not be set as markup");
  }

  createDiv(info: { cls?: string } = {}): FakeEl {
    const el = new FakeEl(this.ownerDocument);
    if (info.cls) el.cls = [info.cls];
    el.parent = this;
    this.children.push(el);
    return el;
  }
  hasClass(name: string): boolean {
    return this.cls.includes(name);
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, ev: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  focus(): void {
    const before = this.ownerDocument.activeElement;
    this.ownerDocument.activeElement = this;
    if (before && before !== this) before.fire("blur");
  }
  blur(): void {
    if (this.ownerDocument.activeElement !== this) return;
    this.ownerDocument.activeElement = null;
    this.fire("blur");
  }
  contains(other: FakeEl): boolean {
    return other === this || this.children.some((c) => c.contains(other));
  }
  closest(selector: string): FakeEl | null {
    for (let el: FakeEl | null = this; el; el = el.parent) if (selector.startsWith(".") && el.hasClass(selector.slice(1))) return el;
    return null;
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

const asEl = (el: FakeEl) => el as unknown as HTMLElement;

const base = (): TextNode => ({ ...textNodeDefaults(createDocument("a4-portrait").pages[0], { id: "p-text" }, []), x: 10, y: 20, width: 100, height: 40 });

/** A figure view's worth: a store, with the renderer following it the way `NodeHost` makes it. */
function setup(over: Partial<TextNode> = {}, view: { readOnly?: boolean } = {}) {
  const doc = createDocument("a4-portrait");
  doc.nodes.push({ ...base(), ...over });
  const store = new DocumentStore(doc);
  const component = { store, readOnly: view.readOnly ?? false };
  const stage = new FakeEl();
  stage.cls.push("lf-stage");
  const pageNodes = stage.createDiv({ cls: "lf-page-nodes" });
  const renderer = textNodeType.mount(doc.nodes[0] as TextNode, asEl(pageNodes), { component } as never);
  const node = (): TextNode | undefined => store.doc.nodes.find((n) => n.id === "p-text") as TextNode | undefined;
  store.subscribe(() => {
    const current = node();
    if (current) renderer.update(current);
  });
  const nodeEl = pageNodes.children[0];
  const text = nodeEl.children[0].children[0];
  /** What the user does: types into the element that is being edited. */
  const type = (value: string) => {
    text.innerText = value;
    text.textContent = value;
  };
  return { store, stage, renderer, nodeEl, text, node, component, type };
}

describe("the type", () => {
  test("is 'text', named Text, with the type icon, and bounds are the node's rectangle", () => {
    expect([textNodeType.type, textNodeType.name, textNodeType.icon]).toEqual(["text", "Text", "type"]);
    expect(textNodeType.bounds(base())).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  test("re-exports the pure SVG function and uses it for export", () => {
    expect(textNodeSvg).toBe(pureTextNodeSvg);
    const ctx = { doc: createDocument("a4-portrait"), page: createDocument("a4-portrait").pages[0], assets: new Map(), defs: [], warnings: [], uid: (p: string) => p };
    expect(textNodeType.toSvg(base(), ctx)).toBe(pureTextNodeSvg(base(), ctx));
  });

  test("the font choices are the curated fonts", () => {
    expect(CURATED_FONT_OPTIONS).toEqual([
      { value: "Arial", label: "Arial" },
      { value: "Helvetica", label: "Helvetica" },
      { value: "Times New Roman", label: "Times New Roman" },
      { value: "Calibri", label: "Calibri" },
      { value: "Georgia", label: "Georgia" },
      { value: "Courier New", label: "Courier New" },
    ]);
  });

  test("the inspector offers the seven font fields, in order, and each key reads a value off a text node", () => {
    const fields = textNodeType.inspector(base());
    expect(fields.map((f) => `${f.kind}:${f.key}`)).toEqual([
      "select:font.family",
      "number:font.size",
      "select:font.weight",
      "toggle:font.italic",
      "color:font.color",
      "select:font.align",
      "number:font.lineHeight",
    ]);
    expect(fields[0].options).toBe(CURATED_FONT_OPTIONS);
    expect(fields[1]).toMatchObject({ unit: "pt", min: 1, step: 0.5 });
    expect(fields[2].options!.map((o) => o.value)).toEqual(["normal", "bold"]);
    expect(fields[5].options!.map((o) => o.value)).toEqual(["left", "center", "right"]);
    expect(fields[6]).toMatchObject({ min: 0.5, step: 0.1 });
    for (const field of fields) expect(readValue(base(), field.key)).toBeDefined();
  });
});

describe("mount and update", () => {
  test("draws .lf-node > .lf-node-body > .lf-text with the box, the font and the text", () => {
    const { nodeEl, text } = setup({ z: 3, text: "Panel A" });
    expect(nodeEl.hasClass("lf-node")).toBe(true);
    expect(nodeEl.children[0].hasClass("lf-node-body")).toBe(true);
    expect(text.hasClass("lf-text")).toBe(true);
    expect(nodeEl.style).toMatchObject({ left: "10px", top: "20px", width: "100px", height: "40px", zIndex: "3", transform: "", opacity: "" });
    expect(text.style).toMatchObject({
      fontFamily: "Arial",
      fontSize: "7pt",
      fontWeight: "normal",
      fontStyle: "normal",
      color: "#000000",
      textAlign: "left",
      lineHeight: "1.2",
      whiteSpace: "pre-wrap",
      overflow: "hidden",
    });
    expect(text.textContent).toBe("Panel A");
  });

  test("update redraws the box, the font and the text", () => {
    const { store, nodeEl, text } = setup();
    store.commit("restyle", (d) => {
      const n = d.nodes[0] as TextNode;
      n.x = 50;
      n.rotation = 90;
      n.opacity = 0.5;
      n.text = "B\nC";
      n.font = { ...DEFAULT_FONT, family: "Georgia", size: 8, weight: "bold", italic: true, color: "#ff0000", align: "right", lineHeight: 1.5 };
    });
    expect(nodeEl.style).toMatchObject({ left: "50px", transform: "rotate(90deg)", opacity: "0.5" });
    expect(text.style).toMatchObject({
      fontFamily: "Georgia",
      fontSize: "8pt",
      fontWeight: "bold",
      fontStyle: "italic",
      color: "#ff0000",
      textAlign: "right",
      lineHeight: "1.5",
    });
    expect(text.textContent).toBe("B\nC");
  });

  test("text is never set as markup", () => {
    const { store, text } = setup({ text: "<b>x</b> & y" });
    expect(text.textContent).toBe("<b>x</b> & y");
    store.commit("t", (d) => { (d.nodes[0] as TextNode).text = "<i>z</i>"; });
    expect(text.textContent).toBe("<i>z</i>");
  });

  test("unmount removes the element", () => {
    const { stage, renderer } = setup();
    renderer.unmount();
    expect(stage.children[0].children).toEqual([]);
  });
});

describe("editing", () => {
  test("double-click makes the text plain-text editable, focuses it and selects all of it", () => {
    const { text } = setup();
    expect(text.attrs.has("contenteditable")).toBe(false);
    text.fire("dblclick");
    expect(text.attrs.get("contenteditable")).toBe("plaintext-only");
    expect(text.ownerDocument.activeElement).toBe(text);
    expect(text.ownerDocument.selection.anchorNode).toBe(text);
  });

  test("a double-click while editing is the browser's (a word is selected), not another select-all", () => {
    const { text } = setup();
    text.fire("dblclick");
    text.ownerDocument.selection.anchorNode = null;
    text.fire("dblclick");
    expect(text.ownerDocument.selection.anchorNode).toBeNull();
  });

  test("losing focus commits what was typed as one 'text' edit and leaves edit mode", () => {
    const { store, text, node, type } = setup({ text: "Text" });
    text.fire("dblclick");
    type("A");
    text.blur();

    expect(node()!.text).toBe("A");
    expect(text.textContent).toBe("A");
    expect(text.attrs.has("contenteditable")).toBe(false);
    expect(text.ownerDocument.selection.anchorNode).toBeNull();
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(node()!.text).toBe("Text");
    expect(text.textContent).toBe("Text");
  });

  test("a click on the stage takes the focus, which commits", () => {
    const { stage, text, node, type } = setup();
    text.fire("dblclick");
    type("A");
    // What the pointer controller does on a press.
    stage.focus();
    expect(node()!.text).toBe("A");
  });

  test("line breaks typed are kept, and a Windows line ending is one break", () => {
    const { text, node, type } = setup();
    text.fire("dblclick");
    type("a\r\nb\n\nc");
    text.blur();
    expect(node()!.text).toBe("a\nb\n\nc");
  });

  test("leaving without typing anything commits nothing", () => {
    const { store, text, type } = setup({ text: "Text" });
    text.fire("dblclick");
    type("Text");
    text.blur();
    expect(store.canUndo()).toBe(false);
  });

  test("Escape puts the previous text back, leaves edit mode without a commit, and is not passed on to the stage", () => {
    const { stage, store, text, node, type } = setup({ text: "Text" });
    text.fire("dblclick");
    type("oops");
    const ev = { key: "Escape", isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    text.fire("keydown", ev);

    expect(text.textContent).toBe("Text");
    expect(text.attrs.has("contenteditable")).toBe(false);
    expect(node()!.text).toBe("Text");
    expect(store.canUndo()).toBe(false);
    expect(ev.stopPropagation).toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
    // The keys are the stage's again; the focus moving there is not a blur that commits anything.
    expect(text.ownerDocument.activeElement).toBe(stage);
    expect(store.canUndo()).toBe(false);
  });

  test("other keys, Escape outside an edit, and Escape while composing are left alone", () => {
    const { text, type } = setup({ text: "Text" });
    const keys = (ev: object) => ({ isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...ev });
    const outside = keys({ key: "Escape" });
    text.fire("keydown", outside);
    expect(outside.stopPropagation).not.toHaveBeenCalled();

    text.fire("dblclick");
    type("x");
    for (const ev of [keys({ key: "Enter" }), keys({ key: "a" }), keys({ key: "Escape", isComposing: true })]) {
      text.fire("keydown", ev);
      expect(ev.stopPropagation).not.toHaveBeenCalled();
    }
    expect(text.attrs.get("contenteditable")).toBe("plaintext-only");
    expect(text.textContent).toBe("x");
  });

  test("a change from elsewhere while editing does not overwrite what is being typed, but the font and box follow", () => {
    const { store, text, nodeEl, node, type } = setup({ text: "Text" });
    text.fire("dblclick");
    type("typing");
    store.commit("elsewhere", (d) => {
      const n = d.nodes[0] as TextNode;
      n.text = "changed";
      n.x = 99;
      n.font.size = 12;
    });
    expect(text.textContent).toBe("typing");
    expect(nodeEl.style.left).toBe("99px");
    expect(text.style.fontSize).toBe("12pt");

    text.blur();
    // The user's typing wins over the change it did not know about.
    expect(node()!.text).toBe("typing");
  });

  test("an undo from elsewhere while editing is not put back by leaving without typing", () => {
    const { store, text, node } = setup({ text: "Text" });
    store.commit("text", (d) => { (d.nodes[0] as TextNode).text = "First"; });
    text.fire("dblclick");
    // `text.innerText` stays as it was when editing began: nothing was typed.
    text.innerText = "First";
    store.undo();
    expect(node()!.text).toBe("Text");
    expect(text.textContent).toBe("First");

    text.blur();
    expect(node()!.text).toBe("Text");
    expect(text.textContent).toBe("Text");
    expect(store.canUndo()).toBe(false);
  });

  test("a node removed while it is edited: the blur does not throw and brings nothing back", () => {
    const { store, text } = setup();
    text.fire("dblclick");
    text.innerText = "typed";
    store.commit("delete", (d) => { d.nodes = []; });
    expect(() => text.blur()).not.toThrow();
    expect(store.doc.nodes).toEqual([]);
    expect(text.textContent).toBe("Text");
  });

  test("unmounting while editing drops the edit: the blur that follows commits nothing", () => {
    const { store, renderer, text } = setup();
    text.fire("dblclick");
    text.innerText = "typed";
    renderer.unmount();
    text.blur();
    expect(store.canUndo()).toBe(false);
    expect(store.doc.nodes[0]).toMatchObject({ text: "Text" });
  });

  test("it edits through the view's current store, not the one it was made with", () => {
    const { component, text, type } = setup();
    const swapped = createDocument("a4-portrait");
    swapped.nodes.push(base());
    component.store = new DocumentStore(swapped);
    text.fire("dblclick");
    type("A");
    text.blur();
    expect((swapped.nodes[0] as TextNode).text).toBe("Text");
    expect((component.store.doc.nodes[0] as TextNode).text).toBe("A");
  });

  test("lf-activate on the node's element (what the pointer controller sends for a double-click) enters edit mode like a dblclick", () => {
    const { nodeEl, text, node, type } = setup({ text: "Text" });
    nodeEl.fire("lf-activate");
    expect(text.attrs.get("contenteditable")).toBe("plaintext-only");
    expect(text.ownerDocument.activeElement).toBe(text);
    expect(text.ownerDocument.selection.anchorNode).toBe(text);

    type("A");
    text.blur();
    expect(node()!.text).toBe("A");
    expect(text.attrs.has("contenteditable")).toBe(false);
  });

  test("both a dblclick on the text and lf-activate for the same double-click start one edit, not two", () => {
    const { nodeEl, text, type } = setup({ text: "Text" });
    text.fire("dblclick");
    type("typed");
    nodeEl.fire("lf-activate");
    // The second activation found it editing already: nothing typed was lost, nothing was selected afresh.
    expect(text.textContent).toBe("typed");
    expect(text.attrs.get("contenteditable")).toBe("plaintext-only");
  });

  test("lf-activate is refused for a locked node, a read-only view and a renderer with no view, as a dblclick is", () => {
    for (const made of [setup({ locked: true }), setup({}, { readOnly: true })]) {
      made.nodeEl.fire("lf-activate");
      expect(made.text.attrs.has("contenteditable")).toBe(false);
      expect(made.text.ownerDocument.activeElement).toBeNull();
    }
    const stage = new FakeEl();
    textNodeType.mount(base(), asEl(stage), { component: {} } as never);
    stage.children[0].fire("lf-activate");
    expect(stage.children[0].children[0].children[0].attrs.has("contenteditable")).toBe(false);
  });

  test("a locked node, a read-only view and a renderer with no view to edit through do not enter edit mode", () => {
    for (const made of [setup({ locked: true }), setup({}, { readOnly: true })]) {
      made.text.fire("dblclick");
      expect(made.text.attrs.has("contenteditable")).toBe(false);
      expect(made.text.ownerDocument.activeElement).toBeNull();
    }
    const stage = new FakeEl();
    textNodeType.mount(base(), asEl(stage), { component: {} } as never);
    const text = stage.children[0].children[0].children[0];
    text.fire("dblclick");
    expect(text.attrs.has("contenteditable")).toBe(false);
  });
});
