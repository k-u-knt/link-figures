import { boxAttachable } from "../model/attach";
import { newId } from "../model/defaults";
import { mmToPx, type Rect } from "../model/geometry";
import type { Resolved } from "../links/types";
import type { CardNode, Node, Page } from "../model/types";
import { firstLink, mapOffset, renameEdits, renameInCardText, applyEdits } from "../model/card-links";
import type { LinkRename, NodeRenderer, NodeType, RenderContext, UpdateContext } from "../registry/node-type";
import { attachLinkSuggest, type BlockIdWriter } from "../view/card-link-suggest";
import { openCardLink, renderCard, type CardBody } from "../view/card-render";

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

/**
 * One card's DOM: `.lf-node.lf-card` (`is-note` for a note card) holding `.lf-card-body`, which shows the card's content
 * (`renderCard`). A text card is edited in place: a double-click (as `lf-activate` from the pointer controller) swaps the body for a plain `textarea.lf-card-editor` holding its Markdown, with link suggestions while a `[[` link is
 * typed (`attachLinkSuggest`; Escape with their list open closes only the list); Escape or the textarea
 * losing the focus ends the edit and writes what was typed with `node.update`, one undo step, and nothing when it is
 * unchanged. The pointer controller leaves presses and keys on the textarea to it (`isEditable`).
 */
class CardNodeRenderer implements NodeRenderer {
  private node: CardNode;
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private shown: CardBody | null = null;
  /** What the body was drawn from (the content and what was resolved for it), so an update that leaves it alone draws nothing. */
  private drawnFrom: { key: string; resolved: Resolved | undefined } | null = null;
  private editor: HTMLTextAreaElement | null = null;
  /** The text when editing began: what tells whether anything was typed. */
  private before = "";
  /** Detaches the editor's link suggestions (`attachLinkSuggest`); a no-op when not editing. */
  private detachSuggest: () => void = () => {};

  constructor(node: CardNode, host: HTMLElement, private readonly ctx: RenderContext) {
    this.node = node;
    this.el = host.createDiv({ cls: ["lf-node", "lf-card"] });
    this.body = this.el.createDiv({ cls: "lf-card-body" });
    // From the pointer controller only, as a text node is told: its press captured the pointer, so it finds the card in
    // the model and tells it, after a double-click on a member of a group that is not entered has entered the group.
    this.el.addEventListener("lf-activate", () => this.beginEdit());
    // A link in what the card shows opens in a new tab beside the figure (the pointer controller leaves its press alone).
    // In the capture phase: before Obsidian's own handlers in a rendered embed, so a link opens once (`openCardLink`).
    for (const type of ["click", "auxclick"] as const) this.body.addEventListener(type, (ev) => void openCardLink(ev, this.ctx), { capture: true });
    this.update(node);
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
  }

  unmount(): void {
    // The card is gone (deleted, undone, reloaded): what was being typed has nowhere to go.
    this.editor = null;
    this.detachSuggest();
    this.shown?.release();
    this.shown = null;
    this.el.remove();
  }

  drawn(): Promise<void> {
    return this.shown?.drawn ?? Promise.resolve();
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

  /** Draws the body from the node and what was resolved for it, unless it already shows that. */
  private draw(): void {
    const n = this.node;
    const key = JSON.stringify([n.text, n.file, n.subpath]);
    const resolved = n.file === undefined ? undefined : this.ctx.resolved(n.id);
    if (this.drawnFrom && this.drawnFrom.key === key && this.drawnFrom.resolved === resolved) return;
    this.drawnFrom = { key, resolved };
    this.shown?.release();
    this.shown = renderCard(this.body, n, this.ctx);
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
    area.focus({ preventScroll: true });
  }

  /** Ends the edit and writes what was typed, if it is anything new; `toStage`: the keys go back to the stage. */
  private endEdit(toStage: boolean): void {
    const area = this.editor;
    if (!area) return;
    this.editor = null;
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
