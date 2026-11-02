import type { Pt } from "../model/geometry";
import type { PathData } from "../model/path";
import type { Field } from "./fields";

/**
 * A resolved connector end: its point in page px and, when it is attached to an anchor, the anchor's outward unit
 * normal (`null` for a free end or one snapped to an item's centre), so a route can leave the item square to its edge.
 */
export interface EndPoint {
  pt: Pt;
  dir: Pt | null;
}

/**
 * One way of drawing a connector between its ends (straight, curved, orthogonal…). `params` are the connector's own
 * `routeParams`, as they are in the file, so a route reads them defensively. `path` must give finite numbers for any
 * ends, including two ends at the same point.
 */
export interface Route {
  id: string;
  name: string;
  icon: string;
  /** The `routeParams` a connector gets when the user switches to this route. */
  defaults(): Record<string, unknown>;
  /** The route's own inspector fields; their keys are relative to the connector's `routeParams` (`"bend"`). */
  fields(params: Record<string, unknown>): Field[];
  /** The open path from `a` to `b`, starting with a move to `a.pt` and ending on `b.pt`. */
  path(a: EndPoint, b: EndPoint, params: Record<string, unknown>): PathData;
}

export class RouteRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly routes = new Map<string, Route>();

  register(r: Route): void {
    this.routes.set(r.id, r);
  }

  get(id: string): Route | undefined {
    return this.routes.get(id);
  }

  all(): Route[] {
    return [...this.routes.values()];
  }
}
