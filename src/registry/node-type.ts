import type { App, Component } from "obsidian";
import type { AssetMap } from "../export/asset-types";
import type { Rect } from "../model/geometry";
import type { Node, NodeId, Page } from "../model/types";
import type { Resolved } from "../links/types";
import type { Field } from "./fields";

export interface RenderContext {
  app: App;
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
  page: Page;
  assets: AssetMap;
  defs: string[];
  warnings: string[];
  uid(prefix: string): string;
}

export interface NodeType<N extends Node = Node> {
  type: N["type"];
  name: string;
  icon: string;
  mount(node: N, host: HTMLElement, ctx: RenderContext): NodeRenderer;
  bounds(node: N): Rect;
  inspector(node: N): Field[];
  /** An SVG fragment, or `"raster"` to have the node rendered by the DOM and embedded as an image. */
  toSvg(node: N, ctx: SvgContext): string | "raster";
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
