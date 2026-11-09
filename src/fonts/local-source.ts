/**
 * The built-in `local` font source: the fonts installed on this computer, through `queryLocalFonts()` (spec §3, §8).
 *
 * Obsidian refuses `queryLocalFonts()` with `SecurityError: Page needs to be visible` while its window is hidden, so the
 * list is primed while the window is visible (at plugin load and on `visibilitychange`, see main.ts) and cached for the
 * session. Each face's bytes are read from the cached `FontData.blob()` when a face is found.
 */
import { FontLoadError, FontSourceUnavailableError, type FontSource, type FontStyle, type LoadedFace } from "../registry/font-source";
import { collectionFace, collectionFaceNames, collectionFaceTables, collectionSize, faceNames, hasTable, hasVariations, sfntFlavour } from "./sfnt";

/** The parts of the Local Font Access API's `FontData` this source uses. */
export interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

export interface LocalFontSource extends FontSource {
  /** Queries the installed fonts unless the list is already cached. False when the query was refused. */
  prime(): Promise<boolean>;
}

export interface LocalFontOptions {
  /** Faces larger than this are refused as unreadable (default 50 MB), so a huge font is never read into a PDF. */
  maxFaceBytes?: number;
}

type LocalFontQuery = () => Promise<readonly LocalFontData[]>;

const MAX_FACE_BYTES = 50 * 1024 * 1024;
/** Colour-bitmap tables (Apple Color Emoji's `sbix`, Noto Color Emoji's `CBDT`): jsPDF would embed outlines-less glyphs. */
const BITMAP_TABLES = ["sbix", "CBDT"];

/** `window.queryLocalFonts()`, or an empty list where the API does not exist. */
const defaultQuery: LocalFontQuery = async () => {
  const host = globalThis as { queryLocalFonts?: () => Promise<readonly LocalFontData[]> };
  return typeof host.queryLocalFonts === "function" ? host.queryLocalFonts() : [];
};

const fold = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

const EXACT_STYLES: Record<string, FontStyle> = {
  regular: "normal",
  normal: "normal",
  bold: "bold",
  italic: "italic",
  oblique: "italic",
  "bold italic": "bolditalic",
  "bold oblique": "bolditalic",
};
const ALIAS_STYLES: Record<string, FontStyle> = {
  roman: "normal",
  book: "normal",
  plain: "normal",
  "regular italic": "italic",
  "book italic": "italic",
  "roman italic": "italic",
};

/**
 * The style a face's style name stands for, and how good a match it is (lower is better): the §3 names; other names for
 * the regular and italic faces; Semibold/Demibold; then any other name that contains "Bold" (ExtraBold, Bold
 * Condensed…). Any other name (Light, Medium, Condensed…) is none of the four styles.
 */
export function styleOf(name: string): { style: FontStyle; rank: number } | null {
  const key = fold(name);
  if (EXACT_STYLES[key]) return { style: EXACT_STYLES[key], rank: 0 };
  if (ALIAS_STYLES[key]) return { style: ALIAS_STYLES[key], rank: 1 };
  if (!key.includes("bold")) return null;
  const style: FontStyle = /italic|oblique/.test(key) ? "bolditalic" : "bold";
  return { style, rank: /^(semi|demi)[ -]?bold( (italic|oblique))?$/.test(key) ? 2 : 3 };
}

/** The CSS weight a style name implies (400 when it names none). */
function weightOf(name: string): number {
  const key = fold(name).replace(/[\s-]/g, "");
  if (/thin|hairline/.test(key)) return 100;
  if (/(extra|ultra)light/.test(key)) return 200;
  if (/light/.test(key)) return 300;
  if (/(semi|demi)bold/.test(key)) return 600;
  if (/(extra|ultra)bold/.test(key)) return 800;
  if (/black|heavy/.test(key)) return 900;
  if (/bold/.test(key)) return 700;
  if (/medium/.test(key)) return 500;
  return 400;
}

const isBold = (style: FontStyle) => style === "bold" || style === "bolditalic";
const isItalic = (style: FontStyle) => style === "italic" || style === "bolditalic";
const styleFrom = (bold: boolean, italic: boolean): FontStyle => (bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "normal");
const combine = (a: FontStyle, b: FontStyle) => styleFrom(isBold(a) || isBold(b), isItalic(a) || isItalic(b));
const slanted = (name: string) => /italic|oblique/.test(fold(name));
const WIDTHS = /condensed|narrow|compressed|extended|expanded|wide/;

/** The nearest of the four styles to any style name: "Light Italic" is italic, "Black" is bold. */
const looseStyle = (name: string): FontStyle => styleOf(name)?.style ?? styleFrom(weightOf(name) >= 600, slanted(name));

/**
 * How well a face named `name` stands in for `want` (lower is better): the right slant and boldness, normal width, and
 * the weight nearest 400 (or 700), preferring the heavier on a tie (Medium over Light).
 */
function standInCost(name: string, want: FontStyle): number {
  const weight = weightOf(name);
  const target = isBold(want) ? 700 : 400;
  let cost = (Math.abs(weight - target) / 100) * 2 + (weight < target ? 1 : 0);
  if (weight >= 600 !== isBold(want)) cost += 20;
  if (slanted(name) !== isItalic(want)) cost += 20;
  if (WIDTHS.test(fold(name))) cost += 100;
  return cost;
}

/** jsPDF's own TrueType parser, which (unlike `addFont`) throws on a font it cannot read (§8.8). Loaded lazily. */
async function trialParse(bytes: Uint8Array): Promise<void> {
  const { jsPDF } = await import("jspdf");
  (jsPDF as unknown as { API: { TTFFont: { open(data: Uint8Array): unknown } } }).API.TTFFont.open(bytes);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The face of a collection that `font` describes (by PostScript name, then family and style), checked and extracted. */
function pickCollectionFace(bytes: Uint8Array, font: LocalFontData, maxFaceBytes: number): Uint8Array {
  const size = collectionSize(bytes);
  const names = Array.from({ length: size }, (_, i) => {
    try {
      return collectionFaceNames(bytes, i);
    } catch {
      return null; // a broken face must not hide the others
    }
  });
  let index = names.findIndex((n) => n?.postscriptName && fold(n.postscriptName) === fold(font.postscriptName));
  if (index < 0) index = names.findIndex((n) => n && fold(n.family) === fold(font.family) && fold(n.subfamily) === fold(font.style));
  if (index < 0 && size === 1) index = 0;
  if (index < 0) throw new FontLoadError("unreadable", `no face of the collection is "${font.postscriptName}"`);
  const tables = collectionFaceTables(bytes, index);
  if (tables.some((t) => BITMAP_TABLES.includes(t.tag))) throw new FontLoadError("unreadable", "the font has colour bitmap glyphs");
  if (tables.reduce((sum, t) => sum + t.data.length, 0) > maxFaceBytes) throw new FontLoadError("unreadable", "the font is too large");
  return collectionFace(bytes, index);
}

/**
 * The standalone TrueType bytes of an installed face, and the style they really are: a variable face is only its
 * default style (§8.6), whatever named instance `font` describes. Not yet trial-parsed.
 */
async function readFace(font: LocalFontData, maxFaceBytes: number): Promise<{ bytes: Uint8Array; style: FontStyle }> {
  let bytes: Uint8Array;
  try {
    const blob = await font.blob();
    // A collection may be larger than the limit while each face is not; its faces are checked once it is read.
    if (blob.size > maxFaceBytes && sfntFlavour(new Uint8Array(await blob.slice(0, 4).arrayBuffer())) !== "collection") {
      throw new FontLoadError("unreadable", "the font is too large");
    }
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    if (error instanceof FontLoadError) throw error;
    throw new FontLoadError("unreadable", `the font file could not be read: ${message(error)}`);
  }
  try {
    const flavour = sfntFlavour(bytes);
    if (flavour === "cff") throw new FontLoadError("cff");
    if (flavour === "unknown") throw new FontLoadError("unreadable", "the font is not a TrueType font");
    let face = bytes;
    if (flavour === "collection") face = pickCollectionFace(bytes, font, maxFaceBytes);
    else if (BITMAP_TABLES.some((tag) => hasTable(face, tag))) throw new FontLoadError("unreadable", "the font has colour bitmap glyphs");
    if (sfntFlavour(face) === "cff") throw new FontLoadError("cff");
    const style = looseStyle(hasVariations(face) ? faceNames(face).subfamily : font.style);
    return { bytes: face, style };
  } catch (error) {
    if (error instanceof FontLoadError) throw error;
    throw new FontLoadError("unreadable", message(error));
  }
}

export function localFontSource(query: LocalFontQuery = defaultQuery, options: LocalFontOptions = {}): LocalFontSource {
  const maxFaceBytes = options.maxFaceBytes ?? MAX_FACE_BYTES;
  let fonts: readonly LocalFontData[] | null = null;
  let pending: Promise<boolean> | null = null;

  const prime = (): Promise<boolean> => {
    if (fonts) return Promise.resolve(true);
    pending ??= (async () => {
      try {
        fonts = [...(await query())];
        return true;
      } catch {
        return false;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const installed = async (): Promise<readonly LocalFontData[]> => {
    if (!(await prime()) || !fonts) throw new FontSourceUnavailableError("installed fonts could not be read (Obsidian was not visible)");
    return fonts;
  };

  return {
    id: "local",
    name: "Installed fonts",
    prime,

    async list() {
      const seen = new Set<string>();
      const families: string[] = [];
      for (const font of await installed()) {
        if (seen.has(fold(font.family))) continue;
        seen.add(fold(font.family));
        families.push(font.family);
      }
      return families;
    },

    async find(name, style): Promise<LoadedFace | null> {
      const all = await installed();
      const key = fold(name);
      let faces = all.filter((f) => fold(f.family) === key);
      let want = style;
      let named: LocalFontData | undefined;
      if (faces.length === 0) {
        // A full or PostScript name (ArialMT, MyriadPro-Light) names a face: use its family, and add its style.
        named = all.find((f) => fold(f.fullName) === key || fold(f.postscriptName) === key);
        if (!named) return null;
        const family = fold(named.family);
        faces = all.filter((f) => fold(f.family) === family);
        want = combine(looseStyle(named.style), style);
      }
      const family = (named ?? faces[0]).family;

      // A bad face (CFF, unreadable) is skipped; its error is thrown only if no face works.
      let firstError: FontLoadError | undefined;
      const tried = new Set<LocalFontData>();
      const firstOf = async (candidates: LocalFontData[], only: FontStyle | null) => {
        for (const font of candidates) {
          if (tried.has(font)) continue;
          try {
            const face = await readFace(font, maxFaceBytes);
            if (only && face.style !== only) continue; // e.g. a variable font's named instance; it may still stand in
            tried.add(font);
            try {
              await trialParse(face.bytes);
            } catch (error) {
              throw new FontLoadError("unreadable", `jsPDF could not parse the font: ${message(error)}`);
            }
            return face;
          } catch (error) {
            tried.add(font);
            firstError ??= error instanceof FontLoadError ? error : new FontLoadError("unreadable", message(error));
          }
        }
        return null;
      };

      // Faces that are exactly `s`. A named face whose style is none of the four (Light, Medium) is exact only as itself.
      const ofStyle = (s: FontStyle) => {
        if (named && !styleOf(named.style)) return looseStyle(named.style) === s ? [named] : [];
        return faces
          .map((font, order) => ({ font, order, match: styleOf(font.style) }))
          .filter((c) => c.match?.style === s)
          .sort((a, b) => Number(b.font === named) - Number(a.font === named) || a.match!.rank - b.match!.rank || a.order - b.order)
          .map((c) => c.font);
      };
      const bySuitability = faces
        .map((font, order) => ({ font, order, cost: standInCost(font.style, want) }))
        .sort((a, b) => a.cost - b.cost || a.order - b.order)
        .map((c) => c.font);

      const exact = await firstOf(ofStyle(want), want);
      if (exact) return { bytes: exact.bytes, family, style: exact.style, exact: true };
      // A stand-in: the named face itself; else the regular face (§8.6); else the family's most suitable face.
      const standIn =
        (named ? await firstOf([named], null) : null) ??
        (want !== "normal" ? await firstOf(ofStyle("normal"), "normal") : null) ??
        (await firstOf(bySuitability, null));
      if (standIn) return { bytes: standIn.bytes, family, style: standIn.style, exact: false };
      if (firstError) throw firstError;
      return null;
    },
  };
}
