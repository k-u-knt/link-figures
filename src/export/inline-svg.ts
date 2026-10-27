/**
 * Reading and inlining SVG text, for placing a linked `.svg` inside another SVG. Pure string work (no DOM), so it
 * runs in tests and in the exporters alike.
 */

/** CSS pixels per user unit of each absolute length unit, as a fraction (`px * n / d`) so that `72pt` is exactly 96. */
const UNIT_TO_PX: Record<string, [number, number]> = {
  "": [1, 1],
  px: [1, 1],
  pt: [96, 72],
  pc: [96, 6],
  mm: [96, 25.4],
  cm: [96, 2.54],
  in: [96, 1],
};

/** What a browser uses for a replaced element that gives no size at all. */
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;

/** A tag's attribute text: runs to the first `>` that is not inside a quoted value. */
const QUOTED_TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;

/** What may precede the root element: whitespace (a byte order mark counts), the XML declaration, comments, the DOCTYPE. */
const PROLOG_ITEM = /\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>/iy;
const ROOT_START = new RegExp(`<svg(?=[\\s/>])(${QUOTED_TAG_BODY})>`, "y");

interface RootTag {
  /** The attribute text of the root `<svg>`. */
  attrs: string;
  /** Where the markup between the root's start and end tags lies; empty for a self-closing root. */
  innerStart: number;
  innerEnd: number;
}

/** Finds the root `<svg>` after the prolog without copying the text; null when the text does not begin like an SVG file. */
function parseRoot(text: string): RootTag | null {
  let pos = 0;
  for (;;) {
    PROLOG_ITEM.lastIndex = pos;
    const item = PROLOG_ITEM.exec(text);
    if (!item) break;
    pos += item[0].length;
  }
  ROOT_START.lastIndex = pos;
  const start = ROOT_START.exec(text);
  if (!start) return null;
  const attrs = start[1];
  const innerStart = pos + start[0].length;
  if (attrs.trimEnd().endsWith("/")) return { attrs, innerStart, innerEnd: innerStart };
  const end = text.lastIndexOf("</svg>");
  return { attrs, innerStart, innerEnd: end >= innerStart ? end : text.length };
}

function attributesOf(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(/([^\s=/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.set(m[1], m[2] ?? m[3] ?? "");
  return out;
}

/** A positive length in px, or null for anything else (absent, a percentage, an `em`, zero). */
function lengthPx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/.exec(value);
  if (!m) return null;
  const [mul, div] = UNIT_TO_PX[m[2] ?? ""];
  const px = (Number(m[1]) * mul) / div;
  return px > 0 ? px : null;
}

function parseViewBox(value: string | undefined): [number, number, number, number] | null {
  if (value === undefined) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) return null;
  return [parts[0], parts[1], parts[2], parts[3]];
}

/**
 * The size an SVG file gives itself: its `viewBox` if it has one, else its `width`/`height` in px (`pt`, `mm`, `in`,
 * `cm` and `pc` converted at 96 dpi), else 300 x 150. `viewBox` defaults to the box at the origin of that size.
 */
export function svgIntrinsicSize(text: string): { width: number; height: number; viewBox: [number, number, number, number] } {
  const root = parseRoot(text);
  const attrs = root ? attributesOf(root.attrs) : new Map<string, string>();
  const viewBox = parseViewBox(attrs.get("viewBox"));
  if (viewBox) return { width: viewBox[2], height: viewBox[3], viewBox };
  const width = lengthPx(attrs.get("width")) ?? DEFAULT_WIDTH;
  const height = lengthPx(attrs.get("height")) ?? DEFAULT_HEIGHT;
  return { width, height, viewBox: [0, 0, width, height] };
}

/**
 * The root `<svg>`'s declarations of namespace prefixes (` xmlns:xlink="…"`), ready to be put on the element that
 * takes the root's place. Inlined content that uses `xlink:href` or an editor's own prefix is otherwise not well-formed.
 */
export function svgRootNamespaces(text: string): string {
  const root = parseRoot(text);
  if (!root) return "";
  let out = "";
  for (const [name, value] of attributesOf(root.attrs)) {
    if (name.startsWith("xmlns:")) out += ` ${name}="${value.replace(/"/g, "&quot;")}"`;
  }
  return out;
}

/**
 * The root `<svg>`'s child markup, with every id and every reference to one carried into `idPrefix`'s namespace so
 * that several files, and the figure's own ids, can share one document: `id`, `url(#x)`, `href="#x"` and
 * `xlink:href="#x"`. The XML declaration, DOCTYPE and comments are dropped.
 */
export function inlineSvg(text: string, idPrefix: string): string {
  const root = parseRoot(text);
  if (!root) return "";
  return text
    .slice(root.innerStart, root.innerEnd)
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .replace(new RegExp(`<[A-Za-z_][^\\s/>]*${QUOTED_TAG_BODY}>`, "g"), (tag) => prefixAttributes(tag, idPrefix))
    .replace(/url\(\s*(["']?)#([^)"'\s]*)\1\s*\)/g, (_m, quote: string, id: string) => `url(${quote}#${idPrefix}${id}${quote})`);
}

/** Only inside a start tag: an `id` attribute (not `xml:id` or `data-id`) and a `href` that points into this document. */
function prefixAttributes(tag: string, idPrefix: string): string {
  return tag
    .replace(/(\sid\s*=\s*)("[^"]*"|'[^']*')/g, (_m, head: string, value: string) => `${head}${value[0]}${idPrefix}${value.slice(1)}`)
    .replace(/(\s(?:xlink:)?href\s*=\s*)(["'])#/g, (_m, head: string, quote: string) => `${head}${quote}#${idPrefix}`);
}
