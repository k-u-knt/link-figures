import type { Node, NodeId } from "../model/types";
import type { Resolved } from "./types";

/**
 * Which nodes depend on which vault paths, so a changed file maps back to the nodes to re-resolve or draw again. A node's
 * paths are kept per `channel`: what its link resolved to (`"resolved"`, the default) and what its drawing reads besides
 * (`"linked"`, see `NodeType.linkedPaths`) are replaced independently of each other.
 */
export class InvalidationIndex {
  private readonly deps = new Map<NodeId, Map<string, Set<string>>>();
  /** For each path, the nodes depending on it and through how many channels. */
  private readonly nodesByPath = new Map<string, Map<NodeId, number>>();

  /** Replaces the node's dependencies on `channel` with `deps`. */
  track(nodeId: NodeId, deps: string[], channel = "resolved"): void {
    this.untrackChannel(nodeId, channel);
    const own = new Set(deps);
    if (own.size === 0) return;
    let channels = this.deps.get(nodeId);
    if (!channels) this.deps.set(nodeId, (channels = new Map()));
    channels.set(channel, own);
    for (const path of own) this.link(path, nodeId);
  }

  /** Forgets every dependency of the node, on every channel. */
  untrack(nodeId: NodeId): void {
    for (const channel of [...(this.deps.get(nodeId)?.keys() ?? [])]) this.untrackChannel(nodeId, channel);
  }

  nodesFor(path: string): NodeId[] {
    return [...(this.nodesByPath.get(path)?.keys() ?? [])];
  }

  /** True when some node depends on `path`. */
  has(path: string): boolean {
    return this.nodesByPath.has(path);
  }

  rename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const nodes = this.nodesByPath.get(oldPath);
    if (!nodes) return;
    for (const nodeId of [...nodes.keys()]) {
      for (const [channel, deps] of this.deps.get(nodeId) ?? []) {
        if (!deps.has(oldPath)) continue;
        this.track(nodeId, [...deps].map((p) => (p === oldPath ? newPath : p)), channel);
      }
    }
  }

  private untrackChannel(nodeId: NodeId, channel: string): void {
    const channels = this.deps.get(nodeId);
    const deps = channels?.get(channel);
    if (!channels || !deps) return;
    channels.delete(channel);
    if (channels.size === 0) this.deps.delete(nodeId);
    for (const path of deps) this.unlink(path, nodeId);
  }

  private link(path: string, nodeId: NodeId): void {
    let nodes = this.nodesByPath.get(path);
    if (!nodes) this.nodesByPath.set(path, (nodes = new Map()));
    nodes.set(nodeId, (nodes.get(nodeId) ?? 0) + 1);
  }

  private unlink(path: string, nodeId: NodeId): void {
    const nodes = this.nodesByPath.get(path);
    const count = nodes?.get(nodeId);
    if (!nodes || count === undefined) return;
    if (count > 1) nodes.set(nodeId, count - 1);
    else nodes.delete(nodeId);
    if (nodes.size === 0) this.nodesByPath.delete(path);
  }
}

/**
 * The nodes that resolve a link (`resolves`: file panels by default; the view also counts note cards, see
 * `NodeHost.missingIds`), in document order, whose link led nowhere because there was no file, or no image in the note,
 * to follow it to: a file that appears may mend them. A node that is not resolved yet is not missing, and one that
 * failed on a heading or on decoding is not helped by a new file.
 */
export function missingNodeIds(nodes: readonly Node[], resolved: ReadonlyMap<NodeId, Resolved>, resolves: (node: Node) => boolean = (node) => node.type === "file"): NodeId[] {
  return nodes
    .filter((node) => {
      const result = resolves(node) ? resolved.get(node.id) : undefined;
      return result?.kind === "missing" && (result.reason === "file" || result.reason === "no-image");
    })
    .map((node) => node.id);
}
