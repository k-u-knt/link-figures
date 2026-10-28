import { AdjustmentRegistry, type MapAdjustmentType, type PixelAdjustmentType, type RgbaImage, type SampleImage } from "../../src/registry/adjustment";
import type { Adjustment } from "../../src/model/types";

/** Test-only adjustments; never registered in production. */

/** Inverts R, G and B; alpha is kept. In place, as a pixel adjustment may. */
export const invert: PixelAdjustmentType = {
  id: "test.invert",
  name: "Invert (test)",
  stage: "pixel",
  defaults: () => ({}),
  fields: () => [],
  apply(image: RgbaImage): RgbaImage {
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 255 - image.data[i];
      image.data[i + 1] = 255 - image.data[i + 1];
      image.data[i + 2] = 255 - image.data[i + 2];
    }
    return image;
  },
};

/** Doubles R (clipped to 255). */
export const double: PixelAdjustmentType = {
  id: "test.double",
  name: "Double red (test)",
  stage: "pixel",
  defaults: () => ({}),
  fields: () => [],
  apply(image: RgbaImage): RgbaImage {
    for (let i = 0; i < image.data.length; i += 4) image.data[i] = image.data[i] * 2;
    return image;
  },
};

/** What `test.mapRed` was given, call by call: the bit depth and a copy of the samples. */
export const mapRedCalls: { bitsPerSample: number; samples: number[] }[] = [];

/** Puts the high byte of each (first) 16-bit sample into R, with G and B 0 and alpha 255; records what it received. */
export const mapRed: MapAdjustmentType = {
  id: "test.mapRed",
  name: "High byte to red (test)",
  stage: "map",
  defaults: () => ({}),
  fields: () => [],
  apply(image: SampleImage): RgbaImage {
    mapRedCalls.push({ bitsPerSample: image.bitsPerSample, samples: [...image.data] });
    const pixels = image.width * image.height;
    const data = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      data[i * 4] = image.data[i * image.samplesPerPixel] >> 8;
      data[i * 4 + 3] = 255;
    }
    return { width: image.width, height: image.height, data };
  },
};

/** A registry holding the three test adjustments. */
export function testRegistry(): AdjustmentRegistry {
  const registry = new AdjustmentRegistry();
  for (const type of [invert, double, mapRed]) registry.register(type);
  return registry;
}

/** An enabled adjustment entry of `type` with no params. */
export const step = (type: string, enabled = true): Adjustment => ({ type, enabled, params: {} });
