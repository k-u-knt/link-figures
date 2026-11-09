import type { Registries } from ".";
import type { Document, NodeId, Page } from "../model/types";

/**
 * A line something can snap to, in page px: a vertical line at x = `pos` (in the `x` list) or a horizontal one at
 * y = `pos` (in `y`), spanning `from`..`to` along the other axis so a guide can be drawn between the two. `kind` ranks
 * ties (page and margin before item); `source` is the id of the source, or of the item, it came from.
 */
export interface SnapLine {
  pos: number;
  from: number;
  to: number;
  kind: "item" | "page" | "margin";
  source: string;
}

/** Where things snap to: the lines on `page`, leaving out `exclude` (the units being moved) and their descendants. */
export interface SnapSource {
  id: string;
  lines(doc: Document, page: Page, exclude: Set<NodeId>, registries: Registries): { x: SnapLine[]; y: SnapLine[] };
}

export class SnapSourceRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly sources = new Map<string, SnapSource>();

  register(s: SnapSource): void {
    this.sources.set(s.id, s);
  }

  get(id: string): SnapSource | undefined {
    return this.sources.get(id);
  }

  all(): SnapSource[] {
    return [...this.sources.values()];
  }
}
