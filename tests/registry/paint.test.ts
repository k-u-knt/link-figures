import { builtinPaintTypes } from "../../src/paint/builtin";
import { createRegistries } from "../../src/registry";
import { PaintRegistry, paintToSvg, strokeAttrs, type PaintType } from "../../src/registry/paint";
import type { Paint, Stroke } from "../../src/model/types";

const box = { x: 10, y: 20, width: 100, height: 50 };

function registry(): PaintRegistry {
  const r = new PaintRegistry();
  for (const t of builtinPaintTypes) r.register(t);
  return r;
}

/** The ids a real SVG build hands out: `prefix-1`, `prefix-2`… per prefix. */
function context(warnings?: string[]) {
  const counters = new Map<string, number>();
  return {
    warnings,
    uid(prefix: string) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
  };
}

const svg = (paint: Paint, warnings?: string[]) => paintToSvg(registry(), paint, box, context(warnings));

describe("PaintRegistry", () => {
  test("replaces by id in place and keeps registration order", () => {
    const r = new PaintRegistry();
    const p = (id: string, name: string): PaintType => ({ id, name, defaults: () => ({ type: id }), fields: () => [], toSvg: () => ({ ref: "none", defs: [] }) });
    r.register(p("solid", "Solid"));
    r.register(p("linear", "Linear"));
    r.register(p("solid", "Solid2"));
    expect(r.all().map((t) => t.id)).toEqual(["solid", "linear"]);
    expect(r.get("solid")!.name).toBe("Solid2");
    expect(r.get("missing")).toBeUndefined();
  });

  test("createRegistries includes an empty paint registry", () => expect(createRegistries().paints.all()).toEqual([]));

  test("the built-ins are none, solid, linear, radial and pattern, and each one's defaults are of its own type", () => {
    expect(builtinPaintTypes.map((t) => t.id)).toEqual(["none", "solid", "linear", "radial", "pattern"]);
    for (const t of builtinPaintTypes) expect(t.defaults().type).toBe(t.id);
  });

  test("defaults are a fresh object each time", () => {
    const linear = registry().get("linear")!;
    const a = linear.defaults();
    (a.stops as unknown[]).push({ offset: 0.5, color: "#ff0000" });
    expect(linear.defaults().stops).toHaveLength(2);
  });
});

describe("built-in toSvg", () => {
  test("none paints nothing", () => expect(svg({ type: "none" })).toEqual({ ref: "none", defs: [] }));

  test("solid is its colour, with its opacity when it has one", () => {
    expect(svg({ type: "solid", color: "#ff0000" })).toEqual({ ref: "#ff0000", defs: [] });
    expect(svg({ type: "solid", color: "#ff0000", opacity: 0.5 })).toEqual({ ref: "#ff0000", defs: [], opacity: 0.5 });
    expect(svg({ type: "solid", color: "#ff0000", opacity: 1 })).toEqual({ ref: "#ff0000", defs: [] });
  });

  test("a 0° linear gradient runs left to right across the box's middle, in user space", () => {
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#ffffff", opacity: 0.5 },
    ];
    expect(svg({ type: "linear", angle: 0, stops })).toEqual({
      ref: "url(#grad-1)",
      defs: [
        '<linearGradient id="grad-1" gradientUnits="userSpaceOnUse" x1="10" y1="45" x2="110" y2="45"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.5"/></linearGradient>',
      ],
    });
  });

  test("a 90° linear gradient runs top to bottom, and 180° right to left", () => {
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#ffffff" },
    ];
    expect(svg({ type: "linear", angle: 90, stops }).defs[0]).toContain('x1="60" y1="20" x2="60" y2="70"');
    expect(svg({ type: "linear", angle: 180, stops }).defs[0]).toContain('x1="110" y1="45" x2="10" y2="45"');
    expect(svg({ type: "linear", angle: -90, stops }).defs[0]).toContain('x1="60" y1="70" x2="60" y2="20"');
  });

  test("a diagonal linear gradient's line reaches the box's corners", () => {
    const def = svg({ type: "linear", angle: 45, stops: [] }).defs[0];
    const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) => Number(new RegExp(` ${k}="([^"]+)"`).exec(def)![1]));
    // The corners project onto the line at its ends: the line spans (w + h)·cos45° along 45°.
    expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(150 * Math.SQRT1_2);
    expect((x1 + x2) / 2).toBeCloseTo(60);
    expect((y1 + y2) / 2).toBeCloseTo(45);
  });

  test("stops are written in offset order, kept within 0 to 1", () => {
    const def = svg({ type: "linear", angle: 0, stops: [{ offset: 1.5, color: "#ffffff" }, { offset: -1, color: "#000000" }] }).defs[0];
    expect(def).toContain('<stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/>');
  });

  test("a radial gradient is centred on its fraction of the box, its radius a fraction of the longer side", () => {
    const stops = [
      { offset: 0, color: "#ff0000" },
      { offset: 1, color: "#0000ff" },
    ];
    expect(svg({ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops })).toEqual({
      ref: "url(#grad-1)",
      defs: [
        '<radialGradient id="grad-1" gradientUnits="userSpaceOnUse" cx="60" cy="45" r="50"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></radialGradient>',
      ],
    });
    expect(svg({ type: "radial", cx: 0, cy: 1, r: 0.25, stops }).defs[0]).toContain('cx="10" cy="70" r="25"');
  });

  test("a hatch pattern tiles from the box's corner, with its background", () => {
    expect(svg({ type: "pattern", pattern: "hatch", fg: "#000000", bg: "#ffffff", scale: 1, angle: 0 })).toEqual({
      ref: "url(#pattern-1)",
      defs: [
        '<pattern id="pattern-1" patternUnits="userSpaceOnUse" x="10" y="20" width="8" height="8"><rect width="8" height="8" fill="#ffffff"/><path d="M0 8 L8 0 M-2 2 L2 -2 M6 10 L10 6" fill="none" stroke="#000000" stroke-width="1"/></pattern>',
      ],
    });
  });

  test("a pattern with no background is transparent between its lines, and its angle turns it about the box's corner", () => {
    expect(svg({ type: "pattern", pattern: "hatchReverse", fg: "#123456", bg: null, scale: 2, angle: 30 }).defs[0]).toBe(
      '<pattern id="pattern-1" patternUnits="userSpaceOnUse" x="10" y="20" width="16" height="16" patternTransform="rotate(30 10 20)"><path d="M0 0 L16 16 M-4 12 L4 20 M12 -4 L20 4" fill="none" stroke="#123456" stroke-width="2"/></pattern>',
    );
  });

  test("crosshatch, grid and dots each draw their own tile", () => {
    const tile = (pattern: string) => svg({ type: "pattern", pattern, fg: "#000000", bg: null, scale: 1, angle: 0 }).defs[0];
    expect(tile("crosshatch")).toContain('<path d="M0 8 L8 0 M-2 2 L2 -2 M6 10 L10 6 M0 0 L8 8 M-2 6 L2 10 M6 -2 L10 2" fill="none" stroke="#000000" stroke-width="1"/>');
    expect(tile("grid")).toContain('<path d="M0 4 L8 4 M4 0 L4 8" fill="none" stroke="#000000" stroke-width="1"/>');
    expect(tile("dots")).toContain('<circle cx="4" cy="4" r="1.5" fill="#000000"/>');
  });

  test("ids are unique within a build", () => {
    const r = registry();
    const ctx = context();
    const stops = [{ offset: 0, color: "#000000" }];
    expect(paintToSvg(r, { type: "linear", angle: 0, stops }, box, ctx).ref).toBe("url(#grad-1)");
    expect(paintToSvg(r, { type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops }, box, ctx).ref).toBe("url(#grad-2)");
  });

  test("a colour that would break out of its attribute is escaped", () => {
    expect(svg({ type: "linear", angle: 0, stops: [{ offset: 0, color: '"><script>' }] }).defs[0]).toContain('stop-color="&quot;&gt;&lt;script&gt;"');
    expect(svg({ type: "solid", color: '"x' }).ref).toBe("&quot;x");
  });

  test("a zero-size box gives finite numbers everywhere", () => {
    const r = registry();
    const zero = { x: 5, y: 5, width: 0, height: 0 };
    for (const t of builtinPaintTypes) {
      const out = paintToSvg(r, t.defaults(), zero, context());
      expect(out.defs.join("")).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe("paintToSvg", () => {
  test("an unknown paint type paints nothing, with a warning", () => {
    const warnings: string[] = [];
    expect(svg({ type: "x.future", foo: 1 }, warnings)).toEqual({ ref: "none", defs: [] });
    expect(warnings).toEqual(['no paint type "x.future" is registered, drawn without paint']);
  });

  test("an unknown paint type with nowhere to warn still paints nothing", () => expect(svg({ type: "x.future" })).toEqual({ ref: "none", defs: [] }));
});

describe("strokeAttrs", () => {
  const stroke = (partial: Partial<Stroke> = {}): Stroke => ({ paint: { type: "solid", color: "#000000" }, width: 1.5, dash: "solid", ...partial });

  test("a solid stroke is its paint and its width in px", () => {
    expect(strokeAttrs(stroke(), "#000000")).toBe('stroke="#000000" stroke-width="2"');
  });

  test("dashes scale with the width, and cap and join are written when set", () => {
    expect(strokeAttrs(stroke({ dash: "dash", cap: "round", join: "bevel" }), "url(#grad-1)")).toBe(
      'stroke="url(#grad-1)" stroke-width="2" stroke-dasharray="8 4" stroke-linecap="round" stroke-linejoin="bevel"',
    );
    expect(strokeAttrs(stroke({ dash: "dot" }), "#000000")).toContain('stroke-dasharray="2 4"');
    expect(strokeAttrs(stroke({ dash: "dashDot" }), "#000000")).toContain('stroke-dasharray="8 4 2 4"');
  });

  test("a paint's own opacity is written as stroke-opacity", () => {
    expect(strokeAttrs(stroke(), "#000000", 0.5)).toBe('stroke="#000000" stroke-width="2" stroke-opacity="0.5"');
  });

  test("a stroke of no width has no dashes", () => {
    expect(strokeAttrs(stroke({ width: 0, dash: "dash" }), "#000000")).toBe('stroke="#000000" stroke-width="0"');
  });
});
