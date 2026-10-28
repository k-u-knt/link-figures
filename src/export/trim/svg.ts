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

/** Elements that are only ever drawn through a reference, wherever they are declared. */
const RESOURCES = new Set(["clipPath", "mask", "marker", "pattern", "linearGradient", "radialGradient", "filter", "symbol"]);

/**
 * The definitions that can go when nothing uses them any more: the children of `<defs>` and the resource elements
 * anywhere, that have an id and are not inside another definition.
 */
function definitionsOf(root: Element): Element[] {
  const definitions: Element[] = [];
  for (const el of Array.from(root.querySelectorAll("[id]"))) {
    if (!isSvg(el) || !(el.parentElement?.localName === "defs" || RESOURCES.has(el.localName))) continue;
    if (definitions.some((definition) => definition.contains(el))) continue;
    definitions.push(el);
  }
  return definitions;
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

/** A plain number attribute (`px` allowed), `fallback` when absent, `null` when it cannot be read. */
function numberAttribute(el: Element, name: string, fallback: number): number | null {
  const value = el.getAttribute(name);
  return value === null || value.trim() === "" ? fallback : userLengthOf(value);
}

/** `<marker>`'s viewBox mapped into its viewport (`width` × `height`) as `preserveAspectRatio` says: scale and offset per axis. */
function markerViewBoxFit(marker: Element, width: number, height: number): { sx: number; sy: number; tx: number; ty: number } | null {
  const viewBox = marker.getAttribute("viewBox");
  if (viewBox === null) return { sx: 1, sy: 1, tx: 0, ty: 0 };
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite) || !(parts[2] > 0 && parts[3] > 0)) return null;
  const [vx, vy, vw, vh] = parts;
  const ratio = (marker.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim().split(/\s+/);
  const align = ratio[0] || "xMidYMid";
  if (align === "none") return { sx: width / vw, sy: height / vh, tx: (-vx * width) / vw, ty: (-vy * height) / vh };
  const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
  const meetOrSlice = ratio[1] ?? "meet";
  if (!m || (meetOrSlice !== "meet" && meetOrSlice !== "slice")) return null;
  const s = meetOrSlice === "meet" ? Math.min(width / vw, height / vh) : Math.max(width / vw, height / vh);
  const offset = (where: string, room: number) => (where === "Min" ? 0 : where === "Mid" ? room / 2 : room);
  return { sx: s, sy: s, tx: -vx * s + offset(m[1], width - vw * s), ty: -vy * s + offset(m[2], height - vh * s) };
}

/**
 * How far `marker` can paint from the vertex it is placed on, in the user units of the element it marks: the farthest
 * corner of its viewport (`markerWidth` × `markerHeight`, default 3 × 3) from its reference point (`refX`, `refY`, in
 * its viewBox when it has one), in stroke widths unless `markerUnits` is `userSpaceOnUse`. The distance holds however
 * `orient` turns it. `null` when it cannot be read, or when its content may paint outside its viewport
 * (`overflow` visible or auto).
 */
function markerReach(marker: Element, strokeWidth: number, view: Window): number | null {
  const overflow = view.getComputedStyle(marker).getPropertyValue("overflow");
  if (overflow === "visible" || overflow === "auto") return null;
  const units = marker.getAttribute("markerUnits") ?? "strokeWidth";
  if (units !== "strokeWidth" && units !== "userSpaceOnUse") return null;
  const width = numberAttribute(marker, "markerWidth", 3);
  const height = numberAttribute(marker, "markerHeight", 3);
  const refX = numberAttribute(marker, "refX", 0);
  const refY = numberAttribute(marker, "refY", 0);
  if (width === null || height === null || refX === null || refY === null || width < 0 || height < 0) return null;
  const fit = markerViewBoxFit(marker, width, height);
  if (!fit) return null;
  const rx = refX * fit.sx + fit.tx;
  const ry = refY * fit.sy + fit.ty;
  const reach = Math.hypot(Math.max(Math.abs(rx), Math.abs(width - rx)), Math.max(Math.abs(ry), Math.abs(height - ry)));
  return units === "strokeWidth" ? reach * strokeWidth : reach;
}

/** The element named by a computed `url(#id)` value of `tag` in `root`, `undefined` for `none`, `null` for anything else (a missing element, a CSS function). */
function referencedElement(value: string, tag: string, root: Element): Element | null | undefined {
  if (value === "" || value === "none") return undefined;
  const m = /^url\(\s*["']?#([^)"'\s]+)["']?\s*\)$/.exec(value.trim());
  if (!m) return null;
  return Array.from(root.querySelectorAll(tag)).find((el) => el.id === m[1]) ?? null;
}

/** The outermost element above `el` (or `el` itself). */
function rootOf(el: Element): Element {
  let root = el;
  while (root.parentElement) root = root.parentElement;
  return root;
}

// ---- A safe copy to measure ------------------------------------------------------------------------------------------

/** Elements that could run something or load something else into the app's document. */
const UNSAFE_ELEMENTS = new Set(["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "handler", "listener"]);

const XLINK_NS = "http://www.w3.org/1999/xlink";

/** A reference that stays inside the file: `#…` or `data:…`. */
function isLocalTarget(target: string): boolean {
  const t = target.trim().toLowerCase();
  return t.startsWith("#") || t.startsWith("data:");
}

/**
 * What a `url()` that leaves the file becomes in the measuring copy: a reference to nothing, as a target that cannot be
 * loaded is to the browser. A paint falls back to the colour written after it, and a filter or marker naming it cannot
 * be measured, so what it draws is kept.
 */
const REMOVED_URL = "url(#lf-removed)";
const REMOVED_ID = "lf-removed";

/**
 * `css` with every `url()` that leaves the file replaced by `REMOVED_URL`, or `null` when what is left could still load
 * something (an `@import`, `image-set()`, a CSS escape that could spell either, a `url(` that was not understood).
 */
function localCss(css: string): string | null {
  const out = css.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (whole, _quote: string, target: string) => (isLocalTarget(target) ? whole : REMOVED_URL));
  if (/\\|@import|image-set\(|image\(|cross-fade\(|element\(/i.test(out)) return null;
  for (const m of out.matchAll(/url\(/gi)) {
    if (!/^url\(\s*["']?\s*(#|data:)/i.test(out.slice(m.index))) return null;
  }
  return out;
}

/**
 * Makes `root` (a copy, not yet in any live document) safe to put into the app's document: drops elements that run or
 * embed (scripts, `foreignObject`, anything not SVG) and animations, event attributes, links out of the file, and
 * CSS that loads (see `localCss`). False when some CSS could not be made safe: the copy must then not be used.
 */
function makeSafe(root: Element): boolean {
  for (const el of elementsOf(root)) {
    if (el !== root && (!isSvg(el) || UNSAFE_ELEMENTS.has(el.localName) || ANIMATIONS.has(el.localName))) {
      el.remove();
      continue;
    }
    // `REMOVED_URL` must name nothing.
    if (el.id === REMOVED_ID) el.removeAttribute("id");
    for (const attribute of Array.from(el.attributes)) {
      const name = attribute.localName.toLowerCase();
      const isLink = name === "href" || name === "src" || attribute.namespaceURI === XLINK_NS;
      if (name.startsWith("on") || (isLink && !isLocalTarget(attribute.value))) {
        el.removeAttributeNode(attribute);
        continue;
      }
      if (!/url\(|\\|@import|image/i.test(attribute.value)) continue;
      const css = localCss(attribute.value);
      if (css === null) return false;
      attribute.value = css;
    }
    if (el.localName === "style") {
      const css = localCss(el.textContent ?? "");
      if (css === null) return false;
      el.textContent = css;
    }
  }
  return true;
}

/** A source's safe copy, in a shadow root of the host, and which copy stands for each of the source's elements. */
interface Mounted {
  source: Element;
  root: Element;
  copies: Map<Element, Element>;
}

/** Puts a safe copy of `source` into a shadow root of `host`; `null` when no safe copy can be made. */
function mountSafeCopy(source: Element, host: HTMLElement): Mounted | null {
  // Copied in the parsed (inert) document, and made safe there, before any of it reaches the app's document.
  const root = source.cloneNode(true) as Element;
  const sources = elementsOf(source);
  const copies = new Map(elementsOf(root).map((copy, i) => [sources[i], copy]));
  if (!makeSafe(root)) return null;
  const mount = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  mount.replaceChildren(root);
  return { source, root, copies };
}

/**
 * A measure with the browser's layout. `failure` says why no element of the SVG could be measured at all (its styles
 * could not be made safe, or its root could not be laid out), or is `null`: then a `null` box is that element's own.
 */
export type DomSvgMeasure = SvgMeasure & { readonly failure: string | null };

const UNSAFE_FAILURE = "the SVG's styles could not be made safe to measure";
const LAYOUT_FAILURE = "the SVG could not be laid out to measure";

/**
 * Measures with the browser's layout. The source itself never enters the app's document: the first element measured
 * puts a safe copy of its SVG (see `makeSafe`) into a shadow root of `host` (which should be in the document, out of
 * sight but not `display: none`), and each element is measured by its copy. The shadow root keeps the SVG's `<style>`
 * rules and the app's apart. The box is `getBBox()` mapped to the root's user units (its viewBox) through the screen
 * matrices of the element and of the root, widened by half the stroke width (scaled), by the farthest reach of its
 * markers (see `markerReach`), and to the filter region of every filter on the element or above it. `null` when any
 * of this cannot be read, or no safe copy can be made (and then `failure` says so).
 */
export function domSvgMeasure(host: HTMLElement): DomSvgMeasure {
  let mounted: Mounted | null = null;
  let unsafe: Element | null = null;
  let failure: string | null = null;
  const measure: SvgMeasure = (source) => {
    try {
      const sourceRoot = rootOf(source);
      if (unsafe === sourceRoot) return null;
      if (mounted?.source !== sourceRoot) {
        mounted = mountSafeCopy(sourceRoot, host);
        if (!mounted) {
          unsafe = sourceRoot;
          failure = UNSAFE_FAILURE;
          return null;
        }
      }
      const root = mounted.root;
      const el = mounted.copies.get(source) as SVGGraphicsElement | undefined;
      const view = root.ownerDocument.defaultView;
      const rootScreen = (root as SVGGraphicsElement).getScreenCTM();
      const toRootFromScreen = rootScreen ? invert(matrixOf(rootScreen)) : null;
      if (!view || !toRootFromScreen) {
        failure = LAYOUT_FAILURE;
        return null;
      }
      if (!el || !el.isConnected) return null;
      /** `node`'s user units to the root's, or `null`. */
      const toRoot = (node: SVGGraphicsElement): Matrix | null => {
        const screen = node.getScreenCTM();
        return screen ? multiply(toRootFromScreen, matrixOf(screen)) : null;
      };

      const matrix = toRoot(el);
      if (!matrix) return null;
      const style = view.getComputedStyle(el);
      const scale = scaleOf(matrix);
      const strokeWidth = Number.parseFloat(style.getPropertyValue("stroke-width") || "1");
      if (!Number.isFinite(strokeWidth)) return null;
      const stroked = style.getPropertyValue("stroke") !== "none";
      let reach = stroked ? strokeWidth / 2 : 0;
      for (const property of ["marker-start", "marker-mid", "marker-end"]) {
        const marker = referencedElement(style.getPropertyValue(property), "marker", root);
        if (marker === undefined) continue;
        const markerReached = marker && markerReach(marker, strokeWidth, view);
        if (markerReached === null || markerReached === undefined) return null;
        reach = Math.max(reach, markerReached);
      }
      let box = widen(mapRect(el.getBBox(), matrix), reach * scale);

      for (let node: Element | null = el; node; node = node.parentElement) {
        const filter = referencedElement(view.getComputedStyle(node).getPropertyValue("filter"), "filter", root);
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
  return Object.defineProperty(measure, "failure", { get: () => failure }) as DomSvgMeasure;
}
