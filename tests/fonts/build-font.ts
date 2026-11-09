/**
 * Builds minimal but valid TrueType fonts in code, so tests never need system fonts. Every glyph is a square; the
 * cmap is a format-4 (3,1) subtable, which is what jsPDF requires. tests/fonts/sfnt.test.ts loads these in jsPDF.
 */
import { sfntTables, writeSfnt, type SfntTable } from "../../src/fonts/sfnt";

export type BuildStyle = "Regular" | "Bold" | "Italic" | "Bold Italic";

export interface BuildFontOptions {
  family: string;
  style: BuildStyle;
  /** The characters the cmap maps, each to its own glyph. BMP only. */
  chars: string;
  /** The sfnt version tag. "OTTO" only relabels the font (the outlines stay TrueType), for flavour detection. */
  flavour?: "true" | "00010000" | "OTTO";
  /** Adds an `fvar` table, making the font variable. */
  fvar?: boolean;
  /** Adds this many unmapped glyphs, to make the font larger. */
  padGlyphs?: number;
}

const UNITS_PER_EM = 1000;
const ADVANCE = 700;
const ASCENT = 800;
const DESCENT = -200;
/** The square every glyph draws: (100,0) to (600,700). */
const SQUARE = { xMin: 100, yMin: 0, xMax: 600, yMax: 700 };

class Writer {
  private bytes: number[] = [];
  u8(n: number) {
    this.bytes.push(n & 0xff);
    return this;
  }
  u16(n: number) {
    return this.u8(n >> 8).u8(n);
  }
  i16(n: number) {
    return this.u16(n & 0xffff);
  }
  u32(n: number) {
    return this.u16(n >>> 16).u16(n & 0xffff);
  }
  tag(t: string) {
    for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i));
    return this;
  }
  raw(data: Uint8Array) {
    for (const b of data) this.bytes.push(b);
    return this;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.bytes.push(0);
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

const utf16be = (text: string) => {
  const w = new Writer();
  for (let i = 0; i < text.length; i++) w.u16(text.charCodeAt(i));
  return w.done();
};

/** One closed square contour of four on-curve points, clockwise. */
const squareGlyph = () => {
  const w = new Writer().i16(1).i16(SQUARE.xMin).i16(SQUARE.yMin).i16(SQUARE.xMax).i16(SQUARE.yMax);
  w.u16(3).u16(0); // endPtsOfContours[0], instructionLength
  for (let i = 0; i < 4; i++) w.u8(0x01); // on curve, x and y as int16 deltas
  for (const dx of [SQUARE.xMin, 0, SQUARE.xMax - SQUARE.xMin, 0]) w.i16(dx);
  for (const dy of [SQUARE.yMin, SQUARE.yMax, 0, -SQUARE.yMax]) w.i16(dy);
  while (w.length % 4) w.u8(0);
  return w.done();
};

const head = (bold: boolean, italic: boolean) =>
  new Writer()
    .u32(0x00010000) // version
    .u32(0x00010000) // fontRevision
    .u32(0) // checkSumAdjustment, set by writeSfnt
    .u32(0x5f0f3cf5) // magicNumber
    .u16(0x000b) // flags
    .u16(UNITS_PER_EM)
    .zeros(16) // created, modified
    .i16(SQUARE.xMin)
    .i16(SQUARE.yMin)
    .i16(SQUARE.xMax)
    .i16(SQUARE.yMax)
    .u16((bold ? 1 : 0) | (italic ? 2 : 0)) // macStyle
    .u16(8) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(1) // indexToLocFormat: long offsets
    .i16(0) // glyphDataFormat
    .done();

const hhea = (numGlyphs: number) =>
  new Writer()
    .u32(0x00010000)
    .i16(ASCENT)
    .i16(DESCENT)
    .i16(0) // lineGap
    .u16(ADVANCE) // advanceWidthMax
    .i16(SQUARE.xMin) // minLeftSideBearing
    .i16(ADVANCE - SQUARE.xMax) // minRightSideBearing
    .i16(SQUARE.xMax) // xMaxExtent
    .i16(1) // caretSlopeRise
    .i16(0) // caretSlopeRun
    .i16(0) // caretOffset
    .zeros(8) // reserved
    .i16(0) // metricDataFormat
    .u16(numGlyphs) // numberOfHMetrics
    .done();

const maxp = (numGlyphs: number) =>
  new Writer()
    .u32(0x00010000)
    .u16(numGlyphs)
    .u16(4) // maxPoints
    .u16(1) // maxContours
    .u16(0) // maxCompositePoints
    .u16(0) // maxCompositeContours
    .u16(2) // maxZones
    .zeros(16) // twilight points .. component depth
    .done();

const hmtx = (numGlyphs: number) => {
  const w = new Writer();
  for (let i = 0; i < numGlyphs; i++) w.u16(ADVANCE).i16(SQUARE.xMin);
  return w.done();
};

/** A format-4 subtable with one segment per character, plus the closing 0xFFFF segment. */
const cmap = (codes: Map<number, number>) => {
  const sorted = [...codes.entries()].sort((a, b) => a[0] - b[0]);
  const segments = [...sorted.map(([code, glyph]) => ({ start: code, end: code, delta: glyph - code })), { start: 0xffff, end: 0xffff, delta: 1 }];
  const count = segments.length;
  const power = 2 ** Math.floor(Math.log2(count));
  const sub = new Writer()
    .u16(4)
    .u16(16 + 8 * count) // length
    .u16(0) // language
    .u16(2 * count)
    .u16(2 * power)
    .u16(Math.log2(power))
    .u16(2 * count - 2 * power);
  for (const s of segments) sub.u16(s.end);
  sub.u16(0); // reservedPad
  for (const s of segments) sub.u16(s.start);
  for (const s of segments) sub.i16(s.delta);
  for (let i = 0; i < count; i++) sub.u16(0); // idRangeOffset
  return new Writer().u16(0).u16(1).u16(3).u16(1).u32(12).raw(sub.done()).done();
};

const name = (records: [number, string][]) => {
  const strings = records.map(([id, text]) => [id, utf16be(text)] as const);
  const w = new Writer().u16(0).u16(strings.length).u16(6 + 12 * strings.length);
  let offset = 0;
  for (const [id, data] of strings) {
    w.u16(3).u16(1).u16(0x409).u16(id).u16(data.length).u16(offset);
    offset += data.length;
  }
  for (const [, data] of strings) w.raw(data);
  return w.done();
};

const post = (italic: boolean) =>
  new Writer()
    .u32(0x00030000) // format 3: no glyph names
    .u32(italic ? (-12 << 16) >>> 0 : 0) // italicAngle
    .i16(-100) // underlinePosition
    .i16(50) // underlineThickness
    .u32(0) // isFixedPitch
    .zeros(16) // memory hints
    .done();

const os2 = (bold: boolean, italic: boolean, codes: number[]) =>
  new Writer()
    .u16(4) // version
    .i16(ADVANCE) // xAvgCharWidth
    .u16(bold ? 700 : 400)
    .u16(5) // usWidthClass
    .u16(0) // fsType: installable
    .zeros(16) // sub/superscript sizes and offsets
    .i16(50) // yStrikeoutSize
    .i16(300) // yStrikeoutPosition
    .i16(0) // sFamilyClass: none (sans)
    .zeros(10) // panose
    .zeros(16) // ulUnicodeRange1-4
    .tag("NONE") // achVendID
    .u16((italic ? 0x01 : 0) | (bold ? 0x20 : 0) | (!bold && !italic ? 0x40 : 0)) // fsSelection
    .u16(codes.length ? Math.min(...codes) : 0)
    .u16(codes.length ? Math.max(...codes) : 0)
    .i16(ASCENT) // sTypoAscender
    .i16(DESCENT) // sTypoDescender
    .i16(0) // sTypoLineGap
    .u16(ASCENT) // usWinAscent
    .u16(-DESCENT) // usWinDescent
    .zeros(8) // ulCodePageRange1-2
    .i16(500) // sxHeight
    .i16(700) // sCapHeight
    .u16(0) // usDefaultChar
    .u16(32) // usBreakChar
    .u16(1) // usMaxContext
    .done();

/** A minimal `fvar` header with no axes or instances; its presence is what marks a variable font. */
const fvar = () => new Writer().u16(1).u16(0).u16(16).u16(2).u16(0).u16(20).u16(0).u16(4).done();

const VERSIONS = { "00010000": [0, 1, 0, 0], true: [0x74, 0x72, 0x75, 0x65], OTTO: [0x4f, 0x54, 0x54, 0x4f] } as const;

export function buildFont(options: BuildFontOptions): Uint8Array {
  const { family, style, chars, flavour = "00010000", padGlyphs = 0 } = options;
  const bold = style.includes("Bold");
  const italic = style.includes("Italic");
  const codes = new Map<number, number>();
  for (const char of chars) {
    const code = char.codePointAt(0)!;
    if (code > 0xffff) throw new Error(`buildFont: "${char}" is outside the BMP`);
    if (!codes.has(code)) codes.set(code, codes.size + 1); // glyph 0 is .notdef
  }
  const numGlyphs = 1 + codes.size + padGlyphs;
  const glyph = squareGlyph();
  const glyf = new Uint8Array(glyph.length * numGlyphs);
  const loca = new Writer();
  for (let i = 0; i < numGlyphs; i++) {
    glyf.set(glyph, i * glyph.length);
    loca.u32(i * glyph.length);
  }
  loca.u32(numGlyphs * glyph.length);
  const fullName = `${family} ${style}`;
  const postscriptName = `${family.replace(/\s/g, "")}-${style.replace(/\s/g, "")}`;
  const tables: SfntTable[] = [
    { tag: "head", data: head(bold, italic) },
    { tag: "hhea", data: hhea(numGlyphs) },
    { tag: "maxp", data: maxp(numGlyphs) },
    { tag: "hmtx", data: hmtx(numGlyphs) },
    { tag: "cmap", data: cmap(codes) },
    { tag: "loca", data: loca.done() },
    { tag: "glyf", data: glyf },
    {
      tag: "name",
      data: name([
        [1, family],
        [2, style],
        [4, fullName],
        [6, postscriptName],
        [16, family],
        [17, style],
      ]),
    },
    { tag: "post", data: post(italic) },
    { tag: "OS/2", data: os2(bold, italic, [...codes.keys()]) },
  ];
  if (options.fvar) tables.push({ tag: "fvar", data: fvar() });
  return writeSfnt(Uint8Array.from(VERSIONS[flavour]), tables);
}

/** A TrueType Collection (`ttcf` version 1) holding each font's tables unshared. */
export function buildCollection(fonts: Uint8Array[]): Uint8Array {
  const parsed = fonts.map((font) => ({ version: font.subarray(0, 4), tables: sfntTables(font) }));
  const header = 12 + 4 * fonts.length;
  const directories = parsed.reduce((sum, f) => sum + 12 + 16 * f.tables.length, 0);
  const padded = (n: number) => (n + 3) & ~3;
  const out = new Writer().tag("ttcf").u32(0x00010000).u32(fonts.length);
  let directory = header;
  for (const f of parsed) {
    out.u32(directory);
    directory += 12 + 16 * f.tables.length;
  }
  let data = header + directories;
  const bodies: Uint8Array[] = [];
  for (const f of parsed) {
    const n = f.tables.length;
    const power = 2 ** Math.floor(Math.log2(n));
    out.raw(f.version).u16(n).u16(power * 16).u16(Math.log2(power)).u16(n * 16 - power * 16);
    for (const t of f.tables) {
      out.tag(t.tag).u32(0).u32(data).u32(t.data.length);
      const body = new Uint8Array(padded(t.data.length));
      body.set(t.data);
      bodies.push(body);
      data += body.length;
    }
  }
  for (const body of bodies) out.raw(body);
  return out.done();
}
