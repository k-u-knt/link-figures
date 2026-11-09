import { describe, expect, it, vi } from "vitest";
import { channelSamples, displayAdjustment, displayChannelCount, seedDisplay, type DisplayChannel } from "../../src/adjust/display";
import { builtinLuts } from "../../src/adjust/luts";
import { planeToRgba, type Plane } from "../../src/links/decoders/tiff-convert";
import { LutRegistry } from "../../src/registry/lut";

function luts(): LutRegistry {
  const registry = new LutRegistry();
  for (const l of builtinLuts) registry.register(l);
  return registry;
}

const display = displayAdjustment(luts());

function render(plane: Plane, channels: DisplayChannel[]): number[] {
  return [...display.apply(plane, { channels }).data];
}

function grey8(values: number[], whiteIsZero = false): Plane {
  return { width: values.length, height: 1, bitsPerSample: 8, samplesPerPixel: 1, data: Uint8Array.from(values), whiteIsZero };
}

/** Every 8-bit value, so each step of the table is checked. */
const all8 = Array.from({ length: 256 }, (_, i) => i);

/** 16-bit values with exact halves under many spans, plus the ends. */
const some16 = [0, 1, 2, 3, 100, 101, 257, 1000, 1001, 2550, 2551, 30000, 32767, 32768, 65534, 65535];

const planes: Record<string, Plane> = {
  "8-bit grey": grey8(all8),
  "16-bit grey": { width: 4, height: 4, bitsPerSample: 16, samplesPerPixel: 1, data: Uint16Array.from([1000, 1001, 1002, 1003, 1004, 1255, 1256, 1100, 1101, 1127, 1128, 1129, 1050, 1051, 1200, 1201]) },
  "16-bit 3-sample": { width: 2, height: 2, bitsPerSample: 16, samplesPerPixel: 3, data: Uint16Array.from([500, 600, 700, 501, 1010, 755, 627, 628, 629, 999, 501, 760]) },
  "8-bit 4-sample raster": { width: 3, height: 1, bitsPerSample: 8, samplesPerPixel: 4, data: Uint8Array.from([10, 20, 30, 0, 127, 128, 129, 128, 250, 251, 252, 255]) },
  "16-bit 4-sample": { width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 4, data: Uint16Array.from([100, 200, 300, 65535, 400, 500, 355, 32896]) },
  "8-bit whiteIsZero grey": grey8(all8, true),
  "16-bit whiteIsZero grey": { width: 4, height: 2, bitsPerSample: 16, samplesPerPixel: 1, data: Uint16Array.from([1000, 1001, 1002, 1127, 1128, 1255, 1256, 1100]), whiteIsZero: true },
};

describe("a freshly seeded display (Review Focus 1)", () => {
  for (const [name, plane] of Object.entries(planes)) {
    it(`renders ${name} exactly as planeToRgba on "auto"`, () => {
      expect(render(plane, seedDisplay(plane, "auto"))).toEqual([...planeToRgba(plane, "auto").rgba]);
    });

    for (const range of [{ min: 3, max: 250 }, { min: 1001, max: 1256 }, { min: 0, max: 65535 }, { min: 1100, max: 1100 }, { min: 600, max: 500 }]) {
      it(`renders ${name} exactly as planeToRgba on ${JSON.stringify(range)}`, () => {
        expect(render(plane, seedDisplay(plane, range))).toEqual([...planeToRgba(plane, range).rgba]);
      });
    }
  }

  it("renders a flat 16-bit plane, plain and whiteIsZero, as planeToRgba's mid-grey", () => {
    for (const whiteIsZero of [false, true]) {
      const flat: Plane = { width: 2, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: Uint16Array.from([700, 700]), whiteIsZero };
      expect(render(flat, seedDisplay(flat, "auto"))).toEqual([...planeToRgba(flat, "auto").rgba]);
    }
  });

  it("seeds grey for one sample and red, green, blue for three or four, at gamma 1 and visible", () => {
    expect(seedDisplay(planes["16-bit grey"], "auto")).toEqual([{ min: 1000, max: 1256, gamma: 1, lut: "grey", visible: true }]);
    const rgb = { min: 500, max: 1010, gamma: 1, visible: true };
    expect(seedDisplay(planes["16-bit 3-sample"], "auto")).toEqual([{ ...rgb, lut: "red" }, { ...rgb, lut: "green" }, { ...rgb, lut: "blue" }]);
    expect(seedDisplay(planes["8-bit 4-sample raster"], { min: 5, max: 9 }).map((c) => [c.min, c.max, c.lut])).toEqual([[5, 9, "red"], [5, 9, "green"], [5, 9, "blue"]]);
    expect(seedDisplay(planes["8-bit grey"], "auto")[0]).toMatchObject({ min: 0, max: 255 });
  });

  it("seeds a whiteIsZero plane in the inverted values the user sees", () => {
    expect(seedDisplay(planes["16-bit whiteIsZero grey"], "auto")[0]).toMatchObject({ min: 65535 - 1256, max: 65535 - 1000 });
    expect(seedDisplay(planes["8-bit whiteIsZero grey"], { min: 10, max: 200 })[0]).toMatchObject({ min: 55, max: 245 });
  });
});

describe("displayChannelCount and channelSamples", () => {
  it("counts one channel for grey and three for three or four samples", () => {
    expect(displayChannelCount(planes["8-bit grey"])).toBe(1);
    expect(displayChannelCount(planes["16-bit 3-sample"])).toBe(3);
    expect(displayChannelCount(planes["8-bit 4-sample raster"])).toBe(3);
  });

  it("gives a channel's own samples, and says when the user sees them inverted", () => {
    expect(Array.from(channelSamples(planes["8-bit 4-sample raster"], 1).values)).toEqual([20, 128, 251]);
    expect(channelSamples(planes["8-bit 4-sample raster"], 1).invert).toBe(false);
    expect(Array.from(channelSamples(planes["16-bit 3-sample"], 2).values)).toEqual([700, 755, 629, 760]);
    const wiz = channelSamples(grey8([1, 2, 3], true), 0);
    expect(Array.from(wiz.values)).toEqual([1, 2, 3]);
    expect(wiz.invert).toBe(true);
  });
});

describe("the display mapping", () => {
  const grey = (over: Partial<DisplayChannel> = {}): DisplayChannel => ({ min: 0, max: 255, gamma: 1, lut: "grey", visible: true, ...over });
  const fire = builtinLuts.find((l) => l.id === "fire")!.table();

  it("colours grey through the fire LUT", () => {
    const out = render(grey8([0, 64, 200, 255]), [grey({ lut: "fire" })]);
    for (const [i, v] of [0, 64, 200, 255].entries()) expect(out.slice(i * 4, i * 4 + 4)).toEqual([fire[v * 3], fire[v * 3 + 1], fire[v * 3 + 2], 255]);
  });

  it("adds visible channels and clamps at 255", () => {
    const plane: Plane = { width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 3, data: Uint8Array.from([200, 100, 50]) };
    const out = render(plane, [grey({ lut: "yellow" }), grey({ lut: "red" }), grey({ lut: "cyan" })]);
    // R: 200 + 100 + 0, G: 200 + 0 + 50, B: 0 + 0 + 50.
    expect(out).toEqual([255, 250, 50, 255]);
  });

  it("leaves out a channel that is not visible", () => {
    const plane: Plane = { width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 3, data: Uint8Array.from([200, 100, 50]) };
    expect(render(plane, [grey({ lut: "red" }), grey({ lut: "green", visible: false }), grey({ lut: "blue" })])).toEqual([200, 0, 50, 255]);
  });

  it("bends mid-grey by gamma: 0.5 at gamma 2 is 255 * 0.5^0.5", () => {
    expect(render(grey8([127]), [grey({ max: 254, gamma: 2 })]).slice(0, 3)).toEqual([180, 180, 180]);
    expect(Math.round(255 * Math.sqrt(0.5))).toBe(180);
  });

  it("maps everything to the LUT at 0.5 when max is not above min", () => {
    expect(render(grey8([0, 90, 255]), [grey({ min: 90, max: 90 })])).toEqual([128, 128, 128, 255, 128, 128, 128, 255, 128, 128, 128, 255]);
    expect(render(grey8([0, 255]), [grey({ min: 200, max: 100, lut: "fire" })]).slice(0, 3)).toEqual([fire[384], fire[385], fire[386]]);
  });

  it("clamps samples outside min..max", () => {
    expect(render(grey8([0, 10, 20, 30]), [grey({ min: 10, max: 20 })]).filter((_, i) => i % 4 === 0)).toEqual([0, 0, 255, 255]);
  });

  it("draws an unknown LUT as grey and reports it once", () => {
    const onUnknownLut = vi.fn();
    const adjustment = displayAdjustment(luts(), onUnknownLut);
    const params = { channels: [grey({ lut: "nope" })] };
    expect([...adjustment.apply(grey8([0, 77]), params).data]).toEqual([0, 0, 0, 255, 77, 77, 77, 255]);
    adjustment.apply(grey8([5]), params);
    expect(onUnknownLut).toHaveBeenCalledTimes(1);
    expect(onUnknownLut).toHaveBeenCalledWith("nope");
  });

  it("fills missing or malformed channels from the plane's auto seed", () => {
    const plane = planes["16-bit 3-sample"];
    const expected = [...planeToRgba(plane, "auto").rgba];
    expect([...display.apply(plane, {}).data]).toEqual(expected);
    expect([...display.apply(plane, { channels: [{ lut: 7 }, null] }).data]).toEqual(expected);
    // An extra channel is ignored.
    expect([...display.apply(plane, { channels: [...seedDisplay(plane, "auto"), grey({ lut: "fire" })] }).data]).toEqual(expected);
  });

  it("is the map adjustment `display`", () => {
    expect(display.id).toBe("display");
    expect(display.stage).toBe("map");
    expect(display.name).toBe("Display");
  });
});
