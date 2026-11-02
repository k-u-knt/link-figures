import { MIN_NODE_PX, NUDGE_LARGE_MM, NUDGE_MM } from "../constants";
import { mmToPx, nodeWorldRect, pageOriginsPx, rectContainsPt, type PlacePoint, type Pt, type Rect } from "../model/geometry";
import { toSvgPath } from "../model/path";
import type { DocumentStore } from "../model/store";
import type { Document, Node, NodeId, Page, PageId } from "../model/types";
import type { DragTargets, ToolPreview } from "../registry/command";
import type { HandleDrag, InteractionContext, NodeType } from "../registry/node-type";
import type { LinkFiguresView } from "./figure-view";
import { dragRect, HANDLES, handleAt, hitAll, hitTest, marqueeSelect, rectFromPoints, resizeRect, roundPx, type Handle, type HitItem } from "./pointer-math";
import { pagePointAt, pageWorldRect } from "./viewport";

/** Screen pixels a press has to travel before it is a drag; a click that wobbles is still a click. */
const DRAG_THRESHOLD_PX = 3;
/** How far from a handle's centre, in screen pixels, a press still grabs it. The drawn handle is 8 px across. */
const HANDLE_GRAB_PX = 6;
/** How far from a line, in screen pixels, a press still hits it (see `NodeType.hitTest`). */
const LINE_HIT_PX = 4;
/** The radius, in screen pixels, of the points a preview marks (the anchors of the item under the pointer). */
const MARK_RADIUS_PX = 3.5;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Text being typed into must keep its keys. */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** What a press turns into once it has travelled far enough. A `move` that has nothing to move becomes a marquee: see `begin`. */
type Intent =
  | { kind: "move" }
  | { kind: "resize"; id: NodeId; handle: Handle }
  | { kind: "handle"; id: NodeId; handle: string }
  | { kind: "marquee"; pageId: PageId; base: NodeId[] };

/**
 * `idle -> pressed -> moving | resizing | handling | marquee -> idle`, and `idle -> drawing -> idle` for an armed tool
 * that is dragged out. (Panning the canvas is the view's own gesture, which this one stays out of: see
 * `LinkFiguresView.isPanGesture`.) `world` is where the press began, in world pixels; `from` is the same point on the
 * press page, `under` the items there (topmost first), and `el` what the drag draws in that page's overlay (the dragged
 * box, or the tool's own preview), once the press has become a drag. `handling` drags a handle of a node's own (see
 * `NodeType.handles`): `drag` is what its release does, as the node type last said.
 */
type Gesture =
  | { kind: "idle" }
  | { kind: "pressed"; pointerId: number; client: Pt; world: Pt; intent: Intent; collapseTo: NodeId | null }
  | { kind: "moving"; pointerId: number; world: Pt; origins: Map<NodeId, Node> }
  | { kind: "resizing"; pointerId: number; world: Pt; id: NodeId; handle: Handle; start: Rect }
  | { kind: "handling"; pointerId: number; world: Pt; id: NodeId; handle: string; drag: HandleDrag | null; el: Element | null }
  | { kind: "marquee"; pointerId: number; world: Pt; pageId: PageId; base: NodeId[]; el: HTMLElement }
  | { kind: "drawing"; pointerId: number; client: Pt; world: Pt; from: PlacePoint; under: NodeId[]; el: Element | null };

type Pressed = Extract<Gesture, { kind: "pressed" }>;
type Moving = Extract<Gesture, { kind: "moving" }>;
type Resizing = Extract<Gesture, { kind: "resizing" }>;
type Handling = Extract<Gesture, { kind: "handling" }>;
type Marquee = Extract<Gesture, { kind: "marquee" }>;
type Drawing = Extract<Gesture, { kind: "drawing" }>;

/**
 * What is drawn for one selected node in its page's overlay: an outlined box holding the handles, the eight resize
 * handles or, for a node type with handles of its own (`own`), those.
 */
interface SelectionParts {
  box: HTMLElement;
  locked: boolean;
  own: boolean;
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
  /** What an armed tool shows for the pointer hovering over a page (see `Command.preview`), or null. */
  private hoverEl: Element | null = null;

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
    on("pointerleave", () => this.clearHover());
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
    this.clearHover();
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
    // `preventDefault`): it belongs to what the tool has just made, such as a label that has started editing. A tool that
    // is dragged out (`placeDrag`) is placed at the release instead: see `finishDrawing`.
    const tool = this.view.armedTool;
    if (tool) {
      ev.preventDefault();
      const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
      const at = pagePointAt(this.store.doc, world);
      this.clearHover();
      if (!at) this.view.disarmTool();
      else if (tool.placeDrag) this.startDrawing(ev, world, at);
      else this.view.placeTool(at);
      return;
    }

    // So that keys arrive after a click.
    stage.focus({ preventScroll: true });

    const doc = this.store.doc;
    const selection = this.view.selection;
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));

    const grabbed = this.grabbedHandle(doc, world);
    if (grabbed) {
      this.press(ev, world, grabbed, null);
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
    if (g.kind === "idle") {
      this.hover(ev);
      return;
    }
    if (ev.pointerId !== g.pointerId) return;
    if (g.kind === "drawing") {
      this.drawPreview(g, ev);
      return;
    }
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
    else if (g.kind === "handling") this.dragHandleTo(g, now);
    else if (g.kind === "marquee") this.sweep(g, now);
  }

  /**
   * The gesture a press becomes once it is a drag, or null when what it was going to act on is gone. A press on a node
   * moves the selected nodes that are not locked; when none is (the press was on a locked node, which can be selected
   * but not moved) the drag sweeps a marquee on that node's page instead, so that a locked node, a full-page
   * background say, does not keep what lies over it from being selected by a sweep. That marquee starts afresh, as
   * one from bare paper does without shift: the locked node leaves the selection as the sweep begins.
   */
  private begin(g: Pressed): Moving | Resizing | Handling | Marquee | null {
    const doc = this.store.doc;
    const { intent } = g;
    if (intent.kind === "move") {
      const editable = this.editableSelection(doc);
      const origins = new Map<NodeId, Node>();
      for (const node of doc.nodes) if (editable.has(node.id)) origins.set(node.id, node);
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
    if (intent.kind === "handle") {
      if (!doc.nodes.some((n) => n.id === intent.id)) return null;
      return { kind: "handling", pointerId: g.pointerId, world: g.world, id: intent.id, handle: intent.handle, drag: null, el: null };
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
        if (origin) this.translate(node, origin, dx, dy);
      }
    });
  }

  /**
   * Moves `target` (a draft node) to `origin` moved by (`dx`, `dy`): its box, or what its type's `translate` changes (a
   * connector's free ends). Only what the type changes is written, so a node whose type moves nothing stays as it is.
   */
  private translate(target: Node, origin: Node, dx: number, dy: number): void {
    const type = this.nodeType(origin);
    if (!type?.translate) {
      target.x = roundPx(origin.x + dx);
      target.y = roundPx(origin.y + dy);
      return;
    }
    const next = type.translate(origin, dx, dy) as unknown as Record<string, unknown>;
    const before = origin as unknown as Record<string, unknown>;
    const draft = target as unknown as Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] !== before[key]) draft[key] = next[key];
  }

  /**
   * The end of a move drag: each node moved goes to the page under its centre, keeping its place on the canvas. A node
   * whose centre is over no page stays where it is. Committed while the drag still counts as under way, so that it is
   * one undo step with the drag, and the selection then keeps only what is on its first node's page.
   */
  private movePagesToCentres(g: Moving): void {
    const doc = this.store.doc;
    const origins = pageOriginsPx(doc);
    const moves = new Map<NodeId, { page: PageId; dx: number; dy: number }>();
    for (const node of doc.nodes) {
      if (!g.origins.has(node.id)) continue;
      const from = origins.get(node.page);
      if (!from) continue;
      const centre = { x: from.x + node.x + node.width / 2, y: from.y + node.y + node.height / 2 };
      const target = pageAt(doc, centre);
      const to = target && origins.get(target.id);
      if (!target || !to || target.id === node.page) continue;
      moves.set(node.id, { page: target.id, dx: from.x - to.x, dy: from.y - to.y });
    }
    if (moves.size === 0) return;
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    this.store.commit("move", (draft) => {
      for (const node of draft.nodes) {
        const to = moves.get(node.id);
        const origin = byId.get(node.id);
        if (!to || !origin) continue;
        node.page = to.page;
        this.translate(node, origin, to.dx, to.dy);
      }
    });
    this.select([...this.view.selection.ids]);
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

  // Dragging a handle of a node's own

  /**
   * Asks the node's type what dragging the handle to `world` does (the point on the node's page, clamped to its paper,
   * with the other items there), and draws what it says: the outline the node would have and the points it marks.
   */
  private dragHandleTo(g: Handling, world: Pt): void {
    const doc = this.store.doc;
    const node = doc.nodes.find((n) => n.id === g.id);
    const page = node && doc.pages.find((p) => p.id === node.page);
    const type = node && this.nodeType(node);
    if (!node || !page || !type?.dragHandle) {
      this.endGesture();
      return;
    }
    const to = clampToPaper(doc, page, world);
    const under = this.itemsUnder(doc, page.id, world).filter((id) => id !== node.id);
    try {
      g.drag = type.dragHandle(node, g.handle, to, under, this.interaction(doc));
    } catch (error) {
      console.error(`Link Figures: could not drag a handle of ${node.id}`, error);
      g.drag = null;
    }
    g.el = this.drawPreviewIn(page.id, g.drag && { path: g.drag.preview, marks: g.drag.marks }, g.el);
  }

  /** The release of a handle: the command the node's type last named runs, as a script would run it (one undo step). */
  private finishHandle(g: Handling): void {
    const call = g.drag?.call;
    this.endGesture();
    if (call) this.view.runCommandById(call.id, call.args);
  }

  // Drawing with a tool that is dragged out

  private startDrawing(ev: PointerEvent, world: Pt, from: PlacePoint): void {
    const under = this.itemsUnder(this.store.doc, from.page.id, world);
    this.gesture = { kind: "drawing", pointerId: ev.pointerId, client: { x: ev.clientX, y: ev.clientY }, world, from, under, el: null };
    try {
      this.stage?.setPointerCapture(ev.pointerId);
    } catch {
      // Without capture the drag still follows the pointer while it is over the stage.
    }
  }

  /**
   * Where the pointer of `ev` puts the far end of the drawing: `from` itself while the pointer has not gone further
   * than a click may wobble (3 screen px), and otherwise the point on the press page, clamped to its paper; and the items
   * of the press page under the pointer (under the press, for a click). Null when the press page has gone.
   */
  private drawingEnd(g: Drawing, ev: PointerEvent): { to: PlacePoint; targets: DragTargets } | null {
    const doc = this.store.doc;
    const page = doc.pages.find((p) => p.id === g.from.page.id);
    if (!page) return null;
    if (Math.hypot(ev.clientX - g.client.x, ev.clientY - g.client.y) <= DRAG_THRESHOLD_PX) return { to: g.from, targets: { from: g.under, to: g.under } };
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
    return { to: clampToPaper(doc, page, world), targets: { from: g.under, to: this.itemsUnder(doc, page.id, world) } };
  }

  /**
   * Draws the drawing in the press page's overlay as the tool will be given it: the tool's own preview when it has one
   * (see `Command.preview`; for a click, what it shows hovering), else the dragged box (Shift: a square).
   */
  private drawPreview(g: Drawing, ev: PointerEvent): void {
    const end = this.drawingEnd(g, ev);
    if (!end) {
      this.endGesture();
      return;
    }
    const { to, targets } = end;
    if (this.view.armedTool?.preview) {
      g.el = this.drawPreviewIn(g.from.page.id, this.view.toolPreview(to === g.from ? null : g.from, to, targets), g.el);
      return;
    }
    if (to === g.from) {
      g.el?.remove();
      g.el = null;
      return;
    }
    if (!g.el) {
      const host = this.overlayOf(g.from.page.id);
      if (!host) return;
      g.el = host.ownerDocument.createElement("div");
      g.el.className = "lf-draw-preview";
      host.appendChild(g.el);
    }
    const rect = dragRect(g.from, to, ev.shiftKey);
    const style = (g.el as HTMLElement).style;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
  }

  /** The release of a drawing: the tool is given the press and release points (see `drawingEnd`), Shift, and the items under them. */
  private finishDrawing(g: Drawing, ev: PointerEvent): void {
    const end = this.drawingEnd(g, ev);
    this.endGesture();
    if (end) this.view.placeToolDrag(g.from, end.to, { shift: ev.shiftKey }, end.targets);
  }

  // What an armed tool shows while the pointer hovers

  /** Draws what the armed tool shows for the pointer over a page (the anchors of the item under it), or clears it. */
  private hover(ev: PointerEvent): void {
    if (!this.view.armedTool?.preview || this.view.readOnly) {
      this.clearHover();
      return;
    }
    const doc = this.store.doc;
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
    const at = pagePointAt(doc, world);
    if (!at) {
      this.clearHover();
      return;
    }
    const under = this.itemsUnder(doc, at.page.id, world);
    const preview = this.view.toolPreview(null, at, { from: [], to: under });
    // Over another page than before, it is drawn afresh in that page's overlay.
    if (this.hoverEl && this.hoverEl.parentElement !== this.overlayOf(at.page.id)) this.clearHover();
    this.hoverEl = this.drawPreviewIn(at.page.id, preview, this.hoverEl);
  }

  private clearHover(): void {
    this.hoverEl?.remove();
    this.hoverEl = null;
  }

  /**
   * Draws `preview` (an outline and marked points, in page px) in the overlay of `pageId`, in `el` when given (it is
   * replaced), and returns what it drew; null, with `el` removed, when there is nothing to draw or no overlay.
   */
  private drawPreviewIn(pageId: PageId, preview: ToolPreview | null, el: Element | null): Element | null {
    const path = preview?.path;
    const marks = preview?.marks ?? [];
    const host = this.overlayOf(pageId);
    if (!host || ((!path || path.length === 0) && marks.length === 0)) {
      el?.remove();
      return null;
    }
    const doc = host.ownerDocument;
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "lf-tool-preview");
    if (path && path.length > 0) {
      const line = doc.createElementNS(SVG_NS, "path");
      line.setAttribute("class", "lf-tool-preview-path");
      line.setAttribute("d", toSvgPath(path));
      svg.appendChild(line);
    }
    const r = MARK_RADIUS_PX / this.view.viewport.zoom;
    for (const mark of marks) {
      const dot = doc.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "lf-tool-preview-mark");
      dot.setAttribute("cx", String(mark.x));
      dot.setAttribute("cy", String(mark.y));
      dot.setAttribute("r", String(r));
      svg.appendChild(dot);
    }
    if (el?.parentElement === host) el.replaceWith(svg);
    else {
      el?.remove();
      host.appendChild(svg);
    }
    return svg;
  }

  private onPointerUp(ev: PointerEvent): void {
    const g = this.gesture;
    if (g.kind === "idle" || ev.pointerId !== g.pointerId) return;
    if (g.kind === "drawing") {
      this.finishDrawing(g, ev);
      return;
    }
    if (g.kind === "handling") {
      this.finishHandle(g);
      return;
    }
    const selection = this.view.selection;
    if (g.kind === "pressed" && g.collapseTo !== null && selection.ids.length > 1) selection.set([g.collapseTo]);
    if (g.kind === "moving") this.movePagesToCentres(g);
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
    if (g.kind === "marquee" || g.kind === "drawing" || g.kind === "handling") g.el?.remove();
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
        // The Delete command, as the toolbar and the palette run it: one way to delete.
        handled = this.editableSelection(this.store.doc).size > 0;
        if (handled) this.view.runCommandById("delete");
        break;
      case "Escape":
        // An armed tool is put down first; the selection is cleared by the next Escape.
        if (this.view.armedTool) {
          this.view.disarmTool();
          this.clearHover();
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
    const byId = new Map(this.store.doc.nodes.map((n) => [n.id, n] as const));
    this.store.commit("nudge", (draft) => {
      for (const node of draft.nodes) {
        const origin = byId.get(node.id);
        if (origin && ids.has(node.id)) this.translate(node, origin, dx, dy);
      }
    });
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
    if (parts && (!host || parts.box.parentElement !== host || parts.locked !== node.locked || parts.own !== this.hasOwnHandles(node))) {
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
    if (parts.own && !node.locked) this.placeOwnHandles(parts.box, node);
  }

  private draw(host: HTMLElement, node: Node): SelectionParts {
    const doc = host.ownerDocument;
    const box = doc.createElement("div");
    const own = this.hasOwnHandles(node);
    box.className = ["lf-selection", "lf-selected", ...(node.locked ? ["is-locked"] : []), ...(own ? ["has-own-handles"] : [])].join(" ");
    // A locked node can be selected (so that the inspector can unlock it) but not reshaped: it gets no handles, and a dashed outline.
    // A node with handles of its own gets those, drawn where they are each time it changes (see `placeOwnHandles`).
    if (!node.locked && !own) {
      for (const handle of HANDLES) {
        const el = doc.createElement("div");
        el.className = "lf-handle";
        el.dataset.handle = handle;
        box.appendChild(el);
      }
    }
    host.appendChild(box);
    return { box, locked: node.locked, own };
  }

  /** Draws the handles of `node`'s own (see `NodeType.handles`) in its selection box, which sits on its box. */
  private placeOwnHandles(box: HTMLElement, node: Node): void {
    const handles = this.ownHandles(node);
    const doc = box.ownerDocument;
    box.replaceChildren(
      ...handles.map((h) => {
        const el = doc.createElement("div");
        el.className = "lf-handle lf-own-handle";
        el.dataset.ownHandle = h.id;
        el.style.left = `${h.x - node.x}px`;
        el.style.top = `${h.y - node.y}px`;
        return el;
      }),
    );
  }

  private hasOwnHandles(node: Node): boolean {
    return !!this.nodeType(node)?.handles;
  }

  /** The handles of `node`'s own, in page px; none when its type has none, or fails to say. */
  private ownHandles(node: Node): { id: string; x: number; y: number }[] {
    try {
      return this.nodeType(node)?.handles?.(node, this.interaction(this.store.doc)) ?? [];
    } catch (error) {
      console.error(`Link Figures: could not find the handles of ${node.id}`, error);
      return [];
    }
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

  /**
   * The selected node whose handle is under `world`, if any: one of its own handles (the nearest, within reach) for a
   * type that has them, else one of its box's resize handles.
   */
  private grabbedHandle(doc: Document, world: Pt): Extract<Intent, { kind: "resize" | "handle" }> | null {
    const tolerance = HANDLE_GRAB_PX / this.view.viewport.zoom;
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    const origins = pageOriginsPx(doc);
    // The latest selected is the one drawn on top.
    for (const id of [...this.view.selection.ids].reverse()) {
      const node = byId.get(id);
      if (!node || node.locked) continue;
      if (this.hasOwnHandles(node)) {
        const origin = origins.get(node.page);
        if (!origin) continue;
        let best: { handle: string; distance: number } | null = null;
        for (const h of this.ownHandles(node)) {
          const dx = Math.abs(world.x - (origin.x + h.x));
          const dy = Math.abs(world.y - (origin.y + h.y));
          const distance = Math.hypot(dx, dy);
          if (dx <= tolerance && dy <= tolerance && (!best || distance < best.distance)) best = { handle: h.id, distance };
        }
        if (best) return { kind: "handle", id, handle: best.handle };
        continue;
      }
      const handle = handleAt(nodeWorldRect(doc, node), world, tolerance);
      if (handle) return { kind: "resize", id, handle };
    }
    return null;
  }

  /**
   * `nodes` as items to press, each with its page's position as `layer` (later pages are drawn over earlier ones), and
   * for a type hit by more than its box (see `NodeType.hitTest`), what says whether a world point is on it.
   */
  private hitItems(doc: Document, nodes: Node[]): HitItem[] {
    const layers = new Map(doc.pages.map((page, i) => [page.id, i] as const));
    const origins = pageOriginsPx(doc);
    const tolerance = LINE_HIT_PX / this.view.viewport.zoom;
    let ctx: InteractionContext | null = null;
    return nodes.map((n) => {
      const type = this.nodeType(n);
      const origin = origins.get(n.page);
      const hit =
        type?.hitTest && origin
          ? (p: Pt): boolean => {
              ctx ??= this.interaction(doc);
              try {
                return type.hitTest?.(n, { x: p.x - origin.x, y: p.y - origin.y }, tolerance, ctx) ?? false;
              } catch (error) {
                console.error(`Link Figures: could not tell whether ${n.id} is under the pointer`, error);
                return false;
              }
            }
          : undefined;
      return { id: n.id, rect: nodeWorldRect(doc, n), z: n.z, locked: n.locked, layer: layers.get(n.page) ?? 0, hit };
    });
  }

  /** Every node, to press: see `hitItems`. */
  private itemsOnAllPages(doc: Document): HitItem[] {
    return this.hitItems(doc, doc.nodes);
  }

  /** The nodes of the page `pageId` under the world point `world`, topmost first. */
  private itemsUnder(doc: Document, pageId: PageId, world: Pt): NodeId[] {
    return hitAll(this.hitItems(doc, doc.nodes.filter((n) => n.page === pageId)), world);
  }

  private nodeType(node: Node): NodeType | undefined {
    return this.view.plugin.registries.nodeTypes.get(node.type);
  }

  /** What a node type's pointer hooks are given: the registries, `doc` and the view's settings. */
  private interaction(doc: Document): InteractionContext {
    return { registries: this.view.plugin.registries, doc, viewOption: (key) => this.view.viewOption(key) };
  }

  private itemsOn(doc: Document, page: Page): { id: NodeId; rect: Rect; z: number; locked: boolean }[] {
    return doc.nodes
      .filter((n) => n.page === page.id)
      .map((n) => ({ id: n.id, rect: nodeWorldRect(doc, n), z: n.z, locked: n.locked }));
  }
}

/** The world point `world` as a point on `page`, clamped to its paper. */
function clampToPaper(doc: Document, page: Page, world: Pt): PlacePoint {
  const paper = pageWorldRect(doc, page);
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return { page, x: clamp(world.x - paper.x, paper.width), y: clamp(world.y - paper.y, paper.height) };
}

/** The page under a world point, or null when it is over the canvas between or around the pages. */
function pageAt(doc: Document, world: Pt): Page | null {
  return doc.pages.find((page) => rectContainsPt(pageWorldRect(doc, page), world)) ?? null;
}
