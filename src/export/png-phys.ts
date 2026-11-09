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

/** A `pHYs` chunk, whole: length, type, the dpi in pixels per metre both ways (unit 1 = metre), and the CRC. */
function physChunk(dpi: number): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const view = new DataView(chunk.buffer);
  const perMetre = Math.round(dpi / METRES_PER_INCH);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, perMetre);
  view.setUint32(12, perMetre);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

/**
 * The PNG with its resolution set to `dpi`: a `pHYs` chunk just before the first `IDAT`, and any `pHYs` it had left
 * out. Every other chunk is kept as it was.
 */
export function withPhys(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < SIGNATURE.length || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("the bytes are not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [png.subarray(0, SIGNATURE.length)];
  let placed = false;
  for (let at = SIGNATURE.length; at < png.length; ) {
    if (at + 12 > png.length) throw new Error("the PNG ends inside a chunk");
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > png.length) throw new Error("the PNG ends inside a chunk");
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT" && !placed) {
      parts.push(physChunk(dpi));
      placed = true;
    }
    if (type !== "pHYs") parts.push(png.subarray(at, end));
    at = end;
  }
  if (!placed) throw new Error("the PNG has no IDAT chunk");
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
