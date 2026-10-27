import type { Range16 } from "../model/types";

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
  tiff(bytes: ArrayBuffer, pageIndex: number, range: Range16 | "auto"): Promise<DecodedImage>;
}

/** `deps` are the vault paths whose change should trigger re-resolution. */
export type Resolved =
  | { kind: "image"; file: FileRef; src: string; source: SourceKind; pageCount: number; deps: string[] }
  | { kind: "content"; file: FileRef; markdown: string; deps: string[] }
  | { kind: "missing"; reason: "file" | "subpath" | "no-image" | "decode"; deps: string[] };
