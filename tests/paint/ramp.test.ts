import { builtinPaintTypes } from "../../src/paint/builtin";
import {
  addStop,
  builtinRampGeometries,
  builtinRampPresets,
  colorAt,
  moveStop,
  paintOfRamp,
  rampKindName,
  rampOf,
  removeStop,
  reverseRamp,
  sortStops,
  type ColorRamp,
} from "../../src/paint/ramp";
import { createRegistries } from "../../src/registry";
import { RampGeometryRegistry, type RampGeometryType } from "../../src/registry/ramp";
import type { Paint } from "../../src/model/types";

function registries() {
  const r = createRegistries();
  for (const t of builtinPaintTypes) r.paints.register(t);
  for (const g of builtinRampGeometries) r.rampGeometries.register(g);
  for (const p of builtinRampPresets) r.rampPresets.register(p);
  return r;
}

const of = (paint: Paint) => rampOf(paint, registries());
const write = (ramp: ColorRamp, previous?: Paint) => paintOfRamp(ramp, previous, registries().rampGeometries);
const roundTrip = (paint: Paint) => write(of(paint)!, paint);

describe("rampOf and paintOfRamp", () => {
  test("a solid, a linear and a radial paint come back as they were", () => {
    const paints: Paint[] = [
      { type: "solid", color: "#ff0000" },
      { type: "solid", color: "#ff0000", opacity: 0.5 },
      { type: "linear", angle: 30, stops: [{ offset: 0, color: "#000000" }, { offset: 0.4, color: "#ff0000", opacity: 0.25 }, { offset: 1, color: "#ffffff" }] },
      { type: "radial", cx: 0.25, cy: 0.75, r: 0.6, stops: [{ offset: 0, color: "#0000ff" }, { offset: 1, color: "#00ff00", opacity: 0 }] },
    ];
    for (const paint of paints) {
      expect(roundTrip(paint)).toEqual(paint);
      // Key order too: a written paint serialises as the file had it.
      expect(JSON.stringify(roundTrip(paint))).toBe(JSON.stringify(paint));
      // And from defaults, without a previous paint.
      expect(JSON.stringify(write(of(paint)!))).toBe(JSON.stringify(paint));
    }
    for (const t of builtinPaintTypes.filter((p) => p.ramp)) expect(JSON.stringify(write(of(t.defaults())!))).toBe(JSON.stringify(t.defaults()));
  });

  test("a solid reads as one stop on a linear ramp at angle 0", () => {
    expect(of({ type: "solid", color: "#123456", opacity: 0.5 })).toEqual({ stops: [{ offset: 0, color: "#123456", opacity: 0.5 }], geometry: { kind: "linear", angle: 0 } });
  });

  test("a paint whose type has no ramp hook, or is not registered, has no ramp", () => {
    expect(of({ type: "none" })).toBeUndefined();
    expect(of({ type: "pattern", pattern: "hatch" })).toBeUndefined();
    expect(of({ type: "x.future" })).toBeUndefined();
  });

  test("one stop gives a solid: its colour, and its opacity only when under 1", () => {
    expect(write({ stops: [{ offset: 0.3, color: "#ff0000" }], geometry: { kind: "radial", cx: 0.5, cy: 0.5, r: 0.5 } })).toEqual({ type: "solid", color: "#ff0000" });
    expect(write({ stops: [{ offset: 0, color: "#ff0000", opacity: 1 }], geometry: { kind: "linear", angle: 0 } })).toEqual({ type: "solid", color: "#ff0000" });
    expect(write({ stops: [{ offset: 0, color: "#ff0000", opacity: 0.2 }], geometry: { kind: "linear", angle: 0 } })).toEqual({ type: "solid", color: "#ff0000", opacity: 0.2 });
    // A gradient's extra keys are not carried onto a solid.
    expect(write({ stops: [{ offset: 0, color: "#ff0000" }], geometry: { kind: "linear", angle: 0 } }, { type: "linear", angle: 0, stops: [], note: 1 })).toEqual({ type: "solid", color: "#ff0000" });
  });

  test("two or more stops give the paint of the ramp's geometry, keeping a previous paint's own keys", () => {
    const stops = [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }];
    expect(write({ stops, geometry: { kind: "linear", angle: 45 } })).toEqual({ type: "linear", angle: 45, stops });
    expect(write({ stops, geometry: { kind: "radial", cx: 0.1, cy: 0.2, r: 0.3 } })).toEqual({ type: "radial", cx: 0.1, cy: 0.2, r: 0.3, stops });
    expect(write({ stops, geometry: { kind: "linear", angle: 45 } }, { type: "linear", angle: 0, stops: [], note: "kept" })).toEqual({ type: "linear", angle: 45, stops, note: "kept" });
  });

  test("a plugin's geometry writes its own paint", () => {
    const geometries = new RampGeometryRegistry();
    const conic: RampGeometryType = {
      kind: "x.conic",
      name: "Conic",
      defaults: () => ({ kind: "x.conic", from: 0 }),
      fields: () => [],
      toPaint: (stops, geometry) => ({ type: "x.conic", from: geometry.from, stops }),
    };
    geometries.register(conic);
    const stops = [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }];
    expect(paintOfRamp({ stops, geometry: { kind: "x.conic", from: 90 } }, undefined, geometries)).toEqual({ type: "x.conic", from: 90, stops });
  });

  test("stops are written sorted by offset and kept within 0 to 1", () => {
    const paint = write({ stops: [{ offset: 1.5, color: "#ffffff" }, { offset: -1, color: "#000000" }, { offset: 0.5, color: "#ff0000" }], geometry: { kind: "linear", angle: 0 } });
    expect(paint.stops).toEqual([{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }]);
  });

  test("the kind's name is the paint type's", () => {
    const r = registries();
    expect(rampKindName({ type: "solid", color: "#000000" }, r)).toBe("Solid");
    expect(rampKindName({ type: "linear", angle: 0, stops: [] }, r)).toBe("Linear gradient");
    expect(rampKindName({ type: "radial", stops: [] }, r)).toBe("Radial gradient");
  });
});

describe("the ramp's operations", () => {
  const linear = (stops: ColorRamp["stops"]): ColorRamp => ({ stops, geometry: { kind: "linear", angle: 0 } });

  test("sortStops is stable and clamps", () => {
    const a = { offset: 0.5, color: "#aaaaaa" };
    const b = { offset: 0.5, color: "#bbbbbb" };
    expect(sortStops([{ offset: 2, color: "#ffffff" }, a, b, { offset: -3, color: "#000000" }])).toEqual([{ offset: 0, color: "#000000" }, a, b, { offset: 1, color: "#ffffff" }]);
  });

  test("colorAt interpolates in sRGB with straight alpha", () => {
    const stops = [{ offset: 0, color: "#000000", opacity: 0 }, { offset: 1, color: "#ffffff" }];
    expect(colorAt(stops, 0.5)).toEqual({ color: "#808080", opacity: 0.5 });
    expect(colorAt(stops, 0.25)).toEqual({ color: "#404040", opacity: 0.25 });
    // Outside the stops the end colour holds.
    expect(colorAt([{ offset: 0.2, color: "#ff0000" }, { offset: 0.8, color: "#0000ff" }], 0.1)).toEqual({ color: "#ff0000", opacity: 1 });
    expect(colorAt([{ offset: 0.2, color: "#ff0000" }, { offset: 0.8, color: "#0000ff" }], 0.9)).toEqual({ color: "#0000ff", opacity: 1 });
    expect(colorAt([{ offset: 0.2, color: "#ff0000" }, { offset: 0.8, color: "#0000ff" }], 0.5)).toEqual({ color: "#800080", opacity: 1 });
    // Short hex is read; a colour that cannot be read takes the nearer stop's.
    expect(colorAt([{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], 0.5).color).toBe("#800080");
    expect(colorAt([{ offset: 0, color: "red" }, { offset: 1, color: "#0000ff" }], 0.4).color).toBe("red");
  });

  test("addStop puts the ramp's colour there, with its opacity, and says which stop it is", () => {
    const { ramp, index } = addStop(linear([{ offset: 0, color: "#000000", opacity: 0 }, { offset: 1, color: "#ffffff" }]), 0.5);
    expect(index).toBe(1);
    expect(ramp.stops[1]).toEqual({ offset: 0.5, color: "#808080", opacity: 0.5 });
    // An opaque colour gets no opacity key.
    expect(addStop(linear([{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }]), 0.25).ramp.stops[1]).toEqual({ offset: 0.25, color: "#404040" });
  });

  test("a solid that gains a stop is a linear gradient at angle 0", () => {
    const solid = of({ type: "solid", color: "#ff0000" })!;
    const { ramp, index } = addStop(solid, 0.7);
    expect(index).toBe(1);
    expect(write(ramp, { type: "solid", color: "#ff0000" })).toEqual({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.7, color: "#ff0000" }] });
  });

  test("removeStop takes a stop away, never the last", () => {
    const two = linear([{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
    const one = removeStop(two, 0);
    expect(one.stops).toEqual([{ offset: 1, color: "#ffffff" }]);
    expect(write(one)).toEqual({ type: "solid", color: "#ffffff" });
    expect(removeStop(one, 0)).toEqual(one);
  });

  test("moveStop keeps the order and follows the moved stop past a neighbour", () => {
    const ramp = linear([{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }]);
    const moved = moveStop(ramp, 0, 0.75);
    expect(moved.index).toBe(1);
    expect(moved.ramp.stops.map((s) => s.color)).toEqual(["#ff0000", "#000000", "#ffffff"]);
    expect(moved.ramp.stops[1].offset).toBe(0.75);
    expect(moveStop(ramp, 1, 3).ramp.stops[2]).toEqual({ offset: 1, color: "#ff0000" });
  });

  test("reverseRamp flips each offset and the order follows", () => {
    const ramp = linear([{ offset: 0, color: "#000000" }, { offset: 0.25, color: "#ff0000", opacity: 0.5 }, { offset: 1, color: "#ffffff" }]);
    expect(reverseRamp(ramp).stops).toEqual([{ offset: 0, color: "#ffffff" }, { offset: 0.75, color: "#ff0000", opacity: 0.5 }, { offset: 1, color: "#000000" }]);
    expect(reverseRamp(reverseRamp(ramp))).toEqual(ramp);
  });
});

describe("the presets", () => {
  const preset = (id: string) => builtinRampPresets.find((p) => p.id === id)!;
  const ramp: ColorRamp = { stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00", opacity: 0.5 }, { offset: 1, color: "#0000ff" }], geometry: { kind: "linear", angle: 30 } };

  test("are Solid, Two-colour linear, Radial and Reverse", () => {
    expect(builtinRampPresets.map((p) => p.name)).toEqual(["Solid", "Two-colour linear", "Radial", "Reverse"]);
  });

  test("Solid keeps the selected stop's colour", () => {
    expect(write(preset("solid").apply(ramp, 1))).toEqual({ type: "solid", color: "#00ff00", opacity: 0.5 });
  });

  test("Two-colour linear takes the first and last colours, or black to white", () => {
    expect(write(preset("linear2").apply(ramp, 1))).toEqual({ type: "linear", angle: 30, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] });
    expect(write(preset("linear2").apply(of({ type: "solid", color: "#ff0000" })!, 0))).toEqual({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] });
  });

  test("Radial keeps the current stops", () => {
    expect(write(preset("radial").apply(ramp, 0))).toEqual({ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: ramp.stops });
  });

  test("Reverse flips the ramp", () => {
    expect(preset("reverse").apply(ramp, 0)).toEqual(reverseRamp(ramp));
  });
});
