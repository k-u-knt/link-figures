import { TFile, type App, type Component } from "obsidian";
import { RESOLVE_DEBOUNCE_MS } from "../constants";
import type { NodeId } from "../model/types";
import type { InvalidationIndex } from "./invalidation";

/** Turns vault changes into one debounced `onInvalidate` call listing the nodes that depend on the changed files. */
export class LinkWatcher {
  private readonly pending = new Set<NodeId>();
  private timer: number | null = null;

  constructor(
    private readonly app: App,
    private readonly index: InvalidationIndex,
    private readonly onInvalidate: (ids: NodeId[]) => void,
    private readonly debounceMs: number = RESOLVE_DEBOUNCE_MS,
  ) {}

  /** Listeners and any pending flush are tied to `component`, so unloading it stops the watcher. */
  start(component: Component): void {
    const { vault, metadataCache } = this.app;
    component.registerEvent(vault.on("modify", (file) => this.invalidate(file)));
    component.registerEvent(vault.on("delete", (file) => this.invalidate(file)));
    component.registerEvent(
      vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.index.rename(oldPath, file.path);
        this.invalidate(file);
      }),
    );
    component.registerEvent(metadataCache.on("changed", (file) => this.invalidate(file)));
    component.register(() => this.cancel());
  }

  private invalidate(file: unknown): void {
    if (!(file instanceof TFile)) return;
    const ids = this.index.nodesFor(file.path);
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
