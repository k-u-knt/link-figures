import { MIN_NODE_PX } from "../constants";
import { cropPlacement, type Pt, type Rect } from "../model/geometry";
import { isLocked } from "../model/groups";
import { snapEdges, type SnapLines } from "../model/snap";
import type { DocumentStore } from "../model/store";
import type { Crop, FileNode, NodeId, PageId } from "../model/types";
import type { UndoStep } from "../registry/command";
import type { SnapLine } from "../registry/snap";
import { HANDLES, handleAt, resizeRect, type Handle } from "./pointer-math";

/** What a crop drag moves: one of the eight edges or corners of the crop, or the image under the box (`pan`). */
export type CropHandle = Handle | "pan";

/** The keys held during a drag. */
export interface CropMods {
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Lines a crop handle snaps to, on the panel's page; null when snapping is off. */
export type CropSnap = { pageId: PageId; lines: SnapLines } | null;

/** The Notice a rotated panel gives instead of starting a session. */
export const CROP_ROTATED_NOTICE = "Set rotation to 0 to crop on the page";

/**
 * What a crop session needs from the view and the pointer controller: the store and commands, the image's size and
 * source, the page overlays, and snapping as the pointer's drags snap.
 */
export interface CropHost {
  readonly store: DocumentStore;
  runCommandById(id: string, args: Record<string, unknown>, step: UndoStep): void;
  imageSizeNow(id: NodeId): { width: number; height: number } | null;
  /** The URL the panel's image was loaded from, for the ghost; null draws the ghost as an outline only. */
  imageSourceNow(id: NodeId): string | null;
  overlayOf(pageId: PageId): HTMLElement | null;
  snapLines(pageId: PageId, exclude: NodeId[]): CropSnap;
  snapping(mods: CropMods): boolean;
  snapReachPage(): number;
  drawGuides(snap: NonNullable<CropSnap>, guides: SnapLine[], moving: Rect): void;
  clearGuides(): void;
  /** The session has ended (finished or cancelled). */
  onEnd(): void;
}

/** Whether `node` can be cropped on the page: "ok", "rotated" (a Notice says why not), or "no". */
export function croppable(store: DocumentStore, host: Pick<CropHost, "imageSizeNow">, id: NodeId): "ok" | "rotated" | "no" {
  const node = store.doc.nodes.find((n) => n.id === id);
  if (!node || node.type !== "file" || node.show !== "image" || isLocked(store.doc, id)) return "no";
  if (!host.imageSizeNow(id)) return "no";
  return node.rotation !== 0 ? "rotated" : "ok";
}

/** What a drag works from: the panel as it was when the drag began, all in page px. */
interface Grab {
  handle: CropHandle;
  at: Pt;
  /** The whole image on the page. */
  image: Rect;
  /** The part of the image that shows: the box, or for a letterboxed `contain` panel the region inside it. */
  visible: Rect;
  /** `visible` as a crop of the image. */
  crop: Crop;
  /** Whether the panel's box and crop already are `visible` and `crop` (no entry normalisation is needed). */
  normalised: boolean;
  snap: CropSnap;
}

/**
 * Crop mode on the page for one image panel. Dragging a handle moves that edge of the crop and the box with it, the
 * image staying still (`panel.crop` keep "image"); dragging inside the box pans the image under it (keep "box"). Every
 * edit of a session is merged into one undo step, from the first real edit to the end; the normalisation of a panel
 * whose box shows other than its crop (cover overflow, contain letterboxing) is folded into that first edit, so a
 * session without one changes nothing. `cancel` takes the session's step back. While it runs, the whole image is shown
 * at 35 % (`.lf-crop-ghost`) behind eight crop handles on the box, in the page overlay.
 */
export class CropSession {
  /** The panel being cropped, or null when no session is under way. */
  id: NodeId | null = null;
  /** When the session's first edit was made, which stamps all its commits (see `PointerController.commitTime`). */
  startedAt: number | null = null;
  private edited = false;
  private applying = false;
  private grab: Grab | null = null;
  private unsubscribe: (() => void) | null = null;
  private ghost: HTMLElement | null = null;
  private frame: HTMLElement | null = null;

  constructor(private readonly host: CropHost) {}

  get active(): boolean {
    return this.id !== null;
  }

  /** Starts a session on the panel `id`; false (and nothing started) when it cannot be cropped on the page. */
  start(id: NodeId): boolean {
    if (this.active) this.finish();
    if (croppable(this.host.store, this.host, id) !== "ok") return false;
    this.id = id;
    this.startedAt = null;
    this.edited = false;
    this.grab = null;
    this.unsubscribe = this.host.store.subscribe(() => this.onStoreChange());
    this.draw();
    return true;
  }

  /** The handle of the crop box within `tolerance` of the page point `p`, if any. */
  handleAt(p: Pt, tolerance: number): Handle | null {
    const node = this.node();
    return node ? handleAt(boxOf(node), p, tolerance) : null;
  }

  /** Whether the page point `p` is in the panel's box. */
  contains(p: Pt): boolean {
    const node = this.node();
    if (!node) return false;
    return p.x >= node.x && p.x <= node.x + node.width && p.y >= node.y && p.y <= node.y + node.height;
  }

  /** The page the panel is on. */
  pageId(): PageId | null {
    return this.node()?.page ?? null;
  }

  /** Begins a drag of `handle` at the page point `at`. */
  begin(handle: CropHandle, at: Pt): void {
    const node = this.node();
    const natural = node && this.host.imageSizeNow(node.id);
    if (!node || !natural) {
      this.grab = null;
      return;
    }
    const placed = cropPlacement(node, natural, node.crop, node.fit);
    const image = { x: node.x + placed.image.x, y: node.y + placed.image.y, width: placed.image.width, height: placed.image.height };
    const visible = { x: node.x + placed.region.x, y: node.y + placed.region.y, width: placed.region.width, height: placed.region.height };
    const crop = cropOf(visible, image);
    const normalised = rectsClose(visible, boxOf(node)) && cropsClose(crop, node.crop ?? { x: 0, y: 0, w: 1, h: 1 });
    const snap = handle === "pan" ? null : this.host.snapLines(node.page, [node.id]);
    // A handle sits on the box, but moves the visible region's edge (they differ on a letterboxed contain panel): the press
    // is taken as made on that edge, so the dragged edge goes to the pointer and the edges not dragged stay at `visible`.
    const box = boxOf(node);
    const from = { ...at };
    if (handle !== "pan") {
      if (handle.includes("w")) from.x += visible.x - box.x;
      if (handle.includes("e")) from.x += visible.x + visible.width - (box.x + box.width);
      if (handle.includes("n")) from.y += visible.y - box.y;
      if (handle.includes("s")) from.y += visible.y + visible.height - (box.y + box.height);
    }
    this.grab = { handle, at: from, image, visible, crop, normalised, snap };
  }

  /**
   * Drags `handle` to the page point `to` (from where `begin` began it; a drag not begun begins at the handle itself).
   * A handle moves its edges, snapped (not with Shift or Alt) and stopped at the image; Shift on a corner keeps the box's
   * aspect. `pan` moves the crop under the box, stopped at the image's edges.
   */
  drag(handle: CropHandle, to: Pt, mods: CropMods = {}): void {
    if (!this.active) return;
    if (!this.grab || this.grab.handle !== handle) this.begin(handle, handle === "pan" ? to : this.handlePoint(handle) ?? to);
    const g = this.grab;
    if (!g) return;
    const dx = to.x - g.at.x;
    const dy = to.y - g.at.y;
    if (handle === "pan") {
      const c = g.crop;
      const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
      const crop = { x: clamp(c.x - dx / g.image.width, 1 - c.w), y: clamp(c.y - dy / g.image.height, 1 - c.h), w: c.w, h: c.h };
      if (!g.normalised) {
        // The first edit of a panel that shows other than its crop: the box and crop become what is visible first, in the same step.
        this.run({ id: this.id, crop: g.crop, keep: "image" });
        g.normalised = true;
      }
      this.run({ id: this.id, crop, keep: "box" });
      return;
    }
    const corner = handle.length === 2;
    const keepAspect = !!mods.shiftKey && corner;
    let rect = resizeRect(g.visible, handle, dx, dy, { keepAspect, min: MIN_NODE_PX });
    let guides: SnapLine[] = [];
    if (g.snap && !keepAspect && this.host.snapping(mods)) {
      const edges = { left: handle.includes("w"), right: handle.includes("e"), top: handle.includes("n"), bottom: handle.includes("s") };
      const s = snapEdges(g.snap.lines, rect, edges, this.host.snapReachPage());
      rect = s.rect;
      guides = s.guides;
    }
    rect = keepAspect ? clampKeepingAspect(rect, g.image, handle) : clampTo(rect, g.image);
    if (g.snap && guides.length > 0) this.host.drawGuides(g.snap, guides, rect);
    else this.host.clearGuides();
    g.normalised = true;
    this.run({ id: this.id, crop: cropOf(rect, g.image), keep: "image" });
  }

  /** The end of a drag: the guides go; the session's step stays open for the next drag. */
  release(): void {
    this.grab = null;
    this.host.clearGuides();
  }

  /** Ends the session, keeping what it did (one undo step, or none when nothing was edited). */
  finish(): void {
    if (!this.active) return;
    this.end();
  }

  /** Ends the session, taking back what it did: the document is as it was at the start, with no step left to redo. */
  cancel(): void {
    if (!this.active) return;
    if (this.edited) {
      this.applying = true;
      try {
        this.host.store.undo();
        this.host.store.discardRedo();
      } finally {
        this.applying = false;
      }
    }
    this.end();
  }

  private end(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.host.store.endMerge();
    this.host.clearGuides();
    this.ghost?.remove();
    this.frame?.remove();
    this.ghost = null;
    this.frame = null;
    this.id = null;
    this.grab = null;
    this.startedAt = null;
    this.edited = false;
    this.host.onEnd();
  }

  /** Runs one `panel.crop`, merged into the session's step. */
  private run(args: { id: NodeId | null; crop: Crop; keep: "image" | "box" }): void {
    if (this.startedAt === null) this.startedAt = Date.now();
    this.applying = true;
    try {
      this.host.runCommandById("panel.crop", { ...args }, this.edited ? "continue" : "start");
    } finally {
      this.applying = false;
    }
  }

  /** A change the session made is drawn; any other change (an undo, another edit, a delete, a reload) finishes it. */
  private onStoreChange(): void {
    if (this.applying) {
      this.edited = true;
      this.draw();
      return;
    }
    this.finish();
  }

  private node(): FileNode | null {
    const node = this.host.store.doc.nodes.find((n) => n.id === this.id);
    return node?.type === "file" ? node : null;
  }

  private handlePoint(handle: Handle): Pt | null {
    const node = this.node();
    if (!node) return null;
    const box = boxOf(node);
    return {
      x: handle.includes("w") ? box.x : handle.includes("e") ? box.x + box.width : box.x + box.width / 2,
      y: handle.includes("n") ? box.y : handle.includes("s") ? box.y + box.height : box.y + box.height / 2,
    };
  }

  /** Draws (or moves) the ghost image and the crop frame with its handles in the panel's page overlay. */
  private draw(): void {
    const node = this.node();
    const natural = node && this.host.imageSizeNow(node.id);
    const host = node ? this.host.overlayOf(node.page) : null;
    if (!node || !natural || !host) return;
    const doc = host.ownerDocument;
    if (this.ghost?.parentElement !== host || this.frame?.parentElement !== host) {
      this.ghost?.remove();
      this.frame?.remove();
      const source = this.host.imageSourceNow(node.id);
      const ghost = doc.createElement(source ? "img" : "div");
      ghost.className = "lf-crop-ghost";
      if (source) (ghost as HTMLImageElement).src = source;
      const frame = doc.createElement("div");
      frame.className = "lf-crop-frame";
      for (const handle of HANDLES) {
        const el = doc.createElement("div");
        el.className = "lf-crop-handle";
        el.dataset.handle = handle;
        frame.appendChild(el);
      }
      // The ghost first, so it is behind the handles.
      host.appendChild(ghost);
      host.appendChild(frame);
      this.ghost = ghost;
      this.frame = frame;
    }
    const { image } = cropPlacement(node, natural, node.crop, node.fit);
    place(this.ghost, { x: node.x + image.x, y: node.y + image.y, width: image.width, height: image.height });
    place(this.frame, boxOf(node));
  }
}

function boxOf(node: FileNode): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function place(el: HTMLElement | null, rect: Rect): void {
  if (!el) return;
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

/** `rect` (on the page) as a crop of `image` (on the page). */
function cropOf(rect: Rect, image: Rect): Crop {
  return { x: (rect.x - image.x) / image.width, y: (rect.y - image.y) / image.height, w: rect.width / image.width, h: rect.height / image.height };
}

/** Within 0.01 px. */
function rectsClose(a: Rect, b: Rect): boolean {
  const near = (u: number, v: number) => Math.abs(u - v) < 0.01;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

function cropsClose(a: Crop, b: Crop): boolean {
  const near = (u: number, v: number) => Math.abs(u - v) < 1e-6;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
}

/** `rect` with each edge kept within `bounds`. */
function clampTo(rect: Rect, bounds: Rect): Rect {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  return { x: left, y: top, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

/** `rect`, dragged by the corner `handle`, scaled about the opposite corner until it lies within `bounds`. */
function clampKeepingAspect(rect: Rect, bounds: Rect, handle: Handle): Rect {
  const west = handle.includes("w");
  const north = handle.includes("n");
  const anchorX = west ? rect.x + rect.width : rect.x;
  const anchorY = north ? rect.y + rect.height : rect.y;
  const roomX = west ? anchorX - bounds.x : bounds.x + bounds.width - anchorX;
  const roomY = north ? anchorY - bounds.y : bounds.y + bounds.height - anchorY;
  const scale = Math.max(0, Math.min(1, roomX / rect.width, roomY / rect.height));
  const width = rect.width * scale;
  const height = rect.height * scale;
  return { x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height };
}
