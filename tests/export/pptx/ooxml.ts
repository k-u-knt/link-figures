import { Window } from "happy-dom";
import { crc32 as zlibCrc32, inflateRawSync } from "node:zlib";

/** One entry of a ZIP as the central directory describes it, with its data inflated and its CRC checked. */
export interface ZipEntry {
  name: string;
  method: number;
  data: Uint8Array;
}

/**
 * The entries of a ZIP, read independently of the writer: the end-of-central-directory record, then each central
 * directory entry and its local header (which must agree), inflated with node's zlib; throws on a bad CRC or size.
 */
export function unzip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error("no end of central directory record at the end");
  const count = view.getUint16(eocd + 10, true);
  if (view.getUint16(eocd + 8, true) !== count) throw new Error("entry counts disagree");
  const cdSize = view.getUint32(eocd + 12, true);
  let p = view.getUint32(eocd + 16, true);
  if (p + cdSize !== eocd) throw new Error("central directory does not end at the EOCD record");
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central header ${i}`);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nlen = view.getUint16(p + 28, true);
    const elen = view.getUint16(p + 30, true);
    const clen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;

    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    if (view.getUint16(local + 8, true) !== method) throw new Error(`method differs for ${name}`);
    if (view.getUint32(local + 14, true) !== crc) throw new Error(`crc differs for ${name}`);
    if (view.getUint32(local + 18, true) !== csize || view.getUint32(local + 22, true) !== usize) throw new Error(`sizes differ for ${name}`);
    const lnlen = view.getUint16(local + 26, true);
    const lelen = view.getUint16(local + 28, true);
    if (decoder.decode(zip.subarray(local + 30, local + 30 + lnlen)) !== name) throw new Error(`name differs for ${name}`);
    const start = local + 30 + lnlen + lelen;
    const raw = zip.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`method ${method} for ${name}`);
    if (data.byteLength !== usize) throw new Error(`size of ${name} is ${data.byteLength}, not ${usize}`);
    if (zlibCrc32(data) !== crc) throw new Error(`bad crc for ${name}`);
    entries.push({ name, method, data });
  }
  return entries;
}

/** The entries of a ZIP by name, as text. */
export function unzipText(zip: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder();
  return new Map(unzip(zip).map((e) => [e.name, decoder.decode(e.data)]));
}

const parser = new new Window().DOMParser();

/**
 * `text` parsed as XML; throws when it is not well formed. happy-dom catches unbalanced tags and unbound prefixes; an
 * `&` that starts no predefined or numeric entity, and a repeated attribute, are checked here. (happy-dom drops a
 * prefixed attribute whose local name an earlier attribute of the element has, `id` then `r:id`; the writer puts
 * `r:id` first.)
 */
export function parseXml(text: string): globalThis.Document {
  if (!text.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')) throw new Error("no XML declaration");
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) throw new Error("a bare &");
  for (const tag of text.match(/<[^!?/][^>]*>/g) ?? []) {
    const names = [...tag.matchAll(/\s([\w:.-]+)\s*=/g)].map((m) => m[1]);
    if (new Set(names).size !== names.length) throw new Error(`a repeated attribute in ${tag}`);
  }
  const doc = parser.parseFromString(text.slice(text.indexOf("?>") + 2), "application/xml") as unknown as globalThis.Document;
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error(`not well formed: ${text.slice(0, 200)}`);
  return doc;
}

/** Every element of `doc` whose qualified name is `name` (`"a:off"`). */
export function all(doc: globalThis.Document | Element, name: string): Element[] {
  return Array.from(doc.getElementsByTagName(name));
}

/** The one element named `name` under `doc`; throws when there is not exactly one. */
export function one(doc: globalThis.Document | Element, name: string): Element {
  const found = all(doc, name);
  if (found.length !== 1) throw new Error(`${found.length} <${name}>`);
  return found[0];
}

/** `slide` (an spTree fragment) wrapped so it parses with the DrawingML and PresentationML prefixes bound. */
export function parseFragment(fragment: string): globalThis.Document {
  return parseXml(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<root xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      fragment +
      "</root>",
  );
}
