import type { Pt, Rect } from "../model/geometry";
import type { PathData } from "../model/path";
import type { Field } from "./fields";

/** A named point on a shape's edge, in page px, with `dir` the unit normal pointing out of the shape there. */
export interface Anchor {
  id: string;
  x: number;
  y: number;
  dir: Pt;
}

/**
 * One kind of shape (rectangle, ellipse…): what a shape node of that kind draws, and where connectors attach to it.
 * Everything is worked out in the node's box, unrotated, in page px; callers apply the node's rotation. `params` are
 * the node's own `params`, as they are in the file, so a kind reads them defensively.
 */
export interface ShapeKind {
  id: string;
  name: string;
  icon: string;
  /** The `params` a new shape of this kind starts with. */
  defaults(): Record<string, unknown>;
  /** The kind's own inspector fields; their keys are relative to the node's `params` (`"cornerRadius"`). */
  fields(params: Record<string, unknown>): Field[];
  /** The closed outline the shape fills and strokes. */
  outline(box: Rect, params: Record<string, unknown>): PathData;
  anchors(box: Rect, params: Record<string, unknown>): Anchor[];
}

export class ShapeKindRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly kinds = new Map<string, ShapeKind>();

  register(k: ShapeKind): void {
    this.kinds.set(k.id, k);
  }

  get(id: string): ShapeKind | undefined {
    return this.kinds.get(id);
  }

  all(): ShapeKind[] {
    return [...this.kinds.values()];
  }
}
