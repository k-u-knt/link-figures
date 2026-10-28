import { hasActiveAdjustments, renderSamples } from "../../src/adjust/render";
import { planeToRgba, type Plane } from "../../src/links/decoders/tiff-convert";
import { mapRedCalls, step, testRegistry } from "./fixtures";

const registry = testRegistry();

/** One 8-bit RGB pixel: R 60, G 50, B 0. */
const rgbPixel = (): Plane => ({ width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 3, data: new Uint8Array([60, 50, 0]) });
/** Two 16-bit grey pixels whose high bytes are 0x12 and 0xab. */
const grey16 = (): Plane => ({ width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: new Uint16Array([0x1234, 0xabcd]) });

beforeEach(() => {
  mapRedCalls.length = 0;
});

describe("renderSamples", () => {
  test("an empty list gives exactly the default mapping", () => {
    const range = { min: 0x1000, max: 0xb000 };
    const out = renderSamples(grey16(), { range, adjustments: [] }, registry);
    expect(out).toEqual({ width: 2, height: 1, data: planeToRgba(grey16(), range).rgba });
  });

  test("pixel adjustments apply in list order", () => {
    // invert then double: R 60 -> 195 -> 255 (clipped); double then invert: R 60 -> 120 -> 135.
    const invertFirst = renderSamples(rgbPixel(), { range: "auto", adjustments: [step("test.invert"), step("test.double")] }, registry);
    const doubleFirst = renderSamples(rgbPixel(), { range: "auto", adjustments: [step("test.double"), step("test.invert")] }, registry);
    expect([...invertFirst.data]).toEqual([255, 205, 255, 255]);
    expect([...doubleFirst.data]).toEqual([135, 205, 255, 255]);
  });

  test("a disabled entry is skipped", () => {
    const out = renderSamples(rgbPixel(), { range: "auto", adjustments: [step("test.invert", false), step("test.double")] }, registry);
    expect([...out.data]).toEqual([120, 50, 0, 255]);
  });

  test("a map adjustment receives the native 16-bit samples, and the range is not applied", () => {
    const out = renderSamples(grey16(), { range: { min: 0, max: 1 }, adjustments: [step("test.mapRed")] }, registry);
    expect(mapRedCalls).toEqual([{ bitsPerSample: 16, samples: [0x1234, 0xabcd] }]);
    expect([...out.data]).toEqual([0x12, 0, 0, 255, 0xab, 0, 0, 255]);
  });

  test("the first enabled map adjustment maps; pixel adjustments then apply to its output", () => {
    const out = renderSamples(grey16(), { range: "auto", adjustments: [step("test.mapRed", false), step("test.invert"), step("test.mapRed"), step("test.mapRed")] }, registry);
    expect(mapRedCalls).toHaveLength(1);
    expect([...out.data]).toEqual([255 - 0x12, 255, 255, 255, 255 - 0xab, 255, 255, 255]);
  });

  test("a map adjustment owns a flat plane: no mid-grey", () => {
    const flat: Plane = { width: 1, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: new Uint16Array([0x4000]) };
    expect([...renderSamples(flat, { range: "auto", adjustments: [step("test.mapRed")] }, registry).data]).toEqual([0x40, 0, 0, 255]);
    expect([...renderSamples(flat, { range: "auto", adjustments: [] }, registry).data]).toEqual([128, 128, 128, 255]);
  });

  test("an unknown type is skipped and reported once, however often it appears", () => {
    const onUnknown = vi.fn();
    const out = renderSamples(rgbPixel(), { range: "auto", adjustments: [step("future.thing"), step("test.double"), step("future.thing")] }, registry, onUnknown);
    expect([...out.data]).toEqual([120, 50, 0, 255]);
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledWith("future.thing");
  });

  test("the samples are never changed, even by in-place pixel adjustments", () => {
    const plane = rgbPixel();
    const before = new Uint8Array(plane.data.buffer.slice(0));
    renderSamples(plane, { range: "auto", adjustments: [step("test.invert"), step("test.double")] }, registry);
    expect(new Uint8Array(plane.data.buffer)).toEqual(before);
  });
});

describe("hasActiveAdjustments", () => {
  test("is true only when an entry is both enabled and registered", () => {
    expect(hasActiveAdjustments({ range: "auto", adjustments: [] }, registry)).toBe(false);
    expect(hasActiveAdjustments({ range: "auto", adjustments: [step("test.invert", false)] }, registry)).toBe(false);
    // An unknown type is skipped when drawing, so it changes nothing.
    expect(hasActiveAdjustments({ range: "auto", adjustments: [step("test.invert", false), step("future.thing")] }, registry)).toBe(false);
    expect(hasActiveAdjustments({ range: "auto", adjustments: [step("future.thing"), step("test.invert")] }, registry)).toBe(true);
  });
});
