import { ellipsePath, flattenPath, multiply, pathBounds, rectPath, toSvgPath, type Matrix, type PathData } from "../model/path";
import { OUTLINE_TOLERANCE_PX, strokeOutline, svgPathData, type LineCap, type LineJoin } from "./stroke-outline";

/**
 * Gradient and pattern strokes made drawable by svg2pdf.js (2.8.1), which paints a gradient or pattern on a fill but
 * leaves such a stroke unpainted (tests/export/shapes-export-pdf.test.ts records this). Each shape element stroked with
 * one is drawn instead as its stroke's outline (`strokeOutline`), filled with the same paint, so the line stays a vector
 * gradient or pattern in the PDF. A stroke that cannot be outlined keeps its geometry and is drawn in one colour (a
 * gradient's first stop, a pattern's first colour), and the caller is told so.
 *
 * Properties are read as SVG cascades them through the document: the `style` attribute before the presentation
 * attribute, from the nearest ancestor that sets them. `<style>` rules are not read: a style sheet that strokes with a
 * gradient or pattern is reported, since svg2pdf.js leaves that line out too, and in a document whose style sheet sets
 * any stroke property, every gradient or pattern stroke falls back to one colour (with the notice) rather than being
 * outlined with what may be the wrong width, dashes or caps: which rule reaches which element is not worked out here.
 */

const SVG_MIME = "image/svg+xml";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
/** The elements whose geometry can be outlined. */
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
/** Elements that can be stroked but not outlined: they fall back to one colour. */
const UNOUTLINED = new Set(["text", "tspan", "textPath", "use"]);
const GRADIENTS = new Set(["linearGradient", "radialGradient"]);
/** A `url(#id)` paint, quoted or not, with or without a fallback after it. */
const URL_PAINT = /^\s*url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/;
/** A plain number, in user units or `px`. */
const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:px)?\s*$/i;
/** A plain number or a percentage, for a gradient's objectBoundingBox coordinates. */
const FRACTION = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)\s*$/i;
const STYLE_SHEET_STROKE = /stroke\s*:\s*url\(/i;
/** A style sheet declaration of any stroke property (`stroke`, `stroke-width`, `stroke-dasharray`…). */
const STYLE_SHEET_STROKE_PROPERTY = /(?:^|[{;\s])stroke[-a-z]*\s*:/i;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** Properties that apply to an element as a whole, so they move to the group that stands in for it. */
const GROUP_PROPERTIES = ["opacity", "clip-path", "mask", "filter"];
const MARKERS = ["marker-start", "marker-mid", "marker-end"];
const DEFAULT_MITER_LIMIT = 4;
/** More dashes than this along one element are not outlined (the outline would be too large to write): one colour instead. */
const MAX_DASHES = 100_000;

/** About how many dashes `dash` cuts the path into. */
function dashCount(path: PathData, dash: number[]): number {
  const total = dash.reduce((a, b) => a + b, 0) * (dash.length % 2 === 1 ? 2 : 1);
  if (dash.length === 0 || !(total > 0)) return 0;
  let length = 0;
  for (const line of flattenPath(path, 1)) for (let i = 1; i < line.length; i++) length += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  return (length / total) * dash.length;
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
  const value = styleValue(el, property) ?? el.getAttribute(property) ?? undefined;
  return value === undefined || value.trim() === "inherit" ? undefined : value.trim();
}

/** The value `property` has on the element or, when it does not set it, on its nearest ancestor that does. */
function cascaded(el: Element, property: string): string | undefined {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = ownValue(node, property);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The `style` attribute without its `property` declarations; the attribute goes when nothing is left. */
function dropStyle(el: Element, property: string): void {
  const style = el.getAttribute("style");
  if (style === null) return;
  const kept = style.split(";").filter((d) => {
    const colon = d.indexOf(":");
    return d.trim() !== "" && !(colon >= 0 && d.slice(0, colon).trim().toLowerCase() === property);
  });
  if (kept.length === 0) el.removeAttribute("style");
  else el.setAttribute("style", kept.join(";"));
}

/** Sets `property` on the element as a presentation attribute, over anything its `style` attribute said. */
function setOwn(el: Element, property: string, value: string): void {
  dropStyle(el, property);
  el.setAttribute(property, value);
}

/** Moves `property` (as the element set it, in its `style` or as an attribute) from `from` to `to`. */
function moveProperty(from: Element, to: Element, property: string): void {
  const styled = styleValue(from, property);
  const attribute = from.getAttribute(property);
  if (styled !== undefined) {
    to.setAttribute("style", `${to.getAttribute("style") ?? ""}${property}: ${styled};`);
    dropStyle(from, property);
  }
  if (attribute !== null) {
    to.setAttribute(property, attribute);
    from.removeAttribute(property);
  }
}

const plain = (value: string | null | undefined): number | null => {
  const match = value == null ? null : LENGTH.exec(value);
  return match ? Number(match[1]) : null;
};

/** The element's geometry as `PathData` in its own user space; `[]` for one SVG does not draw; null for what cannot be read. */
function geometry(el: Element): PathData | null {
  const num = (name: string, fallback: number | null = 0) => {
    const value = el.getAttribute(name);
    return value === null ? fallback : plain(value);
  };
  switch (el.localName) {
    case "path":
      return svgPathData(el.getAttribute("d") ?? "");
    case "line": {
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((n) => num(n));
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return [
        { op: "M", x: x1, y: y1 },
        { op: "L", x: x2, y: y2 },
      ];
    }
    case "polyline":
    case "polygon": {
      const values = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).filter((v) => v !== "").map(plain);
      if (values.some((v) => v === null)) return null;
      const path: PathData = [];
      for (let i = 0; i + 1 < values.length; i += 2) path.push({ op: i === 0 ? "M" : "L", x: values[i]!, y: values[i + 1]! });
      if (el.localName === "polygon" && path.length > 0) path.push({ op: "Z" });
      return path;
    }
    case "circle": {
      const [cx, cy, r] = [num("cx"), num("cy"), num("r")];
      if (cx === null || cy === null || r === null) return null;
      return r > 0 ? ellipsePath({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }) : [];
    }
    case "ellipse": {
      const [cx, cy, rx, ry] = [num("cx"), num("cy"), num("rx", null), num("ry", null)];
      if (cx === null || cy === null || rx === null || ry === null) return null;
      return rx > 0 && ry > 0 ? ellipsePath({ x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry }) : [];
    }
    case "rect": {
      const [x, y, w, h] = [num("x"), num("y"), num("width"), num("height")];
      const rx = num("rx", null);
      const ry = num("ry", null);
      if (x === null || y === null || w === null || h === null) return null;
      if (!(w > 0 && h > 0)) return [];
      if ((el.hasAttribute("rx") && rx === null) || (el.hasAttribute("ry") && ry === null)) return null;
      const radius = rx ?? ry ?? 0;
      // `rectPath` rounds every corner by one radius; elliptical corners are not outlined.
      if ((ry ?? radius) !== radius || radius > Math.min(w, h) / 2) return null;
      return rectPath({ x, y, width: w, height: h }, radius);
    }
    default:
      return null;
  }
}

/** The element and the ones its `href` points to, in order, for attributes and stops a paint server inherits. */
function hrefChain(doc: Document, el: Element): Element[] {
  const chain = [el];
  for (let i = 0; i < 16; i++) {
    const last = chain[chain.length - 1];
    const href = last.getAttribute("href") ?? last.getAttributeNS(XLINK_NS, "href") ?? last.getAttribute("xlink:href");
    const next = href?.startsWith("#") ? doc.getElementById(href.slice(1)) : null;
    if (!next || chain.includes(next)) break;
    chain.push(next);
  }
  return chain;
}

/** The one colour a stroke falls back to: a gradient's first stop, or the first colour a pattern draws with. */
function fallbackColour(doc: Document, server: Element): string {
  for (const el of hrefChain(doc, server)) {
    if (GRADIENTS.has(el.localName)) {
      const stop = Array.from(el.children).find((c) => c.localName === "stop");
      if (stop) return ownValue(stop, "stop-color") ?? "#000000";
    } else {
      for (const child of Array.from(el.querySelectorAll("*"))) {
        for (const property of ["fill", "stroke", "stop-color"]) {
          const value = ownValue(child, property);
          if (value && value !== "none" && !value.startsWith("url(")) return value;
        }
      }
    }
  }
  return "#000000";
}

/** An objectBoundingBox coordinate as a fraction of the box, or null when it is not a number or a percentage. */
function fraction(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  const match = FRACTION.exec(value);
  return match ? Number(match[1]) / (match[2] === "%" ? 100 : 1) : null;
}

const GRADIENT_COORDINATES: Record<string, [string, number][]> = {
  linearGradient: [
    ["x1", 0],
    ["y1", 0],
    ["x2", 1],
    ["y2", 0],
  ],
  radialGradient: [
    ["cx", 0.5],
    ["cy", 0.5],
    ["r", 0.5],
  ],
};

/**
 * What the outline is to be filled with so that it is painted as the stroke was: the stroke's own `url(#id)` for a
 * paint laid out in user space; for a gradient laid out on the element's bounding box (which the outline's box is not), a
 * userSpaceOnUse copy of it on that box, placed after it with id `<id>-lfbox<n>`. `"none"` when SVG paints nothing (an
 * objectBoundingBox paint on a box with no width or height); null when it cannot be laid out so.
 */
function outlinePaint(doc: Document, server: Element, path: PathData, ids: Set<string>): string | null {
  const chain = hrefChain(doc, server);
  const isPattern = server.localName === "pattern";
  const unitsOf = (name: string) => chain.find((el) => el.hasAttribute(name))?.getAttribute(name)?.trim();
  const id = server.getAttribute("id")!;
  if (isPattern) {
    const contentByBox = unitsOf("patternContentUnits") === "objectBoundingBox" && !chain.some((el) => el.hasAttribute("viewBox"));
    return unitsOf("patternUnits") === "userSpaceOnUse" && !contentByBox ? `url(#${id})` : null;
  }
  if (unitsOf("gradientUnits") === "userSpaceOnUse") return `url(#${id})`;
  const box = pathBounds(path);
  if (!(box.width > 0 && box.height > 0)) return "none";
  // Attributes inherited through `href` would be read in the copy's units: such a gradient is not laid out here.
  if (chain.length > 1) return null;
  const copy = server.cloneNode(true) as Element;
  for (const [name, fallback] of GRADIENT_COORDINATES[server.localName] ?? []) {
    const value = fraction(server.getAttribute(name), fallback);
    if (value === null) return null;
    copy.setAttribute(name, String(value));
  }
  for (const name of ["fx", "fy", "fr"]) {
    if (!server.hasAttribute(name)) continue;
    const value = fraction(server.getAttribute(name), 0);
    if (value === null) return null;
    copy.setAttribute(name, String(value));
  }
  let n = 0;
  let copyId: string;
  do copyId = `${id}-lfbox${++n}`;
  while (ids.has(copyId));
  ids.add(copyId);
  const own = server.getAttribute("gradientTransform");
  copy.setAttribute("id", copyId);
  copy.setAttribute("gradientUnits", "userSpaceOnUse");
  copy.setAttribute("gradientTransform", `matrix(${box.width} 0 0 ${box.height} ${box.x} ${box.y})${own ? ` ${own}` : ""}`);
  server.after(copy);
  return `url(#${copyId})`;
}

/** The dash lengths `stroke-dasharray` gives: `[]` for none or a list SVG ignores, null for lengths with units. */
function dashArray(value: string | undefined): number[] | null {
  if (value === undefined || value === "none") return [];
  const lengths = value.split(/[\s,]+/).filter((v) => v !== "").map(plain);
  if (lengths.some((l) => l === null)) return null;
  return lengths.some((l) => l! < 0) ? [] : (lengths as number[]);
}

const CAPS: readonly string[] = ["butt", "round", "square"];

/** The join `stroke-linejoin` names; SVG 2's `miter-clip` and `arcs` are drawn as a miter. */
function joinOf(value: string | undefined): LineJoin {
  return value === "round" || value === "bevel" ? value : "miter";
}

type PaintPart = "fill" | "stroke" | "markers";

/** The order the element paints its fill, stroke and markers in (`paint-order`): the ones it names, then the rest as usual. */
function paintOrder(el: Element): PaintPart[] {
  const named = (cascaded(el, "paint-order") ?? "normal").split(/\s+/).filter((t): t is PaintPart => t === "fill" || t === "stroke" || t === "markers");
  return [...new Set<PaintPart>([...named, "fill", "stroke", "markers"])];
}

/** One transform function as a matrix; translations are left out, as only the scale is wanted. Null for one not read. */
function transformFunction(name: string, args: number[]): Matrix | null {
  const rad = ((args[0] ?? 0) * Math.PI) / 180;
  switch (name) {
    case "matrix":
      return args.length === 6 ? [args[0], args[1], args[2], args[3], 0, 0] : null;
    case "scale":
      return args.length >= 1 ? [args[0], 0, 0, args[1] ?? args[0], 0, 0] : null;
    case "rotate":
      return [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
    case "skewX":
      return [1, 0, Math.tan(rad), 1, 0, 0];
    case "skewY":
      return [1, Math.tan(rad), 0, 1, 0, 0];
    case "translate":
      return IDENTITY;
    default:
      return null;
  }
}

/** A `transform` attribute's linear part (the identity for one it cannot read): the list's last function applies first. */
function transformOf(value: string | null): Matrix {
  if (value === null) return IDENTITY;
  let m = IDENTITY;
  const functions = Array.from(value.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g));
  for (const [, name, raw] of functions.reverse()) {
    const args = raw.split(/[\s,]+/).filter((v) => v !== "").map(Number);
    const f = args.every(Number.isFinite) ? transformFunction(name, args) : null;
    if (!f) return IDENTITY;
    m = multiply(m, f);
  }
  return m;
}

/** The scale a nested `<svg>` puts on its content (its viewBox fitted to its width and height), as a matrix. */
function viewportOf(el: Element): Matrix {
  const box = (el.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const width = plain(el.getAttribute("width"));
  const height = plain(el.getAttribute("height"));
  if (box.length !== 4 || !box.every(Number.isFinite) || !(box[2] > 0 && box[3] > 0) || width === null || height === null) return IDENTITY;
  const sx = width / box[2];
  const sy = height / box[3];
  const align = (el.getAttribute("preserveAspectRatio") ?? "").trim();
  if (align.startsWith("none")) return [sx, 0, 0, sy, 0, 0];
  const k = align.endsWith("slice") ? Math.max(sx, sy) : Math.min(sx, sy);
  return [k, 0, 0, k, 0, 0];
}

/**
 * How much the element's user space is enlarged on the page, at most (the largest singular value of its transforms and
 * nested viewports up to the page's own `<svg>`), so that a curve can be flattened to a tolerance on the page.
 */
function pageScale(el: Element): number {
  let m = IDENTITY;
  for (let node: Element | null = el; node && node.parentElement; node = node.parentElement) {
    m = multiply(m, transformOf(node.getAttribute("transform")));
    if (node !== el && node.localName === "svg") m = multiply(m, viewportOf(node));
  }
  const [a, b, c, d] = m;
  const t = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return Math.sqrt((t + Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2);
}

/**
 * The element stroked with `paint` replaced by a group that stands in for it: its id, transform and whole-element
 * properties (opacity, clip, mask, filter), then the element itself with no stroke and no markers (when it still draws
 * a fill), the stroke's outline filled with `paint` at the stroke's opacity, and a copy of the element that draws only
 * its markers, in the element's paint order (markers last unless `paint-order` says otherwise). Curves are flattened
 * to 0.05 pt on the page.
 * `"nothing"` when SVG draws no stroke here (a width of zero, no geometry, a bounding-box paint on a flat box); null
 * when the stroke cannot be outlined.
 */
function outline(doc: Document, el: Element, server: Element, ids: Set<string>): Element | null | "nothing" {
  const path = geometry(el);
  const width = plain(cascaded(el, "stroke-width") ?? "1");
  const dash = dashArray(cascaded(el, "stroke-dasharray"));
  const dashOffset = plain(cascaded(el, "stroke-dashoffset") ?? "0");
  const opacity = plain(cascaded(el, "stroke-opacity") ?? "1");
  const nonScaling = ownValue(el, "vector-effect") === "non-scaling-stroke";
  const rescaledDashes = el.hasAttribute("pathLength") && dash !== null && dash.length > 0;
  if (path === null || width === null || width < 0 || dash === null || dashOffset === null || opacity === null || nonScaling || rescaledDashes) return null;
  if (width === 0 || path.length === 0) return "nothing";
  if (dashCount(path, dash) > MAX_DASHES) return null;
  const paint = outlinePaint(doc, server, path, ids);
  if (paint === null) return null;
  if (paint === "none") return "nothing";

  const capValue = cascaded(el, "stroke-linecap") ?? "butt";
  const cap = (CAPS.includes(capValue) ? capValue : "butt") as LineCap;
  const limit = plain(cascaded(el, "stroke-miterlimit")) ?? DEFAULT_MITER_LIMIT;
  const scale = pageScale(el);
  const tolerance = scale > 0 && Number.isFinite(scale) ? OUTLINE_TOLERANCE_PX / scale : OUTLINE_TOLERANCE_PX;
  const area = strokeOutline(path, width, cap, joinOf(cascaded(el, "stroke-linejoin")), dash, { dashOffset, miterLimit: limit, tolerance });

  const filled = doc.createElementNS(SVG_NS, "path");
  filled.setAttribute("d", toSvgPath(area));
  filled.setAttribute("fill", paint);
  const shown = Math.min(1, Math.max(0, opacity));
  // Written even at 1, so the outline does not take a `fill-opacity` from an ancestor.
  filled.setAttribute("fill-opacity", String(shown));
  filled.setAttribute("fill-rule", "nonzero");
  filled.setAttribute("stroke", "none");
  const markers = MARKERS.some((m) => (cascaded(el, m) ?? cascaded(el, "marker") ?? "none") !== "none");
  if (markers) for (const m of MARKERS) filled.setAttribute(m, "none");
  const visibility = ownValue(el, "visibility");
  if (visibility) filled.setAttribute("visibility", visibility);

  const group = doc.createElementNS(SVG_NS, "g");
  for (const attribute of ["id", "transform"]) {
    const value = el.getAttribute(attribute);
    if (value === null) continue;
    group.setAttribute(attribute, value);
    el.removeAttribute(attribute);
  }
  for (const property of GROUP_PROPERTIES) moveProperty(el, group, property);
  setOwn(el, "stroke", "none");
  // A line has no inside to fill; every other shape fills, open or closed.
  const fills = el.localName !== "line" && (cascaded(el, "fill") ?? "black") !== "none";
  const markerCopy = markers ? (el.cloneNode(true) as Element) : null;
  if (markerCopy) {
    setOwn(markerCopy, "fill", "none");
    for (const m of MARKERS) setOwn(el, m, "none");
    dropStyle(el, "marker");
    el.removeAttribute("marker");
  }
  const drawn: Record<PaintPart, Element | null> = { fill: fills ? el : null, stroke: filled, markers: markerCopy };
  const parts = paintOrder(el).flatMap((part) => drawn[part] ?? []);
  el.replaceWith(group);
  for (const part of parts) group.appendChild(part);
  return group;
}

/**
 * The page SVG with every gradient or pattern stroke drawn as a filled outline, as the module comment says. `labelOf`
 * names what an element belongs to, for the warnings (one per owner and kind of paint). The input comes back as it is
 * when nothing is stroked so, or when it cannot be parsed.
 */
export function outlinePaintedStrokes(svg: string, labelOf: (el: Element) => string): { svg: string; warnings: string[] } {
  if (!/stroke\s*(?:=\s*["']|:)\s*url\(/i.test(svg)) return { svg, warnings: [] };
  const doc = new DOMParser().parseFromString(svg, SVG_MIME);
  if (doc.getElementsByTagName("parsererror").length > 0) return { svg, warnings: [] };

  const warnings = new Set<string>();
  const ids = new Set(Array.from(doc.querySelectorAll("[id]"), (el) => el.getAttribute("id")!));
  const sheetStrokes = Array.from(doc.getElementsByTagName("style")).some((style) => STYLE_SHEET_STROKE_PROPERTY.test(style.textContent ?? ""));
  let changed = false;
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (el.localName === "style" && STYLE_SHEET_STROKE.test(el.textContent ?? "")) {
      warnings.add(`${labelOf(el)}: a line a style sheet paints with a gradient or pattern is left out of the PDF`);
      continue;
    }
    if (!SHAPES.has(el.localName) && !UNOUTLINED.has(el.localName)) continue;
    if (el.closest("clipPath")) continue;
    const id = URL_PAINT.exec(cascaded(el, "stroke") ?? "")?.[2];
    const server = id === undefined ? null : doc.getElementById(id);
    if (!server || !(GRADIENTS.has(server.localName) || server.localName === "pattern")) continue;

    // A style sheet may give the element stroke properties `cascaded` does not see, by any selector: no outline then.
    const done = SHAPES.has(el.localName) && !sheetStrokes ? outline(doc, el, server, ids) : null;
    changed = true;
    if (done === "nothing") setOwn(el, "stroke", "none");
    else if (done === null) {
      setOwn(el, "stroke", fallbackColour(doc, server));
      const kind = server.localName === "pattern" ? "pattern" : "gradient";
      warnings.add(`${labelOf(el)}: ${kind} line drawn in one colour in the PDF`);
    }
  }
  return { svg: changed ? new XMLSerializer().serializeToString(doc) : svg, warnings: [...warnings] };
}
