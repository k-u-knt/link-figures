import { decodeTiffPage } from "../../src/links/decoders/tiff";

/** A TIFF of 16-bit greyscale pages, one row of `values.length` pixels each, in the given byte order. */
function buildTiff(pages: number[][], littleEndian: boolean, photometric = 1): ArrayBuffer {
  const entryCount = 9;
  const ifdSize = 2 + entryCount * 12 + 4;
  const pageSize = ifdSize + pages[0].length * 2;
  const view = new DataView(new ArrayBuffer(8 + pages.length * pageSize));
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, littleEndian);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, littleEndian);
  view.setUint8(0, littleEndian ? 0x49 : 0x4d);
  view.setUint8(1, littleEndian ? 0x49 : 0x4d);
  u16(2, 42);
  u32(4, 8);
  pages.forEach((values, page) => {
    const ifd = 8 + page * pageSize;
    const data = ifd + ifdSize;
    // [tag, type (3 = SHORT, 4 = LONG), value]: width, height, bits, no compression, photometric, strip offset, samples, rows per strip, strip bytes.
    const tags = [[256, 3, values.length], [257, 3, 1], [258, 3, 16], [259, 3, 1], [262, 3, photometric], [273, 4, data], [277, 3, 1], [278, 3, 1], [279, 4, values.length * 2]];
    u16(ifd, tags.length);
    tags.forEach(([tag, type, value], i) => {
      const entry = ifd + 2 + i * 12;
      u16(entry, tag);
      u16(entry + 2, type);
      u32(entry + 4, 1);
      if (type === 3) u16(entry + 8, value);
      else u32(entry + 8, value);
    });
    u32(ifd + 2 + tags.length * 12, page < pages.length - 1 ? ifd + pageSize : 0);
    values.forEach((value, i) => u16(data + i * 2, value));
  });
  return view.buffer;
}

// 10000 is 0x2710 and 258 is 0x0102: each differs from its byte-swapped value, so a double swap shows.
test.each([["little-endian", true], ["big-endian", false]])("%s 16-bit samples come out as the written values", (_name, littleEndian) => {
  const { plane, pageCount } = decodeTiffPage(buildTiff([[10000, 258]], littleEndian), 0);
  expect(pageCount).toBe(1);
  expect(plane).toMatchObject({ width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 1 });
  expect([...plane.data]).toEqual([10000, 258]);
});

test("pageCount counts the IFDs and pageIndex picks one, clamped into range", () => {
  const bytes = buildTiff([[1, 2], [3, 4], [5, 6]], false);
  const first = (pageIndex: number) => { const { plane, pageCount } = decodeTiffPage(bytes, pageIndex); expect(pageCount).toBe(3); return plane.data[0]; };
  expect([first(0), first(1), first(2)]).toEqual([1, 3, 5]);
  expect([first(-4), first(99), first(Number.NaN)]).toEqual([1, 5, 1]);
});

test("photometric interpretation reaches the plane: 0 is WhiteIsZero, 3 (palette) is refused", () => {
  expect(decodeTiffPage(buildTiff([[1, 2]], true, 0), 0).plane.whiteIsZero).toBe(true);
  expect(decodeTiffPage(buildTiff([[1, 2]], false, 1), 0).plane.whiteIsZero).toBe(false);
  expect(() => decodeTiffPage(buildTiff([[1, 2]], true, 3), 0)).toThrow(/photometric interpretation 3/);
});
