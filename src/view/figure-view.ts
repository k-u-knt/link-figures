import { Notice, TextFileView, TFile, type Menu, type PaneType, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type { EditorView } from "../commands/builtin";
import { prepareCall, runCall } from "../commands/headless";
import { LOADING_WAIT_MS } from "../api";
import { DEFAULT_PAGE_LIMIT_MM, FILE_SUFFIX, VIEW_TYPE } from "../constants";
import { ExportModal } from "../export/export-modal";
import { FontFamilyList } from "../fonts/family-list";
import { FormatError, NotFigureError } from "../format/errors";
import { applyLinkEntries, applyLinkEntriesOfType, classifyReload } from "../format/links-reload";
import { isLinkedType, linkOf, linktextOf, withLink } from "../format/node-links";
import { hookFailureReports, loadDocument } from "../format/load";
import { parseFigureFile, type ParsedFigureFile } from "../format/parse";
import { emptyParsed, serializeFigureFile } from "../format/serialize";
import { Intake } from "../links/intake";
import type { Plane } from "../links/decoders/tiff-convert";
import { InvalidationIndex, missingNodeIds } from "../links/invalidation";
import { afterLinkUpdates, hasLinkUpdateQueue } from "../links/link-updates";
import { renamedLinkFiles } from "../links/resolver";
import type { Resolved } from "../links/types";
import { renameLinksInStore } from "../links/card-renames";
import { vaultLinktext } from "../links/linktext";
import { LinkWatcher } from "../links/watcher";
import type LinkFiguresPlugin from "../main";
import { createDocument } from "../model/defaults";
import type { PlacePoint, Pt, Rect } from "../model/geometry";
import { createFigureStore } from "../model/normalise";
import { DocumentStore } from "../model/store";
import type { Document, Node as FigureNode, NodeId, Page, PageId } from "../model/types";
import type { Command, CommandContext, DragTargets, MenuPlace, ToolPreview, UndoStep } from "../registry/command";
import type { ImageState, LinkRename, NodeType } from "../registry/node-type";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { settlesWithin } from "../util/event-loop";
import { showContextMenu } from "./context-menu";
import { Inspector } from "./inspector";
import { ItemBar, wireItemBar, type ItemBarWiring } from "./item-bar";
import { NodeHost } from "./node-host";
import { PageLayer } from "./page-layer";
import { isEditable, PointerController } from "./pointer";
import { SelectionState } from "./selection";
import { Toolbar } from "./toolbar";
import { scrollsUnderWheel } from "./wheel";
import { focusPageOf, nearestPage, pageInFocus, pageWorldRect, Viewport } from "./viewport";

/** What stands in for a document while none is loaded, so `store` is never undefined. It is never written to a file. */
const blankDocument = (): Document => createDocument(DEFAULT_SETTINGS.defaultPreset);

/** Wheel zoom: one unit of `deltaY` scales the zoom by `exp(-0.01)`, which suits a trackpad pinch (a ctrl+wheel). */
const WHEEL_ZOOM_RATE = 0.01;

/** Why `text` does not load as a figure, or null when it does. */
function unreadableReason(text: string, registries: LinkFiguresPlugin["registries"]): string | null {
  try {
    loadDocument(text, registries);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

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
  /** The bar above the one selected card (see `ItemBar`), in the stage's screen space, and its hooks (`wireItemBar`). */
  private itemBar!: ItemBarWiring;

  /** True while the file could not be read: nothing may be written, and `getViewData` returns the text as it was. */
  readOnly = false;
  /**
   * Obsidian's TextFileView (not in its typings): when the file changes on disk while the view has an edit not yet
   * saved, a plain-text view merges base, ours and theirs line by line, which for the figure's JSON can give two node
   * objects with no comma between them. A figure is not plain text: the view takes up the file as it is instead.
   */
  isPlaintext = false;
  /**
   * The group the user has entered by double-clicking it, or null: presses then act on its direct children rather than
   * on whole top-level units. View state only, not saved; the pointer controller keeps it (see `PointerController`).
   */
  enteredGroup: NodeId | null = null;
  /** The tool that the next press on a page places (see `Command.place`), or null. A new document, or none, disarms it. */
  armedTool: Command | null = null;

  /**
   * The page a right-click on its paper focused (see `openContextMenu`), or null: with nothing selected, page-level
   * commands, Fit page and the Page inspector act on it rather than on the page nearest the middle of the stage. A pan,
   * a zoom or a press of the left button lets go of it.
   */
  private pinnedPage: PageId | null = null;

  /** A context menu is open (see `showContextMenu`): the stage's Escape leaves the selection alone. */
  contextMenuOpen = false;
  /** The menu that set `contextMenuOpen` (see `showContextMenu`). */
  contextMenu: Menu | null = null;

  /** This view's settings that are not part of the figure (a tool's mode): see `viewOption`. */
  private readonly options = new Map<string, unknown>();

  /**
   * The nodes a plugin's `migrate` hook could not read when the figure was loaded (see `HookFailure`): drawn, inspected
   * and pressed as placeholders, whatever type is registered for them, and saved as the file has them; copies of them
   * join it (`markUnreadable`), and it only grows until the next load, so undo and redo of a copy keep it right. It is
   * the store's own set (`DocumentStore.unreadable`), so the store's normalisers skip their type's hooks too.
   */
  get unreadableNodes(): Set<NodeId> {
    return this.store.unreadable;
  }

  /** The file whose text the last `setViewData` took up (or could not read): while `file` is another, the view is loading. */
  private loadedFile: unknown = null;
  /** The view has closed: it is never loading again (`isLoading`), though Obsidian may not have cleared its file yet. */
  private closed = false;
  /** What `whenLoaded` waits on: resolved when `setViewData` has run, or the view closes. */
  private loadWaiters: (() => void)[] = [];

  /** The view has edits that no save has taken yet (an edit, undo or redo since the last load or save). */
  private unsaved = false;
  /**
   * The text the file has as far as the view knows: what it last took up from the file, or last saved. A text read
   * from the file that differs from it only in its links is a link update (a rename), which the view's unsaved edits
   * survive (see `adoptLinkUpdate`).
   */
  private diskText = "";
  /**
   * The renames of files the open figure links to since its file was last read, as `renamedLinkFiles` gives them: a
   * save first takes up what Obsidian's link update for them wrote (`takeUpBeforeSave`).
   */
  private renamesSinceRead = new Map<string, string>();
  /**
   * The renames whose link update (the job of Obsidian's update queue that the rename is part of) has not ended yet:
   * the window in which a text that does not load is taken for that update's damage and repaired (`repairLinkUpdate`).
   * Emptied by a job queued after it (`endLinkUpdate`), so a link update the user declined ("Do not update") closes it
   * too. Without Obsidian's queue, the next text the view takes up from the file closes it.
   */
  private linkUpdateRenames = new Map<string, string>();
  /** An `endLinkUpdate` is queued. */
  private linkUpdateEndQueued = false;
  /** Damaged texts already repaired or being repaired: the same text delivered again (a late reload) is not news. */
  private readonly repairedTexts = new Set<string>();
  /** A damaged text is being backed up and the figure readied to replace it: a save waits for it (`repair`). */
  private repairing: Promise<boolean> | null = null;
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

  /**
   * Whether the view has a file that its text has not yet been handed to it for (Obsidian is reading it): an API call
   * waits for it (`whenLoaded`) before it decides between the view and the file.
   */
  isLoading(): boolean {
    return !this.closed && this.file !== null && this.loadedFile !== this.file;
  }

  /**
   * The `onLoadFile` that is running, or null: the loading ends when it does, not at a `setViewData` that comes in
   * during it. A newer one (the leaf switched to another file) takes over, and the older ends nothing.
   */
  private currentLoad: object | null = null;

  /**
   * As Obsidian's (it reads the file and calls `setViewData`), once the plugin's own writes of the file that are in flight
   * have landed (an API call that went to the file just before this view opened), or `LOADING_WAIT_MS` has passed: read
   * before one lands, the view would hold the text it replaces, and its next edit would be saved over it. A load that a
   * newer one has overtaken (the leaf switched files meanwhile) reads nothing. The loading ends whatever happens, a failed
   * read too, and only then, so no API call runs in the view before the text it keeps is loaded.
   */
  async onLoadFile(file: TFile): Promise<void> {
    const load = {};
    this.currentLoad = load;
    try {
      const writes = this.plugin.figureWrites.settled(file.path);
      if (writes) await settlesWithin(writes, LOADING_WAIT_MS);
      if (this.currentLoad !== load || this.file !== file) return;
      await super.onLoadFile(file);
    } finally {
      if (this.currentLoad === load) {
        this.currentLoad = null;
        this.settleLoad();
      }
    }
  }

  /** Resolves once the view is not loading (see `isLoading`): its file's text set, or the view closed. */
  whenLoaded(): Promise<void> {
    if (!this.isLoading()) return Promise.resolve();
    return new Promise((resolve) => this.loadWaiters.push(resolve));
  }

  /** The view has taken up its file's text (or will not): whoever waits for it to load goes on. */
  private settleLoad(): void {
    this.loadedFile = this.file;
    const waiters = this.loadWaiters;
    this.loadWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async onClose(): Promise<void> {
    this.pointer?.detach();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.fitFrame !== null) window.cancelAnimationFrame(this.fitFrame);
    this.fitFrame = null;
    if (this.chromeFrame !== null) window.cancelAnimationFrame(this.chromeFrame);
    this.chromeFrame = null;
    this.closed = true;
    const waiters = this.loadWaiters;
    this.loadWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * As Obsidian's, but the view never writes what the plugin could not read back: nothing while the file could not be
   * read (it is shown as it is and not changed), and a text that does not load as a figure is refused, the file kept as
   * it was, with a Notice.
   */
  async save(clear?: boolean): Promise<void> {
    if (this.readOnly) return;
    // After Obsidian's link updates under way (a rename whose "Update links" prompt is open): they splice their links
    // in at the offsets the file had when they began, and a save landing in between would leave those offsets stale.
    // Queued even from inside a link update's own job, which never waits on the save.
    return afterLinkUpdates(this.app, () => this.saveNow(clear), { alwaysQueue: true });
  }

  /** `save`'s work, once no link update is under way. */
  private async saveNow(clear?: boolean): Promise<void> {
    // Nothing over a damaged file before its backup is written: the save waits for it, then writes the repaired
    // figure, or nothing when the figure is held (no backup: `repair`).
    if (this.repairing) await this.repairing;
    if (this.readOnly) return;
    if (!this.loaded) return super.save(clear);
    if (await this.takeUpBeforeSave(clear)) return;
    const text = this.getViewData();
    const problem = unreadableReason(text, this.plugin.registries);
    if (problem !== null) {
      const message = `Link Figures: ${this.file?.path ?? "the figure"} was not saved: what would be written could not be read back as a figure (${problem}). The file is kept as it was.`;
      console.error(message);
      new Notice(message);
      return;
    }
    // What is saved from here is no longer unsaved (an edit made while the write is under way sets it again).
    this.unsaved = false;
    const file = this.file;
    // Obsidian's save asks for the text again: it gets this one, serialised once.
    this.savingText = text;
    try {
      await super.save(clear);
    } finally {
      this.savingText = null;
    }
    if (!clear) this.diskText = text;
    if (!clear && file) await this.checkAfterSave(file, text);
  }

  /**
   * Takes up a change of the file the view has not seen yet, before a save writes over it: Obsidian's link update,
   * which the save waited for (see `save`), lands just before it, while Obsidian's own reload of the view is still
   * reading the file. Taken up as any reload is (a link update keeps the unsaved edits: `adoptLinkUpdate`). True when
   * this save is then not to write: the edits that are left are saved by a later save (`requestSave`), once that
   * reload has come and found the view up to date, as a write now would be followed by the reload's stale text. A
   * save that closes the view writes at once.
   */
  private async takeUpBeforeSave(clear?: boolean): Promise<boolean> {
    const file = this.file;
    // Only after a rename of something the figure links to, which the view has not seen the file's update for yet.
    if (!file || this.renamesSinceRead.size === 0) return false;
    let disk: string;
    try {
      disk = await this.app.vault.read(file);
    } catch {
      return false;
    }
    if (this.file !== file || !this.loaded || this.readOnly || disk === this.diskText) return false;
    const internals = this as unknown as { lastSavedData?: string | null };
    if ("lastSavedData" in internals) internals.lastSavedData = disk;
    this.data = disk;
    this.setViewData(disk, false);
    if (clear || !this.loaded || this.readOnly) return false;
    if (this.unsaved) this.requestSave();
    return true;
  }

  /**
   * Obsidian does not hand the view a change that lands while its own write is under way (a sync): the file is read
   * again after the save, and a text other than the one saved is taken up as a change from outside, the user told.
   */
  private async checkAfterSave(file: TFile, saved: string): Promise<void> {
    let disk: string;
    try {
      disk = await this.app.vault.read(file);
    } catch {
      return;
    }
    if (this.file !== file || !this.loaded || this.readOnly || disk === saved || disk === this.data) return;
    // Obsidian's record of the file is brought in line too, so its next save and reload compare against this text.
    const internals = this as unknown as { lastSavedData?: string | null };
    if ("lastSavedData" in internals) internals.lastSavedData = disk;
    this.data = disk;
    // The saved edits are what this text replaces.
    this.unsaved = true;
    this.setViewData(disk, false);
  }

  /** The text `save` is writing, which `getViewData` gives while it does (see `save`). */
  private savingText: string | null = null;

  getViewData(): string {
    if (this.savingText !== null) return this.savingText;
    if (this.readOnly) return this.rawText;
    // Nothing of ours is loaded: hand back what Obsidian holds rather than the stand-in document.
    if (!this.loaded) return this.data;
    const text = serializeFigureFile(this.store.doc, this.parsed);
    // An untouched figure goes back byte for byte, so merely opening a hand-edited file never reformats it.
    return text === this.serializedAtLoad ? this.rawText : text;
  }

  setViewData(data: string, clear: boolean): void {
    // Whatever happens in it, a throw included, the loading ends (unless an `onLoadFile` that ends it is still running):
    // an API call waiting for it goes on.
    try {
      this.takeUpViewData(data, clear);
    } finally {
      if (this.currentLoad === null) this.settleLoad();
    }
  }

  /** `setViewData`'s work: loads `data`, or takes it up as a reload of the same file. */
  private takeUpViewData(data: string, clear: boolean): void {
    if (clear) this.clear();
    let loaded: ReturnType<typeof loadDocument>;
    try {
      loaded = loadDocument(data, this.plugin.registries);
    } catch (error) {
      // A damaged text already being repaired (or held over), read again: the open figure stays.
      if (!clear && this.loaded && this.repairedTexts.has(data)) return;
      if (!clear && this.loaded && !this.readOnly && this.repairLinkUpdate(data, error)) return;
      // Refuse to open, and with it to save: the file is shown as it is and never replaced by a default document.
      this.setDocument(blankDocument(), emptyParsed());
      this.loaded = false;
      this.showError(describeLoadError(error), data);
      return;
    }
    // The same file read again (not a different one, which comes with `clear`): when only link targets differ, the open figure is kept as it is.
    const reload = !clear && this.loaded && !this.readOnly;
    if (reload && this.adoptReload(data, loaded)) return;
    if (reload && this.unsaved && this.adoptLinkUpdate(data, loaded)) return;
    // The file's version replaces the open figure: edits not yet saved are gone, and the user is told, whoever wrote it
    // (the plugin's own calls go to the view, so its write landing here is unexpected too).
    if (reload && this.unsaved && this.file) {
      const message = `Link Figures: "${this.file.path}" was changed outside this view; your unsaved edits were replaced by the file's version.`;
      console.warn(message);
      new Notice(message);
    }
    this.unsaved = false;
    this.clearError();
    this.readOnly = false;
    // Said once per type as the figure opens, not again each time the file is read back.
    if (!reload) {
      for (const report of hookFailureReports(loaded.hookFailures)) {
        new Notice(report);
        console.warn(report);
      }
    }
    this.setDocument(loaded.doc, loaded.parsed, reload, loaded.unreadable);
    this.rawText = data;
    this.diskText = data;
    this.tookUpFromFile();
    // The store's document, normalised: a file that only the normalisers would change is not rewritten by opening it
    // (and closing it, which saves), as a headless call does not rewrite it.
    this.serializedAtLoad = serializeFigureFile(this.store.doc, this.parsed);
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
    // Over unsaved edits, only the links the file changed since it was read, three ways (a relink of the user's stays).
    if (kind === "links" && this.unsaved && this.adoptLinkUpdate(data, loaded)) return true;
    if (kind === "links") this.reloadLinks(data);
    // The file is what the figure is now, so an untouched figure goes back byte for byte as it was read.
    this.rawText = data;
    this.diskText = data;
    this.tookUpFromFile();
    this.serializedAtLoad = serializeFigureFile(this.store.doc, this.parsed);
    return true;
  }

  /**
   * Takes up `data` over unsaved edits when it differs from the text the view last knew the file to have
   * (`diskText`) only in link targets: Obsidian's link update for a rename, landing before the view's save. The nodes
   * whose link it changed take the new link, and the edits stay, to be saved; nothing else is read. False for any
   * other change, which the caller loads over the edits (and says so).
   */
  private adoptLinkUpdate(data: string, loaded: ReturnType<typeof loadDocument>): boolean {
    let base: ReturnType<typeof loadDocument>;
    try {
      base = loadDocument(this.diskText, this.plugin.registries);
    } catch {
      return false;
    }
    const kind = classifyReload(base, loaded);
    if (kind === "other") return false;
    const was = new Map(base.doc.nodes.map((n) => [n.id, n]));
    const mine = new Map(this.store.doc.nodes.map((n) => [n.id, linktextOf(n)]));
    const renames = new Map([...this.renamesSinceRead, ...this.linkUpdateRenames]);
    // Three ways: a node takes the file's new link only when its link in the view is still the one the file had (or
    // that one renamed); a node the user has linked elsewhere since keeps the user's link, to be saved.
    const now = new Map<NodeId, string>();
    for (const n of loaded.doc.nodes) {
      const before = was.get(n.id);
      if (!before || linktextOf(before) === linktextOf(n)) continue;
      const current = mine.get(n.id);
      if (current === linktextOf(before) || current === linktextOf(renamedLink(before, renames))) now.set(n.id, linktextOf(n));
    }
    // A node of a type not known here keeps its entry as the file has it.
    const entries = new Map(loaded.parsed.links.map((e) => [e.id, e]));
    this.parsed = { ...this.parsed, links: this.parsed.links.map((e) => (now.has(e.id) || !isLinkedType(this.store.doc.nodes.find((n) => n.id === e.id)?.type ?? "") ? (entries.get(e.id) ?? e) : e)) };
    const doc = this.store.doc;
    const nodes = doc.nodes.map((n) => (now.has(n.id) ? withLink(n, now.get(n.id)) : n));
    if (nodes.some((n, i) => n !== doc.nodes[i])) this.store.replace({ ...doc, nodes }, "links", { keepHistory: true });
    this.rawText = data;
    this.diskText = data;
    this.tookUpFromFile();
    this.serializedAtLoad = serializeFigureFile(createFigureStore(loaded.doc, this.plugin.registries, undefined, loaded.unreadable).doc, loaded.parsed);
    return true;
  }

  /** The view took up a text read from its file: what was renamed before it is in it (or was declined). */
  private tookUpFromFile(): void {
    this.renamesSinceRead.clear();
    // Without Obsidian's queue there is no telling when a link update ends: this is as near as the view gets.
    if (!hasLinkUpdateQueue(this.app)) this.linkUpdateRenames.clear();
  }

  /**
   * The file was rewritten into a text that does not load (`error`) while Obsidian's link update for a rename of a
   * file the figure links to is under way (`linkUpdateRenames`): it spliced its links in at offsets that a write since
   * had made stale (one that did not wait for it: see `save`). The open figure is still whole, so it is written back
   * over the damage, with the renamed links the update meant to write, once the damaged text is backed up beside the
   * figure (`repair`). False outside that window, for the caller to show the file as it is.
   */
  private repairLinkUpdate(damaged: string, error: unknown): boolean {
    if (this.linkUpdateRenames.size === 0) return false;
    this.repairedTexts.add(damaged);
    void this.repair(damaged, error, new Map(this.linkUpdateRenames));
    return true;
  }

  /**
   * `repairLinkUpdate`'s work: the damaged text is written to `<figure> (damaged <date time>).md` beside the figure,
   * and only then is the figure saved over it, the user told where the damaged text is. A save asked for meanwhile
   * (closing the figure included) waits for this (`repairing`), so unsaved edits are not lost. A file that cannot be
   * backed up is never overwritten: the intact figure is kept open but held (read-only, never saved), and the user
   * told.
   */
  private async repair(damaged: string, error: unknown, renames: ReadonlyMap<string, string>): Promise<void> {
    const work = this.backUpAndTakeOver(damaged, error, renames);
    this.repairing = work;
    let repaired = false;
    try {
      repaired = await work;
    } finally {
      if (this.repairing === work) this.repairing = null;
    }
    if (repaired) void this.save();
  }

  /** `repair` up to its save: true when the view now holds what is to be saved over the damaged file. */
  private async backUpAndTakeOver(damaged: string, error: unknown, renames: ReadonlyMap<string, string>): Promise<boolean> {
    const file = this.file;
    if (!file) return false;
    let backup: string | null = null;
    try {
      backup = await this.writeBackup(file, damaged);
    } catch (failure) {
      console.error(`Link Figures: could not back up the damaged "${file.path}"`, failure);
    }
    if (this.file !== file || !this.loaded || this.readOnly) return false;
    if (backup === null) {
      // Held: the figure stays as it is in memory, for the user to copy from, and nothing writes the file.
      this.readOnly = true;
      this.rawText = damaged;
      this.disarmTool();
      this.renderChrome();
      const message = `Link Figures: "${file.path}" was damaged on disk and could not be backed up; it is kept open here and not saved. Copy what you need, or fix the folder and reopen.`;
      console.error(message, describeLoadError(error));
      new Notice(message);
      return false;
    }
    const doc = this.store.doc;
    const nodes = doc.nodes.map((n) => renamedLink(n, renames));
    if (nodes.some((n, i) => n !== doc.nodes[i])) this.store.replace({ ...doc, nodes }, "links", { keepHistory: true });
    // Whatever the view holds is written: never the damaged text, nor the text as first read. The damaged text is
    // what the file has, so the save does not take it up again (`takeUpBeforeSave`).
    this.serializedAtLoad = "";
    this.diskText = damaged;
    this.unsaved = true;
    const message = `Link Figures: "${file.path}" was damaged by a link update after a rename (${describeLoadError(error)}); it was repaired from the open figure. The damaged text is in "${backup}".`;
    console.error(message);
    new Notice(message);
    return true;
  }

  /**
   * Writes `text` to a new file beside `file`, `<name> (damaged <yyyy-mm-dd hh-mm-ss>).md` (or the next free name, as
   * Obsidian's `getAvailablePath` gives it: a name that is taken is no reason to fail), and gives its path.
   */
  private async writeBackup(file: TFile, text: string): Promise<string> {
    const base = file.name.endsWith(FILE_SUFFIX) ? file.name.slice(0, -FILE_SUFFIX.length) : file.name.replace(/\.md$/i, "");
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
    const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
    const stem = `${folder}${base} (damaged ${stamp})`;
    const vault = this.app.vault as typeof this.app.vault & { getAvailablePath?(path: string, extension: string): string };
    const taken = (path: string) => this.app.vault.getAbstractFileByPath(path) !== null;
    let path = typeof vault.getAvailablePath === "function" ? vault.getAvailablePath(stem, "md") : `${stem}.md`;
    for (let n = 1; typeof vault.getAvailablePath !== "function" && taken(path); n++) path = `${stem} ${n}.md`;
    await this.app.vault.create(path, text);
    return path;
  }

  /**
   * The link update the renames were part of has ended (a job of Obsidian's queue after it), applied or declined: the
   * window for repairs closes. A damaged text it left that the view has not been handed yet (Obsidian's reload is
   * still reading) is repaired now; when it comes, it is known (`repairedTexts`).
   */
  private async endLinkUpdate(): Promise<void> {
    this.linkUpdateEndQueued = false;
    const file = this.file;
    try {
      if (!file || !this.loaded || this.readOnly || this.linkUpdateRenames.size === 0) return;
      const disk = await this.app.vault.read(file);
      if (this.file !== file || disk === this.diskText || this.repairedTexts.has(disk)) return;
      try {
        loadDocument(disk, this.plugin.registries);
      } catch (error) {
        this.repairedTexts.add(disk);
        await this.repair(disk, error, new Map(this.linkUpdateRenames));
      }
    } catch {
      // The file could not be read: there is nothing to repair from here.
    } finally {
      this.linkUpdateRenames.clear();
    }
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
   * A node type was registered (`NodeTypeRegistry.onRegister`). One that keeps its link in the Links section
   * (`linkField`), registered after this figure was loaded, found its nodes read without their links: they take them
   * from the file's Links entries now (`applyLinkEntriesOfType`), as a links reload does, so the next save keeps them.
   */
  typeRegistered(type: Pick<NodeType, "type" | "linkField">): void {
    if (!this.loaded || this.readOnly || !type.linkField) return;
    const { doc, changedIds } = applyLinkEntriesOfType(this.store.doc, this.parsed.links, type.type);
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
    this.renameUnsavedLinks(renames);
    // Kept for a link update that leaves the file unreadable (`repairLinkUpdate`): only renames of what it links to.
    const linked = new Set(this.store.doc.nodes.flatMap((n) => linkOf(n)?.file ?? []));
    let touched = false;
    for (const [from, to] of renames) {
      if (!linked.has(from)) continue;
      this.renamesSinceRead.set(from, to);
      this.linkUpdateRenames.set(from, to);
      touched = true;
    }
    // The window for repairs closes when the rename's link update ends: a job queued now runs after it.
    if (touched && !this.linkUpdateEndQueued && hasLinkUpdateQueue(this.app)) {
      this.linkUpdateEndQueued = true;
      void afterLinkUpdates(this.app, () => this.endLinkUpdate(), { alwaysQueue: true });
    }
  }

  /**
   * Renames the links of the open figure's nodes that the file does not hold yet (a card or panel made, or relinked,
   * since the last save): Obsidian rewrites only the links its metadata cache has of the file, so these would keep
   * the old name and be saved stale. A link the file holds as the view has it is left to Obsidian's link update (and
   * to the user's answer to its prompt), which the view then takes up (`adoptReload`, `adoptLinkUpdate`).
   */
  private renameUnsavedLinks(renames: ReadonlyMap<string, string>): void {
    if (renames.size === 0) return;
    let onDisk: Map<NodeId, string>;
    try {
      onDisk = new Map(loadDocument(this.diskText, this.plugin.registries).doc.nodes.map((n) => [n.id, linktextOf(n)]));
    } catch {
      onDisk = new Map();
    }
    const doc = this.store.doc;
    const nodes = doc.nodes.map((n) => (onDisk.get(n.id) === linktextOf(n) ? n : renamedLink(n, renames)));
    if (nodes.some((n, i) => n !== doc.nodes[i])) this.store.replace({ ...doc, nodes }, "links", { keepHistory: true });
  }

  /**
   * A file was renamed that links the nodes hold in their own fields may lead to (a text card's `[[…]]`, which no Links
   * section holds for Obsidian to rewrite), as the plugin follows it after Obsidian's link update
   * (`links/card-renames.ts`): the document and its undo history are rewritten in place, not as an undo step, an open
   * card editor's text too (what was typed stays), and the figure is saved.
   */
  renameLinks(rename: LinkRename): void {
    if (!this.loaded || this.readOnly) return;
    const changed = renameLinksInStore(this.store, this.plugin.registries, rename);
    this.nodeHost.renameLinks(rename);
    if (!changed) return;
    this.unsaved = true;
    this.requestSave();
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
    this.diskText = "";
    this.renamesSinceRead.clear();
    this.linkUpdateRenames.clear();
    this.repairedTexts.clear();
    this.serializedAtLoad = "";
    this.unsaved = false;
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
    this.fitPageTo(focusPageOf(this.pinnedPage, this.store.doc.pages, this.currentPage()));
  }

  /** Sets the zoom (1 is 100%) and puts the current page (or the page a right-click focused) in the middle of the stage. */
  zoomTo(z: number): void {
    const stage = this.stageSize();
    const rect = this.pageRect(focusPageOf(this.pinnedPage, this.store.doc.pages, this.currentPage()));
    if (!rect || stage.width === 0 || stage.height === 0) return;
    this.viewport.centreOn({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, stage, z);
    this.applyViewport();
  }

  /**
   * Copies the viewport onto the DOM. A pan or a zoom can change which page is nearest the middle of the stage, and the
   * Page section of the inspector and the view commands act on that page (`focusPage`), so the chrome is drawn again too.
   */
  applyViewport(): void {
    // The page now in the middle is the one in focus, not one a right-click focused before.
    this.pinnedPage = null;
    this.viewportEl.style.transform = this.viewport.cssTransform();
    // For what is drawn on the pages but is sized in screen pixels (handles, outlines): see the selection rules in styles.css.
    this.viewportEl.style.setProperty("--lf-zoom", String(this.viewport.zoom));
    // The item bar is in screen space: it follows a pan or a zoom at once, not a frame later.
    if (this.store) this.itemBar?.viewportApplied();
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
    // An export dialog already open is focused, not stacked on.
    ExportModal.show(this);
  }

  // What the commands, the toolbar and the inspector use.

  /** The page of the selected nodes when something is selected, else `currentPage()`: what page-level commands and the Page inspector act on. */
  focusPage(): Page {
    const nearest = focusPageOf(this.pinnedPage, this.store.doc.pages, this.currentPage());
    return pageInFocus(this.store.doc, this.selection.ids, nearest) ?? nearest;
  }

  /**
   * Opens the context menu for `where` (see `MenuPlace`) at `at`, a client point, or at the middle of the stage when
   * null (from the keyboard). A page menu focuses `page` (else the focus page stays as it is) for the commands it runs.
   * The pointer controller has already adjusted the selection.
   */
  openContextMenu(where: MenuPlace, at: Pt | null, page: PageId | null): void {
    if (this.readOnly) return;
    // Each opening decides it afresh: a page menu pins its page, any other menu none, so it cannot outlive its menu.
    const pinned = where === "page" ? page : null;
    if (pinned !== this.pinnedPage) {
      this.pinnedPage = pinned;
      this.renderChrome();
    }
    const box = this.stageEl.getBoundingClientRect();
    showContextMenu(this, where, at ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 });
  }

  /** The client point (as a pointer event gives it) of world point `world`. */
  clientPointOf(world: Pt): Pt {
    const box = this.stageEl.getBoundingClientRect();
    const screen = this.viewport.toScreen(world);
    return { x: box.left + screen.x, y: box.top + screen.y };
  }

  /** Whether a figure is loaded (not the blank stand-in, nor a file that could not be read): what the API may act on. */
  hasDocument(): boolean {
    return this.loaded;
  }

  /** Adds copies of unreadable nodes to `unreadableNodes` (see `FigureViewLike.markUnreadable`). */
  markUnreadable(ids: NodeId[]): void {
    for (const id of ids) this.unreadableNodes.add(id);
  }

  commandContext(): CommandContext {
    return {
      app: this.app,
      registries: this.plugin.registries,
      view: this,
      store: this.store,
      selection: this.selectedIds(),
      page: this.focusPage(),
      unreadable: this.unreadableNodes,
      markUnreadable: (ids) => this.markUnreadable(ids),
      linktext: (file) => vaultLinktext(this.app, file, this.file?.path ?? ""),
    };
  }

  /** Runs `command` on the current context, if it applies; a failure is shown to the user rather than lost. */
  runCommand(command: Command): void {
    const ctx = this.commandContext();
    // A read-only view runs only what changes nothing (`Command.readOnlySafe`: Open source).
    if ((this.readOnly && !command.readOnlySafe) || !command.applies(ctx)) return;
    // An undo step of its own, as a call's is (see `runCall`): it neither merges into the edit before it nor takes in the next.
    this.store.endMerge();
    this.attempt(command, () => command.run(ctx));
    this.store.endMerge();
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
   * A tool chosen from a context menu that is placed from one (`Command.placeFromMenu`): placed at the client point `at`,
   * where the menu was opened, as a press there would place it (`PointerController.toolPointAt`). Nothing happens where
   * the tool would be put down. A failure is shown as `runCommand` shows one.
   */
  placeToolAt(id: string, at: Pt): void {
    const tool = this.plugin.registries.commands.get(id);
    if (this.readOnly || !tool?.place || !tool.applies(this.commandContext())) return;
    const point = this.pointer.toolPointAt(tool, this.viewport.toWorld(this.stagePoint({ clientX: at.x, clientY: at.y })));
    if (!point) return;
    this.setArmedTool(tool);
    this.placeTool(point);
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
    // Brought in line by a card's edit and by the pointer's gestures as well as by the chrome (see `wireItemBar`).
    this.itemBar = wireItemBar(this, new ItemBar(this.stageEl), { stage: this.stageEl, gestures: this.pointer });
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
    if (this.store) this.itemBar?.sync();
  }

  /** Whether a drag, a resize or a tool's drag is under way (the item bar hides meanwhile). */
  gestureUnderWay(): boolean {
    return this.pointer?.busy() ?? false;
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
    // A zoom is always the canvas's; a card's editor (or any box that scrolls) takes the wheel while it has room to.
    if (!ev.ctrlKey && !ev.metaKey && scrollsUnderWheel(ev.target, this.stageEl, ev.deltaX, ev.deltaY)) return;
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) this.viewport.zoomAt(this.stagePoint(ev), Math.exp(-ev.deltaY * WHEEL_ZOOM_RATE));
    else this.viewport.panBy(-ev.deltaX, -ev.deltaY);
    this.applyViewport();
  }

  private onPointerDown(ev: PointerEvent): void {
    // A press of the left button is a new focus: the page a right-click focused is let go of.
    if (ev.button === 0) this.pinnedPage = null;
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
  private setDocument(doc: Document, parsed: ParsedFigureFile, keepResolutions = false, unreadable: Iterable<NodeId> = []): void {
    this.ensureDom();
    // A tool armed for the document that was just replaced is not to land on this one.
    this.disarmTool();
    // An inspector gesture (a histogram drag) of the replaced document does not stamp this one's commits.
    this.gestureStartedAt = null;
    this.unsubscribe?.();
    if (!keepResolutions) this.nodeHost.reset();
    this.parsed = parsed;
    const store = createFigureStore(doc, this.plugin.registries, () => this.pointer.commitTime(), unreadable);
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
      this.nodeHost.applyChange(store.doc, ev.changedNodeIds, ev.pagesChanged);
      // TextFileView does not save on its own. `replace` is a reload, not an edit.
      if (ev.kind === "commit" || ev.kind === "undo" || ev.kind === "redo") {
        this.unsaved = true;
        this.requestSave();
      }
      this.renderChrome();
    });
    this.renderChrome();
  }
}

/** `node` with its link's file renamed as `renames` says (a node whose type keeps a link); the node itself when not. */
function renamedLink(node: FigureNode, renames: ReadonlyMap<string, string>): FigureNode {
  const link = linkOf(node);
  const file = link ? renames.get(link.file) : undefined;
  return file === undefined ? node : ({ ...node, file } as FigureNode);
}
