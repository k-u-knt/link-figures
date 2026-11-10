import type { App } from "obsidian";

/**
 * The link text Obsidian writes for a link to `file` (a path or a name) from `fromPath`, in the user's link format
 * (`metadataCache.fileToLinktext` of the file the link finds); `file` itself when it finds none, or there is no cache.
 */
export function vaultLinktext(app: App, file: string, fromPath: string): string {
  const cache = (app as Partial<App>).metadataCache;
  const target = typeof cache?.getFirstLinkpathDest === "function" ? cache.getFirstLinkpathDest(file, fromPath) : null;
  return target && typeof cache?.fileToLinktext === "function" ? cache.fileToLinktext(target, fromPath) : file;
}
