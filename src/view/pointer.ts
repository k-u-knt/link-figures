import { MIN_NODE_PX, NUDGE_LARGE_MM, NUDGE_MM } from "../constants";
import { visualBounds } from "../model/arrange";
import { SNAP_REACH_PX } from "../model/attach";
import { mmToPx, nodeWorldRect, pageOriginsPx, rectContainsPt, unionRect, type PlacePoint, type Pt, type Rect } from "../model/geometry";
import { descendantsOf, isGroup, isLocked, outermostUnit, parentOf, unitsOf } from "../model/groups";
import { toSvgPath } from "../model/path";
import { collectSnapLines, SNAP_OPTION, SNAP_REACH_SCREEN_PX, snapEdges, snapMove, snapOn, type SnapLines } from "../model/snap";
import type { DocumentStore } from "../model/store";
import type { Document, Node, NodeId, Page, PageId } from "../model/types";
import type { DragTargets, ToolPreview } from "../registry/command";
import type { HandleDrag, InteractionContext, NodeType } from "../registry/node-type";
import type { SnapLine } from "../registry/snap";
import { CROP_ROTATED_NOTICE, CropSession, croppable, type CropHandle } from "./crop-session";
import type { LinkFiguresView } from "./figure-view";
import { dragRect, HANDLES, handleAt, hitAll, hitTest, marqueeSelect, nodeSizePx, rectFromPoints, resizeRect, roundPx, type Handle, type HitItem } from "./pointer-math";
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
  | { kind: "marquee"; pageId: PageId; base: NodeId[]; within: NodeId | null; leaveOnClick: boolean };

/**
 * What a drag snaps to (see `model/snap`): the lines on the drag's page, taken from the document as it was when the drag
 * began, less what is being dragged. Null on a gesture that does not snap (snapping off when it began).
 */
type Snap = { pageId: PageId; lines: SnapLines } | null;

/**
 * `idle -> pressed -> moving | resizing | handling | marquee -> idle`, and `idle -> drawing -> idle` for an armed tool
 * that is dragged out. (Panning the canvas is the view's own gesture, which this one stays out of: see
 * `LinkFiguresView.isPanGesture`.) `world` is where the press began, in world pixels; `from` is the same point on the
 * press page, `under` the items there (topmost first), and `el` what the drag draws in that page's overlay (the dragged
 * box, or the tool's own preview), once the press has become a drag. `handling` drags a handle of a node's own (see
 * `NodeType.handles`): `drag` is what its release does, as the node type last said. A marquee selects the units of
 * the level `within` (the children of that entered group, or the top-level units); a press on empty paper inside the
 * entered group (`leaveOnClick`) sweeps at its level, and leaves it when it ends as a click.
 */
type Gesture =
  | { kind: "idle" }
  | { kind: "pressed"; pointerId: number; client: Pt; world: Pt; intent: Intent; collapseTo: NodeId | null }
  | { kind: "moving"; pointerId: number; world: Pt; ids: NodeId[]; moved: Pt; started: boolean; snap: Snap; bounds: Rect | null }
  | { kind: "resizing"; pointerId: number; world: Pt; id: NodeId; handle: Handle; start: Rect; group: { pageId: PageId; el: HTMLElement | null } | null; snap: Snap }
  | { kind: "handling"; pointerId: number; world: Pt; id: NodeId; handle: string; drag: HandleDrag | null; el: Element | null }
  | { kind: "marquee"; pointerId: number; world: Pt; pageId: PageId; base: NodeId[]; within: NodeId | null; el: HTMLElement }
  | { kind: "drawing"; pointerId: number; client: Pt; world: Pt; from: PlacePoint; under: NodeId[]; el: Element | null; snap: Snap }
  | { kind: "cropping"; pointerId: number; client: Pt; handle: CropHandle; started: boolean };

type Pressed = Extract<Gesture, { kind: "pressed" }>;
type Moving = Extract<Gesture, { kind: "moving" }>;
type Resizing = Extract<Gesture, { kind: "resizing" }>;
type Handling = Extract<Gesture, { kind: "handling" }>;
type Marquee = Extract<Gesture, { kind: "marquee" }>;
type Drawing = Extract<Gesture, { kind: "drawing" }>;
type Cropping = Extract<Gesture, { kind: "cropping" }>;

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
  /** The faint dashed outline of the entered group (see `LinkFiguresView.enteredGroup`), or null. */
  private enteredEl: HTMLElement | null = null;
  /** The snap guides of the drag under way (see `drawGuides`), in its page's overlay. */
  private guideEls: HTMLElement[] = [];

  /** `sync` is under way (see the crop session's `onEnd`). */
  private syncing = false;
  /** Crop mode on the page (see `CropSession`): while a session is under way, presses on its panel go to it. */
  readonly cropSession: CropSession;

  constructor(private readonly view: LinkFiguresView) {
    this.cropSession = new CropSession({
      get store() {
        return view.store;
      },
      runCommandById: (id, args, step) => view.runCommandById(id, args, step),
      imageSizeNow: (id) => view.imageSizeNow(id),
      imageSourceNow: (id) => view.imageSourceNow?.(id) ?? null,
      overlayOf: (pageId) => this.overlayOf(pageId),
      snapLines: (pageId, exclude) => this.snapLines(pageId, exclude),
      snapping: (mods) => this.snapping(mods),
      snapReachPage: () => this.snapReachPage(),
      drawGuides: (snap, guides, moving) => this.drawGuides(snap, guides, moving),
      clearGuides: () => this.clearGuides(),
      onEnd: () => {
        this.stage?.classList?.remove("lf-crop-pan");
        // A finish from inside `sync` (the selection moved on) is drawn by that `sync` itself.
        if (!this.syncing) this.sync();
      },
    });
  }

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
    this.cropSession.finish();
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
    this.cropSession.finish();
    this.unsubscribeStore?.();
    this.clearParts();
    // A group entered in another document is not one of this one's.
    this.view.enteredGroup = null;
    this.unsubscribeStore = this.view.store.subscribe(() => this.onStoreChange());
    this.sync();
  }

  /**
   * The time a commit counts as made at, which the store uses to merge commits that follow each other closely. A drag
   * commits on every pointer move and is to be one undo step however long the pointer rests on the way, so while one
   * is under way every commit is stamped with the moment the drag began.
   */
  commitTime(): number {
    // A crop session is one step from its first edit to its end, over however many drags.
    // An inspector gesture (a histogram handle's drag) is stamped the same way (`LinkFiguresView.gestureStartedAt`).
    return this.dragStartedAt ?? this.cropSession.startedAt ?? this.view.gestureStartedAt ?? Date.now();
  }

  /**
   * Starts crop mode on the image panel `id` (see `CropSession`), selecting it alone; a rotated panel shows the Notice
   * "Set rotation to 0 to crop on the page" instead. False when no session started.
   */
  startCrop(id: NodeId): boolean {
    if (this.view.readOnly) return false;
    const can = croppable(this.store, this.view, id);
    if (can === "rotated") this.view.notify(CROP_ROTATED_NOTICE);
    if (can !== "ok") return false;
    this.endGesture();
    this.cropSession.finish();
    if (this.view.armedTool) this.view.disarmTool();
    // The panel is selected at its own level: its group is entered (a panel at top level leaves any group), so the
    // selection is not taken up to the group by the next store change (see `onStoreChange`), which would end the session.
    const parent = parentOf(this.store.doc, id);
    if ((this.view.enteredGroup ?? null) !== parent) this.setEntered(parent);
    this.select([id]);
    const started = this.cropSession.start(id);
    this.sync();
    return started;
  }

  /** Finishes the crop session under way, if any, keeping what it did. */
  finishCrop(): void {
    this.cropSession.finish();
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

  /** The entered group (see `LinkFiguresView.enteredGroup`), or null when none is, or it is no longer a group of the document. */
  private get entered(): NodeId | null {
    const id = this.view.enteredGroup ?? null;
    return id !== null && isGroup(this.store.doc, id, this.view.plugin.registries) ? id : null;
  }

  /** Enters group `id` (null: leaves every group), and outlines it. */
  private setEntered(id: NodeId | null): void {
    this.view.enteredGroup = id;
    this.placeEnteredOutline();
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
      this.cropSession.finish();
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

    // A crop session takes a press on its handles or in its box; a press anywhere else finishes it, and is a press as any other.
    const crop = this.cropSession;
    if (crop.active) {
      const origin = pageOriginsPx(doc).get(crop.pageId() ?? "");
      const at = origin ? { x: world.x - origin.x, y: world.y - origin.y } : null;
      const handle = at && crop.handleAt(at, HANDLE_GRAB_PX / this.view.viewport.zoom);
      const target = handle ?? (at && crop.contains(at) ? "pan" : null);
      if (at && target) {
        crop.begin(target, at);
        this.gesture = { kind: "cropping", pointerId: ev.pointerId, client: { x: ev.clientX, y: ev.clientY }, handle: target, started: false };
        try {
          stage.setPointerCapture(ev.pointerId);
        } catch {
          // Without capture the drag still follows the pointer while it is over the stage.
        }
        return;
      }
      crop.finish();
    }

    const grabbed = this.grabbedHandle(doc, world);
    if (grabbed) {
      this.press(ev, world, grabbed, null);
      return;
    }

    const selectedPage = this.selectionPage(doc);
    // Nodes are not clipped to their page, so what is under the pointer is looked for among every page's nodes. What is
    // hit is a drawn node; the press acts on the unit it is part of at the entered level (a whole group at top level).
    const drawn = hitTest(this.itemsOnAllPages(doc), world);
    let entered = this.entered;
    // A press on a node outside the entered group leaves it entirely, and what was selected in it.
    if (drawn !== null && entered !== null && !descendantsOf(doc, entered).includes(drawn)) {
      this.setEntered(null);
      entered = null;
      selection.clear();
    }
    const hit = drawn === null ? null : outermostUnit(doc, drawn, entered);

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

    // Empty paper (or no paper): shift keeps what is selected on this page, anything else starts afresh. Inside the
    // entered group's box a sweep selects among its children, and a click leaves it (see `onPointerUp`); anywhere else
    // the press leaves it at once.
    const page = pageAt(doc, world);
    const group = entered === null ? undefined : doc.nodes.find((n) => n.id === entered);
    const inside = !!group && group.page === page?.id && rectContainsPt(nodeWorldRect(doc, group), world);
    if (entered !== null && !inside) {
      this.setEntered(null);
      entered = null;
      // What shift keeps selected is then taken as the top-level units it is part of, so as not to mix levels.
      if (ev.shiftKey) selection.set(unitsOf(doc, selection.ids, null));
    }
    if (!ev.shiftKey || page === null || page.id !== selectedPage) selection.clear();
    if (page) this.press(ev, world, { kind: "marquee", pageId: page.id, base: [...selection.ids], within: entered, leaveOnClick: inside }, null);
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
      this.cropHover(ev);
      this.hover(ev);
      return;
    }
    if (ev.pointerId !== g.pointerId) return;
    if (g.kind === "drawing") {
      this.drawPreview(g, ev);
      return;
    }
    if (g.kind === "cropping") {
      this.cropTo(g, ev);
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
    if (g.kind === "moving") this.moveBy(g, dx, dy, ev);
    else if (g.kind === "resizing") this.resizeBy(g, dx, dy, ev);
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
      const ids = doc.nodes.filter((n) => editable.has(n.id)).map((n) => n.id);
      if (ids.length > 0) {
        // The dragged units' bounds snap as one, to the lines of their page (they are all on one) less themselves.
        const pageId = doc.nodes.find((n) => n.id === ids[0])?.page;
        const snap = pageId === undefined ? null : this.snapLines(pageId, ids);
        const bounds = snap && unionRect(ids.map((id) => visualBounds(doc, id, this.view.plugin.registries)));
        return { kind: "moving", pointerId: g.pointerId, world: g.world, ids, moved: { x: 0, y: 0 }, started: false, snap, bounds };
      }
      const page = this.selectionPage(doc);
      return page === null ? null : this.beginMarquee(g, page, [], this.entered);
    }
    if (intent.kind === "resize") {
      const node = doc.nodes.find((n) => n.id === intent.id);
      if (!node) return null;
      const start = { x: node.x, y: node.y, width: node.width, height: node.height };
      const group = isGroup(doc, node.id, this.view.plugin.registries) ? { pageId: node.page, el: null } : null;
      return { kind: "resizing", pointerId: g.pointerId, world: g.world, id: node.id, handle: intent.handle, start, group, snap: this.snapLines(node.page, [node.id]) };
    }
    if (intent.kind === "handle") {
      if (!doc.nodes.some((n) => n.id === intent.id)) return null;
      return { kind: "handling", pointerId: g.pointerId, world: g.world, id: intent.id, handle: intent.handle, drag: null, el: null };
    }
    return this.beginMarquee(g, intent.pageId, intent.base, intent.within);
  }

  /** A marquee on a page that keeps `base` selected and selects units of the level `within`; null when the page is not drawn. */
  private beginMarquee(g: Pressed, pageId: PageId, base: NodeId[], within: NodeId | null): Marquee | null {
    const host = this.overlayOf(pageId);
    if (!host) return null;
    const el = host.ownerDocument.createElement("div");
    el.className = "lf-marquee";
    host.appendChild(el);
    return { kind: "marquee", pointerId: g.pointerId, world: g.world, pageId, base, within, el };
  }

  /**
   * Moves the dragged nodes to where the drag has taken them, by `node.move` (without the page change, which is for
   * the release): each call moves them on by what is left to go, and the calls of one drag make one undo step. The
   * total offset is first snapped, so that an edge or centre of the dragged units' bounds that comes within reach of a
   * line lands on it (not with Alt held).
   */
  private moveBy(g: Moving, dx: number, dy: number, ev: { altKey?: boolean }): void {
    const present = new Set(this.store.doc.nodes.map((n) => n.id));
    g.ids = g.ids.filter((id) => present.has(id));
    // What was being dragged has been deleted from under the pointer.
    if (g.ids.length === 0) {
      this.endGesture();
      return;
    }
    let to = { x: roundPx(dx), y: roundPx(dy) };
    if (g.snap && g.bounds && this.snapping(ev)) {
      const s = snapMove(g.snap.lines, offsetRect(g.bounds, to), this.snapReachPage());
      to = { x: roundPx(to.x + s.dx), y: roundPx(to.y + s.dy) };
      this.drawGuides(g.snap, s.guides, offsetRect(g.bounds, to));
    } else this.clearGuides();
    const step = { x: roundPx(to.x - g.moved.x), y: roundPx(to.y - g.moved.y) };
    if (step.x === 0 && step.y === 0) return;
    this.view.runCommandById("node.move", { ids: g.ids, dx: step.x, dy: step.y, pages: false }, g.started ? "continue" : "start");
    g.started = true;
    g.moved = to;
  }

  /**
   * The end of a move drag: `node.move` once more, by nothing, takes each node moved to the page under its centre
   * (see `node.move`). Run while the drag still counts as under way, so that it is one undo step with the drag, and the
   * selection then keeps only what is on its first node's page.
   */
  private finishMove(g: Moving): void {
    if (g.ids.length === 0) return;
    this.view.runCommandById("node.move", { ids: g.ids, dx: 0, dy: 0 }, g.started ? "continue" : "start");
    this.select([...this.view.selection.ids]);
  }

  /**
   * Resizes the node to the box the drag has taken it to, always worked out from the box it had when the drag began.
   * A group is not changed while the drag goes on: its new box is outlined in its page's overlay, and the release
   * resizes it (see `finishGroupResize`). Any other node's box is written directly, the commits making one undo step.
   */
  private resizeBy(g: Resizing, dx: number, dy: number, ev: { shiftKey: boolean; altKey?: boolean }): void {
    if (!this.store.doc.nodes.some((n) => n.id === g.id)) {
      this.endGesture();
      return;
    }
    const next = this.snappedBox(g, dx, dy, ev);
    if (g.group) {
      const host = this.overlayOf(g.group.pageId);
      if (!host) return;
      if (g.group.el?.parentElement !== host) {
        g.group.el?.remove();
        g.group.el = host.ownerDocument.createElement("div");
        g.group.el.className = "lf-draw-preview";
        host.appendChild(g.group.el);
      }
      const style = g.group.el.style;
      style.left = `${next.x}px`;
      style.top = `${next.y}px`;
      style.width = `${next.width}px`;
      style.height = `${next.height}px`;
      return;
    }
    this.store.commit("resize", (draft) => {
      const node = draft.nodes.find((n) => n.id === g.id);
      if (!node) return;
      Object.assign(node, next);
    });
  }

  /**
   * The release of a group's resize: one `node.update` on the group, with the box the release point gives from the box
   * it had when the drag began (Shift: keeping its aspect), which scales its members (see `scaleUnits`). One undo step.
   */
  private finishGroupResize(g: Resizing, ev: PointerEvent): void {
    const now = this.view.viewport.toWorld(this.view.stagePoint(ev));
    const box = this.snappedBox(g, now.x - g.world.x, now.y - g.world.y, ev);
    this.endGesture();
    if (this.store.doc.nodes.some((n) => n.id === g.id)) this.view.runCommandById("node.update", { id: g.id, patch: box });
  }

  /**
   * The box a resize drag by (`dx`, `dy`) gives (see `resizedBox`), its dragged edges snapped to the lines within reach,
   * with guides drawn for them. Not snapped with Alt held, with Shift (the aspect is kept, which a snapped edge would
   * break), nor for a rotated node, whose box's edges are not where it is drawn.
   */
  private snappedBox(g: Resizing, dx: number, dy: number, ev: { shiftKey: boolean; altKey?: boolean }): Rect {
    const next = resizedBox(g, dx, dy, ev.shiftKey);
    const node = this.store.doc.nodes.find((n) => n.id === g.id);
    if (!g.snap || ev.shiftKey || !node || node.rotation !== 0 || !this.snapping(ev)) {
      this.clearGuides();
      return next;
    }
    const edges = { left: g.handle.includes("w"), right: g.handle.includes("e"), top: g.handle.includes("n"), bottom: g.handle.includes("s") };
    const s = snapEdges(g.snap.lines, next, edges, this.snapReachPage());
    const box = { x: roundPx(s.rect.x), y: roundPx(s.rect.y), width: nodeSizePx(roundPx(s.rect.width)), height: nodeSizePx(roundPx(s.rect.height)) };
    this.drawGuides(g.snap, s.guides, box);
    return box;
  }

  /**
   * Draws the marquee from where the press began to `now`, and selects the units of its level on its page that are not
   * locked (nor in a locked group): a node it touches, a group only when it holds the whole of it.
   */
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
    this.view.selection.set([...g.base, ...marqueeSelect(this.unitsOn(doc, page, g.within), rect)]);
  }

  // Crop mode

  /** The stage shows the move cursor (`.lf-crop-pan`) while the pointer is over the box of the panel being cropped, away from its handles. */
  private cropHover(ev: PointerEvent): void {
    const crop = this.cropSession;
    let inside = false;
    if (crop.active) {
      const origin = pageOriginsPx(this.store.doc).get(crop.pageId() ?? "");
      const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
      const at = origin ? { x: world.x - origin.x, y: world.y - origin.y } : null;
      // Over a handle (the press would grab it, not pan) the cursor is the handle's own.
      inside = !!at && !crop.handleAt(at, HANDLE_GRAB_PX / this.view.viewport.zoom) && crop.contains(at);
    }
    this.stage?.classList?.toggle("lf-crop-pan", inside);
  }

  /** Drags the crop session's handle (or pans its image) to the pointer of `ev`, once the press has travelled far enough to be a drag. */
  private cropTo(g: Cropping, ev: PointerEvent): void {
    if (!g.started && Math.hypot(ev.clientX - g.client.x, ev.clientY - g.client.y) < DRAG_THRESHOLD_PX) return;
    g.started = true;
    const crop = this.cropSession;
    const origin = pageOriginsPx(this.store.doc).get(crop.pageId() ?? "");
    if (!crop.active || !origin) {
      this.endGesture();
      return;
    }
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
    crop.drag(g.handle, { x: world.x - origin.x, y: world.y - origin.y }, ev);
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
    // What is under the point the node's type is given, not under the pointer beyond the paper.
    const paper = pageWorldRect(doc, page);
    const under = this.itemsUnder(doc, page.id, { x: paper.x + to.x, y: paper.y + to.y }).filter((id) => id !== node.id);
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
    // A tool with a preview of its own (the connector) finds what it attaches to itself; a box is dragged out snapping.
    const snap = this.view.armedTool?.preview ? null : this.snapLines(from.page.id, []);
    this.gesture = { kind: "drawing", pointerId: ev.pointerId, client: { x: ev.clientX, y: ev.clientY }, world, from, under, el: null, snap };
    try {
      this.stage?.setPointerCapture(ev.pointerId);
    } catch {
      // Without capture the drag still follows the pointer while it is over the stage.
    }
  }

  /**
   * Where the pointer of `ev` puts the far end of the drawing: `from` itself while the pointer has not gone further
   * than a click may wobble (3 screen px), and otherwise the point on the press page, clamped to its paper and snapped
   * to the lines within reach (not with Alt, nor Shift, which squares the box); the items of the press page under the
   * pointer (under the press, for a click); and the lines it snapped to.
   * Null when the press page has gone.
   */
  private drawingEnd(g: Drawing, ev: PointerEvent): { to: PlacePoint; targets: DragTargets; guides: SnapLine[] } | null {
    const doc = this.store.doc;
    const page = doc.pages.find((p) => p.id === g.from.page.id);
    if (!page) return null;
    const reach = this.snapReach();
    if (Math.hypot(ev.clientX - g.client.x, ev.clientY - g.client.y) <= DRAG_THRESHOLD_PX) return { to: g.from, targets: { from: g.under, to: g.under, reach }, guides: [] };
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
    let to = clampToPaper(doc, page, world);
    let guides: SnapLine[] = [];
    if (g.snap && !ev.shiftKey && this.snapping(ev)) {
      const s = snapMove(g.snap.lines, { x: to.x, y: to.y, width: 0, height: 0 }, this.snapReachPage());
      to = clampToPaper(doc, page, { x: world.x + s.dx, y: world.y + s.dy });
      guides = s.guides;
    }
    return { to, targets: { from: g.under, to: this.itemsUnder(doc, page.id, world), reach }, guides };
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
    if (g.snap && end.guides.length > 0) this.drawGuides(g.snap, end.guides, dragRect(g.from, to, ev.shiftKey));
    else this.clearGuides();
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
    const preview = this.view.toolPreview(null, at, { from: [], to: under, reach: this.snapReach() });
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
    if (g.kind === "cropping") {
      this.endGesture();
      return;
    }
    if (g.kind === "resizing" && g.group) {
      this.finishGroupResize(g, ev);
      return;
    }
    const selection = this.view.selection;
    if (g.kind === "pressed" && g.collapseTo !== null && selection.ids.length > 1) selection.set([g.collapseTo]);
    // A click on empty paper inside the entered group leaves it, as one anywhere else did on the press.
    if (g.kind === "pressed" && g.intent.kind === "marquee" && g.intent.leaveOnClick) this.setEntered(null);
    if (g.kind === "moving") this.finishMove(g);
    this.endGesture();
  }

  /** The pointer was cancelled or its capture lost: whatever was done so far stays done (and undoable). */
  private onPointerLost(ev: PointerEvent): void {
    const g = this.gesture;
    if (g.kind !== "idle" && ev.pointerId === g.pointerId) this.endGesture();
  }

  /**
   * Back to idle, with the pointer released and the marquee gone, and the gesture's undo step closed: whatever is done
   * next (a nudge straight after a drag, say) is a step of its own, even under the same label. Safe to call at any time.
   */
  private endGesture(): void {
    const g = this.gesture;
    // First, so the capture event that the release below causes finds nothing to end.
    this.gesture = { kind: "idle" };
    this.dragStartedAt = null;
    this.clearGuides();
    if (g.kind === "idle") return;
    // A crop drag's step stays open for the session's next drag: the session closes it when it ends.
    if (g.kind === "cropping") this.cropSession.release();
    else this.store.endMerge();
    if (g.kind === "marquee" || g.kind === "drawing" || g.kind === "handling") g.el?.remove();
    if (g.kind === "resizing") g.group?.el?.remove();
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
   * `lf-activate` event on its element. A double-click on a member of a group that is not entered enters that group
   * instead (one level each time) and selects the unit clicked at the new level: only a node that is a unit of the
   * entered level itself is told.
   */
  private onDoubleClick(ev: MouseEvent): void {
    if (this.view.readOnly || isEditable(ev.target)) return;
    // A double-click finishes crop mode.
    if (this.cropSession.active) {
      this.cropSession.finish();
      return;
    }
    const doc = this.store.doc;
    const world = this.view.viewport.toWorld(this.view.stagePoint(ev));
    const hit = hitTest(this.itemsOnAllPages(doc), world);
    if (hit === null) return;
    let entered = this.entered;
    if (entered !== null && !descendantsOf(doc, entered).includes(hit)) entered = null;
    const unit = outermostUnit(doc, hit, entered);
    if (unit !== hit) {
      this.setEntered(unit);
      this.select([outermostUnit(doc, hit, unit)]);
      return;
    }
    if (entered !== this.entered) this.setEntered(entered);
    // An image panel starts crop mode (a rotated one says why it does not).
    const can = croppable(this.store, this.view, hit);
    if (can !== "no") {
      this.startCrop(hit);
      return;
    }
    const el = this.view.nodeHost.elementFor(hit);
    el?.dispatchEvent(new CustomEvent("lf-activate", { bubbles: false }));
  }

  // Keyboard

  private onKeyDown(ev: KeyboardEvent): void {
    // Escape takes the snap guides of a drag away (the drag goes on, and draws them again where it snaps next).
    if (ev.key === "Escape" && this.guideEls.length > 0) {
      ev.preventDefault();
      this.clearGuides();
    }
    // Escape during a group's resize drops it: the group is changed only by the release.
    if (ev.key === "Escape" && this.gesture.kind === "resizing" && this.gesture.group && !this.view.readOnly) {
      ev.preventDefault();
      this.endGesture();
      return;
    }
    // Crop mode: Enter finishes it; Escape ends a drag under way, putting the crop back as it was when the drag began, and
    // with no drag takes the whole session back.
    const crop = this.cropSession;
    if (crop.active && !this.view.readOnly && !ev.isComposing && !isEditable(ev.target) && (ev.key === "Enter" || ev.key === "Escape")) {
      if (ev.key === "Enter" && this.gesture.kind !== "idle") return;
      ev.preventDefault();
      if (ev.key === "Escape" && this.gesture.kind === "cropping") {
        crop.abortDrag();
        this.endGesture();
        return;
      }
      this.endGesture();
      if (ev.key === "Enter") crop.finish();
      else crop.cancel();
      return;
    }
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
        // Then the entered group is left, one level each time, with the group left selected.
        {
          const entered = this.entered;
          if (entered !== null) {
            this.setEntered(parentOf(this.store.doc, entered));
            this.select([entered]);
            handled = true;
            break;
          }
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
    // Consecutive nudges make one undo step, as the store merges commits made moments apart. A nudge keeps each node on its page.
    this.view.runCommandById("node.move", { ids: [...ids], dx: roundPx(dx), dy: roundPx(dy), pages: false }, "continue");
    return true;
  }

  // Selection and what is drawn for it

  private onStoreChange(): void {
    // An entered group that is gone (deleted, ungrouped, dissolved) is left.
    if ((this.view.enteredGroup ?? null) !== null && this.entered === null) this.view.enteredGroup = null;
    // Undo, a reload or a delete can take a selected node away; and an undo (of an ungroup, say) can put a selected
    // node back inside a group that is not entered, where it is selected as that group (its unit at the entered level).
    const doc = this.store.doc;
    const present = new Set(doc.nodes.map((n) => n.id));
    const selection = this.view.selection;
    const kept = unitsOf(doc, selection.ids.filter((id) => present.has(id)), this.entered);
    if (kept.length !== selection.ids.length || kept.some((id, i) => id !== selection.ids[i])) selection.set(kept);
    else this.sync();
  }

  /** Brings the outlines and handles in line with the selection and the document. */
  private sync(): void {
    this.syncing = true;
    try {
      this.syncNow();
    } finally {
      this.syncing = false;
    }
  }

  private syncNow(): void {
    const doc = this.store.doc;
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    // Crop mode lasts while its panel alone is selected; meanwhile its handles are the crop's, not the box's.
    const crop = this.cropSession;
    const ids = this.view.selection.ids;
    if (crop.active && (ids.length !== 1 || ids[0] !== crop.id)) crop.finish();
    const wanted = ids.filter((id) => byId.has(id) && id !== crop.id);
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
    this.placeEnteredOutline();
  }

  /** Draws the entered group's dashed outline on its box, in its page's overlay; removes it when no group is entered. */
  private placeEnteredOutline(): void {
    const id = this.entered;
    const node = id === null ? undefined : this.store.doc.nodes.find((n) => n.id === id);
    const host = node ? this.overlayOf(node.page) : null;
    if (!node || !host) {
      this.enteredEl?.remove();
      this.enteredEl = null;
      return;
    }
    if (this.enteredEl?.parentElement !== host) {
      this.enteredEl?.remove();
      this.enteredEl = host.ownerDocument.createElement("div");
      this.enteredEl.className = "lf-group-entered";
      host.appendChild(this.enteredEl);
    }
    const style = this.enteredEl.style;
    style.left = `${node.x}px`;
    style.top = `${node.y}px`;
    style.width = `${node.width}px`;
    style.height = `${node.height}px`;
  }

  private place(node: Node): void {
    const host = this.overlayOf(node.page);
    let parts = this.parts.get(node.id);
    // Locked itself or through a group it is in.
    const locked = isLocked(this.store.doc, node.id);
    // Moved to another page, or its page was drawn afresh, or locked since: what was drawn no longer fits.
    if (parts && (!host || parts.box.parentElement !== host || parts.locked !== locked || parts.own !== this.hasOwnHandles(node))) {
      parts.box.remove();
      this.parts.delete(node.id);
      parts = undefined;
    }
    if (!host) return;
    if (!parts) {
      parts = this.draw(host, node, locked);
      this.parts.set(node.id, parts);
    }
    const style = parts.box.style;
    style.left = `${node.x}px`;
    style.top = `${node.y}px`;
    style.width = `${node.width}px`;
    style.height = `${node.height}px`;
    if (parts.own && !locked) this.placeOwnHandles(parts.box, node);
  }

  private draw(host: HTMLElement, node: Node, locked: boolean): SelectionParts {
    const doc = host.ownerDocument;
    const box = doc.createElement("div");
    const own = this.hasOwnHandles(node);
    box.className = ["lf-selection", "lf-selected", ...(locked ? ["is-locked"] : []), ...(own ? ["has-own-handles"] : [])].join(" ");
    // A locked node can be selected (so that the inspector can unlock it) but not reshaped: it gets no handles, and a dashed outline.
    // A node with handles of its own gets those, drawn where they are each time it changes (see `placeOwnHandles`).
    if (!locked && !own) {
      for (const handle of HANDLES) {
        const el = doc.createElement("div");
        el.className = "lf-handle";
        el.dataset.handle = handle;
        box.appendChild(el);
      }
    }
    host.appendChild(box);
    return { box, locked, own };
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
    this.enteredEl?.remove();
    this.enteredEl = null;
  }

  private overlayOf(pageId: PageId): HTMLElement | null {
    try {
      return this.view.pageLayer.overlayHost(pageId);
    } catch {
      // A node can point at a page that is not drawn.
      return null;
    }
  }

  /** The nodes of the selection that may be changed: the ones that are in the document and not locked, nor in a locked group. */
  private editableSelection(doc: Document): Set<NodeId> {
    const selected = new Set(this.view.selection.ids);
    return new Set(doc.nodes.filter((n) => selected.has(n.id) && !isLocked(doc, n.id)).map((n) => n.id));
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
      if (!node || isLocked(doc, id)) continue;
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

  /** Every drawn node, to press: see `hitItems`. */
  private itemsOnAllPages(doc: Document): HitItem[] {
    return this.hitItems(doc, this.drawnNodes(doc));
  }

  /** The drawn nodes of the page `pageId` under the world point `world`, topmost first. */
  private itemsUnder(doc: Document, pageId: PageId, world: Pt): NodeId[] {
    return hitAll(this.hitItems(doc, this.drawnNodes(doc).filter((n) => n.page === pageId)), world);
  }

  /**
   * The nodes that are drawn, which a pointer can be on: every node but containers (a type with `members`, a group),
   * whose box only surrounds their members. A press finds a member, and acts on its unit (see `outermostUnit`).
   */
  private drawnNodes(doc: Document): Node[] {
    return doc.nodes.filter((n) => !this.nodeType(n)?.members);
  }

  private nodeType(node: Node): NodeType | undefined {
    return this.view.plugin.registries.nodeTypes.get(node.type);
  }

  /** What a node type's pointer hooks are given: the registries, `doc`, the view's settings and the snap reach at its zoom. */
  private interaction(doc: Document): InteractionContext {
    return { registries: this.view.plugin.registries, doc, viewOption: (key) => this.view.viewOption(key), snapReach: this.snapReach() };
  }

  // Snapping

  /** The lines on page `pageId` a drag snaps to, less `exclude` (see `Snap`); null when snapping is off or the page is gone. */
  private snapLines(pageId: PageId, exclude: NodeId[]): Snap {
    if (!snapOn(this.view.viewOption(SNAP_OPTION))) return null;
    const doc = this.store.doc;
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return null;
    const registries = this.view.plugin.registries;
    return { pageId, lines: collectSnapLines(registries.snaps.all(), doc, page, new Set(exclude), registries) };
  }

  /** Whether the drag snaps at the pointer event `ev`: not with Alt held, nor with snapping toggled off. */
  private snapping(ev: { altKey?: boolean }): boolean {
    return !ev.altKey && snapOn(this.view.viewOption(SNAP_OPTION));
  }

  /** `SNAP_REACH_SCREEN_PX` in page px at the viewport's zoom. */
  private snapReachPage(): number {
    return SNAP_REACH_SCREEN_PX / this.view.viewport.zoom;
  }

  /**
   * Draws a guide (a 1 px line) in the overlay of the drag's page along each line in `guides`, one for lines at the same
   * place, spanning them and `moving` (what is dragged, as it now is); the guides drawn before are replaced.
   */
  private drawGuides(snap: NonNullable<Snap>, guides: SnapLine[], moving: Rect): void {
    this.clearGuides();
    const host = this.overlayOf(snap.pageId);
    if (!host || guides.length === 0) return;
    const vertical = new Set(snap.lines.x);
    const spans = new Map<string, { vertical: boolean; pos: number; from: number; to: number }>();
    for (const line of guides) {
      const v = vertical.has(line);
      const key = `${v ? "x" : "y"}:${line.pos}`;
      const span = spans.get(key) ?? { vertical: v, pos: line.pos, from: v ? moving.y : moving.x, to: v ? moving.y + moving.height : moving.x + moving.width };
      span.from = Math.min(span.from, line.from);
      span.to = Math.max(span.to, line.to);
      spans.set(key, span);
    }
    for (const span of spans.values()) {
      const el = host.ownerDocument.createElement("div");
      el.className = `lf-snap-guide ${span.vertical ? "is-vertical" : "is-horizontal"}`;
      const style = el.style;
      style.left = `${span.vertical ? span.pos : span.from}px`;
      style.top = `${span.vertical ? span.from : span.pos}px`;
      style.width = `${span.vertical ? 0 : span.to - span.from}px`;
      style.height = `${span.vertical ? span.to - span.from : 0}px`;
      host.appendChild(el);
      this.guideEls.push(el);
    }
  }

  private clearGuides(): void {
    for (const el of this.guideEls) el.remove();
    this.guideEls = [];
  }

  /** `SNAP_REACH_PX` in page px at the viewport's zoom. */
  private snapReach(): number {
    return SNAP_REACH_PX / this.view.viewport.zoom;
  }

  /**
   * The units of `page` at the level `within`: the children of that group, or the top-level nodes when it is null; each
   * locked when it or a group it is in is, and a container (a group) to be held whole by a marquee.
   */
  private unitsOn(doc: Document, page: Page, within: NodeId | null): { id: NodeId; rect: Rect; locked: boolean; whole: boolean }[] {
    return doc.nodes
      .filter((n) => n.page === page.id && (n.parent ?? null) === within)
      .map((n) => ({ id: n.id, rect: nodeWorldRect(doc, n), locked: isLocked(doc, n.id), whole: !!this.nodeType(n)?.members }));
  }
}

/** The box a resize drag by (`dx`, `dy`) gives, from the box at its start, rounded and kept to the least size a node may have. */
function resizedBox(g: Resizing, dx: number, dy: number, keepAspect: boolean): Rect {
  const next = resizeRect(g.start, g.handle, dx, dy, { keepAspect, min: MIN_NODE_PX });
  // Rounding must not take a size back under the least it may be.
  return { x: roundPx(next.x), y: roundPx(next.y), width: nodeSizePx(roundPx(next.width)), height: nodeSizePx(roundPx(next.height)) };
}

/** `rect` moved by `by`. */
function offsetRect(rect: Rect, by: Pt): Rect {
  return { x: rect.x + by.x, y: rect.y + by.y, width: rect.width, height: rect.height };
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
