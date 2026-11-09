import { jsPDF } from "jspdf";
import {
  cmapCovers,
  collectionFace,
  collectionFaceNames,
  collectionFaces,
  collectionSize,
  faceNames,
  hasVariations,
  missingChars,
  sfntFlavour,
} from "../../src/fonts/sfnt";
import { buildCollection, buildFont } from "./build-font";

const regular = () => buildFont({ family: "Test Sans", style: "Regular", chars: "abc" });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("sfntFlavour", () => {
  test("a TrueType font is truetype, whether tagged 0x00010000 or 'true'", () => {
    expect(sfntFlavour(regular())).toBe("truetype");
    expect(sfntFlavour(buildFont({ family: "T", style: "Regular", chars: "a", flavour: "00010000" }))).toBe("truetype");
    expect(sfntFlavour(buildFont({ family: "T", style: "Regular", chars: "a", flavour: "true" }))).toBe("truetype");
  });

  test("an OTTO font is cff, a ttcf is a collection, and anything else is unknown", () => {
    expect(sfntFlavour(buildFont({ family: "T", style: "Regular", chars: "a", flavour: "OTTO" }))).toBe("cff");
    expect(sfntFlavour(buildCollection([regular()]))).toBe("collection");
    expect(sfntFlavour(new TextEncoder().encode("wOFF0000"))).toBe("unknown");
    expect(sfntFlavour(new Uint8Array([0, 1]))).toBe("unknown");
  });
});

describe("faceNames", () => {
  test("round-trips the family, subfamily, full name and PostScript name", () => {
    expect(faceNames(buildFont({ family: "Test Sans", style: "Bold Italic", chars: "abc" }))).toEqual({
      family: "Test Sans",
      subfamily: "Bold Italic",
      fullName: "Test Sans Bold Italic",
      postscriptName: "TestSans-BoldItalic",
    });
  });
});

describe("collectionFaces", () => {
  test("a two-font collection gives two standalone TrueType faces with the inputs' names", () => {
    const inputs = [
      buildFont({ family: "Test Sans", style: "Regular", chars: "abc" }),
      buildFont({ family: "Test Sans", style: "Bold", chars: "abcd" }),
    ];
    const faces = collectionFaces(buildCollection(inputs));
    expect(faces).toHaveLength(2);
    expect(faces.map(sfntFlavour)).toEqual(["truetype", "truetype"]);
    expect(faces.map(faceNames)).toEqual(inputs.map(faceNames));
    expect(missingChars(faces[1], "abcd")).toEqual([]);
    expect(missingChars(faces[0], "abcd")).toEqual(["d"]);
  });

  test("a non-collection gives no faces", () => {
    expect(collectionFaces(regular())).toEqual([]);
  });

  test("collectionSize, collectionFaceNames and collectionFace read one face without extracting the others", () => {
    const inputs = [
      buildFont({ family: "Test Sans", style: "Regular", chars: "abc" }),
      buildFont({ family: "Test Sans", style: "Bold", chars: "abcd" }),
    ];
    const ttc = buildCollection(inputs);
    expect(collectionSize(ttc)).toBe(2);
    expect(collectionSize(regular())).toBe(0);
    expect(collectionFaceNames(ttc, 1)).toEqual(faceNames(inputs[1]));
    expect(() => collectionFaceNames(regular(), 0)).toThrow(/not a collection/);
    expect(faceNames(collectionFace(ttc, 1))).toEqual(faceNames(inputs[1]));
    expect(() => collectionFace(ttc, 2)).toThrow(/no face 2/);
    expect(() => collectionFace(regular(), 0)).toThrow(/not a collection/);
  });
});

describe("hasVariations", () => {
  test("is true only for a font with an fvar table", () => {
    expect(hasVariations(buildFont({ family: "V", style: "Regular", chars: "a", fvar: true }))).toBe(true);
    expect(hasVariations(regular())).toBe(false);
  });
});

describe("cmapCovers and missingChars", () => {
  test("cmapCovers reports exactly the built characters", () => {
    const covers = cmapCovers(regular());
    expect([..."abc"].every((c) => covers(c.codePointAt(0)!))).toBe(true);
    expect(covers("d".codePointAt(0)!)).toBe(false);
    expect(covers(0x1f600)).toBe(false);
  });

  test("missingChars lists each missing character once, in order", () => {
    expect(missingChars(regular(), "abµc−")).toEqual(["µ", "−"]);
    expect(missingChars(regular(), "µaµ−µ")).toEqual(["µ", "−"]);
    expect(missingChars(regular(), "cab")).toEqual([]);
  });

  test("covers non-contiguous and non-ASCII characters", () => {
    const font = buildFont({ family: "T", style: "Regular", chars: "zAµ−a" });
    expect(missingChars(font, "aAzµ−b")).toEqual(["b"]);
  });
});

describe("padGlyphs", () => {
  test("adds unused glyphs and grows the font", () => {
    const small = regular();
    const padded = buildFont({ family: "Test Sans", style: "Regular", chars: "abc", padGlyphs: 2000 });
    expect(padded.length).toBeGreaterThan(small.length + 2000 * 10);
    expect(missingChars(padded, "abcd")).toEqual(["d"]);
  });
});

describe("jsPDF round trip", () => {
  // jsPDF's addFont handler reports parse errors through console.error rather than throwing.
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  const load = (bytes: Uint8Array) => {
    const doc = new jsPDF({ unit: "pt" });
    doc.addFileToVFS("TestSans.ttf", base64(bytes));
    doc.addFont("TestSans.ttf", "Test Sans", "normal", "Identity-H");
    doc.setFont("Test Sans", "normal");
    doc.text("abc", 10, 10);
    return doc;
  };

  test("a built font loads, draws and embeds", () => {
    for (const bytes of [regular(), buildFont({ family: "Test Sans", style: "Regular", chars: "abc", padGlyphs: 50 })]) {
      const doc = load(bytes);
      expect(errors).not.toHaveBeenCalled();
      expect(doc.getTextWidth("abc")).toBeGreaterThan(0);
      const pdf = doc.output();
      expect(pdf).toContain("/FontFile2");
      expect(pdf).toContain("/Subtype /CIDFontType2");
      expect(pdf).toContain("/BaseFont /Test#20Sans");
    }
  });

  test("a collection fails to load (the check above can fail)", () => {
    try {
      load(buildCollection([regular()]));
    } catch {
      // drawing with a font that never loaded may also throw
    }
    expect(errors).toHaveBeenCalled();
  });
});

describe("malformed input", () => {
  // The table directory record for `tag`, so a test can corrupt one entry.
  const record = (bytes: Uint8Array, tag: string) => {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = v.getUint16(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + 16 * i;
      if (String.fromCharCode(...bytes.subarray(at, at + 4)) === tag) return { v, at };
    }
    throw new Error(`no ${tag}`);
  };
  const withHugeTable = (tag: string) => {
    const bytes = regular().slice();
    const { v, at } = record(bytes, tag);
    v.setUint32(at + 12, 0x7fffffff);
    return bytes;
  };
  const garbage = new TextEncoder().encode("this is not a font at all, just text");

  test("an out-of-range table the helper does not read is ignored", () => {
    const bytes = withHugeTable("post");
    expect(faceNames(bytes).family).toBe("Test Sans");
    expect(hasVariations(bytes)).toBe(false);
    expect(missingChars(bytes, "abd")).toEqual(["d"]);
  });

  test("an out-of-range table the helper reads throws", () => {
    expect(() => faceNames(withHugeTable("name"))).toThrow(/out of bounds/);
    expect(() => cmapCovers(withHugeTable("cmap"))).toThrow(/out of bounds/);
  });

  test("a truncated font throws", () => {
    const truncated = regular().subarray(0, 40);
    expect(() => faceNames(truncated)).toThrow();
    expect(() => cmapCovers(truncated)).toThrow();
    expect(() => hasVariations(truncated)).toThrow();
  });

  test("a non-sfnt throws, has no variations and no collection faces", () => {
    expect(() => faceNames(garbage)).toThrow(/not an sfnt/);
    expect(() => cmapCovers(garbage)).toThrow(/not an sfnt/);
    expect(hasVariations(garbage)).toBe(false);
    expect(collectionFaces(garbage)).toEqual([]);
  });

  test("cmapCovers checks the segment arrays when called, not when the result is used", () => {
    const bytes = regular().slice();
    const { v, at } = record(bytes, "cmap");
    const cmap = v.getUint32(at + 8);
    const sub = cmap + v.getUint32(cmap + 8); // the first encoding record's offset
    v.setUint16(sub + 6, 0xfffe); // segCountX2 far beyond the table
    expect(() => cmapCovers(bytes)).toThrow(/cmap/);
  });
});
