import { focusOpenTab } from "../../src/view/open-tab";

/** A workspace with leaves showing `files` (null: a view with no file), each of view type `type`. */
function workspace(leaves: { file: object | null; type?: string }[]) {
  const made = leaves.map(({ file, type }) => ({
    view: { file, getViewType: () => type ?? "markdown" },
    openFile: vi.fn(async () => {}),
  }));
  const ws = {
    iterateAllLeaves: (fn: (leaf: (typeof made)[number]) => void) => made.forEach(fn),
    setActiveLeaf: vi.fn(),
  };
  return { ws, leaves: made };
}

describe("focusOpenTab", () => {
  const note = { path: "Notes/a.md" };

  test("focuses the first tab that shows the note in a Markdown view, and takes it to the subpath", () => {
    const { ws, leaves } = workspace([{ file: { path: "x.md" } }, { file: note, type: "lnkfig" }, { file: note }, { file: note }]);
    expect(focusOpenTab(ws as never, note as never, "#Legend")).toBe(true);
    expect(ws.setActiveLeaf).toHaveBeenCalledWith(leaves[2], { focus: true });
    expect(leaves[2].openFile).toHaveBeenCalledWith(note, { active: true, eState: { subpath: "#Legend" } });
    expect(leaves[3].openFile).not.toHaveBeenCalled();
  });

  test("a whole note: focused, and left where its tab has it", () => {
    const { ws, leaves } = workspace([{ file: note }]);
    expect(focusOpenTab(ws as never, note as never, "")).toBe(true);
    expect(ws.setActiveLeaf).toHaveBeenCalledWith(leaves[0], { focus: true });
    expect(leaves[0].openFile).not.toHaveBeenCalled();
  });

  test("false, touching nothing, when no tab shows the note", () => {
    const { ws, leaves } = workspace([{ file: { path: "Notes/a.md" } }, { file: null }]);
    expect(focusOpenTab(ws as never, note as never, "")).toBe(false);
    expect(ws.setActiveLeaf).not.toHaveBeenCalled();
    expect(leaves[0].openFile).not.toHaveBeenCalled();
  });
});
