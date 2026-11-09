import { EditorDragTracker, listenForEditorDrags } from "../../src/links/editor-drag";

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
