import type { PixelRecipe } from "../adjust/render";

export interface FileRef {
  path: string;
  extension: string;
}

/** Character offsets into a note; `end: null` runs to the end of the note. */
export interface Range {
  start: number;
  end: number | null;
}

/** Everything the resolver needs from the vault; implemented over Obsidian elsewhere so the resolver stays pure. */
export interface VaultAccess {
  resolveLink(path: string, fromPath: string): FileRef | null;
  /** `""` gives `{ start: 0, end: null }`; an unknown heading or block gives `null`. */
  sectionRange(file: FileRef, subpath: string): Range | null;
  /** Embeds whose offset lies in `range`, in document order. */
  embedsIn(file: FileRef, range: Range): { link: string; offset: number }[];
  readText(file: FileRef): Promise<string>;
  readBinary(file: FileRef): Promise<ArrayBuffer>;
  resourcePath(file: FileRef): string;
}

export type SourceKind = "raster" | "svg" | "pdf" | "tiff";

export interface DecodedImage {
  dataUrl: string;
  width: number;
  height: number;
  pageCount: number;
}

export interface Decoders {
  /** `scale` 1 is 72 dpi. */
  pdf(bytes: ArrayBuffer, pageIndex: number, scale: number): Promise<DecodedImage>;
  /** One page's native samples drawn through the panel's recipe (see `renderSamples`). */
  tiff(bytes: ArrayBuffer, pageIndex: number, recipe: PixelRecipe): Promise<DecodedImage>;
  /** A PNG, JPEG or other browser-decodable image drawn through the panel's recipe; used only when `adjusts` is true. */
  raster(bytes: ArrayBuffer, recipe: PixelRecipe): Promise<DecodedImage>;
  /** Whether the recipe has an adjustment that is switched on and registered (see `hasActiveAdjustments`). */
  adjusts(recipe: PixelRecipe): boolean;
}

/** `deps` are the vault paths whose change should trigger re-resolution. */
export type Resolved =
  | { kind: "image"; file: FileRef; src: string; source: SourceKind; pageCount: number; deps: string[] }
  | { kind: "content"; file: FileRef; markdown: string; deps: string[] }
  /** `message` is the decoder's own reason, for `"decode"`. */
  | { kind: "missing"; reason: "file" | "subpath" | "no-image" | "decode"; deps: string[]; message?: string };
