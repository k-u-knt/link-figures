import { tokenize } from "../../src/export/trim/pdf/tokenize";
import { findUnits, type Matrix, type ResourceInfo, type Unit } from "../../src/export/trim/pdf/units";

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

type FontInfo = ReturnType<ResourceInfo["font"]>;
type XObjectInfo = ReturnType<ResourceInfo["xobject"]>;

function resources(
  opts: { fonts?: Record<string, FontInfo>; xobjects?: Record<string, XObjectInfo>; shadings?: Record<string, [number, number, number, number]> } = {},
): ResourceInfo {
  return {
    xobject: (name) => opts.xobjects?.[name] ?? null,
    font: (name) => opts.fonts?.[name] ?? null,
    shadingBBox: (name) => opts.shadings?.[name] ?? null,
  };
}

/** A font with no widths table: every glyph one em. */
const EM_FONT: FontInfo = { widths: null, twoByte: false };

function units(src: string, res: ResourceInfo = resources(), ctm: Matrix = IDENTITY): { units: Unit[]; text: (u: Unit) => string } {
  const bytes = enc(src);
  return { units: findUnits(tokenize(bytes), bytes, res, ctm), text: (u) => src.slice(u.start, u.end) };
}

function expectBox(unit: Unit, x: number, y: number, width: number, height: number) {
  expect(unit.box).not.toBeNull();
  expect(unit.box!.x).toBeCloseTo(x, 9);
  expect(unit.box!.y).toBeCloseTo(y, 9);
  expect(unit.box!.width).toBeCloseTo(width, 9);
  expect(unit.box!.height).toBeCloseTo(height, 9);
}

describe("paths", () => {
  test("a filled rectangle goes through the CTM, and its range is exactly its operands and operators", () => {
    const { units: found, text } = units("q 2 0 0 2 100 100 cm 0 0 10 10 re f Q");
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("path");
    expect(text(found[0])).toBe("0 0 10 10 re f");
    expectBox(found[0], 100, 100, 20, 20);
  });

  test("Q restores the CTM", () => {
    const { units: found } = units("q 2 0 0 2 100 100 cm Q 0 0 10 10 re f");
    expectBox(found[0], 0, 0, 10, 10);
  });

  test("a stroke is widened by half the line width times the CTM's scale", () => {
    expectBox(units("4 w 0 0 10 10 re S").units[0], -2, -2, 14, 14);
    expectBox(units("3 0 0 1 0 0 cm 4 w 0 0 m 10 0 l S").units[0], -6, -6, 42, 12);
  });

  test("a sharp miter join reaches past half the line width", () => {
    // A spike with its tip at (10, 0): the miter (about 5.1 line half-widths, within the default limit of 10) pokes out
    // to about x 20.2, far past the 12 that half the line width reaches.
    const box = units("4 w 0 -2 m 10 0 l 0 2 l S").units[0].box!;
    expect(box.x + box.width).toBeGreaterThan(20);
    // Round joins stay within half the line width.
    expectBox(units("1 j 4 w 0 -2 m 10 0 l 0 2 l S").units[0], -2, -4, 14, 8);
  });

  test("projecting caps reach half the line width diagonally", () => {
    const box = units("2 J 2 w 0 0 m 10 10 l S").units[0].box!;
    expect(box.x).toBeLessThanOrEqual(-Math.SQRT2 + 1e-9);
  });

  test("curves use all their control points", () => {
    expectBox(units("0 0 m 0 50 10 50 10 0 c f").units[0], 0, 0, 10, 50);
    expectBox(units("0 0 m 5 -20 10 0 v f").units[0], 0, -20, 10, 20);
    expectBox(units("0 0 m 5 30 10 0 y f").units[0], 0, 0, 10, 30);
  });

  test("Review Focus 1: a clipping path is never a unit", () => {
    expect(units("0 0 10 10 re W n").units).toEqual([]);
    expect(units("0 0 10 10 re W* f").units).toEqual([]);
  });

  test("a path ended by n is not a unit", () => {
    expect(units("0 0 10 10 re n").units).toEqual([]);
  });

  test("state operators stay outside every range", () => {
    const { units: found, text } = units("1 0 0 rg 2 w 0 0 m 5 5 l S 0 g 0 0 1 1 re f");
    expect(found.map(text)).toEqual(["0 0 m 5 5 l S", "0 0 1 1 re f"]);
  });

  test("an operator inside a path makes its box unknown", () => {
    const { units: found } = units("0 0 m 1 0 0 rg 5 5 l S");
    expect(found).toHaveLength(1);
    expect(found[0].box).toBeNull();
  });

  test("marked content around a unit is not part of it", () => {
    const { units: found, text } = units("/Artifact <</Type /Pagination>> BDC 0 0 1 1 re f EMC");
    expect(found.map(text)).toEqual(["0 0 1 1 re f"]);
  });
});

describe("XObjects, inline images, shadings", () => {
  const res = resources({
    xobjects: {
      Fm1: { subtype: "Form", bbox: [0, 0, 50, 50], matrix: [1, 0, 0, 1, 10, 10] },
      Im1: { subtype: "Image" },
    },
    shadings: { Sh1: [0, 0, 4, 8] },
  });

  test("a form's BBox goes through its matrix and the CTM", () => {
    const { units: found, text } = units("/Fm1 Do", res);
    expect(found[0].kind).toBe("xobject");
    expect(found[0].name).toBe("Fm1");
    expect(found[0].ctm).toEqual(IDENTITY);
    expect(text(found[0])).toBe("/Fm1 Do");
    expectBox(found[0], 10, 10, 50, 50);
  });

  test("an image is the unit square through the CTM", () => {
    const { units: found } = units("q 30 0 0 20 5 6 cm /Im1 Do Q", res);
    expectBox(found[0], 5, 6, 30, 20);
    expect(found[0].ctm).toEqual([30, 0, 0, 20, 5, 6]);
  });

  test("an unknown XObject has no box", () => {
    const { units: found } = units("/Nope Do", res);
    expect(found).toHaveLength(1);
    expect(found[0].box).toBeNull();
  });

  test("an inline image is the unit square through the CTM", () => {
    const src = "q 8 0 0 4 1 2 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \x80 EI Q";
    const { units: found, text } = units(src, res);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("inlineImage");
    expect(text(found[0]).startsWith("BI")).toBe(true);
    expect(text(found[0]).endsWith("EI")).toBe(true);
    expectBox(found[0], 1, 2, 8, 4);
  });

  test("a shading uses its BBox when given, and is unknown otherwise", () => {
    const { units: found } = units("2 0 0 2 0 0 cm /Sh1 sh /Sh2 sh", res);
    expect(found.map((u) => [u.kind, u.name])).toEqual([
      ["shading", "Sh1"],
      ["shading", "Sh2"],
    ]);
    expectBox(found[0], 0, 0, 8, 16);
    expect(found[1].box).toBeNull();
  });
});

describe("text", () => {
  test("Review Focus 5: two Tj in one BT are one unit spanning both", () => {
    const { units: found, text } = units("BT /F1 10 Tf 0 0 Td (ab) Tj 1000 0 Td (c) Tj ET", resources({ fonts: { F1: EM_FONT } }));
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("text");
    expect(text(found[0])).toBe("BT /F1 10 Tf 0 0 Td (ab) Tj 1000 0 Td (c) Tj ET");
    // "c" starts at x 1000 and is 10 wide; the em box runs from -3 to 12.
    expectBox(found[0], 0, -3, 1010, 15);
  });

  test("Review Focus 5: a two-byte font counts one em per byte", () => {
    const { units: found } = units("BT /F0 10 Tf <00410042> Tj ET", resources({ fonts: { F0: { widths: null, twoByte: true } } }));
    expectBox(found[0], 0, -3, 40, 15);
  });

  test("a simple font uses its widths, and the missing width for codes outside the table", () => {
    const font: FontInfo = { widths: { first: 65, list: [500, 250], missing: 100 }, twoByte: false };
    // A (500) B (250) C (missing: 100) at 20 pt: 10 + 5 + 2.
    expectBox(units("BT /F1 20 Tf (ABC) Tj ET", resources({ fonts: { F1: font } })).units[0], 0, -6, 17, 30);
  });

  test("Tm, the CTM, char and word spacing, horizontal scaling and rise are applied", () => {
    const src = "2 0 0 2 0 0 cm BT /F1 10 Tf 1 0 0 1 5 0 Tm 1 Tc 2 Tw 50 Tz 4 Ts (a b) Tj ET";
    // Advances: a 10+1, space 10+1+2, b 10 (inked) → (11 + 13 + 10) × 0.5 = 17; y from -3+4 to 12+4.
    expectBox(units(src, resources({ fonts: { F1: EM_FONT } })).units[0], 10, 2, 34, 30);
  });

  test("TJ adjustments move the next glyph back", () => {
    expectBox(units("BT /F1 10 Tf [(a) -1000 (b)] TJ ET", resources({ fonts: { F1: EM_FONT } })).units[0], 0, -3, 30, 15);
  });

  test("T*, ' and \" move to the next line by the leading", () => {
    const { units: found } = units("BT /F1 10 Tf 12 TL (a) Tj T* (b) Tj (c) ' 0 0 (d) \" ET", resources({ fonts: { F1: EM_FONT } }));
    expectBox(found[0], 0, -36 - 3, 10, 36 + 15);
  });

  test("text render mode 7 (and any clipping mode) gives no box", () => {
    const res = resources({ fonts: { F1: EM_FONT } });
    expect(units("BT /F1 10 Tf 7 Tr (a) Tj ET", res).units[0].box).toBeNull();
    expect(units("BT /F1 10 Tf 4 Tr (a) Tj ET", res).units[0].box).toBeNull();
    expect(units("7 Tr BT /F1 10 Tf (a) Tj ET", res).units[0].box).toBeNull();
  });

  test("an unknown font, a missing Tf or an unknown operator inside gives no box", () => {
    const res = resources({ fonts: { F1: EM_FONT } });
    expect(units("BT /F9 10 Tf (a) Tj ET", res).units[0].box).toBeNull();
    expect(units("BT (a) Tj ET", res).units[0].box).toBeNull();
    expect(units("BT /F1 10 Tf (a) Tj foo ET", res).units[0].box).toBeNull();
    expect(units("BT /F1 10 Tf 0 0 m 1 1 l S (a) Tj ET", res).units[0].box).toBeNull();
  });

  test("text state set inside a text object and relied on later keeps it", () => {
    const res = resources({ fonts: { F1: EM_FONT, F2: EM_FONT } });
    // The second object has no Tf of its own: dropping the first would lose its font.
    const relied = units("BT /F1 10 Tf (a) Tj ET BT (b) Tj ET", res).units;
    expect(relied[0].box).toBeNull();
    expect(relied[1].box).not.toBeNull();
    // Set again before it is used, or restored by Q: the first object can go.
    expect(units("BT /F1 10 Tf (a) Tj ET BT /F2 12 Tf (b) Tj ET", res).units[0].box).not.toBeNull();
    expect(units("q BT /F1 10 Tf (a) Tj ET Q BT /F2 12 Tf (b) Tj ET", res).units[0].box).not.toBeNull();
    // A fill colour set inside the text object and used by a later fill keeps it; a later stroke does not read it.
    expect(units("BT 1 0 0 rg /F1 10 Tf (a) Tj ET 0 0 1 1 re f", res).units[0].box).toBeNull();
    expect(units("BT 1 0 0 rg /F1 10 Tf (a) Tj ET 0 0 m 1 1 l S", res).units[0].box).not.toBeNull();
  });

  test("a text object with nothing shown has no box", () => {
    expect(units("BT 0 0 Td ET").units[0].box).toBeNull();
  });
});

describe("malformed streams", () => {
  test("operands of the wrong kind or count throw", async () => {
    const { ContentParseError } = await import("../../src/export/trim/pdf/tokenize");
    expect(() => units("1 2 cm")).toThrow(ContentParseError);
    expect(() => units("BT /F1 10 Tf (a) Tj")).toThrow(ContentParseError);
    expect(() => units("BT BT ET ET")).toThrow(ContentParseError);
    expect(() => units("[1 2 re")).toThrow(ContentParseError);
    expect(() => units("1 2 ] m")).toThrow(ContentParseError);
    expect(() => units("0 0 10 10 re /Fm1 Do f")).toThrow(ContentParseError);
  });
});
