import { mmToPx, pageOriginsPx, pageSizePx } from "../model/geometry";
import type { Document, Margins, Page, PageId } from "../model/types";
import { paperInk } from "./paper-ink";

interface PageParts {
  page: HTMLElement;
  label: HTMLElement;
  nodes: HTMLElement;
  /** Present only while some margin is above zero. */
  margins: HTMLElement | null;
  overlay: HTMLElement;
}

function div(cls: string): HTMLElement {
  const el = document.createElement("div");
  el.classList.add(cls);
  return el;
}

const hasMargins = (m: Margins): boolean => m.top > 0 || m.right > 0 || m.bottom > 0 || m.left > 0;

/**
 * The sheets of paper inside the viewport element, in world coordinates (the viewport's transform does the
 * panning and zooming). Pages that are still in the document keep their elements across renders, so whatever
 * is hosted inside a page (nodes, overlays) survives a change to page size, paper or margins.
 */
export class PageLayer {
  private readonly pages = new Map<PageId, PageParts>();

  constructor(private readonly viewportEl: HTMLElement) {}

  /** Brings the sheets in line with `doc`: one `.lf-page` per page, in document order. */
  render(doc: Document): void {
    const origins = pageOriginsPx(doc);
    const live = new Set(doc.pages.map((page) => page.id));

    // Dead sheets go first: reordering the survivors around them would move elements, which reloads whatever they host.
    for (const [id, parts] of this.pages) {
      if (live.has(id)) continue;
      parts.page.remove();
      this.pages.delete(id);
    }

    let previous: HTMLElement | null = null;
    for (const page of doc.pages) {
      let parts = this.pages.get(page.id);
      if (!parts) {
        parts = this.createParts(page);
        this.pages.set(page.id, parts);
      }
      this.update(parts, page, origins.get(page.id) ?? { x: 0, y: 0 });

      // Only moves an element that is not already in its place, so a stable document touches nothing.
      const expected: ChildNode | null = previous ? previous.nextSibling : this.viewportEl.firstChild;
      if (parts.page !== expected) this.viewportEl.insertBefore(parts.page, expected);
      previous = parts.page;
    }
  }

  pageEl(id: PageId): HTMLElement | undefined {
    return this.pages.get(id)?.page;
  }

  /** Where the page's nodes are drawn. */
  nodesHost(id: PageId): HTMLElement {
    return this.partsOf(id).nodes;
  }

  /** Where the page's selection handles and guides are drawn, above its nodes. */
  overlayHost(id: PageId): HTMLElement {
    return this.partsOf(id).overlay;
  }

  private partsOf(id: PageId): PageParts {
    const parts = this.pages.get(id);
    if (!parts) throw new Error(`Link Figures: no page "${id}" is rendered`);
    return parts;
  }

  private createParts(page: Page): PageParts {
    const el = div("lf-page");
    el.dataset.pageId = page.id;
    const label = div("lf-page-label");
    const nodes = div("lf-page-nodes");
    const overlay = div("lf-page-overlay");
    el.append(label, nodes, overlay);
    return { page: el, label, nodes, margins: null, overlay };
  }

  private update(parts: PageParts, page: Page, origin: { x: number; y: number }): void {
    const size = pageSizePx(page);
    const style = parts.page.style;
    style.left = `${origin.x}px`;
    style.top = `${origin.y}px`;
    style.width = `${size.width}px`;
    style.height = `${size.height}px`;
    style.backgroundColor = page.paper;
    // What is drawn on the paper (rendered notes, placeholders, guides) takes its text colours from the paper, not the theme.
    const { ink, muted } = paperInk(page.paper);
    style.setProperty("--lf-ink", ink);
    style.setProperty("--lf-ink-muted", muted);
    if (parts.label.textContent !== page.name) parts.label.textContent = page.name;

    if (!hasMargins(page.margins)) {
      parts.margins?.remove();
      parts.margins = null;
      return;
    }
    if (!parts.margins) {
      parts.margins = div("lf-page-margins");
      // Above the nodes, below the overlay.
      parts.page.insertBefore(parts.margins, parts.overlay);
    }
    const m = parts.margins.style;
    m.top = `${mmToPx(page.margins.top)}px`;
    m.right = `${mmToPx(page.margins.right)}px`;
    m.bottom = `${mmToPx(page.margins.bottom)}px`;
    m.left = `${mmToPx(page.margins.left)}px`;
  }
}
