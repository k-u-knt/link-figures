/**
 * Reading and inlining SVG text, for placing a linked `.svg` inside another SVG. Pure string work (no DOM), so it
 * runs in tests and in the exporters alike.
 *
 * Inlining makes the file's elements part of the figure's document, so everything that is global there is made the
 * file's own: ids, `class` names and `<style>` rules are carried into the node's namespace, and what could run or
 * escape (scripts, event attributes, `<foreignObject>`) is dropped.
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

const PREDEFINED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
/** An entity whose value would grow past this is not defined, so nested definitions cannot blow the text up. */
const MAX_ENTITY_LENGTH = 100_000;

function expandEntityRefs(text: string, entities: Map<string, string>): string {
  return text.replace(/&([A-Za-z_][\w.-]*);/g, (ref, name: string) => entities.get(name) ?? ref);
}

/**
 * Replaces `&name;` references to entities declared in the DOCTYPE's internal subset (`<!ENTITY name "value">`) by
 * their values, and drops the DOCTYPE. Once the DOCTYPE is gone an undeclared `xmlns:x="&ns_x;"` (Illustrator) would
 * make the whole document not well-formed.
 */
function expandEntities(text: string): string {
  if (!text.includes("<!ENTITY")) return text;
  const doctype = /<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>/i.exec(text);
  if (!doctype) return text;
  const entities = new Map<string, string>();
  for (const m of doctype[0].matchAll(/<!ENTITY\s+([^\s%"']+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g)) {
    if (PREDEFINED_ENTITIES.has(m[1])) continue;
    const value = expandEntityRefs(m[2] ?? m[3] ?? "", entities);
    if (value.length <= MAX_ENTITY_LENGTH) entities.set(m[1], value);
  }
  const rest = text.slice(doctype.index + doctype[0].length);
  return text.slice(0, doctype.index) + (entities.size > 0 ? expandEntityRefs(rest, entities) : rest);
}

interface RootTag {
  /** The text with entities expanded; the offsets below index into it. */
  doc: string;
  /** The attribute text of the root `<svg>`. */
  attrs: string;
  /** Where the markup between the root's start and end tags lies; empty for a self-closing root. */
  innerStart: number;
  innerEnd: number;
}

/** Finds the root `<svg>` after the prolog; null when the text does not begin like an SVG file. */
function parseRoot(text: string): RootTag | null {
  const doc = expandEntities(text);
  let pos = 0;
  for (;;) {
    PROLOG_ITEM.lastIndex = pos;
    const item = PROLOG_ITEM.exec(doc);
    if (!item) break;
    pos += item[0].length;
  }
  ROOT_START.lastIndex = pos;
  const start = ROOT_START.exec(doc);
  if (!start) return null;
  const attrs = start[1];
  const innerStart = pos + start[0].length;
  if (attrs.trimEnd().endsWith("/")) return { doc, attrs, innerStart, innerEnd: innerStart };
  const close = doc.lastIndexOf("</svg");
  const closed = close >= innerStart && /^<\/svg\s*>/.test(doc.slice(close, close + 40));
  return { doc, attrs, innerStart, innerEnd: closed ? close : doc.length };
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

/** `url(#x)`, `url('#x')`, `url("#x")` and `url(&quot;#x&quot;)`, with or without spaces inside. */
const URL_REF = /url\(\s*(&quot;|["']?)#([^)"'&\s]*)\1\s*\)/g;

function prefixUrlRefs(text: string, idPrefix: string): string {
  return text.replace(URL_REF, (_m, quote: string, id: string) => `url(${quote}#${idPrefix}${id}${quote})`);
}

function prefixClasses(value: string, idPrefix: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => idPrefix + name)
    .join(" ");
}

/** What the nested `<svg>` that takes the root's place sets itself. */
const OWN_ROOT_ATTRIBUTES = new Set(["x", "y", "width", "height", "viewBox", "preserveAspectRatio", "xmlns", "id"]);

/**
 * The root `<svg>`'s attributes that are not the nested element's own (position, size, view box, default namespace,
 * id), as ` name="value"` text for the element that takes the root's place: namespace prefixes (` xmlns:xlink="…"`,
 * without which inlined `xlink:href` is not well-formed), and the presentation attributes the content inherits
 * (`fill`, `stroke`, `style`, `class`…). `class` and `url(#x)` references are carried into `idPrefix`'s namespace;
 * event attributes are dropped.
 */
export function svgRootAttributes(text: string, idPrefix = ""): string {
  const root = parseRoot(text);
  if (!root) return "";
  let out = "";
  for (const [name, value] of attributesOf(root.attrs)) {
    if (OWN_ROOT_ATTRIBUTES.has(name) || /^on[a-z]/i.test(name)) continue;
    const carried = prefixUrlRefs(name === "class" ? prefixClasses(value, idPrefix) : value, idPrefix);
    out += ` ${name}="${carried.replace(/"/g, "&quot;")}"`;
  }
  return out;
}

interface Scope {
  idPrefix: string;
  /** The root's own class names, as the file wrote them: a rule for `.svglite polyline` must still reach the root's children. */
  rootClasses: Set<string>;
  warnings?: string[];
}

function warn(scope: Scope, message: string): void {
  if (scope.warnings && !scope.warnings.includes(message)) scope.warnings.push(message);
}

/** Index of the closing quote of the string that opens at `i` (or the end of `s`). */
function skipQuoted(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length && s[j] !== s[i]) j += s[j] === "\\" ? 2 : 1;
  return j;
}

/** Splits at top-level occurrences of `sep`, not inside parentheses, brackets or strings. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") i = skipQuoted(s, i);
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(s.slice(from));
  return parts;
}

/** Where the selector's first compound selector ends: at the first combinator (whitespace, `>`, `+`, `~`) outside brackets. */
function firstCompoundEnd(sel: string): number {
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") i = skipQuoted(sel, i);
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) return i;
  }
  return sel.length;
}

/** `#x` becomes `#{prefix}x` and `.c` becomes `.{prefix}c`; attribute selectors and strings are left as they are. */
function prefixSelectorNames(sel: string, idPrefix: string): string {
  let out = "";
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === "\\") {
      out += sel.slice(i, i + 2);
      i++;
    } else if (c === '"' || c === "'") {
      const end = skipQuoted(sel, i);
      out += sel.slice(i, end + 1);
      i = end;
    } else if (c === "[") {
      let end = i + 1;
      while (end < sel.length && sel[end] !== "]") end = sel[end] === '"' || sel[end] === "'" ? skipQuoted(sel, end) + 1 : end + 1;
      out += sel.slice(i, end + 1);
      i = end;
    } else if ((c === "#" || c === ".") && /[A-Za-z_\\-]|[^\x00-\x7f]/.test(sel[i + 1] ?? "")) {
      out += c + idPrefix;
    } else {
      out += c;
    }
  }
  return out;
}

/** A first compound selector that can be the root element itself: `svg`, `.rootClass`, `svg.rootClass`. */
const ROOT_COMPOUND = /^(svg)?((?:\.[\w-]+)*)$/;

/**
 * One selector scoped to the inlined file: `S` becomes `#{prefix}root S`. A selector whose first part can match the
 * root element itself (`.svglite polyline` when the root has `class="svglite"`) would not match as its own
 * descendant, so it also gets the form where that first part and the scope are the same element.
 */
function scopeSelector(sel: string, scope: Scope): string[] {
  const root = `#${scope.idPrefix}root`;
  const scoped = [`${root} ${prefixSelectorNames(sel, scope.idPrefix)}`];
  const end = firstCompoundEnd(sel);
  const first = ROOT_COMPOUND.exec(sel.slice(0, end));
  if (first && end > 0) {
    const classes = first[2].split(".").filter(Boolean);
    if (classes.every((name) => scope.rootClasses.has(name))) {
      scoped.push(`${first[1] ?? ""}${root}${prefixSelectorNames(first[2], scope.idPrefix)}${prefixSelectorNames(sel.slice(end), scope.idPrefix)}`);
    }
  }
  return scoped;
}

/**
 * A stylesheet with every rule scoped to the inlined file (see `scopeSelector`), so that its `*` or `.st0` cannot
 * restyle the rest of the figure or collide with another file's. At-rules (`@media`, `@font-face`, `@import`…) are
 * dropped.
 */
function scopeCss(css: string, scope: Scope): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    let open = i;
    while (open < src.length && src[open] !== "{" && src[open] !== ";") open++;
    if (open >= src.length) break;
    const prelude = src.slice(i, open).trim();
    if (src[open] === ";") {
      if (prelude.startsWith("@")) warn(scope, `${/^@[\w-]+/.exec(prelude)?.[0] ?? "@"} rule in <style> dropped`);
      i = open + 1;
      continue;
    }
    let depth = 1;
    let end = open + 1;
    while (end < src.length && depth > 0) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}") depth--;
      end++;
    }
    const body = src.slice(open + 1, depth === 0 ? end - 1 : end);
    i = end;
    if (prelude.startsWith("@")) {
      warn(scope, `${/^@[\w-]+/.exec(prelude)?.[0] ?? "@"} rule in <style> dropped`);
      continue;
    }
    const selectors = splitTopLevel(prelude, ",")
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((s) => scopeSelector(s, scope));
    if (selectors.length > 0) out += `${selectors.join(",")}{${body}}`;
  }
  return out;
}

function scopeStyleElements(markup: string, scope: Scope): string {
  return markup.replace(new RegExp(`<style(?=[\\s>])(${QUOTED_TAG_BODY})>([\\s\\S]*?)<\\/style\\s*>`, "g"), (_m, attrs: string, css: string) => {
    const cdata = /^(\s*<!\[CDATA\[)([\s\S]*?)(\]\]>\s*)$/.exec(css);
    const scoped = cdata ? cdata[1] + scopeCss(cdata[2], scope) + cdata[3] : scopeCss(css, scope);
    return `<style${attrs}>${scoped}</style>`;
  });
}

/** Only inside a start tag: event attributes go; `id` (not `xml:id` or `data-id`), `class` and a `href` into this document are carried over. */
function prefixAttributes(tag: string, idPrefix: string): string {
  return tag
    .replace(/\s+on[A-Za-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/(\sid\s*=\s*)("[^"]*"|'[^']*')/g, (_m, head: string, value: string) => `${head}${value[0]}${idPrefix}${value.slice(1)}`)
    .replace(
      /(\sclass\s*=\s*)("[^"]*"|'[^']*')/g,
      (_m, head: string, value: string) => `${head}${value[0]}${prefixClasses(value.slice(1, -1), idPrefix)}${value[0]}`,
    )
    .replace(/(\s(?:[A-Za-z_][\w.-]*:)?href\s*=\s*)(["'])#/g, (_m, head: string, quote: string) => `${head}${quote}#${idPrefix}`);
}

/**
 * The root `<svg>`'s child markup, made safe to share a document with the figure and with other files. In
 * `idPrefix`'s namespace: every `id`, every reference to one (`url(#x)`, `href="#x"`, `xlink:href="#x"` or any
 * other prefix), every `class` name, and every `<style>` rule, which is also scoped to `#{idPrefix}root`, the id
 * the element that takes the root's place must carry. Dropped: the XML declaration, DOCTYPE (its entities are
 * expanded first), comments, `<script>`, `<foreignObject>` and `on…` attributes, and `<style>` at-rules, each
 * kind of which adds a message to `warnings`.
 */
export function inlineSvg(text: string, idPrefix: string, warnings?: string[]): string {
  const root = parseRoot(text);
  if (!root) return "";
  const scope: Scope = {
    idPrefix,
    rootClasses: new Set((attributesOf(root.attrs).get("class") ?? "").split(/\s+/).filter(Boolean)),
    warnings,
  };
  const inner = root.doc
    .slice(root.innerStart, root.innerEnd)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(new RegExp(`<script\\b${QUOTED_TAG_BODY}/>|<script\\b[\\s\\S]*?</script\\s*>`, "gi"), "")
    .replace(new RegExp(`<foreignObject\\b${QUOTED_TAG_BODY}/>|<foreignObject\\b[\\s\\S]*?</foreignObject\\s*>`, "gi"), "");
  return prefixUrlRefs(
    scopeStyleElements(inner, scope)
      .trim()
      .replace(new RegExp(`<[A-Za-z_][^\\s/>]*${QUOTED_TAG_BODY}>`, "g"), (tag) => prefixAttributes(tag, idPrefix)),
    idPrefix,
  );
}
