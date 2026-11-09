import { readFileSync } from "node:fs";
import { jpegOrientation } from "../../src/links/decoders/exif";

/** A JPEG made of SOI, the given segments (marker, body) and SOS/EOI. */
function jpeg(...segments: [number, number[]][]): Uint8Array {
  const out = [0xff, 0xd8];
  for (const [marker, body] of segments) out.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
  out.push(0xff, 0xda, 0, 2, 0xff, 0xd9);
  return new Uint8Array(out);
}

/** An APP1 EXIF body with one IFD0 entry `tag` of `type` and `value`, little- or big-endian. */
function exif(le: boolean, value: number, tag = 0x0112, type = 3): number[] {
  const u16 = (v: number) => (le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  return [0x45, 0x78, 0x69, 0x66, 0, 0, ...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(tag), ...u16(type), ...u32(1), ...u16(value), 0, 0, ...u32(0)];
}

const JFIF: [number, number[]] = [0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]];

describe("jpegOrientation", () => {
  it("reads the orientation of a real JPEG with EXIF Orientation 6 (after its JFIF segment)", () => {
    expect(jpegOrientation(readFileSync(new URL("../export/fixtures/exif6.jpg", import.meta.url)))).toBe(6);
  });

  it("reads every orientation, in either byte order", () => {
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(jpegOrientation(jpeg(JFIF, [0xe1, exif(true, value)]))).toBe(value);
      expect(jpegOrientation(jpeg([0xe1, exif(false, value)]).buffer as ArrayBuffer)).toBe(value);
    }
  });

  it("is 1 for a JPEG without EXIF, with EXIF but no orientation, or with a value out of range or of the wrong type", () => {
    expect(jpegOrientation(jpeg(JFIF))).toBe(1);
    expect(jpegOrientation(jpeg([0xe1, exif(true, 6, 0x010f)]))).toBe(1);
    expect(jpegOrientation(jpeg([0xe1, exif(true, 9)]))).toBe(1);
    expect(jpegOrientation(jpeg([0xe1, exif(true, 0)]))).toBe(1);
    expect(jpegOrientation(jpeg([0xe1, exif(true, 6, 0x0112, 4)]))).toBe(1);
  });

  it("skips an APP1 segment that is not EXIF (XMP) and reads a later EXIF one", () => {
    const xmp: [number, number[]] = [0xe1, Array.from("http://ns.adobe.com/xap/1.0/\0", (c) => c.charCodeAt(0))];
    expect(jpegOrientation(jpeg(xmp, [0xe1, exif(false, 8)]))).toBe(8);
  });

  it("ignores EXIF after the start of scan, and is 1 for bytes that are not a JPEG or are cut short", () => {
    const late = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xe1, 0, 34, ...exif(true, 6)]);
    expect(jpegOrientation(late)).toBe(1);
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
    expect(jpegOrientation(new Uint8Array([]))).toBe(1);
    const cut = jpeg([0xe1, exif(true, 6)]).slice(0, 20);
    expect(jpegOrientation(cut)).toBe(1);
  });
});
