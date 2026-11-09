import { DecodeLimitError } from "../../src/links/decoders/budget";
import { turnJpegUpright, UPRIGHT_JPEG_QUALITY, type JpegCanvas } from "../../src/export/upright-jpeg";

/** A canvas whose decode gives a bitmap of `width` x `height` (as turned by its EXIF) and whose encode gives `out`. */
function fakeCanvas(width: number, height: number, out = new Uint8Array([9, 8, 7])) {
  const bitmap = { width, height, close: vi.fn() };
  const canvas: JpegCanvas & { decode: ReturnType<typeof vi.fn>; encode: ReturnType<typeof vi.fn> } = {
    decode: vi.fn(async () => bitmap),
    encode: vi.fn(async () => new Blob([out], { type: "image/jpeg" })),
  };
  return { bitmap, canvas };
}

test("decodes the photo turned by its EXIF and encodes it straight back as a JPEG at quality 0.95, closing the bitmap", async () => {
  const { bitmap, canvas } = fakeCanvas(30, 40);
  const input = new Uint8Array([1, 2, 3]).buffer;
  const result = await turnJpegUpright(input, canvas);
  expect(UPRIGHT_JPEG_QUALITY).toBe(0.95);
  expect(canvas.decode).toHaveBeenCalledTimes(1);
  expect(canvas.encode).toHaveBeenCalledWith(bitmap, "image/jpeg", 0.95);
  expect(result).toEqual({ bytes: new Uint8Array([9, 8, 7]).buffer, width: 30, height: 40 });
  expect(bitmap.close).toHaveBeenCalledTimes(1);
});

test("a photo over the decode budget is refused before it is drawn, and its bitmap is closed", async () => {
  const { bitmap, canvas } = fakeCanvas(10_000, 6_000);
  await expect(turnJpegUpright(new ArrayBuffer(4), canvas)).rejects.toBeInstanceOf(DecodeLimitError);
  expect(canvas.encode).not.toHaveBeenCalled();
  expect(bitmap.close).toHaveBeenCalledTimes(1);
});

test("a failed encode rejects, and the bitmap is still closed", async () => {
  const { bitmap, canvas } = fakeCanvas(30, 40);
  canvas.encode.mockRejectedValue(new Error("no canvas"));
  await expect(turnJpegUpright(new ArrayBuffer(4), canvas)).rejects.toThrow("no canvas");
  expect(bitmap.close).toHaveBeenCalledTimes(1);
});
