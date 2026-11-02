import { MarkdownView, Notice, Plugin, TFile, normalizePath, type WorkspaceLeaf } from "obsidian";
import { createApi, type LinkFiguresApi } from "./api";
import { registerBuiltinCommands } from "./commands/builtin";
import { registerDevCommands } from "./commands/dev";
import { builtinCapKinds, builtinRoutes } from "./connectors/builtin";
import { VIEW_TYPE, normalisePageLimit } from "./constants";
import { pdfExporter } from "./export/exporters/pdf";
import { svgExporter } from "./export/exporters/svg";
import { createDecoders } from "./links/decoders";
import { ObsidianVaultAccess } from "./links/obsidian-access";
import type { Decoders } from "./links/types";
import { connectorNodeType } from "./nodes/connector-node";
import { fileNodeType } from "./nodes/file-node";
import { shapeNodeType } from "./nodes/shape-node";
import { textNodeType } from "./nodes/text-node";
import { builtinPaintTypes } from "./paint/builtin";
import { createRegistries, type Registries } from "./registry";
import { CommandError } from "./registry/command";
import { builtinShapeKinds } from "./shapes/builtin";
import { DEFAULT_SETTINGS, LinkFiguresSettingTab, type LinkFiguresSettings } from "./settings/settings";
import { LinkFiguresView } from "./view/figure-view";
import { createFigureFile } from "./view/new-figure";
import { hasFigureMarker, installOpenHook, showInFigureView } from "./view/open-hook";
import { installViewStateRewrite } from "./view/view-state-rewrite";

const NEW_FIGURE_NAME = "Untitled figure";

export default class LinkFiguresPlugin extends Plugin {
  settings: LinkFiguresSettings = { ...DEFAULT_SETTINGS };
  registries: Registries = createRegistries();
  /** Paths the user chose to see as markdown this session; the open hook leaves them alone. */
  forcedMarkdown = new Set<string>();
  access = new ObsidianVaultAccess(this.app);
  decoders: Decoders = createDecoders(this.registries.adjustments);
  /** The API for other plugins and scripts (the Obsidian CLI's `eval`): see `LinkFiguresApi`. */
  api: LinkFiguresApi = createApi({
    app: this.app,
    registries: this.registries,
    files: {
      read: (path) => this.app.vault.read(this.vaultFile(path)),
      write: (path, text) => this.app.vault.modify(this.vaultFile(path), text),
    },
    openFigure: (path) => this.openFigureView(path),
  });
  /** When each figure view was last made active, by a counter: the API acts on the most recent view of a figure. */
  private readonly viewActivity = new WeakMap<LinkFiguresView, number>();
  private activityCount = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registries.nodeTypes.register(fileNodeType);
    this.registries.nodeTypes.register(textNodeType);
    this.registries.nodeTypes.register(shapeNodeType);
    this.registries.nodeTypes.register(connectorNodeType);
    this.registries.exporters.register(svgExporter);
    this.registries.exporters.register(pdfExporter);
    for (const paint of builtinPaintTypes) this.registries.paints.register(paint);
    for (const kind of builtinShapeKinds) this.registries.shapes.register(kind);
    for (const route of builtinRoutes) this.registries.routes.register(route);
    for (const cap of builtinCapKinds) this.registries.caps.register(cap);
    registerBuiltinCommands(this);
    registerDevCommands(this);
    this.registerView(VIEW_TYPE, (leaf) => new LinkFiguresView(leaf, this));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof LinkFiguresView) this.viewActivity.set(leaf.view, ++this.activityCount);
      }),
    );
    // The fallback for an open that did not go through `setViewState` with a figure path; the wrapper below does the work.
    installOpenHook(this);
    this.register(installViewStateRewrite(this));

    this.addCommand({
      id: "new-figure",
      name: "New figure",
      callback: () => void this.attempt("create the figure", () => this.newFigure()),
    });
    this.addCommand({
      id: "open-as-markdown",
      name: "Open as markdown",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(LinkFiguresView);
        const file = view?.file;
        if (!view || !file) return false;
        if (!checking) void this.attempt("open as markdown", () => this.openAsMarkdown(view.leaf, file));
        return true;
      },
    });
    this.addCommand({
      id: "open-as-figure",
      name: "Open as figure",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file;
        if (!view || !file || !hasFigureMarker(this.app, file)) return false;
        if (!checking) void this.attempt("open as figure", () => this.openAsFigure(view.leaf, file));
        return true;
      },
    });

    this.addRibbonIcon("image", "New figure", () => void this.attempt("create the figure", () => this.newFigure()));
    this.addSettingTab(new LinkFiguresSettingTab(this.app, this));
  }

  /** The figure view that has the focus, for the palette commands. */
  activeFigureView(): LinkFiguresView | null {
    return this.app.workspace.getActiveViewOfType(LinkFiguresView);
  }

  /** The most recently active figure view that has the figure at `path` loaded, or null. */
  private openFigureView(path: string): LinkFiguresView | null {
    const target = normalizePath(path);
    let best: LinkFiguresView | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof LinkFiguresView) || view.file?.path !== target || !view.hasDocument()) continue;
      if (!best || (this.viewActivity.get(view) ?? 0) > (this.viewActivity.get(best) ?? 0)) best = view;
    }
    return best;
  }

  /** The file at vault path `path`; a `CommandError` when there is none. */
  private vaultFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new CommandError(`there is no file "${path}"`);
    return file;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.maxPageSizeMm = normalisePageLimit(this.settings.maxPageSizeMm);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Creates a figure beside the active file (or at the vault root) and opens it in a new tab. */
  private async newFigure(): Promise<void> {
    const folder = this.app.workspace.getActiveFile()?.parent?.path ?? "";
    const file = await createFigureFile(this.app, folder, NEW_FIGURE_NAME, this.settings.defaultPreset);
    // Open the view directly: the metadata cache has not indexed a new file yet, so the open hook could not tell it apart.
    await showInFigureView(this.app.workspace.getLeaf("tab"), file.path);
  }

  private async openAsMarkdown(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    this.forcedMarkdown.add(file.path);
    await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source", source: true }, active: true });
  }

  private async openAsFigure(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    this.forcedMarkdown.delete(file.path);
    await showInFigureView(leaf, file.path);
  }

  /** Runs a command body and reports a failure to the user instead of leaving it unhandled. */
  private async attempt(what: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.error(`Link Figures: could not ${what}`, error);
      new Notice(`Link Figures: could not ${what}. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
