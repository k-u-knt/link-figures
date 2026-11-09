/**
 * Which Markdown view a drag started in, so that a drop of text is matched only against the selection of the editor
 * it was dragged out of (spec `2026-11-10-drop-from-note-design.md` §3). A selection left standing in some note must
 * not claim text dragged in from another app. `listenForEditorDrags` wires a tracker to a window's document (the main
 * one and each popout's).
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
    // A selection dragged out of an editor may report its Text node as the target, which has no `closest`.
    const node = target as { nodeType?: unknown; parentElement?: unknown } | null;
    const el = (node?.nodeType === 3 ? node.parentElement : target) as Closest | null;
    if (!el || typeof el.closest !== "function" || !el.closest(".cm-editor")) return;
    const holding = this.markdownLeaves().filter((leaf) => (leaf.view as Containing | undefined)?.containerEl?.contains?.(el) === true);
    // One view only: a drag that cannot be told to one view is not matched at all.
    if (holding.length === 1) this.source = holding[0].view ?? null;
  }

  clear(): void {
    this.source = null;
  }
}

/**
 * Listens for drags on `doc` (the main window's, or a popout's): `dragstart` in the capture phase, before an editor can
 * stop it; `dragend` likewise; and `drop` bubbling, so that the stage's own drop handler has read the record first.
 * Returns the function that removes the three listeners.
 */
export function listenForEditorDrags(doc: Document, tracker: EditorDragTracker): () => void {
  const start = (ev: Event) => tracker.dragStart(ev.target);
  const clear = () => tracker.clear();
  doc.addEventListener("dragstart", start, { capture: true });
  doc.addEventListener("dragend", clear, { capture: true });
  doc.addEventListener("drop", clear);
  return () => {
    doc.removeEventListener("dragstart", start, { capture: true });
    doc.removeEventListener("dragend", clear, { capture: true });
    doc.removeEventListener("drop", clear);
  };
}
