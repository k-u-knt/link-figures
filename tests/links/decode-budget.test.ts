import { MAX_DECODE_MEGAPIXELS } from "../../src/constants";
import { checkDecodeBudget, DecodeLimitError } from "../../src/links/decoders/budget";

test("the limit is 50 MP", () => expect(MAX_DECODE_MEGAPIXELS).toBe(50));

test("an image up to the limit passes", () => {
  expect(() => checkDecodeBudget(10_000, 5_000, "TIFF page 1")).not.toThrow();
  expect(() => checkDecodeBudget(1, 1, "TIFF page 1")).not.toThrow();
});

test("one pixel over is refused with a DecodeLimitError that names the image, its size and the limit", () => {
  let caught: unknown;
  try {
    checkDecodeBudget(8000, 8000, "TIFF page 3");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DecodeLimitError);
  expect(caught).toMatchObject({ name: "DecodeLimitError", width: 8000, height: 8000, message: "TIFF page 3 is 8000×8000 px (64 MP); the limit is 50 MP" });
  expect(() => checkDecodeBudget(10_001, 5_000, "PDF page at 1200 dpi")).toThrow("PDF page at 1200 dpi is 10001×5000 px (50 MP); the limit is 50 MP");
  expect(() => checkDecodeBudget(9921, 14031, "PDF page at 1200 dpi")).toThrow("(139.2 MP)");
});

test("a size that is not a number is left to the decoder", () => {
  expect(() => checkDecodeBudget(Number.NaN, 100, "TIFF page 1")).not.toThrow();
});
