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

test("an inline image is one token; EI inside its data not followed by whitespace does not end it", () => {
  const src = "q BI /W 2 /H 1 /BPC 8 /CS /G ID \x00 EIx\xffEI\x01 EI Q";
  const tokens = tokenize(enc(src));
  expect(tokens.map((t) => t.kind)).toEqual(["operator", "inlineImage", "operator"]);
  const image = tokens[1];
  expect(image.start).toBe(src.indexOf("BI"));
  expect(image.end).toBe(src.lastIndexOf("EI") + 2);
  expect(tokens[2].value).toBe("Q");
});

test("an inline image's /L gives where its data ends", () => {
  // The data is "EI EI" (5 bytes): without the length, the scan would end at the first " EI ".
  const src = "BI /W 5 /H 1 /L 5 ID EI EI EI";
  const tokens = tokenize(enc(src));
  expect(tokens).toHaveLength(1);
  expect(tokens[0].end).toBe(src.length);
});

test("an inline image may end at the end of the data", () => {
  const tokens = tokenize(enc("BI /W 1 /H 1 ID x EI"));
  expect(tokens).toHaveLength(1);
  expect(tokens[0].kind).toBe("inlineImage");
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
  expect(() => tokenize(enc("q ID Q"))).toThrow(ContentParseError);
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
