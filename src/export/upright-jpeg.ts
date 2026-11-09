import { checkDecodeBudget } from "../links/decoders/budget";

/** The JPEG quality a turned photo is encoded at: close to the camera's own, at a fraction of a PNG's size. */
export const UPRIGHT_JPEG_QUALITY = 0.95;

/** A decoded picture, as `createImageBitmap` gives it: its size (turned by its EXIF), and `close` to free its pixels. */
export interface JpegBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** How a photo is decoded and encoded again: the browser's canvas (`browserJpegCanvas`), or a stand-in in a test. */
export interface JpegCanvas {
  /** The picture, turned upright by its EXIF orientation. */
  decode(blob: Blob): Promise<JpegBitmap>;
  /** `bitmap` drawn at its size and encoded as `type` at `quality`. */
  encode(bitmap: JpegBitmap, type: string, quality: number): Promise<Blob>;
}

/** A photo turned upright: its JPEG bytes and its pixel size. */
export interface UprightJpeg {
  bytes: ArrayBuffer;
  width: number;
  height: number;
}

/** Turns a photo upright (see `turnJpegUpright`); `AssetDeps.turnJpeg` takes another in a test. */
export type JpegTurner = (bytes: ArrayBuffer) => Promise<UprightJpeg>;

/**
 * The JPEG `bytes` turned upright by their EXIF orientation, as the stage's `<img>` draws them, encoded again as a JPEG
 * at `UPRIGHT_JPEG_QUALITY`: drawn straight from the decoded bitmap onto a canvas, with no read-back of its pixels.
 * Rejects (a `DecodeLimitError`) for a photo over the decode budget before it is drawn, or when decoding or encoding
 * fails; the bitmap is closed whatever happens.
 */
export async function turnJpegUpright(bytes: ArrayBuffer, canvas: JpegCanvas = browserJpegCanvas): Promise<UprightJpeg> {
  const bitmap = await canvas.decode(new Blob([bytes], { type: "image/jpeg" }));
  try {
    const { width, height } = bitmap;
    checkDecodeBudget(width, height, "Photo");
    const blob = await canvas.encode(bitmap, "image/jpeg", UPRIGHT_JPEG_QUALITY);
    return { bytes: await blob.arrayBuffer(), width, height };
  } finally {
    bitmap.close();
  }
}

/** The browser's: `createImageBitmap` with `imageOrientation: "from-image"`, and an OffscreenCanvas where there is one. */
export const browserJpegCanvas: JpegCanvas = {
  decode: (blob) => createImageBitmap(blob, { imageOrientation: "from-image" }),
  async encode(bitmap, type, quality) {
    const { width, height } = bitmap;
    const source = bitmap as unknown as CanvasImageSource;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable");
      context.drawImage(source, 0, 0);
      return canvas.convertToBlob({ type, quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable");
      context.drawImage(source, 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the photo could not be encoded"))), type, quality),
      );
    } finally {
      // Frees the canvas's pixels now rather than when it is collected.
      canvas.width = 0;
      canvas.height = 0;
    }
  },
};
