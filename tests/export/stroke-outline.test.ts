// @vitest-environment happy-dom
import type { Pt } from "../../src/model/geometry";
import { flattenPath, type PathData } from "../../src/model/path";
import { outlinePaintedStrokes } from "../../src/export/svg-stroke-paints";
import { strokeOutline, svgPathData } from "../../src/export/stroke-outline";

/** The nonzero winding number of `pt` in the outline (each subpath flattened finely). */
function winding(outline: PathData, pt: Pt): number {
  let w = 0;
  for (const ring of flattenPath(outline, 0.001)) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const side = (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y);
      if (a.y <= pt.y && b.y > pt.y && side > 0) w++;
      else if (a.y > pt.y && b.y <= pt.y && side < 0) w--;
    }
  }
  return w;
}
const inside = (outline: PathData, x: number, y: number) => winding(outline, { x, y }) !== 0;

const line = (...pts: [number, number][]): PathData => pts.map(([x, y], i) => ({ op: i === 0 ? "M" : "L", x, y }));

describe("strokeOutline", () => {
  test("a straight butt line is the rectangle half the width either side, and nothing beyond its ends", () => {
    const o = strokeOutline(line([0, 0], [10, 0]), 2, "butt", "miter");
    expect(inside(o, 5, 0.9)).toBe(true);
    expect(inside(o, 5, -0.9)).toBe(true);
    expect(inside(o, 5, 1.1)).toBe(false);
    expect(inside(o, -0.1, 0)).toBe(false);
    expect(inside(o, 10.1, 0)).toBe(false);
  });

  test("every piece winds the same way, so overlaps add up instead of cancelling", () => {
    const o = strokeOutline(line([0, 0], [10, 0], [10, 10]), 2, "round", "round");
    // The corner is covered by both segments' bodies and the round join: still inside.
    expect(winding(o, { x: 9.5, y: 0.5 })).not.toBe(0);
    const ws = [winding(o, { x: 5, y: 0 }), winding(o, { x: 10, y: 5 }), winding(o, { x: 9.8, y: 0.2 })];
    expect(ws.every((w) => Math.sign(w) === Math.sign(ws[0]))).toBe(true);
  });

  test("square caps reach half the width past each end; round caps are half discs", () => {
    const sq = strokeOutline(line([0, 0], [10, 0]), 2, "square", "miter");
    expect(inside(sq, -0.9, 0.9)).toBe(true);
    expect(inside(sq, 10.9, -0.9)).toBe(true);
    expect(inside(sq, 11.1, 0)).toBe(false);
    const rd = strokeOutline(line([0, 0], [10, 0]), 2, "round", "miter");
    expect(inside(rd, -0.95, 0)).toBe(true);
    expect(inside(rd, -0.8, 0.8)).toBe(false);
  });

  test("a miter join fills the corner's tip, a bevel cuts it, a round join rounds it", () => {
    const corner = line([0, 0], [10, 0], [10, 10]);
    expect(inside(strokeOutline(corner, 2, "butt", "miter"), 10.9, -0.9)).toBe(true);
    expect(inside(strokeOutline(corner, 2, "butt", "bevel"), 10.9, -0.9)).toBe(false);
    expect(inside(strokeOutline(corner, 2, "butt", "bevel"), 10.4, -0.4)).toBe(true);
    const round = strokeOutline(corner, 2, "butt", "round");
    expect(inside(round, 10.65, -0.65)).toBe(true);
    expect(inside(round, 10.9, -0.9)).toBe(false);
  });

  test("a miter longer than the limit falls back to a bevel", () => {
    const sharp = line([0, 0], [10, 0], [0, 1]);
    const tip = { x: 10.5, y: 0 };
    const o = strokeOutline(sharp, 2, "butt", "miter", [], { miterLimit: 4 });
    expect(inside(o, tip.x + 1, -0.5)).toBe(false);
  });

  test("a closed path joins its last segment to its first and has no caps", () => {
    const sq = strokeOutline([...line([0, 0], [10, 0], [10, 10], [0, 10]), { op: "Z" }], 2, "square", "miter");
    expect(inside(sq, -0.9, -0.9)).toBe(true);
    expect(inside(sq, 5, 5)).toBe(false);
    expect(inside(sq, -1.1, 5)).toBe(false);
  });

  test("dashes leave their gaps empty and each dash gets its own caps", () => {
    // Dash 4, gap 2 along a 20-long line: dashes at 0-4, 6-10, 12-16, 18-20.
    const o = strokeOutline(line([0, 0], [20, 0]), 2, "butt", "miter", [4, 2]);
    for (const x of [2, 8, 14, 19]) expect(inside(o, x, 0)).toBe(true);
    for (const x of [5, 11, 17]) expect(inside(o, x, 0)).toBe(false);
    // Offset 1: dashes at 0-3, 5-9, 11-15, 17-20.
    const shifted = strokeOutline(line([0, 0], [20, 0]), 2, "butt", "miter", [4, 2], { dashOffset: 1 });
    expect(inside(shifted, 2.5, 0)).toBe(true);
    expect(inside(shifted, 4, 0)).toBe(false);
    expect(inside(shifted, 5.5, 0)).toBe(true);
  });

  test("dashes of length zero are dots with round caps, at the path's start and end too", () => {
    const o = strokeOutline(line([0, 0], [20, 0]), 2, "round", "miter", [0, 4]);
    for (const x of [0, 4, 8, 12, 16, 20]) expect(inside(o, x + 0.5, 0) || inside(o, x - 0.5, 0)).toBe(true);
    expect(inside(o, -0.5, 0)).toBe(true);
    expect(inside(o, 20.5, 0)).toBe(true);
    for (const x of [2, 6, 18]) expect(inside(o, x, 0)).toBe(false);
  });

  test("a dash pattern that sums to next to nothing is drawn solid, and quickly", () => {
    const started = Date.now();
    const o = strokeOutline(line([0, 0], [20, 0]), 2, "round", "miter", [1e-10, 1e-10]);
    expect(Date.now() - started).toBeLessThan(500);
    for (const x of [-0.5, 5, 10.3, 20.5]) expect(inside(o, x, 0)).toBe(true);
  });

  test("a cubic's outline stays within the tolerance of half the width from the curve", () => {
    const curve: PathData = [{ op: "M", x: 0, y: 0 }, { op: "C", x1: 30, y1: 60, x2: 70, y2: -60, x: 100, y: 0 }];
    const o = strokeOutline(curve, 10, "butt", "miter");
    // Points along the curve, offset along its normal by 4.9 (inside) and 5.2 (outside).
    for (const t of [0.2, 0.35, 0.5, 0.8]) {
      const mt = 1 - t;
      const p = { x: 3 * mt * mt * t * 30 + 3 * mt * t * t * 70 + t ** 3 * 100, y: 3 * mt * mt * t * 60 - 3 * mt * t * t * 60 };
      const d = { x: 3 * mt * mt * 30 + 6 * mt * t * 40 + 3 * t * t * 30, y: 3 * mt * mt * 60 - 6 * mt * t * 120 + 3 * t * t * 60 };
      const len = Math.hypot(d.x, d.y);
      const n = { x: -d.y / len, y: d.x / len };
      for (const s of [1, -1]) {
        expect(inside(o, p.x + s * n.x * 4.9, p.y + s * n.y * 4.9)).toBe(true);
        expect(inside(o, p.x + s * n.x * 5.2, p.y + s * n.y * 5.2)).toBe(false);
      }
    }
  });

  test("a zero-length subpath is a dot with round or square caps, and nothing with butt caps", () => {
    const dot = line([5, 5], [5, 5]);
    expect(inside(strokeOutline(dot, 2, "round", "miter"), 5.6, 5.6)).toBe(true);
    expect(inside(strokeOutline(dot, 2, "square", "miter"), 5.9, 5.9)).toBe(true);
    expect(strokeOutline(dot, 2, "butt", "miter")).toEqual([]);
  });

  test("a zero width or an empty path gives an empty outline, and all numbers are finite", () => {
    expect(strokeOutline(line([0, 0], [10, 0]), 0, "butt", "miter")).toEqual([]);
    expect(strokeOutline([], 2, "round", "round")).toEqual([]);
    const o = strokeOutline(line([0, 0], [0, 0], [10, 0], [10, 0], [0, 0]), 2, "round", "miter", [0, 3]);
    expect(JSON.stringify(o)).not.toMatch(/null|NaN|Infinity/);
  });
});

describe("svgPathData", () => {
  test("reads absolute and relative M L H V C S Q T Z, and gives null for arcs", () => {
    expect(svgPathData("M1 2 L3,4 h2 v-1 Z")).toEqual([
      { op: "M", x: 1, y: 2 },
      { op: "L", x: 3, y: 4 },
      { op: "L", x: 5, y: 4 },
      { op: "L", x: 5, y: 3 },
      { op: "Z" },
    ]);
    expect(svgPathData("m10 10 20 0")).toEqual([
      { op: "M", x: 10, y: 10 },
      { op: "L", x: 30, y: 10 },
    ]);
    expect(svgPathData("M0 0 Q 3 3 6 0")).toEqual([{ op: "M", x: 0, y: 0 }, { op: "C", x1: 2, y1: 2, x2: 4, y2: 2, x: 6, y: 0 }]);
    expect(svgPathData("M0 0 C0 1 1 1 1 0 S2 -1 2 0")?.[2]).toEqual({ op: "C", x1: 1, y1: -1, x2: 2, y2: -1, x: 2, y: 0 });
    expect(svgPathData("M0 0 A5 5 0 0 1 10 0")).toBeNull();
    expect(svgPathData("M0 0 L")).toBeNull();
  });
});

const GRAD = '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>';
const doc = (defs: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs>${defs}</defs>${body}</svg>`;
const parse = (text: string) => new DOMParser().parseFromString(text, "image/svg+xml");
const label = () => "Shape";

describe("outlinePaintedStrokes", () => {
  test("an SVG without a gradient or pattern stroke comes back as it is", () => {
    const input = doc(GRAD, '<path d="M0 0 L10 0" stroke="#000" fill="url(#g)"/>');
    expect(outlinePaintedStrokes(input, label)).toEqual({ svg: input, warnings: [] });
  });

  test("a gradient stroke becomes a filled outline painted by the same gradient, at the stroke's opacity", () => {
    const out = parse(outlinePaintedStrokes(doc(GRAD, '<path id="p" d="M10 60 L190 60" fill="none" stroke="url(#g)" stroke-width="10" stroke-opacity="0.5"/>'), label).svg);
    const paths = Array.from(out.getElementsByTagName("path"));
    expect(paths).toHaveLength(1);
    const outline = paths[0];
    expect(outline.getAttribute("fill")).toBe("url(#g)");
    expect(outline.getAttribute("fill-opacity")).toBe("0.5");
    expect(outline.getAttribute("fill-rule")).toBe("nonzero");
    expect(outline.getAttribute("stroke")).toBe("none");
    // The id moves to the group that stands in for the element.
    expect(outline.parentElement?.getAttribute("id")).toBe("p");
  });

  test("a filled shape keeps its fill under the outline, and its transform and opacity move to the group", () => {
    const out = parse(
      outlinePaintedStrokes(doc(GRAD, '<rect x="10" y="10" width="50" height="20" fill="#eeeeee" stroke="url(#g)" stroke-width="2" transform="rotate(10)" opacity="0.8"/>'), label).svg,
    );
    const group = out.getElementsByTagName("g")[0];
    expect(group.getAttribute("transform")).toBe("rotate(10)");
    expect(group.getAttribute("opacity")).toBe("0.8");
    const [rect, outline] = Array.from(group.children);
    expect(rect.tagName).toBe("rect");
    expect(rect.getAttribute("stroke")).toBe("none");
    expect(rect.getAttribute("fill")).toBe("#eeeeee");
    expect(outline.getAttribute("fill")).toBe("url(#g)");
  });

  test("a stroke inherited from a group, and a pattern stroke, are both converted", () => {
    const pattern = '<pattern id="h" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M0 8 L8 0" stroke="#123456"/></pattern>';
    const out = parse(outlinePaintedStrokes(doc(pattern, '<g stroke="url(#h)" stroke-width="3"><line x1="0" y1="0" x2="50" y2="0"/></g>'), label).svg);
    const outline = Array.from(out.querySelectorAll("path")).find((p) => p.getAttribute("fill") === "url(#h)");
    expect(outline).toBeDefined();
    expect(out.getElementsByTagName("line")).toHaveLength(0);
  });

  test("an objectBoundingBox gradient is laid out on the stroked geometry's box through a userSpaceOnUse copy", () => {
    const obb = '<linearGradient id="o"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>';
    const out = parse(outlinePaintedStrokes(doc(obb, '<path d="M10 20 L110 70" fill="none" stroke="url(#o)" stroke-width="4"/>'), label).svg);
    const copy = Array.from(out.getElementsByTagName("linearGradient")).find((g) => g.getAttribute("id") !== "o");
    expect(copy?.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
    expect(copy?.getAttribute("gradientTransform")).toBe("matrix(100 0 0 50 10 20)");
    expect([copy?.getAttribute("x1"), copy?.getAttribute("x2")]).toEqual(["0", "1"]);
    expect(out.querySelector("path")?.getAttribute("fill")).toBe(`url(#${copy?.getAttribute("id")})`);
  });

  test("a stroke that cannot be converted keeps its geometry in the gradient's first stop colour, and says so", () => {
    const { svg, warnings } = outlinePaintedStrokes(doc(GRAD, '<path d="M0 0 A5 5 0 0 1 10 0" fill="none" stroke="url(#g)" stroke-width="2"/><text stroke="url(#g)">Hi</text>'), () => "Panel \"plot.svg\"");
    const out = parse(svg);
    expect(out.querySelector("path")?.getAttribute("d")).toBe("M0 0 A5 5 0 0 1 10 0");
    expect(out.querySelector("path")?.getAttribute("stroke")).toBe("#ff0000");
    expect(out.querySelector("text")?.getAttribute("stroke")).toBe("#ff0000");
    expect(warnings).toEqual(['Panel "plot.svg": gradient line drawn in one colour in the PDF']);
  });

  test("a stroke whose width has units it cannot read is reported as well, for a pattern as a pattern", () => {
    const pattern = '<pattern id="h" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M0 8 L8 0" stroke="#123456"/></pattern>';
    const { svg, warnings } = outlinePaintedStrokes(doc(pattern, '<path d="M0 0 L10 0" stroke="url(#h)" stroke-width="2mm"/>'), label);
    expect(parse(svg).querySelector("svg > path")?.getAttribute("stroke")).toBe("#123456");
    expect(warnings).toEqual(["Shape: pattern line drawn in one colour in the PDF"]);
  });

  test("an outline at full stroke opacity says so, rather than taking an ancestor's fill-opacity", () => {
    const out = parse(outlinePaintedStrokes(doc(GRAD, '<g fill-opacity="0.2"><path d="M0 0 L50 0" fill="none" stroke="url(#g)" stroke-width="2"/></g>'), label).svg);
    expect(out.querySelector("path")?.getAttribute("fill-opacity")).toBe("1");
  });

  test("markers draw over the outline, from a copy that draws only them; the filled element keeps none", () => {
    const marker = '<marker id="m" markerWidth="4" markerHeight="4"><path d="M0 0 L4 2 L0 4 Z"/></marker>';
    const out = parse(outlinePaintedStrokes(doc(GRAD + marker, '<path id="p" d="M0 0 L50 0 L50 20" fill="#eeeeee" stroke="url(#g)" stroke-width="2" marker-end="url(#m)"/>'), label).svg);
    const group = out.getElementById("p")!;
    const [shape, outline, markers] = Array.from(group.children);
    expect(shape.getAttribute("fill")).toBe("#eeeeee");
    expect(shape.getAttribute("marker-end")).toBe("none");
    expect(outline.getAttribute("fill")).toBe("url(#g)");
    expect(markers.getAttribute("marker-end")).toBe("url(#m)");
    expect([markers.getAttribute("fill"), markers.getAttribute("stroke")]).toEqual(["none", "none"]);
  });

  test("in a document whose style sheet sets stroke properties, every painted stroke is drawn in one colour and reported", () => {
    // By the element's class, a classed ancestor, an element selector or an id: which rule reaches which is not guessed at.
    for (const [sheet, body] of [
      [".thick { stroke-width: 6 }", '<path class="thick" d="M0 0 L50 0" fill="none" stroke="url(#g)"/>'],
      [".lines path { stroke-dasharray: 2 }", '<g class="lines"><path d="M0 0 L50 0" fill="none" stroke="url(#g)"/></g>'],
      ["path { stroke-linecap: round }", '<path d="M0 0 L50 0" fill="none" stroke="url(#g)"/>'],
      ["#p { stroke-width: 6 }", '<path id="p" d="M0 0 L50 0" fill="none" stroke="url(#g)"/>'],
    ]) {
      const { svg, warnings } = outlinePaintedStrokes(doc(`${GRAD}<style>${sheet}</style>`, `${body}<path d="M0 9 L50 9" fill="none" stroke="url(#g)"/>`), label);
      const paths = Array.from(parse(svg).querySelectorAll("svg > path, svg > g > path"));
      expect(paths.map((p) => p.getAttribute("stroke"))).toEqual(["#ff0000", "#ff0000"]);
      expect(paths.some((p) => p.getAttribute("fill") === "url(#g)")).toBe(false);
      expect(warnings).toEqual(["Shape: gradient line drawn in one colour in the PDF"]);
    }
  });

  test("markers the paint order puts before the stroke are drawn under the outline", () => {
    const marker = '<marker id="m" markerWidth="4" markerHeight="4"><path d="M0 0 L4 2 L0 4 Z"/></marker>';
    const out = parse(
      outlinePaintedStrokes(doc(GRAD + marker, '<path id="p" d="M0 0 L50 0" fill="none" stroke="url(#g)" stroke-width="2" marker-end="url(#m)" paint-order="markers stroke"/>'), label).svg,
    );
    const [markers, outline] = Array.from(out.getElementById("p")!.children);
    expect(markers.getAttribute("marker-end")).toBe("url(#m)");
    expect(outline.getAttribute("fill")).toBe("url(#g)");
  });

  test("a curve in an enlarged user space is flattened finer, to the same tolerance on the page", () => {
    const pieces = (wrap: (body: string) => string) => {
      const out = parse(outlinePaintedStrokes(doc(GRAD, wrap('<path d="M0 0 C3 6 7 -6 10 0" fill="none" stroke="url(#g)" stroke-width="1"/>')), label).svg);
      return (out.querySelector('path[fill="url(#g)"]')?.getAttribute("d")?.match(/L/g) ?? []).length;
    };
    const plainCount = pieces((b) => b);
    expect(pieces((b) => `<g transform="translate(5 5) scale(10)">${b}</g>`)).toBeGreaterThan(plainCount * 2);
    expect(pieces((b) => `<svg width="100" height="100" viewBox="0 0 10 10">${b}</svg>`)).toBeGreaterThan(plainCount * 2);
  });

  test("dashes too fine to outline in reasonable size fall back to one colour with the notice, quickly", () => {
    const started = Date.now();
    const { svg, warnings } = outlinePaintedStrokes(doc(GRAD, '<path d="M0 0 L50 0" fill="none" stroke="url(#g)" stroke-dasharray="0.00001"/>'), label);
    expect(Date.now() - started).toBeLessThan(500);
    expect(parse(svg).querySelector("svg > path")?.getAttribute("stroke")).toBe("#ff0000");
    expect(warnings).toEqual(["Shape: gradient line drawn in one colour in the PDF"]);
  });
});
