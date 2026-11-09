import type { Plane } from "../links/decoders/tiff-convert";
import { autoRange } from "../links/decoders/tiff-convert";
import type { Range16 } from "../model/types";
import type { MapAdjustmentType, RgbaImage, SampleImage } from "../registry/adjustment";
import type { LutRegistry } from "../registry/lut";

/**
 * How one channel of a plane is drawn: samples from `min` to `max` stretch over the LUT, bent by `gamma`. `min` and
 * `max` are in the values the user sees: for a `whiteIsZero` plane that is the inverted sample, (2^bits − 1) − v.
 */
export type DisplayChannel = { min: number; max: number; gamma: number; lut: string; visible: boolean };

/** One display channel for a grey plane, three for RGB or RGBA (alpha is never a channel). */
export function displayChannelCount(plane: Plane): 1 | 3 {
  return plane.samplesPerPixel === 1 ? 1 : 3;
}

/** The highest sample value of the plane's bit depth. */
export function topValue(plane: Plane): number {
  return plane.bitsPerSample === 8 ? 255 : 65535;
}

/**
 * The raw samples of `channel` (0-based colour sample), in pixel order. `invert` is true for a `whiteIsZero` plane:
 * the value the user sees (and that `min`/`max`, the histogram and auto work in) is then (2^bits − 1) − v.
 */
export function channelSamples(plane: Plane, channel: number): { values: ArrayLike<number>; invert: boolean } {
  const invert = plane.whiteIsZero === true && plane.samplesPerPixel === 1;
  const { data, samplesPerPixel } = plane;
  if (samplesPerPixel === 1) return { values: data, invert };
  const pixels = plane.width * plane.height;
  const values = data instanceof Uint16Array ? new Uint16Array(pixels) : new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) values[i] = data[i * samplesPerPixel + channel];
  return { values, invert };
}

/**
 * The channels that draw `plane` exactly as `planeToRgba(plane, range)` does (§10.1): one shared min/max — 0..255 for
 * an 8-bit plane on "auto", the shared auto range of the colour samples for a 16-bit one, or `range` itself — gamma 1,
 * and LUT `grey` or `red`/`green`/`blue`. For a `whiteIsZero` plane the range is turned into the inverted values the
 * user sees (min = top − range.max, max = top − range.min).
 */
export function seedDisplay(plane: Plane, range: Range16 | "auto"): DisplayChannel[] {
  const raw = range !== "auto" ? range : plane.bitsPerSample === 8 ? { min: 0, max: 255 } : autoRange(plane.data, plane.samplesPerPixel);
  const invert = plane.whiteIsZero === true && plane.samplesPerPixel === 1;
  const top = topValue(plane);
  const { min, max } = invert ? { min: top - raw.max, max: top - raw.min } : raw;
  const luts = displayChannelCount(plane) === 1 ? ["grey"] : ["red", "green", "blue"];
  return luts.map((lut) => ({ min, max, gamma: 1, lut, visible: true }));
}

/** `channels[index]` read defensively over `fallback` (params come from the file). */
export function readChannel(value: unknown, fallback: DisplayChannel): DisplayChannel {
  if (typeof value !== "object" || value === null) return fallback;
  const v = value as Record<string, unknown>;
  const finite = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
  const gamma = finite(v.gamma, fallback.gamma);
  return {
    min: finite(v.min, fallback.min),
    max: finite(v.max, fallback.max),
    gamma: gamma > 0 ? gamma : fallback.gamma,
    lut: typeof v.lut === "string" ? v.lut : fallback.lut,
    visible: typeof v.visible === "boolean" ? v.visible : fallback.visible,
  };
}

/**
 * The channels a panel's display draws with, given its `display` adjustment's `params` (undefined when it has none):
 * with a plane, one per channel of it — the adjustment's own, each missing or malformed one filled as drawing fills it
 * (the plane's "auto" seed), or without an adjustment the seed of what the panel shows by its `range` (§10.1). Without a
 * plane only the adjustment's stored channels are known (each read over a 16-bit grey fallback); none without either.
 */
export function displayChannelsOf(params: Record<string, unknown> | undefined, plane: Plane | null, range: Range16 | "auto"): DisplayChannel[] {
  const given = params && Array.isArray(params.channels) ? (params.channels as unknown[]) : [];
  if (!plane) {
    const fallback: DisplayChannel = { min: 0, max: 65535, gamma: 1, lut: "grey", visible: true };
    return given.map((c) => readChannel(c, fallback));
  }
  if (!params) return seedDisplay(plane, range);
  return seedDisplay(plane, "auto").map((fallback, c) => readChannel(given[c], fallback));
}

/**
 * Raw sample value (0..2^bits − 1) to the LUT step (0..255) of one channel. A `whiteIsZero` sample is inverted first
 * (u = top − v). Then t = clamp((u − min) / (max − min), 0, 1), t = t^(1/gamma), step = round(255 t); `max ≤ min`
 * gives t = 0.5. As in `planeToRgba`'s table, the product is formed before dividing so exact halves stay exact.
 *
 * Rounding matches `planeToRgba` byte for byte when gamma is 1: half up for a plain plane; for a `whiteIsZero` plane
 * the step is rounded from the top (255 − round(255 (1 − t))), because `planeToRgba` rounds the raw sample and inverts
 * afterwards. The two differ only on exact halves (a flat whiteIsZero plane is 127, as there).
 */
function stepTable(plane: Plane, channel: DisplayChannel, invert: boolean): Uint8Array {
  const top = topValue(plane);
  const table = new Uint8Array(top + 1);
  const { min, max, gamma } = channel;
  const span = max - min;
  const clamp = (x: number): number => (x < 0 ? 0 : x > 255 ? 255 : x);
  const bend = gamma === 1 ? (x: number) => x : (x: number) => 255 * Math.pow(x / 255, 1 / gamma);
  for (let v = 0; v <= top; v++) {
    const u = invert ? top - v : v;
    let step: number;
    if (span <= 0) {
      const x = bend(127.5);
      step = invert ? 255 - Math.round(255 - x) : Math.round(x);
    } else if (invert && gamma === 1) {
      step = 255 - Math.round(clamp(((max - u) * 255) / span));
    } else {
      const x = bend(clamp(((u - min) * 255) / span));
      step = invert ? 255 - Math.round(255 - x) : Math.round(x);
    }
    table[v] = step;
  }
  return table;
}

/**
 * The `display` map adjustment (§3, §10): each channel maps its samples through min/max/gamma onto a LUT, and the
 * visible channels' colours add per component, clamped to 255. Alpha (a fourth sample) passes through: 8-bit copied,
 * 16-bit scaled by 1/257, as `planeToRgba`. Missing or malformed channels take the plane's "auto" seed; extra ones
 * are ignored. An unknown LUT draws as `grey` and is reported to `onUnknownLut` once per id.
 */
export function displayAdjustment(luts: LutRegistry, onUnknownLut?: (id: string) => void): MapAdjustmentType {
  const reported = new Set<string>();
  const greyTable = (): Uint8Array => {
    const grey = luts.get("grey");
    if (grey) return grey.table();
    const table = new Uint8Array(768);
    for (let i = 0; i < 768; i++) table[i] = Math.floor(i / 3);
    return table;
  };
  const lutTable = (id: string): Uint8Array => {
    const lut = luts.get(id);
    if (lut) return lut.table();
    if (!reported.has(id)) {
      reported.add(id);
      onUnknownLut?.(id);
    }
    return greyTable();
  };

  return {
    id: "display",
    name: "Display",
    stage: "map",
    defaults: () => ({ channels: [] }),
    fields: () => [],
    apply(image: SampleImage, params: Record<string, unknown>): RgbaImage {
      const { width, height, bitsPerSample, samplesPerPixel, data } = image;
      const given = Array.isArray(params.channels) ? (params.channels as unknown[]) : [];
      const seed = seedDisplay(image, "auto");
      const invert = image.whiteIsZero === true && samplesPerPixel === 1;
      const channels = seed
        .map((fallback, c) => ({ c, channel: readChannel(given[c], fallback) }))
        .filter(({ channel }) => channel.visible)
        .map(({ c, channel }) => ({ c, steps: stepTable(image, channel, invert), colours: lutTable(channel.lut) }));

      const pixels = width * height;
      const out = new Uint8ClampedArray(pixels * 4);
      for (let i = 0; i < pixels; i++) {
        const source = i * samplesPerPixel;
        let r = 0;
        let g = 0;
        let b = 0;
        for (const { c, steps, colours } of channels) {
          const k = steps[data[source + c]] * 3;
          r += colours[k];
          g += colours[k + 1];
          b += colours[k + 2];
        }
        const target = i * 4;
        out[target] = r;
        out[target + 1] = g;
        out[target + 2] = b;
        out[target + 3] = samplesPerPixel !== 4 ? 255 : bitsPerSample === 8 ? data[source + 3] : Math.round(data[source + 3] / 257);
      }
      return { width, height, data: out };
    },
  };
}
