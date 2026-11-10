import { keepOffPaper, type OffPaperDrag } from "../../src/view/pointer";

vi.mock("obsidian", () => ({ Platform: { isMacOS: true }, Menu: class {}, Notice: class {}, setIcon: () => {} }));

test("keepOffPaper sets each item's last to where the drag's one offset puts it, not where it alone would slide", () => {
  // One paper at x 0-100. Item A starts left of it and runs into it moving right; item B starts far right, unhindered.
  const paper = { x: 0, y: 0, width: 100, height: 100 };
  const a = { x: -40, y: 10, width: 20, height: 20 };
  const b = { x: 300, y: 10, width: 20, height: 20 };
  const drag: OffPaperDrag = { items: [{ start: a, last: a }, { start: b, last: b }], papers: [paper] };
  const out = keepOffPaper(drag, { x: 0, y: 0 }, { x: 50, y: 0 });
  // A stops at the paper's left edge (its right side at 0): the drag is held to +20.
  expect(out).toEqual({ x: 20, y: 0 });
  // B alone would have gone +50; its last is where +20 puts it, so the next move slides it from there.
  expect(drag.items[0].last).toEqual({ x: -20, y: 10, width: 20, height: 20 });
  expect(drag.items[1].last).toEqual({ x: 320, y: 10, width: 20, height: 20 });
});
