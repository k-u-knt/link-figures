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
 * The breadcrumb segments of a note card's label, for the vault file at `path` and the card's `subpath`: the folders the
 * file is in, then its name (without `.md`, as Obsidian's short name has it), then where in it the card shows:
 * - a heading subpath (`#A`, `#A#B`): each heading in it;
 * - a block (`#^id`): the heading it is under in `cache` (the note's cached metadata), or `^id` when there is none.
 *
 * Canvas's label is `Note › subpath`; the folders are added so the label says where the note lives.
 */
export function cardLabel(path: string, subpath: string, cache: LabelCache | null | undefined): string[] {
  const parts = path.split("/").filter((p) => p !== "");
  const name = parts.pop() ?? path;
  const segments = [...parts, name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name];
  const refs = subpath.split("#").filter((p) => p !== "");
  const block = refs.length === 1 && refs[0].startsWith("^") ? refs[0] : null;
  if (block === null) return [...segments, ...refs];
  const heading = headingAbove(cache, block.slice(1));
  return [...segments, heading ?? block];
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

  /** Shows `segments` joined by `LABEL_SEPARATOR`; `missing`: greyed out, as for a note that is not in the vault. */
  show(segments: string[], missing: boolean): void {
    const el = this.el ?? this.make();
    const text = segments.join(LABEL_SEPARATOR);
    if (text !== this.shown) {
      el.textContent = text;
      this.shown = text;
    }
    el.title = text;
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
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.open(ev);
    });
    // Before the body, so the body stays the card's last child and is drawn over nothing of the label.
    this.card.insertBefore(el, this.card.firstChild);
    this.el = el;
    return el;
  }
}
