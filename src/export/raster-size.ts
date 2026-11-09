const MM_PER_INCH = 25.4;

/** Chromium's canvas limits: the longest side, and the most pixels, a canvas can have. */
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_AREA = 268_435_456;

export interface RasterSize {
  dpi: number;
  widthPx: number;
  heightPx: number;
  /** True when the page did not fit at the dpi asked for, so `dpi` is lower. */
  reduced: boolean;
}

const pixelsAt = (mm: number, dpi: number) => Math.max(1, Math.round((mm / MM_PER_INCH) * dpi));

function sizeAt(page: { width: number; height: number }, dpi: number, reduced: boolean): RasterSize {
  return { dpi, widthPx: pixelsAt(page.width, dpi), heightPx: pixelsAt(page.height, dpi), reduced };
}

const fits = (s: RasterSize) => s.widthPx <= MAX_CANVAS_SIDE && s.heightPx <= MAX_CANVAS_SIDE && s.widthPx * s.heightPx <= MAX_CANVAS_AREA;

/**
 * The page's size in pixels at `dpi` (its size in mm), or, when that is over the canvas limits, at the largest whole
 * dpi that is not (`reduced`).
 */
export function fitDpi(pageMm: { width: number; height: number }, dpi: number): RasterSize {
  const asked = sizeAt(pageMm, dpi, false);
  if (fits(asked)) return asked;
  const inches = { width: pageMm.width / MM_PER_INCH, height: pageMm.height / MM_PER_INCH };
  const bound = Math.min(
    MAX_CANVAS_SIDE / inches.width,
    MAX_CANVAS_SIDE / inches.height,
    Math.sqrt(MAX_CANVAS_AREA / (inches.width * inches.height)),
  );
  // Rounding to whole pixels can put the bound's own size a pixel over, so step down until it fits.
  let fitted = Math.max(1, Math.floor(bound));
  while (fitted > 1 && !fits(sizeAt(pageMm, fitted, true))) fitted--;
  return sizeAt(pageMm, fitted, true);
}
