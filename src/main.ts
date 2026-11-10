import { MarkdownView, Notice, Plugin, TFile, normalizePath, type WorkspaceLeaf } from "obsidian";
import { createApi, type LinkFiguresApi } from "./api";
import { readHeadlessFigure, type FigureFiles } from "./commands/headless";
import { afterLinkUpdates } from "./links/link-updates";
import { displayAdjustment } from "./adjust/display";
import { builtinLuts } from "./adjust/luts";
import { arrangeCommands } from "./commands/arrange";
import { cardCommands } from "./commands/cards";
import { builtinSnapSources } from "./model/snap";
import { registerBuiltinCommands, registerPaletteCommand } from "./commands/builtin";
import { cropCommands } from "./commands/crop";
import { displayCommands } from "./commands/display";
import { registerDevCommands } from "./commands/dev";
import { drawingCommands } from "./commands/drawing";
import { FigureWrites } from "./commands/figure-writes";
import { panelCommands } from "./commands/panels";
import { blockIdPrefix } from "./links/block-id";
import { BlockIdQueue, writableEditor, type NoteHost } from "./links/note-block-id";
import { EditorDragTracker, PopoutDragListeners, listenForEditorDrags } from "./links/editor-drag";
import { groupCommands } from "./commands/groups";
import { builtinCapKinds, builtinRoutes } from "./connectors/builtin";
import { VIEW_TYPE } from "./constants";
import { viewExportTarget } from "./export/export-modal";
import { closeBackgroundTab, exportFigure, exportInBackground, takeBackgroundLeaf, type BackgroundFigure, type ExportOutcome, type ExportRequest, type TabWorkspace } from "./export/export-run";
import { pdfExporter } from "./export/exporters/pdf";
import { pptxExporter } from "./export/exporters/pptx";
import { pngExporter, tiffExporter } from "./export/exporters/raster";
import { svgExporter } from "./export/exporters/svg";
import { localFontSource } from "./fonts/local-source";
import { createDecoders } from "./links/decoders";
import { ObsidianVaultAccess } from "./links/obsidian-access";
import type { Decoders } from "./links/types";
import { cardNodeType } from "./nodes/card-node";
import { connectorNodeType } from "./nodes/connector-node";
import { fileNodeType } from "./nodes/file-node";
import { groupNodeType } from "./nodes/group-node";
import { shapeNodeType } from "./nodes/shape-node";
import { textNodeType } from "./nodes/text-node";
import { builtinPaintTypes } from "./paint/builtin";
import { builtinRampGeometries, builtinRampPresets } from "./paint/ramp";
import { createRegistries, type Registries } from "./registry";
import { CommandError } from "./registry/command";
import { builtinShapeKinds } from "./shapes/builtin";
import { DEFAULT_SETTINGS, LinkFiguresSettingTab, normaliseSettings, type LinkFiguresSettings } from "./settings/settings";
import { LinkFiguresView } from "./view/figure-view";
import { createFigureFile, writeNewFigureFile } from "./view/new-figure";
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
  /** Block ids are written one at a time per note, each after the cache has indexed the last: see `BlockIdQueue`. */
  private readonly blockIds = new BlockIdQueue(
    () => this.noteHost(),
    () => blockIdPrefix(this.settings.blockIdPrefix),
  );
  /** The plugin's writes of figure files in flight: a figure view that starts to load waits for those of its file. */
  readonly figureWrites = new FigureWrites();
  /** Figure files by vault path, as the API and an export of a closed figure read them; every write is in `figureWrites`. */
  private readonly figureFiles: FigureFiles = this.figureWrites.wrap({
    read: (path) => this.app.vault.read(this.vaultFile(path)),
    // After Obsidian's link updates under way, whose offsets a write landing in between would make stale (`afterLinkUpdates`).
    process: (path, edit) => afterLinkUpdates(this.app, async () => void (await this.app.vault.process(this.vaultFile(path), edit))),
  });
  /** The API for other plugins and scripts (the Obsidian CLI's `eval`): see `LinkFiguresApi`. */
  api: LinkFiguresApi = createApi({
    app: this.app,
    registries: this.registries,
    files: this.figureFiles,
    normalizePath,
    openFigure: (path) => this.openFigureView(path),
    loadingFigure: (path) => this.loadingFigureViews(path),
    noteBlockId: (path, line) => this.blockIds.blockId(path, line),
    exportFigure: (path, request) => this.exportFigureAt(path, request),
    createFigureFile: (path, text) => writeNewFigureFile(this.app, path, text),
    defaultPreset: () => this.settings.defaultPreset,
    pageLimitMm: () => this.settings.maxPageSizeMm,
  });
  /** The Markdown view a drag started in (its editor), for a drop of text on a figure to match against: see `EditorDragTracker`. */
  readonly editorDrag = new EditorDragTracker(() => this.app.workspace.getLeavesOfType("markdown"));
  /** When each figure view was last made active, by a counter: the API acts on the most recent view of a figure. */
  private readonly viewActivity = new WeakMap<LinkFiguresView, number>();
  private activityCount = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registries.nodeTypes.register(fileNodeType);
    this.registries.nodeTypes.register(textNodeType);
    this.registries.nodeTypes.register(shapeNodeType);
    this.registries.nodeTypes.register(connectorNodeType);
    this.registries.nodeTypes.register(groupNodeType);
    this.registries.nodeTypes.register(cardNodeType);
    // A type registered later (another plugin's) may keep links in the Links section: open figures take theirs up.
    this.register(
      this.registries.nodeTypes.onRegister((type) => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof LinkFiguresView) leaf.view.typeRegistered(type);
      }),
    );
    this.registries.exporters.register(svgExporter);
    this.registries.exporters.register(pdfExporter);
    this.registries.exporters.register(pngExporter);
    this.registries.exporters.register(tiffExporter);
    this.registries.exporters.register(pptxExporter);
    for (const paint of builtinPaintTypes) this.registries.paints.register(paint);
    for (const geometry of builtinRampGeometries) this.registries.rampGeometries.register(geometry);
    for (const preset of builtinRampPresets) this.registries.rampPresets.register(preset);
    for (const kind of builtinShapeKinds) this.registries.shapes.register(kind);
    for (const route of builtinRoutes) this.registries.routes.register(route);
    for (const cap of builtinCapKinds) this.registries.caps.register(cap);
    for (const source of builtinSnapSources) this.registries.snaps.register(source);
    for (const lut of builtinLuts) this.registries.luts.register(lut);
    // The installed fonts can only be listed while the window is visible: prime now, and again whenever it becomes
    // visible until the list is cached (export and the inspector also retry when they need it).
    const localFonts = localFontSource();
    this.registries.fontSources.register(localFonts);
    void localFonts.prime();
    // Where a drag starts in an editor, in the main window and in each popout (removed when the popout closes).
    this.register(listenForEditorDrags(document, this.editorDrag));
    const popouts = new PopoutDragListeners(document, (doc) => listenForEditorDrags(doc, this.editorDrag));
    this.registerEvent(this.app.workspace.on("window-open", (win) => popouts.add(win.doc)));
    this.registerEvent(this.app.workspace.on("window-close", (win) => popouts.remove(win.doc)));
    this.register(() => popouts.clear());
    // The popouts already open when the plugin loads (restored with the workspace) open no window-open of their own.
    this.app.workspace.onLayoutReady(() => {
      const leaves: WorkspaceLeaf[] = [];
      this.app.workspace.iterateAllLeaves((leaf) => void leaves.push(leaf));
      popouts.addLeaves(leaves);
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void localFonts.prime();
    });
    this.registries.adjustments.register(
      displayAdjustment(this.registries.luts, (id) => console.warn(`Link Figures: no LUT "${id}" is registered, so the channel is drawn in grey`)),
    );
    registerBuiltinCommands(this);
    // Not in the palette: each needs arguments (the tools, the inspector and scripts give them).
    for (const command of [...drawingCommands(), ...panelCommands(), ...cardCommands()]) this.registries.commands.register(command);
    // Group, Ungroup, Align and Distribute act on the selection, so they are in the palette (and can take hotkeys); the hidden ones need arguments.
    for (const command of [...groupCommands(), ...arrangeCommands()]) {
      if (command.hidden) this.registries.commands.register(command);
      else registerPaletteCommand(this, command);
    }
    // panel.crop takes arguments (the inspector and crop mode give them); Reset crop is also in the palette.
    for (const command of cropCommands()) {
      if (command.hidden) this.registries.commands.register(command);
      else registerPaletteCommand(this, command);
    }
    // panel.display and panel.histogram take arguments (the inspector gives them); Auto display range and Reset display are also in the palette.
    for (const command of displayCommands()) {
      if (command.hidden) this.registries.commands.register(command);
      else registerPaletteCommand(this, command);
    }
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

  /**
   * Resolves once every figure view of `path` that is still loading has loaded (see `LinkFiguresView.whenLoaded`); null
   * when none is. A tab not yet shown (deferred) is not loading: it reads the file when it is shown.
   */
  private loadingFigureViews(path: string): Promise<void> | null {
    const target = normalizePath(path);
    const loading: Promise<void>[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof LinkFiguresView && view.file?.path === target && view.isLoading()) loading.push(view.whenLoaded());
    }
    return loading.length === 0 ? null : Promise.all(loading).then(() => undefined);
  }

  /** Notes as `noteBlockId` and a drop out of a note read and write them: by path, through the cache, an open Markdown editor, and `vault.process`. */
  noteHost(): NoteHost {
    const { vault, metadataCache, workspace } = this.app;
    const note = (path: string): TFile | null => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? file : null;
    };
    const markdownViews = (path: string): MarkdownView[] =>
      workspace.getLeavesOfType("markdown").flatMap((leaf) => (leaf.view instanceof MarkdownView && leaf.view.file?.path === path ? [leaf.view] : []));
    // The view whose editor `editor` gives (one not in Reading view), so that the editor saved is the one written through.
    const markdownView = (path: string): MarkdownView | null => {
      const views = markdownViews(path);
      return views.find((view) => view.getMode() !== "preview") ?? views[0] ?? null;
    };
    const nextIndex = (path: string, timeoutMs: number) => {
      let settle: (indexed: boolean) => void = () => undefined;
      const indexed = new Promise<boolean>((resolve) => (settle = resolve));
      const ref = metadataCache.on("changed", (file) => {
        if (file.path === path) done(true);
      });
      const timer = window.setTimeout(() => done(false), timeoutMs);
      const done = (value: boolean) => {
        window.clearTimeout(timer);
        metadataCache.offref(ref);
        settle(value);
      };
      return { indexed, cancel: () => done(false) };
    };
    return {
      resolve: (path) => (note(path) ?? note(`${path}.md`))?.path ?? null,
      cache: (path) => {
        const file = note(path);
        return file ? metadataCache.getFileCache(file) : null;
      },
      read: (path) => vault.cachedRead(this.vaultFile(path)),
      // Not through a Reading view's editor: the file is written with process instead (`writableEditor`).
      editor: (path) => writableEditor(markdownViews(path)),
      saveAndReindex: (path, timeoutMs) => {
        // Listening before the save, so the event cannot come first.
        const { indexed, cancel } = nextIndex(path, timeoutMs);
        const view = markdownView(path);
        if (!view) cancel();
        else
          view.save().catch((error: unknown) => {
            console.error(`Link Figures: could not save ${path}`, error);
            cancel();
          });
        return indexed;
      },
      nextIndex,
      // A note may hold links too: after Obsidian's link updates under way, as a figure file's writes are.
      process: (path, edit) => afterLinkUpdates(this.app, async () => void (await vault.process(this.vaultFile(path), edit))),
    };
  }

  /**
   * Exports the figure at `path` as `api.export` asks: from its most recently active view, or, with none, from a view
   * opened in a background tab for it once the request has been checked against its file, which is waited on until its
   * links are resolved and its nodes drawn, and closed again afterwards (`exportInBackground`).
   */
  private async exportFigureAt(path: string, request: ExportRequest): Promise<ExportOutcome> {
    const open = this.openFigureView(path);
    if (open?.file) {
      const { files, warnings } = await exportFigure(viewExportTarget(open, open.file), request);
      return { files, warnings };
    }
    return exportInBackground(
      {
        registries: this.registries,
        settings: this.settings,
        read: (figure) => readHeadlessFigure(this.registries, this.figureFiles, figure),
        open: (figure) => this.openInBackground(figure),
      },
      path,
      request,
    );
  }

  /** Opens the figure at `path` in a background tab, for `exportInBackground`; the tab is closed again if it is no figure. */
  private async openInBackground(path: string): Promise<BackgroundFigure> {
    const file = this.vaultFile(path);
    // Not left active by "Always focus new tabs", and closed after the export unless the user switches to it.
    const tab = takeBackgroundLeaf(this.app.workspace as unknown as TabWorkspace<WorkspaceLeaf>);
    const leaf = tab.leaf;
    try {
      await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: false });
      await leaf.loadIfDeferred();
      const view = leaf.view;
      if (!(view instanceof LinkFiguresView) || !view.hasDocument() || !view.file) throw new CommandError(`api.export: "${path}" could not be opened as a figure`);
      // The view started resolving its links when it loaded; any it has not started yet are started here.
      void view.nodeHost.resolveStale();
      // Closing saves what the view would write (nothing, for a figure it only read): done first, and waited on, so the
      // next call on the figure, which the API queues after this export, does not race that write.
      const close = () => closeBackgroundTab({ save: () => view.save(), ...tab });
      return { target: viewExportTarget(view, view.file), drawn: () => view.nodeHost.drawn(), close };
    } catch (error) {
      tab.detach();
      tab.release?.();
      throw error;
    }
  }

  /** The file at vault path `path`; a `CommandError` when there is none. */
  private vaultFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new CommandError(`there is no file "${path}"`);
    return file;
  }

  async loadSettings(): Promise<void> {
    this.settings = normaliseSettings(await this.loadData());
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
