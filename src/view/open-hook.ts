import { MarkdownView, Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { FRONTMATTER_KEY, VIEW_TYPE } from "../constants";
import type LinkFiguresPlugin from "../main";

/** True when the metadata cache has seen the `link-figures` frontmatter key on the file. */
export function hasFigureMarker(app: App, file: TFile): boolean {
  return app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] !== undefined;
}

/** Shows `path` in the figure view in `leaf` and makes the leaf active. */
export function showInFigureView(leaf: WorkspaceLeaf, path: string): Promise<void> {
  return leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true });
}

/**
 * Obsidian opens every `.md` file in the markdown view, so a figure file is switched to the figure view right after
 * it opens (a brief markdown flash is accepted). Uses public events only.
 */
export function installOpenHook(plugin: LinkFiguresPlugin): void {
  const { workspace } = plugin.app;
  // Leaves whose switch is still running: `file-open` and `active-leaf-change` both fire for one open.
  const switching = new Set<WorkspaceLeaf>();

  const consider = (leaf: WorkspaceLeaf | null): void => {
    if (!leaf || switching.has(leaf) || !plugin.settings.openAsFigure) return;
    const view = leaf.view;
    // Anything but a loaded markdown view is skipped: that includes a leaf already showing the figure view.
    if (!(view instanceof MarkdownView) || !view.file) return;
    const file = view.file;
    if (plugin.forcedMarkdown.has(file.path) || !hasFigureMarker(plugin.app, file)) return;

    switching.add(leaf);
    showInFigureView(leaf, file.path)
      .catch((error: unknown) => {
        console.error("Link Figures: could not open the file as a figure", error);
        new Notice("Link Figures: could not open this file as a figure. Use \"Open as markdown\" to see its source.");
      })
      .finally(() => switching.delete(leaf));
  };

  plugin.registerEvent(workspace.on("active-leaf-change", (leaf) => consider(leaf)));
  plugin.registerEvent(workspace.on("file-open", () => consider(workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null)));
}
