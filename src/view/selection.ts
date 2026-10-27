import type { NodeId } from "../model/types";

type Listener = (ids: NodeId[]) => void;

/** Which nodes are selected, in the order they were picked, and who wants to know when that changes. Knows nothing of the document. */
export class SelectionState {
  /** Replaced, never changed in place, so a reference to it stays a snapshot. */
  private current: readonly NodeId[] = [];
  private readonly listeners = new Set<Listener>();

  get ids(): readonly NodeId[] {
    return this.current;
  }

  has(id: NodeId): boolean {
    return this.current.includes(id);
  }

  /** Replaces the selection; asking for what is already selected, in the same order, tells no one. */
  set(ids: readonly NodeId[]): void {
    const next = [...new Set(ids)];
    if (next.length === this.current.length && next.every((id, i) => id === this.current[i])) return;
    this.current = next;
    this.emit();
  }

  toggle(id: NodeId): void {
    this.set(this.has(id) ? this.current.filter((other) => other !== id) : [...this.current, id]);
  }

  clear(): void {
    this.set([]);
  }

  /** Returns the function that stops listening. */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    // A copy of the listeners, so one may stop listening (itself or another) while this runs.
    for (const fn of [...this.listeners]) fn([...this.current]);
  }
}
