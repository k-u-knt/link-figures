import { deflateRaw } from "pako";
import { crc32 } from "./png-phys";

/** One file of an archive: `store` keeps it uncompressed (data that is compressed already, as PNG and JPEG are). */
export interface ZipInput {
  name: string;
  data: Uint8Array;
  store?: boolean;
}

/** 1980-01-01 00:00, the earliest DOS date: entries carry a fixed time, so the same input makes the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const VERSION = 20;
/** What a ZIP without ZIP64 holds: 16-bit entry counts, 32-bit sizes and offsets. */
export const MAX_ENTRIES = 0xffff;
export const MAX_BYTES = 0xffffffff;

/**
 * A ZIP archive (no ZIP64, so under 4 GB and 65 535 entries) of `entries`, in their order: each deflated (pako's raw
 * deflate) unless it is to be stored or deflate would not make it smaller. A name that is not ASCII is flagged as UTF-8.
 * Throws on a repeated name, more than MAX_ENTRIES entries, or an entry or archive over MAX_BYTES.
 */
export function zip(entries: readonly ZipInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  if (entries.length > MAX_ENTRIES) throw new Error(`zip: ${entries.length} entries, more than a ZIP without ZIP64 holds (${MAX_ENTRIES})`);
  for (const entry of entries) {
    if (entry.data.byteLength > MAX_BYTES) throw new Error(`zip: "${entry.name}" is larger than a ZIP without ZIP64 holds (4 GB)`);
    if (seen.has(entry.name)) throw new Error(`zip: the name "${entry.name}" is used twice`);
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    const flags = /^[\x20-\x7e]*$/.test(entry.name) ? 0 : UTF8_FLAG;
    const crc = crc32(entry.data);
    let method = 0;
    let body = entry.data;
    if (!entry.store && entry.data.byteLength > 0) {
      const deflated = deflateRaw(entry.data);
      if (deflated.byteLength < entry.data.byteLength) {
        method = 8;
        body = deflated;
      }
    }

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.byteLength, true);
    lv.setUint32(22, entry.data.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, VERSION, true);
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.byteLength, true);
    cv.setUint32(24, entry.data.byteLength, true);
    cv.setUint16(28, name.byteLength, true);
    // Extra and comment lengths, disk number, internal and external attributes: all 0.
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.byteLength + body.byteLength;
    if (offset > MAX_BYTES) throw new Error("zip: the archive would be larger than a ZIP without ZIP64 holds (4 GB)");
  }

  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  if (offset + cdSize > MAX_BYTES) throw new Error("zip: the archive would be larger than a ZIP without ZIP64 holds (4 GB)");
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + end.byteLength);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.byteLength;
  }
  return out;
}
