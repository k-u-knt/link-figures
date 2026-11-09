import { pageOriginsPx, imagePlacement, cropPlacement, mmToPx, pxToMm, nodeWorldRect, rectIntersects, rectContainsPt, unionRect, cropWithInset, visibleCrop } from "../../src/model/geometry";
import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import { MM_TO_PX } from "../../src/constants";

test("page origins stack vertically with the gap", () => { const d = createDocument("a4-portrait"); d.pages.push(createPage("a4-portrait", [d.pages[0].id])); const o = pageOriginsPx(d); expect(o.get(d.pages[1].id)).toEqual({ x: 0, y: (297 + 20) * MM_TO_PX }); });
test("imagePlacement cover fills the box, centred", () => { const r = imagePlacement({ width: 100, height: 100 }, { width: 200, height: 100 }, null, "cover"); expect(r).toEqual({ x: -50, y: 0, width: 200, height: 100 }); });
test("imagePlacement contain letterboxes", () => { const r = imagePlacement({ width: 100, height: 100 }, { width: 200, height: 100 }, null, "contain"); expect(r).toEqual({ x: 0, y: 25, width: 100, height: 50 }); });
test("imagePlacement with a crop maps the crop region onto the box", () => { const r = imagePlacement({ width: 100, height: 100 }, { width: 200, height: 200 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, "cover"); expect(r).toEqual({ x: -100, y: -100, width: 200, height: 200 }); });

// Beyond the brief: behaviour of the remaining helpers.
test("mm and px round-trip", () => expect(pxToMm(mmToPx(12.5))).toBeCloseTo(12.5, 10));
test("nodeWorldRect adds the page origin to the node position", () => {
  const d = createDocument("a4-portrait");
  d.pages.push(createPage("a4-portrait", [d.pages[0].id]));
  const node = fileNodeDefaults(d.pages[1], { file: "a.png", subpath: "", show: "image" }, []);
  const r = nodeWorldRect(d, { ...node, x: 10, y: 20, width: 30, height: 40 });
  expect(r).toEqual({ x: 10, y: (297 + 20) * MM_TO_PX + 20, width: 30, height: 40 });
});
test("rectIntersects is true for overlap and false for touching or disjoint rects", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  expect(rectIntersects(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
  expect(rectIntersects(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  expect(rectIntersects(a, { x: 20, y: 20, width: 5, height: 5 })).toBe(false);
});
test("rectContainsPt includes the edges", () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  expect(rectContainsPt(r, { x: 10, y: 10 })).toBe(true);
  expect(rectContainsPt(r, { x: 10.1, y: 5 })).toBe(false);
});
test("unionRect bounds all rects, and is empty for none", () => {
  expect(unionRect([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: -5, width: 5, height: 5 }])).toEqual({ x: 0, y: -5, width: 25, height: 15 });
  expect(unionRect([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
});
test("imagePlacement fills the box when the image has no size yet", () => {
  expect(imagePlacement({ width: 100, height: 50 }, { width: 0, height: 0 }, null, "cover")).toEqual({ x: 0, y: 0, width: 100, height: 50 });
});

test("cropPlacement: contain with a right-half crop letterboxes the crop, not the image", () => {
  const p = cropPlacement({ width: 200, height: 100 }, { width: 200, height: 100 }, { x: 0.5, y: 0, w: 0.5, h: 1 }, "contain");
  expect(p.fitted).toEqual({ x: 50, y: 0, width: 100, height: 100 });
  expect(p.region).toEqual(p.fitted);
  expect(p.image).toEqual({ x: -50, y: 0, width: 200, height: 100 });
});
test("cropPlacement: cover with the same crop fills the box and the region is cut to it", () => {
  const p = cropPlacement({ width: 200, height: 100 }, { width: 200, height: 100 }, { x: 0.5, y: 0, w: 0.5, h: 1 }, "cover");
  expect(p.fitted).toEqual({ x: 0, y: -50, width: 200, height: 200 });
  expect(p.region).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  expect(p.image).toEqual({ x: -200, y: -50, width: 400, height: 200 });
});
test("cropPlacement: no crop, contain, a wide image in a square box", () => {
  const p = cropPlacement({ width: 100, height: 100 }, { width: 200, height: 100 }, null, "contain");
  expect(p.fitted).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  expect(p.region).toEqual(p.fitted);
  expect(p.image).toEqual(p.fitted);
});
test("cropPlacement: an image without a size gives the box as region", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  expect(cropPlacement({ width: 100, height: 50 }, { width: 0, height: 0 }, null, "contain")).toEqual({ image: box, fitted: box, region: box });
});
test("imagePlacement is the whole image of cropPlacement", () => {
  const args = [{ width: 200, height: 100 }, { width: 300, height: 90 }, { x: 0.25, y: 0.1, w: 0.5, h: 0.8 }] as const;
  for (const fit of ["cover", "contain"] as const) expect(imagePlacement(...args, fit)).toEqual(cropPlacement(...args, fit).image);
});

describe("cropWithInset", () => {
  test("writing one side never moves the opposite side: the inset stops 1 % before it", () => {
    const c = { x: 0.2, y: 0.1, w: 0.5, h: 0.6 };
    const left = cropWithInset(c, "left", 0.9);
    expect(left.x + left.w).toBeCloseTo(0.7, 10);
    expect(left.w).toBeCloseTo(0.01, 10);
    const right = cropWithInset(c, "right", 0.95);
    expect(right.x).toBeCloseTo(0.2, 10);
    expect(right.w).toBeCloseTo(0.01, 10);
    const top = cropWithInset(c, "top", 1);
    expect(top.y + top.h).toBeCloseTo(0.7, 10);
    expect(top.h).toBeCloseTo(0.01, 10);
    const bottom = cropWithInset(c, "bottom", 1);
    expect(bottom.y).toBeCloseTo(0.1, 10);
    expect(bottom.h).toBeCloseTo(0.01, 10);
  });

  test("an inset below 0 is 0", () => {
    expect(cropWithInset({ x: 0.2, y: 0, w: 0.5, h: 1 }, "left", -0.5)).toEqual({ x: 0, y: 0, w: 0.7, h: 1 });
  });
});

describe("visibleCrop: what a panel shows now, as a crop of its image", () => {
  const natural = { width: 200, height: 100 };
  test("cover with the box wider than the image: the strips cut off top and bottom are left out", () => {
    expect(visibleCrop({ width: 200, height: 50, crop: null, fit: "cover" }, natural)).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 });
  });
  test("contain letterboxed: all of the crop shows, so it is the crop itself", () => {
    expect(visibleCrop({ width: 200, height: 200, crop: null, fit: "contain" }, natural)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(visibleCrop({ width: 200, height: 200, crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: "contain" }, natural)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });
  test("a crop whose aspect is the box's is what shows", () => {
    expect(visibleCrop({ width: 100, height: 100, crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: "cover" }, natural)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });
});
