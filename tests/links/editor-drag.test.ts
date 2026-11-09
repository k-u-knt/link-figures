import { EditorDragTracker } from "../../src/links/editor-drag";

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
