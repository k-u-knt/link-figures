/** The text colours that read on a sheet of the given paper colour. */
export interface PaperInk {
  /** Black on light paper, white on dark; `#rrggbb`. */
  ink: string;
  /** The ink 60% of the way toward the paper, for secondary text and hairlines; `#rrggbb`. */
  muted: string;
}

type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** How far toward the paper the muted ink is blended. */
const MUTED_BLEND = 0.6;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (the alpha is ignored); null for anything else. */
function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((d) => d + d).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

const toHex = ([r, g, b]: Rgb): string => "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");

/** Paper that cannot be read as a colour counts as white. */
export function paperInk(paper: string): PaperInk {
  const rgb = parseHex(paper) ?? WHITE;
  const inkRgb = luminance(rgb) >= 0.5 ? BLACK : WHITE;
  const muted = inkRgb.map((c, i) => Math.round(c + (rgb[i] - c) * MUTED_BLEND)) as Rgb;
  return { ink: toHex(inkRgb), muted: toHex(muted) };
}
