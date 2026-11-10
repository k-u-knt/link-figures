import { MarkdownView, Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { FILE_SUFFIX, VIEW_TYPE } from "../constants";
import { hasMarker } from "../format/figure-file";
import type LinkFiguresPlugin from "../main";

/** True when the metadata cache has seen the `link-figures` frontmatter key on the file. */
export function hasFigureMarker(app: App, file: TFile): boolean {
  return hasMarker(app.metadataCache.getFileCache(file)?.frontmatter);
}

/**
 * True when `path` should open in the figure view: the setting is on, the user has not chosen markdown for the path, and
 * the file is a figure. That is a file with the figure suffix, or else one whose frontmatter carries the marker (the cache
 * may not have indexed a new file yet, which is why the suffix decides first and without the cache).
 */
export function isFigureFile(plugin: LinkFiguresPlugin, path: string): boolean {
  if (!plugin.settings.openAsFigure || plugin.forcedMarkdown.has(path)) return false;
  if (path.endsWith(FILE_SUFFIX)) return true;
  const file = plugin.app.vault.getFileByPath(path);
  return file !== null && hasFigureMarker(plugin.app, file);
}

/** Shows `path` in the figure view in `leaf` and makes the leaf active. */
export function showInFigureView(leaf: WorkspaceLeaf, path: string): Promise<void> {
  return leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true });
}

/**
 * The fallback for a figure file that still opens in the markdown view. `installViewStateRewrite` turns a markdown open of a
 * figure file into the figure view's before it is recorded; this catches an open that did not go through `setViewState` with
 * a figure path (a figure without the suffix that the cache had not indexed). It switches the leaf right after the file
 * opens, which costs a brief markdown flash and an extra history entry. Uses public events only.
 */
export function installOpenHook(plugin: LinkFiguresPlugin): void {
  const { workspace } = plugin.app;
  // Leaves whose switch is still running: `file-open` and `active-leaf-change` both fire for one open.
  const switching = new Set<WorkspaceLeaf>();

  const consider = (leaf: WorkspaceLeaf | null): void => {
    if (!leaf || switching.has(leaf)) return;
    const view = leaf.view;
    // Anything but a loaded markdown view is skipped: that includes a leaf already showing the figure view.
    if (!(view instanceof MarkdownView) || !view.file) return;
    const path = view.file.path;
    if (!isFigureFile(plugin, path)) return;

    switching.add(leaf);
    showInFigureView(leaf, path)
      .catch((error: unknown) => {
        console.error("Link Figures: could not open the file as a figure", error);
        new Notice("Link Figures: could not open this file as a figure. Use \"Open as markdown\" to see its source.");
      })
      .finally(() => switching.delete(leaf));
  };

  plugin.registerEvent(workspace.on("active-leaf-change", (leaf) => consider(leaf)));
  plugin.registerEvent(workspace.on("file-open", () => consider(workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null)));
}
