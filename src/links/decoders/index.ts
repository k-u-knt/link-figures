import type { AdjustmentRegistry } from "../../registry/adjustment";
import type { Decoders } from "../types";
import { decodePdf } from "./pdf";
import { decodeRaster } from "./raster";
import { decodeTiff } from "./tiff";

/** The decoders, drawing TIFF and adjusted raster panels with the adjustments registered in `adjustments`. */
export function createDecoders(adjustments: AdjustmentRegistry): Decoders {
  return {
    pdf: decodePdf,
    tiff: (bytes, pageIndex, recipe) => decodeTiff(bytes, pageIndex, recipe, adjustments),
    raster: (bytes, recipe) => decodeRaster(bytes, recipe, adjustments),
  };
}
