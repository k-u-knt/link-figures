import { MIN_NODE_PX, NUDGE_LARGE_MM, NUDGE_MM } from "../constants";
import { mmToPx, nodeWorldRect, rectContainsPt, type Pt, type Rect } from "../model/geometry";
import type { DocumentStore } from "../model/store";
import type { Document, Node, NodeId, Page, PageId } from "../model/types";
import type { LinkFiguresView } from "./figure-view";
import { HANDLES, handleAt, hitTest, marqueeSelect, rectFromPoints, resizeRect, roundPx, type Handle } from "./pointer-math";
import { pagePointAt, pageWorldRect } from "./viewport";

/** Screen pixels a press has to travel before it is a drag; a click that wobbles is still a click. */
const DRAG_THRESHOLD_PX = 3;
/** How far from a handle's centre, in screen pixels, a press still grabs it. The drawn handle is 8 px across. */
const HANDLE_GRAB_PX = 6;

/** Text being typed into must keep its keys. */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** What a press turns into once it has travelled far enough. A `move` that has nothing to move becomes a marquee: see `begin`. */
type Intent =
  | { kind: "move" }
  | { kind: "resize"; id: NodeId; handle: Handle }
  | { kind: "marquee"; pageId: PageId; base: NodeId[] };

/**
 * `idle -> pressed -> moving | resizing | marquee -> idle`. (Panning the canvas is the view's own gesture, which
 * this one stays out of: see `LinkFiguresView.isPanGesture`.) `world` is where the press began, in world pixels.
 */
type Gesture =
  | { kind: "idle" }
  | { kind: "pressed"; pointerId: number; client: Pt; world: Pt; intent: Intent; collapseTo: NodeId | null }
  | { kind: "moving"; pointerId: number; world: Pt; origins: Map<NodeId, Pt> }
  | { kind: "resizing"; pointerId: number; world: Pt; id: NodeId; handle: Handle; start: Rect }
  | { kind: "marquee"; pointerId: number; world: Pt; pageId: PageId; base: NodeId[]; el: HTMLElement };

type Pressed = Extract<Gesture, { kind: "pressed" }>;
type Moving = Extract<Gesture, { kind: "moving" }>;
type Resizing = Extract<Gesture, { kind: "resizing" }>;
type Marquee = Extract<Gesture, { kind: "marquee" }>;

/** What is drawn for one selected node in its page's overlay: an outlined box holding the handles. */
interface SelectionParts {
  box: HTMLElement;
  locked: boolean;
}

/**
 * Selecting, moving and resizing nodes with the pointer, and the keyboard on the stage. Edits go through the view's
 * store (`move` and `resize` on every pointer move, which the store merges into one undo step), and what is selected
 * is drawn in the page overlays. Nodes are found in the model, not by what the pointer landed on in the DOM.
 */
export class PointerController {
  private stage: HTMLElement | null = null;
  private listening: AbortController | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeSelection: (() => void) | null = null;
  private gesture: Gesture = { kind: "idle" };
  /** When the drag under way began, or null when there is none; see `commitTime`. */
  private dragStartedAt: number | null = null;
  private readonly parts = new Map<NodeId, SelectionParts>();

  constructor(private readonly view: LinkFiguresView) {}

  attach(stageEl: HTMLElement): void {
    this.detach();
    this.stage = stageEl;
    const listening = new AbortController();
    this.listening = listening;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (ev: HTMLElementEventMap[K]) => void): void =>
      stageEl.addEventListener(type, fn, { signal: listening.signal });
    on("pointerdown", (ev) => this.onPointerDown(ev));
    on("pointermove", (ev) => this.onPointerMove(ev));
    on("pointerup", (ev) => this.onPointerUp(ev));
    on("pointercancel", (ev) => this.onPointerLost(ev));
    on("lostpointercapture", (ev) => this.onPointerLost(ev));
    // A press the controller took is not also a text selection or a native drag: that is the mouse event's default.
    on("mousedown", (ev) => {
      if (this.gesture.kind !== "idle" && ev.button === 0) ev.preventDefault();
    });
    on("dblclick", (ev) => this.onDoubleClick(ev));
    on("keydown", (ev) => this.onKeyDown(ev));
    on("blur", () => this.endGesture());
    this.unsubscribeSelection = this.view.selection.onChange(() => this.sync());
    this.rebind();
  }

  detach(): void {
    this.endGesture();
    this.listening?.abort();
    this.listening = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = null;
    this.clearParts();
    this.stage = null;
  }

  /** The view has swapped in another store: what was in progress or drawn for the old one is dropped, and the new one is followed. */
  rebind(): void {
    if (!this.stage) return;
    this.endGesture();
    this.unsubscribeStore?.();
    this.clearParts();
    this.unsubscribeStore = this.view.store.subscribe(() => this.onStoreChange());
    this.sync();
  }

  /**
   * The time a commit counts as made at, which the store uses to merge commits that follow each other closely. A drag
   * commits on every pointer move and is to be one undo step however long the pointer rests on the way, so while one
   * is under way every commit is stamped with the moment the drag began.
   */
  commitTime(): number {
    return this.dragStartedAt ?? Date.now();
  }

  /** Selects `ids`, less any that are not in the document and any that are not on the page of the first one: a selection never spans pages. */
  select(ids: NodeId[]): void {
    const byId = new Map(this.store.doc.nodes.map((n) => [n.id, n] as const));
    const first = ids.map((id) => byId.get(id)).find((n) => n);
    this.view.selection.set(first ? ids.filter((id) => byId.get(id)?.page === first.page) : []);
  }

  private get store(): DocumentStore {
    return this.view.store;
  }

  // Pointer

  private onPointerDown(ev: PointerEvent): void {
    const stage = this.stage;
    if (!stage || this.view.readOnly) return;
    if (this.gesture.kind !== "idle") {
      // Another finger is not ours; the same pointer pressing again means the last release never arrived.
      if (ev.pointerId !== this.gesture.pointerId) return;
      this.endGesture();
    }
    if (!ev.isPrimary || ev.button !== 0 || this.view.isPanGesture(ev)) return;
    // The link badge and the like are clickable themselves: capturing the pointer would send their click to the stage.
    const target = ev.target as Element | null;
    if (isEditable(target) || target?.closest?.(".lf-badge")) return;

    // An armed tool takes the press: it is placed where the press is, on any page and over any node, and selects nothing
    // itself. The stage does not take the focus, and the mousedown that follows must not move it either (hence
    // `preventDefault`): it belongs to what the tool has just made, such as a label that has started editing.
    if (this.view.armedTool) {
      ev.preventDefault();
      const at = pagePointAt(this.store.doc, this.view.viewport.toWorld(this.view.stagePoint(ev)));
      if (at) this.view.placeTool(at);
      else this.view.disarmTool();
      return;
    }

    // So that keys arrive after a click.
    stage.focus({ preventScroll: true });

    const doc = this.store.doc;
    const selection = this.view.selection;
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));

    const grabbed = this.grabbedHandle(doc, world);
    if (grabbed) {
      this.press(ev, world, { kind: "resize", ...grabbed }, null);
      return;
    }

    const selectedPage = this.selectionPage(doc);
    // Nodes are not clipped to their page, so what is under the pointer is looked for among every page's nodes.
    const hit = hitTest(this.itemsOnAllPages(doc), world);

    if (hit) {
      // The page that counts for a selection is the node's own, wherever on the canvas it has ended up.
      const hitPage = doc.nodes.find((n) => n.id === hit)?.page;
      if (selectedPage !== null && selectedPage !== hitPage) selection.clear();
      if (ev.shiftKey) {
        selection.toggle(hit);
        if (selection.has(hit)) this.press(ev, world, { kind: "move" }, null);
        return;
      }
      // A press on a node of a larger selection moves them all; a click that goes nowhere narrows it to that node.
      // A press on a locked node selects it like any other, but there is nothing to move: a drag from it sweeps a marquee (see `begin`).
      const collapseTo = selection.has(hit) ? hit : null;
      if (!selection.has(hit)) selection.set([hit]);
      this.press(ev, world, { kind: "move" }, collapseTo);
      return;
    }

    // Empty paper (or no paper): shift keeps what is selected on this page, anything else starts afresh.
    const page = pageAt(doc, world);
    if (!ev.shiftKey || page === null || page.id !== selectedPage) selection.clear();
    if (page) this.press(ev, world, { kind: "marquee", pageId: page.id, base: [...selection.ids] }, null);
  }

  private press(ev: PointerEvent, world: Pt, intent: Intent, collapseTo: NodeId | null): void {
    this.gesture = { kind: "pressed", pointerId: ev.pointerId, client: { x: ev.clientX, y: ev.clientY }, world, intent, collapseTo };
    try {
      this.stage?.setPointerCapture(ev.pointerId);
    } catch {
      // Without capture the gesture still follows the pointer while it is over the stage.
    }
  }

  private onPointerMove(ev: PointerEvent): void {
    let g = this.gesture;
    if (g.kind === "idle" || ev.pointerId !== g.pointerId) return;
    if (g.kind === "pressed") {
      if (Math.hypot(ev.clientX - g.client.x, ev.clientY - g.client.y) < DRAG_THRESHOLD_PX) return;
      const begun = this.begin(g);
      if (!begun) {
        this.endGesture();
        return;
      }
      this.gesture = g = begun;
      if (begun.kind !== "marquee") this.dragStartedAt = Date.now();
    }

    const now = this.view.viewport.toWorld(this.view.stagePoint(ev));
    const dx = now.x - g.world.x;
    const dy = now.y - g.world.y;
    if (g.kind === "moving") this.moveBy(g, dx, dy);
    else if (g.kind === "resizing") this.resizeBy(g, dx, dy, ev.shiftKey);
    else if (g.kind === "marquee") this.sweep(g, now);
  }

  /**
   * The gesture a press becomes once it is a drag, or null when what it was going to act on is gone. A press on a node
   * moves the selected nodes that are not locked; when none is (the press was on a locked node, which can be selected
   * but not moved) the drag sweeps a marquee on that node's page instead, so that a locked node, a full-page
   * background say, does not keep what lies over it from being selected by a sweep. That marquee starts afresh, as
   * one from bare paper does without shift: the locked node leaves the selection as the sweep begins.
   */
  private begin(g: Pressed): Moving | Resizing | Marquee | null {
    const doc = this.store.doc;
    const { intent } = g;
    if (intent.kind === "move") {
      const editable = this.editableSelection(doc);
      const origins = new Map<NodeId, Pt>();
      for (const node of doc.nodes) if (editable.has(node.id)) origins.set(node.id, { x: node.x, y: node.y });
      if (origins.size > 0) return { kind: "moving", pointerId: g.pointerId, world: g.world, origins };
      const page = this.selectionPage(doc);
      return page === null ? null : this.beginMarquee(g, page, []);
    }
    if (intent.kind === "resize") {
      const node = doc.nodes.find((n) => n.id === intent.id);
      if (!node) return null;
      const start = { x: node.x, y: node.y, width: node.width, height: node.height };
      return { kind: "resizing", pointerId: g.pointerId, world: g.world, id: node.id, handle: intent.handle, start };
    }
    return this.beginMarquee(g, intent.pageId, intent.base);
  }

  /** A marquee on a page that keeps `base` selected; null when the page is not drawn. */
  private beginMarquee(g: Pressed, pageId: PageId, base: NodeId[]): Marquee | null {
    const host = this.overlayOf(pageId);
    if (!host) return null;
    const el = host.ownerDocument.createElement("div");
    el.className = "lf-marquee";
    host.appendChild(el);
    return { kind: "marquee", pointerId: g.pointerId, world: g.world, pageId, base, el };
  }

  private moveBy(g: Moving, dx: number, dy: number): void {
    const present = new Set(this.store.doc.nodes.map((n) => n.id));
    for (const id of [...g.origins.keys()]) if (!present.has(id)) g.origins.delete(id);
    // What was being dragged has been deleted from under the pointer.
    if (g.origins.size === 0) {
      this.endGesture();
      return;
    }
    this.store.commit("move", (draft) => {
      for (const node of draft.nodes) {
        const origin = g.origins.get(node.id);
        if (!origin) continue;
        node.x = roundPx(origin.x + dx);
        node.y = roundPx(origin.y + dy);
      }
    });
  }

  private resizeBy(g: Resizing, dx: number, dy: number, keepAspect: boolean): void {
    if (!this.store.doc.nodes.some((n) => n.id === g.id)) {
      this.endGesture();
      return;
    }
    const next = resizeRect(g.start, g.handle, dx, dy, { keepAspect, min: MIN_NODE_PX });
    this.store.commit("resize", (draft) => {
      const node = draft.nodes.find((n) => n.id === g.id);
      if (!node) return;
      node.x = roundPx(next.x);
      node.y = roundPx(next.y);
      // Rounding must not take a size back under the least it may be.
      node.width = Math.max(MIN_NODE_PX, roundPx(next.width));
      node.height = Math.max(MIN_NODE_PX, roundPx(next.height));
    });
  }

  /** Draws the marquee from where the press began to `now`, and selects the unlocked nodes of its page that it touches. */
  private sweep(g: Marquee, now: Pt): void {
    const doc = this.store.doc;
    const page = doc.pages.find((p) => p.id === g.pageId);
    if (!page) {
      this.endGesture();
      return;
    }
    const rect = rectFromPoints(g.world, now);
    const paper = pageWorldRect(doc, page);
    const style = g.el.style;
    style.left = `${rect.x - paper.x}px`;
    style.top = `${rect.y - paper.y}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
    this.view.selection.set([...g.base, ...marqueeSelect(this.itemsOn(doc, page), rect)]);
  }

  private onPointerUp(ev: PointerEvent): void {
    const g = this.gesture;
    if (g.kind === "idle" || ev.pointerId !== g.pointerId) return;
    const selection = this.view.selection;
    if (g.kind === "pressed" && g.collapseTo !== null && selection.ids.length > 1) selection.set([g.collapseTo]);
    this.endGesture();
  }

  /** The pointer was cancelled or its capture lost: whatever was done so far stays done (and undoable). */
  private onPointerLost(ev: PointerEvent): void {
    const g = this.gesture;
    if (g.kind !== "idle" && ev.pointerId === g.pointerId) this.endGesture();
  }

  /** Back to idle, with the pointer released and the marquee gone. Safe to call at any time. */
  private endGesture(): void {
    const g = this.gesture;
    // First, so the capture event that the release below causes finds nothing to end.
    this.gesture = { kind: "idle" };
    this.dragStartedAt = null;
    if (g.kind === "idle") return;
    if (g.kind === "marquee") g.el.remove();
    try {
      if (this.stage?.hasPointerCapture(g.pointerId)) this.stage.releasePointerCapture(g.pointerId);
    } catch {
      // Already released.
    }
  }

  // Double-click

  /**
   * What a double-click on a node means is for the node's type to say (a text node starts editing). A press on a node
   * captures the pointer, which sends the `click` and `dblclick` that follow to the stage, so the node's own element
   * never sees them. The node under the pointer is therefore found in the model, as for a press, and told by an
   * `lf-activate` event on its element.
   */
  private onDoubleClick(ev: MouseEvent): void {
    if (this.view.readOnly || isEditable(ev.target)) return;
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
    const hit = hitTest(this.itemsOnAllPages(this.store.doc), world);
    const el = hit === null ? undefined : this.view.nodeHost.elementFor(hit);
    el?.dispatchEvent(new CustomEvent("lf-activate", { bubbles: false }));
  }

  // Keyboard

  private onKeyDown(ev: KeyboardEvent): void {
    // The stage is the one place these keys are ours; text being typed into inside it, and anything while dragging, are not.
    if (this.view.readOnly || this.gesture.kind !== "idle" || ev.isComposing || isEditable(ev.target)) return;
    const store = this.store;
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod) {
      if (ev.altKey) return;
      const key = ev.key.toLowerCase();
      if (key === "z") {
        ev.preventDefault();
        if (ev.shiftKey) store.redo();
        else store.undo();
      } else if (key === "y" && ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        ev.preventDefault();
        store.redo();
      }
      return;
    }
    if (ev.altKey) return;

    let handled = false;
    switch (ev.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        const step = mmToPx(ev.shiftKey ? NUDGE_LARGE_MM : NUDGE_MM);
        const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
        const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
        handled = this.nudge(dx, dy);
        break;
      }
      case "Delete":
      case "Backspace":
        handled = this.deleteSelected();
        break;
      case "Escape":
        // An armed tool is put down first; the selection is cleared by the next Escape.
        if (this.view.armedTool) {
          this.view.disarmTool();
          handled = true;
          break;
        }
        handled = this.view.selection.ids.length > 0;
        this.view.selection.clear();
        break;
    }
    if (handled) ev.preventDefault();
  }

  private nudge(dx: number, dy: number): boolean {
    const ids = this.editableSelection(this.store.doc);
    if (ids.size === 0) return false;
    this.store.commit("nudge", (draft) => {
      for (const node of draft.nodes) {
        if (!ids.has(node.id)) continue;
        node.x = roundPx(node.x + dx);
        node.y = roundPx(node.y + dy);
      }
    });
    return true;
  }

  /** Deletes the selected nodes that are not locked (the Delete key, and the Delete command). Whether there were any. */
  deleteSelected(): boolean {
    const ids = this.editableSelection(this.store.doc);
    if (ids.size === 0) return false;
    this.store.commit("delete", (draft) => {
      draft.nodes = draft.nodes.filter((node) => !ids.has(node.id));
    });
    // The node host lets go of removed nodes too, but what a deleted node depended on is nobody's business once it is gone.
    for (const id of ids) this.view.index.untrack(id);
    return true;
  }

  // Selection and what is drawn for it

  private onStoreChange(): void {
    // Undo, a reload or a delete can take a selected node away.
    const present = new Set(this.store.doc.nodes.map((n) => n.id));
    const selection = this.view.selection;
    const kept = selection.ids.filter((id) => present.has(id));
    if (kept.length !== selection.ids.length) selection.set(kept);
    else this.sync();
  }

  /** Brings the outlines and handles in line with the selection and the document. */
  private sync(): void {
    const doc = this.store.doc;
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    const wanted = this.view.selection.ids.filter((id) => byId.has(id));
    const keep = new Set(wanted);
    for (const [id, parts] of this.parts) {
      if (keep.has(id)) continue;
      parts.box.remove();
      this.parts.delete(id);
    }
    for (const id of wanted) {
      const node = byId.get(id);
      if (node) this.place(node);
    }
  }

  private place(node: Node): void {
    const host = this.overlayOf(node.page);
    let parts = this.parts.get(node.id);
    // Moved to another page, or its page was drawn afresh, or locked since: what was drawn no longer fits.
    if (parts && (!host || parts.box.parentElement !== host || parts.locked !== node.locked)) {
      parts.box.remove();
      this.parts.delete(node.id);
      parts = undefined;
    }
    if (!host) return;
    if (!parts) {
      parts = this.draw(host, node);
      this.parts.set(node.id, parts);
    }
    const style = parts.box.style;
    style.left = `${node.x}px`;
    style.top = `${node.y}px`;
    style.width = `${node.width}px`;
    style.height = `${node.height}px`;
  }

  private draw(host: HTMLElement, node: Node): SelectionParts {
    const doc = host.ownerDocument;
    const box = doc.createElement("div");
    box.className = node.locked ? "lf-selection lf-selected is-locked" : "lf-selection lf-selected";
    // A locked node can be selected (so that the inspector can unlock it) but not reshaped: it gets no handles, and a dashed outline.
    if (!node.locked) {
      for (const handle of HANDLES) {
        const el = doc.createElement("div");
        el.className = "lf-handle";
        el.dataset.handle = handle;
        box.appendChild(el);
      }
    }
    host.appendChild(box);
    return { box, locked: node.locked };
  }

  private clearParts(): void {
    for (const parts of this.parts.values()) parts.box.remove();
    this.parts.clear();
  }

  private overlayOf(pageId: PageId): HTMLElement | null {
    try {
      return this.view.pageLayer.overlayHost(pageId);
    } catch {
      // A node can point at a page that is not drawn.
      return null;
    }
  }

  /** The nodes of the selection that may be changed: the ones that are in the document and not locked. */
  private editableSelection(doc: Document): Set<NodeId> {
    const selected = new Set(this.view.selection.ids);
    return new Set(doc.nodes.filter((n) => selected.has(n.id) && !n.locked).map((n) => n.id));
  }

  /** The page the selected nodes are on (they are all on one), or null when nothing is selected. */
  private selectionPage(doc: Document): PageId | null {
    const first = this.view.selection.ids[0];
    return doc.nodes.find((n) => n.id === first)?.page ?? null;
  }

  /** The selected node whose handle is under `world`, if any. */
  private grabbedHandle(doc: Document, world: Pt): { id: NodeId; handle: Handle } | null {
    const tolerance = HANDLE_GRAB_PX / this.view.viewport.zoom;
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    // The latest selected is the one drawn on top.
    for (const id of [...this.view.selection.ids].reverse()) {
      const node = byId.get(id);
      if (!node || node.locked) continue;
      const handle = handleAt(nodeWorldRect(doc, node), world, tolerance);
      if (handle) return { id, handle };
    }
    return null;
  }

  /** Every node, each with its page's position as `layer`: later pages are drawn over earlier ones. */
  private itemsOnAllPages(doc: Document): { id: NodeId; rect: Rect; z: number; locked: boolean; layer: number }[] {
    const layers = new Map(doc.pages.map((page, i) => [page.id, i] as const));
    return doc.nodes.map((n) => ({ id: n.id, rect: nodeWorldRect(doc, n), z: n.z, locked: n.locked, layer: layers.get(n.page) ?? 0 }));
  }

  private itemsOn(doc: Document, page: Page): { id: NodeId; rect: Rect; z: number; locked: boolean }[] {
    return doc.nodes
      .filter((n) => n.page === page.id)
      .map((n) => ({ id: n.id, rect: nodeWorldRect(doc, n), z: n.z, locked: n.locked }));
  }
}

/** The page under a world point, or null when it is over the canvas between or around the pages. */
function pageAt(doc: Document, world: Pt): Page | null {
  return doc.pages.find((page) => rectContainsPt(pageWorldRect(doc, page), world)) ?? null;
}
