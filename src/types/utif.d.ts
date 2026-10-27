// Minimal typings for the corners of UTIF.js (untyped CommonJS) that the TIFF decoder uses.
declare module "utif" {
  export interface IFD {
    width: number;
    height: number;
    /** Raw samples, set by `decodeImage`. 16-bit samples come out little-endian whatever the file's byte order. */
    data: Uint8Array;
    /** Byte order of the file, set by `decodeImage`. */
    isLE: boolean;
    /** ImageWidth and ImageLength, read by `decode` (before `decodeImage` sets `width` and `height`). */
    t256?: number[];
    t257?: number[];
    /** BitsPerSample. */
    t258?: number[];
    /** PhotometricInterpretation. */
    t262?: number[];
    /** SamplesPerPixel. */
    t277?: number[];
    /** PlanarConfiguration. */
    t284?: number[];
    [tag: string]: unknown;
  }

  const UTIF: {
    decode(buff: ArrayBuffer | Uint8Array): IFD[];
    decodeImage(buff: ArrayBuffer | Uint8Array, ifd: IFD): void;
  };
  export default UTIF;
}
