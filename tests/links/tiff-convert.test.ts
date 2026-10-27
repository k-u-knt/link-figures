import { autoRange, ifdToPlane, planeToRgba } from "../../src/links/decoders/tiff-convert";

test("autoRange", () => expect(autoRange(new Uint16Array([100, 4000, 250]))).toEqual({ min: 100, max: 4000 }));
test("16-bit grey stretches to 0..255", () => { const { rgba, range } = planeToRgba({ width: 3, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: new Uint16Array([100, 2050, 4000]) }, "auto"); expect(range).toEqual({ min: 100, max: 4000 }); expect([...rgba]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]); });
test("explicit range clamps", () => { const { rgba } = planeToRgba({ width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: new Uint16Array([0, 65535]) }, { min: 100, max: 200 }); expect([...rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]); });
test("8-bit RGB auto passes through", () => { const { rgba } = planeToRgba({ width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 3, data: new Uint8Array([10, 20, 30]) }, "auto"); expect([...rgba]).toEqual([10, 20, 30, 255]); });
test("ifdToPlane reads little-endian 16-bit", () => { const p = ifdToPlane({ width: 1, height: 1, t258: [16], t277: [1], data: new Uint8Array([0x10, 0x27]), isLE: true }); expect(p.bitsPerSample).toBe(16); expect(p.data[0]).toBe(10000); });

// Beyond the brief.

const grey16 = (data: number[]) => ({ width: data.length, height: 1, bitsPerSample: 16 as const, samplesPerPixel: 1 as const, data: new Uint16Array(data) });

test("autoRange of nothing is 0..0, and handles arrays too long to spread", () => { expect(autoRange(new Uint8Array(0))).toEqual({ min: 0, max: 0 }); const big = new Uint16Array(500_000).fill(7); big[123_456] = 9; big[400_000] = 2; expect(autoRange(big)).toEqual({ min: 2, max: 9 }); });
test("a flat plane maps to black, not NaN", () => { const { rgba, range } = planeToRgba(grey16([50, 50, 50]), "auto"); expect(range).toEqual({ min: 50, max: 50 }); expect([...rgba]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]); });
test("an explicit range with max <= min maps to black", () => { const plane = grey16([0, 100, 65535]); for (const range of [{ min: 100, max: 100 }, { min: 200, max: 100 }]) expect([...planeToRgba(plane, range).rgba].filter((_, i) => i % 4 !== 3)).toEqual(Array(9).fill(0)); });
test("an explicit range is returned as given", () => expect(planeToRgba(grey16([5]), { min: 1, max: 9 }).range).toEqual({ min: 1, max: 9 }));
test("8-bit grey stretches under auto", () => { const { rgba, range } = planeToRgba({ width: 3, height: 1, bitsPerSample: 8, samplesPerPixel: 1, data: new Uint8Array([50, 100, 150]) }, "auto"); expect(range).toEqual({ min: 50, max: 150 }); expect([...rgba]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]); });
test("8-bit RGBA auto passes through, alpha included, with range 0..255", () => { const { rgba, range } = planeToRgba({ width: 2, height: 1, bitsPerSample: 8, samplesPerPixel: 4, data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]) }, "auto"); expect(range).toEqual({ min: 0, max: 255 }); expect([...rgba]).toEqual([10, 20, 30, 40, 50, 60, 70, 80]); });
test("8-bit RGB takes an explicit range", () => { const { rgba } = planeToRgba({ width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 3, data: new Uint8Array([50, 100, 150]) }, { min: 50, max: 150 }); expect([...rgba]).toEqual([0, 128, 255, 255]); });
test("16-bit RGB stretches every channel over the whole data", () => { const { rgba, range } = planeToRgba({ width: 1, height: 1, bitsPerSample: 16, samplesPerPixel: 3, data: new Uint16Array([0, 1000, 2000]) }, "auto"); expect(range).toEqual({ min: 0, max: 2000 }); expect([...rgba]).toEqual([0, 128, 255, 255]); });

test("ifdToPlane reads big-endian 16-bit when isLE is false", () => { const p = ifdToPlane({ width: 2, height: 1, t258: [16], t277: [1], data: new Uint8Array([0x27, 0x10, 0x01, 0x02]), isLE: false }); expect([...p.data]).toEqual([10000, 258]); });
test("ifdToPlane reads 16-bit from data that starts at an odd byte offset", () => { const backing = new Uint8Array([0xff, 0x10, 0x27, 0x02, 0x01]); const p = ifdToPlane({ width: 2, height: 1, t258: [16], t277: [1], data: backing.subarray(1), isLE: true }); expect([...p.data]).toEqual([10000, 258]); });
test("ifdToPlane keeps 8-bit samples and trims trailing bytes", () => { const p = ifdToPlane({ width: 1, height: 1, t258: [8, 8, 8], t277: [3], data: new Uint8Array([1, 2, 3, 9, 9]), isLE: true }); expect(p).toMatchObject({ bitsPerSample: 8, samplesPerPixel: 3 }); expect([...p.data]).toEqual([1, 2, 3]); });
test("ifdToPlane defaults to one sample per pixel", () => expect(ifdToPlane({ width: 2, height: 1, t258: [8], data: new Uint8Array([1, 2]), isLE: true }).samplesPerPixel).toBe(1));
test("ifdToPlane rejects what it cannot show", () => {
  const ifd = { width: 1, height: 1, t258: [8], t277: [1], data: new Uint8Array([1]), isLE: true };
  expect(() => ifdToPlane({ ...ifd, t258: [1] })).toThrow(/1-bit/);
  expect(() => ifdToPlane({ ...ifd, t258: undefined })).toThrow(/1-bit/);
  expect(() => ifdToPlane({ ...ifd, t258: [32] })).toThrow(/32-bit/);
  expect(() => ifdToPlane({ ...ifd, t277: [2] })).toThrow(/2 samples/);
  expect(() => ifdToPlane({ ...ifd, width: 2 })).toThrow(/shorter/);
  expect(() => ifdToPlane({ ...ifd, t258: [16] })).toThrow(/shorter/);
});
