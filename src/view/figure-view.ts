import { Notice, TextFileView, TFile, type PaneType, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type { EditorView } from "../commands/builtin";
import { prepareCall, runCall } from "../commands/headless";
import { DEFAULT_PAGE_LIMIT_MM, FILE_SUFFIX, VIEW_TYPE } from "../constants";
import { ExportModal } from "../export/export-modal";
import { FontFamilyList } from "../fonts/family-list";
import { FormatError, NotFigureError } from "../format/errors";
import { applyLinkEntries, classifyReload } from "../format/links-reload";
import { loadDocument } from "../format/load";
import { parseFigureFile, type ParsedFigureFile } from "../format/parse";
import { emptyParsed, serializeFigureFile } from "../format/serialize";
import { Intake } from "../links/intake";
import type { Plane } from "../links/decoders/tiff-convert";
import { InvalidationIndex, missingNodeIds } from "../links/invalidation";
import { renamedLinkFiles } from "../links/resolver";
import type { Resolved } from "../links/types";
import { LinkWatcher } from "../links/watcher";
import type LinkFiguresPlugin from "../main";
import { createDocument } from "../model/defaults";
import type { PlacePoint, Pt, Rect } from "../model/geometry";
import { createFigureStore } from "../model/normalise";
import { DocumentStore } from "../model/store";
import type { Document, NodeId, Page } from "../model/types";
import type { Command, CommandContext, DragTargets, ToolPreview, UndoStep } from "../registry/command";
import type { ImageState } from "../registry/node-type";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { Inspector } from "./inspector";
import { NodeHost } from "./node-host";
import { PageLayer } from "./page-layer";
import { isEditable, PointerController } from "./pointer";
import { SelectionState } from "./selection";
import { Toolbar } from "./toolbar";
import { nearestPage, pageInFocus, pageWorldRect, Viewport } from "./viewport";

/** What stands in for a document while none is loaded, so `store` is never undefined. It is never written to a file. */
const blankDocument = (): Document => createDocument(DEFAULT_SETTINGS.defaultPreset);

/** Wheel zoom: one unit of `deltaY` scales the zoom by `exp(-0.01)`, which suits a trackpad pinch (a ctrl+wheel). */
const WHEEL_ZOOM_RATE = 0.01;

function describeLoadError(error: unknown): string {
  if (error instanceof FormatError || error instanceof NotFigureError) return error.message;
  console.error("Link Figures: unexpected error while reading a figure file", error);
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** The figure view's lifecycle: build the DOM, load a figure file into a store, save it back. Rendering lives elsewhere. */
export class LinkFiguresView extends TextFileView implements EditorView {
  store: DocumentStore = new DocumentStore(blankDocument());
  parsed: ParsedFigureFile = emptyParsed();
  readonly index = new InvalidationIndex();
  readonly watcher: LinkWatcher;
  readonly resolvedCache = new Map<NodeId, Resolved>();
  /**
   * When a gesture made outside the stage (an inspector histogram drag) began, or null when there is none: while it
   * lasts every commit is stamped with it, as a stage drag's are (see `PointerController.commitTime`), so the gesture
   * stays one undo step however long the pointer rests.
   */
  gestureStartedAt: number | null = null;

  stageEl!: HTMLElement;
  viewportEl!: HTMLElement;
  toolbarEl!: HTMLElement;
  inspectorEl!: HTMLElement;

  /** World to stage transform; `applyViewport` copies it onto `viewportEl`. */
  readonly viewport = new Viewport();
  pageLayer!: PageLayer;
  nodeHost!: NodeHost;
  /** Which nodes are selected; emptied whenever a document is loaded. */
  selection!: SelectionState;
  private pointer!: PointerController;
  private intake!: Intake;
  private toolbar!: Toolbar;
  private inspector!: Inspector;

  /** True while the file could not be read: nothing may be written, and `getViewData` returns the text as it was. */
  readOnly = false;
  /**
   * The group the user has entered by double-clicking it, or null: presses then act on its direct children rather than
   * on whole top-level units. View state only, not saved; the pointer controller keeps it (see `PointerController`).
   */
  enteredGroup: NodeId | null = null;
  /** The tool that the next press on a page places (see `Command.place`), or null. A new document, or none, disarms it. */
  armedTool: Command | null = null;

  /** This view's settings that are not part of the figure (a tool's mode): see `viewOption`. */
  private readonly options = new Map<string, unknown>();

  /** The file text as `setViewData` received it. */
  private rawText = "";
  /** What the loaded document serialises to, to tell whether it has changed since the file was read. */
  private serializedAtLoad = "";
  /** A real document is loaded (not the blank stand-in). */
  private loaded = false;
  private errorEl: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The next loaded document is to be fitted to the stage once the stage has a size. */
  private needsFit = true;
  private fitFrame: number | null = null;
  /** The animation frame in which the chrome is next brought in line with the viewport (see `scheduleChrome`). */
  private chromeFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private spaceHeld = false;
  /** The pointer that is dragging the canvas, and where it was last seen (client coordinates). */
  private panning: { pointerId: number; x: number; y: number } | null = null;

  constructor(leaf: WorkspaceLeaf, readonly plugin: LinkFiguresPlugin) {
    super(leaf);
    this.watcher = new LinkWatcher(
      plugin.app,
      this.index,
      (ids) => {
        void this.nodeHost.resolve(ids);
      },
      () => missingNodeIds(this.store.doc.nodes, this.resolvedCache),
    );
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    const file = this.file;
    if (!file) return "Figure";
    return file.name.endsWith(FILE_SUFFIX) ? file.name.slice(0, -FILE_SUFFIX.length) : file.basename;
  }

  getIcon(): string {
    return "image";
  }

  async onOpen(): Promise<void> {
    this.ensureDom();
    this.wireStageInput();
    this.pointer.attach(this.stageEl);
    this.intake.attach(this.stageEl);
    // A stage that was hidden or not yet laid out when the document loaded is fitted once it has a size.
    this.resizeObserver = new ResizeObserver(() => this.fitWhenSized());
    this.resizeObserver.observe(this.stageEl);
    this.watcher.start(this);
    // Obsidian rewrites the Links section of a figure file when a source is renamed. `TextFileView` hands such a change
    // to `setViewData`, but this does not depend on that: whichever of the two sees it first applies it, the other finds nothing left to do.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === this.file?.path) void this.onExternalModify();
      }),
    );
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));
  }

  async onClose(): Promise<void> {
    this.pointer?.detach();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.fitFrame !== null) window.cancelAnimationFrame(this.fitFrame);
    this.fitFrame = null;
    if (this.chromeFrame !== null) window.cancelAnimationFrame(this.chromeFrame);
    this.chromeFrame = null;
  }

  getViewData(): string {
    if (this.readOnly) return this.rawText;
    // Nothing of ours is loaded: hand back what Obsidian holds rather than the stand-in document.
    if (!this.loaded) return this.data;
    const text = serializeFigureFile(this.store.doc, this.parsed);
    // An untouched figure goes back byte for byte, so merely opening a hand-edited file never reformats it.
    return text === this.serializedAtLoad ? this.rawText : text;
  }

  setViewData(data: string, clear: boolean): void {
    if (clear) this.clear();
    let loaded: ReturnType<typeof loadDocument>;
    try {
      loaded = loadDocument(data);
    } catch (error) {
      // Refuse to open, and with it to save: the file is shown as it is and never replaced by a default document.
      this.setDocument(blankDocument(), emptyParsed());
      this.loaded = false;
      this.showError(describeLoadError(error), data);
      return;
    }
    // The same file read again (not a different one, which comes with `clear`): when only link targets differ, the open figure is kept as it is.
    const reload = !clear && this.loaded && !this.readOnly;
    if (reload && this.adoptReload(data, loaded)) return;
    this.clearError();
    this.readOnly = false;
    this.setDocument(loaded.doc, loaded.parsed, reload);
    this.rawText = data;
    this.serializedAtLoad = serializeFigureFile(loaded.doc, loaded.parsed);
    this.loaded = true;
    this.scheduleFit();
  }

  /**
   * Takes up `data`, the text the file now has, without loading it anew when the open figure already is that figure,
   * or differs only in the link targets of its panels: selection, history and what is drawn stay. False when it is
   * anything else, which the caller loads.
   */
  private adoptReload(data: string, loaded: ReturnType<typeof loadDocument>): boolean {
    const kind = classifyReload({ doc: this.store.doc, parsed: this.parsed }, loaded);
    if (kind === "other") return false;
    if (kind === "links") this.reloadLinks(data);
    // The file is what the figure is now, so an untouched figure goes back byte for byte as it was read.
    this.rawText = data;
    this.serializedAtLoad = serializeFigureFile(this.store.doc, this.parsed);
    return true;
  }

  /**
   * Applies the link targets in the Links section of `text` to the open figure, for the nodes whose target differs: Obsidian
   * rewrites that section when a source file is renamed. Nothing else in `text` is read, and nothing else changes, so the
   * selection, the drawn panels and the undo history stay; a panel keeps showing what it showed until its new target is resolved.
   */
  reloadLinks(text: string): void {
    if (!this.loaded || this.readOnly) return;
    let links: ParsedFigureFile["links"];
    try {
      links = parseFigureFile(text).links;
    } catch {
      return; // Not a figure file that can be read: what is open stays, and `setViewData` is where that is reported.
    }
    this.parsed = { ...this.parsed, links };
    const { doc, changedIds } = applyLinkEntries(this.store.doc, links);
    // The store tells the node host, which resolves just these nodes, and the view does not save: the file already says this.
    if (changedIds.length > 0) this.store.replace(doc, "links", { keepHistory: true });
  }

  /**
   * A file in the vault was renamed. Obsidian rewrites the links of the figure's nodes (see `reloadLinks`), but a node that
   * is only in the undo history, such as a deleted panel, is in no file for it to rewrite: its link is rewritten here, so
   * that undo brings it back linked to the file's new name.
   */
  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    const figurePath = this.file?.path;
    if (!(file instanceof TFile) || !figurePath || !this.loaded || this.readOnly) return;
    const renames = renamedLinkFiles(oldPath, file.path, figurePath, this.plugin.access, (omitMd) =>
      this.app.metadataCache.fileToLinktext(file, figurePath, omitMd),
    );
    this.store.rebasePaths(renames);
  }

  /** The figure file was modified. Whoever wrote it, if it was not this view, its Links section may have been rewritten. */
  private async onExternalModify(): Promise<void> {
    const file = this.file;
    if (!file || !this.loaded || this.readOnly) return;
    let text: string;
    try {
      text = await this.app.vault.cachedRead(file);
    } catch {
      return;
    }
    if (this.file !== file) return;
    // This view's own save (Obsidian has recorded what it wrote in `data` by now), or a change that `setViewData` already took up.
    if (text === this.data || text === this.getViewData()) return;
    this.reloadLinks(text);
  }

  clear(): void {
    this.setDocument(blankDocument(), emptyParsed());
    this.loaded = false;
    this.readOnly = false;
    this.rawText = "";
    this.serializedAtLoad = "";
    // A file is about to be loaded (or none): whichever comes next starts from a fitted page, an edit reload of the same file does not.
    this.needsFit = true;
    this.clearError();
    this.renderChrome();
  }

  /** Replaces the stage content with a banner and the raw text, and makes the view read-only. */
  showError(message: string, raw: string): void {
    this.readOnly = true;
    this.rawText = raw;
    this.ensureDom();
    this.disarmTool();
    this.clearError();
    this.viewportEl.hide();
    const box = this.stageEl.createDiv({ cls: "lf-error" });
    box.createDiv({
      cls: "lf-error-banner",
      text: `This figure file could not be read: ${message}. It is shown as it is and will not be changed. Use "Open as markdown" to fix it.`,
      attr: { role: "alert" },
    });
    box.createEl("pre", { cls: "lf-error-raw", text: raw });
    this.errorEl = box;
    this.renderChrome();
  }

  // FigureViewLike. Stubs until the tasks named beside each one.

  selectedIds(): NodeId[] {
    return [...this.selection.ids];
  }

  /** The page whose centre is nearest the middle of the stage. */
  currentPage(): Page {
    const stage = this.stageSize();
    const middle = this.viewport.toWorld({ x: stage.width / 2, y: stage.height / 2 });
    return nearestPage(this.store.doc, middle) ?? this.store.doc.pages[0];
  }

  setSelection(ids: NodeId[]): void {
    this.pointer.select(ids);
  }

  fitPage(): void {
    this.fitPageTo(this.currentPage());
  }

  /** Sets the zoom (1 is 100%) and puts the current page in the middle of the stage. */
  zoomTo(z: number): void {
    const stage = this.stageSize();
    const rect = this.pageRect(this.currentPage());
    if (!rect || stage.width === 0 || stage.height === 0) return;
    this.viewport.centreOn({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, stage, z);
    this.applyViewport();
  }

  /**
   * Copies the viewport onto the DOM. A pan or a zoom can change which page is nearest the middle of the stage, and the
   * Page section of the inspector and the view commands act on that page (`focusPage`), so the chrome is drawn again too.
   */
  applyViewport(): void {
    this.viewportEl.style.transform = this.viewport.cssTransform();
    // For what is drawn on the pages but is sized in screen pixels (handles, outlines): see the selection rules in styles.css.
    this.viewportEl.style.setProperty("--lf-zoom", String(this.viewport.zoom));
    this.scheduleChrome();
  }

  /** Draws the toolbar and the inspector once in the next animation frame, however many times the viewport changes before it. */
  private scheduleChrome(): void {
    if (this.chromeFrame !== null) return;
    this.chromeFrame = window.requestAnimationFrame(() => {
      this.chromeFrame = null;
      this.renderChrome();
    });
  }

  /** A pointerdown that pans the canvas (middle button, or the left with the space bar held), which the pointer controller leaves alone. */
  isPanGesture(ev: PointerEvent): boolean {
    return ev.button === 1 || (ev.button === 0 && this.spaceHeld);
  }

  requestExport(): void {
    // A file that could not be read shows only the stand-in document, which is not the user's figure.
    if (!this.loaded) {
      new Notice("Link Figures: there is no figure to export.");
      return;
    }
    new ExportModal(this).open();
  }

  // What the commands, the toolbar and the inspector use.

  /** The page of the selected nodes when something is selected, else `currentPage()`: what page-level commands and the Page inspector act on. */
  focusPage(): Page {
    const nearest = this.currentPage();
    return pageInFocus(this.store.doc, this.selection.ids, nearest) ?? nearest;
  }

  /** Whether a figure is loaded (not the blank stand-in, nor a file that could not be read): what the API may act on. */
  hasDocument(): boolean {
    return this.loaded;
  }

  commandContext(): CommandContext {
    return { app: this.app, registries: this.plugin.registries, view: this, store: this.store, selection: this.selectedIds(), page: this.focusPage() };
  }

  /** Runs `command` on the current context, if it applies; a failure is shown to the user rather than lost. */
  runCommand(command: Command): void {
    const ctx = this.commandContext();
    if (this.readOnly || !command.applies(ctx)) return;
    this.attempt(command, () => command.run(ctx));
  }

  /**
   * Runs the registered command `id`. Without `args` as `runCommand` does (nothing when there is none); with them, as the
   * API runs a call on an open figure (checked against the command's params, an undo step of its own unless `step` says
   * otherwise: a drag's moves make one step), so that what a tool does through it is what a script does. A failure is
   * shown to the user rather than lost.
   */
  runCommandById(id: string, args?: Record<string, unknown>, step: UndoStep = "own"): void {
    const command = this.plugin.registries.commands.get(id);
    if (!command) return;
    if (args === undefined) {
      this.runCommand(command);
      return;
    }
    if (this.readOnly) return;
    this.attempt(command, () => runCall(this.store, this.commandContext(), prepareCall(this.plugin.registries, { id, args }), step));
  }

  /** Arms `command`, a tool, in place of any other; arming the armed tool again disarms it. Nothing is armed in a read-only view. */
  armTool(command: Command): void {
    if (this.readOnly || !(command.place || command.placeDrag)) return;
    this.setArmedTool(this.armedTool?.id === command.id ? null : command);
  }

  disarmTool(): void {
    this.setArmedTool(null);
  }

  /** The press of an armed tool on a page: the tool is disarmed, then placed at `at` (once), a failure shown as `runCommand` shows one. */
  placeTool(at: PlacePoint): void {
    const tool = this.armedTool;
    if (!tool?.place) return;
    this.disarmTool();
    const ctx = this.commandContext();
    this.attempt(tool, () => tool.place?.(ctx, at));
  }

  /**
   * The release of a drag of an armed tool (`placeDrag`): the tool is disarmed, then given the press and release points
   * on the press page and the items under them (once), a failure shown as `runCommand` shows one.
   */
  placeToolDrag(from: PlacePoint, to: PlacePoint, mods: { shift: boolean }, targets: DragTargets): void {
    const tool = this.armedTool;
    if (!tool?.placeDrag) return;
    this.disarmTool();
    const ctx = this.commandContext();
    this.attempt(tool, () => tool.placeDrag?.(ctx, from, to, mods, targets));
  }

  /** What the armed tool shows for the pointer at `to` (see `Command.preview`); null when it shows nothing of its own, or fails to say. */
  toolPreview(from: PlacePoint | null, to: PlacePoint, targets: DragTargets): ToolPreview | null {
    const tool = this.armedTool;
    if (!tool?.preview) return null;
    try {
      return tool.preview(this.commandContext(), from, to, targets);
    } catch (error) {
      console.error(`Link Figures: "${tool.name}" could not show its preview`, error);
      return null;
    }
  }

  viewOption(key: string): unknown {
    return this.options.get(key);
  }

  setViewOption(key: string, value: unknown): void {
    this.options.set(key, value);
    this.renderChrome();
  }

  /** What a double-click tells a node, from a command: an `lf-activate` event on its element (a text node starts editing). */
  activateNode(id: NodeId): void {
    this.nodeHost.elementFor(id)?.dispatchEvent(new CustomEvent("lf-activate", { bubbles: false }));
  }

  /** Does what `command` does; a failure, thrown or rejected, is shown to the user rather than lost. */
  private attempt(command: Command, action: () => unknown): void {
    const fail = (error: unknown): void => {
      console.error(`Link Figures: "${command.name}" failed`, error);
      new Notice(`Link Figures: "${command.name}" failed. ${error instanceof Error ? error.message : String(error)}`);
    };
    try {
      void Promise.resolve(action()).catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  /** The stage shows an armed tool by its cursor (`.lf-tool-armed` in styles.css), and the toolbar by its button. */
  private setArmedTool(tool: Command | null): void {
    if (tool === this.armedTool) return;
    // Arming a tool finishes crop mode.
    if (tool) this.pointer.finishCrop();
    this.armedTool = tool;
    this.stageEl.classList.toggle("lf-tool-armed", tool !== null);
    if (tool) this.stageEl.style.setProperty("--lf-tool-cursor", tool.cursor ?? "crosshair");
    else this.stageEl.style.removeProperty("--lf-tool-cursor");
    this.renderChrome();
  }

  /** The natural size of the image a node shows (waiting for it to load); rejects for a node that shows no image. */
  imageSize(id: NodeId): Promise<{ width: number; height: number }> {
    return this.nodeHost.naturalSize(id);
  }

  /** The natural size of the image a node shows if it has loaded; null while it has not, and for a node that shows none. */
  imageSizeNow(id: NodeId): { width: number; height: number } | null {
    return this.nodeHost.naturalSizeNow(id);
  }

  /** Whether node `id` shows an image now (see `ImageState`): `none` for a panel that shows only its badge. */
  imageStateNow(id: NodeId): ImageState | null {
    return this.nodeHost.imageStateNow(id);
  }

  /**
   * The decoded samples of the TIFF or raster image panel `id` shows, if they are cached; null otherwise. A null starts
   * their decode, and the toolbar and the inspector are drawn again when it lands (see `NodeHost.samplesNow`).
   */
  samplesNow(id: NodeId): Plane | null {
    return this.nodeHost.samplesNow(id);
  }

  private fontList: FontFamilyList | null = null;

  /** The installed font families for the Font menu; null until the list has arrived (it is asked for now, and the chrome is drawn once when it lands). */
  fontFamilies(): string[] | null {
    this.fontList ??= new FontFamilyList(this.plugin.registries, () => this.renderChrome());
    return this.fontList.get();
  }

  /** Samples asked for by `samplesNow` have been decoded: what asked for them (the inspector, a command's state) asks again. */
  samplesLanded(): void {
    this.renderChrome();
  }

  /** The URL the image a node shows was loaded from, if it has loaded; null otherwise (the crop ghost draws an outline then). */
  imageSourceNow(id: NodeId): string | null {
    return this.nodeHost.imageSourceNow(id);
  }

  /** Starts crop mode on the image panel `id` (a rotated panel shows a Notice instead). */
  startCrop(id: NodeId): void {
    this.pointer.startCrop(id);
  }

  /** Shows `message` to the user as a Notice. */
  notify(message: string): void {
    new Notice(message);
  }

  /** The Maximum page size setting, in millimetres. */
  pageLimitMm(): number {
    return this.plugin.settings?.maxPageSizeMm ?? DEFAULT_PAGE_LIMIT_MM;
  }

  /** Says that a page size was cut down to the limit. */
  notePageLimit(limitMm: number): void {
    new Notice(`Pages are limited to ${limitMm} mm on a side (Settings → Link Figures → Maximum page size).`);
  }

  /** Opens a link target from this figure's place in the vault, in a new tab when asked to (the badge on a node, and the Open source command). */
  openLink(linktext: string, newLeaf: PaneType | boolean = false): void {
    void this.app.workspace.openLinkText(linktext, this.file?.path ?? "", newLeaf);
  }

  /** Builds `.lf-view` once; `onOpen`, `showError` and `setDocument` all call it because `setViewData` may run before `onOpen`. */
  private ensureDom(): void {
    if (this.stageEl) return;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "lf-view" });
    this.toolbarEl = root.createDiv({ cls: "lf-toolbar" });
    const main = root.createDiv({ cls: "lf-main" });
    this.stageEl = main.createDiv({ cls: "lf-stage" });
    // Focusable by click and by tab, so the space bar and the editing keys reach the stage.
    this.stageEl.tabIndex = 0;
    this.viewportEl = this.stageEl.createDiv({ cls: "lf-viewport" });
    this.inspectorEl = main.createDiv({ cls: "lf-inspector" });
    this.pageLayer = new PageLayer(this.viewportEl);
    // Made here, not in `onOpen`, because this is what makes sure a page layer exists whichever of the two runs first.
    this.nodeHost = new NodeHost(this, this.pageLayer, this.plugin.registries);
    this.selection = new SelectionState();
    this.pointer = new PointerController(this);
    this.intake = new Intake(this);
    // Once per view: they read `store` when they render, so a new store needs nothing from them (`setDocument` re-renders).
    this.toolbar = new Toolbar(this, this.toolbarEl);
    this.inspector = new Inspector(this, this.inspectorEl, (message) => new Notice(message));
    this.selection.onChange(() => this.renderChrome());
    this.applyViewport();
  }

  /** Brings the toolbar and the inspector in line with the document and the selection. An edit must never fail because a panel could not draw. */
  private renderChrome(): void {
    try {
      this.toolbar.render();
      this.inspector.render();
    } catch (error) {
      console.error("Link Figures: could not draw the toolbar or the inspector", error);
    }
  }

  /** Wheel zoom and pan, and drag-to-pan with the middle button or the space bar. */
  private wireStageInput(): void {
    const stage = this.stageEl;
    // Not passive: zooming must stop the wheel from also doing what the page would do with it.
    this.registerDomEvent(stage, "wheel", (ev) => this.onWheel(ev), { passive: false });
    this.registerDomEvent(stage, "pointerdown", (ev) => this.onPointerDown(ev));
    this.registerDomEvent(stage, "pointermove", (ev) => this.onPointerMove(ev));
    this.registerDomEvent(stage, "pointerup", (ev) => this.endPan(ev));
    this.registerDomEvent(stage, "pointercancel", (ev) => this.endPan(ev));
    this.registerDomEvent(stage, "keydown", (ev) => this.onSpace(ev, true));
    this.registerDomEvent(stage, "keyup", (ev) => this.onSpace(ev, false));
    this.registerDomEvent(stage, "blur", () => this.setSpaceHeld(false));
  }

  private onWheel(ev: WheelEvent): void {
    if (this.errorEl) return; // the error text scrolls
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) this.viewport.zoomAt(this.stagePoint(ev), Math.exp(-ev.deltaY * WHEEL_ZOOM_RATE));
    else this.viewport.panBy(-ev.deltaX, -ev.deltaY);
    this.applyViewport();
  }

  private onPointerDown(ev: PointerEvent): void {
    if (this.errorEl || this.panning) return;
    if (!this.isPanGesture(ev)) return;
    ev.preventDefault();
    this.panning = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
    this.stageEl.setPointerCapture(ev.pointerId);
    this.stageEl.classList.add("lf-panning");
  }

  private onPointerMove(ev: PointerEvent): void {
    const pan = this.panning;
    if (!pan || ev.pointerId !== pan.pointerId) return;
    this.viewport.panBy(ev.clientX - pan.x, ev.clientY - pan.y);
    pan.x = ev.clientX;
    pan.y = ev.clientY;
    this.applyViewport();
  }

  private endPan(ev: PointerEvent): void {
    if (!this.panning || ev.pointerId !== this.panning.pointerId) return;
    this.panning = null;
    this.stageEl.classList.remove("lf-panning");
  }

  private onSpace(ev: KeyboardEvent, down: boolean): void {
    if (ev.code !== "Space" || this.errorEl) return;
    if (down) {
      if (isEditable(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      ev.preventDefault();
    }
    this.setSpaceHeld(down);
  }

  private setSpaceHeld(held: boolean): void {
    this.spaceHeld = held;
    this.stageEl.classList.toggle("lf-pan-ready", held);
  }

  /** A pointer position in stage pixels, which is what the viewport maps to and from. */
  stagePoint(ev: { clientX: number; clientY: number }): Pt {
    const box = this.stageEl.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  private stageSize(): { width: number; height: number } {
    return { width: this.stageEl?.clientWidth ?? 0, height: this.stageEl?.clientHeight ?? 0 };
  }

  private pageRect(page: Page | undefined): Rect | null {
    return page ? pageWorldRect(this.store.doc, page) : null;
  }

  private fitPageTo(page: Page | undefined): void {
    const rect = this.pageRect(page);
    if (!rect) return;
    this.viewport.fitRect(rect, this.stageSize());
    this.applyViewport();
  }

  private scheduleFit(): void {
    if (this.fitFrame !== null) return;
    this.fitFrame = window.requestAnimationFrame(() => {
      this.fitFrame = null;
      this.fitWhenSized();
    });
  }

  /** Fits the first page of a freshly loaded document, once; waits (for the next resize) while the stage has no size. */
  private fitWhenSized(): void {
    if (!this.needsFit || !this.loaded) return;
    const stage = this.stageSize();
    if (stage.width === 0 || stage.height === 0) return;
    const first = this.store.doc.pages[0];
    if (!first) return;
    this.needsFit = false;
    this.fitPageTo(first);
  }

  private clearError(): void {
    if (!this.errorEl) return;
    this.errorEl.remove();
    this.errorEl = null;
    this.viewportEl.show();
  }

  /**
   * Swaps in a fresh store and drops everything derived from the previous document. With `keepResolutions` (the same
   * file read again) what was resolved for a node whose link is the same is kept, and only the rest is resolved.
   */
  private setDocument(doc: Document, parsed: ParsedFigureFile, keepResolutions = false): void {
    this.ensureDom();
    // A tool armed for the document that was just replaced is not to land on this one.
    this.disarmTool();
    // An inspector gesture (a histogram drag) of the replaced document does not stamp this one's commits.
    this.gestureStartedAt = null;
    this.unsubscribe?.();
    if (!keepResolutions) this.nodeHost.reset();
    this.parsed = parsed;
    const store = createFigureStore(doc, this.plugin.registries, () => this.pointer.commitTime());
    this.store = store;
    // Nothing selected, in progress or drawn belongs to the document that was just replaced.
    this.selection.clear();
    this.pointer.rebind();
    this.pageLayer.render(store.doc);
    this.nodeHost.renderAll(store.doc);
    void this.nodeHost.resolveStale();
    this.unsubscribe = store.subscribe((ev) => {
      if (ev.pagesChanged) this.pageLayer.render(store.doc);
      // A `replace` names the nodes that differ, like an edit does; the node host resolves again only those whose link changed.
      this.nodeHost.applyChange(store.doc, ev.changedNodeIds);
      // TextFileView does not save on its own. `replace` is a reload, not an edit.
      if (ev.kind === "commit" || ev.kind === "undo" || ev.kind === "redo") this.requestSave();
      this.renderChrome();
    });
    this.renderChrome();
  }
}
