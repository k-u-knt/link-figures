import { normalizePath, TFile, type App } from "obsidian";
import type { LinkFiguresSettings } from "../settings/settings";

/** What a file name may not contain on one of the systems a vault can be synced to. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** The name with each character a file name cannot hold replaced by "-" (a page called "A/B" must not make a subfolder). */
export function safeFileName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARS, "-");
}

/** `name` with `" (n)"` before its extension (or at its end when it has none). */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/**
 * The names made safe (see `safeFileName`) and distinct from each other, in the same order: the first of a repeated
 * name keeps it and the others become `name (2).ext`, `name (3).ext`... Names are compared as a file system that
 * ignores case would, and a number added here never collides with a name that comes later.
 */
export function uniqueFileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const safe = safeFileName(name);
    let unique = safe;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = numbered(safe, n);
    used.add(unique.toLowerCase());
    return unique;
  });
}

/** The folder exports go to: the setting, or else the figure's own folder (`""` for the vault root). */
export function exportFolderFor(settings: Pick<LinkFiguresSettings, "exportFolder">, figurePath: string): string {
  if (settings.exportFolder) return settings.exportFolder;
  const slash = figurePath.lastIndexOf("/");
  return slash === -1 ? "" : figurePath.slice(0, slash);
}

/** The export folder normalised, `""` for the vault root (`normalizePath` leaves "/" as it is, which names the root). */
export function exportDir(folder: string): string {
  const normalized = folder ? normalizePath(folder) : "";
  return normalized === "/" ? "" : normalized;
}

/** The vault path `writeExportFile` writes `name` to in `folder`. */
export function exportPathFor(folder: string, name: string): string {
  const dir = exportDir(folder);
  const safeName = safeFileName(name);
  return normalizePath(dir ? `${dir}/${safeName}` : safeName);
}

/**
 * True for what an export must never write over: the figure file itself, any note, and any file a node of the figure
 * depends on (`isDependency`). Writing goes through `modifyBinary`, which bypasses the trash.
 */
export function isFigureSource(path: string, figurePath: string, isDependency: (path: string) => boolean): boolean {
  return path === figurePath || /\.md$/i.test(path) || isDependency(path);
}

/** Creates `folder` and the folders above it that are missing. */
async function ensureFolder(app: App, folder: string): Promise<void> {
  let path = "";
  for (const part of folder.split("/").filter(Boolean)) {
    path = path ? `${path}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) throw new Error(`"${path}" is a file, so it cannot hold the export`);
    if (existing) continue;
    try {
      await app.vault.createFolder(path);
    } catch (error) {
      // The folder can exist on disk without being in the vault's index yet.
      if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

/**
 * Writes `blob` to `folder/name` in the vault, replacing the file of that name if there is one. The folder is
 * created when missing. Characters a file name cannot hold (a page called "A/B") become "-" rather than a subfolder.
 */
export async function writeExportFile(app: App, folder: string, name: string, blob: Blob): Promise<TFile> {
  const dir = exportDir(folder);
  const path = exportPathFor(folder, name);
  const data = await blob.arrayBuffer();
  if (dir) await ensureFolder(app, dir);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modifyBinary(existing, data);
    return existing;
  }
  if (existing) throw new Error(`"${path}" is a folder, so a file cannot be written there`);
  return app.vault.createBinary(path, data);
}
