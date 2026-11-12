/**
 * Reading and inlining SVG text, for placing a linked `.svg` inside another SVG. Pure string work (no DOM), so it
 * runs in tests and in the exporters alike.
 *
 * Inlining makes the file's elements part of the figure's document, so everything that is global there is made the
 * file's own: ids, `class` names and `<style>` rules are carried into the node's namespace, and what could run or
 * escape (scripts, event attributes, `<foreignObject>`, `javascript:` links) is dropped, as is every reference out of
 * the document (an `href` or `url()` that is not `#…` or `data:…`): the PDF export fetches what `<image>` points at
 * and turns `<a>` into link annotations, and a browser opening the SVG export would fetch the rest.
 *
 * The markup is read by a tokenizer, not by regular expressions, so that a quote inside one attribute's value cannot
 * hide the next attribute, and every start tag is rebuilt from the attributes it keeps, so that removing one cannot
 * join its neighbours into another (`<a hr href="x"ef="javascript:…">`). The tokenizer reads a tag the way a lenient
 * (HTML) parser does — unquoted and valueless attributes, nothing between a quoted value and the next name — which
 * agrees with an XML parser on every well-formed tag and sees at least what either sees in a malformed one.
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

/** What may precede the root element: whitespace (a byte order mark counts), the XML declaration, comments, the DOCTYPE. */
const PROLOG_ITEM = /\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[^\]]*\][^>[]*)?>/iy;

/**
 * Where the prolog of `text` ends, and where its DOCTYPE lies (null without one). The DOCTYPE's pattern has one way
 * to match any text, so a run of `[]` cannot make it backtrack (it used to take time exponential in the run), and it is
 * only looked for in the prolog, item by item, so text further on (a comment, say) is never read as one.
 */
function readProlog(text: string): { end: number; doctype: { start: number; end: number } | null } {
  let pos = 0;
  let doctype: { start: number; end: number } | null = null;
  for (;;) {
    PROLOG_ITEM.lastIndex = pos;
    const item = PROLOG_ITEM.exec(text);
    if (!item) break;
    if (doctype === null && /^<!DOCTYPE/i.test(item[0])) doctype = { start: pos, end: pos + item[0].length };
    pos += item[0].length;
  }
  return { end: pos, doctype };
}

const PREDEFINED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
/** An entity whose value would grow past this is not defined, so nested definitions cannot blow the text up. */
const MAX_ENTITY_LENGTH = 100_000;
/** What expanding entities may add to a document in all (2 MB): many references to a large entity cannot blow it up either. */
const MAX_EXPANSION_LENGTH = 2 * 1024 * 1024;
const EXPANSION_CAPPED_WARNING = "entity expansion stopped at 2 MB; the remaining references were removed";

/**
 * Replaces `&name;` references to `entities` by their values while the text grows by at most `budget` characters in
 * all. Past that, expanding stops: the remaining references to `entities` are removed (left in, they would not be
 * well-formed once the DOCTYPE that declared them is gone), and `capped` says so.
 */
function expandEntityRefs(text: string, entities: Map<string, string>, budget: number): { text: string; capped: boolean } {
  let grown = 0;
  let capped = false;
  const out = text.replace(/&([A-Za-z_][\w.-]*);/g, (ref, name: string) => {
    const value = entities.get(name);
    if (value === undefined) return ref;
    if (capped || grown + value.length - ref.length > budget) {
      capped = true;
      return "";
    }
    grown += value.length - ref.length;
    return value;
  });
  return { text: out, capped };
}

/**
 * Replaces `&name;` references to entities declared in the DOCTYPE's internal subset (`<!ENTITY name "value">`) by
 * their values, and drops the DOCTYPE. Once the DOCTYPE is gone an undeclared `xmlns:x="&ns_x;"` (Illustrator) would
 * make the whole document not well-formed. Expansion adds at most `MAX_EXPANSION_LENGTH` characters (`capped` past that).
 */
function expandEntities(text: string): { text: string; capped: boolean } {
  if (!text.includes("<!ENTITY")) return { text, capped: false };
  const doctype = readProlog(text).doctype;
  if (!doctype) return { text, capped: false };
  const entities = new Map<string, string>();
  for (const m of text.slice(doctype.start, doctype.end).matchAll(/<!ENTITY\s+([^\s%"']+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g)) {
    if (PREDEFINED_ENTITIES.has(m[1])) continue;
    const value = expandEntityRefs(m[2] ?? m[3] ?? "", entities, MAX_ENTITY_LENGTH);
    if (!value.capped && value.text.length <= MAX_ENTITY_LENGTH) entities.set(m[1], value.text);
  }
  const rest = text.slice(doctype.end);
  const expanded = entities.size > 0 ? expandEntityRefs(rest, entities, MAX_EXPANSION_LENGTH) : { text: rest, capped: false };
  return { text: text.slice(0, doctype.start) + expanded.text, capped: expanded.capped };
}

// ---- The tokenizer ---------------------------------------------------------------------------------------------------

/** One attribute of a tag as the tokenizer read it: `value` is the raw text between the quotes, or the unquoted run. */
interface TagAttribute {
  name: string;
  value: string;
  /** The quote the value was written in, or "" for an unquoted or missing value. */
  quote: string;
}

interface Tag {
  /** The name as written, prefix included (`svg:script`). */
  name: string;
  attributes: TagAttribute[];
  selfClosing: boolean;
  /** Index just past the closing `>`, or the markup's length when the tag never closes. */
  end: number;
  /** False when the markup ends inside the tag (in a quoted value, say): a lenient parser then drops the tag and the rest. */
  closed: boolean;
}

const WHITESPACE = /\s/;
/** What may follow `<` (or `</`) for a tag: a letter, `_`, `:` or anything outside ASCII, as an XML name may start. */
const NAME_START = /[A-Za-z_:\u0080-\uFFFF]/;

/**
 * Reads the start or end tag that opens at `start` (the index of its `<`) the way a lenient parser does: the name runs
 * to whitespace, `/` or `>`; then attributes, each a name (a run without whitespace, `/`, `>` or `=`), optionally `=`
 * and a value, quoted (to the matching quote, `>` allowed inside) or unquoted (to whitespace or `>`); nothing need
 * separate a quoted value from the next name; a `/` not followed by `>` is skipped. The first of two attributes with
 * the same name wins, as in HTML (in XML the tag would not be well-formed).
 */
function readTag(markup: string, start: number): Tag {
  const len = markup.length;
  let i = start + 1;
  if (markup[i] === "/") i++;
  const nameStart = i;
  while (i < len && !/[\s/>]/.test(markup[i])) i++;
  const name = markup.slice(nameStart, i);
  const attributes: TagAttribute[] = [];
  const seen = new Set<string>();
  const add = (attribute: TagAttribute) => {
    if (!seen.has(attribute.name)) attributes.push(attribute);
    seen.add(attribute.name);
  };
  const tag = (selfClosing: boolean, end: number, closed: boolean): Tag => ({ name, attributes, selfClosing, end, closed });
  for (;;) {
    while (i < len && WHITESPACE.test(markup[i])) i++;
    if (i >= len) return tag(false, len, false);
    const c = markup[i];
    if (c === ">") return tag(false, i + 1, true);
    if (c === "/") {
      if (markup[i + 1] === ">") return tag(true, i + 2, true);
      i++;
      continue;
    }
    const attrStart = i++;
    while (i < len && !/[\s/>=]/.test(markup[i])) i++;
    const attrName = markup.slice(attrStart, i);
    let j = i;
    while (j < len && WHITESPACE.test(markup[j])) j++;
    if (markup[j] !== "=") {
      add({ name: attrName, value: "", quote: "" });
      continue;
    }
    i = j + 1;
    while (i < len && WHITESPACE.test(markup[i])) i++;
    const quote = markup[i];
    if (quote === '"' || quote === "'") {
      const close = markup.indexOf(quote, i + 1);
      if (close < 0) return tag(false, len, false);
      add({ name: attrName, value: markup.slice(i + 1, close), quote });
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < len && !/[\s>]/.test(markup[i])) i++;
      add({ name: attrName, value: markup.slice(valueStart, i), quote: "" });
    }
  }
}

/**
 * The element's name without its namespace prefix, in lower case; "" for a name with `<` in it (`scr<script`), which
 * no parser knows as an element, so that it is no `script` either: `dropElementFragments` deals with what it holds.
 */
function localName(name: string): string {
  return name.includes("<") ? "" : name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

function attributesOf(tag: Tag): Map<string, string> {
  return new Map(tag.attributes.map((a) => [a.name, a.value]));
}

interface Token {
  /** Text up to the next `<`; a lone `<` that opens nothing; a CDATA section; a comment or other `<!…>`/`<?…>` (dropped); a tag. */
  kind: "text" | "lt" | "cdata" | "comment" | "bogus" | "start" | "end";
  start: number;
  end: number;
  tag?: Tag;
}

/** Index just past `terminator` from `from` on, or the markup's length when it does not occur. */
function endOf(markup: string, terminator: string, from: number): number {
  const at = markup.indexOf(terminator, from);
  return at < 0 ? markup.length : at + terminator.length;
}

/** The token at `i`, read as in text content: a lone `<` is text, `<!…>` and `<?…>` run to the first `>` as in HTML. */
function readToken(markup: string, i: number): Token {
  if (markup[i] !== "<") {
    const next = markup.indexOf("<", i);
    return { kind: "text", start: i, end: next < 0 ? markup.length : next };
  }
  const c = markup[i + 1] ?? "";
  if (c === "!") {
    if (markup.startsWith("<![CDATA[", i)) return { kind: "cdata", start: i, end: endOf(markup, "]]>", i + 9) };
    if (markup.startsWith("<!--", i)) return { kind: "comment", start: i, end: endOf(markup, "-->", i + 4) };
    return { kind: "bogus", start: i, end: endOf(markup, ">", i + 2) };
  }
  if (c === "?") return { kind: "bogus", start: i, end: endOf(markup, ">", i + 2) };
  if (c === "/") {
    if (!NAME_START.test(markup[i + 2] ?? "")) return { kind: "bogus", start: i, end: endOf(markup, ">", i + 2) };
    const tag = readTag(markup, i);
    return { kind: "end", start: i, end: tag.end, tag };
  }
  if (!NAME_START.test(c)) return { kind: "lt", start: i, end: i + 1 };
  const tag = readTag(markup, i);
  return { kind: "start", start: i, end: tag.end, tag };
}

/**
 * Where the element whose start tag ends at `from` ends: the index of its end tag (`contentEnd`) and the index just
 * past it (`end`), both the markup's length when there is none. Looks for an end tag of the same local name under
 * any prefix, past nested elements of that name, and past CDATA sections, comments and tags (a `</style>` quoted
 * inside a tag is no end tag).
 */
function findEndTag(markup: string, from: number, local: string): { contentEnd: number; end: number } {
  let depth = 0;
  for (let i = from; i < markup.length; ) {
    const token = readToken(markup, i);
    if (token.tag && !token.tag.closed) break;
    if (token.kind === "start" && token.tag && !token.tag.selfClosing && localName(token.tag.name) === local) depth++;
    else if (token.kind === "end" && token.tag && localName(token.tag.name) === local) {
      if (depth === 0) return { contentEnd: token.start, end: token.end };
      depth--;
    }
    i = token.end;
  }
  return { contentEnd: markup.length, end: markup.length };
}

// ---- The root element ------------------------------------------------------------------------------------------------

interface RootTag {
  /** The text with entities expanded; the offsets below index into it. */
  doc: string;
  /** Entity expansion stopped at its limit. */
  capped: boolean;
  /** The root `<svg>` start tag. */
  tag: Tag;
  /** Where the markup between the root's start and end tags lies; empty for a self-closing root. */
  innerStart: number;
  innerEnd: number;
}

/** Finds the root `<svg>` after the prolog; null when the text does not begin like an SVG file. */
function parseRoot(text: string): RootTag | null {
  const { text: doc, capped } = expandEntities(text);
  const pos = readProlog(doc).end;
  if (!doc.startsWith("<svg", pos) || !/[\s/>]/.test(doc[pos + 4] ?? "")) return null;
  const tag = readTag(doc, pos);
  if (!tag.closed) return null;
  const innerStart = tag.end;
  const innerEnd = tag.selfClosing ? innerStart : findEndTag(doc, innerStart, "svg").contentEnd;
  return { doc, capped, tag, innerStart, innerEnd };
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
  const attrs = root ? attributesOf(root.tag) : new Map<string, string>();
  const viewBox = parseViewBox(attrs.get("viewBox"));
  if (viewBox) return { width: viewBox[2], height: viewBox[3], viewBox };
  const width = lengthPx(attrs.get("width")) ?? DEFAULT_WIDTH;
  const height = lengthPx(attrs.get("height")) ?? DEFAULT_HEIGHT;
  return { width, height, viewBox: [0, 0, width, height] };
}

// ---- References ------------------------------------------------------------------------------------------------------

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

interface Scope {
  idPrefix: string;
  /** The namespaces in scope in the root's content: SVG's as the default (the root's place is taken by an SVG `<svg>`), and the prefixes the root binds. */
  namespaces: Namespaces;
  /** The root's own class names, as the file wrote them: a rule for `.svglite polyline` must still reach the root's children. */
  rootClasses: Set<string>;
  warnings?: string[];
}

function warn(scope: Scope, message: string): void {
  if (scope.warnings && !scope.warnings.includes(message)) scope.warnings.push(message);
}

/** `xml:base`, which would change what every relative reference below it points at. */
const XML_BASE = /^xml:base$/i;
/** `href`, `xlink:href` or the attribute under any other prefix. */
const HREF_NAME = /^(?:[^:]*:)*href$/i;
/**
 * `url(…)` with its value unquoted, quoted, or quoted with `&quot;` or `&apos;` (inside an attribute). The unquoted
 * value keeps the white space around it (a caller trims it) and holds no `(` unless escaped (CSS reads an unescaped
 * one as a bad URL, which loads nothing): no two parts of the pattern can match the same white space, so `url(`
 * followed by a long run of it cannot make the match backtrack (it used to take time cubic in the run).
 */
const URL_FUNCTION =
  /url\((?:\s*"([^"]*)"\s*|\s*'([^']*)'\s*|\s*&quot;((?:(?!&quot;)[\s\S])*)&quot;\s*|\s*&apos;((?:(?!&apos;)[\s\S])*)&apos;\s*|((?:[^()"'\\]|\\[\s\S])*))\)/gi;
const MAX_REFERENCE_SHOWN = 80;

/**
 * A reference that stays in the document: a fragment (`#id`) or an image as inline data (`data:image/png…`, and the
 * other types a browser draws as an image, where an SVG one runs no script and loads nothing). Anything else would be
 * fetched, or (`data:text/html`) is a document of its own.
 */
function isLocalRef(value: string): boolean {
  return /^\s*(?:#|data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)[;,])/i.test(value);
}

function externalRemoved(scope: Scope, value: string): void {
  const shown = value.trim() || "(empty)";
  warn(scope, `external reference removed: ${shown.length > MAX_REFERENCE_SHOWN ? `${shown.slice(0, MAX_REFERENCE_SHOWN)}…` : shown}`);
}

/** Every `url(…)` that leads out of the document (see `isLocalRef`) becomes `none`, with a warning. */
function dropExternalUrls(text: string, scope: Scope): string {
  return text.replace(URL_FUNCTION, (whole, ...values: (string | undefined)[]) => {
    const value = values.slice(0, 5).find((v) => v !== undefined) ?? "";
    if (isLocalRef(value)) return whole;
    externalRemoved(scope, value);
    return "none";
  });
}

// ---- Stylesheets -----------------------------------------------------------------------------------------------------

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
 * A stylesheet with its comments and at-rules (`@media`, `@font-face`, `@import`…) dropped, and, when `scoped`, every
 * rule scoped to the inlined file (see `scopeSelector`), so that its `*` or `.st0` cannot restyle the rest of the
 * figure or collide with another file's. Not scoped, the rules are written back as they are.
 */
function scopeCss(css: string, scope: Scope, scoped: boolean): string {
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
      .flatMap((s) => (scoped ? scopeSelector(s, scope) : [s]));
    if (selectors.length > 0) out += `${selectors.join(",")}{${body}}`;
  }
  return out;
}

/** A `<style>` whose whole content is one CDATA section (the section's own end cannot occur inside it). */
const CDATA_ONLY = /^(\s*<!\[CDATA\[)((?:(?!\]\]>)[\s\S])*)(\]\]>\s*)$/;

/**
 * The text of a `<style>` element with its at-rules and external `url()`s gone (see `scopeCss`, `dropExternalUrls`),
 * and when `inline`, its rules scoped and its `url(#x)` references prefixed. Written back inside its CDATA section
 * when it had one; otherwise a `<` is written as `&lt;` so that what was text cannot become markup.
 */
function sanitiseStyleContent(css: string, scope: Scope, inline: boolean): string {
  const cleaned = (text: string) => {
    const dropped = dropExternalUrls(scopeCss(text, scope, inline), scope);
    return inline ? prefixUrlRefs(dropped, scope.idPrefix) : dropped;
  };
  const cdata = CDATA_ONLY.exec(css);
  if (cdata) return cdata[1] + cleaned(cdata[2]) + cdata[3];
  return cleaned(css).replace(/</g, "&lt;").replace(/\]\]>/g, "]]&gt;");
}

// ---- Sanitising ------------------------------------------------------------------------------------------------------

/** Elements dropped with all they hold, by local name in lower case. */
const DROPPED_ELEMENTS = new Set(["script", "foreignobject"]);

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The SVG elements an inlined file keeps, by local name in lower case: what draws, its containers, paint servers,
 * filters, text, fonts, descriptive elements and declarative animation. Anything else — `<script>`,
 * `<foreignObject>`, SVG Tiny's `<handler>`, and every element of another namespace (an XHTML `<iframe>`, Inkscape's
 * `<sodipodi:namedview>`, RDF metadata) — is dropped with all it holds.
 */
const SVG_ELEMENTS = new Set(
  [
    "a", "circle", "clipPath", "defs", "desc", "ellipse", "g", "image", "line", "linearGradient", "marker", "mask",
    "metadata", "path", "pattern", "polygon", "polyline", "radialGradient", "rect", "stop", "style", "svg", "switch",
    "symbol", "text", "textPath", "title", "tref", "tspan", "use", "view",
    "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
    "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
    "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
    "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
    "font", "font-face", "font-face-format", "font-face-name", "font-face-src", "font-face-uri", "glyph", "glyphRef",
    "hkern", "missing-glyph", "vkern", "altGlyph", "altGlyphDef", "altGlyphItem",
    "animate", "animateColor", "animateMotion", "animateTransform", "mpath", "set",
  ].map((name) => name.toLowerCase()),
);
/** Animation elements: one that changes an `href` (`<set attributeName="href" to="javascript:…">`) is dropped. */
const ANIMATIONS = new Set(["animate", "animatecolor", "animatemotion", "animatetransform", "set"]);

/** The namespaces in scope by prefix ("" for the default one). */
type Namespaces = ReadonlyMap<string, string>;

/** `namespaces` with the declarations `tag` makes (`xmlns`, `xmlns:p`) added. */
function declaredNamespaces(tag: Tag, namespaces: Namespaces): Namespaces {
  let out: Map<string, string> | null = null;
  for (const { name, value } of tag.attributes) {
    const m = /^xmlns(?::(.*))?$/.exec(name);
    if (!m) continue;
    out ??= new Map(namespaces);
    out.set(m[1] ?? "", value.trim());
  }
  return out ?? namespaces;
}

/**
 * Whether the element `tag` opens is kept: an SVG element (see `SVG_ELEMENTS`) whose prefix, or the default
 * namespace, is bound to SVG's where it stands, and no animation that changes an `href`.
 */
function isKeptElement(tag: Tag, namespaces: Namespaces): boolean {
  const local = localName(tag.name);
  if (!SVG_ELEMENTS.has(local)) return false;
  const colon = tag.name.lastIndexOf(":");
  if (namespaces.get(colon < 0 ? "" : tag.name.slice(0, colon)) !== SVG_NAMESPACE) return false;
  if (ANIMATIONS.has(local)) {
    const target = tag.attributes.find((a) => a.name === "attributeName")?.value.trim() ?? "";
    if (HREF_NAME.test(target)) return false;
  }
  return true;
}
/** The start of a dropped element's tag wherever it occurs in the text, under any namespace prefix. */
const DROPPED_START = /<(?:[^\s/<>:"'=]+:)*(script|foreignObject)\b/gi;
const DROPPED_END = /<\/(?:[^\s/<>:"'=]+:)*(script|foreignObject)\s*>/gi;

/**
 * The value to write for an attribute, or null to drop it. Event attributes (`on…`) go; an `href` under any prefix
 * stays only when it leads into the document (`#…` or `data:…`, see `isLocalRef`), else it goes with a warning;
 * every other value loses its external `url()`s. When `inline`, `id`, `class`, a fragment `href` and `url(#x)` are
 * carried into `scope.idPrefix`'s namespace.
 */
function keptValue(attribute: TagAttribute, scope: Scope, inline: boolean): string | null {
  const { name, value } = attribute;
  if (/^on/i.test(name) || /["'<=]/.test(name) || XML_BASE.test(name)) return null;
  if (HREF_NAME.test(name)) {
    if (!isLocalRef(value)) {
      externalRemoved(scope, value);
      return null;
    }
    return inline && value.startsWith("#") ? `#${scope.idPrefix}${value.slice(1)}` : value;
  }
  if (inline && name === "id") return scope.idPrefix + value;
  if (inline && name === "class") return prefixClasses(value, scope.idPrefix);
  const kept = dropExternalUrls(value, scope);
  return inline ? prefixUrlRefs(kept, scope.idPrefix) : kept;
}

/** The value between the quotes it was written in (double quotes when it had none), the quote itself escaped. */
function quoted(value: string, quote: string): string {
  return quote === "'" ? `'${value.replace(/'/g, "&apos;")}'` : `"${value.replace(/"/g, "&quot;")}"`;
}

/** The start tag written again from the attributes it keeps (see `keptValue`), one space before each. */
function rebuildTag(tag: Tag, scope: Scope, inline: boolean): string {
  let out = `<${tag.name}`;
  for (const attribute of tag.attributes) {
    const value = keptValue(attribute, scope, inline);
    if (value !== null) out += ` ${attribute.name}=${quoted(value, attribute.quote)}`;
  }
  return out + (tag.selfClosing ? "/>" : ">");
}

/**
 * One pass over the markup, token by token: start tags are rebuilt from the attributes they keep, end tags written
 * as `</name>`, `<script>` and `<foreignObject>` (any prefix) dropped with everything up to their end tag (or to the
 * end of the markup), every element that is not an SVG one (see `SVG_ELEMENTS`, `isKeptElement`) dropped with
 * everything up to its end tag (or, without one, its start tag alone), comments and other `<!…>`/`<?…>` dropped, `<style>` content cleaned (see
 * `sanitiseStyleContent`), text and CDATA sections copied, and a `<` that opens nothing written as `&lt;`. Where the
 * markup ends inside a tag, the tag and what follows are dropped, as a lenient parser does.
 */
function sanitiseMarkup(markup: string, scope: Scope, inline: boolean): string {
  let out = "";
  // The elements open where the token stands, each with the namespaces in scope inside it; the first is the root's.
  const open: { name: string; namespaces: Namespaces }[] = [{ name: "", namespaces: scope.namespaces }];
  for (let i = 0; i < markup.length; ) {
    const token = readToken(markup, i);
    if (token.tag && !token.tag.closed) break;
    i = token.end;
    switch (token.kind) {
      case "text":
      case "cdata":
        out += markup.slice(token.start, token.end);
        break;
      case "lt":
        out += "&lt;";
        break;
      case "end": {
        out += `</${token.tag!.name}>`;
        const at = open.findLastIndex((e) => e.name === token.tag!.name);
        if (at > 0) open.length = at;
        break;
      }
      case "start": {
        const tag = token.tag!;
        const local = localName(tag.name);
        const namespaces = declaredNamespaces(tag, open[open.length - 1].namespaces);
        // A name with `<` in it is no element to any parser (see `localName`); `dropElementFragments` peels what it hides.
        const scripted = DROPPED_ELEMENTS.has(local);
        if (scripted || (local !== "" && !isKeptElement(tag, namespaces))) {
          // Dropped with all it holds. `<script>` and `<foreignObject>` without an end tag take the rest of the markup
          // with them; any other element without one loses its start tag only, and what follows is judged on its own.
          if (!tag.selfClosing) {
            const end = findEndTag(markup, tag.end, local);
            if (scripted || end.contentEnd < markup.length) i = end.end;
          }
          break;
        }
        out += rebuildTag(tag, scope, inline);
        if (!tag.selfClosing && local !== "style") open.push({ name: tag.name, namespaces });
        if (local === "style" && !tag.selfClosing) {
          const { contentEnd, end } = findEndTag(markup, tag.end, local);
          out += `${sanitiseStyleContent(markup.slice(tag.end, contentEnd), scope, inline)}</${tag.name}>`;
          i = end;
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Removes `<script>` and `<foreignObject>` (any prefix) wherever their text occurs — inside a CDATA section or a tag
 * name too, where `sanitiseMarkup` sees no element — self-closing, or with everything up to their end tag; a start
 * without an end tag is left. Removing one can join its surroundings into another (`<scr<script/>ipt>`): the
 * caller repeats until nothing changes.
 */
function dropElementFragments(markup: string): string {
  let out = "";
  let pos = 0;
  const noEndTag = new Set<string>();
  DROPPED_START.lastIndex = 0;
  for (let m = DROPPED_START.exec(markup); m; m = DROPPED_START.exec(markup)) {
    const name = m[1].toLowerCase();
    const tag = readTag(markup, m.index);
    let end = tag.closed && tag.selfClosing ? tag.end : -1;
    if (end < 0 && !noEndTag.has(name)) {
      DROPPED_END.lastIndex = tag.closed ? tag.end : m.index + m[0].length;
      for (let e = DROPPED_END.exec(markup); e; e = DROPPED_END.exec(markup)) {
        if (e[1].toLowerCase() === name) {
          end = e.index + e[0].length;
          break;
        }
      }
      if (end < 0) noEndTag.add(name);
    }
    if (end < 0) continue;
    out += markup.slice(pos, m.index);
    pos = end;
    DROPPED_START.lastIndex = end;
  }
  return out + markup.slice(pos);
}

/** Passes over the markup before it is given up as too tangled to clean: a file that is well-formed is stable after two. */
const MAX_PASSES = 64;
const TANGLED_WARNING = "markup too tangled to sanitise, dropped";

/**
 * The markup made safe: comments out, every tag rebuilt and the dropped elements removed (see `sanitiseMarkup`,
 * `dropElementFragments`), again and again until nothing changes, so that removing one thing cannot leave another
 * behind; then one more pass that carries ids, classes, references and style rules into `scope.idPrefix`'s namespace.
 */
function sanitise(markup: string, scope: Scope): string {
  for (let pass = 0; ; pass++) {
    if (pass === MAX_PASSES) {
      warn(scope, TANGLED_WARNING);
      return "";
    }
    const before = markup;
    markup = dropElementFragments(sanitiseMarkup(markup.replace(/<!--[\s\S]*?-->/g, ""), scope, false));
    if (markup === before) break;
  }
  return sanitiseMarkup(markup, scope, true);
}

/** What the nested `<svg>` that takes the root's place sets itself. */
const OWN_ROOT_ATTRIBUTES = new Set(["x", "y", "width", "height", "viewBox", "preserveAspectRatio", "xmlns", "id"]);

/**
 * The root `<svg>`'s attributes that are not the nested element's own (position, size, view box, default namespace,
 * id), as ` name="value"` text for the element that takes the root's place: namespace prefixes (` xmlns:xlink="…"`,
 * without which inlined `xlink:href` is not well-formed), and the presentation attributes the content inherits
 * (`fill`, `stroke`, `style`, `class`…). `class` and `url(#x)` references are carried into `idPrefix`'s namespace;
 * event attributes are dropped, and so are references out of the document (see `inlineSvg`), each with a warning.
 */
export function svgRootAttributes(text: string, idPrefix = "", warnings?: string[]): string {
  const root = parseRoot(text);
  if (!root) return "";
  const scope: Scope = { idPrefix, namespaces: new Map(), rootClasses: new Set(), warnings };
  let out = "";
  for (const { name, value } of root.tag.attributes) {
    if (OWN_ROOT_ATTRIBUTES.has(name) || /^on/i.test(name) || /["'<=]/.test(name) || XML_BASE.test(name)) continue;
    let carried: string;
    if (HREF_NAME.test(name)) {
      if (!isLocalRef(value)) {
        externalRemoved(scope, value);
        continue;
      }
      carried = value;
    } else {
      carried = prefixUrlRefs(dropExternalUrls(name === "class" ? prefixClasses(value, idPrefix) : value, scope), idPrefix);
    }
    out += ` ${name}="${carried.replace(/"/g, "&quot;")}"`;
  }
  return out;
}

/**
 * The root `<svg>`'s child markup, made safe to share a document with the figure and with other files. In
 * `idPrefix`'s namespace: every `id`, every reference to one (`url(#x)`, `href="#x"`, `xlink:href="#x"` or any
 * other prefix), every `class` name, and every `<style>` rule, which is also scoped to `#{idPrefix}root`, the id
 * the element that takes the root's place must carry. Dropped: the XML declaration, DOCTYPE (its entities are
 * expanded first), comments, `<script>` and `<foreignObject>` (under any prefix), `on…` attributes, and `<style>`
 * at-rules; every `href` (any prefix) and `url()` that leads out of the document (not `#…` or an image's `data:…`, so
 * `javascript:` too), the `href` dropped and the `url()` made `none`. `url()` is read in attribute values and
 * `<style>` text only, never in text content. At-rules and references out add a message to `warnings` (one per kind
 * or value), as does an entity expansion that stopped at its limit.
 */
export function inlineSvg(text: string, idPrefix: string, warnings?: string[]): string {
  const root = parseRoot(text);
  if (!root) return "";
  const scope: Scope = {
    idPrefix,
    namespaces: new Map([...declaredNamespaces(root.tag, new Map()), ["", SVG_NAMESPACE]]),
    rootClasses: new Set((attributesOf(root.tag).get("class") ?? "").split(/\s+/).filter(Boolean)),
    warnings,
  };
  if (root.capped) warn(scope, EXPANSION_CAPPED_WARNING);
  return sanitise(root.doc.slice(root.innerStart, root.innerEnd), scope).trim();
}
