import type { App, Component } from "obsidian";
import type { AssetMap } from "../export/asset-types";
import { registerLinkedType, type LinkField } from "../format/node-links";
import type { Attachable } from "../model/attach";
import type { Pt, Rect } from "../model/geometry";
import type { PathData } from "../model/path";
import type { Document, FileNode, Node, NodeId, Page, PageId } from "../model/types";
import type { Plane } from "../links/decoders/tiff-convert";
import type { Resolved } from "../links/types";
import type { Field } from "./fields";
import type { Registries } from "./index";

/**
 * A link the stage resolves for a node (see `NodeType.linkTarget`), as a file panel's own fields name its link. Any
 * other file panel field given (which image, page, range, adjustments) is kept, so a file panel gives itself.
 */
export interface LinkTarget extends Partial<Omit<FileNode, "file" | "subpath" | "show">> {
  file: string;
  subpath: string;
  show: FileNode["show"];
}

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
  /**
   * The nodes their plugin could not read (see `DocumentStore.unreadable`): handled as placeholders, so none of their
   * type's hooks may be called on them. A node drawn from other nodes (a connector) passes it on (`resolveConnector`).
   */
  unreadable?: ReadonlySet<NodeId>;
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
  /**
   * The nodes their plugin could not read (see `DocumentStore.unreadable`): handled as placeholders, so none of their
   * type's hooks may be called on them. A node drawn from other nodes (a connector) passes it on (`resolveConnector`).
   */
  unreadable?: ReadonlySet<NodeId>;
}

/**
 * What a node type's `toPptx` may depend on besides the node: one slide of an editable PowerPoint export. Positions are
 * page px from the page's top-left corner; `px` turns them into the slide's EMU.
 */
export interface PptxContext {
  /** The plugin's registries, as in `RenderContext` (the paints a fill is written with). */
  registries: Registries;
  doc: Document;
  /** The page the slide is made of. */
  page: Page;
  /** The page's assets, trimmed (see `collectAssets`, `trimAssets`): what a panel draws. */
  assets: AssetMap;
  /** How much the slide is scaled from the page: 1, unless the page is outside PowerPoint's slide sizes. */
  scale: number;
  /** `value` page px as EMU on the slide (scaled), rounded to a whole EMU. */
  px(value: number): number;
  /** The export's resolution, for what is written as a picture. */
  dpi: number;
  /** Adds a picture to the slide's media; returns the relationship id an `a:blip r:embed` names it by. */
  addMedia(bytes: Uint8Array, ext: "png" | "jpeg"): string;
  /** A shape id not yet used on the slide (`p:cNvPr id`). */
  nextId(): number;
  /**
   * `svgFragment` (page px, as `toSvg` writes, with any `<defs>` it needs inline) drawn over `box` (page px) on a clear
   * background, as PNG bytes at `dpi` (lower when that is over the canvas limits, which it says through `warn`, by default
   * with the page's name; `labelled` passes the item's). Rejects when it cannot be drawn.
   */
  rasterise(svgFragment: string, box: Rect, warn?: (message: string) => void): Promise<Uint8Array>;
  /** Says what the slide could not keep; the same message is reported once per export. Say which item it is about. */
  warn(message: string): void;
  /**
   * The nodes their plugin could not read (see `DocumentStore.unreadable`): handled as placeholders, so none of their
   * type's hooks may be called on them. A node drawn from other nodes (a connector) passes it on (`resolveConnector`).
   */
  unreadable?: ReadonlySet<NodeId>;
}

/**
 * A node as PresentationML: `xml` is one or more shape-tree elements (`p:sp`, `p:pic`, `p:cxnSp`, `p:grpSp`) whose
 * pictures were added with `PptxContext.addMedia`.
 */
export interface PptxPart {
  xml: string;
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
  /**
   * The patch the update was given (`node.update`), which the node's fields were merged with: a check that judges only
   * what the caller gave (a stroke's keys, see `fieldError`) reads it. Absent, the whole value is judged.
   */
  patch?: Record<string, unknown>;
  /**
   * The nodes their plugin could not read (see `DocumentStore.unreadable`): handled as placeholders, so none of their
   * type's hooks may be called on them. A node drawn from other nodes (a connector) passes it on (`resolveConnector`).
   */
  unreadable?: ReadonlySet<NodeId>;
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
  /**
   * The nodes their plugin could not read (see `FigureViewLike.unreadableNodes`): handled as placeholders, so a new
   * connector end is never attached to one (see `nodeTypeFor`).
   */
  unreadable?: ReadonlySet<NodeId>;
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
   * The node as editable PowerPoint shapes; `"raster"` to have it written as a picture of its SVG drawing (as is a type
   * without the hook), null to leave it out. May be async.
   */
  toPptx?(node: N, ctx: PptxContext): PptxPart | "raster" | null | Promise<PptxPart | "raster" | null>;
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
   * touches; a key the type does not know is fine, as the file format keeps unknown keys. It is called for a changed base field too, after that field's own
   * check, so a type can refuse a value it does not take (a card's `rotation`). Also called for the base field
   * `"page"` when a patch moves the node to another page, so a type can refuse a move this command cannot make (a
   * connector attached to items, which `node.move` moves with them). `node.update` runs these checks within its patch
   * (`judgingPatch`): a stroke field checked with `fieldError` or `paramError` is judged by the keys the patch gives
   * alone, so a stray key already in the file is kept, whether or not `ctx` is passed on (`ctx.patch` is the patch).
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
   * id), in z order. A container's own drawing (its frame, background) is not exported to PowerPoint: only its members are. Moving, deleting, duplicating, restacking and aligning the node act on these too; code that needs
   * to know whether a node contains others asks this hook (`isGroup` in model/groups.ts), never the node's type.
   */
  members?(node: N, doc: Document): NodeId[];
  /**
   * For an inspector field that is not stored at its key but written by a command of its own (a file panel's crop
   * insets, which run `panel.crop`): how the inspector reads the field's value from a node, and the call that writes a
   * value to one. Undefined for a key that is a path into the node, which `node.update` writes.
   */
  fieldRoute?(key: string): FieldRoute<N> | undefined;
  /**
   * Opts the type in to keeping a link in the figure file's Links section (see `LinkField`): its nodes' `file` and
   * `subpath` are written there, not in the JSON, read back from there, and follow a rename of the target.
   */
  linkField?: LinkField;
  /**
   * `false` keeps the type's items out of every export, inside groups too, and with them every node drawn from one of
   * them (a connector with an end on one, see `isExported`): a card beside the figure. Absent, the items are exported.
   */
  exportable?: false;
  /**
   * Opts the type in to being kept off the paper: the store keeps each of its items at least `CARD_PAPER_GAP_MM` outside
   * every page's paper rectangle (`pushOffPaper`, by the smallest move), in the commit that would put it there, whether
   * the item or a page moved. Its box (`bounds`) is what is kept clear.
   */
  offPaper?: true;
  /**
   * Opts the type in to being tied to pages by connectors: a connector whose one end is attached to an item of the type
   * may have its other end on a page (`{ kind: "page" }`), and is then an association (`isAssociation`). A page end on a
   * connector from anything else is refused.
   */
  pageTies?: true;
  /**
   * The pages the node is tied to by itself (a connector's page ends). Deleting one of these pages deletes the node with
   * it, in the same undo step. Such a node is not exported, as it is drawn from a card (see `isExported`).
   */
  tiedPages?(node: N): PageId[];
  /**
   * The vault link whose target the stage shows in the node, resolved as a file panel's link is (`resolveFileNode`): the
   * file, its subpath, and whether the node shows the section's content or an image in it. The result reaches the
   * node's renderer through `RenderContext.resolved`, and the node is resolved again when the target changes. Null (or
   * absent) for a node that shows no link (a text card). A file panel gives itself.
   */
  linkTarget?(node: N): LinkTarget | null;
  /**
   * For a type a plugin registers (not one this plugin builds in): validates one of its nodes as a figure file holds it,
   * and gives the node back, completed with what is missing. `raw` has the base fields checked (`id`, `type`, `page`, a
   * numeric box) and the common defaults filled in (`z`, `rotation`, `opacity`, `locked`); every other key is as the
   * file has it. The node given back keeps `raw`'s `id` and `type`. Throw when the node cannot be read: the rest of the
   * file still loads, and this node is kept as it is in the file and saved back unchanged, drawn as an "Unreadable"
   * placeholder, skipped by an export, and never handed to this type's hooks (see `loadDocument`'s `unreadable`). The
   * failure is reported as a `HookFailure` (the message is shown when the figure opens, naming the node). Without it, a
   * node of the type is loaded as it is.
   */
  migrate?(raw: Record<string, unknown>): N;
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
    // The file format reads which types keep a link without the registries.
    registerLinkedType(t.type, t.linkField);
  }

  get(type: string): NodeType<any> | undefined {
    return this.types.get(type);
  }

  all(): NodeType<any>[] {
    return [...this.types.values()];
  }
}

/**
 * The NodeType whose hooks may run on `node`: the one registered for its type, or undefined for a type no plugin
 * registers and for a node its plugin's `migrate` hook could not read (one of `unreadable`, see `loadDocument`). Such a
 * node is handled as a placeholder, by its box: callers take the same fallback they take for an unregistered type, and
 * its type's hooks are never called on it. Every call of a node's type hooks looks its type up here.
 */
export function nodeTypeFor(registries: { nodeTypes: NodeTypeRegistry }, node: Pick<Node, "id" | "type">, unreadable?: ReadonlySet<NodeId>): NodeType<any> | undefined {
  return unreadable?.has(node.id) ? undefined : registries.nodeTypes.get(node.type);
}

/**
 * Whether an export draws `node`: not when its type is not `exportable` (a card), nor when it is drawn from a node that
 * is not exportable (`dependsOn`: a connector with an end on a card, an association among them, as only a card may be
 * tied to a page). A node no registered type can be asked about is left to the exporter, which skips it with its own
 * warning.
 */
export function isExported(doc: Document, registries: { nodeTypes: NodeTypeRegistry }, node: Node, unreadable?: ReadonlySet<NodeId>): boolean {
  const type = nodeTypeFor(registries, node, unreadable);
  if (!type) return true;
  if (type.exportable === false) return false;
  for (const id of type.dependsOn?.(node) ?? []) {
    const other = doc.nodes.find((n) => n.id === id);
    // Asked of its type even when its plugin could not read it: the flag is the type's, not the node's.
    if (other && registries.nodeTypes.get(other.type)?.exportable === false) return false;
  }
  return true;
}
