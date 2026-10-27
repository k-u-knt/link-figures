import UTIF from "utif";
import type { Range16 } from "../../model/types";
import type { DecodedImage } from "../types";
import { ifdToPlane, planeToRgba, type Plane } from "./tiff-convert";

/** UTIF decode of one page (index clamped into range) as a `Plane`, plus the file's page count. No DOM. */
export function decodeTiffPage(bytes: ArrayBuffer, pageIndex: number): { plane: Plane; pageCount: number } {
  const ifds = UTIF.decode(bytes);
  if (ifds.length === 0) throw new Error("TIFF contains no images");
  const ifd = ifds[Math.min(Math.max(Math.trunc(pageIndex) || 0, 0), ifds.length - 1)];
  UTIF.decodeImage(bytes, ifd);
  if (!ifd.data) throw new Error("TIFF page has no image data");
  // `decodeImage` byte-swaps big-endian 16-bit samples to little-endian in place, so `ifd.isLE` (the file's byte
  // order) no longer describes `ifd.data`, which is little-endian either way.
  return { plane: ifdToPlane({ ...ifd, isLE: true }), pageCount: ifds.length };
}

/** One TIFF page as a PNG data URL, 16-bit data stretched to 8 bits by `range`. */
export async function decodeTiff(bytes: ArrayBuffer, pageIndex: number, range: Range16 | "auto"): Promise<DecodedImage> {
  const { plane, pageCount } = decodeTiffPage(bytes, pageIndex);
  const { rgba } = planeToRgba(plane, range);
  const canvas = document.createElement("canvas");
  canvas.width = plane.width;
  canvas.height = plane.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.putImageData(new ImageData(rgba, plane.width, plane.height), 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), width: plane.width, height: plane.height, pageCount };
}
