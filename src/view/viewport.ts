import { pageOriginsPx, pageSizePx, rectContainsPt, type PlacePoint, type Pt, type Rect } from "../model/geometry";
import type { Document, NodeId, Page } from "../model/types";

export interface Size {
  width: number;
  height: number;
}

/**
 * The pan/zoom transform between world (canvas) coordinates and stage pixels:
 * `screen = world * zoom + (tx, ty)`. Pure maths, so it can be tested without a DOM.
 */
export class Viewport {
  tx = 0;
  ty = 0;
  zoom = 1;
  readonly minZoom = 0.05;
  readonly maxZoom = 8;

  toScreen(p: Pt): Pt {
    return { x: p.x * this.zoom + this.tx, y: p.y * this.zoom + this.ty };
  }

  toWorld(p: Pt): Pt {
    return { x: (p.x - this.tx) / this.zoom, y: (p.y - this.ty) / this.zoom };
  }

  /** Multiplies the zoom by `factor` (clamped), keeping the world point under `screen` where it is. */
  zoomAt(screen: Pt, factor: number): void {
    if (!(factor > 0)) return;
    const next = this.clamp(this.zoom * factor);
    if (next === this.zoom) return;
    const world = this.toWorld(screen);
    this.zoom = next;
    this.tx = screen.x - world.x * next;
    this.ty = screen.y - world.y * next;
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
  }

  /** Zooms so `r` fills the stage less `paddingPx` on every side (clamped), with `r` centred. */
  fitRect(r: Rect, stage: Size, paddingPx = 40): void {
    if (r.width <= 0 || r.height <= 0 || stage.width <= 0 || stage.height <= 0) return;
    const zoom = Math.min((stage.width - 2 * paddingPx) / r.width, (stage.height - 2 * paddingPx) / r.height);
    this.centreOn({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, stage, zoom);
  }

  /** Puts the world point at the middle of the stage, at `zoom` (clamped) when given and at the current zoom otherwise. */
  centreOn(world: Pt, stage: Size, zoom: number = this.zoom): void {
    if (!Number.isFinite(zoom)) return;
    this.zoom = this.clamp(zoom);
    this.tx = stage.width / 2 - world.x * this.zoom;
    this.ty = stage.height / 2 - world.y * this.zoom;
  }

  cssTransform(): string {
    return `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
  }

  private clamp(zoom: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }
}

/** The page's rectangle in world coordinates. */
export function pageWorldRect(doc: Document, page: Page): Rect {
  const origin = pageOriginsPx(doc).get(page.id) ?? { x: 0, y: 0 };
  return { ...origin, ...pageSizePx(page) };
}

/** The page under a world point, and the point in that page's pixels; null when it is over the canvas between or around the pages. */
export function pagePointAt(doc: Document, world: Pt): PlacePoint | null {
  for (const page of doc.pages) {
    const rect = pageWorldRect(doc, page);
    if (rectContainsPt(rect, world)) return { page, x: world.x - rect.x, y: world.y - rect.y };
  }
  return null;
}

/** The page whose centre is nearest `world`; the first page on a tie, and undefined for a document without pages. */
export function nearestPage(doc: Document, world: Pt): Page | undefined {
  let best: Page | undefined;
  let bestDistance = Infinity;
  for (const page of doc.pages) {
    const r = pageWorldRect(doc, page);
    const distance = Math.hypot(r.x + r.width / 2 - world.x, r.y + r.height / 2 - world.y);
    if (distance < bestDistance) {
      best = page;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The page that page-level commands and the inspector act on: the page of the first selected node that is in the
 * document (a selection is never spread over pages), else `nearest`, the page the stage is centred on.
 */
export function pageInFocus(doc: Document, selection: readonly NodeId[], nearest: Page | undefined): Page | undefined {
  for (const id of selection) {
    const node = doc.nodes.find((n) => n.id === id);
    const page = node && doc.pages.find((p) => p.id === node.page);
    if (page) return page;
  }
  return nearest;
}
