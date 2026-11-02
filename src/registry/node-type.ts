import type { App, Component } from "obsidian";
import type { AssetMap } from "../export/asset-types";
import type { Attachable } from "../model/attach";
import type { Pt, Rect } from "../model/geometry";
import type { PathData } from "../model/path";
import type { Document, Node, NodeId, Page } from "../model/types";
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

/** What a node type's inspector fields may depend on besides the node. */
export interface InspectorContext {
  registries: Registries;
}

/** What a node type's part in `node.update` may depend on besides the node. */
export interface UpdateContext {
  registries: Registries;
}

/** What a node type's pointer hooks (`hitTest`, `handles`, `dragHandle`) may depend on besides the node. */
export interface InteractionContext {
  registries: Registries;
  /** The document as it is now: what a node drawn from other nodes reads them from. */
  doc: Document;
  /** A setting of the open view, such as the snap mode new connector ends take (see `FigureViewLike.viewOption`). */
  viewOption(key: string): unknown;
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
   * patch leaves it, or null when it is fine. Called for each such field a patch touches; a key the type does not know
   * is fine, as the file format keeps unknown keys.
   */
  checkField?(key: string, value: unknown, ctx: UpdateContext): string | null;
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
   * True when the node is to stay on its page although a move (`node.move`) has taken the centre of its box over
   * another page; `moving` is every node of that move. A connector stays while an end is attached to an item that is
   * not moving, which a page change would leave behind. Without it, the node goes to the page under its centre.
   */
  keepsPage?(node: N, moving: ReadonlySet<NodeId>): boolean;
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
