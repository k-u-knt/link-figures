import { tokenize } from "../../src/export/trim/pdf/tokenize";
import { findUnits, type Matrix, type ResourceInfo, type Unit } from "../../src/export/trim/pdf/units";

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

type FontInfo = ReturnType<ResourceInfo["font"]>;
type XObjectInfo = ReturnType<ResourceInfo["xobject"]>;
type GStateInfo = ReturnType<ResourceInfo["extGState"]>;

function resources(
  opts: {
    fonts?: Record<string, FontInfo>;
    xobjects?: Record<string, XObjectInfo>;
    shadings?: Record<string, [number, number, number, number]>;
    gstates?: Record<string, GStateInfo>;
  } = {},
): ResourceInfo {
  return {
    xobject: (name) => opts.xobjects?.[name] ?? null,
    font: (name) => opts.fonts?.[name] ?? null,
    shadingBBox: (name) => opts.shadings?.[name] ?? null,
    extGState: (name) => opts.gstates?.[name] ?? null,
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

  test("s, b and b* close the path, and the closing joins' miter tips are in the box", () => {
    // An open triangle (0,0) → (10,0) → (10,10); closing adds sharp 45° corners at (10,10) and (0,0), whose miters
    // (about 2.6 half-widths: x 2 · 2.61 along the bisector) reach well past half the line width.
    for (const paint of ["s", "b", "b*"]) {
      const box = units(`4 w 0 0 m 10 0 l 10 10 l ${paint}`).units[0].box!;
      expect(box.y + box.height).toBeGreaterThan(14.5);
      expect(box.x).toBeLessThan(-4.5);
    }
    // S does not close: the end at (10, 10) has a butt cap, and only the right-angle corner is mitered.
    expectBox(units("4 w 0 0 m 10 0 l 10 10 l S").units[0], -2, -2, 14, 14);
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
    // "c" starts at x 1000 and is 10 wide; each show is padded by half an em (5) on each side; -0.5 em to 1.2 em high.
    expectBox(found[0], -5, -5, 1020, 17);
  });

  test("Review Focus 5: a two-byte font counts one em per byte", () => {
    const { units: found } = units("BT /F0 10 Tf <00410042> Tj ET", resources({ fonts: { F0: { widths: null, twoByte: true } } }));
    expectBox(found[0], -5, -5, 50, 17);
  });

  test("a two-byte font's glyphs are as wide as its widest known glyph, when that exceeds an em", () => {
    const font: FontInfo = { widths: { first: 1, list: [600, 1500], missing: 500 }, twoByte: true };
    // Two bytes of 1.5 em at 10 pt, padded by 5 on each side.
    expectBox(units("BT /F0 10 Tf <0102> Tj ET", resources({ fonts: { F0: font } })).units[0], -5, -5, 40, 17);
  });

  test("a simple font uses its widths, and the missing width for codes outside the table", () => {
    const font: FontInfo = { widths: { first: 65, list: [500, 250], missing: 100 }, twoByte: false };
    // A (500) B (250) C (missing: 100) at 20 pt: 10 + 5 + 2, padded by 10 on each side.
    expectBox(units("BT /F1 20 Tf (ABC) Tj ET", resources({ fonts: { F1: font } })).units[0], -10, -10, 37, 34);
  });

  test("Tm, the CTM, char and word spacing, horizontal scaling and rise are applied", () => {
    const src = "2 0 0 2 0 0 cm BT /F1 10 Tf 1 0 0 1 5 0 Tm 1 Tc 2 Tw 50 Tz 4 Ts (a b) Tj ET";
    // Advances: a 10+1, space 10+1+2, b 10 (inked) → (11 + 13 + 10) × 0.5 = 17, padded by 2.5 (half a scaled em) on
    // each side: -2.5…19.5, then +5 and ×2 → 5…49. y from -5+4 to 12+4, ×2 → -2…32.
    expectBox(units(src, resources({ fonts: { F1: EM_FONT } })).units[0], 5, -2, 44, 34);
  });

  test("TJ adjustments move the next glyph back", () => {
    expectBox(units("BT /F1 10 Tf [(a) -1000 (b)] TJ ET", resources({ fonts: { F1: EM_FONT } })).units[0], -5, -5, 40, 17);
  });

  test("T*, ' and \" move to the next line by the leading", () => {
    const { units: found } = units("BT /F1 10 Tf 12 TL (a) Tj T* (b) Tj (c) ' 0 0 (d) \" ET", resources({ fonts: { F1: EM_FONT } }));
    expectBox(found[0], -5, -36 - 5, 20, 36 + 17);
  });

  test("stroked text (render modes 1 and 2) is widened by half the line width", () => {
    const res = resources({ fonts: { F1: EM_FONT } });
    expectBox(units("2 w BT /F1 10 Tf 1 Tr (a) Tj ET", res).units[0], -6, -6, 22, 19);
    expectBox(units("2 w BT /F1 10 Tf 2 Tr (a) Tj ET", res).units[0], -6, -6, 22, 19);
    expectBox(units("2 w BT /F1 10 Tf 0 Tr (a) Tj ET", res).units[0], -5, -5, 20, 17);
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

describe("graphics states (gs)", () => {
  test("a line width set by gs widens the stroke box, and Q restores it", () => {
    const res = resources({ gstates: { GS0: { lineWidth: 20 } } });
    expectBox(units("/GS0 gs 0 0 m 10 0 l S", res).units[0], -10, -10, 30, 20);
    expectBox(units("q /GS0 gs Q 0 0 m 10 0 l S", res).units[0], -0.5, -0.5, 11, 1);
  });

  test("a larger miter limit set by gs reveals miter tips the default limit cuts off", () => {
    // A spike so sharp (about 50 half-widths) that the default limit of 10 bevels it.
    const spike = "4 w 0 -0.2 m 10 0 l 0 0.2 l S";
    const res = resources({ gstates: { GSm: { miterLimit: 100 }, GSc: { cap: 2 }, GSj: { join: 1 } } });
    const beveled = units(spike, res).units[0].box!;
    const mitered = units(`/GSm gs ${spike}`, res).units[0].box!;
    expect(beveled.x + beveled.width).toBeLessThan(13);
    expect(mitered.x + mitered.width).toBeGreaterThan(100);
    // A round join set by gs has no tip; a projecting cap reaches half the width diagonally.
    expect(units(`/GSm gs /GSj gs ${spike}`, res).units[0].box).toEqual(beveled);
    expectBox(units("/GSc gs 0 0 m 10 0 l S", res).units[0], -Math.SQRT1_2, -Math.SQRT1_2, 10 + Math.SQRT2, Math.SQRT2);
  });

  test("a font set by gs is the one the text is measured with", () => {
    const res = resources({ gstates: { GSf: { font: { font: EM_FONT, size: 10 } }, GSx: { font: { font: null, size: 10 } } } });
    expectBox(units("/GSf gs BT (a) Tj ET", res).units[0], -5, -5, 20, 17);
    // A font set by gs that must not be measured, as by Tf, gives no box.
    expect(units("/GSx gs BT (a) Tj ET", res).units[0].box).toBeNull();
  });

  test("an unreadable ExtGState makes strokes and text unknown until its Q; fills stay known", () => {
    const res = resources({ fonts: { F1: EM_FONT } });
    const found = units("q /Bad gs 0 0 m 10 0 l S 0 0 10 10 re f BT /F1 10 Tf (a) Tj ET Q 0 0 m 10 0 l S BT /F1 10 Tf (a) Tj ET", res).units;
    expect(found.map((u) => u.box === null)).toEqual([true, false, true, false, false]);
    // A Tf or w after it does not make it known again: what else the dictionary set is still unknown.
    expect(units("/Bad gs 1 w 0 0 m 10 0 l S", res).units[0].box).toBeNull();
    expect(units("/Bad gs BT /F1 10 Tf (a) Tj ET", res).units[0].box).toBeNull();
  });

  test("a gs after a text object does not count as setting its line width again, so the text object stays", () => {
    // Whether GS0 sets the width depends on its dictionary, so the stroke after it may read the width set in the text.
    const res = resources({ fonts: { F1: EM_FONT }, gstates: { GS0: { lineWidth: 3 } } });
    expect(units("BT 5 w /F1 10 Tf (a) Tj ET /GS0 gs 0 0 m 1 1 l S", res).units[0].box).toBeNull();
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
