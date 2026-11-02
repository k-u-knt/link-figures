import type { App, Component } from "obsidian";
import type { AssetMap } from "../export/asset-types";
import type { Attachable } from "../model/attach";
import type { Rect } from "../model/geometry";
import type { Document, Node, NodeId, Page } from "../model/types";
import type { Resolved } from "../links/types";
import type { Field } from "./fields";
import type { Registries } from "./index";

export interface RenderContext {
  app: App;
  /** The plugin's registries: what a node type draws with (shape kinds, paints…). */
  registries: Registries;
  figurePath: string;
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
