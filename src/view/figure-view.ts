import { TextFileView, type WorkspaceLeaf } from "obsidian";
import { FILE_SUFFIX, VIEW_TYPE } from "../constants";
import { FormatError, NotFigureError } from "../format/errors";
import { loadDocument } from "../format/load";
import type { ParsedFigureFile } from "../format/parse";
import { emptyParsed, serializeFigureFile } from "../format/serialize";
import { InvalidationIndex } from "../links/invalidation";
import type { Resolved } from "../links/types";
import { LinkWatcher } from "../links/watcher";
import type LinkFiguresPlugin from "../main";
import { createDocument } from "../model/defaults";
import type { Pt, Rect } from "../model/geometry";
import { DocumentStore } from "../model/store";
import type { Document, NodeId, Page } from "../model/types";
import type { FigureViewLike } from "../registry/command";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { NodeHost } from "./node-host";
import { PageLayer } from "./page-layer";
import { isEditable, PointerController } from "./pointer";
import { SelectionState } from "./selection";
import { nearestPage, pageWorldRect, Viewport } from "./viewport";

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
export class LinkFiguresView extends TextFileView implements FigureViewLike {
  store: DocumentStore = new DocumentStore(blankDocument());
  parsed: ParsedFigureFile = emptyParsed();
  readonly index = new InvalidationIndex();
  readonly watcher: LinkWatcher;
  readonly resolvedCache = new Map<NodeId, Resolved>();

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

  /** True while the file could not be read: nothing may be written, and `getViewData` returns the text as it was. */
  readOnly = false;

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
  private resizeObserver: ResizeObserver | null = null;
  private spaceHeld = false;
  /** The pointer that is dragging the canvas, and where it was last seen (client coordinates). */
  private panning: { pointerId: number; x: number; y: number } | null = null;

  constructor(leaf: WorkspaceLeaf, readonly plugin: LinkFiguresPlugin) {
    super(leaf);
    this.watcher = new LinkWatcher(plugin.app, this.index, (ids) => {
      void this.nodeHost.resolve(ids);
    });
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
    // A stage that was hidden or not yet laid out when the document loaded is fitted once it has a size.
    this.resizeObserver = new ResizeObserver(() => this.fitWhenSized());
    this.resizeObserver.observe(this.stageEl);
    this.watcher.start(this);
  }

  async onClose(): Promise<void> {
    this.pointer?.detach();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.fitFrame !== null) window.cancelAnimationFrame(this.fitFrame);
    this.fitFrame = null;
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
    this.clearError();
    this.readOnly = false;
    this.setDocument(loaded.doc, loaded.parsed);
    this.rawText = data;
    this.serializedAtLoad = serializeFigureFile(loaded.doc, loaded.parsed);
    this.loaded = true;
    this.scheduleFit();
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
  }

  /** Replaces the stage content with a banner and the raw text, and makes the view read-only. */
  showError(message: string, raw: string): void {
    this.readOnly = true;
    this.rawText = raw;
    this.ensureDom();
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

  applyViewport(): void {
    this.viewportEl.style.transform = this.viewport.cssTransform();
    // For what is drawn on the pages but is sized in screen pixels (handles, outlines): see the selection rules in styles.css.
    this.viewportEl.style.setProperty("--lf-zoom", String(this.viewport.zoom));
  }

  /** A pointerdown that pans the canvas (middle button, or the left with the space bar held), which the pointer controller leaves alone. */
  isPanGesture(ev: PointerEvent): boolean {
    return ev.button === 1 || (ev.button === 0 && this.spaceHeld);
  }

  requestExport(): void {
    // Task 14 opens the export modal
  }

  /** Builds `.lf-view` once; `onOpen`, `showError` and `setDocument` all call it because `setViewData` may run before `onOpen`. */
  private ensureDom(): void {
    if (this.stageEl) return;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "lf-view" });
    this.toolbarEl = root.createDiv({ cls: "lf-toolbar" });
    const main = root.createDiv({ cls: "lf-main" });
    this.stageEl = main.createDiv({ cls: "lf-stage" });
    // Focusable by click (not by tab), so the space bar reaches the stage once it has been clicked.
    this.stageEl.tabIndex = -1;
    this.viewportEl = this.stageEl.createDiv({ cls: "lf-viewport" });
    this.inspectorEl = main.createDiv({ cls: "lf-inspector" });
    this.pageLayer = new PageLayer(this.viewportEl);
    // Made here, not in `onOpen`, because this is what makes sure a page layer exists whichever of the two runs first.
    this.nodeHost = new NodeHost(this, this.pageLayer, this.plugin.registries.nodeTypes);
    this.selection = new SelectionState();
    this.pointer = new PointerController(this);
    this.applyViewport();
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

  /** Swaps in a fresh store and drops everything derived from the previous document. */
  private setDocument(doc: Document, parsed: ParsedFigureFile): void {
    this.ensureDom();
    this.unsubscribe?.();
    for (const node of this.store.doc.nodes) this.index.untrack(node.id);
    this.resolvedCache.clear();
    this.parsed = parsed;
    const store = new DocumentStore(doc, () => this.pointer.commitTime());
    this.store = store;
    // Nothing selected, in progress or drawn belongs to the document that was just replaced.
    this.selection.clear();
    this.pointer.rebind();
    this.pageLayer.render(doc);
    this.nodeHost.renderAll(doc);
    void this.nodeHost.resolve(doc.nodes.map((n) => n.id));
    this.unsubscribe = store.subscribe((ev) => {
      if (ev.pagesChanged) this.pageLayer.render(store.doc);
      if (ev.kind === "replace") {
        // Same page ids and node ids can survive a reload, so nothing already drawn is trusted.
        this.nodeHost.renderAll(store.doc);
        void this.nodeHost.resolve(store.doc.nodes.map((n) => n.id));
      } else {
        this.nodeHost.applyChange(store.doc, ev.changedNodeIds);
      }
      // TextFileView does not save on its own. `replace` is a reload, not an edit.
      if (ev.kind === "commit" || ev.kind === "undo" || ev.kind === "redo") this.requestSave();
    });
  }
}
