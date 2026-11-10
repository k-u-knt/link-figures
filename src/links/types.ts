import type { PixelRecipe } from "../adjust/render";
import type { Plane } from "./decoders/tiff-convert";

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
  /**
   * When the file was last modified (ms) and its size (bytes), for keying its decoded samples (see `samplesKey`); null
   * or absent when unknown, which caches nothing.
   */
  stat?(file: FileRef): { mtime: number; size: number } | null;
  /**
   * Resolves once what is known of the file at `path` (its headings and blocks, which `sectionRange` reads) is of the
   * file as it is now: after a write, once Obsidian's metadata cache has caught up, or a bounded wait. Never rejects.
   * Absent: known at once.
   */
  settled?(path: string): Promise<void>;
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
  /**
   * One page's native samples drawn through the panel's recipe (see `renderSamples`). With a samples `key` (see
   * `samplesKey`) the decoded page is cached under it, and when it is cached already `bytes` are not looked at.
   */
  tiff(bytes: ArrayBuffer, pageIndex: number, recipe: PixelRecipe, key?: string): Promise<DecodedImage>;
  /** A PNG, JPEG or other browser-decodable image drawn through the panel's recipe; used only when `adjusts` is true. `key` as for `tiff`. */
  raster(bytes: ArrayBuffer, recipe: PixelRecipe, key?: string): Promise<DecodedImage>;
  /** Whether the recipe has an adjustment that is switched on and registered (see `hasActiveAdjustments`). */
  adjusts(recipe: PixelRecipe): boolean;
  /** The decoded samples cached under `key`, if they are (a cached plane is shared: never write into it). */
  samples(key: string): Plane | undefined;
  /** Decodes a TIFF page or a raster image into the samples cache under `key`, without drawing it (a cached one is not decoded again). */
  decodeSamples(bytes: ArrayBuffer, source: "tiff" | "raster", pageIndex: number, key: string): Promise<Plane>;
}

/** `deps` are the vault paths whose change should trigger re-resolution. */
export type Resolved =
  | { kind: "image"; file: FileRef; src: string; source: SourceKind; pageCount: number; deps: string[] }
  | { kind: "content"; file: FileRef; markdown: string; deps: string[] }
  /** `message` is the decoder's own reason, for `"decode"`. */
  | { kind: "missing"; reason: "file" | "subpath" | "no-image" | "decode"; deps: string[]; message?: string };
