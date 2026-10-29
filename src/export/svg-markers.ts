/**
 * Markers sized in user units, made to come out at that size in the PDF export. svg2pdf.js (2.8.1) scales every marker
 * by the stroke width of the element that uses it, whatever its `markerUnits`, so a `markerUnits="userSpaceOnUse"`
 * marker on a stroke of width w is drawn w times too big. svg2pdf.js does honour a marker's `viewBox`, scaling its
 * content by `markerWidth / viewBox width` (and likewise for the height), so the element is pointed at a copy of the
 * marker whose `markerWidth` and `markerHeight` are divided by w over a `viewBox` of the original's size: that scale
 * is 1/w, which cancels the w. The copy's reference point and clip (its `viewBox`, read in the marker's own units) are
 * the original's.
 *
 * The stroke width is read as svg2pdf.js reads it, from the `style` attribute before the presentation attribute and
 * from the nearest ancestor that sets it, as `Math.abs(parseFloat(value))` (so `2pt`, `50%` and `-2` are widths of 2,
 * 50 and 2, as svg2pdf.js has them). A width that parses to NaN (`inherit`) or 0 leaves the element as it is. `<style>`
 * rules are not read, so a document with a `<style>` element that mentions `stroke-width` is left as it is.
 */

const SVG_MIME = "image/svg+xml";
const MARKER_PROPERTIES = ["marker-start", "marker-mid", "marker-end"] as const;
/** What svg2pdf.js takes for an absent `markerWidth` or `markerHeight`, as SVG does. */
const DEFAULT_MARKER_SIZE = 3;
/** A plain number, in user units or `px`. */
const NUMBER = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:px)?\s*$/i;
/** A `url(#id)` reference, quoted or not. */
const URL_REF = /^\s*url\(\s*(['"]?)#([^'")\s]+)\1\s*\)\s*$/;

/** The number a length is, or null when it is not a plain number. */
function plainNumber(value: string): number | null {
  const match = NUMBER.exec(value);
  return match ? Number(match[1]) : null;
}

/** The value `property` has in an element's `style` attribute, or undefined when the attribute does not set it. */
function styleValue(el: Element, property: string): string | undefined {
  let value: string | undefined;
  for (const declaration of (el.getAttribute("style") ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon >= 0 && declaration.slice(0, colon).trim().toLowerCase() === property) value = declaration.slice(colon + 1).trim();
  }
  return value;
}

/** The value `property` has on an element itself: its `style` attribute first, then the presentation attribute. */
function ownValue(el: Element, property: string): string | undefined {
  return styleValue(el, property) ?? el.getAttribute(property) ?? undefined;
}

/** The stroke width the element is drawn with (1 when nothing sets it), read as svg2pdf.js reads it, or null when that is NaN or 0. */
function strokeWidthOf(el: Element): number | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = ownValue(node, "stroke-width");
    if (value === undefined) continue;
    const width = Math.abs(parseFloat(value));
    return Number.isNaN(width) || width === 0 ? null : width;
  }
  return 1;
}

/** The marker's `markerWidth` or `markerHeight`, or null when it is not a plain number. */
function markerSize(marker: Element, attribute: "markerWidth" | "markerHeight"): number | null {
  const value = marker.getAttribute(attribute);
  return value === null ? DEFAULT_MARKER_SIZE : plainNumber(value);
}

/**
 * The page SVG with every `userSpaceOnUse` marker on a stroke wider or narrower than 1 swapped for a copy that
 * svg2pdf.js draws at the marker's own size: one copy per marker and stroke width, with id `<id>-lfsw<n>`, placed
 * after the original. The input comes back as it is when no marker needs this, or when it cannot be parsed.
 */
export function normaliseUserSpaceMarkers(svg: string): string {
  if (!svg.includes("userSpaceOnUse")) return svg;
  const doc = new DOMParser().parseFromString(svg, SVG_MIME);
  if (doc.getElementsByTagName("parsererror").length > 0) return svg;

  const markers = new Map<string, Element>();
  for (const marker of Array.from(doc.getElementsByTagName("marker"))) {
    const id = marker.getAttribute("id");
    if (id && !markers.has(id) && marker.getAttribute("markerUnits")?.trim() === "userSpaceOnUse") markers.set(id, marker);
  }
  if (markers.size === 0) return svg;
  // svg2pdf.js applies stylesheet rules to stroke width, which this pass cannot see: leave the whole page as it is.
  if (Array.from(doc.getElementsByTagName("style")).some((style) => (style.textContent ?? "").includes("stroke-width"))) return svg;

  const ids = new Set(Array.from(doc.querySelectorAll("[id]"), (el) => el.getAttribute("id")));
  const clones = new Map<string, string>();
  let counter = 0;
  /** The id of the marker's copy for stroke width `width`, made on first use; null when the marker's size is not a number. */
  const cloneFor = (id: string, width: number): string | null => {
    const key = `${id}\u0000${width}`;
    const known = clones.get(key);
    if (known) return known;
    const marker = markers.get(id)!;
    const markerWidth = markerSize(marker, "markerWidth");
    const markerHeight = markerSize(marker, "markerHeight");
    if (markerWidth === null || markerHeight === null) return null;
    let cloneId: string;
    do cloneId = `${id}-lfsw${++counter}`;
    while (ids.has(cloneId));
    ids.add(cloneId);
    const clone = marker.cloneNode(true) as Element;
    clone.setAttribute("id", cloneId);
    if (!clone.hasAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${markerWidth} ${markerHeight}`);
    clone.setAttribute("markerWidth", String(markerWidth / width));
    clone.setAttribute("markerHeight", String(markerHeight / width));
    marker.after(clone);
    clones.set(key, cloneId);
    return cloneId;
  };
  /** The reference rewritten to the marker's copy, or null when it names no marker that needs one. */
  const rewrite = (reference: string, width: number): string | null => {
    const id = URL_REF.exec(reference)?.[2];
    const cloneId = id !== undefined && markers.has(id) ? cloneFor(id, width) : null;
    return cloneId === null ? null : `url(#${cloneId})`;
  };

  let changed = false;
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const uses = MARKER_PROPERTIES.some((property) => el.hasAttribute(property)) || /marker-(?:start|mid|end)/i.test(el.getAttribute("style") ?? "");
    if (!uses) continue;
    const width = strokeWidthOf(el);
    if (width === null || width === 1) continue;

    for (const property of MARKER_PROPERTIES) {
      const attribute = el.getAttribute(property);
      const rewritten = attribute === null ? null : rewrite(attribute, width);
      if (rewritten !== null) {
        el.setAttribute(property, rewritten);
        changed = true;
      }
    }
    const style = el.getAttribute("style");
    if (style !== null) {
      const declarations = style.split(";").map((declaration) => {
        const colon = declaration.indexOf(":");
        const property = colon >= 0 ? declaration.slice(0, colon).trim().toLowerCase() : "";
        if (!(MARKER_PROPERTIES as readonly string[]).includes(property)) return declaration;
        const rewritten = rewrite(declaration.slice(colon + 1), width);
        return rewritten === null ? declaration : `${declaration.slice(0, colon + 1)} ${rewritten}`;
      });
      const rewrittenStyle = declarations.join(";");
      if (rewrittenStyle !== style) {
        el.setAttribute("style", rewrittenStyle);
        changed = true;
      }
    }
  }
  return changed ? new XMLSerializer().serializeToString(doc) : svg;
}
