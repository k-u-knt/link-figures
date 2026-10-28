/**
 * A tokenizer for PDF content streams (ISO 32000-1 §7.2, §8.9.7): numbers, names, strings, hex strings, array and
 * dictionary brackets, operators, and inline images (`BI … ID … EI`) as single tokens. It is strict: anything it
 * cannot read with certainty throws, and the caller then leaves the stream as it is.
 */

/** The content stream cannot be read with certainty: the caller must not rewrite it. */
export class ContentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentParseError";
  }
}

/**
 * One token, covering the bytes [start, end) of the stream. `value` is the number's text, the name decoded (without its
 * `/`), the string's bytes decoded (one character per byte), the operator's text, the bracket itself, or, for an
 * inline image, the text of its dictionary (between `BI` and `ID`).
 */
export interface Token {
  kind: "number" | "name" | "string" | "hexstring" | "arrayStart" | "arrayEnd" | "dictStart" | "dictEnd" | "operator" | "inlineImage";
  start: number;
  end: number;
  value: string;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** A regular token that starts like a number must be one. */
const NUMBER_START = /^[+\-.0-9]/;

function isWhite(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
}

function isDelimiter(b: number): boolean {
  // ( ) < > [ ] { } / %
  return b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d || b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25;
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Reads a content stream into tokens; comments and whitespace are dropped. Throws `ContentParseError` on malformed input. */
export function tokenize(bytes: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (true) {
    const token = next();
    if (!token) break;
    if (token.kind === "operator" && token.value === "BI") tokens.push(inlineImage(token.start));
    else if (token.kind === "operator" && (token.value === "EI" || token.value === "ID")) {
      // Outside an inline image these can only be the rest of one whose data was ended too early.
      throw new ContentParseError(`"${token.value}" outside an inline image at byte ${token.start}`);
    } else tokens.push(token);
  }
  return tokens;

  /** The next token after `pos`, or null at the end of the data. */
  function next(): Token | null {
    skipWhiteAndComments();
    if (pos >= bytes.length) return null;
    const start = pos;
    const b = bytes[pos];
    if (b === 0x28) return literalString(start);
    if (b === 0x3c) {
      if (bytes[pos + 1] === 0x3c) {
        pos += 2;
        return { kind: "dictStart", start, end: pos, value: "<<" };
      }
      return hexString(start);
    }
    if (b === 0x3e) {
      if (bytes[pos + 1] === 0x3e) {
        pos += 2;
        return { kind: "dictEnd", start, end: pos, value: ">>" };
      }
      throw new ContentParseError(`Unexpected ">" at byte ${start}`);
    }
    if (b === 0x5b) {
      pos++;
      return { kind: "arrayStart", start, end: pos, value: "[" };
    }
    if (b === 0x5d) {
      pos++;
      return { kind: "arrayEnd", start, end: pos, value: "]" };
    }
    if (b === 0x2f) return name(start);
    if (b === 0x29 || b === 0x7b || b === 0x7d) throw new ContentParseError(`Unexpected "${String.fromCharCode(b)}" at byte ${start}`);
    while (pos < bytes.length && !isWhite(bytes[pos]) && !isDelimiter(bytes[pos])) pos++;
    const text = latin1(bytes, start, pos);
    if (NUMBER.test(text)) return { kind: "number", start, end: pos, value: text };
    if (NUMBER_START.test(text)) throw new ContentParseError(`Malformed number "${text}" at byte ${start}`);
    // An operator is printable ASCII: anything else is binary data read as content (a misparsed inline image).
    for (let i = start; i < pos; i++) {
      if (bytes[i] < 0x21 || bytes[i] > 0x7e) throw new ContentParseError(`Non-ASCII byte in operator at byte ${i}`);
    }
    return { kind: "operator", start, end: pos, value: text };
  }

  function skipWhiteAndComments(): void {
    while (pos < bytes.length) {
      const b = bytes[pos];
      if (isWhite(b)) pos++;
      else if (b === 0x25) {
        while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
      } else break;
    }
  }

  function name(start: number): Token {
    pos++;
    let value = "";
    while (pos < bytes.length && !isWhite(bytes[pos]) && !isDelimiter(bytes[pos])) {
      const b = bytes[pos];
      if (b === 0x23 && pos + 2 < bytes.length && hexValue(bytes[pos + 1]) >= 0 && hexValue(bytes[pos + 2]) >= 0) {
        value += String.fromCharCode(hexValue(bytes[pos + 1]) * 16 + hexValue(bytes[pos + 2]));
        pos += 3;
      } else {
        value += String.fromCharCode(b);
        pos++;
      }
    }
    return { kind: "name", start, end: pos, value };
  }

  function literalString(start: number): Token {
    pos++;
    let depth = 1;
    let value = "";
    while (pos < bytes.length) {
      const b = bytes[pos++];
      if (b === 0x5c) {
        if (pos >= bytes.length) break;
        const e = bytes[pos++];
        if (e >= 0x30 && e <= 0x37) {
          // Up to three octal digits; overflow past a byte is ignored, as readers do.
          let code = e - 0x30;
          for (let k = 0; k < 2 && pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x37; k++) code = code * 8 + (bytes[pos++] - 0x30);
          value += String.fromCharCode(code & 0xff);
        } else if (e === 0x0d) {
          // A backslash before an end of line continues the string on the next line.
          if (bytes[pos] === 0x0a) pos++;
        } else if (e !== 0x0a) {
          const escapes: Record<number, string> = { 0x6e: "\n", 0x72: "\r", 0x74: "\t", 0x62: "\b", 0x66: "\f" };
          value += escapes[e] ?? String.fromCharCode(e);
        }
      } else if (b === 0x28) {
        depth++;
        value += "(";
      } else if (b === 0x29) {
        depth--;
        if (depth === 0) return { kind: "string", start, end: pos, value };
        value += ")";
      } else if (b === 0x0d) {
        // Any end of line inside a string reads as a line feed.
        if (bytes[pos] === 0x0a) pos++;
        value += "\n";
      } else value += String.fromCharCode(b);
    }
    throw new ContentParseError(`Unterminated string at byte ${start}`);
  }

  function hexString(start: number): Token {
    pos++;
    let value = "";
    let high = -1;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      if (b === 0x3e) {
        if (high >= 0) value += String.fromCharCode(high * 16);
        return { kind: "hexstring", start, end: pos, value };
      }
      if (isWhite(b)) continue;
      const v = hexValue(b);
      if (v < 0) throw new ContentParseError(`Bad hex digit in string at byte ${pos - 1}`);
      if (high < 0) high = v;
      else {
        value += String.fromCharCode(high * 16 + v);
        high = -1;
      }
    }
    throw new ContentParseError(`Unterminated hex string at byte ${start}`);
  }

  /**
   * The inline image starting with `BI` at `start`, through its `EI`. Where its data ends is never guessed from the
   * bytes (binary data can hold anything): it is the length the dictionary declares (/L or /Length), or, for unfiltered
   * data, the length its size, bits per component and colour space give. Whitespace and `EI` must follow it exactly.
   */
  function inlineImage(start: number): Token {
    const dict: Token[] = [];
    let id: Token | null = null;
    for (let t = next(); t; t = next()) {
      if (t.kind === "operator" && t.value === "ID") {
        id = t;
        break;
      }
      if (t.kind === "operator" && t.value === "BI") throw new ContentParseError(`Nested BI at byte ${t.start}`);
      dict.push(t);
    }
    if (!id) throw new ContentParseError(`Inline image without ID at byte ${start}`);
    const dictText = dict.length ? latin1(bytes, dict[0].start, dict[dict.length - 1].end) : "";
    // One whitespace byte separates ID from the data.
    if (!(id.end < bytes.length && isWhite(bytes[id.end]))) throw new ContentParseError(`No whitespace after ID at byte ${id.end}`);
    const dataStart = id.end + 1;

    const length = imageDataLength(inlineImageDict(dict), start);
    let p = dataStart + length;
    if (!(p < bytes.length && isWhite(bytes[p]))) throw new ContentParseError(`Inline image data not followed by EI at byte ${start}`);
    while (p < bytes.length && isWhite(bytes[p])) p++;
    if (!endsAt(p)) throw new ContentParseError(`Inline image data not followed by EI at byte ${start}`);
    pos = p + 2;
    return { kind: "inlineImage", start, end: pos, value: dictText };
  }

  /** True when an `EI` operator stands at `p`: "EI" followed by whitespace or the end of the data. */
  function endsAt(p: number): boolean {
    return bytes[p] === 0x45 && bytes[p + 1] === 0x49 && (p + 2 === bytes.length || isWhite(bytes[p + 2]));
  }
}

/** A value in an inline image's dictionary: a single token, or the tokens of an array or dictionary (brackets excluded). */
type DictValue = { token: Token } | { items: Token[] };

/** An inline image's dictionary, by key. Throws when it is not a sequence of name keys and values. */
function inlineImageDict(tokens: Token[]): Map<string, DictValue> {
  const dict = new Map<string, DictValue>();
  let i = 0;
  while (i < tokens.length) {
    const key = tokens[i++];
    if (key.kind !== "name" || i >= tokens.length) throw new ContentParseError(`Bad inline image dictionary at byte ${key.start}`);
    const first = tokens[i++];
    if (first.kind === "arrayStart" || first.kind === "dictStart") {
      const items: Token[] = [];
      let depth = 1;
      while (i < tokens.length) {
        const t = tokens[i++];
        if (t.kind === "arrayStart" || t.kind === "dictStart") depth++;
        if (t.kind === "arrayEnd" || t.kind === "dictEnd") depth--;
        if (depth === 0) break;
        items.push(t);
      }
      if (depth !== 0) throw new ContentParseError(`Bad inline image dictionary at byte ${first.start}`);
      dict.set(key.value, { items });
    } else if (first.kind === "arrayEnd" || first.kind === "dictEnd") {
      throw new ContentParseError(`Bad inline image dictionary at byte ${first.start}`);
    } else dict.set(key.value, { token: first });
  }
  return dict;
}

/** The value under either of two keys (an inline image's abbreviation and full name). */
function lookup(dict: Map<string, DictValue>, short: string, long: string): DictValue | undefined {
  return dict.get(short) ?? dict.get(long);
}

function integerValue(value: DictValue | undefined): number | null {
  if (!value || !("token" in value) || value.token.kind !== "number") return null;
  const n = Number(value.token.value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Components per pixel of an inline image's colour space; throws for one that is unknown here. */
function components(value: DictValue | undefined, at: number): number {
  const name = value && "token" in value && value.token.kind === "name" ? value.token.value : null;
  if (name === "G" || name === "DeviceGray") return 1;
  if (name === "RGB" || name === "DeviceRGB") return 3;
  if (name === "CMYK" || name === "DeviceCMYK") return 4;
  if (value && "items" in value && value.items[0]?.kind === "name" && (value.items[0].value === "I" || value.items[0].value === "Indexed")) return 1;
  throw new ContentParseError(`Inline image with a colour space not known here at byte ${at}`);
}

/**
 * The length of an inline image's data: the declared /L (/Length) or, for unfiltered data, height × bytes per row.
 * Throws when it cannot be known exactly.
 */
function imageDataLength(dict: Map<string, DictValue>, at: number): number {
  const declared = lookup(dict, "L", "Length");
  if (declared) {
    const n = integerValue(declared);
    if (n === null) throw new ContentParseError(`Bad inline image length at byte ${at}`);
    return n;
  }
  if (lookup(dict, "F", "Filter")) throw new ContentParseError(`Filtered inline image without a length at byte ${at}`);
  const width = integerValue(lookup(dict, "W", "Width"));
  const height = integerValue(lookup(dict, "H", "Height"));
  const maskValue = lookup(dict, "IM", "ImageMask");
  const mask = !!maskValue && "token" in maskValue && maskValue.token.kind === "operator" && maskValue.token.value === "true";
  const bpc = integerValue(lookup(dict, "BPC", "BitsPerComponent")) ?? (mask ? 1 : null);
  if (width === null || height === null || bpc === null) throw new ContentParseError(`Inline image without its size at byte ${at}`);
  const comps = mask ? 1 : components(lookup(dict, "CS", "ColorSpace"), at);
  return height * Math.ceil((width * bpc * comps) / 8);
}
