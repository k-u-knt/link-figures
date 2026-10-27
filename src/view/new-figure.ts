import { normalizePath, type App, type TFile } from "obsidian";
import { FILE_SUFFIX } from "../constants";
import { emptyParsed, serializeFigureFile } from "../format/serialize";
import { createDocument } from "../model/defaults";
import { getPreset } from "../model/presets";
import { DEFAULT_SETTINGS } from "../settings/settings";

/**
 * Writes a one-page figure to `<folder>/<baseName>.lnkfig.md`, numbering the name (" 1", " 2", ...) while it is taken.
 * An unknown preset id (a stale setting) falls back to the default preset rather than failing.
 */
export async function createFigureFile(app: App, folderPath: string, baseName: string, presetId: string): Promise<TFile> {
  const preset = getPreset(presetId) ? presetId : DEFAULT_SETTINGS.defaultPreset;
  const text = serializeFigureFile(createDocument(preset), emptyParsed());
  const folder = folderPath === "" || folderPath === "/" ? "" : `${folderPath}/`;
  for (let n = 0; ; n++) {
    const path = normalizePath(`${folder}${baseName}${n === 0 ? "" : ` ${n}`}${FILE_SUFFIX}`);
    // The adapter check also sees files on disk that the vault has not indexed yet, and is case-insensitive where the filesystem is.
    if (!app.vault.getAbstractFileByPath(path) && !(await app.vault.adapter.exists(path))) return app.vault.create(path, text);
  }
}
