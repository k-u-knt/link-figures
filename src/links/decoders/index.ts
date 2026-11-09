import { hasActiveAdjustments } from "../../adjust/render";
import type { AdjustmentRegistry } from "../../registry/adjustment";
import type { Decoders } from "../types";
import { decodePdf } from "./pdf";
import { decodeRaster, rasterPlane } from "./raster";
import { SampleCache } from "./sample-cache";
import { decodeTiff, tiffPlane } from "./tiff";

/**
 * The decoders, drawing TIFF and adjusted raster panels with the adjustments registered in `adjustments`. They share
 * one cache of decoded samples (see `SampleCache`), used for each call that gives a samples key.
 */
export function createDecoders(adjustments: AdjustmentRegistry): Decoders {
  const cache = new SampleCache();
  return {
    pdf: decodePdf,
    tiff: (bytes, pageIndex, recipe, key) => decodeTiff(bytes, pageIndex, recipe, adjustments, cache, key),
    raster: (bytes, recipe, key) => decodeRaster(bytes, recipe, adjustments, cache, key),
    adjusts: (recipe) => hasActiveAdjustments(recipe, adjustments),
    samples: (key) => cache.get(key),
    decodeSamples: async (bytes, source, pageIndex, key) =>
      source === "tiff" ? tiffPlane(bytes, pageIndex, cache, key).plane : rasterPlane(bytes, cache, key),
  };
}
