import { createApi } from "../src/api";
import { builtinPaintTypes } from "../src/paint/builtin";
import { builtinRampGeometries, builtinRampPresets } from "../src/paint/ramp";
import { createRegistries } from "../src/registry";
import { normalizePath } from "./export/fake-vault";

function api() {
  const registries = createRegistries();
  for (const t of builtinPaintTypes) registries.paints.register(t);
  for (const g of builtinRampGeometries) registries.rampGeometries.register(g);
  for (const p of builtinRampPresets) registries.rampPresets.register(p);
  return createApi({ app: {} as never, registries, files: {} as never, normalizePath, openFigure: () => null });
}

describe("api.ramp", () => {
  test("of reads a solid or gradient paint as a ramp, and nothing else", () => {
    const { ramp } = api();
    expect(ramp.of({ type: "solid", color: "#ff0000" })).toEqual({ stops: [{ offset: 0, color: "#ff0000" }], geometry: { kind: "linear", angle: 0 } });
    expect(ramp.of({ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: [{ offset: 1, color: "#ffffff" }, { offset: 0, color: "#000000" }] })).toEqual({
      stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }],
      geometry: { kind: "radial", cx: 0.5, cy: 0.5, r: 0.5 },
    });
    expect(ramp.of({ type: "pattern" })).toBeUndefined();
  });

  test("toPaint writes one stop as a solid and more by the geometry, as the slider does", () => {
    const { ramp } = api();
    expect(ramp.toPaint({ stops: [{ offset: 0.4, color: "#00ff00", opacity: 0.5 }], geometry: { kind: "linear", angle: 0 } })).toEqual({ type: "solid", color: "#00ff00", opacity: 0.5 });
    const stops = [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }];
    expect(ramp.toPaint({ stops, geometry: { kind: "linear", angle: 90 } })).toEqual({ type: "linear", angle: 90, stops });
    // A paint read and written back is the paint it was.
    const paint = { type: "linear", angle: 15, stops };
    expect(ramp.toPaint(ramp.of(paint)!, paint)).toEqual(paint);
  });

  test("its results are copies: changing one changes nothing the API keeps", () => {
    const { ramp } = api();
    const paint = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };
    const read = ramp.of(paint)!;
    read.stops[0].color = "#123456";
    expect(paint.stops[0].color).toBe("#000000");
  });
});
