import { fitDpi, MAX_CANVAS_AREA, MAX_CANVAS_SIDE } from "../../src/export/raster-size";

test("a page that fits is drawn at the dpi asked for, its size in whole pixels", () => {
  // 180 × 170 mm at 300 dpi: 2125.98 × 2007.87 px.
  expect(fitDpi({ width: 180, height: 170 }, 300)).toEqual({ dpi: 300, widthPx: 2126, heightPx: 2008, reduced: false });
});

test("the limits are Chromium's canvas limits", () => {
  expect(MAX_CANVAS_SIDE).toBe(16384);
  expect(MAX_CANVAS_AREA).toBe(268_435_456);
});

test("a page wider than the side limit is drawn at the largest whole dpi whose pixels fit", () => {
  // 1000 mm at 1000 dpi is 39 370 px; 16 384 px over 1000 mm is 416.15 dpi.
  const fit = fitDpi({ width: 1000, height: 100 }, 1000);
  expect(fit).toMatchObject({ dpi: 416, reduced: true });
  expect(fit.widthPx).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
  expect(fitDpi({ width: 1000, height: 100 }, 417).reduced).toBe(true);
});

test("the side and area limits are met together on a page that is over both", () => {
  const fit = fitDpi({ width: 5000, height: 5000 }, 1200);
  expect(fit.reduced).toBe(true);
  expect(fit.widthPx).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
  expect(fit.widthPx * fit.heightPx).toBeLessThanOrEqual(MAX_CANVAS_AREA);
  expect(fit.dpi).toBeGreaterThan(0);
});

test("a page is at least one pixel each way", () => {
  expect(fitDpi({ width: 0.01, height: 0.01 }, 72)).toMatchObject({ widthPx: 1, heightPx: 1, reduced: false });
});
