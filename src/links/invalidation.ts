import type { NodeId } from "../model/types";

/** Which nodes depend on which vault paths, so a changed file maps back to the nodes to re-resolve. */
export class InvalidationIndex {
  private readonly depsByNode = new Map<NodeId, Set<string>>();
  private readonly nodesByPath = new Map<string, Set<NodeId>>();

  /** Replaces the node's dependencies with `deps`. */
  track(nodeId: NodeId, deps: string[]): void {
    this.untrack(nodeId);
    const own = new Set(deps);
    this.depsByNode.set(nodeId, own);
    for (const path of own) this.link(path, nodeId);
  }

  untrack(nodeId: NodeId): void {
    const deps = this.depsByNode.get(nodeId);
    if (!deps) return;
    this.depsByNode.delete(nodeId);
    for (const path of deps) {
      const nodes = this.nodesByPath.get(path);
      if (!nodes) continue;
      nodes.delete(nodeId);
      if (nodes.size === 0) this.nodesByPath.delete(path);
    }
  }

  nodesFor(path: string): NodeId[] {
    return [...(this.nodesByPath.get(path) ?? [])];
  }

  rename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const nodes = this.nodesByPath.get(oldPath);
    if (!nodes) return;
    this.nodesByPath.delete(oldPath);
    for (const nodeId of nodes) {
      const deps = this.depsByNode.get(nodeId);
      deps?.delete(oldPath);
      deps?.add(newPath);
      this.link(newPath, nodeId);
    }
  }

  private link(path: string, nodeId: NodeId): void {
    const nodes = this.nodesByPath.get(path);
    if (nodes) nodes.add(nodeId);
    else this.nodesByPath.set(path, new Set([nodeId]));
  }
}
