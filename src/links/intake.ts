import { normalizePath, Notice, type App } from "obsidian";
import { MIN_NODE_PX } from "../constants";
import { splitLinktext } from "../format/links-section";
import { prepareCall, runInOneCommit } from "../commands/headless";
import { fileNodeDefaults } from "../model/defaults";
import { mmToPx, pageSizePx, type PlacePoint, type Pt } from "../model/geometry";
import type { FileNode, NodeId, Page } from "../model/types";
import type { LinkFiguresView } from "../view/figure-view";
import { isEditable } from "../view/pointer";
import { roundPx } from "../view/pointer-math";
import { pagePointAt, pageWorldRect } from "../view/viewport";
import { classifyDrop, classifyPaste, dedupeName, extensionOf, linkSafeName, type DropData, type IntakeAction } from "./intake-classify";
import { isPanelExtension, resolveFileNode } from "./resolver";
import type { Resolved } from "./types";

/** Nodes from one drop are laid out one below the other, this far apart. */
const STAGGER_MM = 10;
/** An image that has neither loaded nor failed by now will not; it must not hold up the rest of a drop. */
const IMAGE_LOAD_TIMEOUT_MS = 15000;

type Size = { width: number; height: number };

/** Where new nodes go: a page, and a position on it in that page's pixels. */
export type IntakeTarget = PlacePoint;

/** What a node is to link to, and how it is to show it. */
type Planned = Pick<FileNode, "file" | "subpath" | "show">;
/** A planned node and the natural size of the image it will show, or null when it shows none, the image has no size, or it could not be decoded (the node is then made at its default size). */
type Measured = Planned & { size: Size | null };

/** What `app.dragManager.draggable` is known to hold. The field is unofficial, so every part of it is checked. */
interface RawDraggable {
  type?: unknown;
  file?: unknown;
  files?: unknown;
  linktext?: unknown;
  sourcePath?: unknown;
}

function pathOf(file: unknown): string | undefined {
  const path = (file as { path?: unknown } | null | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

/** Obsidian's own drag in progress, if there is one and this version of Obsidian has the field at all. */
function readDraggable(app: App): DropData["draggable"] {
  const raw = (app as unknown as { dragManager?: { draggable?: RawDraggable | null } }).dragManager?.draggable;
  if (!raw || typeof raw !== "object") return undefined;
  switch (raw.type) {
    case "file": {
      const path = pathOf(raw.file);
      return { type: "file", paths: path === undefined ? [] : [path] };
    }
    case "files": {
      const files = Array.isArray(raw.files) ? raw.files : [];
      return { type: "files", paths: files.map(pathOf).filter((p): p is string => p !== undefined) };
    }
    case "link":
      return {
        type: "link",
        linktext: typeof raw.linktext === "string" ? raw.linktext : undefined,
        sourcePath: typeof raw.sourcePath === "string" ? raw.sourcePath : undefined,
      };
    case "folder":
      return { type: "folder" };
    default:
      return undefined;
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const hasName = (file: File | Blob): file is File => typeof (file as Partial<File>).name === "string";

/** The natural size of the image at `src`; rejects when it cannot be loaded. */
function loadImageSize(src: string): Promise<Size> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("The image did not load in time")), IMAGE_LOAD_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("The image could not be loaded"));
    };
    img.src = src;
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Turns what is dropped or pasted on the stage into file nodes: files from the vault are linked, files and images from
 * outside it are first saved into the vault, and a pasted `[[link]]` is linked as it stands. What to make of an event is
 * `intake-classify.ts`'s business; saving, measuring and the one commit are this class's.
 */
export class Intake {
  constructor(private readonly view: LinkFiguresView) {}

  /** Listens on the stage; the view removes the listeners when it unloads. */
  attach(stageEl: HTMLElement): void {
    this.view.registerDomEvent(stageEl, "dragover", (ev) => this.onDragOver(ev));
    this.view.registerDomEvent(stageEl, "drop", (ev) => this.onDrop(ev));
    this.view.registerDomEvent(stageEl, "paste", (ev) => this.onPaste(ev));
  }

  /**
   * Makes a node for each action, from the left: saves what has to be saved, resolves each link and measures the image
   * it shows, then adds all the nodes to the page with `panel.create` in one commit (`"insert"`, so one undo takes them
   * all out and leaves any saved file alone) and selects them. The view draws and resolves new nodes on that commit (`NodeHost.applyChange`),
   * so they are not resolved again here. An item that cannot be saved is reported in a Notice and left out (nothing was
   * written for it); the others go in. An item that is saved or linked but cannot be decoded goes in too, at the default
   * size, so that its panel shows the badge for it and the file is not left orphaned; a Notice gives the decoder's reason.
   * `files` are indexed as the actions' `index` fields are, and may have gaps. Resolves to the ids of the new nodes.
   */
  async execute(actions: IntakeAction[], at: IntakeTarget, files: ReadonlyArray<File | Blob | undefined>): Promise<NodeId[]> {
    const figure = this.view.file;
    if (!figure) return [];

    // Files that arrived but are not wanted: no action points at them.
    const wanted = new Set(actions.flatMap((a) => (a.kind === "save-file" || a.kind === "save-image-blob" ? [a.index] : [])));
    const skipped: string[] = [];
    files.forEach((file, i) => {
      if (file && !wanted.has(i) && hasName(file)) skipped.push(file.name);
    });

    const measured: Measured[] = [];
    for (const action of actions) {
      const planned = await this.plan(action, figure.path, files, skipped);
      if (planned) measured.push(await this.measure(planned, figure.path, at.page));
    }
    if (skipped.length > 0) new Notice(`Link Figures: skipped ${skipped.join(", ")}: not an image, PDF or TIFF file.`);
    return measured.length > 0 ? this.insert(measured, at) : [];
  }

  private onDragOver(ev: DragEvent): void {
    // Without this the drop is refused, and the window may navigate to a dropped file.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = this.view.readOnly ? "none" : "copy";
  }

  private onDrop(ev: DragEvent): void {
    ev.preventDefault();
    const view = this.view;
    if (view.readOnly || !view.file) return;
    const transfer = ev.dataTransfer;
    const files = transfer ? Array.from(transfer.files) : [];
    // Obsidian's draggable can outlive a drag it did not start (a file from Finder), so it counts only when no files came.
    const draggable = files.length === 0 ? readDraggable(view.app) : undefined;
    const actions = classifyDrop({
      draggable,
      osFiles: files.map((f) => ({ name: f.name, type: f.type })),
      text: transfer?.getData("text/plain") ?? "",
    });
    // Files that are all of a kind not wanted still go to `execute`, which says so.
    if (actions.length === 0 && files.length === 0) return;
    this.run(actions, this.placeAt(view.viewport.toWorld(view.stagePoint(ev))), files);
  }

  private onPaste(ev: ClipboardEvent): void {
    const view = this.view;
    // Only the stage and what is not for typing in it: a text field that has focus keeps its paste.
    if (view.readOnly || !view.file || isEditable(ev.target)) return;
    const data = ev.clipboardData;
    if (!data) return;
    const items = Array.from(data.items);
    // The items' contents can be read only while the event is being handled.
    const entries = items.map((item) => ({
      type: item.type,
      text: item.kind === "string" && item.type === "text/plain" ? data.getData("text/plain") : undefined,
    }));
    const files = items.map((item) => (item.kind === "file" && item.type.startsWith("image/") ? (item.getAsFile() ?? undefined) : undefined));
    const actions = classifyPaste(entries, new Date());
    if (actions.length === 0 && !files.some(Boolean)) return;
    ev.preventDefault();
    this.run(actions, this.pasteTarget(), files);
  }

  private run(actions: IntakeAction[], at: IntakeTarget, files: ReadonlyArray<File | Blob | undefined>): void {
    this.execute(actions, at, files)
      .then((ids) => {
        // So that the keys (arrows, Delete, undo) act on what has just come in.
        if (ids.length > 0) this.view.stageEl.focus({ preventScroll: true });
      })
      .catch((error: unknown) => {
        console.error("Link Figures: could not add the dropped or pasted items", error);
        new Notice(`Link Figures: could not add the items. ${errorText(error)}`);
      });
  }

  /** The page under a world point (else the page nearest the middle of the stage) and the point in that page's own pixels. */
  private placeAt(world: Pt): IntakeTarget {
    const doc = this.view.store.doc;
    const under = pagePointAt(doc, world);
    if (under) return under;
    const page = this.view.currentPage();
    const origin = pageWorldRect(doc, page);
    return { page, x: world.x - origin.x, y: world.y - origin.y };
  }

  /** A paste has no pointer: the middle of the stage, kept on the page so that a node of the default size fits on it. */
  private pasteTarget(): IntakeTarget {
    const stage = this.view.stageEl;
    const at = this.placeAt(this.view.viewport.toWorld({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }));
    const size = pageSizePx(at.page);
    const node = fileNodeDefaults(at.page, { file: "", subpath: "", show: "image" }, []);
    return {
      page: at.page,
      x: clamp(at.x, 0, Math.max(0, size.width - node.width)),
      y: clamp(at.y, 0, Math.max(0, size.height - node.height)),
    };
  }

  /**
   * What `action` is to link to, saving the file first if it has to be saved. Null: skipped (named in `skipped`), failed
   * (a Notice), or dropped text that names no vault file (nothing to say).
   */
  private async plan(
    action: IntakeAction,
    figurePath: string,
    files: ReadonlyArray<File | Blob | undefined>,
    skipped: string[],
  ): Promise<Planned | null> {
    switch (action.kind) {
      case "link-file": {
        const extension = extensionOf(action.path);
        if (isPanelExtension(extension)) return { file: action.path, subpath: "", show: "image" };
        // A note is linked the way Obsidian writes a link to one: without `.md`.
        if (extension === "md") return { file: action.path.replace(/\.md$/i, ""), subpath: "", show: "content" };
        skipped.push(basename(action.path));
        return null;
      }
      case "link-text": {
        const { file, subpath } = splitLinktext(action.linktext);
        // A link dragged out of a note is relative to that note; one that was pasted or dropped as text, to the figure.
        const target = this.view.plugin.access.resolveLink(file, action.sourcePath ?? figurePath);
        // A link that resolves is judged by what it resolves to; one that does not, by how it is written (a note's name has no extension).
        const extension = target ? target.extension.toLowerCase() : extensionOf(file);
        const show = isPanelExtension(extension) ? "image" : !target || extension === "md" ? "content" : null;
        if (show === null) {
          skipped.push(action.linktext);
          return null;
        }
        // Written relative to the note it came from, a link would resolve to something else from here: link the file it led to.
        if (target && action.sourcePath !== undefined) {
          return show === "image"
            ? { file: target.path, subpath: "", show }
            : { file: target.path.replace(/\.md$/i, ""), subpath, show };
        }
        return { file, subpath, show };
      }
      case "maybe-path": {
        // Text that names a vault file stands for that file; any other text is not for the figure and is let go quietly.
        const target = this.view.plugin.access.resolveLink(action.text, figurePath);
        return target ? this.plan({ kind: "link-file", path: target.path }, figurePath, files, skipped) : null;
      }
      case "save-file":
      case "save-image-blob": {
        const source = files[action.index];
        if (!source) {
          new Notice(`Link Figures: could not read ${action.name}.`);
          return null;
        }
        try {
          const path = await this.saveAttachment(action.name, await source.arrayBuffer(), figurePath);
          return { file: path, subpath: "", show: "image" };
        } catch (error) {
          console.error(`Link Figures: could not save ${action.name}`, error);
          new Notice(`Link Figures: could not save ${action.name}. ${errorText(error)}`);
          return null;
        }
      }
    }
  }

  /**
   * Writes the bytes into the vault under a name that is not taken and that a link can hold (`linkSafeName`), and returns
   * the path. Obsidian's own attachment setting decides where unless this plugin's folder setting is filled in, which then does.
   */
  private async saveAttachment(given: string, data: ArrayBuffer, figurePath: string): Promise<string> {
    const { vault, fileManager } = this.view.app;
    const name = linkSafeName(given);
    const folder = this.view.plugin.settings.attachmentFolder.trim();
    let path: string;
    if (folder === "") {
      path = await fileManager.getAvailablePathForAttachment(name, figurePath);
    } else {
      const dir = normalizePath(folder);
      const free = dedupeName(name, (candidate) => vault.getAbstractFileByPath(normalizePath(`${dir}/${candidate}`)) !== null);
      path = normalizePath(`${dir}/${free}`);
    }
    await this.ensureFolder(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
    await vault.createBinary(path, data);
    return path;
  }

  private async ensureFolder(folder: string): Promise<void> {
    const { vault } = this.view.app;
    if (folder === "" || vault.getAbstractFileByPath(folder)) return;
    try {
      await vault.createFolder(folder);
    } catch (error) {
      // Created in the meantime (the vault may not have noticed yet when asked, but does by now): fine.
      if (!vault.getAbstractFileByPath(folder)) throw error;
    }
  }

  /**
   * Resolves the node's link as the view will and, for an image, loads it to learn its size. Never null: what cannot be
   * decoded (a decoder that fails or refuses, a resolution that throws, an image that will not load) is still added, at
   * its default size, so that the panel shows the badge the resolver gives it, and one Notice says so with the decoder's
   * reason when there is one. Leaving it out would orphan a file that `plan` has already saved.
   */
  private async measure(planned: Planned, figurePath: string, page: Page): Promise<Measured> {
    const { access, decoders } = this.view.plugin;
    const label = planned.file + planned.subpath;
    const failed = (reason?: string): Measured => {
      new Notice(`Link Figures: ${label} could not be decoded; its panel shows a badge saying so.${reason ? ` ${reason}` : ""}`);
      return { ...planned, size: null };
    };

    let resolved: Resolved;
    try {
      resolved = await resolveFileNode(fileNodeDefaults(page, planned, []), figurePath, access, decoders);
    } catch (error) {
      console.error(`Link Figures: could not resolve ${label}`, error);
      return failed();
    }
    // The decoder's reason (a page over the size limit names its size) is worth reading.
    if (resolved.kind === "missing" && resolved.reason === "decode") return failed(resolved.message);
    // A note section, or a link that leads nowhere (yet): the node is made at its default size and shows the problem.
    if (resolved.kind !== "image") return { ...planned, size: null };

    try {
      const size = await loadImageSize(resolved.src);
      // An image with no size of its own (an SVG without width, height or viewBox) keeps the default box.
      return { ...planned, size: size.width > 0 && size.height > 0 ? size : null };
    } catch (error) {
      console.error(`Link Figures: could not load ${label}`, error);
      return failed();
    }
  }

  /**
   * The one commit: a `panel.create` per item, run together as one commit labelled "insert", which is an undo step of its
   * own. Everything awaited so far may have outlived the document, so the page and the store are looked up afresh.
   */
  private insert(items: Measured[], at: IntakeTarget): NodeId[] {
    const view = this.view;
    const store = view.store;
    const page = store.doc.pages.find((p) => p.id === at.page.id);
    if (!page) {
      new Notice("Link Figures: the page was removed before the items could be added, so nothing was added.");
      return [];
    }

    const { registries } = view.plugin;
    // The width is the default (a share of the page's); the height follows the picture.
    const width = fileNodeDefaults(page, { file: "", subpath: "", show: "image" }, []).width;
    const calls = items.map((item, i) =>
      prepareCall(registries, {
        id: "panel.create",
        args: {
          page: page.id,
          file: item.file,
          subpath: item.subpath,
          show: item.show,
          x: roundPx(at.x),
          y: roundPx(at.y + i * mmToPx(STAGGER_MM)),
          ...(item.size ? { height: Math.max(MIN_NODE_PX, roundPx((width * item.size.height) / item.size.width)) } : {}),
        },
      }),
    );
    store.endMerge();
    let results: unknown[];
    try {
      results = runInOneCommit(store, view.commandContext(), calls, "insert");
    } finally {
      store.endMerge();
    }
    const ids = results.map((r) => (r as { id: NodeId }).id);
    view.setSelection(ids);
    return ids;
  }
}
