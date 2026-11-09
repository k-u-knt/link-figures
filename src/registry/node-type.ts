import type { App, Component } from "obsidian";
import type { AssetMap } from "../export/asset-types";
import type { Attachable } from "../model/attach";
import type { Pt, Rect } from "../model/geometry";
import type { PathData } from "../model/path";
import type { Document, Node, NodeId, Page, PageId } from "../model/types";
import type { Plane } from "../links/decoders/tiff-convert";
import type { Resolved } from "../links/types";
import type { Field } from "./fields";
import type { Registries } from "./index";

export interface RenderContext {
  app: App;
  /** The plugin's registries: what a node type draws with (shape kinds, paints…). */
  registries: Registries;
  figurePath: string;
  /** The document as it is now: what a node drawn from other nodes (a connector from the items its ends are attached to) reads them from. */
  doc(): Document;
  resolved(id: NodeId): Resolved | undefined;
  openLink(linktext: string, evt: MouseEvent): void;
  component: Component;
}

export interface NodeRenderer {
  update(node: Node): void;
  unmount(): void;
  /**
   * Resolves once what the node shows now has finished drawing (an image loaded or failed, a note's markdown rendered or
   * failed to), so the stage can be snapshotted. Never rejects. Without it, the node is drawn as soon as it is mounted.
   */
  drawn?(): Promise<void>;
}

export interface SvgContext {
  /** The plugin's registries, as in `RenderContext`. */
  registries: Registries;
  doc: Document;
  page: Page;
  assets: AssetMap;
  defs: string[];
  warnings: string[];
  uid(prefix: string): string;
}

/** What a node type's `attachable` may depend on besides the node. */
export interface AttachContext {
  registries: Pick<Registries, "shapes">;
}

/**
 * What the view shows for a node that may show an image, now: `image` once an image has loaded, `loading` while one may
 * still come (not resolved or not loaded yet), and `none` when the node shows no image (its link does not resolve, so it
 * shows only its badge, or the image failed to load, or it shows note content).
 */
export type ImageState = "loading" | "image" | "none";

/** What a node type's inspector fields may depend on besides the node. */
export interface InspectorContext {
  registries: Registries;
  /** The natural size of the image node `id` shows, once it has loaded; absent or null without a view (headless). */
  imageSizeNow?(id: NodeId): { width: number; height: number } | null;
  /** What the view shows for node `id` (see `ImageState`); absent or null without a view, or for a node not drawn. */
  imageStateNow?(id: NodeId): ImageState | null;
  /**
   * The decoded samples of the TIFF or raster image node `id` shows, if they are cached; absent or null otherwise (a
   * null starts their decode, and the inspector is drawn again when they land).
   */
  samplesNow?(id: NodeId): Plane | null;
  /** The installed font families (sorted, de-duplicated), or null while the list is not available; absent without a view. */
  fontFamilies?(): string[] | null;
}

/** What a node type's part in `node.update` may depend on besides the node. */
export interface UpdateContext {
  registries: Registries;
  /** The document as it is before the update: what a node that refers to other nodes (a connector's ends) is checked against. */
  doc: Document;
}

/** What a node type's pointer hooks (`hitTest`, `handles`, `dragHandle`) may depend on besides the node. */
export interface InteractionContext {
  registries: Registries;
  /** The document as it is now: what a node drawn from other nodes reads them from. */
  doc: Document;
  /** A setting of the open view, such as the snap mode new connector ends take (see `FigureViewLike.viewOption`). */
  viewOption(key: string): unknown;
  /** How near (page px) a dragged end must come to a snap point to take it, at the view's zoom (see `SNAP_REACH_PX`). */
  snapReach: number;
}

/** A point of a selected node that can be dragged to change it, in page px; `id` is the node type's own. */
export interface NodeHandle {
  id: string;
  x: number;
  y: number;
}

/**
 * What dragging a node's handle to a point does: `call`, the command the release runs (with its JSON arguments), and
 * what is drawn while the drag is under way: `preview`, the outline the node would have (page px), and `marks`, points
 * worth showing (the anchors of the item the end would attach to).
 */
export interface HandleDrag {
  call: { id: string; args: Record<string, unknown> };
  preview?: PathData;
  marks?: Pt[];
}

export interface NodeType<N extends Node = Node> {
  type: N["type"];
  name: string;
  icon: string;
  mount(node: N, host: HTMLElement, ctx: RenderContext): NodeRenderer;
  bounds(node: N): Rect;
  inspector(node: N, ctx: InspectorContext): Field[];
  /** An SVG fragment, or `"raster"` to have the node rendered by the DOM and embedded as an image. */
  toSvg(node: N, ctx: SvgContext): string | "raster";
  /**
   * An SVG fragment drawn over the node's own drawing, whether that is `toSvg`'s fragment, a raster the DOM made of the
   * node, or a PDF panel's page embedded as vectors (a file panel's frame). The empty string draws nothing.
   */
  overlaySvg?(node: N, ctx: SvgContext): string;
  /**
   * Opts the type in to being attached to by connectors: its outline and anchors in page px, with the node's rotation
   * applied. A type that does not implement it (a connector) cannot be attached to.
   */
  attachable?(node: N, ctx: AttachContext): Attachable;
  /**
   * The other nodes this node is drawn from (a connector's attached items). The stage draws the node again when any of
   * them is added, removed or edited, even when the node itself did not change.
   */
  dependsOn?(node: N): NodeId[];
  /**
   * Base fields (`"x"`, `"rotation"`…) the type works out for itself, so the inspector does not offer them (a connector's
   * box is the area it draws, and it is never rotated).
   */
  derivedFields?: readonly string[];
  /**
   * For `node.update`: `after` (the node with the patch merged in) with what else the change brings, as a new node or
   * `after` changed in place (a connector given a new `route` gets that route's default `routeParams`, under the ones the
   * patch gives). `patch` is the patch as it was given. Runs before the fields are checked.
   */
  completeUpdate?(before: N, after: N, patch: Record<string, unknown>, ctx: UpdateContext): N;
  /**
   * For `node.update`: what is wrong with `value`, one of the type's own top-level fields (`"fill"`, `"ends"`) as the
   * patch leaves it, or null when it is fine. `node` is the whole node as the patch leaves it (after `completeUpdate`),
   * for a field that depends on another (a connector's ends must be on its page). Called for each such field a patch
   * touches; a key the type does not know is fine, as the file format keeps unknown keys.
   */
  checkField?(key: string, value: unknown, ctx: UpdateContext, node: N): string | null;
  /**
   * Whether `pt` (page px) is on the node, for a type that is not hit across its whole box (a line is hit near its path).
   * `tolerance` is how far off it may be, in page px (a few screen px at the current zoom). Without it, the node's box is
   * what is hit.
   */
  hitTest?(node: N, pt: Pt, tolerance: number, ctx: InteractionContext): boolean;
  /**
   * The handles a selected node shows in place of the eight resize handles of its box (a connector's ends and its route's
   * handles). Without it, the box's resize handles are shown.
   */
  handles?(node: N, ctx: InteractionContext): NodeHandle[];
  /**
   * What dragging the handle `handle` (an id from `handles`) to `to` (page px, on the node's page) does; `under` are the
   * other items there, topmost first. Null when the drag does nothing.
   */
  dragHandle?(node: N, handle: string, to: Pt, under: readonly NodeId[], ctx: InteractionContext): HandleDrag | null;
  /**
   * The node moved by (`dx`, `dy`) page px, as a drag of the selection moves it. Without it the box moves; a connector
   * moves only its free ends (its attached ends stay with their items). Returns `node` itself when nothing changes.
   */
  translate?(node: N, dx: number, dy: number): N;
  /**
   * The node scaled by (`sx`, `sy`) about `origin` (page px), as resizing a group scales its members: the fields that
   * change. Without it the box's position (its offset from `origin`) and size are scaled, rounded as a drag rounds them
   * and kept to the least size a node may have; text sizes, stroke widths and corner radii are left as they are
   * (`scaleUnits` in model/groups.ts). A connector scales only its free ends: its attached ends follow their items.
   */
  scale?(node: N, sx: number, sy: number, origin: Pt, ctx: InteractionContext | UpdateContext): Partial<N>;
  /**
   * The page the node is on once a move (`node.move`) that took it along has ended. Without it, the node goes to
   * `ctx.centrePage`, the page under the centre of its box. A connector follows its items: it stays while an end is
   * attached to an item that is not moving, goes with its items when they all go to one page, and otherwise goes to
   * the page under its centre.
   */
  pageAfterMove?(node: N, ctx: MoveContext): PageId;
  /**
   * Opts the type in to containing other nodes, as a group does: the ids of its members (the nodes whose `parent` is its
   * id), in z order. Moving, deleting, duplicating, restacking and aligning the node act on these too; code that needs
   * to know whether a node contains others asks this hook (`isGroup` in model/groups.ts), never the node's type.
   */
  members?(node: N, doc: Document): NodeId[];
  /**
   * For an inspector field that is not stored at its key but written by a command of its own (a file panel's crop
   * insets, which run `panel.crop`): how the inspector reads the field's value from a node, and the call that writes a
   * value to one. Undefined for a key that is a path into the node, which `node.update` writes.
   */
  fieldRoute?(key: string): FieldRoute<N> | undefined;
}

/** How the inspector reads and writes a field that a command writes (see `NodeType.fieldRoute`). */
export interface FieldRoute<N extends Node = Node> {
  /** The field's value on `node`; `ctx` says what the view shows now, when there is a view. */
  read(node: N, ctx?: InspectorContext): unknown;
  /**
   * Whether the field is written on `node` at all (a crop inset only on a panel that shows an image and is not locked, in
   * `doc`, as the command would refuse it); every node of the type when not given.
   */
  applies?(node: N, doc: Document, ctx?: InspectorContext): boolean;
  /**
   * Written on the first selected node only, the one whose fields the inspector shows (a panel's display: per-image
   * ranges rarely match); by default on every selected node of the type that it applies to.
   */
  firstOnly?: boolean;
  /** The command call (its id and JSON arguments) that sets the field of `node` to `value`. */
  call(node: N, value: unknown, ctx?: InspectorContext): { id: string; args: Record<string, unknown> };
}

/** What a node type's `pageAfterMove` may depend on besides the node. */
export interface MoveContext {
  /** Every node of the move. */
  moving: ReadonlySet<NodeId>;
  /**
   * The page node `id` is on once the move has ended, as far as it is known: for a node of the move whose type has no
   * `pageAfterMove`, the page under its centre; for any other node, the page it is on now. Undefined for no such node.
   */
  pageOf(id: NodeId): PageId | undefined;
  /** The page under the centre of the node's box, or the node's own page when the centre is over no page. */
  centrePage: PageId;
}

export class NodeTypeRegistry {
  // Re-registering a type replaces it in place and keeps its position.
  private readonly types = new Map<string, NodeType<any>>();

  register(t: NodeType<any>): void {
    this.types.set(t.type, t);
  }

  get(type: string): NodeType<any> | undefined {
    return this.types.get(type);
  }

  all(): NodeType<any>[] {
    return [...this.types.values()];
  }
}
