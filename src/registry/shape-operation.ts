import type { Node, NodeId, ShapeNode } from "../model/types";

/**
 * Something done to shapes as a whole (union, subtract, intersect…), working on their kinds' outlines. `run` is pure:
 * it returns the nodes to add and the ids of the nodes to remove, and the `shape.operate` command commits that as one
 * undo step. None is built in; operations come as registry entries (later this plugin's own, or another plugin's).
 */
export interface ShapeOperation {
  id: string;
  name: string;
  /** Whether the operation can run on `nodes` (the shapes named, in the order named). */
  applies(nodes: ShapeNode[]): boolean;
  run(nodes: ShapeNode[]): { add: Node[]; remove: NodeId[] };
}

export class ShapeOperationRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly operations = new Map<string, ShapeOperation>();

  register(o: ShapeOperation): void {
    this.operations.set(o.id, o);
  }

  get(id: string): ShapeOperation | undefined {
    return this.operations.get(id);
  }

  all(): ShapeOperation[] {
    return [...this.operations.values()];
  }
}
