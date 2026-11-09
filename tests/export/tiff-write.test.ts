import UTIF from "utif";
import { encodeTiffRgb as encodeParts } from "../../src/export/tiff-write";

/** RGB as RGBA, opaque. */
function rgba(rgb: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray((rgb.length / 3) * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) out.set([rgb[i], rgb[i + 1], rgb[i + 2], 255], j);
  return out;
}

/** The TIFF of an RGB image, as one file: its RGB passed as RGBA, and the parts joined. */
async function encodeTiffRgb(rgb: Uint8Array, w: number, h: number, dpi: number, compression: "none" | "deflate", rowsPerChunk?: number): Promise<Uint8Array> {
  const parts = await encodeParts(rgba(rgb), w, h, dpi, compression, rowsPerChunk);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A w × h RGB gradient, every pixel different. */
function gradient(w: number, h: number): Uint8Array {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set([i % 256, (i * 7) % 256, (i * 13) % 256], i * 3);
  return rgb;
}

/** The value of a short or long tag, read straight from the file (little-endian, first IFD). */
function rawTags(bytes: Uint8Array): Map<number, { type: number; count: number; value: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = view.getUint32(4, true);
  const tags = new Map<number, { type: number; count: number; value: number }>();
  const n = view.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12;
    const type = view.getUint16(at + 2, true);
    tags.set(view.getUint16(at, true), { type, count: view.getUint32(at + 4, true), value: type === 3 ? view.getUint16(at + 8, true) : view.getUint32(at + 8, true) });
  }
  expect(view.getUint32(ifd + 2 + n * 12, true)).toBe(0);
  return tags;
}

for (const compression of ["none", "deflate"] as const) {
  test(`${compression}: UTIF reads back the pixels and the tags`, async () => {
    const [w, h] = [37, 23];
    const rgb = gradient(w, h);
    // Five rows a chunk, so the rows are streamed in several pieces.
    const bytes = await encodeTiffRgb(rgb, w, h, 600, compression, 5);
    expect([...bytes.subarray(0, 4)]).toEqual([0x49, 0x49, 42, 0]);

    const [ifd] = UTIF.decode(bytes);
    expect(ifd.t256).toEqual([w]);
    expect(ifd.t257).toEqual([h]);
    expect(ifd.t258).toEqual([8, 8, 8]);
    expect(ifd.t259).toEqual([compression === "none" ? 1 : 8]);
    expect(ifd.t262).toEqual([2]);
    expect(ifd.t277).toEqual([3]);
    expect(ifd.t278).toEqual([h]);
    expect(ifd.t284).toEqual([1]);
    expect(ifd.t296).toEqual([2]);
    expect(ifd.t282).toEqual([600]);
    expect(ifd.t283).toEqual([600]);
    UTIF.decodeImage(bytes, ifd);
    expect(ifd.width).toBe(w);
    expect(ifd.height).toBe(h);
    expect([...ifd.data]).toEqual([...rgb]);
  });
}

test("tags are in ascending order, with types TIFF readers expect", async () => {
  const bytes = await encodeTiffRgb(gradient(4, 4), 4, 4, 300, "deflate");
  const tags = rawTags(bytes);
  expect([...tags.keys()]).toEqual([256, 257, 258, 259, 262, 273, 277, 278, 279, 282, 283, 284, 296]);
  expect(tags.get(258)).toMatchObject({ type: 3, count: 3 });
  expect(tags.get(282)).toMatchObject({ type: 5, count: 1 });
  expect(tags.get(273)!.value % 2).toBe(0);
});

test("uncompressed data is the RGB bytes as they are; deflate is smaller for a flat image", async () => {
  const flat = new Uint8Array(100 * 100 * 3).fill(255);
  const none = await encodeTiffRgb(flat, 100, 100, 300, "none");
  const tags = rawTags(none);
  expect(tags.get(279)!.value).toBe(30000);
  expect([...none.subarray(tags.get(273)!.value, tags.get(273)!.value + 30000)].every((b) => b === 255)).toBe(true);
  expect((await encodeTiffRgb(flat, 100, 100, 300, "deflate")).length).toBeLessThan(1000);
});

test("a buffer of the wrong length, or a size that is not whole and positive, is refused", async () => {
  await expect(encodeParts(new Uint8ClampedArray(5), 2, 1, 300, "none")).rejects.toThrow(/8 bytes/);
  await expect(encodeParts(new Uint8ClampedArray(0), 0, 1, 300, "none")).rejects.toThrow(/size/);
});

test("the resolution is stored in hundredths of a dot, as the PNG's is in pixels per metre", async () => {
  const bytes = await encodeTiffRgb(new Uint8Array(3), 1, 1, 299.5, "none");
  const view = new DataView(bytes.buffer);
  const at = rawTags(bytes).get(282)!.value;
  expect([view.getUint32(at, true), view.getUint32(at + 4, true)]).toEqual([29950, 100]);
});

test("the parts are the header, the strip, and the IFD with its values", async () => {
  const parts = await encodeParts(rgba(gradient(3, 2)), 3, 2, 300, "none");
  expect(parts[0].length).toBe(8);
  expect(parts.at(-1)!.length).toBeGreaterThan(2 + 13 * 12 + 4);
});
