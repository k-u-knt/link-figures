/**
 * Pattern tiles kept in view in the PDF export. svg2pdf.js (2.8.1) writes a tiling pattern's `/BBox` at the SVG
 * pattern's `x`/`y` but draws the tile's children at 0..width, so a `userSpaceOnUse` pattern whose `x` or `y` is not 0
 * has its tile clipped away. The same pattern with `x="0" y="0"` and the offset as a `patternTransform` translate gets
 * a `/BBox` at the origin and the offset in its `/Matrix`, which svg2pdf.js draws as the SVG does.
 *
 * The translate is appended to an existing `patternTransform`, so it applies to the tile first and the existing
 * transform (a rotation about the box corner, say) after it, as the pattern's own `x`/`y` do in SVG.
 *
 * Only a pattern with `patternUnits="userSpaceOnUse"` and plain-number `x`/`y` (user units or `px`) is rewritten.
 * A pattern with `href`, whose `x`/`y` may be inherited, or with a percentage or other unit, is left as it is.
 */

const SVG_MIME = "image/svg+xml";
const XLINK = "http://www.w3.org/1999/xlink";
/** A plain number, in user units or `px`. */
const NUMBER = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:px)?\s*$/i;

/** The number an optional length attribute is (0 when absent), or null when it is not a plain number. */
function offset(pattern: Element, attribute: "x" | "y"): number | null {
  const value = pattern.getAttribute(attribute);
  if (value === null) return 0;
  const match = NUMBER.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * The page SVG with every `userSpaceOnUse` pattern that has an `x` or `y` moved to the origin and a `translate` of
 * that offset appended to its `patternTransform`. The input comes back as it is when no pattern needs this, or when
 * it cannot be parsed.
 */
export function normalisePatternOrigins(svg: string): string {
  if (!svg.includes("userSpaceOnUse")) return svg;
  const doc = new DOMParser().parseFromString(svg, SVG_MIME);
  if (doc.getElementsByTagName("parsererror").length > 0) return svg;

  let changed = false;
  for (const pattern of Array.from(doc.getElementsByTagName("pattern"))) {
    if (pattern.getAttribute("patternUnits")?.trim() !== "userSpaceOnUse") continue;
    if (pattern.hasAttribute("href") || pattern.hasAttributeNS(XLINK, "href")) continue;
    const x = offset(pattern, "x");
    const y = offset(pattern, "y");
    if (x === null || y === null || (x === 0 && y === 0)) continue;
    const existing = pattern.getAttribute("patternTransform")?.trim();
    pattern.setAttribute("x", "0");
    pattern.setAttribute("y", "0");
    pattern.setAttribute("patternTransform", `${existing ? `${existing} ` : ""}translate(${x} ${y})`);
    changed = true;
  }
  return changed ? new XMLSerializer().serializeToString(doc) : svg;
}
