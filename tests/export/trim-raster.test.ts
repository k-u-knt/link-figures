import { cutRaster } from "../../src/export/trim/raster";
import type { PixelRect } from "../../src/export/trim/visible";

/** A cut that only records what it was asked for and answers with an image of the cut's size. */
function fakeCut() {
  const calls: { dataUri: string; rect: PixelRect }[] = [];
  const cutImage = async (dataUri: string, rect: PixelRect) => {
    calls.push({ dataUri, rect });
    return { dataUri: "data:image/png;base64,CUT", width: rect.width, height: rect.height };
  };
  return { calls, cutImage };
}

test("the raster is cut to the visible fraction, rounded outward, and the crop is re-expressed in the cut image", async () => {
  const { calls, cutImage } = fakeCut();
  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  // A quarter in from each side of a 400×200 image: 100.4…300.4 rounds outward to 100…301.
  const out = await cutRaster("data:src", { width: 400, height: 200 }, crop, { x: 0.251, y: 0.25, width: 0.5, height: 0.5 }, cutImage);
  expect(calls).toEqual([{ dataUri: "data:src", rect: { x: 100, y: 50, width: 201, height: 100 } }]);
  expect(out).not.toBeNull();
  expect(out!.dataUri).toBe("data:image/png;base64,CUT");
  expect([out!.width, out!.height]).toEqual([201, 100]);
  // The crop's 200×100 px start where the cut does (y) or 0 px before it (x), in the cut's 201×100.
  expect(out!.crop.x).toBeCloseTo(0, 12);
  expect(out!.crop.y).toBeCloseTo(0, 12);
  expect(out!.crop.w).toBeCloseTo(200 / 201, 12);
  expect(out!.crop.h).toBeCloseTo(1, 12);
  expect(out!.cut).toEqual({ x: 100, y: 50, width: 201, height: 100 });
});

test("without a crop, the whole image is the crop, re-expressed in the cut image (outside 0–1)", async () => {
  const { cutImage } = fakeCut();
  const out = await cutRaster("data:src", { width: 400, height: 200 }, null, { x: 0.25, y: 0, width: 0.5, height: 1 }, cutImage);
  expect(out!.crop).toEqual({ x: -0.5, y: 0, w: 2, h: 1 });
});

test("nothing is cut when no whole pixel lies outside", async () => {
  const { calls, cutImage } = fakeCut();
  const out = await cutRaster("data:src", { width: 400, height: 200 }, null, { x: 0.001, y: 0, width: 0.998, height: 1 }, cutImage);
  expect(out).toBeNull();
  expect(calls).toEqual([]);
});

test("a cut that answers with a different size is refused", async () => {
  const cutImage = async () => ({ dataUri: "data:x", width: 10, height: 10 });
  await expect(cutRaster("data:src", { width: 400, height: 200 }, null, { x: 0.25, y: 0, width: 0.5, height: 1 }, cutImage)).rejects.toThrow(
    /200 × 200/,
  );
});
