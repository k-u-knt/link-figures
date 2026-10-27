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
import { DocumentStore } from "../model/store";
import type { Document, NodeId, Page } from "../model/types";
import type { FigureViewLike } from "../registry/command";
import { DEFAULT_SETTINGS } from "../settings/settings";

/** What stands in for a document while none is loaded, so `store` is never undefined. It is never written to a file. */
const blankDocument = (): Document => createDocument(DEFAULT_SETTINGS.defaultPreset);

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

  constructor(leaf: WorkspaceLeaf, readonly plugin: LinkFiguresPlugin) {
    super(leaf);
    this.watcher = new LinkWatcher(plugin.app, this.index, (_ids) => {
      /* Task 10 wires nodeHost.resolve */
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
    this.watcher.start(this);
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
  }

  clear(): void {
    this.setDocument(blankDocument(), emptyParsed());
    this.loaded = false;
    this.readOnly = false;
    this.rawText = "";
    this.serializedAtLoad = "";
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
    return []; // Task 11 reads the selection state
  }

  currentPage(): Page {
    return this.store.doc.pages[0]; // Task 9 picks the page nearest the stage centre
  }

  setSelection(_ids: NodeId[]): void {
    // Task 11 writes the selection state
  }

  fitPage(): void {
    // Task 9 fits the current page to the stage
  }

  zoomTo(_z: number): void {
    // Task 9 sets the viewport zoom
  }

  requestExport(): void {
    // Task 14 opens the export modal
  }

  /** Builds `.lf-view` once; `onOpen` and `showError` both call it because `setViewData` may run before `onOpen`. */
  private ensureDom(): void {
    if (this.stageEl) return;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "lf-view" });
    this.toolbarEl = root.createDiv({ cls: "lf-toolbar" });
    this.stageEl = root.createDiv({ cls: "lf-stage" });
    this.viewportEl = this.stageEl.createDiv({ cls: "lf-viewport" });
    this.inspectorEl = root.createDiv({ cls: "lf-inspector" });
  }

  private clearError(): void {
    if (!this.errorEl) return;
    this.errorEl.remove();
    this.errorEl = null;
    this.viewportEl.show();
  }

  /** Swaps in a fresh store and drops everything derived from the previous document. */
  private setDocument(doc: Document, parsed: ParsedFigureFile): void {
    this.unsubscribe?.();
    for (const node of this.store.doc.nodes) this.index.untrack(node.id);
    this.resolvedCache.clear();
    this.parsed = parsed;
    this.store = new DocumentStore(doc);
    this.unsubscribe = this.store.subscribe((ev) => {
      // TextFileView does not save on its own. `replace` is a reload, not an edit.
      if (ev.kind === "commit" || ev.kind === "undo" || ev.kind === "redo") this.requestSave();
    });
  }
}
