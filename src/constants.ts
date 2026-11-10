import type { Font } from "./model/types";

export const PLUGIN_ID = "link-figures";
export const VIEW_TYPE = "link-figures";
export const FRONTMATTER_KEY = "link-figures";
export const FORMAT_VERSION = 1;
export const FILE_SUFFIX = ".lnkfig.md";
export const FENCE_LANG = "lnkfig";
/** The class of a node's element whose links (`a`) take their own clicks, not the stage (a card's text: see `isOwnClick`). */
export const LIVE_LINKS = "lf-live-links";

export const MM_TO_PX = 96 / 25.4;
export const PAGE_GAP_MM = 20;
export const MIN_NODE_PX = MM_TO_PX;
export const NUDGE_MM = 0.5;
export const NUDGE_LARGE_MM = 5;
export const COALESCE_MS = 300;
export const RESOLVE_DEBOUNCE_MS = 300;

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
export const PANEL_EXTENSIONS = [...IMAGE_EXTENSIONS, "pdf", "tif", "tiff"];
export const PDF_SCREEN_DPI = 150;
/** The largest image a decoder makes (a TIFF plane, a PDF page drawn at a resolution), in millions of pixels. */
export const MAX_DECODE_MEGAPIXELS = 50;
/** The range of the export resolution (dpi). */
export const MIN_DPI = 72;
export const MAX_DPI = 1200;
/** The range of the setting that caps a page's width and height, and its default (millimetres). */
export const MIN_PAGE_LIMIT_MM = 100;
export const MAX_PAGE_LIMIT_MM = 5000;
export const DEFAULT_PAGE_LIMIT_MM = 2000;
export const PT_TO_PX = 96 / 72;
export const PX_TO_PT = 72 / 96;

export const CURATED_FONTS = ["Arial", "Helvetica", "Times New Roman", "Calibri", "Georgia", "Courier New"];

export const DEFAULT_FONT: Font = {
  family: "Arial",
  size: 7,
  weight: "normal",
  italic: false,
  color: "#000000",
  align: "left",
  lineHeight: 1.2,
};

/** A stored page limit kept within its range; anything that is not a number is the default. */
export function normalisePageLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PAGE_LIMIT_MM;
  return Math.min(MAX_PAGE_LIMIT_MM, Math.max(MIN_PAGE_LIMIT_MM, value));
}
