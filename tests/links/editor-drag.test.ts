import { EditorDragTracker, PopoutDragListeners, listenForEditorDrags } from "../../src/links/editor-drag";

/** An element that is inside the elements `ancestors` lists (its own `closest` and each container's `contains`). */
function element(inEditor: boolean) {
  return { closest: (selector: string) => (selector === ".cm-editor" && inEditor ? {} : null) };
}

function leafWith(target: unknown) {
  return { view: { file: { path: "Notes/a.md" }, containerEl: { contains: (el: unknown) => el === target } } };
}

describe("EditorDragTracker", () => {
  test("a drag that starts in a Markdown view's editor records that view; dragend clears it", () => {
    const target = element(true);
    const leaf = leafWith(target);
    const tracker = new EditorDragTracker(() => [leafWith(element(true)), leaf]);
    tracker.dragStart(target);
    expect(tracker.source).toBe(leaf.view);
    tracker.clear();
    expect(tracker.source).toBeNull();
  });

  test("a drag that starts outside an editor (or in no Markdown view) records nothing, and clears an old record", () => {
    const inEditor = element(true);
    const tracker = new EditorDragTracker(() => [leafWith(inEditor)]);
    tracker.dragStart(inEditor);
    tracker.dragStart(element(false));
    expect(tracker.source).toBeNull();
    tracker.dragStart(inEditor);
    tracker.dragStart(element(true));
    expect(tracker.source).toBeNull();
    tracker.dragStart(null);
    expect(tracker.source).toBeNull();
  });
});

describe("EditorDragTracker: what a drag's target can be", () => {
  test("a Text node (a selection dragged in Chromium) is read through its parent element", () => {
    const parent = element(true);
    const text = { nodeType: 3, parentElement: parent };
    const leaf = { view: { containerEl: { contains: (el: unknown) => el === parent } } };
    const tracker = new EditorDragTracker(() => [leaf]);
    tracker.dragStart(text);
    expect(tracker.source).toBe(leaf.view);
    tracker.dragStart({ nodeType: 3, parentElement: null });
    expect(tracker.source).toBeNull();
  });
});

describe("EditorDragTracker: an embed dragged out of an editor (Live Preview's image widget)", () => {
  /** An element inside an embed (`.internal-embed`, here `embedEl`) inside an editor. */
  function inEmbed(embedEl: unknown) {
    return { closest: (selector: string) => (selector === ".cm-editor" ? {} : selector === ".internal-embed" ? embedEl : null) };
  }
  /** A Markdown view holding `target`, whose editor's CodeMirror view places `embedEl` at `offset`. */
  function viewWith(target: unknown, editor: unknown) {
    return { view: { containerEl: { contains: (el: unknown) => el === target }, editor } };
  }
  const lineOf = (offset: number) => ({ line: Math.floor(offset / 10), ch: offset % 10 });

  test("records the embed's place in the note, through the editor's CodeMirror view (posAtDOM) and offsetToPos", () => {
    const embedEl = { name: "embed" };
    const img = inEmbed(embedEl);
    const posAtDOM = vi.fn((el: unknown) => (el === embedEl ? 42 : -1));
    const leaf = viewWith(img, { cm: { posAtDOM }, offsetToPos: lineOf });
    const tracker = new EditorDragTracker(() => [leaf]);
    tracker.dragStart(img);
    expect(tracker.source).toBe(leaf.view);
    expect(tracker.embed).toEqual({ line: 4, offset: 42 });
    tracker.clear();
    expect(tracker.embed).toBeNull();
  });

  test("a drag of selected text records no embed; a new drag clears an old embed", () => {
    const embedEl = {};
    const img = inEmbed(embedEl);
    const text = element(true);
    const editor = { cm: { posAtDOM: () => 42 }, offsetToPos: lineOf };
    const tracker = new EditorDragTracker(() => [viewWith(img, editor), viewWith(text, editor)]);
    tracker.dragStart(img);
    expect(tracker.embed).not.toBeNull();
    tracker.dragStart(text);
    expect(tracker.embed).toBeNull();
    expect(tracker.source).not.toBeNull();
  });

  test.each<[string, unknown]>([
    ["no CodeMirror view", {}],
    ["posAtDOM that throws", { cm: { posAtDOM: () => { throw new Error("not in the view"); } }, offsetToPos: lineOf }],
    ["posAtDOM that gives no number", { cm: { posAtDOM: () => undefined }, offsetToPos: lineOf }],
    ["no offsetToPos", { cm: { posAtDOM: () => 42 } }],
    ["offsetToPos that throws", { cm: { posAtDOM: () => 42 }, offsetToPos: () => { throw new Error("past the end"); } }],
  ])("with %s, the view is still recorded, without the embed's place", (_what, editor) => {
    const img = inEmbed({});
    const leaf = viewWith(img, editor);
    const tracker = new EditorDragTracker(() => [leaf]);
    tracker.dragStart(img);
    expect(tracker.source).toBe(leaf.view);
    expect(tracker.embed).toEqual({ line: null, offset: null });
  });
});

describe("listenForEditorDrags", () => {
  /** A document that keeps its listeners, so a test can fire them and see them removed. */
  function fakeDoc() {
    const listeners: { type: string; fn: (ev: { target: unknown }) => void; capture: boolean }[] = [];
    return {
      listeners,
      addEventListener: (type: string, fn: (ev: { target: unknown }) => void, options?: { capture?: boolean }) => listeners.push({ type, fn, capture: options?.capture === true }),
      removeEventListener: (type: string, fn: unknown) => {
        const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      fire(type: string, target: unknown = null) {
        for (const l of listeners.filter((x) => x.type === type)) l.fn({ target });
      },
    };
  }

  test("dragstart (capture) records, dragend (capture) and drop (bubbling) clear; the returned function removes them all", () => {
    const target = element(true);
    const leaf = leafWith(target);
    const tracker = new EditorDragTracker(() => [leaf]);
    const doc = fakeDoc();
    const off = listenForEditorDrags(doc as unknown as Document, tracker);
    expect(doc.listeners.map((l) => [l.type, l.capture])).toEqual([["dragstart", true], ["dragend", true], ["drop", false]]);
    doc.fire("dragstart", target);
    expect(tracker.source).toBe(leaf.view);
    doc.fire("drop");
    expect(tracker.source).toBeNull();
    doc.fire("dragstart", target);
    doc.fire("dragend");
    expect(tracker.source).toBeNull();
    off();
    expect(doc.listeners).toEqual([]);
  });
});

describe("PopoutDragListeners", () => {
  const main = { name: "main" } as unknown as Document;
  const popA = { name: "a" } as unknown as Document;
  const popB = { name: "b" } as unknown as Document;
  const leafIn = (doc: Document | undefined) => ({ view: { containerEl: { ownerDocument: doc } } });

  function setup() {
    const listening: Document[] = [];
    const removed: Document[] = [];
    const popouts = new PopoutDragListeners(main, (doc) => {
      listening.push(doc);
      return () => void removed.push(doc);
    });
    return { popouts, listening, removed };
  }

  test("at load: listens once per popout document the open leaves are in, never on the main document", () => {
    const { popouts, listening } = setup();
    popouts.addLeaves([leafIn(main), leafIn(popA), leafIn(popA), leafIn(popB), leafIn(undefined), {}]);
    expect(listening).toEqual([popA, popB]);
    // A window-open for a popout already listened to adds nothing.
    popouts.add(popA);
    expect(listening).toEqual([popA, popB]);
  });

  test("a closed popout's listeners are removed; on unload, all of them", () => {
    const { popouts, listening, removed } = setup();
    popouts.add(popA);
    popouts.add(popB);
    popouts.remove(popA);
    expect(removed).toEqual([popA]);
    popouts.add(popA);
    expect(listening).toEqual([popA, popB, popA]);
    popouts.clear();
    expect(removed).toEqual([popA, popB, popA]);
    popouts.clear();
    expect(removed).toHaveLength(3);
  });
});
