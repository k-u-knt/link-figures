import { resolveSubpath, type App, type TFile } from "obsidian";
import type { FileRef, Range, VaultAccess } from "./types";

/** `VaultAccess` over a live Obsidian vault. Thin by design; the resolver holds the logic. */
export class ObsidianVaultAccess implements VaultAccess {
  constructor(private readonly app: App) {}

  resolveLink(path: string, fromPath: string): FileRef | null {
    const file = this.app.metadataCache.getFirstLinkpathDest(path, fromPath);
    return file ? { path: file.path, extension: file.extension } : null;
  }

  sectionRange(file: FileRef, subpath: string): Range | null {
    if (subpath === "") return { start: 0, end: null };
    const target = this.fileOf(file);
    const cache = target && this.app.metadataCache.getFileCache(target);
    if (!cache) return null;
    const result = resolveSubpath(cache, subpath);
    return result ? { start: result.start.offset, end: result.end?.offset ?? null } : null;
  }

  embedsIn(file: FileRef, range: Range): { link: string; offset: number }[] {
    const target = this.fileOf(file);
    const embeds = (target && this.app.metadataCache.getFileCache(target)?.embeds) ?? [];
    return embeds
      .map((embed) => ({ link: embed.link, offset: embed.position.start.offset }))
      .filter((embed) => embed.offset >= range.start && (range.end === null || embed.offset < range.end))
      .sort((a, b) => a.offset - b.offset);
  }

  readText(file: FileRef): Promise<string> {
    return this.app.vault.cachedRead(this.requireFile(file));
  }

  readBinary(file: FileRef): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.requireFile(file));
  }

  resourcePath(file: FileRef): string {
    const target = this.fileOf(file);
    return target ? this.app.vault.getResourcePath(target) : "";
  }

  private fileOf(ref: FileRef): TFile | null {
    return this.app.vault.getFileByPath(ref.path);
  }

  private requireFile(ref: FileRef): TFile {
    const file = this.fileOf(ref);
    if (!file) throw new Error(`File not found in vault: ${ref.path}`);
    return file;
  }
}
