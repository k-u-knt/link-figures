/**
 * Small readers for sfnt font files (TrueType, OpenType/CFF, TrueType Collections), as far as PDF export needs:
 * which outline flavour a file has, the faces in a collection, a face's names, whether it is variable, and which
 * characters its cmap covers. Malformed input throws; callers treat that as "unreadable".
 */

export type SfntFlavour = "truetype" | "cff" | "collection" | "unknown";

export interface FaceNames {
  family: string;
  subfamily: string;
  fullName: string;
  postscriptName: string;
}

export interface SfntTable {
  tag: string;
  data: Uint8Array;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tagAt = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

export function sfntFlavour(bytes: Uint8Array): SfntFlavour {
  if (bytes.length < 4) return "unknown";
  const tag = tagAt(bytes, 0);
  if (tag === "\x00\x01\x00\x00" || tag === "true") return "truetype";
  if (tag === "OTTO") return "cff";
  if (tag === "ttcf") return "collection";
  return "unknown";
}

/** The tables of the sfnt whose table directory starts at `offset` (0 for a standalone font), in directory order. */
export function sfntTables(bytes: Uint8Array, offset = 0): SfntTable[] {
  const v = view(bytes);
  const count = v.getUint16(offset + 4);
  const tables: SfntTable[] = [];
  for (let i = 0; i < count; i++) {
    const record = offset + 12 + 16 * i;
    const tag = tagAt(bytes, record);
    const start = v.getUint32(record + 8);
    const length = v.getUint32(record + 12);
    if (start + length > bytes.length) throw new Error(`sfnt table "${tag}" is out of bounds`);
    tables.push({ tag, data: bytes.subarray(start, start + length) });
  }
  return tables;
}

const checksum = (bytes: Uint8Array, start: number, length: number) => {
  let sum = 0;
  for (let i = 0; i < length; i += 4) {
    const word = ((bytes[start + i] ?? 0) << 24) | ((bytes[start + i + 1] ?? 0) << 16) | ((bytes[start + i + 2] ?? 0) << 8) | (bytes[start + i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
};

/** A standalone sfnt from a 4-byte version tag and tables, with tables sorted, 4-byte aligned and checksummed. */
export function writeSfnt(version: Uint8Array, tables: SfntTable[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const count = sorted.length;
  const headerLength = 12 + 16 * count;
  const padded = (n: number) => (n + 3) & ~3;
  const total = sorted.reduce((sum, t) => sum + padded(t.data.length), headerLength);
  const out = new Uint8Array(total);
  const v = view(out);
  out.set(version.subarray(0, 4), 0);
  const power = count > 0 ? 2 ** Math.floor(Math.log2(count)) : 0;
  v.setUint16(4, count);
  v.setUint16(6, power * 16);
  v.setUint16(8, power > 0 ? Math.log2(power) : 0);
  v.setUint16(10, count * 16 - power * 16);
  let offset = headerLength;
  let headOffset = -1;
  sorted.forEach((table, i) => {
    out.set(table.data, offset);
    if (table.tag === "head" && table.data.length >= 12) {
      headOffset = offset;
      v.setUint32(offset + 8, 0);
    }
    const record = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[record + k] = table.tag.charCodeAt(k);
    v.setUint32(record + 4, checksum(out, offset, table.data.length));
    v.setUint32(record + 8, offset);
    v.setUint32(record + 12, table.data.length);
    offset += padded(table.data.length);
  });
  if (headOffset >= 0) v.setUint32(headOffset + 8, (0xb1b0afba - checksum(out, 0, out.length)) >>> 0);
  return out;
}

/** Each face of a TrueType Collection as a standalone sfnt; an empty list for anything that is not a collection. */
export function collectionFaces(bytes: Uint8Array): Uint8Array[] {
  if (sfntFlavour(bytes) !== "collection") return [];
  const v = view(bytes);
  const count = v.getUint32(8);
  const faces: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const offset = v.getUint32(12 + 4 * i);
    faces.push(writeSfnt(bytes.subarray(offset, offset + 4), sfntTables(bytes, offset)));
  }
  return faces;
}

/**
 * One table of a standalone font, or of a collection's first face; undefined when the font has none. Only that table
 * is bounds-checked, so a truncated table the caller does not read (a short `DSIG`, say) does not make it throw.
 */
const table = (bytes: Uint8Array, tag: string): Uint8Array | undefined => {
  const flavour = sfntFlavour(bytes);
  if (flavour === "unknown") throw new Error("not an sfnt font");
  const v = view(bytes);
  const offset = flavour === "collection" ? v.getUint32(12) : 0;
  const count = v.getUint16(offset + 4);
  for (let i = 0; i < count; i++) {
    const record = offset + 12 + 16 * i;
    if (record + 16 > bytes.length) throw new Error("sfnt table directory is truncated");
    if (tagAt(bytes, record) !== tag) continue;
    const start = v.getUint32(record + 8);
    const length = v.getUint32(record + 12);
    if (start + length > bytes.length) throw new Error(`sfnt table "${tag}" is out of bounds`);
    return bytes.subarray(start, start + length);
  }
  return undefined;
};

const utf16be = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return text;
};

const macRoman = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("macintosh").decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
};

/** Lower is better: Windows US English, any Windows, Unicode, then Mac Roman English. */
const namePriority = (platform: number, encoding: number, language: number) => {
  if (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10)) return language === 0x409 ? 0 : 1;
  if (platform === 0) return 2;
  if (platform === 1 && encoding === 0 && language === 0) return 3;
  return -1;
};

/** The face's names, preferring the typographic family/subfamily (IDs 16/17) over the legacy ones (1/2). */
export function faceNames(bytes: Uint8Array): FaceNames {
  const data = table(bytes, "name");
  if (!data) throw new Error("font has no name table");
  const v = view(data);
  const count = v.getUint16(2);
  const storage = v.getUint16(4);
  const best = new Map<number, { priority: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const record = 6 + 12 * i;
    const platform = v.getUint16(record);
    const encoding = v.getUint16(record + 2);
    const language = v.getUint16(record + 4);
    const id = v.getUint16(record + 6);
    const priority = namePriority(platform, encoding, language);
    if (priority < 0 || (best.get(id)?.priority ?? Infinity) <= priority) continue;
    const start = storage + v.getUint16(record + 10);
    const raw = data.subarray(start, start + v.getUint16(record + 8));
    best.set(id, { priority, text: platform === 1 ? macRoman(raw) : utf16be(raw) });
  }
  const name = (...ids: number[]) => ids.map((id) => best.get(id)?.text).find((text) => text) ?? "";
  return { family: name(16, 1), subfamily: name(17, 2), fullName: name(4), postscriptName: name(6) };
}

/** True when the font is variable (has an `fvar` table). */
export function hasVariations(bytes: Uint8Array): boolean {
  if (sfntFlavour(bytes) === "unknown") return false;
  return table(bytes, "fvar") !== undefined;
}

/**
 * Whether a code point maps to a real glyph, read from the same cmap jsPDF uses: the first format-4 subtable for
 * Windows Unicode BMP (3,1) or any Unicode platform (0,*). jsPDF draws UTF-16 units through that table, so code
 * points outside the BMP are never covered. A font with no such subtable covers nothing.
 */
export function cmapCovers(bytes: Uint8Array): (codePoint: number) => boolean {
  const data = table(bytes, "cmap");
  if (!data) return () => false;
  const v = view(data);
  const count = v.getUint16(2);
  let sub = -1;
  for (let i = 0; i < count && sub < 0; i++) {
    const platform = v.getUint16(4 + 8 * i);
    const encoding = v.getUint16(6 + 8 * i);
    const offset = v.getUint32(8 + 8 * i);
    if (((platform === 3 && encoding === 1) || platform === 0) && v.getUint16(offset) === 4) sub = offset;
  }
  if (sub < 0) return () => false;
  const segments = v.getUint16(sub + 6) / 2;
  // Check the four segment arrays now, so a caller's try/catch around this call sees a malformed table.
  if (sub + 14 + 8 * segments + 2 > data.length) throw new Error("cmap format-4 subtable is truncated");
  const ends = sub + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const rangeOffsets = deltas + 2 * segments;
  const glyphOf = (code: number) => {
    for (let i = 0; i < segments; i++) {
      if (v.getUint16(ends + 2 * i) < code) continue;
      const start = v.getUint16(starts + 2 * i);
      if (start > code) return 0;
      const delta = v.getUint16(deltas + 2 * i);
      const rangeOffset = v.getUint16(rangeOffsets + 2 * i);
      if (rangeOffset === 0) return (code + delta) & 0xffff;
      const at = rangeOffsets + 2 * i + rangeOffset + 2 * (code - start);
      if (at + 2 > data.length) return 0;
      const glyph = v.getUint16(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
  return (codePoint) => codePoint >= 0 && codePoint <= 0xffff && glyphOf(codePoint) !== 0;
}

/** The characters of `text` the font has no glyph for, each once, in order of first appearance. */
export function missingChars(bytes: Uint8Array, text: string): string[] {
  const covers = cmapCovers(bytes);
  const missing: string[] = [];
  for (const char of text) {
    if (!missing.includes(char) && !covers(char.codePointAt(0)!)) missing.push(char);
  }
  return missing;
}
