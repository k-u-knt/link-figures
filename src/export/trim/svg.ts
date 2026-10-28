import { unionRect, type Rect } from "../../model/geometry";

/**
 * Trimming an SVG source: every drawn element that lies wholly outside the visible region is removed, groups it
 * leaves empty go with it, and so do the definitions only it used. What crosses the edge, and what cannot be measured,
 * stays whole (the exporters' clip paths cut it visually).
 */

/**
 * An element's box in the root viewBox's units, transforms included and widened by what it paints beyond its geometry
 * (stroke, markers, filter); `null` when it cannot be measured.
 */
export type SvgMeasure = (el: SVGGraphicsElement) => Rect | null;

const SVG_NS = "http://www.w3.org/2000/svg";

/** The elements that draw something where they stand: the units that can be removed. */
const DRAWN = new Set(["path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "text", "image", "use"]);

/** Containers whose children are drawn in place and so are looked into. A `switch` is not: removing one alternative can choose another. */
const CONTAINERS = new Set(["g", "a", "svg"]);

/** Containers removed once trimming leaves them with nothing drawn. */
const GROUPS = new Set(["g", "a"]);

/** Children that draw nothing: a group left with only these is empty. */
const UNDRAWN = new Set(["title", "desc", "metadata"]);

/** An element with one of these as a child may move over time, so where it is now says nothing: it is kept. */
const ANIMATIONS = new Set(["animate", "animateTransform", "animateMotion", "set"]);

/** `url(#x)` with or without quotes, in an attribute or in a style sheet. */
const URL_REF = /url\(\s*["']?#([^)"'\s]+)["']?\s*\)/g;

function isSvg(el: Element): boolean {
  return el.namespaceURI === SVG_NS;
}

/** The ids `el`'s own attributes (and, for `<style>`, its text) refer to. */
function referencesOf(el: Element): string[] {
  const ids: string[] = [];
  for (const attribute of Array.from(el.attributes)) {
    if (attribute.localName === "href" && attribute.value.startsWith("#")) ids.push(attribute.value.slice(1));
    for (const m of attribute.value.matchAll(URL_REF)) ids.push(m[1]);
  }
  if (el.localName === "style") for (const m of (el.textContent ?? "").matchAll(URL_REF)) ids.push(m[1]);
  return ids;
}

function elementsOf(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll("*"))];
}

/** Every id anything in the document refers to. */
function referencedIds(root: Element): Set<string> {
  return new Set(elementsOf(root).flatMap(referencesOf));
}

/** The children of `<defs>` that have an id: the definitions that can go when nothing uses them any more. */
function definitionsOf(root: Element): Element[] {
  return Array.from(root.querySelectorAll("defs > [id]")).filter((el) => isSvg(el) && el.parentElement?.localName === "defs");
}

/**
 * The definitions in use: those referred to from outside every definition, then those the used ones refer to, and so
 * on. A reference to an element inside a definition (a `<use>` of a symbol's child) uses the whole definition.
 */
function usedDefinitions(root: Element): Set<Element> {
  const definitions = definitionsOf(root);
  const definitionOf = new Map<string, Element>();
  const insideDefinition = new Set<Element>();
  for (const definition of definitions) {
    for (const el of elementsOf(definition)) {
      insideDefinition.add(el);
      if (el.id && !definitionOf.has(el.id)) definitionOf.set(el.id, definition);
    }
  }
  const used = new Set<Element>();
  const queue = elementsOf(root)
    .filter((el) => !insideDefinition.has(el))
    .flatMap(referencesOf);
  while (queue.length > 0) {
    const definition = definitionOf.get(queue.pop()!);
    if (!definition || used.has(definition)) continue;
    used.add(definition);
    queue.push(...elementsOf(definition).flatMap(referencesOf));
  }
  return used;
}

/** True when `el` or anything inside it has an id something refers to: removing it would break that reference. */
function isReferenced(el: Element, referenced: Set<string>): boolean {
  return elementsOf(el).some((e) => e.id !== "" && referenced.has(e.id));
}

function hasAnimation(el: Element): boolean {
  return Array.from(el.children).some((child) => ANIMATIONS.has(child.localName));
}

/** The drawn elements of `container` that may be removed, looking into the containers drawn in place. */
function candidatesIn(container: Element, referenced: Set<string>, out: SVGGraphicsElement[] = []): SVGGraphicsElement[] {
  for (const child of Array.from(container.children)) {
    if (!isSvg(child) || hasAnimation(child)) continue;
    if (DRAWN.has(child.localName)) {
      if (!isReferenced(child, referenced)) out.push(child as SVGGraphicsElement);
    } else if (CONTAINERS.has(child.localName)) {
      candidatesIn(child, referenced, out);
    }
  }
  return out;
}

/** True only for a box that can be trusted (finite, not empty) and lies wholly outside `visible`; touching is not outside. */
function isWhollyOutside(box: Rect | null, visible: Rect): boolean {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || !(box.width > 0 && box.height > 0)) return false;
  return box.x + box.width < visible.x || box.x > visible.x + visible.width || box.y + box.height < visible.y || box.y > visible.y + visible.height;
}

function hasDrawnChild(group: Element): boolean {
  return Array.from(group.children).some((child) => !UNDRAWN.has(child.localName));
}

/** Removes `el`, then each group above it that this leaves with nothing drawn (and that nothing refers to). */
function removeWithEmptiedGroups(el: Element, root: Element, referenced: Set<string>): void {
  let parent: Element | null = el.parentElement;
  el.remove();
  while (parent && parent !== root && GROUPS.has(parent.localName) && !hasDrawnChild(parent) && !isReferenced(parent, referenced)) {
    const next: Element | null = parent.parentElement;
    parent.remove();
    parent = next;
  }
}

/**
 * `text` without the drawn elements that `measure` puts wholly outside `visible` (in the root viewBox's units), the
 * groups that leaves empty, and the definitions only they used. An element is kept when it crosses or touches the
 * edge, when it cannot be measured or its box is empty or not finite, when something refers to it (a `<use>`), and
 * when it is not drawn in place (inside `<defs>`, a clip path, a `switch`…) or is animated. `removed` counts the
 * drawn elements removed. Throws when `text` is not an SVG document.
 */
export function pruneSvg(text: string, visible: Rect, measure: SvgMeasure): { text: string; removed: number } {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  // Held on to: measuring may move the root into the live document, after which `doc` no longer has it.
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || !isSvg(root) || doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("the SVG could not be read");
  }
  const referenced = referencedIds(root);
  const usedBefore = usedDefinitions(root);
  // Everything is measured before anything is removed, so that removing cannot change another element's box.
  const outside = candidatesIn(root, referenced).filter((el) => isWhollyOutside(measure(el), visible));
  if (outside.length === 0) return { text, removed: 0 };
  for (const el of outside) removeWithEmptiedGroups(el, root, referenced);
  const usedAfter = usedDefinitions(root);
  for (const definition of usedBefore) if (!usedAfter.has(definition)) definition.remove();
  return { text: new XMLSerializer().serializeToString(root), removed: outside.length };
}

// ---- Measuring in the browser ----------------------------------------------------------------------------------------

/** A 2D affine matrix `[a, b, c, d, e, f]`, as SVG writes it. */
type Matrix = [number, number, number, number, number, number];

function matrixOf(m: { a: number; b: number; c: number; d: number; e: number; f: number }): Matrix {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

function multiply([a1, b1, c1, d1, e1, f1]: Matrix, [a2, b2, c2, d2, e2, f2]: Matrix): Matrix {
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

function invert([a, b, c, d, e, f]: Matrix): Matrix | null {
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** The bounding box of `rect` mapped through `m`. */
function mapRect(rect: Rect, [a, b, c, d, e, f]: Matrix): Rect {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ].map(([x, y]) => ({ x: a * x + c * y + e, y: b * x + d * y + f, width: 0, height: 0 }));
  return unionRect(corners);
}

/** How much `m` stretches a length at most. */
function scaleOf([a, b, c, d]: Matrix): number {
  return Math.max(Math.hypot(a, b), Math.hypot(c, d));
}

function widen(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

/** The default filter region: 10 % beyond the filtered element's box on every side. */
const DEFAULT_FILTER_REGION = { x: -0.1, y: -0.1, width: 1.2, height: 1.2 };

/** How far markers may reach beyond a path, in the root's units: three stroke widths (SVG's default marker size), at least 10. [B: may refine] */
function markerReach(strokeWidth: number, scale: number): number {
  return Math.max(strokeWidth * 3 * scale, 10);
}

/** A number, or a percentage as a fraction; `null` for anything else (a length with a unit). */
function fractionOf(value: string | null, fallback: number): number | null {
  if (value === null || value.trim() === "") return fallback;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)\s*$/i.exec(value);
  if (!m) return null;
  return m[2] ? Number(m[1]) / 100 : Number(m[1]);
}

/** A number in user units (`px` allowed); `null` for anything else. */
function userLengthOf(value: string | null): number | null {
  if (value === null) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

/**
 * The region `filter` (an `<filter>` element) paints into for an element whose box is `box`, in that element's user
 * units; `null` when it cannot be read (it inherits from another filter, or uses lengths with units or percentages
 * of the viewport).
 */
function filterRegion(filter: Element, box: Rect): Rect | null {
  if (filter.hasAttribute("href") || filter.hasAttributeNS("http://www.w3.org/1999/xlink", "href")) return null;
  const read = (name: "x" | "y" | "width" | "height") => filter.getAttribute(name);
  if (filter.getAttribute("filterUnits") === "userSpaceOnUse") {
    const [x, y, width, height] = [read("x"), read("y"), read("width"), read("height")].map(userLengthOf);
    return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
  }
  const fx = fractionOf(read("x"), DEFAULT_FILTER_REGION.x);
  const fy = fractionOf(read("y"), DEFAULT_FILTER_REGION.y);
  const fw = fractionOf(read("width"), DEFAULT_FILTER_REGION.width);
  const fh = fractionOf(read("height"), DEFAULT_FILTER_REGION.height);
  if (fx === null || fy === null || fw === null || fh === null) return null;
  return { x: box.x + fx * box.width, y: box.y + fy * box.height, width: fw * box.width, height: fh * box.height };
}

/** The `<filter>` a computed `filter` value names, `undefined` for no filter, `null` for one that cannot be read (CSS functions, several filters, a missing element). */
function filterElementOf(value: string, root: Element): Element | null | undefined {
  if (value === "" || value === "none") return undefined;
  const m = /^url\(\s*["']?#([^)"'\s]+)["']?\s*\)$/.exec(value.trim());
  if (!m) return null;
  return Array.from(root.querySelectorAll("filter")).find((f) => f.id === m[1]) ?? null;
}

/** The outermost element above `el` (or `el` itself). */
function rootOf(el: Element): Element {
  let root = el;
  while (root.parentElement) root = root.parentElement;
  return root;
}

/**
 * Measures with the browser's layout: the first element measured brings its SVG into a shadow root of `host` (which
 * should be in the document, out of sight but not `display: none`), where it stays. The shadow root keeps the SVG's
 * `<style>` rules and the app's apart, so neither restyles the other while it is there. The box is `getBBox()` mapped to the root's user
 * units (its viewBox) through the screen matrices of the element and of the root, widened by half the stroke width
 * (scaled), by `markerReach` when markers are set, and to the filter region of every filter on the element or above
 * it. `null` when any of this cannot be read.
 */
export function domSvgMeasure(host: HTMLElement): SvgMeasure {
  return (el) => {
    try {
      const mount = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const root = rootOf(el);
      if (root.parentNode !== mount) mount.replaceChildren(root);
      const view = el.ownerDocument.defaultView;
      const rootScreen = (root as SVGGraphicsElement).getScreenCTM();
      const toRootFromScreen = rootScreen ? invert(matrixOf(rootScreen)) : null;
      if (!view || !toRootFromScreen) return null;
      /** `node`'s user units to the root's, or `null`. */
      const toRoot = (node: SVGGraphicsElement): Matrix | null => {
        const screen = node.getScreenCTM();
        return screen ? multiply(toRootFromScreen, matrixOf(screen)) : null;
      };

      const matrix = toRoot(el);
      if (!matrix) return null;
      const style = view.getComputedStyle(el);
      const scale = scaleOf(matrix);
      const stroked = style.getPropertyValue("stroke") !== "none";
      const strokeWidth = stroked ? Number.parseFloat(style.getPropertyValue("stroke-width") || "1") : 0;
      if (!Number.isFinite(strokeWidth)) return null;
      const hasMarkers = ["marker-start", "marker-mid", "marker-end"].some((name) => {
        const value = style.getPropertyValue(name);
        return value !== "" && value !== "none";
      });
      let box = widen(mapRect(el.getBBox(), matrix), (strokeWidth / 2) * scale);
      if (hasMarkers) box = widen(box, markerReach(strokeWidth, scale));

      for (let node: Element | null = el; node; node = node.parentElement) {
        const filter = filterElementOf(view.getComputedStyle(node).getPropertyValue("filter"), root);
        if (filter === undefined) continue;
        if (filter === null) return null;
        const filtered = node as SVGGraphicsElement;
        const region = filterRegion(filter, filtered.getBBox());
        const nodeMatrix = toRoot(filtered);
        if (!region || !nodeMatrix) return null;
        box = unionRect([box, mapRect(region, nodeMatrix)]);
      }
      return box;
    } catch {
      return null;
    }
  };
}
