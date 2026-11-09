/**
 * Which Markdown view a drag started in, so that a drop of text is matched only against the selection of the editor
 * it was dragged out of (spec `2026-11-10-drop-from-note-design.md` §3). A selection left standing in some note must
 * not claim text dragged in from another app. `listenForEditorDrags` wires a tracker to a window's document (the main
 * one and each popout's, through `PopoutDragListeners`).
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

/**
 * Where in its note an embed dragged out of an editor is: its line (0-based) and offset in the editor's text, or null
 * for each when the editor could not say.
 */
export interface EmbedPlace {
  line: number | null;
  offset: number | null;
}

/** The unofficial and official calls `embedPlace` makes on a Markdown view's editor, each checked before it is made. */
interface EditorWithView {
  cm?: { posAtDOM?: (node: unknown) => unknown };
  offsetToPos?: (offset: number) => { line?: unknown } | null | undefined;
}

/**
 * Where `embedEl` is in the note of `view`: its offset from the editor's CodeMirror view (`editor.cm.posAtDOM`, which
 * is not part of Obsidian's API), and the line of that offset (`editor.offsetToPos`). Every call is guarded: a view
 * without them, or one that throws, gives nulls.
 */
function embedPlace(view: unknown, embedEl: unknown): EmbedPlace {
  const unknownPlace = { line: null, offset: null };
  try {
    const editor = (view as { editor?: EditorWithView } | null)?.editor;
    const posAtDOM = editor?.cm?.posAtDOM;
    if (typeof posAtDOM !== "function" || typeof editor?.offsetToPos !== "function") return unknownPlace;
    const offset = posAtDOM.call(editor.cm, embedEl);
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return unknownPlace;
    const line = editor.offsetToPos(offset)?.line;
    return typeof line === "number" && Number.isInteger(line) && line >= 0 ? { line, offset } : unknownPlace;
  } catch {
    return unknownPlace;
  }
}

export class EditorDragTracker {
  /** The Markdown view whose editor the current drag started in; null when it started anywhere else, or there is none. */
  source: unknown = null;
  /**
   * When the drag started on an embed (`.internal-embed`) in that editor, such as Live Preview's image widget, which
   * Obsidian drags as the image's file and not as a link from the note: where the embed is in the note. Else null.
   */
  embed: EmbedPlace | null = null;

  /** `markdownLeaves` gives the open Markdown leaves (`workspace.getLeavesOfType("markdown")`). */
  constructor(private readonly markdownLeaves: () => readonly LeafLike[]) {}

  /** Records the Markdown view whose editor (`.cm-editor`) holds `target`; anything else clears the record. */
  dragStart(target: unknown): void {
    this.source = null;
    this.embed = null;
    // A selection dragged out of an editor may report its Text node as the target, which has no `closest`.
    const node = target as { nodeType?: unknown; parentElement?: unknown } | null;
    const el = (node?.nodeType === 3 ? node.parentElement : target) as Closest | null;
    if (!el || typeof el.closest !== "function" || !el.closest(".cm-editor")) return;
    const holding = this.markdownLeaves().filter((leaf) => (leaf.view as Containing | undefined)?.containerEl?.contains?.(el) === true);
    // One view only: a drag that cannot be told to one view is not matched at all.
    if (holding.length !== 1) return;
    this.source = holding[0].view ?? null;
    // Placed now: by the drop, the editor may have drawn the widget again.
    const embedEl = el.closest(".internal-embed");
    if (this.source !== null && embedEl) this.embed = embedPlace(this.source, embedEl);
  }

  clear(): void {
    this.source = null;
    this.embed = null;
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

/**
 * The drag listeners on the popout windows' documents (`listenForEditorDrags`), once per document: added when a popout
 * opens, and at load for the popouts already open (`addLeaves`); removed when it closes, and all of them on unload. The
 * main window's document is left to the caller.
 */
export class PopoutDragListeners {
  private readonly offs = new Map<Document, () => void>();

  constructor(
    private readonly main: Document,
    private readonly listen: (doc: Document) => () => void,
  ) {}

  /** Listens on `doc`, unless it is the main document or is listened on already. */
  add(doc: Document | null | undefined): void {
    if (!doc || doc === this.main || this.offs.has(doc)) return;
    this.offs.set(doc, this.listen(doc));
  }

  /** Listens on the document of each leaf's view (its container element's), for the popouts open before the plugin. */
  addLeaves(leaves: readonly LeafLike[]): void {
    for (const leaf of leaves) this.add((leaf.view as { containerEl?: { ownerDocument?: Document } } | undefined)?.containerEl?.ownerDocument);
  }

  remove(doc: Document): void {
    this.offs.get(doc)?.();
    this.offs.delete(doc);
  }

  clear(): void {
    for (const off of this.offs.values()) off();
    this.offs.clear();
  }
}
