import { deflate } from "pako";

export type TiffCompression = "none" | "deflate";

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

interface Entry {
  tag: number;
  type: typeof SHORT | typeof LONG | typeof RATIONAL;
  values: number[];
}

/** RGBA pixels (as from `getImageData`) as RGB, alpha dropped. */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const pixels = Math.floor(rgba.length / 4);
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0, j = 0; i < pixels * 4; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

/**
 * A baseline TIFF of one 8-bit RGB image: little-endian, chunky, one strip, the resolution `dpi` per inch, the strip
 * stored as it is (`none`) or Adobe Deflate (compression 8, zlib-wrapped).
 *
 * Layout: header, the strip, then the IFD and the values that do not fit in it (BitsPerSample and the two rationals).
 */
export function encodeTiffRgb(rgb: Uint8Array, width: number, height: number, dpi: number, compression: TiffCompression): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`the image size ${width} × ${height} is not whole and positive`);
  }
  const expected = width * height * 3;
  if (rgb.length !== expected) throw new Error(`the RGB data is ${rgb.length} bytes, not ${expected} bytes`);

  const strip = compression === "deflate" ? deflate(rgb) : rgb;
  const resolution = Math.max(1, Math.round(dpi));

  const stripOffset = 8;
  // Word-aligned, as TIFF asks of the IFD and of values stored outside it.
  const ifdOffset = stripOffset + strip.length + (strip.length % 2);
  const entries: Entry[] = [
    { tag: 256, type: LONG, values: [width] },
    { tag: 257, type: LONG, values: [height] },
    { tag: 258, type: SHORT, values: [8, 8, 8] },
    { tag: 259, type: SHORT, values: [compression === "deflate" ? 8 : 1] },
    { tag: 262, type: SHORT, values: [2] },
    { tag: 273, type: LONG, values: [stripOffset] },
    { tag: 277, type: SHORT, values: [3] },
    { tag: 278, type: LONG, values: [height] },
    { tag: 279, type: LONG, values: [strip.length] },
    { tag: 282, type: RATIONAL, values: [resolution, 1] },
    { tag: 283, type: RATIONAL, values: [resolution, 1] },
    { tag: 284, type: SHORT, values: [1] },
    { tag: 296, type: SHORT, values: [2] },
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const sizeOf = (e: Entry) => (e.type === SHORT ? 2 : 4) * e.values.length;
  const extraSize = entries.reduce((n, e) => n + (sizeOf(e) > 4 ? sizeOf(e) + (sizeOf(e) % 2) : 0), 0);

  const out = new Uint8Array(ifdOffset + ifdSize + extraSize);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, ifdOffset, true);
  out.set(strip, stripOffset);

  view.setUint16(ifdOffset, entries.length, true);
  let extra = ifdOffset + ifdSize;
  const writeValues = (at: number, e: Entry) => {
    for (const [i, v] of e.values.entries()) {
      if (e.type === SHORT) view.setUint16(at + i * 2, v, true);
      else view.setUint32(at + i * 4, v, true);
    }
  };
  for (const [i, e] of entries.entries()) {
    const at = ifdOffset + 2 + i * 12;
    view.setUint16(at, e.tag, true);
    view.setUint16(at + 2, e.type, true);
    // A rational is two longs but one value.
    view.setUint32(at + 4, e.type === RATIONAL ? e.values.length / 2 : e.values.length, true);
    if (sizeOf(e) <= 4) {
      writeValues(at + 8, e);
    } else {
      view.setUint32(at + 8, extra, true);
      writeValues(extra, e);
      extra += sizeOf(e) + (sizeOf(e) % 2);
    }
  }
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);
  return out;
}
