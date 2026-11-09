/** The four styles a PDF font is registered under (jsPDF's and svg2pdf's keys). */
export type FontStyle = "normal" | "bold" | "italic" | "bolditalic";

/** One face a source found, ready for jsPDF. */
export interface LoadedFace {
  /** A standalone TrueType font (a collection's face is extracted first). */
  bytes: Uint8Array;
  family: string;
  /** The face's own style; with `exact` false this is the stand-in's style, not the one asked for. */
  style: FontStyle;
  /** False when another face (the regular one) stands in for the style asked for. */
  exact: boolean;
}

/** Why a source has the font but cannot give it: CFF (PostScript) outlines, or bytes jsPDF cannot parse. */
export class FontLoadError extends Error {
  constructor(
    readonly reason: "cff" | "unreadable",
    message?: string,
  ) {
    super(message ?? (reason === "cff" ? "the font has PostScript (CFF) outlines" : "the font could not be read"));
    this.name = "FontLoadError";
  }
}

/** The source cannot list its fonts right now (for `local`: `queryLocalFonts()` refused while Obsidian was hidden). */
export class FontSourceUnavailableError extends Error {
  constructor(message = "the font source is not available") {
    super(message);
    this.name = "FontSourceUnavailableError";
  }
}

export interface FontSource {
  id: string;
  name: string;
  /** The family names the source has. Throws `FontSourceUnavailableError` when it cannot list them now. */
  list(): Promise<string[]>;
  /**
   * The face for `name` (a family, full name or PostScript name, case-insensitively) in `style`; null when the source
   * does not have it. Throws `FontLoadError` when it has the font but cannot use it, and `FontSourceUnavailableError`
   * when it cannot look.
   */
  find(name: string, style: FontStyle): Promise<LoadedFace | null>;
}

export class FontSourceRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly sources = new Map<string, FontSource>();

  register(s: FontSource): void {
    this.sources.set(s.id, s);
  }

  get(id: string): FontSource | undefined {
    return this.sources.get(id);
  }

  all(): FontSource[] {
    return [...this.sources.values()];
  }
}

export type FindFaceReason = "missing" | "cff" | "unreadable" | "unavailable";

/**
 * The first face any source gives for `names` (a font-family list, in order) in `style`. Each name is asked of every
 * source in registry order before the next name is tried, as CSS does. With no face, the reason is the first load
 * error a source gave (the font is there but unusable), else "unavailable" if a source could not look, else "missing".
 * Any other error from a source counts as "unreadable".
 */
export async function findFace(
  registries: { fontSources: FontSourceRegistry },
  names: string[],
  style: FontStyle,
): Promise<{ face: LoadedFace | null; reason?: FindFaceReason }> {
  let loadError: "cff" | "unreadable" | undefined;
  let unavailable = false;
  for (const name of names) {
    for (const source of registries.fontSources.all()) {
      try {
        const face = await source.find(name, style);
        if (face) return { face };
      } catch (error) {
        if (error instanceof FontSourceUnavailableError) unavailable = true;
        else loadError ??= error instanceof FontLoadError ? error.reason : "unreadable";
      }
    }
  }
  return { face: null, reason: loadError ?? (unavailable ? "unavailable" : "missing") };
}
