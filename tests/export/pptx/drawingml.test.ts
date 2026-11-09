import {
  angle60k,
  colorXml,
  custGeomXml,
  EMU_PER_MM,
  EMU_PER_PT,
  EMU_PER_PX,
  fillXml,
  hexColor,
  lnXml,
  nvPrXml,
  PATTERN_WARNING,
  turnedXfrmXml,
  xfrmXml,
  xmlSafe,
} from "../../../src/export/pptx/drawingml";
import type { Paint, Stroke } from "../../../src/model/types";
import { pptxContext } from "./context";
import { all, one, parseFragment } from "./ooxml";

const box = { width: 100, height: 50 };
const stops = [
  { offset: 1, color: "#0000ff" },
  { offset: 0, color: "#ff0000", opacity: 0.5 },
];

function fill(paint: Paint, alpha = 1) {
  const { ctx, warnings } = pptxContext();
  const xml = fillXml(paint, alpha, box, ctx);
  return { xml, doc: parseFragment(xml), warnings };
}

const gs = (doc: globalThis.Document) =>
  all(doc, "a:gs").map((g) => {
    const clr = one(g, "a:srgbClr");
    const alpha = clr.getElementsByTagName("a:alpha")[0];
    return [Number(g.getAttribute("pos")), clr.getAttribute("val"), alpha ? Number(alpha.getAttribute("val")) : 100000];
  });

describe("units", () => {
  it("are DrawingML's", () => {
    expect(EMU_PER_PX).toBe(9525);
    expect(EMU_PER_MM).toBe(36000);
    expect(EMU_PER_PT).toBe(12700);
    // 96 px per inch: an inch is 914400 EMU either way.
    expect(96 * EMU_PER_PX).toBe(25.4 * EMU_PER_MM);
  });

  it("turns degrees into 60000ths within one turn", () => {
    expect(angle60k(0)).toBe(0);
    expect(angle60k(30)).toBe(1800000);
    expect(angle60k(-90)).toBe(16200000);
    expect(angle60k(360)).toBe(0);
    expect(angle60k(450.5)).toBe(5430000);
  });
});

describe("colours", () => {
  it("reads #rrggbb and #rgb", () => {
    expect(hexColor("#a1b2c3")).toBe("A1B2C3");
    expect(hexColor("#abc")).toBe("AABBCC");
    expect(hexColor("red")).toBeNull();
  });

  it("writes alpha below 1 in 1/1000 per cent, and none at 1", () => {
    expect(colorXml("FF0000", 1)).toBe('<a:srgbClr val="FF0000"/>');
    expect(colorXml("FF0000", 0.25)).toBe('<a:srgbClr val="FF0000"><a:alpha val="25000"/></a:srgbClr>');
    expect(colorXml("FF0000", -1)).toBe('<a:srgbClr val="FF0000"><a:alpha val="0"/></a:srgbClr>');
  });
});

describe("fillXml", () => {
  it("paints none as noFill", () => {
    expect(fill({ type: "none" }).xml).toBe("<a:noFill/>");
  });

  it("paints solid with the paint's opacity times the node's", () => {
    const { doc } = fill({ type: "solid", color: "#336699", opacity: 0.5 }, 0.5);
    const clr = one(one(doc, "a:solidFill"), "a:srgbClr");
    expect(clr.getAttribute("val")).toBe("336699");
    expect(one(clr, "a:alpha").getAttribute("val")).toBe("25000");
  });

  it("paints linear as a gradient along the same angle, stops in order", () => {
    // Our angle and DrawingML's both run clockwise from +x with y down: 0 is left to right, 90 top to bottom.
    const { doc } = fill({ type: "linear", angle: 90, stops }, 0.8);
    const lin = one(doc, "a:lin");
    expect(lin.getAttribute("ang")).toBe("5400000");
    expect(lin.getAttribute("scaled")).toBe("0");
    expect(one(doc, "a:gradFill").getAttribute("rotWithShape")).toBe("1");
    expect(gs(doc)).toEqual([
      [0, "FF0000", 40000],
      [100000, "0000FF", 80000],
    ]);
    expect(one(fill({ type: "linear", angle: -45, stops }).doc, "a:lin").getAttribute("ang")).toBe("18900000");
  });

  it("paints a gradient of one stop as that colour, and of none as nothing", () => {
    expect(one(fill({ type: "linear", angle: 0, stops: [{ offset: 0.3, color: "#00ff00" }] }).doc, "a:solidFill")).toBeTruthy();
    expect(fill({ type: "linear", angle: 0, stops: [] }).xml).toBe("<a:noFill/>");
  });

  it("paints radial as a circular path gradient from its centre, stops placed at their distance", () => {
    const { doc } = fill({ type: "radial", cx: 0.25, cy: 0.5, r: 0.5, stops });
    expect(one(doc, "a:path").getAttribute("path")).toBe("circle");
    const rect = one(doc, "a:fillToRect");
    expect([rect.getAttribute("l"), rect.getAttribute("t"), rect.getAttribute("r"), rect.getAttribute("b")]).toEqual(["25000", "50000", "75000", "50000"]);
    // Radius 0.5 × 100 = 50 px; the path's extent is the farthest corner, hypot(75, 25) ≈ 79.06 px.
    const far = Math.hypot(75, 25);
    expect(gs(doc)).toEqual([
      [0, "FF0000", 50000],
      [Math.round((50 / far) * 100000), "0000FF", 100000],
      [100000, "0000FF", 100000],
    ]);
  });

  it("cuts a radial gradient that reaches past the farthest corner there, with the colour it has there", () => {
    const { doc } = fill({ type: "radial", cx: 0.5, cy: 0.5, r: 1, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] });
    const far = Math.hypot(50, 25);
    const grey = Math.round((far / 100) * 255).toString(16).toUpperCase().padStart(2, "0");
    expect(gs(doc)).toEqual([
      [0, "000000", 100000],
      [100000, grey.repeat(3), 100000],
    ]);
  });

  it("paints a pattern with the nearest preset, its colours, a clear background for none, and a warning", () => {
    const presets: Record<string, string> = { hatch: "dkUpDiag", hatchReverse: "dkDnDiag", crosshatch: "diagCross", grid: "lgGrid", dots: "pct20" };
    for (const [pattern, prst] of Object.entries(presets)) {
      const { doc, warnings } = fill({ type: "pattern", pattern, fg: "#112233", bg: "#ffffff", scale: 1, angle: 0 });
      const patt = one(doc, "a:pattFill");
      expect(patt.getAttribute("prst"), pattern).toBe(prst);
      expect(one(one(patt, "a:fgClr"), "a:srgbClr").getAttribute("val")).toBe("112233");
      expect(one(one(patt, "a:bgClr"), "a:srgbClr").getAttribute("val")).toBe("FFFFFF");
      expect(warnings).toEqual([PATTERN_WARNING]);
    }
    const clear = fill({ type: "pattern", pattern: "hatch", fg: "#112233", bg: null, scale: 2, angle: 30 }, 0.5);
    expect(one(one(clear.doc, "a:bgClr"), "a:alpha").getAttribute("val")).toBe("0");
    expect(one(one(clear.doc, "a:fgClr"), "a:alpha").getAttribute("val")).toBe("50000");
  });

  it("paints an unknown pattern as hatch, an unregistered paint as nothing, each with a warning", () => {
    const odd = fill({ type: "pattern", pattern: "waves", fg: "#000000", bg: null });
    expect(one(odd.doc, "a:pattFill").getAttribute("prst")).toBe("dkUpDiag");
    expect(odd.warnings.some((w) => w.includes("waves"))).toBe(true);
    const unknown = fill({ type: "plaid" });
    expect(unknown.xml).toBe("<a:noFill/>");
    expect(unknown.warnings[0]).toContain("plaid");
  });

  it("writes a paint through its type's toPptx, and one without it as nothing, with a warning", () => {
    const { ctx, warnings } = pptxContext();
    ctx.registries.paints.register({ id: "mine", name: "Mine", defaults: () => ({ type: "mine" }), fields: () => [], toSvg: () => ({ ref: "none", defs: [] }), toPptx: (_p, alpha) => `<a:noFill/><!--${alpha}-->` });
    ctx.registries.paints.register({ id: "svgOnly", name: "SVG only", defaults: () => ({ type: "svgOnly" }), fields: () => [], toSvg: () => ({ ref: "none", defs: [] }) });
    expect(fillXml({ type: "mine" }, 0.5, box, ctx)).toBe("<a:noFill/><!--0.5-->");
    expect(fillXml({ type: "svgOnly" }, 1, box, ctx)).toBe("<a:noFill/>");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("svgOnly");
  });

  it("paints a colour it cannot read as black, with a warning", () => {
    const { doc, warnings } = fill({ type: "solid", color: "tomato" });
    expect(one(doc, "a:srgbClr").getAttribute("val")).toBe("000000");
    expect(warnings[0]).toContain("tomato");
  });
});

describe("lnXml", () => {
  const stroke = (over: Partial<Stroke> = {}): Stroke => ({ paint: { type: "solid", color: "#000000" }, width: 0.75, dash: "solid", ...over });
  const ln = (s: Stroke | null, alpha = 1, scale = 1) => {
    const { ctx } = pptxContext({ scale });
    return parseFragment(lnXml(s, alpha, box, ctx));
  };

  it("writes no line as noFill", () => {
    expect(one(one(ln(null), "a:ln"), "a:noFill")).toBeTruthy();
  });

  it("writes the width in EMU (scaled with the slide), the paint, and the dash", () => {
    const line = one(ln(stroke({ dash: "dash" })), "a:ln");
    expect(line.getAttribute("w")).toBe("9525");
    expect(one(line, "a:solidFill")).toBeTruthy();
    expect(one(line, "a:prstDash").getAttribute("val")).toBe("dash");
    expect(one(ln(stroke(), 1, 0.5), "a:ln").getAttribute("w")).toBe("4763");
    expect(one(ln(stroke({ dash: "dot" })), "a:prstDash").getAttribute("val")).toBe("sysDot");
    expect(one(ln(stroke({ dash: "dashDot" })), "a:prstDash").getAttribute("val")).toBe("dashDot");
  });

  it("writes a width of 0 as no line, and clamps a width past PowerPoint's limit with a warning", () => {
    expect(one(one(ln(stroke({ width: 0 })), "a:ln"), "a:noFill")).toBeTruthy();
    expect(one(ln(stroke({ width: 0 })), "a:ln").getAttribute("w")).toBeNull();
    const { ctx, warnings } = pptxContext();
    const wide = one(parseFragment(lnXml(stroke({ width: 2000 }), 1, box, ctx)), "a:ln");
    expect(wide.getAttribute("w")).toBe("20116800");
    expect(warnings[0]).toContain("20116800");
  });

  it("writes a miter of limit 4 (SVG's) when the stroke sets no join, and for a miter join", () => {
    expect(one(ln(stroke()), "a:miter").getAttribute("lim")).toBe("400000");
    expect(one(ln(stroke({ join: "miter" })), "a:miter").getAttribute("lim")).toBe("400000");
  });

  it("writes cap and join, the children in schema order", () => {
    const line = one(ln(stroke({ cap: "round", join: "bevel", paint: { type: "linear", angle: 0, stops } })), "a:ln");
    expect(line.getAttribute("cap")).toBe("rnd");
    expect(Array.from(line.children).map((c) => c.tagName)).toEqual(["a:gradFill", "a:prstDash", "a:bevel"]);
    expect(one(ln(stroke({ cap: "square", join: "miter" })), "a:ln").getAttribute("cap")).toBe("sq");
    expect(one(ln(stroke({ cap: "butt", join: "round" })), "a:round")).toBeTruthy();
  });
});

describe("custGeomXml and turnedXfrmXml", () => {
  const { ctx } = pptxContext();

  it("writes a path in its box's EMU, a line with no fill", () => {
    const doc = parseFragment(
      custGeomXml(
        [
          { op: "M", x: 10, y: 20 },
          { op: "L", x: 30, y: 20 },
          { op: "C", x1: 30, y1: 30, x2: 20, y2: 40, x: 10, y: 40 },
          { op: "Z" },
        ],
        { x: 10, y: 20, width: 20, height: 20 },
        ctx,
      ),
    );
    const path = one(doc, "a:path");
    expect([path.getAttribute("w"), path.getAttribute("h"), path.getAttribute("fill")]).toEqual(["190500", "190500", "none"]);
    expect(Array.from(path.children).map((c) => c.tagName)).toEqual(["a:moveTo", "a:lnTo", "a:cubicBezTo", "a:close"]);
    expect(all(one(path, "a:cubicBezTo"), "a:pt").map((p) => p.getAttribute("x"))).toEqual(["190500", "95250", "0"]);
  });

  it("gives a flat path a box of at least 1 EMU", () => {
    const path = one(parseFragment(custGeomXml([{ op: "M", x: 0, y: 5 }, { op: "L", x: 10, y: 5 }], { x: 0, y: 5, width: 10, height: 0 }, ctx)), "a:path");
    expect(path.getAttribute("h")).toBe("1");
  });

  it("turns a part of a box about the box's centre", () => {
    // A 10 × 10 square at the right end of a box centred on (50, 50), turned a quarter: it goes below the centre.
    const x = one(parseFragment(turnedXfrmXml({ x: 90, y: 45, width: 10, height: 10 }, { x: 50, y: 50 }, 90, ctx)), "a:xfrm");
    expect(x.getAttribute("rot")).toBe("5400000");
    expect([one(x, "a:off").getAttribute("x"), one(x, "a:off").getAttribute("y")]).toEqual([String(45 * 9525), String(90 * 9525)]);
  });

  it("never writes a negative extent", () => {
    const x = one(parseFragment(xfrmXml({ x: -5, y: 0, cx: -3, cy: 2.6 }, 0)), "a:xfrm");
    expect(one(x, "a:ext").getAttribute("cx")).toBe("0");
    expect(one(x, "a:ext").getAttribute("cy")).toBe("3");
    expect(one(x, "a:off").getAttribute("x")).toBe("-5");
  });
});

describe("xfrmXml and nvPrXml", () => {
  it("writes offset, extent and rotation", () => {
    const x = one(parseFragment(xfrmXml({ x: 1, y: 2, cx: 3, cy: 4 }, 30)), "a:xfrm");
    expect(x.getAttribute("rot")).toBe("1800000");
    expect([one(x, "a:off").getAttribute("x"), one(x, "a:off").getAttribute("y")]).toEqual(["1", "2"]);
    expect([one(x, "a:ext").getAttribute("cx"), one(x, "a:ext").getAttribute("cy")]).toEqual(["3", "4"]);
    expect(xfrmXml({ x: 0, y: 0, cx: 1, cy: 1 }, 0)).not.toContain("rot");
  });

  it("drops characters XML cannot hold from the name and description, and keeps line breaks", () => {
    expect(xmlSafe("a\u0001b\ufffec\uffff\td")).toBe("abc\td");
    const pr = one(parseFragment(nvPrXml(5, "x\u0007y", "line 1\nline 2")), "p:cNvPr");
    expect(pr.getAttribute("name")).toBe("xy");
    expect(pr.getAttribute("descr")).toBe("line 1\nline 2");
  });

  it("escapes the name and description", () => {
    const pr = one(parseFragment(nvPrXml(5, 'A & "B" <c>', "[[x#y]]")), "p:cNvPr");
    expect(pr.getAttribute("id")).toBe("5");
    expect(pr.getAttribute("name")).toBe('A & "B" <c>');
    expect(pr.getAttribute("descr")).toBe("[[x#y]]");
  });
});
