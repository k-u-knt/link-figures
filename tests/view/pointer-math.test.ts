import { MIN_NODE_PX } from "../../src/constants";
import { dragRect, HANDLES, handleAt, hitAll, hitTest, marqueeSelect, nodeSizePx, rectFromPoints, resizeRect, roundPx } from "../../src/view/pointer-math";

const r = { x: 10, y: 10, width: 100, height: 50 };
test("se handle grows width and height", () => expect(resizeRect(r, "se", 20, 10, { keepAspect: false, min: 1 })).toEqual({ x: 10, y: 10, width: 120, height: 60 }));
test("nw handle moves origin", () => expect(resizeRect(r, "nw", 10, 5, { keepAspect: false, min: 1 })).toEqual({ x: 20, y: 15, width: 90, height: 45 }));
test("dragging past the opposite edge clamps at min and never inverts", () => { const out = resizeRect(r, "e", -500, 0, { keepAspect: false, min: 4 }); expect(out.width).toBe(4); expect(out.x).toBe(10); });
test("keepAspect on se follows the width", () => expect(resizeRect(r, "se", 100, 0, { keepAspect: true, min: 1 })).toEqual({ x: 10, y: 10, width: 200, height: 100 }));
test("marquee selects intersecting unlocked nodes", () => { const items = [{ id: "a", rect: r, locked: false }, { id: "b", rect: { x: 500, y: 500, width: 10, height: 10 }, locked: false }, { id: "c", rect: r, locked: true }]; expect(marqueeSelect(items, { x: 0, y: 0, width: 50, height: 50 })).toEqual(["a"]); });
test("hitTest picks the topmost", () => { const items = [{ id: "low", rect: r, z: 0, locked: false }, { id: "high", rect: r, z: 5, locked: false }]; expect(hitTest(items, { x: 20, y: 20 })).toBe("high"); expect(hitTest(items, { x: 0, y: 0 })).toBeNull(); });
test("handleAt finds the corner within tolerance", () => { expect(handleAt(r, { x: 111, y: 61 }, 4)).toBe("se"); expect(handleAt(r, { x: 60, y: 9 }, 4)).toBe("n"); expect(handleAt(r, { x: 60, y: 30 }, 4)).toBeNull(); });

// Beyond the brief: the remaining behaviour.
const free = { keepAspect: false, min: 1 };
const keep = { keepAspect: true, min: 1 };

test("HANDLES lists the eight handles once each", () => {
  expect([...HANDLES].sort()).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
});

test("edge handles move one edge only", () => {
  expect(resizeRect(r, "e", 15, 99, free)).toEqual({ x: 10, y: 10, width: 115, height: 50 });
  expect(resizeRect(r, "w", 15, 99, free)).toEqual({ x: 25, y: 10, width: 85, height: 50 });
  expect(resizeRect(r, "n", 99, 8, free)).toEqual({ x: 10, y: 18, width: 100, height: 42 });
  expect(resizeRect(r, "s", 99, 8, free)).toEqual({ x: 10, y: 10, width: 100, height: 58 });
});

test("ne and sw corners move the right pair of edges", () => {
  expect(resizeRect(r, "ne", 10, -5, free)).toEqual({ x: 10, y: 5, width: 110, height: 55 });
  expect(resizeRect(r, "sw", -10, 5, free)).toEqual({ x: 0, y: 10, width: 110, height: 55 });
});

test("a zero drag returns the start rectangle", () => {
  for (const h of HANDLES) expect(resizeRect(r, h, 0, 0, free)).toEqual(r);
  for (const h of HANDLES) expect(resizeRect(r, h, 0, 0, keep)).toEqual(r);
});

test("dragging a west or north handle past the opposite edge pins the opposite edge", () => {
  const w = resizeRect(r, "w", 500, 0, { keepAspect: false, min: 4 });
  expect(w).toEqual({ x: 106, y: 10, width: 4, height: 50 }); // right edge stays at 110
  const n = resizeRect(r, "n", 0, 500, { keepAspect: false, min: 4 });
  expect(n).toEqual({ x: 10, y: 56, width: 100, height: 4 }); // bottom edge stays at 60
  const nw = resizeRect(r, "nw", 500, 500, { keepAspect: false, min: 4 });
  expect(nw).toEqual({ x: 106, y: 56, width: 4, height: 4 });
});

test("a rectangle below min grows to it on the dragged axis only", () => {
  const tiny = { x: 0, y: 0, width: 2, height: 2 };
  expect(resizeRect(tiny, "e", 0, 0, { keepAspect: false, min: 4 })).toEqual({ x: 0, y: 0, width: 4, height: 2 });
});

test("keepAspect on a corner scales about the opposite corner", () => {
  // nw: the south-east corner (110, 60) stays put; width follows the drag.
  const out = resizeRect(r, "nw", -100, 0, keep);
  expect(out).toEqual({ x: -90, y: -40, width: 200, height: 100 });
  expect(out.x + out.width).toBe(110);
  expect(out.y + out.height).toBe(60);
  const ne = resizeRect(r, "ne", 100, 0, keep);
  expect(ne).toEqual({ x: 10, y: -40, width: 200, height: 100 }); // the south-west corner (10, 60) stays put
  const sw = resizeRect(r, "sw", -100, 0, keep);
  expect(sw).toEqual({ x: -90, y: 10, width: 200, height: 100 }); // the north-east corner (110, 10) stays put
});

test("keepAspect on a corner ignores the vertical component of the drag", () => {
  expect(resizeRect(r, "se", 50, 999, keep)).toEqual({ x: 10, y: 10, width: 150, height: 75 });
});

test("keepAspect on an east or west edge scales height about the vertical centre", () => {
  expect(resizeRect(r, "e", 100, 0, keep)).toEqual({ x: 10, y: -15, width: 200, height: 100 });
  expect(resizeRect(r, "w", -100, 0, keep)).toEqual({ x: -90, y: -15, width: 200, height: 100 });
});

test("keepAspect on a north or south edge scales width about the horizontal centre", () => {
  expect(resizeRect(r, "s", 0, 50, keep)).toEqual({ x: -40, y: 10, width: 200, height: 100 });
  expect(resizeRect(r, "n", 0, -50, keep)).toEqual({ x: -40, y: -40, width: 200, height: 100 });
});

test("keepAspect clamps at min on the limiting axis and keeps the ratio", () => {
  const out = resizeRect(r, "se", -500, 0, { keepAspect: true, min: 10 });
  expect(out.width).toBeCloseTo(20); // height 10 is the limit, so width 20
  expect(out.height).toBeCloseTo(10);
  expect(out.x).toBe(10);
  expect(out.y).toBe(10);
  const nw = resizeRect(r, "nw", 500, 0, { keepAspect: true, min: 10 });
  expect(nw.width).toBeCloseTo(20);
  expect(nw.height).toBeCloseTo(10);
  expect(nw.x + nw.width).toBeCloseTo(110);
  expect(nw.y + nw.height).toBeCloseTo(60);
});

test("resizeRect never produces a negative or non-finite size", () => {
  for (const h of HANDLES) {
    for (const opts of [free, keep]) {
      for (const [dx, dy] of [[-1e6, -1e6], [1e6, 1e6], [-1e6, 1e6], [1e6, -1e6], [0, 0]] as const) {
        const out = resizeRect(r, h, dx, dy, { ...opts, min: 3 });
        expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true);
        expect(out.width).toBeGreaterThanOrEqual(3 - 1e-9);
        expect(out.height).toBeGreaterThanOrEqual(3 - 1e-9);
      }
    }
  }
});

test("a zero-height rectangle does not break keepAspect", () => {
  const flat = { x: 0, y: 0, width: 100, height: 0 };
  const out = resizeRect(flat, "se", 20, 5, { keepAspect: true, min: 2 });
  for (const v of Object.values(out)) expect(Number.isFinite(v)).toBe(true);
});

test("marquee selects a node it merely overlaps, and none it only touches", () => {
  const items = [{ id: "a", rect: r, locked: false }];
  expect(marqueeSelect(items, { x: 100, y: 40, width: 50, height: 50 })).toEqual(["a"]);
  expect(marqueeSelect(items, { x: 110, y: 10, width: 50, height: 50 })).toEqual([]);
});

test("marquee keeps the items' order and returns nothing for no items", () => {
  const items = [
    { id: "x", rect: r, locked: false },
    { id: "y", rect: { x: 20, y: 20, width: 5, height: 5 }, locked: false },
  ];
  expect(marqueeSelect(items, { x: 0, y: 0, width: 200, height: 200 })).toEqual(["x", "y"]);
  expect(marqueeSelect([], { x: 0, y: 0, width: 200, height: 200 })).toEqual([]);
});

test("hitTest: a locked item is hit like any other, and the top one wins locked or not", () => {
  const unlocked = { id: "unlocked", rect: r, z: 0, locked: false };
  // Alone, a locked item is found, so that it can be selected and unlocked.
  expect(hitTest([{ id: "locked", rect: r, z: 0, locked: true }], { x: 20, y: 20 })).toBe("locked");
  // Locked over unlocked by z: the locked one is on top, so it is the one hit.
  expect(hitTest([unlocked, { id: "locked", rect: r, z: 9, locked: true }], { x: 20, y: 20 })).toBe("locked");
  // Unlocked over locked: the unlocked one.
  expect(hitTest([{ id: "locked", rect: r, z: 0, locked: true }, { ...unlocked, z: 9 }], { x: 20, y: 20 })).toBe("unlocked");
  // A locked item has the same inclusive edges as any other, and a miss is still a miss.
  const locked = [{ id: "locked", rect: r, z: 0, locked: true }];
  expect(hitTest(locked, { x: 10, y: 10 })).toBe("locked");
  expect(hitTest(locked, { x: 110, y: 60 })).toBe("locked");
  expect(hitTest(locked, { x: 111, y: 60 })).toBeNull();
});

test("hitTest breaks a z tie in favour of the later item", () => {
  const items = [{ id: "first", rect: r, z: 3, locked: false }, { id: "second", rect: r, z: 3, locked: false }];
  expect(hitTest(items, { x: 20, y: 20 })).toBe("second");
});

test("handleAt finds every handle at its position", () => {
  const cx = 60, cy = 35;
  expect(handleAt(r, { x: 10, y: 10 }, 4)).toBe("nw");
  expect(handleAt(r, { x: 110, y: 10 }, 4)).toBe("ne");
  expect(handleAt(r, { x: 10, y: 60 }, 4)).toBe("sw");
  expect(handleAt(r, { x: 110, y: 60 }, 4)).toBe("se");
  expect(handleAt(r, { x: cx, y: 10 }, 4)).toBe("n");
  expect(handleAt(r, { x: cx, y: 60 }, 4)).toBe("s");
  expect(handleAt(r, { x: 10, y: cy }, 4)).toBe("w");
  expect(handleAt(r, { x: 110, y: cy }, 4)).toBe("e");
});

test("handleAt prefers a corner over an edge when the two are within tolerance of a tiny rectangle", () => {
  const tiny = { x: 0, y: 0, width: 4, height: 4 };
  expect(handleAt(tiny, { x: 4, y: 4 }, 4)).toBe("se");
  expect(handleAt(tiny, { x: 0, y: 0 }, 4)).toBe("nw");
});

test("handleAt is null beyond the tolerance", () => {
  expect(handleAt(r, { x: 116, y: 66 }, 4)).toBeNull();
  expect(handleAt(r, { x: 60, y: 3 }, 4)).toBeNull();
});

test("rectFromPoints orders the corners whichever way the drag went", () => {
  expect(rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, width: 40, height: 35 });
  expect(rectFromPoints({ x: 10, y: 40 }, { x: 50, y: 5 })).toEqual({ x: 10, y: 5, width: 40, height: 35 });
  expect(rectFromPoints({ x: 7, y: 7 }, { x: 7, y: 7 })).toEqual({ x: 7, y: 7, width: 0, height: 0 });
});

test("roundPx keeps hundredths", () => {
  expect(roundPx(12.3456789)).toBe(12.35);
  expect(roundPx(-0.004)).toBe(-0);
  expect(roundPx(3)).toBe(3);
});

// A node can be dragged off its page, so a hit is looked for among the nodes of every page.
test("hitTest finds a node that lies in the gap between two pages", () => {
  const gap = { x: 10, y: 700, width: 50, height: 50 }; // below the first page, above the second
  const items = [
    { id: "on-page", rect: r, z: 0, locked: false, layer: 0 },
    { id: "in-gap", rect: gap, z: 0, locked: false, layer: 0 },
    { id: "other-page", rect: { x: 10, y: 800, width: 50, height: 50 }, z: 0, locked: false, layer: 1 },
  ];
  expect(hitTest(items, { x: 30, y: 725 })).toBe("in-gap");
  expect(hitTest(items, { x: 30, y: 775 })).toBeNull();
});

test("hitTest prefers a later page's node over an earlier page's node with a higher z", () => {
  const items = [
    { id: "early-high", rect: r, z: 9, locked: false, layer: 0 },
    { id: "late-low", rect: r, z: 0, locked: false, layer: 1 },
  ];
  expect(hitTest(items, { x: 20, y: 20 })).toBe("late-low");
  expect(hitTest([...items].reverse(), { x: 20, y: 20 })).toBe("late-low");
});

test("hitTest finds a locked node of a later page over the unlocked one below it", () => {
  const items = [
    { id: "early", rect: r, z: 0, locked: false, layer: 0 },
    { id: "late-locked", rect: r, z: 0, locked: true, layer: 1 },
  ];
  expect(hitTest(items, { x: 20, y: 20 })).toBe("late-locked");
});

test("dragRect is the dragged box either way, and with square a square on the side the pointer went", () => {
  expect(dragRect({ x: 50, y: 50 }, { x: 10, y: 80 }, false)).toEqual({ x: 10, y: 50, width: 40, height: 30 });
  expect(dragRect({ x: 50, y: 50 }, { x: 10, y: 80 }, true)).toEqual({ x: 10, y: 50, width: 40, height: 40 });
  expect(dragRect({ x: 50, y: 50 }, { x: 60, y: 0 }, true)).toEqual({ x: 50, y: 0, width: 50, height: 50 });
});

test("hitTest: an item with its own hit test is hit where it says, inside its box or not, and keeps its place in the stacking", () => {
  // A line along y = 30 inside r, hit within 4 px of it, drawn above a box under it.
  const line = { id: "line", rect: r, z: 5, locked: false, hit: (p: { x: number; y: number }) => Math.abs(p.y - 30) <= 4 };
  const box = { id: "box", rect: r, z: 0, locked: false };
  expect(hitTest([box, line], { x: 50, y: 33 })).toBe("line");
  expect(hitTest([box, line], { x: 50, y: 36 })).toBe("box");
  // Off the box's edge, only the line's own test counts.
  expect(hitTest([{ ...line, hit: (p: { x: number; y: number }) => Math.abs(p.y - 8) <= 4 }], { x: 50, y: 6 })).toBe("line");
});

test("hitAll lists everything under the point, topmost first", () => {
  const items = [
    { id: "low", rect: r, z: 0, locked: false },
    { id: "high", rect: r, z: 5, locked: false },
    { id: "tie", rect: r, z: 0, locked: false },
    { id: "away", rect: { x: 500, y: 500, width: 10, height: 10 }, z: 9, locked: false },
    { id: "later-page", rect: r, z: -1, locked: false, layer: 1 },
  ];
  expect(hitAll(items, { x: 20, y: 20 })).toEqual(["later-page", "high", "tie", "low"]);
  expect(hitAll(items, { x: 0, y: 0 })).toEqual([]);
});

test("a node's size is kept to a millimetre at least", () => {
  expect([nodeSizePx(0), nodeSizePx(MIN_NODE_PX / 2), nodeSizePx(40)]).toEqual([MIN_NODE_PX, MIN_NODE_PX, 40]);
});
