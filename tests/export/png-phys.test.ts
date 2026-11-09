import { crc32 } from "node:zlib";
import { withPhys as withPhysParts } from "../../src/export/png-phys";

/** The parts `withPhys` answers with, joined into one file. */
function withPhys(png: Uint8Array, dpi: number): Uint8Array {
  const parts = withPhysParts(png, dpi);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32(Uint8Array.from([...typeBytes, ...data]));
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return [...be(data.length), ...typeBytes, ...data, ...be(crc)];
}

/** A PNG's chunk structure (the IDAT need not decode: `withPhys` never looks inside it). */
function png(...chunks: number[][]): Uint8Array {
  const ihdr = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Uint8Array.from([...SIGNATURE, ...ihdr, ...chunks.flat(), ...chunk("IEND", [])]);
}

interface Chunk {
  type: string;
  data: Uint8Array;
  crcOk: boolean;
}

function readChunks(bytes: Uint8Array): Chunk[] {
  expect([...bytes.subarray(0, 8)]).toEqual(SIGNATURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Chunk[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.slice(at + 8, at + 8 + length);
    const crc = view.getUint32(at + 8 + length);
    out.push({ type, data, crcOk: crc === crc32(bytes.subarray(at + 4, at + 8 + length)) });
    at += 12 + length;
  }
  return out;
}

const idat = chunk("IDAT", [1, 2, 3]);

test("a pHYs chunk with the dpi in pixels per metre goes before the first IDAT, with a valid CRC", () => {
  const out = readChunks(withPhys(png(idat, chunk("IDAT", [4])), 300));
  expect(out.map((c) => c.type)).toEqual(["IHDR", "pHYs", "sRGB", "IDAT", "IDAT", "IEND"]);
  expect(out.every((c) => c.crcOk)).toBe(true);
  const phys = out[1].data;
  expect(phys.length).toBe(9);
  const view = new DataView(phys.buffer);
  // 300 / 0.0254 = 11811.02…
  expect(view.getUint32(0)).toBe(11811);
  expect(view.getUint32(4)).toBe(11811);
  expect(phys[8]).toBe(1);
});

test("an existing pHYs is replaced, wherever it was", () => {
  const old = chunk("pHYs", [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]);
  const out = readChunks(withPhys(png(old, chunk("tEXt", [65, 0, 66]), idat), 600));
  expect(out.map((c) => c.type)).toEqual(["IHDR", "tEXt", "pHYs", "sRGB", "IDAT", "IEND"]);
  expect(new DataView(out[2].data.buffer).getUint32(0)).toBe(Math.round(600 / 0.0254));
  expect(out.every((c) => c.crcOk)).toBe(true);
});

test("the other chunks are kept byte for byte", () => {
  const input = png(chunk("gAMA", [0, 0, 0xb1, 0x8f]), idat);
  const out = withPhys(input, 72);
  const without = readChunks(out).filter((c) => c.type !== "pHYs");
  expect(without.filter((c) => c.type !== "sRGB")).toEqual(readChunks(input).filter((c) => c.type !== "sRGB"));
});

test("bytes that are not a PNG, or one with no IDAT, are refused", () => {
  expect(() => withPhys(Uint8Array.from([1, 2, 3]), 300)).toThrow(/not a PNG/);
  expect(() => withPhys(png(), 300)).toThrow(/IDAT/);
  expect(() => withPhys(png(chunk("PLTE", [0, 0, 0])), 300)).toThrow(/IDAT/);
  const truncated = png(idat).subarray(0, 40);
  expect(() => withPhys(truncated, 300)).toThrow(/PNG/);
});

test("an sRGB chunk (perceptual intent) goes beside pHYs, replacing any the PNG had", () => {
  const out = readChunks(withPhys(png(chunk("sRGB", [3]), idat), 300));
  expect(out.map((c) => c.type)).toEqual(["IHDR", "pHYs", "sRGB", "IDAT", "IEND"]);
  expect([...out[2].data]).toEqual([0]);
  expect(out[2].crcOk).toBe(true);
});

test("a PNG with an ICC profile gets no sRGB chunk, as the two must not both be there", () => {
  const out = readChunks(withPhys(png(chunk("iCCP", [65, 0, 0, 1]), idat), 300));
  expect(out.map((c) => c.type)).toEqual(["IHDR", "iCCP", "pHYs", "IDAT", "IEND"]);
});

test("the input's chunks are passed through as views of it, not copies", () => {
  const input = png(idat);
  const parts = withPhysParts(input, 300);
  expect(parts.some((p) => p.buffer === input.buffer)).toBe(true);
});

test("in a palette PNG, pHYs and sRGB go before the PLTE (sRGB must precede it), not between PLTE and IDAT", () => {
  const plte = chunk("PLTE", [0, 0, 0, 255, 255, 255]);
  const out = readChunks(withPhys(png(plte, chunk("tRNS", [0]), idat), 300));
  expect(out.map((c) => c.type)).toEqual(["IHDR", "pHYs", "sRGB", "PLTE", "tRNS", "IDAT", "IEND"]);
  expect(out.every((c) => c.crcOk)).toBe(true);
  // With an ICC profile (which must also precede PLTE): no sRGB, pHYs still before the PLTE.
  const withProfile = readChunks(withPhys(png(chunk("iCCP", [65, 0, 0, 1]), plte, idat), 300));
  expect(withProfile.map((c) => c.type)).toEqual(["IHDR", "iCCP", "pHYs", "PLTE", "IDAT", "IEND"]);
});
