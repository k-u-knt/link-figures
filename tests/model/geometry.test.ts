import { pageOriginsPx, imagePlacement, cropPlacement, mmToPx, pxToMm, nodeWorldRect, rectIntersects, rectContainsPt, unionRect } from "../../src/model/geometry";
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
