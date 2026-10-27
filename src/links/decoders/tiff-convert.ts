import type { Range16 } from "../../model/types";

/** Interleaved samples, row-major. */
export interface Plane {
  width: number;
  height: number;
  bitsPerSample: 8 | 16;
  samplesPerPixel: 1 | 3 | 4;
  data: Uint8Array | Uint16Array;
}

/** Min and max of `data`; an empty array gives `{ min: 0, max: 0 }`. */
export function autoRange(data: Uint8Array | Uint16Array): Range16 {
  if (data.length === 0) return { min: 0, max: 0 };
  let min = data[0];
  let max = data[0];
  for (let i = 1; i < data.length; i++) {
    const value = data[i];
    if (value < min) min = value;
    else if (value > max) max = value;
  }
  return { min, max };
}

/** Sample value to 0..255. A range with `max <= min` maps everything to 0 (never NaN). */
function lookupTable(bitsPerSample: 8 | 16, range: Range16): Uint8ClampedArray {
  const table = new Uint8ClampedArray(1 << bitsPerSample);
  const span = range.max - range.min;
  if (span > 0) {
    // Multiply before dividing so exact halves stay exact (127.5, not 127.49999999999999); the clamped array clips to 0..255.
    for (let value = 0; value < table.length; value++) table[value] = Math.round(((value - range.min) * 255) / span);
  }
  return table;
}

/**
 * Maps every channel linearly from `range` to 0..255 and returns the range used. Grey (1 sample) is replicated to RGB
 * with alpha 255. `"auto"` stretches to the data's own min and max, except 8-bit RGB(A), which passes through
 * unchanged (range 0..255).
 */
export function planeToRgba(plane: Plane, range: Range16 | "auto"): { rgba: Uint8ClampedArray<ArrayBuffer>; range: Range16 } {
  const { width, height, bitsPerSample, samplesPerPixel, data } = plane;
  const used = range !== "auto" ? range : bitsPerSample === 8 && samplesPerPixel > 1 ? { min: 0, max: 255 } : autoRange(data);
  const table = lookupTable(bitsPerSample, used);
  const pixels = width * height;
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const source = i * samplesPerPixel;
    const target = i * 4;
    if (samplesPerPixel === 1) {
      rgba[target] = rgba[target + 1] = rgba[target + 2] = table[data[source]];
      rgba[target + 3] = 255;
    } else {
      rgba[target] = table[data[source]];
      rgba[target + 1] = table[data[source + 1]];
      rgba[target + 2] = table[data[source + 2]];
      rgba[target + 3] = samplesPerPixel === 4 ? table[data[source + 3]] : 255;
    }
  }
  return { rgba, range: used };
}

/**
 * A decoded UTIF IFD as a `Plane`. `isLE` is the byte order of `ifd.data`; 16-bit samples are copied into a fresh
 * `Uint16Array`, so the data's alignment never matters.
 */
export function ifdToPlane(ifd: { width: number; height: number; t258?: number[]; t277?: number[]; data: Uint8Array; isLE: boolean }): Plane {
  const bitsPerSample = ifd.t258?.[0];
  const samplesPerPixel = ifd.t277?.[0] ?? 1;
  if (bitsPerSample !== 8 && bitsPerSample !== 16) throw new Error(`Unsupported TIFF: ${bitsPerSample ?? 1}-bit samples (8 and 16 are supported)`);
  if (samplesPerPixel !== 1 && samplesPerPixel !== 3 && samplesPerPixel !== 4) throw new Error(`Unsupported TIFF: ${samplesPerPixel} samples per pixel (1, 3 and 4 are supported)`);

  const count = ifd.width * ifd.height * samplesPerPixel;
  const byteCount = count * (bitsPerSample / 8);
  if (ifd.data.length < byteCount) throw new Error("TIFF pixel data is shorter than its dimensions");

  const { width, height } = ifd;
  if (bitsPerSample === 8) return { width, height, bitsPerSample, samplesPerPixel, data: ifd.data.subarray(0, count) };

  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, byteCount);
  const data = new Uint16Array(count);
  for (let i = 0; i < count; i++) data[i] = view.getUint16(i * 2, ifd.isLE);
  return { width, height, bitsPerSample, samplesPerPixel, data };
}
