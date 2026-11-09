import { Viewport, focusPageOf, nearestPage, pageInFocus, pagePointAt, pageWorldRect } from "../../src/view/viewport";
import { createDocument, createPage } from "../../src/model/defaults";
import { MM_TO_PX } from "../../src/constants";

test("toWorld inverts toScreen", () => { const v = new Viewport(); v.tx = 10; v.ty = 20; v.zoom = 2; const p = v.toWorld(v.toScreen({ x: 5, y: 7 })); expect(p.x).toBeCloseTo(5); expect(p.y).toBeCloseTo(7); });
test("zoomAt keeps the point under the cursor fixed", () => { const v = new Viewport(); v.zoom = 1; const before = v.toWorld({ x: 100, y: 50 }); v.zoomAt({ x: 100, y: 50 }, 2); const after = v.toWorld({ x: 100, y: 50 }); expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y); expect(v.zoom).toBe(2); });
test("zoom clamps", () => { const v = new Viewport(); v.zoomAt({ x: 0, y: 0 }, 1000); expect(v.zoom).toBe(8); v.zoomAt({ x: 0, y: 0 }, 1e-6); expect(v.zoom).toBe(0.05); });
test("fitRect centres the rect with padding", () => { const v = new Viewport(); v.fitRect({ x: 0, y: 0, width: 200, height: 100 }, { width: 1000, height: 1000 }, 100); expect(v.zoom).toBeCloseTo(4); expect(v.toScreen({ x: 100, y: 50 })).toEqual({ x: 500, y: 500 }); });

// Beyond the brief: the remaining behaviour.
test("zoomAt keeps the cursor point fixed from a panned, zoomed state", () => {
  const v = new Viewport(); v.tx = -30; v.ty = 70; v.zoom = 1.5;
  const cursor = { x: 240, y: 130 };
  const before = v.toWorld(cursor);
  v.zoomAt(cursor, 0.4);
  const after = v.toWorld(cursor);
  expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y);
  expect(v.zoom).toBeCloseTo(0.6);
});
test("zoomAt at a clamp keeps the point fixed and leaves a clamped zoom alone", () => {
  const v = new Viewport(); v.tx = 11; v.ty = 22; v.zoom = 6;
  v.zoomAt({ x: 50, y: 60 }, 100);
  expect(v.zoom).toBe(8);
  const settled = { tx: v.tx, ty: v.ty };
  v.zoomAt({ x: 300, y: 400 }, 2); // already at the maximum: nothing moves
  expect({ tx: v.tx, ty: v.ty }).toEqual(settled);
});
test("zoomAt ignores a factor that is not a positive number", () => {
  const v = new Viewport(); v.tx = 5; v.ty = 6; v.zoom = 2;
  for (const f of [NaN, 0, -1]) v.zoomAt({ x: 10, y: 10 }, f);
  expect(v).toMatchObject({ tx: 5, ty: 6, zoom: 2 });
});
test("panBy moves the origin in screen pixels", () => { const v = new Viewport(); v.zoom = 3; v.panBy(10, -4); v.panBy(5, 1); expect(v.toScreen({ x: 0, y: 0 })).toEqual({ x: 15, y: -3 }); expect(v.zoom).toBe(3); });
test("cssTransform is translate then scale", () => { const v = new Viewport(); v.tx = 12; v.ty = -3.5; v.zoom = 0.25; expect(v.cssTransform()).toBe("translate(12px, -3.5px) scale(0.25)"); });
test("fitRect fits the limiting axis, offsets for a rect that is not at the origin, and clamps the zoom", () => {
  const v = new Viewport();
  v.fitRect({ x: 1000, y: 2000, width: 400, height: 100 }, { width: 840, height: 600 }, 20);
  expect(v.zoom).toBeCloseTo(2); // width-limited: (840 - 40) / 400
  expect(v.toScreen({ x: 1200, y: 2050 })).toEqual({ x: 420, y: 300 });
  v.fitRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 1000, height: 1000 });
  expect(v.zoom).toBe(8);
  v.fitRect({ x: 0, y: 0, width: 1e6, height: 1e6 }, { width: 1000, height: 1000 });
  expect(v.zoom).toBe(0.05);
});
test("fitRect does nothing for an empty rect or an empty stage", () => {
  const v = new Viewport(); v.tx = 1; v.ty = 2; v.zoom = 3;
  v.fitRect({ x: 0, y: 0, width: 0, height: 10 }, { width: 500, height: 500 });
  v.fitRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 500 });
  expect(v).toMatchObject({ tx: 1, ty: 2, zoom: 3 });
});
test("centreOn puts the world point mid-stage at the given zoom, or at the current zoom", () => {
  const v = new Viewport(); v.zoom = 2;
  v.centreOn({ x: 100, y: 50 }, { width: 800, height: 600 });
  expect(v.zoom).toBe(2);
  expect(v.toScreen({ x: 100, y: 50 })).toEqual({ x: 400, y: 300 });
  v.centreOn({ x: 100, y: 50 }, { width: 800, height: 600 }, 1000);
  expect(v.zoom).toBe(8);
  expect(v.toScreen({ x: 100, y: 50 })).toEqual({ x: 400, y: 300 });
});

const twoPages = () => { const d = createDocument("a4-portrait"); d.pages.push(createPage("a4-portrait", [d.pages[0].id])); return d; };
test("pageWorldRect is the page origin and size in px", () => {
  const d = twoPages();
  expect(pageWorldRect(d, d.pages[0])).toEqual({ x: 0, y: 0, width: 210 * MM_TO_PX, height: 297 * MM_TO_PX });
  expect(pageWorldRect(d, d.pages[1])).toEqual({ x: 0, y: (297 + 20) * MM_TO_PX, width: 210 * MM_TO_PX, height: 297 * MM_TO_PX });
});
test("nearestPage picks the page whose centre is nearest the point", () => {
  const d = twoPages();
  const second = (297 + 20) * MM_TO_PX;
  expect(nearestPage(d, { x: 100, y: 100 })).toBe(d.pages[0]);
  expect(nearestPage(d, { x: 100, y: second + 100 })).toBe(d.pages[1]);
  // The bottom edge of page 0 is still nearer to its own centre; the gap just above page 1 is nearer to page 1's.
  expect(nearestPage(d, { x: 100, y: 297 * MM_TO_PX - 1 })).toBe(d.pages[0]);
  expect(nearestPage(d, { x: 100, y: second - 1 })).toBe(d.pages[1]);
});
test("nearestPage of a document without pages is undefined", () => { const d = createDocument("a4-portrait"); d.pages = []; expect(nearestPage(d, { x: 0, y: 0 })).toBeUndefined(); });
test("pagePointAt: the page under a world point and the point in its pixels; null between pages", () => {
  const d = twoPages();
  const second = (297 + 20) * MM_TO_PX;
  const onFirst = pagePointAt(d, { x: 30, y: 40 })!;
  expect(onFirst.page).toBe(d.pages[0]);
  expect([onFirst.x, onFirst.y]).toEqual([30, 40]);
  // On the second page, the point is in that page's own pixels: less its origin below the first page and the gap.
  const onSecond = pagePointAt(d, { x: 30, y: second + 40 })!;
  expect(onSecond.page).toBe(d.pages[1]);
  expect(onSecond.x).toBe(30);
  expect(onSecond.y).toBeCloseTo(40);
  // In the gap between the pages, beside them, and above the first.
  expect(pagePointAt(d, { x: 30, y: 297 * MM_TO_PX + 10 })).toBeNull();
  expect(pagePointAt(d, { x: 210 * MM_TO_PX + 1, y: 40 })).toBeNull();
  expect(pagePointAt(d, { x: 30, y: -1 })).toBeNull();
});

describe("pageInFocus", () => {
  const twoPages = () => {
    const d = createDocument("a4-portrait");
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
    d.nodes.push({ id: "p-on-2", page: d.pages[1].id } as any, { id: "p-on-1", page: d.pages[0].id } as any);
    return d;
  };

  test("is the page of the selected node, wherever the stage is centred", () => {
    const d = twoPages();
    expect(pageInFocus(d, ["p-on-2"], d.pages[0])).toBe(d.pages[1]);
    expect(pageInFocus(d, ["p-on-1"], d.pages[1])).toBe(d.pages[0]);
  });

  test("is the page the stage is centred on when nothing is selected", () => {
    const d = twoPages();
    expect(pageInFocus(d, [], d.pages[1])).toBe(d.pages[1]);
    expect(pageInFocus(d, [], undefined)).toBeUndefined();
  });

  test("passes over selected ids that are not in the document, and over a node whose page is gone", () => {
    const d = twoPages();
    d.nodes.push({ id: "p-orphan", page: "pg-gone" } as any);
    expect(pageInFocus(d, ["p-gone", "p-orphan", "p-on-2"], d.pages[0])).toBe(d.pages[1]);
    expect(pageInFocus(d, ["p-gone", "p-orphan"], d.pages[0])).toBe(d.pages[0]);
  });
});

describe("focusPageOf", () => {
  const doc = () => {
    const d = createDocument("a4-portrait");
    d.pages.push(createPage("a4-portrait", d.pages.map((p) => p.id)));
    return d;
  };
  test("a pinned page that is still a page wins over the current one", () => {
    const d = doc();
    expect(focusPageOf(d.pages[1].id, d.pages, d.pages[0])).toBe(d.pages[1]);
  });
  test("no pin, or a pin whose page is gone, is the current page", () => {
    const d = doc();
    expect(focusPageOf(null, d.pages, d.pages[0])).toBe(d.pages[0]);
    expect(focusPageOf("gone", d.pages, d.pages[0])).toBe(d.pages[0]);
  });
});
