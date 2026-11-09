/**
 * Which Markdown view a drag started in, so that a drop of text is matched only against the selection of the editor
 * it was dragged out of (spec `2026-11-10-drop-from-note-design.md` §3). A selection left standing in some note must
 * not claim text dragged in from another app. The plugin calls `dragStart` from a capture-phase `dragstart` listener
 * on the document, and `clear` on `dragend` and after a `drop` has been handled.
 */

/** The slice of a workspace leaf the tracker reads: its view's container element. */
export interface LeafLike {
  view?: unknown;
}

interface Containing {
  containerEl?: { contains?: (el: unknown) => boolean };
}

interface Closest {
  closest?: (selector: string) => unknown;
}

export class EditorDragTracker {
  /** The Markdown view whose editor the current drag started in; null when it started anywhere else, or there is none. */
  source: unknown = null;

  /** `markdownLeaves` gives the open Markdown leaves (`workspace.getLeavesOfType("markdown")`). */
  constructor(private readonly markdownLeaves: () => readonly LeafLike[]) {}

  /** Records the Markdown view whose editor (`.cm-editor`) holds `target`; anything else clears the record. */
  dragStart(target: unknown): void {
    this.source = null;
    const el = target as Closest | null;
    if (!el || typeof el.closest !== "function" || !el.closest(".cm-editor")) return;
    const holding = this.markdownLeaves().filter((leaf) => (leaf.view as Containing | undefined)?.containerEl?.contains?.(target) === true);
    // One view only: a drag that cannot be told to one view is not matched at all.
    if (holding.length === 1) this.source = holding[0].view ?? null;
  }

  clear(): void {
    this.source = null;
  }
}
