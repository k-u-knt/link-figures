import type { FileRef, Range, VaultAccess } from "../../src/links/types";

export interface FakeVault {
  /** Path to file text, or `"BINARY"` for a file with no readable text. */
  files: Record<string, string>;
  headings?: Record<string, Record<string, Range>>;
  blocks?: Record<string, Record<string, Range>>;
  embeds?: Record<string, { link: string; offset: number }[]>;
  /** Path to modification time; a file not listed has none (`stat` gives null). */
  mtimes?: Record<string, number | null>;
  /** Path to size in bytes; 0 when not listed. */
  sizes?: Record<string, number>;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stripExtension = (name: string) => (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name);
const refOf = (path: string): FileRef => {
  const name = basename(path);
  return { path, extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "" };
};

export class FakeAccess implements VaultAccess {
  constructor(private readonly vault: FakeVault) {}

  /** Exact path first, then file name with or without its extension. */
  resolveLink(path: string, _fromPath: string): FileRef | null {
    const paths = Object.keys(this.vault.files);
    const hit =
      paths.find((p) => p === path) ??
      paths.find((p) => basename(p) === path) ??
      paths.find((p) => stripExtension(basename(p)) === path);
    return hit === undefined ? null : refOf(hit);
  }

  sectionRange(file: FileRef, subpath: string): Range | null {
    if (subpath === "") return { start: 0, end: null };
    if (subpath.startsWith("#^")) return this.vault.blocks?.[file.path]?.[subpath.slice(2)] ?? null;
    if (subpath.startsWith("#")) return this.vault.headings?.[file.path]?.[subpath.slice(1)] ?? null;
    return null;
  }

  embedsIn(file: FileRef, range: Range): { link: string; offset: number }[] {
    return (this.vault.embeds?.[file.path] ?? []).filter(
      (e) => e.offset >= range.start && (range.end === null || e.offset < range.end),
    );
  }

  async readText(file: FileRef): Promise<string> {
    const text = this.vault.files[file.path];
    if (text === undefined || text === "BINARY") throw new Error(`No text for ${file.path}`);
    return text;
  }

  async readBinary(file: FileRef): Promise<ArrayBuffer> {
    if (this.vault.files[file.path] === undefined) throw new Error(`No such file ${file.path}`);
    return new ArrayBuffer(0);
  }

  resourcePath(file: FileRef): string {
    return "app://" + file.path;
  }

  stat(file: FileRef): { mtime: number; size: number } | null {
    const mtime = this.vault.mtimes?.[file.path];
    return mtime === undefined || mtime === null ? null : { mtime, size: this.vault.sizes?.[file.path] ?? 0 };
  }

  /** As a write to the file on disk changes its modification time. */
  setMtime(path: string, mtime: number | null): void {
    this.vault.mtimes = { ...this.vault.mtimes, [path]: mtime };
  }

  /** As a write to the file on disk may change its size and not its mtime (a coarse clock). */
  setSize(path: string, size: number): void {
    this.vault.sizes = { ...this.vault.sizes, [path]: size };
  }
}
