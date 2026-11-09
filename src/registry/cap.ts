import type { PathData } from "../model/path";

/** The size a new cap gets, as a multiple of the stroke's width. */
export const DEFAULT_CAP_SIZE = 3;

/**
 * One kind of connector end (arrowhead, dot, bar…). Its `path` is a closed area filled with the connector's stroke
 * paint, drawn with the end of the line at the origin and the line arriving from −x (so it points along +x); the
 * caller turns it to the path's tangent and moves it to the end. `size` is the cap's `size` (a multiple of the stroke's
 * width) and `strokeWidthPx` that width in px. `inset` is how far, in px, the line stops short of its end so it does
 * not show through or past the cap.
 */
export interface CapKind {
  id: string;
  name: string;
  path(size: number, strokeWidthPx: number): PathData;
  inset(size: number, strokeWidthPx: number): number;
  /**
   * The DrawingML line end (`a:headEnd`/`a:tailEnd` `type`: `none`, `triangle`, `arrow`, `oval`, `stealth`, `diamond`)
   * nearest the cap, for an editable PowerPoint export. A kind without it is written as no line end, with a warning.
   */
  pptxEnd?: "none" | "triangle" | "arrow" | "oval" | "stealth" | "diamond";
}

export class CapKindRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly kinds = new Map<string, CapKind>();

  register(k: CapKind): void {
    this.kinds.set(k.id, k);
  }

  get(id: string): CapKind | undefined {
    return this.kinds.get(id);
  }

  all(): CapKind[] {
    return [...this.kinds.values()];
  }
}
