import type { Decoders } from "../types";
import { decodePdf } from "./pdf";
import { decodeTiff } from "./tiff";

export function createDecoders(): Decoders {
  return { pdf: decodePdf, tiff: decodeTiff };
}
