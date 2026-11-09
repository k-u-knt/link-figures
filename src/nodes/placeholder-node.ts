import type { Rect } from "../model/geometry";
import type { Node } from "../model/types";
import type { Registries } from "../registry";
import type { NodeRenderer, NodeType } from "../registry/node-type";

const boxOf = (node: Node): Rect => ({ x: node.x, y: node.y, width: node.width, height: node.height });

/** A placeholder's DOM: a dashed `.lf-node.lf-placeholder` over the node's box, with its label. */
class PlaceholderRenderer implements NodeRenderer {
  private readonly el: HTMLElement;

  constructor(node: Node, host: HTMLElement, label: string) {
    this.el = host.createDiv({ cls: ["lf-node", "lf-placeholder"] });
    this.el.createDiv({ cls: "lf-placeholder-label", text: label });
    this.update(node);
  }

  update(n: Node): void {
    const style = this.el.style;
    style.left = `${n.x}px`;
    style.top = `${n.y}px`;
    style.width = `${n.width}px`;
    style.height = `${n.height}px`;
    style.zIndex = String(n.z);
    style.transform = n.rotation === 0 ? "" : `rotate(${n.rotation}deg)`;
    style.opacity = n.opacity === 1 ? "" : String(n.opacity);
  }

  unmount(): void {
    this.el.remove();
  }
}

/**
 * What stands in for the NodeType of `type` when no plugin registers it (a figure holding another plugin's item, with
 * that plugin missing): the stage draws a dashed box labelled "Missing: <type>", the inspector shows the base fields
 * only, and the node is pressed, moved, resized, deleted and grouped by its box, as any item is. It is never registered:
 * an export skips such a node with a warning (see `buildPageSvg`), and the file keeps it as it is.
 */
export function placeholderNodeType(type: string): NodeType {
  const label = `Missing: ${type}`;
  return {
    type,
    name: label,
    icon: "help-circle",
    mount: (node, host) => new PlaceholderRenderer(node, host, label),
    bounds: boxOf,
    inspector: () => [],
    toSvg: () => "",
  } as NodeType;
}

/** The NodeType registered for `type`, else its placeholder (see `placeholderNodeType`). */
export function nodeTypeOrPlaceholder(registries: Pick<Registries, "nodeTypes">, type: string): NodeType {
  return registries.nodeTypes.get(type) ?? placeholderNodeType(type);
}
