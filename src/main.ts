import { MarkdownView, Notice, Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
import { registerBuiltinCommands } from "./commands/builtin";
import { registerDevCommands } from "./commands/dev";
import { VIEW_TYPE, normalisePageLimit } from "./constants";
import { pdfExporter } from "./export/exporters/pdf";
import { svgExporter } from "./export/exporters/svg";
import { createDecoders } from "./links/decoders";
import { ObsidianVaultAccess } from "./links/obsidian-access";
import type { Decoders } from "./links/types";
import { fileNodeType } from "./nodes/file-node";
import { textNodeType } from "./nodes/text-node";
import { createRegistries, type Registries } from "./registry";
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

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registries.nodeTypes.register(fileNodeType);
    this.registries.nodeTypes.register(textNodeType);
    this.registries.exporters.register(svgExporter);
    this.registries.exporters.register(pdfExporter);
    registerBuiltinCommands(this);
    registerDevCommands(this);
    this.registerView(VIEW_TYPE, (leaf) => new LinkFiguresView(leaf, this));
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
