/**
 * The PDF font pass (spec §4, §8): which installed faces a page SVG's text needs, and the PDF copy of that SVG made
 * ready for svg2pdf.js.
 *
 * svg2pdf.js 2.8.1 sets text in a family only when `pdf.getFontList()[family]` (exact, case-sensitive) has the style
 * key (normal/bold/italic/bolditalic, built only for weights 400/700). Otherwise a lower-cased alias (arial, verdana,
 * sans-serif → helvetica; serif, cursive, fantasy → times; monospace, fixed, terminal → courier) ends the search, and
 * with none of those the text is set in Times. So each face is registered under the exact string the SVG uses, weights
 * are rewritten to bold/normal, and only the faces the SVG's text really uses are returned, so a document registers
 * nothing it does not draw (§8.7).
 */
import type { jsPDF as JsPdf } from "jspdf";
import { cmapCovers } from "../fonts/sfnt";
import { findFace, type FindFaceReason, type FontSourceRegistry, type FontStyle, type LoadedFace } from "../registry/font-source";

/** A face to register on one jsPDF document. */
export interface RegisteredFace {
  /** The file name in jsPDF's virtual file system, with a six-letter tag (`ABCDEF+Name-style.ttf`). */
  vfsName: string;
  /**
   * The name svg2pdf.js looks the font up by: the exact family string the SVG uses, or for a family jsPDF would take as
   * one of its standard fonts (Helvetica, Times, Courier…), `<family>-Embedded`, which the PDF copy's runs are renamed to.
   */
  family: string;
  style: FontStyle;
  base64: string;
}

export interface Resolved {
  face: LoadedFace | null;
  reason?: FindFaceReason;
}

/** The face for one family name in one style. */
export type FaceResolver = (name: string, style: FontStyle) => Promise<Resolved>;

/** What names an element's owner in a warning: a text label's or a panel's `nodeLabel`, else the page. */
export type LabelOf = (el: Element) => string;

export const HIDDEN_WARNING = "installed fonts could not be read (Obsidian was not visible) — fonts substituted";

/** svg2pdf.js's aliases: a lower-cased family that ends its search, and the standard font it then uses. */
const SVG2PDF_ALIASES: Record<string, Standard> = {
  "sans-serif": "Helvetica",
  verdana: "Helvetica",
  arial: "Helvetica",
  fixed: "Courier",
  monospace: "Courier",
  terminal: "Courier",
  serif: "Times",
  cursive: "Times",
  fantasy: "Times",
};
type Standard = "Helvetica" | "Times" | "Courier";
/** jsPDF's own font-list keys with the four style keys; svg2pdf.js uses them as they are. */
const JSPDF_STANDARD: Record<string, Standard> = { helvetica: "Helvetica", times: "Times", courier: "Courier" };
/** The lower-cased names jsPDF must not be asked to look up: CSS generics and svg2pdf.js's aliases that are not real families. */
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "fixed", "terminal"]);
/**
 * Metric-compatible with the standard fonts: when not embedded they are set in those, with no warning (§8.4). The
 * PDF copy names the standard font's own key, since svg2pdf.js would set "Helvetica" and "Times New Roman" in Times.
 */
const STANDARD_TWINS: Record<string, Standard> = { arial: "Helvetica", helvetica: "Helvetica", "times new roman": "Times" };
const isTwin = (name: string) => Object.hasOwn(STANDARD_TWINS, name.toLowerCase());
/**
 * jsPDF's `getFont` tries the lower-cased name first, so a face registered as "Helvetica" (macOS installs one) would be
 * written but never drawn: the standard font wins. Such a face is registered under `<family>-Embedded` instead, and its
 * runs are renamed to that in the PDF copy.
 */
const JSPDF_KEYS = new Set(["helvetica", "times", "courier", "symbol", "zapfdingbats"]);
const registeredName = (family: string) => (JSPDF_KEYS.has(family.toLowerCase()) ? `${family}-Embedded` : family);

const REASONS: Record<Exclude<FindFaceReason, "unavailable">, string> = {
  missing: "not installed",
  cff: "has PostScript outlines (OTF/CFF)",
  unreadable: "could not be read",
};
const STYLE_WORDS: Record<FontStyle, string> = { normal: "regular", bold: "bold", italic: "italic", bolditalic: "bold italic" };

/**
 * A resolver over the registry's sources that remembers each answer, so one export asks for the same family and style
 * once however many documents and pages use it.
 */
export function faceResolver(registries: { fontSources: FontSourceRegistry }): FaceResolver {
  const cache = new Map<string, Promise<Resolved>>();
  return (name, style) => {
    const key = `${name}\u0000${style}`;
    let found = cache.get(key);
    if (!found) {
      found = findFace(registries, [name], style);
      cache.set(key, found);
    }
    return found;
  };
}

// ---- CSS bits ------------------------------------------------------------------------------------------------------

/** A `font-family` value as svg2pdf.js reads it: the names in order, quotes stripped, unquoted runs of space collapsed. */
export function parseFamilies(value: string): string[] {
  const names: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,]+))\s*(?:,|$)/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < value.length && (m = re.exec(value))) {
    const name = m[1] ?? m[2] ?? m[3].trim().replace(/\s+/g, " ");
    if (name !== "") names.push(name.replace(/\\(.)/g, "$1"));
    if (m[0] === "") break;
  }
  return names;
}

interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

/** A declaration list, with a `font` shorthand expanded into the longhands it sets (as the CSSOM svg2pdf.js reads does). */
function declarations(text: string): Declaration[] {
  return text.split(";").flatMap((part): Declaration[] => {
    const colon = part.indexOf(":");
    if (colon < 0) return [];
    const property = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    if (property === "") return [];
    if (property !== "font") return [{ property, value, important }];
    return (expandFont(value) ?? []).map(([p, v]) => ({ property: p, value: v, important }));
  });
}

const FONT_SIZE = /^(?:\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|%|mm|cm|in|q|vw|vh|vmin|vmax)|0|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/i;

/**
 * The longhands a `font` shorthand sets: `[style || variant || weight || stretch] size[/line-height] family`. Style
 * and weight are reset to normal when the shorthand does not give them. Null for a value that is not one (a system
 * font such as `caption`).
 */
export function expandFont(value: string): [string, string][] | null {
  // "10px / 1.2" becomes the one token "10px/1.2".
  const tokens = value.trim().replace(/\s*\/\s*/, "/").split(/\s+/);
  const sizeAt = tokens.findIndex((t) => FONT_SIZE.test(t.split("/")[0]));
  if (sizeAt < 0) return null;
  let style = "normal";
  let weight = "normal";
  for (const token of tokens.slice(0, sizeAt).map((t) => t.toLowerCase())) {
    if (token === "italic" || token === "oblique") style = token;
    else if (token === "bold" || token === "bolder" || token === "lighter" || /^\d+(\.\d+)?$/.test(token)) weight = token;
  }
  const [size, lineHeight] = tokens[sizeAt].split("/");
  const rest = tokens.slice(sizeAt + 1);
  const family = rest.join(" ").trim();
  if (family === "") return null;
  const longhands: [string, string][] = [["font-style", style], ["font-weight", weight], ["font-size", size]];
  if (lineHeight) longhands.push(["line-height", lineHeight]);
  longhands.push(["font-family", family]);
  return longhands;
}

interface Rule {
  selector: string;
  specificity: number;
  order: number;
  declarations: Declaration[];
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Roughly a selector's CSS specificity: ids, then classes, attributes and pseudo-classes, then element names. */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/** The plain style rules of some `<style>` text (one per selector of a list). At-rules' own blocks are not read. */
function parseRules(css: string, start: number): Rule[] {
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(css)))) {
    const decls = declarations(m[2]);
    if (decls.length === 0) continue;
    for (const selector of m[1].split(",").map((s) => s.trim())) {
      if (selector === "" || selector.startsWith("@")) continue;
      rules.push({ selector, specificity: specificity(selector), order: start + rules.length, declarations: decls });
    }
  }
  return rules;
}

const FONT_FAMILY_RE = /font-family\s*:\s*([^;}]+)/gi;
/** A `font` shorthand declaration in CSS text (not `font-family` and the like). */
const FONT_SHORTHAND_RE = /(^|[;{\s])font\s*:\s*([^;}]+)/gi;

/** The font-family values of CSS declarations, the `font` shorthand's included. */
function familyValues(css: string): string[] {
  const values = [...css.matchAll(FONT_FAMILY_RE)].map((m) => m[1]);
  for (const m of css.matchAll(FONT_SHORTHAND_RE)) {
    const family = expandFont(m[2].replace(/!\s*important\s*$/i, ""))?.find(([p]) => p === "font-family");
    if (family) values.push(family[1]);
  }
  return values;
}

/**
 * The font-family lists of an SVG, in document order of attributes and inline styles, then `<style>` rules: each list's
 * names unquoted, generic names kept in their place.
 */
export function usedFamilies(svg: string): string[][] {
  const lists: string[][] = [];
  const add = (value: string) => {
    const names = parseFamilies(value.replace(/!\s*important\s*$/i, ""));
    if (names.length > 0) lists.push(names);
  };
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const body = svg.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  for (const m of body.matchAll(/\s(font-family|style)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const value = decode(m[3] ?? m[4] ?? "");
    if (m[1] === "font-family") add(value);
    else for (const family of familyValues(value)) add(family);
  }
  for (const m of svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = stripComments(m[1].replace(/<!\[CDATA\[|\]\]>/g, ""));
    for (const family of familyValues(css)) add(family);
  }
  return lists;
}

// ---- Weights (§8.3) ------------------------------------------------------------------------------------------------

/** A weight as svg2pdf.js can key it: ≥ 600 and `bolder` are bold, every other weight normal. Others are kept. */
function weightKeyword(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === "bold" || v === "normal") return v;
  if (v === "bolder") return "bold";
  if (v === "lighter") return "normal";
  const n = Number(v);
  if (v !== "" && Number.isFinite(n)) return n >= 600 ? "bold" : "normal";
  return value;
}

const WEIGHT_DECL_RE = /(font-weight\s*:\s*)([^;}!]+?)(\s*(?:!\s*important\s*)?(?:;|}|$))/gi;
/**
 * CSS text with each `font` shorthand written out as its longhands, which every reader understands, and each weight
 * as a keyword svg2pdf.js can key.
 */
function rewriteFontDecls(css: string): string {
  const expanded = css.replace(FONT_SHORTHAND_RE, (all, lead: string, value: string) => {
    const important = /!\s*important\s*$/i.test(value) ? " !important" : "";
    const longhands = expandFont(value.replace(/!\s*important\s*$/i, ""));
    const trailing = /\s*$/.exec(value)?.[0] ?? "";
    return longhands ? `${lead}${longhands.map(([p, v]) => `${p}: ${v}${important}`).join("; ")}${trailing}` : all;
  });
  return expanded.replace(WEIGHT_DECL_RE, (all, head: string, value: string, tail: string) => `${head}${weightKeyword(value)}${tail}`);
}

/** Rewrites the weights (and `font` shorthands) in attributes, inline styles and `<style>` text; true when anything changed. */
function rewriteWeights(root: Element): boolean {
  let changed = false;
  const set = (el: Element, name: string, value: string) => {
    if (el.getAttribute(name) === value) return;
    el.setAttribute(name, value);
    changed = true;
  };
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    const weight = el.getAttribute("font-weight");
    if (weight !== null) set(el, "font-weight", weightKeyword(weight));
    const style = el.getAttribute("style");
    if (style !== null && /font/i.test(style)) set(el, "style", rewriteFontDecls(style));
    if (el.localName === "style" && el.textContent && /font/i.test(el.textContent)) {
      const css = rewriteFontDecls(el.textContent);
      if (css !== el.textContent) {
        el.textContent = css;
        changed = true;
      }
    }
  }
  return changed;
}

// ---- Computed font of an element -----------------------------------------------------------------------------------

/** The value svg2pdf.js reads for `property` on `el` itself: inline style, then the most specific matching rule, then the attribute. */
function ownValue(el: Element, property: string, rules: Rule[]): string | undefined {
  const inline = el.getAttribute("style");
  if (inline) {
    const decl = declarations(inline).filter((d) => d.property === property).pop();
    if (decl && decl.value !== "") return decl.value;
  }
  let best: { rule: Rule; decl: Declaration } | undefined;
  for (const rule of rules) {
    const decl = rule.declarations.filter((d) => d.property === property).pop();
    if (!decl) continue;
    let matches = false;
    try {
      matches = el.matches(rule.selector);
    } catch {
      // A selector the DOM cannot read matches nothing, as for svg2pdf.js.
    }
    if (!matches) continue;
    if (
      !best ||
      Number(decl.important) - Number(best.decl.important) > 0 ||
      (decl.important === best.decl.important && (rule.specificity > best.rule.specificity || (rule.specificity === best.rule.specificity && rule.order > best.rule.order)))
    ) {
      best = { rule, decl };
    }
  }
  if (best) return best.decl.value;
  return el.getAttribute(property) ?? undefined;
}

/** The inherited value of `property` for `el`: its own, else its nearest ancestor's. */
function computed(el: Element, property: string, rules: Rule[]): string | undefined {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = ownValue(node, property, rules);
    if (value !== undefined && value.trim().toLowerCase() !== "inherit") return value;
  }
  return undefined;
}

/** The nearest element, `el` or an ancestor, that sets `font-family` itself. */
function declaringElement(el: Element, rules: Rule[]): Element | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = ownValue(node, "font-family", rules);
    if (value !== undefined && value.trim().toLowerCase() !== "inherit") return node;
  }
  return null;
}

/** The style key svg2pdf.js builds for an element, or null for one it cannot match (an oblique bold, say). */
function styleKey(el: Element, rules: Rule[]): FontStyle | null {
  const weight = (computed(el, "font-weight", rules) ?? "normal").trim().toLowerCase();
  const slant = (computed(el, "font-style", rules) ?? "normal").trim().toLowerCase();
  const bold = weight === "bold" || weight === "700";
  if (!bold && weight !== "normal" && weight !== "400") return null;
  if (slant === "italic") return bold ? "bolditalic" : "italic";
  if (bold && slant !== "normal") return null;
  return bold ? "bold" : "normal";
}

// ---- Resolution ----------------------------------------------------------------------------------------------------

/** How svg2pdf.js will set one family list in one style, once the faces found are registered. */
type Outcome =
  | { kind: "embedded"; family: string; face: LoadedFace; first: Failure | null }
  | { kind: "standard"; font: Standard; first: Failure | null; twin?: boolean };

/** Why the list's first family is not what the text is set in. */
interface Failure {
  name: string;
  reason: FindFaceReason;
}

async function resolveList(names: string[], style: FontStyle, resolve: FaceResolver): Promise<Outcome> {
  let first: Failure | null = null;
  for (const [index, name] of names.entries()) {
    const lower = name.toLowerCase();
    // jsPDF's own font-list keys (lower case) are found as they are; a generic name ends the search with its alias.
    if (JSPDF_STANDARD[name]) return { kind: "standard", font: JSPDF_STANDARD[name], first };
    if (!GENERIC.has(lower)) {
      const { face, reason } = await resolve(name, style);
      // A twin of a standard font is set in that font rather than in a stand-in for a missing style.
      if (face && (face.exact || !isTwin(lower))) return { kind: "embedded", family: name, face, first };
      if (index === 0 && !face) first = { name, reason: reason ?? "missing" };
      if (isTwin(lower)) return { kind: "standard", font: STANDARD_TWINS[lower], first, twin: true };
    }
    if (SVG2PDF_ALIASES[lower]) return { kind: "standard", font: SVG2PDF_ALIASES[lower], first };
  }
  return { kind: "standard", font: "Times", first };
}

// ---- Fallback for missing characters (§8.2) ------------------------------------------------------------------------

const SERIF_NAMES = /\b(serif|times|georgia|garamond|cambria|palatino|baskerville|bodoni|didot|caslon|minion|century|constantia|book antiqua|charter|hoefler|perpetua|rockwell|sabon|utopia|libertin|merriweather|playfair|lora|crimson|source serif|noto serif|pt serif|dejavu serif|liberation serif|droid serif|bookman|goudy|cochin|big caslon|iowan|new york)\b/i;

/** The standard font a face falls back to: Times for a serif face (by its OS/2 PANOSE serif style, else its name), else Helvetica. */
function fallbackFor(family: string, bytes: Uint8Array): Standard {
  if (/sans/i.test(family)) return "Helvetica";
  const panose = panoseSerif(bytes);
  if (panose !== null) return panose ? "Times" : "Helvetica";
  return SERIF_NAMES.test(family) ? "Times" : "Helvetica";
}

/** True for a serif PANOSE (Latin text, serif style 2–10), false for sans (11–13), null when the font does not say. */
function panoseSerif(bytes: Uint8Array): boolean | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const record = 12 + 16 * i;
      if (String.fromCharCode(...bytes.subarray(record, record + 4)) !== "OS/2") continue;
      const offset = view.getUint32(record + 8);
      if (offset + 34 > bytes.length || bytes[offset + 32] !== 2) return null;
      const serif = bytes[offset + 33];
      if (serif >= 2 && serif <= 10) return true;
      if (serif >= 11 && serif <= 13) return false;
      return null;
    }
  } catch {
    // A font too short to say.
  }
  return null;
}

const coverage = new WeakMap<Uint8Array, (codePoint: number) => boolean>();
function missingIn(face: LoadedFace, text: string): string[] {
  let covers = coverage.get(face.bytes);
  if (!covers) {
    try {
      covers = cmapCovers(face.bytes);
    } catch {
      covers = () => false;
    }
    coverage.set(face.bytes, covers);
  }
  const missing: string[] = [];
  for (const char of text) if (!missing.includes(char) && !covers(char.codePointAt(0)!)) missing.push(char);
  return missing;
}

/**
 * The characters above Latin-1 that WinAnsiEncoding has (cp1252's 0x80–0x9F). A standard font can draw these and every
 * character U+0020–U+00FF; for a string with any other character, jsPDF writes the whole string as UTF-16 into the
 * one-byte font, which garbles all of it.
 */
const WIN_ANSI_EXTRA = new Set("\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178");
const inWinAnsi = (char: string) => {
  const code = char.codePointAt(0)!;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char);
};
/** What a standard font cannot draw is shown as this. */
const NOT_IN_WIN_ANSI = "?";

/** Replaces, in the text nodes under `el`, each character a standard font cannot encode with "?"; the characters replaced. */
function toWinAnsi(el: Element): string[] {
  const replaced: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    let out = "";
    for (const char of value) {
      // Line breaks and tabs are white space to svg2pdf.js, not characters it draws.
      if (inWinAnsi(char) || /[\t\n\r]/.test(char)) out += char;
      else {
        out += NOT_IN_WIN_ANSI;
        if (!replaced.includes(char)) replaced.push(char);
      }
    }
    if (out !== value) node.nodeValue = out;
  }
  return replaced;
}

/** Sets `font-family` in an element's inline style, which wins over every other source in svg2pdf.js. */
function setInlineFamily(el: Element, family: string): void {
  const kept = declarations(el.getAttribute("style") ?? "").filter((d) => d.property !== "font-family");
  el.setAttribute("style", [...kept.map((d) => `${d.property}: ${d.value}${d.important ? " !important" : ""}`), `font-family: ${family}`].join("; "));
}

// ---- The pass ------------------------------------------------------------------------------------------------------

/** The characters an element draws itself (its own text nodes), with line breaks and tabs as spaces; "" for whitespace only. */
function ownText(el: Element): string {
  let text = "";
  for (const child of Array.from(el.childNodes)) if (child.nodeType === 3) text += (child.nodeValue ?? "").replace(/[\t\n\r]/g, " ");
  return /^ *$/.test(text) ? "" : text;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A six-letter tag that is the same for the same family and style. */
function tagOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.imul(hash ^ (i + 1), 0x01000193) >>> 0;
  }
  return tag;
}

const encoded = new WeakMap<Uint8Array, string>();
function registeredFace(family: string, style: FontStyle, face: LoadedFace): RegisteredFace {
  let data = encoded.get(face.bytes);
  if (data === undefined) {
    data = base64(face.bytes);
    encoded.set(face.bytes, data);
  }
  return { vfsName: `${tagOf(`${family}\u0000${style}`)}+${family.replace(/[^A-Za-z0-9]/g, "")}-${style}.ttf`, family, style, base64: data };
}

const prefixed = (label: string, warning: string) => (label === "" ? warning : `${label}: ${warning}`);

/**
 * The PDF copy of a page SVG and the faces its text needs. Weights are rewritten to bold/normal (§8.3); each text
 * run's family list is resolved to the first face a source has, registered under the SVG's exact string (§8.3); a
 * `<text>` with a character its face lacks is set whole in Helvetica or Times instead (§8.2). An SVG with nothing to
 * change comes back as the same string, so a document with no custom fonts draws as it always did (§8.7).
 */
export async function prepareFonts(svg: string, resolve: FaceResolver, labelOf: LabelOf = () => ""): Promise<{ svg: string; faces: RegisteredFace[]; warnings: string[] }> {
  const unchanged = { svg, faces: [], warnings: [] };
  if (!/font-(family|weight)|font\s*:/i.test(svg) || typeof DOMParser === "undefined") return unchanged;
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed?.documentElement;
  if (!root || typeof root.querySelectorAll !== "function" || parsed.getElementsByTagName("parsererror").length > 0) return unchanged;

  let changed = rewriteWeights(root);
  const rules = Array.from(root.querySelectorAll("style")).flatMap((style, i) => parseRules(style.textContent ?? "", i * 100000));

  const faces = new Map<string, RegisteredFace>();
  const warnings: string[] = [];
  const warn = (warning: string) => {
    if (!warnings.includes(warning)) warnings.push(warning);
  };

  for (const text of Array.from(root.querySelectorAll("text"))) {
    const runs: { el: Element; chars: string; style: FontStyle; family: string; outcome: Outcome }[] = [];
    for (const el of [text, ...Array.from(text.querySelectorAll("tspan"))]) {
      const chars = ownText(el);
      if (chars === "") continue;
      const style = styleKey(el, rules);
      const family = computed(el, "font-family", rules);
      if (style === null || family === undefined) continue;
      runs.push({ el, chars, style, family, outcome: await resolveList(parseFamilies(family), style, resolve) });
    }
    let named: string | undefined;
    const label = () => (named ??= labelOf(text));

    // A face that lacks a character would cut the string there (jsPDF), so the whole text is set in a standard font.
    const lacking = runs
      .map((run) => (run.outcome.kind === "embedded" ? { run, family: run.outcome.family, face: run.outcome.face, missing: missingIn(run.outcome.face, run.chars) } : null))
      .filter((r) => r !== null && r.missing.length > 0);
    if (lacking.length > 0) {
      const fallback = fallbackFor(lacking[0]!.family, lacking[0]!.face.bytes);
      for (const el of [text, ...Array.from(text.querySelectorAll("tspan"))]) setInlineFamily(el, fallback.toLowerCase());
      // The standard font encodes only WinAnsi: anything else is shown as "?" (and said), not left to garble the string.
      const shownAs = toWinAnsi(text);
      const lost = shownAs.length > 0 ? `; "${shownAs.join(", ")}" shown as ${NOT_IN_WIN_ANSI}` : "";
      changed = true;
      const byFamily = new Map<string, string[]>();
      for (const l of lacking) byFamily.set(l!.family, [...new Set([...(byFamily.get(l!.family) ?? []), ...l!.missing])]);
      for (const [family, missing] of byFamily) warn(`font "${family}" lacks "${missing.join(", ")}" — ${label()} set in ${fallback} in PDF${lost}`);
      continue;
    }

    for (const { el, style, family: list, outcome } of runs) {
      const used = outcome.kind === "embedded" ? outcome.family : outcome.font;
      const { first } = outcome;
      // The hidden window is said once for the whole export, even for Arial; a twin that is simply missing is not (§8.4).
      if (first?.reason === "unavailable") warn(HIDDEN_WARNING);
      else if (first && !isTwin(first.name)) warn(prefixed(label(), `font "${first.name}" ${REASONS[first.reason]} — ${used} used in PDF`));
      if (outcome.kind !== "embedded") {
        // A twin not embedded is named by the standard font's own key, on the run itself, so svg2pdf.js finds it.
        if (outcome.twin) {
          setInlineFamily(el, outcome.font.toLowerCase());
          changed = true;
        }
        continue;
      }
      const { family, face } = outcome;
      const name = registeredName(family);
      // svg2pdf.js resolves a family on the element that declares it, in that element's style; a run that inherits
      // it in another style would be set in Times. The run gets the family itself, to resolve in its own style.
      // A face registered under another name gets that name on the run itself.
      const declarer = declaringElement(el, rules);
      if (name !== family) {
        setInlineFamily(el, name);
        changed = true;
      } else if (declarer && declarer !== el && styleKey(declarer, rules) !== style) {
        setInlineFamily(el, list);
        changed = true;
      }
      if (!face.exact) warn(prefixed(label(), `font "${family}" has no ${STYLE_WORDS[style]} face — ${STYLE_WORDS[face.style]} used`));
      const key = `${name}\u0000${style}`;
      if (!faces.has(key)) faces.set(key, registeredFace(name, style, face));
    }
  }

  return { svg: changed ? new XMLSerializer().serializeToString(root) : svg, faces: [...faces.values()], warnings };
}

/** Puts the faces in a jsPDF document's virtual file system and registers each under its family and style (Identity-H). */
export function registerFaces(pdf: JsPdf, faces: RegisteredFace[]): void {
  for (const face of faces) {
    pdf.addFileToVFS(face.vfsName, face.base64);
    pdf.addFont(face.vfsName, face.family, face.style, "Identity-H");
  }
}

/** The faces of several SVGs drawn in one document, each family and style once. */
export function mergeFaces(lists: RegisteredFace[][]): RegisteredFace[] {
  const merged = new Map<string, RegisteredFace>();
  for (const face of lists.flat()) if (!merged.has(`${face.family}\u0000${face.style}`)) merged.set(`${face.family}\u0000${face.style}`, face);
  return [...merged.values()];
}
