import { isWhollyVisible, pixelRect, visibleSourceRect } from "../../src/export/trim/visible";

const close = (actual: { x: number; y: number; width: number; height: number }, expected: typeof actual) => {
  for (const key of ["x", "y", "width", "height"] as const) expect(actual[key]).toBeCloseTo(expected[key], 9);
};

test("contain shows the whole crop", () => {
  close(visibleSourceRect({ width: 100, height: 100 }, { width: 400, height: 200 }, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, "contain"), {
    x: 100,
    y: 50,
    width: 200,
    height: 100,
  });
});

test("cover of an uncropped image shows the part the box cuts out of it", () => {
  // 400×200 covered into 100×100: scale 0.5, the image is 200×100 centred, so its middle 200×200 source px show.
  close(visibleSourceRect({ width: 100, height: 100 }, { width: 400, height: 200 }, null, "cover"), { x: 100, y: 0, width: 200, height: 200 });
});

test("contain without a crop shows the whole image", () => {
  const rect = visibleSourceRect({ width: 100, height: 300 }, { width: 400, height: 200 }, null, "contain");
  close(rect, { x: 0, y: 0, width: 400, height: 200 });
  expect(isWhollyVisible(rect, { width: 400, height: 200 })).toBe(true);
});

test("cover of a crop cuts the crop further, on the axis where it overflows the box", () => {
  // The right half (200×200) covered into a 100×50 box: scale 0.5, the crop is 100×100 high, so its middle 100 source px show.
  close(visibleSourceRect({ width: 100, height: 50 }, { width: 400, height: 200 }, { x: 0.5, y: 0, w: 0.5, h: 1 }, "cover"), {
    x: 200,
    y: 50,
    width: 200,
    height: 100,
  });
});

test("an image without a size is treated as wholly visible", () => {
  const rect = visibleSourceRect({ width: 100, height: 100 }, { width: 0, height: 0 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, "cover");
  expect(isWhollyVisible(rect, { width: 0, height: 0 })).toBe(true);
});

test("isWhollyVisible tolerates rounding noise only", () => {
  const natural = { width: 400, height: 200 };
  expect(isWhollyVisible({ x: 1e-12, y: -1e-12, width: 400 - 1e-12, height: 200 }, natural)).toBe(true);
  expect(isWhollyVisible({ x: 0, y: 0, width: 399.99, height: 200 }, natural)).toBe(false);
  expect(isWhollyVisible({ x: 0, y: 0.5, width: 400, height: 199.5 }, natural)).toBe(false);
});

test("pixelRect rounds outward to whole pixels", () => {
  expect(pixelRect({ x: 10.2, y: 5.7, width: 20.1, height: 3.1 }, { width: 100, height: 100 })).toEqual({ x: 10, y: 5, width: 21, height: 4 });
});

test("pixelRect is clamped to the image", () => {
  expect(pixelRect({ x: -3.5, y: 90.2, width: 120, height: 20 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 90, width: 100, height: 10 });
});

test("pixelRect does not add a pixel for rounding noise on a whole-pixel edge", () => {
  expect(pixelRect({ x: 10.000000000001, y: 4.999999999999, width: 19.999999999998, height: 5 }, { width: 100, height: 100 })).toEqual({
    x: 10,
    y: 5,
    width: 20,
    height: 5,
  });
});
