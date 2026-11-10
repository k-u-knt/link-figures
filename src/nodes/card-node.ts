import { EDITING_CLASS, EDITING_EVENT, LIVE_LINKS } from "../constants";
import { boxAttachable } from "../model/attach";
import { newId } from "../model/defaults";
import { mmToPx, type Pt, type Rect } from "../model/geometry";
import type { Resolved } from "../links/types";
import type { CardNode, Node, Page } from "../model/types";
import { cardLinks, firstLink, mapOffset, renameEdits, renameInCardText, applyEdits } from "../model/card-links";
import { joinLinktext } from "../format/links-section";
import type { LinkedPath, LinkRename, NodeRenderer, NodeType, RenderContext, UpdateContext } from "../registry/node-type";
import { CardLabel, cardLabel, type LabelCache } from "../view/card-label";
import { attachLinkSuggest, type BlockIdWriter } from "../view/card-link-suggest";
import { openCardLink, renderCard, type CardBody } from "../view/card-render";
import { noteFile, openEmbed, type LiveEmbed } from "../view/embed-adapter";

/** The size of a new card, in mm. */
export const CARD_SIZE_MM = { width: 60, height: 40 };

const boxOf = (node: CardNode): Rect => ({ x: node.x, y: node.y, width: node.width, height: node.height });

/** A new text card on `page` with its top-left at (`x`, `y`) page px: 60 × 40 mm, with empty text. */
export function cardNodeDefaults(page: Page, x: number, y: number, existingIds: Iterable<string> = []): CardNode {
  return {
    id: newId("p", existingIds),
    type: "card",
    page: page.id,
    x,
    y,
    width: mmToPx(CARD_SIZE_MM.width),
    height: mmToPx(CARD_SIZE_MM.height),
    z: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    text: "",
  };
}

/**
 * What is wrong with a card's content, or null when nothing is: `text` or `file` (a non-empty path), exactly one of
 * them, and `subpath` only with `file`. The messages are the ones `card.create` and `node.update` give, after the
 * command's name. With `linkless`, a card with neither is fine: a note card as the JSON holds it, whose link is in the
 * figure file's Links section (see `format/node-links.ts`), or whose entry is gone.
 */
export function cardContentError(card: { text?: unknown; file?: unknown; subpath?: unknown }, linkless = false): string | null {
  if (card.text !== undefined && typeof card.text !== "string") return '"text" must be a string';
  if (card.file !== undefined && (typeof card.file !== "string" || card.file === "")) return '"file" must be the path of a note';
  if (card.subpath !== undefined && typeof card.subpath !== "string") return '"subpath" must be a string';
  if (card.text !== undefined && card.file !== undefined) return "give text or file, not both";
  if (card.text === undefined && card.file === undefined && !linkless) return "give text or file";
  if (card.subpath !== undefined && card.file === undefined) return '"subpath" goes only with "file"';
  return null;
}

/** The part of the figure view (`RenderContext.component`) that editing a card goes through. */
interface EditingView {
  readOnly: boolean;
  runCommandById(id: string, args?: Record<string, unknown>): void;
  /** The plugin, whose API writes a block id into a note (`api.blockId`), for a link to a block that has none yet. */
  plugin?: { api?: { blockId?: BlockIdWriter } };
}

/** A DOM node, as `contains` takes it (the model's `Node` has the name here). */
type DomNode = NonNullable<Parameters<HTMLElement["contains"]>[0]>;

/** Whether `target` is a DOM node inside `el` (or `el` itself). */
function within(el: HTMLElement, target: EventTarget | null | undefined): boolean {
  const node = target as unknown as DomNode | null | undefined;
  return !!node && typeof node.nodeType === "number" && el.contains(node);
}

/** The part of Obsidian's metadata cache a note card's label uses. */
interface MetadataCacheLike {
  getCache?(path: string): unknown;
  on?(name: "changed", callback: (file: { path?: unknown } | null | undefined) => void): unknown;
  offref?(ref: unknown): void;
}

/** A note card's live embed (see `openEmbed`): of which file object (kept across a rename) and subpath. */
interface Live {
  embed: LiveEmbed;
  file: object;
  subpath: string;
}

/**
 * One card's DOM: `.lf-node.lf-card` (`is-note` for a note card) holding `.lf-card-body`, which shows the card's content.
 *
 * A text card shows its Markdown rendered (`renderCard`), and is edited in place: a double-click (as `lf-activate` from
 * the pointer controller) swaps the body for a plain `textarea.lf-card-editor` holding its Markdown, with link
 * suggestions while a `[[` link is typed (`attachLinkSuggest`; Escape with their list open closes only the list);
 * Escape or the textarea losing the focus ends the edit and writes what was typed with `node.update`, one undo step, and
 * nothing when it is unchanged.
 *
 * A note card shows Obsidian's own editable embed of its note's section (`openEmbed`), as Canvas's file card does: made
 * once its link resolves, and kept while the card shows that file and subpath, through moves, resizes, other commits and
 * a rename of the note. A click on its body while the card is selected alone (`edit`, from the pointer controller)
 * opens the embed's editor, which saves to the note itself; a press outside the card, or Escape in the editor, ends the
 * edit with a save. The embed goes (saving an edit first) when the card is removed, stops being a note card, shows
 * another note, or its note goes. Without the embed (`openEmbed` gives null), the card shows its section read-only, as
 * a text card is shown. The pointer controller leaves presses and keys in an editor to it (`isEditing`).
 *
 * A note card has a label above it (`CardLabel`), exactly as Canvas's file card has: `Note › Heading` (`cardLabel`), with
 * the note's full vault path as its tooltip, drawn again when Obsidian's cache of the note changes; or the link as
 * stored, greyed out after an alert icon, when the note is missing. A click on it opens the note at
 * that place in a new tab beside the figure, as Open source does; a drag from it moves the card.
 */
class CardNodeRenderer implements NodeRenderer {
  private node: CardNode;
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly label: CardLabel;
  /** The vault path the label shows (null: none, or a missing note), whose cache changes draw it again (`watchCache`). */
  private labelPath: string | null = null;
  /** Stops listening to the metadata cache (`watchCache`); a no-op when not listening. */
  private unwatchCache: () => void = () => {};
  private shown: CardBody | null = null;
  /** What the body was drawn from (the content and what was resolved for it), so an update that leaves it alone draws nothing. */
  private drawnFrom: { key: string; resolved: Resolved | undefined } | null = null;
  private editor: HTMLTextAreaElement | null = null;
  /** The text when editing began: what tells whether anything was typed. */
  private before = "";
  /** Detaches the editor's link suggestions (`attachLinkSuggest`); a no-op when not editing. */
  private detachSuggest: () => void = () => {};
  /** A note card's live embed, or null (a text card, a note not resolved or not found, no embed to be had). */
  private live: Live | null = null;
  /** Ends a note card's edit when a press lands outside the card; on the document while the note is being edited. */
  private readonly pressOutside = (ev: Event): void => {
    if (within(this.el, ev.target)) return;
    this.live?.embed.stopEditing();
  };

  constructor(node: CardNode, host: HTMLElement, private readonly ctx: RenderContext) {
    this.node = node;
    this.el = host.createDiv({ cls: ["lf-node", "lf-card"] });
    this.body = this.el.createDiv({ cls: "lf-card-body" });
    this.label = new CardLabel(this.el, (ev) => this.openNote(ev));
    // From the pointer controller only, as a text node is told: its press captured the pointer, so it finds the card in
    // the model and tells it, after a double-click on a member of a group that is not entered has entered the group.
    this.el.addEventListener("lf-activate", () => this.beginEdit());
    // A link in what the card shows opens in a new tab beside the figure (the pointer controller leaves its press alone).
    // In the capture phase: before Obsidian's own handlers in a rendered embed, so a link opens once (`openCardLink`).
    for (const type of ["click", "auxclick"] as const) this.body.addEventListener(type, (ev) => void openCardLink(ev, this.ctx), { capture: true });
    this.update(node);
    // Once the card is drawn: from now on, a change in Obsidian's cache of its note draws its label again.
    this.watchCache();
  }

  update(node: Node): void {
    this.node = node as CardNode;
    const n = this.node;
    const style = this.el.style;
    style.left = `${n.x}px`;
    style.top = `${n.y}px`;
    style.width = `${n.width}px`;
    style.height = `${n.height}px`;
    style.zIndex = String(n.z);
    style.opacity = n.opacity === 1 ? "" : String(n.opacity);
    this.el.classList.toggle("is-note", n.file !== undefined);
    // What is being typed is the user's: a change of the node does not overwrite it.
    if (!this.editor) this.draw();
    this.drawLabel();
  }

  unmount(): void {
    // The card is gone (deleted, undone, reloaded): what was being typed has nowhere to go. A note's editor saves to the note.
    this.editor = null;
    this.detachSuggest();
    this.dropLive();
    this.unwatchCache();
    this.unwatchCache = () => {};
    this.shown?.release();
    this.shown = null;
    this.el.remove();
  }

  drawn(): Promise<void> {
    return this.shown?.drawn ?? Promise.resolve();
  }

  isEditing(target?: EventTarget | null): boolean {
    if (this.editor) return target === undefined || target === this.editor;
    if (!this.live?.embed.editing()) return false;
    return target === undefined || within(this.body, target);
  }

  /** A click on the body of the selected note card opens its note's editor there (see `canEdit`). */
  edit(target: EventTarget | null, at: Pt): boolean {
    const live = this.live;
    if (!live || !within(this.body, target) || !this.canEdit()) return false;
    live.embed.edit(at);
    return live.embed.editing();
  }

  flush(): Promise<void> {
    return this.live?.embed.flush() ?? Promise.resolve();
  }

  /**
   * Ends a note's edit with a save. A text card's textarea is left alone: it is not in an iframe, and its edit ends by
   * itself (writing through the store) when it loses the focus.
   */
  stopEditing(): void {
    this.live?.embed.stopEditing();
  }

  /** While the embed's note is in the vault, the embed follows it: the watcher need not resolve the card again. */
  followsFile(): boolean {
    const live = this.live;
    if (!live) return false;
    const path = (live.file as { path?: unknown }).path;
    return typeof path === "string" && noteFile(this.ctx.app, path) === live.file;
  }

  /** A note it links or embeds changed: drawn again from scratch (its embeds rendered afresh), unless it is being edited. */
  refresh(): void {
    this.drawnFrom = null;
    if (!this.editor) this.draw();
    this.drawLabel();
  }

  /**
   * The label above a note card: where its note is (the live embed's file, which follows a rename, else what its link
   * resolved to, else the link as stored), and the place in it; the link as stored, greyed out, when it is missing.
   */
  private drawLabel(): void {
    const n = this.node;
    if (n.file === undefined) {
      this.labelPath = null;
      this.label.hide();
      return;
    }
    const subpath = n.subpath ?? "";
    const resolved = this.ctx.resolved(n.id);
    this.labelPath = null;
    if (resolved?.kind === "missing" && !this.live) {
      const linktext = joinLinktext(n.file, subpath);
      this.label.show([linktext], linktext, true);
      return;
    }
    const livePath = (this.live?.file as { path?: unknown } | undefined)?.path;
    const path = typeof livePath === "string" ? livePath : resolved?.kind === "content" ? resolved.file.path : n.file;
    this.labelPath = path;
    this.label.show(cardLabel(path, subpath, this.noteCache(path)), path, false);
  }

  /** Obsidian's metadata cache, as far as the label uses it; undefined when the app has none. */
  private metadataCache(): MetadataCacheLike | undefined {
    return (this.ctx.app as { metadataCache?: MetadataCacheLike } | undefined)?.metadataCache;
  }

  /**
   * Draws the label again when Obsidian's cache of its note changes (a heading renamed, a block moved under another),
   * even while the card's embed follows the note itself and the stage leaves the card alone.
   */
  private watchCache(): void {
    const cache = this.metadataCache();
    if (typeof cache?.on !== "function" || typeof cache.offref !== "function") return;
    const ref = cache.on("changed", (file: { path?: unknown } | null | undefined) => {
      if (this.labelPath !== null && (file === this.live?.file || file?.path === this.labelPath)) this.drawLabel();
    });
    this.unwatchCache = () => cache.offref!(ref);
  }

  /** Obsidian's cached headings and blocks of the note at `path`, or null when there is no cache to ask. */
  private noteCache(path: string): LabelCache | null {
    const cache = this.metadataCache();
    if (typeof cache?.getCache !== "function") return null;
    try {
      return (cache.getCache(path) as LabelCache | null) ?? null;
    } catch {
      return null;
    }
  }

  /** The label was clicked: the note opens at the card's place in it, in a new tab beside the figure (as Open source). */
  private openNote(ev: MouseEvent): void {
    const n = this.node;
    if (n.file !== undefined) this.ctx.openLink(joinLinktext(n.file, n.subpath ?? ""), ev, "tab");
  }

  /**
   * A linked file was renamed while the card is being edited: the editor's text, typed and not yet committed, takes the
   * new links, and so does the text editing began with, so a commit writes only what was typed. The caret stays where
   * it was in the text. (The model is renamed by the plugin, see `cardNodeType.renameLinks`.)
   */
  renameLinks(rename: LinkRename): void {
    const area = this.editor;
    if (!area) return;
    this.before = renameInCardText(this.before, rename.resolve, rename.oldPath, rename.linktext);
    const edits = renameEdits(area.value, rename.resolve, rename.oldPath, rename.linktext);
    if (edits.length === 0) return;
    const { selectionStart, selectionEnd, selectionDirection } = area;
    area.value = applyEdits(area.value, edits);
    area.setSelectionRange(mapOffset(selectionStart, edits), mapOffset(selectionEnd, edits), selectionDirection ?? undefined);
  }

  /**
   * Draws the body from the node and what was resolved for it, unless it already shows that. A note card whose live
   * embed is of the file and subpath it shows now keeps it as it is (its note renamed, re-resolved, edited).
   */
  private draw(): void {
    const n = this.node;
    const key = JSON.stringify([n.text, n.file, n.subpath]);
    const resolved = n.file === undefined ? undefined : this.ctx.resolved(n.id);
    if (this.drawnFrom && this.drawnFrom.key === key && this.drawnFrom.resolved === resolved) return;
    this.drawnFrom = { key, resolved };
    const content = n.file !== undefined && resolved?.kind === "content" ? resolved : null;
    const file = content && noteFile(this.ctx.app, content.file.path);
    const subpath = n.subpath ?? "";
    const live = this.live;
    if (live && content && live.subpath === subpath) {
      if (file === live.file) return;
      // A resolution from before a rename (its path is the note's old one) while the new one is made: the embed follows
      // the note itself, so it stays until the new resolution says what the card shows.
      if (!file && this.followsFile()) return;
    }
    this.dropLive();
    this.shown?.release();
    this.shown = (file && this.openLive(file, subpath)) || renderCard(this.body, n, this.ctx);
  }

  /** Puts Obsidian's editable embed of `file`'s `subpath` in the body; null (the body untouched) when there is none to be had. */
  private openLive(file: NonNullable<ReturnType<typeof noteFile>>, subpath: string): CardBody | null {
    const holder = this.body.ownerDocument.createElement("div");
    // Its links take their own clicks (`openCardLink`), not the stage's.
    holder.classList.add("lf-card-content", "lf-card-embed", LIVE_LINKS);
    const embed = openEmbed(this.ctx.app, file, subpath, holder, this.ctx.figurePath, {
      canEdit: () => this.canEdit(),
      onEditingChange: (editing) => this.liveEditing(editing),
    });
    if (!embed) return null;
    this.body.empty();
    this.body.appendChild(holder);
    this.live = { embed, file, subpath };
    return { drawn: embed.ready, release: () => {} };
  }

  /** Lets go of the live embed, if there is one: an edit under way is ended with a save, then the embed is unloaded. */
  private dropLive(): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    try {
      live.embed.unload();
    } catch (error) {
      console.error(`Link Figures: could not close the note of card ${this.node.id}`, error);
    }
    // Its edit's end may not have been told (the embed failed): the card is not being edited any more either way.
    this.liveEditing(false);
  }

  /** Whether the card may be edited in place now: not locked, and in a view that is not read-only. */
  private canEdit(): boolean {
    const view = this.view();
    return !this.node.locked && !!view && !view.readOnly;
  }

  /** The note's editor opened or went: the card says so, and a press outside it ends it. */
  private liveEditing(editing: boolean): void {
    const doc = this.el.ownerDocument;
    if (this.el.classList.contains(EDITING_CLASS) === editing) return;
    if (editing) doc.addEventListener("pointerdown", this.pressOutside, true);
    else doc.removeEventListener("pointerdown", this.pressOutside, true);
    this.toldEditing(editing);
    // Ended from inside (Escape): the keys go back to the stage, as when a text card's edit ends. Not when the focus
    // has gone elsewhere already.
    const active = doc.activeElement;
    if (!editing && (!active || active === doc.body || this.el.contains(active))) this.el.closest<HTMLElement>(".lf-stage")?.focus({ preventScroll: true });
  }

  /** The figure view, or null when there is none to edit through. */
  private view(): EditingView | null {
    const view = this.ctx.component as unknown as Partial<EditingView>;
    return typeof view.runCommandById === "function" ? (view as EditingView) : null;
  }

  private beginEdit(): void {
    const n = this.node;
    if (this.editor || n.file !== undefined || n.locked) return;
    const view = this.view();
    if (!view || view.readOnly) return;
    this.before = n.text ?? "";
    this.shown?.release();
    this.shown = null;
    this.drawnFrom = null;
    this.body.empty();
    const area = this.body.ownerDocument.createElement("textarea");
    area.className = "lf-card-editor";
    area.value = this.before;
    area.spellcheck = true;
    // Link suggestions first: while their list is open, its keys (Escape among them) are its own, not the edit's.
    const api = view.plugin?.api;
    const blockId: BlockIdWriter | undefined = api?.blockId ? (path, line) => api.blockId!(path, line) : undefined;
    this.detachSuggest = attachLinkSuggest(area, this.ctx.app, this.ctx.figurePath, { blockId });
    area.addEventListener("blur", () => this.endEdit(false));
    area.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || ev.isComposing) return;
      // Escape ends the edit. It must not go on to the stage, which would take it as "deselect".
      ev.preventDefault();
      ev.stopPropagation();
      this.endEdit(true);
    });
    this.body.appendChild(area);
    this.editor = area;
    this.toldEditing(true);
    area.focus({ preventScroll: true });
  }

  /** Marks the element as being edited (or not) and tells the stage, whose item bar hides meanwhile (see `view/item-bar`). */
  private toldEditing(editing: boolean): void {
    this.el.classList.toggle(EDITING_CLASS, editing);
    this.el.dispatchEvent(new CustomEvent(EDITING_EVENT, { bubbles: true }));
  }

  /** Ends the edit and writes what was typed, if it is anything new; `toStage`: the keys go back to the stage. */
  private endEdit(toStage: boolean): void {
    const area = this.editor;
    if (!area) return;
    this.editor = null;
    this.toldEditing(false);
    this.detachSuggest();
    this.detachSuggest = () => {};
    const typed = area.value.replace(/\r\n?/g, "\n");
    area.remove();
    // Compared with what editing began with: a change made elsewhere meanwhile (an undo) is not the user's to put back.
    if (typed !== this.before) this.view()?.runCommandById("node.update", { id: this.node.id, patch: { text: typed } });
    // What the model holds is what is shown, whether or not the write changed it (the card may be gone, or the view read-only).
    this.draw();
    if (toStage) this.el.closest<HTMLElement>(".lf-stage")?.focus({ preventScroll: true });
  }
}

/**
 * A card beside the figure (see `CardNode`): never exported (`exportable: false`), kept off every page's paper by the
 * store (`offPaper`), and tied to pages by connectors (`pageTies`). Connectors attach to its box. A move leaves it on
 * the page it is placed against, as it is never over a page's paper. Its content is checked by `cardContentError`, and
 * giving one kind of content in `node.update` drops the other.
 */
export const cardNodeType: NodeType<CardNode> = {
  type: "card",
  name: "Card",
  icon: "sticky-note",
  exportable: false,
  offPaper: true,
  pageTies: true,
  // A note card's link is in the Links section, as a file panel's is, so it follows a rename of the note.
  linkField: { always: false },
  // Never rotated (`checkField` refuses it), so the inspector does not offer it.
  derivedFields: ["rotation"],

  mount(node: CardNode, host: HTMLElement, ctx: RenderContext): NodeRenderer {
    return new CardNodeRenderer(node, host, ctx);
  },

  /** A note card shows its linked section's content, resolved as a content panel's is; a text card has no link. */
  linkTarget: (node: CardNode) => (node.file === undefined ? null : { file: node.file, subpath: node.subpath ?? "", show: "content" }),

  /** Open source: a note card's link; a text card's first link or embed, outside code (none: nothing to open). */
  sourceLink(node: CardNode) {
    if (node.file !== undefined) return { file: node.file, subpath: node.subpath ?? "" };
    const link = firstLink(node.text ?? "");
    return link ? { file: link.target, subpath: link.subpath } : null;
  },

  /**
   * What the card's drawing reads: a text card's links and embeds (outside code), from the figure's place; a note card's,
   * the links in the section it shows, from the note's place (the note itself is its `linkTarget`).
   */
  linkedPaths(node: CardNode, ctx): LinkedPath[] {
    const resolved = node.file === undefined ? undefined : ctx.resolved(node.id);
    const from = node.file === undefined ? ctx.figurePath : resolved?.kind === "content" ? resolved.file.path : null;
    const text = node.file === undefined ? (node.text ?? "") : resolved?.kind === "content" ? resolved.markdown : "";
    if (from === null) return [];
    return cardLinks(text)
      .filter((link) => link.target !== "")
      .map((link) => ({ link: link.target, from }));
  },

  /** A text card's `[[…]]` and `![[…]]` that led to the renamed file (a note card's link is in the Links section, Obsidian's to rewrite). */
  renameLinks(node: CardNode, rename: LinkRename): CardNode {
    if (typeof node.text !== "string") return node;
    const text = renameInCardText(node.text, rename.resolve, rename.oldPath, rename.linktext);
    return text === node.text ? node : { ...node, text };
  },

  bounds: boxOf,

  inspector: () => [],

  attachable: (node: CardNode) => boxAttachable(node),

  /** Never on the paper, so never moved to the page under its centre: it stays on the page it is placed against. */
  pageAfterMove: (node: CardNode) => node.page,

  /** Text given drops the link (`file`, `subpath`); a link given drops the text. Both given are left for the check to refuse. */
  completeUpdate(_before: CardNode, after: CardNode, patch: Record<string, unknown>): CardNode {
    const text = Object.hasOwn(patch, "text");
    const link = Object.hasOwn(patch, "file");
    if (text && !link) return { ...after, file: undefined, subpath: undefined };
    if (link && !text) return { ...after, text: undefined };
    return after;
  },

  /** Its content (`cardContentError`); and a card does not rotate, so its `rotation` is 0. */
  checkField(key: string, value: unknown, _ctx: UpdateContext, node: CardNode): string | null {
    if (key === "rotation") return value === 0 ? null : "a card does not rotate";
    return key === "text" || key === "file" || key === "subpath" ? cardContentError(node) : null;
  },

  /**
   * A card as a figure file's JSON holds it: its content must be well formed (see `cardContentError`). A note card's
   * link is not in the JSON but in the Links section, which the loader applies after this, so a card with neither is fine.
   */
  migrate(raw: Record<string, unknown>): CardNode {
    const error = cardContentError(raw, true);
    if (error !== null) throw new Error(error);
    return raw as unknown as CardNode;
  },

  toSvg: () => "",

  toPptx: () => null,
};
