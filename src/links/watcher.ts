import { TFile, type App, type Component } from "obsidian";
import { RESOLVE_DEBOUNCE_MS } from "../constants";
import type { NodeId } from "../model/types";
import type { InvalidationIndex } from "./invalidation";

/**
 * Turns vault changes into one debounced `onInvalidate` call listing the nodes to resolve again: those that depend on a
 * changed file, and, when a file appears (is created, or renamed to a new name), those that are missing, as a file by
 * the name they are waiting for may just have appeared. A missing node depends on no file, so the index cannot find it.
 */
export class LinkWatcher {
  private readonly pending = new Set<NodeId>();
  private timer: number | null = null;

  constructor(
    private readonly app: App,
    private readonly index: InvalidationIndex,
    private readonly onInvalidate: (ids: NodeId[]) => void,
    /** The nodes that are missing right now, asked for whenever a file appears. */
    private readonly missingIds: () => NodeId[],
    private readonly debounceMs: number = RESOLVE_DEBOUNCE_MS,
  ) {}

  /** Listeners and any pending flush are tied to `component`, so unloading it stops the watcher. */
  start(component: Component): void {
    const { vault, metadataCache } = this.app;
    component.registerEvent(vault.on("modify", (file) => this.invalidate(file)));
    component.registerEvent(vault.on("delete", (file) => this.invalidate(file)));
    component.registerEvent(
      vault.on("create", (file) => {
        if (file instanceof TFile) this.queue(this.missingIds());
      }),
    );
    component.registerEvent(
      vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.index.rename(oldPath, file.path);
        this.queue([...this.index.nodesFor(file.path), ...this.missingIds()]);
      }),
    );
    component.registerEvent(metadataCache.on("changed", (file) => this.invalidate(file)));
    component.register(() => this.cancel());
  }

  private invalidate(file: unknown): void {
    if (file instanceof TFile) this.queue(this.index.nodesFor(file.path));
  }

  /** Each burst of events is one flush, which comes once they have stopped for the debounce time. */
  private queue(ids: NodeId[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.pending.add(id);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = null;
    const ids = [...this.pending];
    this.pending.clear();
    this.onInvalidate(ids);
  }

  private cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
