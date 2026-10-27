import { normalizePath, TFile, type App } from "obsidian";
import type { LinkFiguresSettings } from "../settings/settings";

/** What a file name may not contain on one of the systems a vault can be synced to. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** The folder exports go to: the setting, or else the figure's own folder (`""` for the vault root). */
export function exportFolderFor(settings: LinkFiguresSettings, figurePath: string): string {
  if (settings.exportFolder) return settings.exportFolder;
  const slash = figurePath.lastIndexOf("/");
  return slash === -1 ? "" : figurePath.slice(0, slash);
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
  const safeName = name.replace(UNSAFE_NAME_CHARS, "-");
  // `normalizePath` leaves "/" as it is, which names the vault root.
  const normalized = folder ? normalizePath(folder) : "";
  const dir = normalized === "/" ? "" : normalized;
  const path = normalizePath(dir ? `${dir}/${safeName}` : safeName);
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
