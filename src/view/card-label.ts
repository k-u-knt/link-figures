import { setIcon } from "obsidian";
import { NODE_GRIP } from "../constants";

/** What separates the label's segments: Canvas's own (`Note › Heading` above a file card). */
export const LABEL_SEPARATOR = " › ";

/** A line in a note, as Obsidian's metadata cache gives a heading's or a block's position. */
interface CachedAt {
  position: { start: { line: number } };
}

/** The part of Obsidian's `CachedMetadata` the label reads: a note's headings, and its blocks by id. */
export interface LabelCache {
  headings?: (CachedAt & { heading: string })[];
  blocks?: Record<string, CachedAt>;
}

/**
 * The segments of a note card's label, as Canvas labels a file card, for the vault file at `path` and the card's
 * `subpath`: the file's short name (a note's name without `.md`; another file's full name), then, for a note with a
 * subpath, where in it the card shows:
 * - a heading subpath: the subpath after its `#` (`#A#B` gives `A#B`, as Canvas shows it);
 * - a block (`#^id`): the heading it is under in `cache` (the note's cached metadata), or `^id` when there is none.
 *
 * The folders are not shown, as in Canvas: the full path is the label's tooltip.
 */
export function cardLabel(path: string, subpath: string, cache: LabelCache | null | undefined): string[] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const isNote = name.toLowerCase().endsWith(".md");
  const short = isNote ? name.slice(0, -3) : name;
  const place = subpath.replace(/^#/, "");
  if (!isNote || place === "") return [short];
  if (!/^\^[^#]*$/.test(place)) return [short, place];
  return [short, headingAbove(cache, place.slice(1)) ?? place];
}

/** The heading the block `id` is under in `cache`: the last heading starting on or before its line, or null. */
function headingAbove(cache: LabelCache | null | undefined, id: string): string | null {
  const line = cache?.blocks?.[id]?.position?.start?.line;
  if (typeof line !== "number") return null;
  let found: string | null = null;
  for (const h of cache?.headings ?? []) {
    if (h.position.start.line > line) break;
    found = h.heading;
  }
  return found;
}

/**
 * A note card's label, drawn above the card (`.lf-card-label`, a child of the card's element so it follows the card).
 * It keeps its size on screen at any zoom through the stage's `--lf-zoom` (see styles.css), and it is not part of any
 * export, which draws from the model and never from the DOM. A click on it calls `open`; a press dragged from it is a
 * press on the card (`NODE_GRIP`).
 */
export class CardLabel {
  private el: HTMLElement | null = null;
  private shown = "";

  constructor(
    private readonly card: HTMLElement,
    private readonly open: (ev: MouseEvent) => void,
  ) {}

  /**
   * Shows `segments` joined by `LABEL_SEPARATOR`, with `tooltip` (the note's full vault path) as its tooltip. `missing`:
   * greyed out after Obsidian's alert icon, as Canvas shows a file that is not in the vault.
   */
  show(segments: string[], tooltip: string, missing: boolean): void {
    const el = this.el ?? this.make();
    const text = segments.join(LABEL_SEPARATOR);
    const key = JSON.stringify([text, missing]);
    if (key !== this.shown) {
      el.textContent = "";
      if (missing) {
        const icon = el.ownerDocument.createElement("span");
        icon.classList.add("lf-card-label-icon");
        setIcon(icon, "alert-triangle");
        el.appendChild(icon);
      }
      el.appendChild(el.ownerDocument.createTextNode(text));
      this.shown = key;
    }
    // Obsidian shows an element's aria-label as its tooltip (as the item bar's buttons have it): no native title too.
    el.setAttribute("aria-label", tooltip);
    el.classList.toggle("is-missing", missing);
  }

  /** Takes the label away (a text card has none). */
  hide(): void {
    this.el?.remove();
    this.el = null;
    this.shown = "";
  }

  private make(): HTMLElement {
    const el = this.card.ownerDocument.createElement("div");
    el.classList.add("lf-card-label", NODE_GRIP);
    // A click, or a middle-click (`auxclick` with the middle button), opens the note.
    const open = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.open(ev);
    };
    // The second click of a double-click opens nothing more.
    el.addEventListener("click", (ev) => {
      if (ev.detail > 1) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      open(ev);
    });
    el.addEventListener("auxclick", (ev) => {
      if (ev.button === 1) open(ev);
    });
    // Before the body, so the body stays the card's last child and is drawn over nothing of the label.
    this.card.insertBefore(el, this.card.firstChild);
    this.el = el;
    return el;
  }
}
