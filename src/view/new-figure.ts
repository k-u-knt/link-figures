import { normalizePath, TFolder, type App, type TFile } from "obsidian";
import { FILE_SUFFIX } from "../constants";
import { emptyParsed, serializeFigureFile } from "../format/serialize";
import { newFigureDocument } from "../model/defaults";
import { DEFAULT_PRESET_ID, getPreset } from "../model/presets";
import { CommandError } from "../registry/command";

/** A new figure file's text: `pages` empty pages of the preset `presetId` (a known one), as "New figure" writes them. */
export function newFigureText(presetId: string, pages: number): string {
  return serializeFigureFile(newFigureDocument(presetId, pages), emptyParsed());
}

/**
 * Writes a one-page figure to `<folder>/<baseName>.lnkfig.md`, numbering the name (" 1", " 2", ...) while it is taken.
 * An unknown preset id (a stale setting) falls back to the default preset rather than failing.
 */
export async function createFigureFile(app: App, folderPath: string, baseName: string, presetId: string): Promise<TFile> {
  const preset = getPreset(presetId) ? presetId : DEFAULT_PRESET_ID;
  const text = newFigureText(preset, 1);
  const folder = folderPath === "" || folderPath === "/" ? "" : `${folderPath}/`;
  for (let n = 0; ; n++) {
    const path = normalizePath(`${folder}${baseName}${n === 0 ? "" : ` ${n}`}${FILE_SUFFIX}`);
    // The adapter check also sees files on disk that the vault has not indexed yet, and is case-insensitive where the filesystem is.
    if (!app.vault.getAbstractFileByPath(path) && !(await app.vault.adapter.exists(path))) return app.vault.create(path, text);
  }
}

/**
 * Writes `text` as a new file at `path` (a normalised vault path), creating the folders above it that are missing: what
 * `api.createFigure` does once it has made the figure's text. Refuses (a `CommandError` naming `createFigure`), writing
 * nothing, when something is already at `path` (in the vault, or on disk and not indexed yet) or a folder above it is a file.
 */
export async function writeNewFigureFile(app: App, path: string, text: string): Promise<void> {
  const command = "createFigure";
  if (app.vault.getAbstractFileByPath(path) || (await app.vault.adapter.exists(path))) {
    throw new CommandError(`${command}: there is already a file or folder at "${path}"`);
  }
  const folders: string[] = [];
  for (const part of path.split("/").slice(0, -1)) folders.push(folders.length === 0 ? part : `${folders[folders.length - 1]}/${part}`);
  // Every folder is checked before any is made, so a refusal leaves the vault as it was.
  const missing = folders.filter((folder) => {
    const existing = app.vault.getAbstractFileByPath(folder);
    if (existing && !(existing instanceof TFolder)) throw new CommandError(`${command}: "${folder}" is a file, so it cannot hold the figure`);
    return !existing;
  });
  for (const folder of missing) {
    try {
      await app.vault.createFolder(folder);
    } catch (error) {
      // The folder can exist on disk without being in the vault's index yet.
      if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  await app.vault.create(path, text);
}
