import type { Rect } from "../model/geometry";
import { childrenOf } from "../model/groups";
import type { GroupNode } from "../model/types";
import type { NodeRenderer, NodeType } from "../registry/node-type";

const boxOf = (node: GroupNode): Rect => ({ x: node.x, y: node.y, width: node.width, height: node.height });

/**
 * A group's DOM: an empty `.lf-group`, hidden. A group draws nothing of its own; its members are drawn as nodes of
 * their own, and the view outlines a selected group from its box.
 */
class GroupNodeRenderer implements NodeRenderer {
  private readonly el: HTMLElement;

  constructor(host: HTMLElement) {
    this.el = host.createDiv({ cls: "lf-group" });
  }

  update(): void {}

  unmount(): void {
    this.el.remove();
  }
}

/**
 * A group of nodes (see `GroupNode`): its members are the nodes whose `parent` is its id. Its box, `z`, rotation and
 * opacity are the store's group normaliser's to keep, and it has no fields of its own to inspect. It draws nothing, so
 * a page exports the same with its groups as without them.
 */
export const groupNodeType: NodeType<GroupNode> = {
  type: "group",
  name: "Group",
  icon: "group",

  mount(_node: GroupNode, host: HTMLElement): NodeRenderer {
    return new GroupNodeRenderer(host);
  },

  bounds: boxOf,

  inspector: () => [],

  derivedFields: ["rotation", "opacity"],

  members: (node, doc) => childrenOf(doc, node.id),

  toSvg: () => "",
};
