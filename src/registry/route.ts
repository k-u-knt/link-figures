import type { Pt } from "../model/geometry";
import type { PathData } from "../model/path";
import type { Field } from "./fields";

/**
 * A resolved connector end: its point in page px and, when it is attached to an anchor, the anchor's outward unit
 * normal (`null` for a free end or one snapped to an item's centre), so a route can leave the item square to its edge.
 * `lead` (px) is how far a route must run straight out along `dir` before it turns or bends away: it keeps the length a
 * cap shortens the line by on one straight piece, so the cap sits square on the anchor and no line shows beside it.
 * It means nothing when `dir` is null.
 */
export interface EndPoint {
  pt: Pt;
  dir: Pt | null;
  lead: number;
}

/**
 * One way of drawing a connector between its ends (straight, curved, orthogonal…). `params` are the connector's own
 * `routeParams`, as they are in the file, so a route reads them defensively. `path` must give finite numbers for any
 * ends, including two ends at the same point.
 */
/** How far `other` lies ahead of `end` along `end.dir` (negative when behind); 0 for an end with no `dir`. */
function aheadOf(end: EndPoint, other: EndPoint): number {
  return end.dir ? (other.pt.x - end.pt.x) * end.dir.x + (other.pt.y - end.pt.y) * end.dir.y : 0;
}

/** How far `other` lies to the side of the line out of `end` along `end.dir`; 0 for an end with no `dir`. */
function besideOf(end: EndPoint, other: EndPoint): number {
  return end.dir ? Math.abs((other.pt.x - end.pt.x) * end.dir.y - (other.pt.y - end.pt.y) * end.dir.x) : 0;
}

/** Two unit normals within about 2.5° of opposite. */
const FACING_DOT = -0.999;

/**
 * The most `lead` (or straight stub) an end may run out along its `dir` without overshooting the other end: half the
 * distance to the other end measured along `dir`, when the other end genuinely lies ahead. Otherwise there is nothing
 * to overshoot and there is no limit (Infinity). An end without a `dir` has none (0).
 *
 * The other end genuinely lies ahead when it is ahead along `dir` and one of these holds:
 * - the two normals face each other, however far apart sideways (two stubs meeting half way make a clean Z);
 * - each end is ahead of the other, and no further to the side of it than that, as two ends looking into one quadrant
 *   (an L runs from one stub straight to the other's row or column);
 * - the other end has no normal and is no further to the side than ahead.
 * An end that is merely ahead by a little but far to the side (two ends facing the same way, one behind the other's
 * edge, or a slanted normal glancing past) keeps its full stub: the route must run along beside it anyway, and a
 * short stub would only tilt the cap or bring the line past the head.
 */
export function maxLead(end: EndPoint, other: EndPoint): number {
  if (!end.dir) return 0;
  const ahead = aheadOf(end, other);
  if (ahead <= 1e-9) return Infinity;
  if (!other.dir) return besideOf(end, other) <= ahead ? ahead / 2 : Infinity;
  if (end.dir.x * other.dir.x + end.dir.y * other.dir.y <= FACING_DOT) return ahead / 2;
  const aheadOther = aheadOf(other, end);
  if (aheadOther <= 1e-9) return Infinity;
  const quadrant = besideOf(end, other) <= aheadOther + 1e-6 && besideOf(other, end) <= ahead + 1e-6;
  return quadrant ? ahead / 2 : Infinity;
}

export interface Route {
  id: string;
  name: string;
  icon: string;
  /** The `routeParams` a connector gets when the user switches to this route. */
  defaults(): Record<string, unknown>;
  /** The route's own inspector fields; their keys are relative to the connector's `routeParams` (`"bend"`). */
  fields(params: Record<string, unknown>): Field[];
  /** The open path from `a` to `b`, starting with a move to `a.pt` and ending on `b.pt`, honouring each end's `lead`. */
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
