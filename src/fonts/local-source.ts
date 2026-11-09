/**
 * The built-in `local` font source: the fonts installed on this computer, through `queryLocalFonts()` (spec §3, §8).
 *
 * Obsidian refuses `queryLocalFonts()` with `SecurityError: Page needs to be visible` while its window is hidden, so the
 * list is primed while the window is visible (at plugin load and on `visibilitychange`, see main.ts) and cached for the
 * session. Each face's bytes are read from the cached `FontData.blob()` when a face is found.
 */
import { FontLoadError, FontSourceUnavailableError, type FontSource, type FontStyle, type LoadedFace } from "../registry/font-source";
import { collectionFace, collectionFaceNames, collectionSize, faceNames, hasVariations, sfntFlavour } from "./sfnt";

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

type LocalFontQuery = () => Promise<readonly LocalFontData[]>;

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
const ALIAS_STYLES: Record<string, FontStyle> = { roman: "normal", book: "normal", plain: "normal" };

/**
 * The style a face's style name stands for, and how good a match it is (lower is better): the §3 names, then other
 * names for the regular face, then a heavier weight name that contains "Bold" (Semibold, ExtraBold…). Any other name
 * (Light, Medium, Condensed…) is no style.
 */
export function styleOf(name: string): { style: FontStyle; rank: number } | null {
  const key = fold(name);
  if (EXACT_STYLES[key]) return { style: EXACT_STYLES[key], rank: 0 };
  if (ALIAS_STYLES[key]) return { style: ALIAS_STYLES[key], rank: 1 };
  if (key.includes("bold")) return { style: /italic|oblique/.test(key) ? "bolditalic" : "bold", rank: 2 };
  return null;
}

const isBold = (style: FontStyle) => style === "bold" || style === "bolditalic";
const isItalic = (style: FontStyle) => style === "italic" || style === "bolditalic";
const combine = (a: FontStyle, b: FontStyle): FontStyle => {
  const bold = isBold(a) || isBold(b);
  const italic = isItalic(a) || isItalic(b);
  return bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "normal";
};

/** jsPDF's own TrueType parser, which (unlike `addFont`) throws on a font it cannot read (§8.8). Loaded lazily. */
async function trialParse(bytes: Uint8Array): Promise<void> {
  const { jsPDF } = await import("jspdf");
  (jsPDF as unknown as { API: { TTFFont: { open(data: Uint8Array): unknown } } }).API.TTFFont.open(bytes);
}

/** The face of a collection that `font` describes: by PostScript name, then by family and style. */
function pickCollectionFace(bytes: Uint8Array, font: LocalFontData): Uint8Array {
  const size = collectionSize(bytes);
  const names = Array.from({ length: size }, (_, i) => collectionFaceNames(bytes, i));
  let index = names.findIndex((n) => n.postscriptName && fold(n.postscriptName) === fold(font.postscriptName));
  if (index < 0) index = names.findIndex((n) => fold(n.family) === fold(font.family) && fold(n.subfamily) === fold(font.style));
  if (index < 0 && size === 1) index = 0;
  if (index < 0) throw new FontLoadError("unreadable", `no face of the collection is "${font.postscriptName}"`);
  return collectionFace(bytes, index);
}

/**
 * The standalone TrueType bytes of an installed face, and the style they really are: a variable face is only its
 * default style (§8.6), whatever named instance `font` describes. Not yet trial-parsed.
 */
async function readFace(font: LocalFontData): Promise<{ bytes: Uint8Array; style: FontStyle }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await (await font.blob()).arrayBuffer());
  } catch (error) {
    throw new FontLoadError("unreadable", `the font file could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const flavour = sfntFlavour(bytes);
    if (flavour === "cff") throw new FontLoadError("cff");
    if (flavour === "unknown") throw new FontLoadError("unreadable", "the font is not a TrueType font");
    const face = flavour === "collection" ? pickCollectionFace(bytes, font) : bytes;
    if (sfntFlavour(face) === "cff") throw new FontLoadError("cff");
    const style = hasVariations(face) ? (styleOf(faceNames(face).subfamily)?.style ?? "normal") : (styleOf(font.style)?.style ?? "normal");
    return { bytes: face, style };
  } catch (error) {
    if (error instanceof FontLoadError) throw error;
    throw new FontLoadError("unreadable", error instanceof Error ? error.message : String(error));
  }
}

export function localFontSource(query: LocalFontQuery = defaultQuery): LocalFontSource {
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

  /** The first of `candidates` whose bytes really are `style`, trial-parsed. */
  const firstOfStyle = async (candidates: LocalFontData[], style: FontStyle | null): Promise<{ bytes: Uint8Array; style: FontStyle } | null> => {
    for (const font of candidates) {
      const face = await readFace(font);
      if (style && face.style !== style) continue;
      try {
        await trialParse(face.bytes);
      } catch (error) {
        throw new FontLoadError("unreadable", `jsPDF could not parse the font: ${error instanceof Error ? error.message : String(error)}`);
      }
      return face;
    }
    return null;
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
        // A full or PostScript name (ArialMT, MyriadPro-Bold) names a face: use its family, and add its style.
        named = all.find((f) => fold(f.fullName) === key || fold(f.postscriptName) === key);
        if (!named) return null;
        const family = fold(named.family);
        faces = all.filter((f) => fold(f.family) === family);
        want = combine(styleOf(named.style)?.style ?? "normal", style);
      }
      const ofStyle = (s: FontStyle) =>
        faces
          .map((font, order) => ({ font, order, match: styleOf(font.style) }))
          .filter((c) => c.match?.style === s)
          // The named face first, then the better style name, then the list order.
          .sort((a, b) => Number(b.font === named) - Number(a.font === named) || a.match!.rank - b.match!.rank || a.order - b.order)
          .map((c) => c.font);
      const family = (named ?? faces[0]).family;

      const exact = await firstOfStyle(ofStyle(want), want);
      if (exact) return { bytes: exact.bytes, family, style: exact.style, exact: true };
      // The regular face stands in for a missing style; failing that, any face of the family (§8.6).
      const standIn = (want !== "normal" ? await firstOfStyle(ofStyle("normal"), "normal") : null) ?? (await firstOfStyle(faces, null));
      return standIn ? { bytes: standIn.bytes, family, style: standIn.style, exact: false } : null;
    },
  };
}
