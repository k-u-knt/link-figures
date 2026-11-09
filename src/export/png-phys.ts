const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const METRES_PER_INCH = 0.0254;

let crcTable: Uint32Array | undefined;

/** The CRC-32 that PNG chunks carry (ISO 3309, as zlib's). */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A whole chunk: length, type, data and the CRC over type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A `pHYs` chunk: the dpi in pixels per metre both ways (unit 1 = metre). */
function physChunk(dpi: number): Uint8Array {
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  const perMetre = Math.round(dpi / METRES_PER_INCH);
  view.setUint32(0, perMetre);
  view.setUint32(4, perMetre);
  data[8] = 1;
  return chunk("pHYs", data);
}

/** An `sRGB` chunk with the perceptual rendering intent (0): the canvas draws in sRGB. */
const srgbChunk = () => chunk("sRGB", Uint8Array.of(0));

/**
 * The PNG with its resolution set to `dpi` and marked as sRGB, as parts to be written one after another (a Blob of
 * them), so that the image data is not copied: a `pHYs` and an `sRGB` chunk just before the first `IDAT`, and any
 * `pHYs` or `sRGB` it had left out. A PNG with an ICC profile (`iCCP`) gets no `sRGB`, as the two must not both be
 * there. Every other chunk is kept as it was, as a view of the input.
 */
export function withPhys(png: Uint8Array, dpi: number): Uint8Array[] {
  if (png.length < SIGNATURE.length || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("the bytes are not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [png.subarray(0, SIGNATURE.length)];
  let placed = false;
  let hasProfile = false;
  for (let at = SIGNATURE.length; at < png.length; ) {
    if (at + 12 > png.length) throw new Error("the PNG ends inside a chunk");
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > png.length) throw new Error("the PNG ends inside a chunk");
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "iCCP") hasProfile = true;
    if (type === "IDAT" && !placed) {
      parts.push(physChunk(dpi));
      if (!hasProfile) parts.push(srgbChunk());
      placed = true;
    }
    if (type !== "pHYs" && type !== "sRGB") parts.push(png.subarray(at, end));
    at = end;
  }
  if (!placed) throw new Error("the PNG has no IDAT chunk");
  return parts;
}
