import { ContentParseError, tokenize, type Token } from "../../src/export/trim/pdf/tokenize";

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const kv = (tokens: Token[]) => tokens.map((t) => [t.kind, t.value]);

test("numbers, including a leading point and a trailing point", () => {
  expect(kv(tokenize(enc("-.5 3. +12 0.25 -7")))).toEqual([
    ["number", "-.5"],
    ["number", "3."],
    ["number", "+12"],
    ["number", "0.25"],
    ["number", "-7"],
  ]);
});

test("names decode #xx escapes and end at a delimiter", () => {
  expect(kv(tokenize(enc("/A#20B/C Do /")))).toEqual([
    ["name", "A B"],
    ["name", "C"],
    ["operator", "Do"],
    ["name", ""],
  ]);
});

test("strings nest parentheses and decode escapes", () => {
  const tokens = tokenize(enc("(a (b) \\(c\\) \\n\\101\\\\\\\nd) Tj"));
  expect(kv(tokens)).toEqual([
    ["string", "a (b) (c) \nA\\d"],
    ["operator", "Tj"],
  ]);
  expect(tokens[0].start).toBe(0);
  expect(tokens[1].start).toBe(tokens[0].end + 1);
});

test("hex strings skip whitespace and pad an odd digit", () => {
  expect(kv(tokenize(enc("<41 42 4>")))).toEqual([["hexstring", "AB@"]]);
});

test("arrays and dictionaries are delimited, comments are skipped", () => {
  const tokens = tokenize(enc("[1 (x)] % a comment ] ) <<\n<</A 1>> BDC"));
  expect(kv(tokens)).toEqual([
    ["arrayStart", "["],
    ["number", "1"],
    ["string", "x"],
    ["arrayEnd", "]"],
    ["dictStart", "<<"],
    ["name", "A"],
    ["number", "1"],
    ["dictEnd", ">>"],
    ["operator", "BDC"],
  ]);
});

test("operators include the quote operators and star forms", () => {
  expect(kv(tokenize(enc("T* f* ' \" BT ET")))).toEqual([
    ["operator", "T*"],
    ["operator", "f*"],
    ["operator", "'"],
    ["operator", '"'],
    ["operator", "BT"],
    ["operator", "ET"],
  ]);
});

test("an inline image is one token, its data as long as its size says, whatever EI it holds", () => {
  // 9 gray 8-bit samples: "\x00 EIx\xffEI\x01".
  const src = "q BI /W 9 /H 1 /BPC 8 /CS /G ID \x00 EIx\xffEI\x01 EI Q";
  const tokens = tokenize(enc(src));
  expect(tokens.map((t) => t.kind)).toEqual(["operator", "inlineImage", "operator"]);
  const image = tokens[1];
  expect(image.start).toBe(src.indexOf("BI"));
  expect(image.end).toBe(src.lastIndexOf("EI") + 2);
  expect(tokens[2].value).toBe("Q");
});

test("an inline image's /L gives where its data ends, filtered or not", () => {
  // The data is "EI EI" (5 bytes).
  const src = "BI /W 5 /H 1 /F /AHx /L 5 ID EI EI EI";
  const tokens = tokenize(enc(src));
  expect(tokens).toHaveLength(1);
  expect(tokens[0].end).toBe(src.length);
  expect(() => tokenize(enc("BI /W 5 /H 1 /L 4 ID EI EI EI"))).toThrow(ContentParseError);
});

test("an unfiltered image's data length comes from its size, bits per component and colour space", () => {
  const one = (src: string, data: string) => {
    const tokens = tokenize(enc(src));
    expect(tokens.map((t) => t.kind)).toEqual(["inlineImage", "operator"]);
    expect(tokens[0].end).toBe(src.indexOf(data) + data.length + " EI".length);
  };
  // Gray 4×1, 8 bits, holding " EI ".
  one("BI /W 4 /H 1 /BPC 8 /CS /G ID \x01 EI EI Q", "\x01 EI");
  // RGB 2×2, 8 bits: 12 bytes.
  one("BI /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB ID  EI EI EI EI EI Q", " EI EI EI EI");
  // Gray 10×2, 1 bit: two bytes a row.
  one("BI /W 10 /H 2 /BPC 1 /CS /G ID abcd EI Q", "abcd");
  // An image mask, 1 bit by default.
  one("BI /IM true /W 10 /H 2 ID abcd EI Q", "abcd");
  // Indexed, given as an array.
  one("BI /W 8 /H 1 /BPC 1 /CS [/I /RGB 1 <000000FFFFFF>] ID \x80 EI Q", "\x80");
  // CMYK 1×1, 8 bits.
  one("BI /W 1 /H 1 /BPC 8 /CS /CMYK ID wxyz EI Q", "wxyz");
});

test("an inline image whose data length cannot be known exactly throws", () => {
  // Filtered without /L.
  expect(() => tokenize(enc("BI /W 4 /H 1 /BPC 8 /CS /G /F /AHx ID 01020304> EI"))).toThrow(ContentParseError);
  // A named resource colour space.
  expect(() => tokenize(enc("BI /W 4 /H 1 /BPC 8 /CS /CS0 ID abcd EI"))).toThrow(ContentParseError);
  // No bits per component.
  expect(() => tokenize(enc("BI /W 4 /H 1 /CS /G ID abcd EI"))).toThrow(ContentParseError);
  // Data not followed by whitespace and EI.
  expect(() => tokenize(enc("BI /W 4 /H 1 /BPC 8 /CS /G ID abcdEI"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("BI /W 4 /H 1 /BPC 8 /CS /G ID abcde EI"))).toThrow(ContentParseError);
});

test("an operator with bytes outside printable ASCII throws", () => {
  expect(() => tokenize(enc("q \xff\x01 Q"))).toThrow(ContentParseError);
});

test("binary inline-image data holding \" EI \" without /L never yields a token inside the image", () => {
  // The scan ends the image at the first " EI "; the binary bytes after it then cannot be read as operators.
  expect(() => tokenize(enc("q BI /W 4 /H 1 /BPC 8 /CS /G ID \x80 EI \xfe\x01 EI Q"))).toThrow(ContentParseError);
});

test("the rest of an inline image ended too early throws, whatever its bytes read as", () => {
  // A false " EI " in binary data without /L, followed by bytes that read as a string, an operator or a name.
  expect(() => tokenize(enc("q BI /W 4 /H 1 /BPC 8 /CS /G ID \x80 EI (\xfe\xfd) EI Q"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("q BI /W 4 /H 1 ID \x80 EI ab EI Q"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("q BI /W 4 /H 1 ID \x80 EI /\xfe EI Q"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("q BI /W 4 /H 1 /BPC 8 /CS /G ID \x80 EI (\xfe\xfd) EI Q"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("q ID Q"))).toThrow(ContentParseError);
});

test("the real EI swallowed by a comment or a string after a false one throws", () => {
  expect(() => tokenize(enc("q BI /W 4 /H 1 ID \x80 EI %\x01 EI Q\nQ"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("q BI /W 4 /H 1 ID \x80 EI (\x01 EI ) Q"))).toThrow(ContentParseError);
  // With a known size the data ends where it must, so the false " EI " cannot end it either.
  expect(() => tokenize(enc("q BI /W 4 /H 1 /BPC 8 /CS /G ID \x80 EI %\x01 EI Q\nQ"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("q BI /W 4 /H 1 /BPC 8 /CS /G ID \x80 EI (\x01 EI ) Q"))).toThrow(ContentParseError);
});

test("malformed input throws ContentParseError", () => {
  expect(() => tokenize(enc("(unterminated"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("<41 4"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("<4G>"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("1 2 ) m"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("1.2.3 w"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("a > b"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("BI /W 1 ID xx"))).toThrow(ContentParseError);
  expect(() => tokenize(enc("BI /W 1"))).toThrow(ContentParseError);
});
