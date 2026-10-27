import { MAX_DECODE_MEGAPIXELS } from "../../constants";

/** A decode refused because the image would be too large to hold: its message names the size and the limit. */
export class DecodeLimitError extends Error {
  constructor(
    message: string,
    /** The size that was refused, in pixels. */
    readonly width: number,
    readonly height: number,
  ) {
    super(message);
    this.name = "DecodeLimitError";
  }
}

/**
 * Throws a `DecodeLimitError` when an image of `width` x `height` pixels is over `MAX_DECODE_MEGAPIXELS`. Decoding one
 * holds its samples, an RGBA copy, a canvas and a PNG data URL at once, and above Chromium's canvas limit `toDataURL`
 * silently returns an empty `data:`. `what` starts the message: `"TIFF page 2 is 8000×8000 px (64 MP); the limit is 50 MP"`.
 */
export function checkDecodeBudget(width: number, height: number, what: string): void {
  const pixels = width * height;
  // Not a number (a size the file does not give) is left to the decoder, which reports it in its own way.
  if (!(pixels > MAX_DECODE_MEGAPIXELS * 1e6)) return;
  const megapixels = Math.round(pixels / 1e5) / 10;
  throw new DecodeLimitError(`${what} is ${width}×${height} px (${megapixels} MP); the limit is ${MAX_DECODE_MEGAPIXELS} MP`, width, height);
}
