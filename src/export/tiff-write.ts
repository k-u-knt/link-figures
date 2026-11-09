import { Deflate } from "pako";

export type TiffCompression = "none" | "deflate";

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
/** Rows converted and compressed between two yields to the event loop. */
const ROWS_PER_CHUNK = 256;

interface Entry {
  tag: number;
  type: typeof SHORT | typeof LONG | typeof RATIONAL;
  values: number[];
}

/** Lets the event loop run (a macrotask), so a long encode does not freeze the window. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Rows `from`…`to` of the RGBA pixels as RGB, alpha dropped. */
function rgbRows(rgba: Uint8ClampedArray, width: number, from: number, to: number): Uint8Array {
  const rgb = new Uint8Array((to - from) * width * 3);
  for (let i = from * width * 4, j = 0; j < rgb.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

/**
 * The strip: the pixels as RGB, a few hundred rows at a time (never the whole image as RGB at once), each stored as it
 * is or pushed through one Adobe Deflate stream (zlib-wrapped), with a yield to the event loop between chunks.
 */
async function stripParts(rgba: Uint8ClampedArray, width: number, height: number, compression: TiffCompression, rowsPerChunk: number): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  const deflate = compression === "deflate" ? new Deflate() : null;
  if (deflate) {
    deflate.onData = (chunk) => parts.push(chunk as Uint8Array);
    deflate.onEnd = () => {};
  }
  for (let row = 0; row < height; row += rowsPerChunk) {
    const rgb = rgbRows(rgba, width, row, Math.min(height, row + rowsPerChunk));
    const last = row + rowsPerChunk >= height;
    if (!deflate) parts.push(rgb);
    else if (!deflate.push(rgb, last) || deflate.err) throw new Error(`the image could not be compressed: ${deflate.msg || "deflate failed"}`);
    if (!last) await yieldToEventLoop();
  }
  return parts;
}

/**
 * A baseline TIFF of one 8-bit RGB image, from RGBA pixels (alpha dropped): little-endian, chunky, one strip, the
 * resolution `dpi` per inch (in hundredths), the strip stored as it is (`none`) or Adobe Deflate (compression 8).
 *
 * The file comes as parts to be written one after another (a Blob of them): the header, the strip's pieces, and the IFD
 * with the values that do not fit in it (BitsPerSample and the two rationals).
 */
export async function encodeTiffRgb(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  dpi: number,
  compression: TiffCompression,
  rowsPerChunk = ROWS_PER_CHUNK,
): Promise<Uint8Array[]> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`the image size ${width} × ${height} is not whole and positive`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) throw new Error(`the RGBA data is ${rgba.length} bytes, not ${expected} bytes`);

  const strip = await stripParts(rgba, width, height, compression, Math.max(1, Math.floor(rowsPerChunk)));
  const stripLength = strip.reduce((n, p) => n + p.length, 0);
  const resolution = Math.max(1, Math.round(dpi * 100));

  const stripOffset = 8;
  // Word-aligned, as TIFF asks of the IFD and of values stored outside it.
  const padding = stripLength % 2;
  const ifdOffset = stripOffset + stripLength + padding;
  const entries: Entry[] = [
    { tag: 256, type: LONG, values: [width] },
    { tag: 257, type: LONG, values: [height] },
    { tag: 258, type: SHORT, values: [8, 8, 8] },
    { tag: 259, type: SHORT, values: [compression === "deflate" ? 8 : 1] },
    { tag: 262, type: SHORT, values: [2] },
    { tag: 273, type: LONG, values: [stripOffset] },
    { tag: 277, type: SHORT, values: [3] },
    { tag: 278, type: LONG, values: [height] },
    { tag: 279, type: LONG, values: [stripLength] },
    { tag: 282, type: RATIONAL, values: [resolution, 100] },
    { tag: 283, type: RATIONAL, values: [resolution, 100] },
    { tag: 284, type: SHORT, values: [1] },
    { tag: 296, type: SHORT, values: [2] },
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const sizeOf = (e: Entry) => (e.type === SHORT ? 2 : 4) * e.values.length;
  const extraSize = entries.reduce((n, e) => n + (sizeOf(e) > 4 ? sizeOf(e) + (sizeOf(e) % 2) : 0), 0);

  const header = new Uint8Array(8);
  header.set([0x49, 0x49, 42, 0]);
  new DataView(header.buffer).setUint32(4, ifdOffset, true);

  // The IFD part starts at `ifdOffset` in the file; offsets in it are file offsets.
  const ifd = new Uint8Array(ifdSize + extraSize);
  const view = new DataView(ifd.buffer);
  view.setUint16(0, entries.length, true);
  let extra = ifdSize;
  const writeValues = (at: number, e: Entry) => {
    for (const [i, v] of e.values.entries()) {
      if (e.type === SHORT) view.setUint16(at + i * 2, v, true);
      else view.setUint32(at + i * 4, v, true);
    }
  };
  for (const [i, e] of entries.entries()) {
    const at = 2 + i * 12;
    view.setUint16(at, e.tag, true);
    view.setUint16(at + 2, e.type, true);
    // A rational is two longs but one value.
    view.setUint32(at + 4, e.type === RATIONAL ? e.values.length / 2 : e.values.length, true);
    if (sizeOf(e) <= 4) {
      writeValues(at + 8, e);
    } else {
      view.setUint32(at + 8, ifdOffset + extra, true);
      writeValues(extra, e);
      extra += sizeOf(e) + (sizeOf(e) % 2);
    }
  }
  view.setUint32(2 + entries.length * 12, 0, true);
  return [header, ...strip, ...(padding ? [new Uint8Array(1)] : []), ifd];
}
