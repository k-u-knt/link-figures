import { resolveSubpath, type App, type TFile } from "obsidian";
import { METADATA_SETTLE_MS } from "../constants";
import type { FileRef, Range, VaultAccess } from "./types";

/**
 * The parts of Obsidian's metadata cache (not in its typings) that tell whether it has caught up with a file: per path,
 * the modification time, size and content hash it last read (`fileCache`), and the metadata by hash (`metadataCache`).
 */
interface CacheInternals {
  fileCache?: Record<string, { mtime?: number; size?: number; hash?: string } | undefined>;
  metadataCache?: Record<string, unknown>;
}

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

  stat(file: FileRef): { mtime: number; size: number } | null {
    const stat = this.fileOf(file)?.stat;
    return stat ? { mtime: stat.mtime, size: stat.size } : null;
  }

  /**
   * Resolves once Obsidian's metadata cache has the note at `path` as it is on disk now (it reads a written note a moment
   * later, then says "changed"), or after `METADATA_SETTLE_MS`. At once for a file that is not a note or not there.
   */
  settled(path: string, timeoutMs: number = METADATA_SETTLE_MS): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file || file.extension !== "md" || this.cacheCurrent(file)) return Promise.resolve();
    const cache = this.app.metadataCache;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        cache.offref(ref);
        window.clearTimeout(timer);
        resolve();
      };
      const ref = cache.on("changed", (changed) => {
        if (changed.path === path) done();
      });
      const timer = window.setTimeout(done, timeoutMs);
    });
  }

  /** Whether the metadata cache was made from the file as it is now (same time and size, its metadata there); false when it cannot tell. */
  private cacheCurrent(file: TFile): boolean {
    const internals = this.app.metadataCache as unknown as CacheInternals;
    const entry = internals.fileCache?.[file.path];
    if (!entry || typeof entry.hash !== "string" || entry.hash === "") return false;
    return entry.mtime === file.stat.mtime && entry.size === file.stat.size && internals.metadataCache?.[entry.hash] !== undefined;
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
