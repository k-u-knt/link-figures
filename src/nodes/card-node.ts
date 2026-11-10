import { boxAttachable } from "../model/attach";
import { newId } from "../model/defaults";
import { mmToPx, type Rect } from "../model/geometry";
import type { CardNode, Page } from "../model/types";
import type { NodeRenderer, NodeType, UpdateContext } from "../registry/node-type";

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

/**
 * A card's DOM for now: `.lf-node.lf-card`, its box, holding its text or its link as plain text. (The stage's Markdown
 * rendering and editing come later.)
 */
class CardNodeRenderer implements NodeRenderer {
  private readonly el: HTMLElement;

  constructor(node: CardNode, host: HTMLElement) {
    this.el = host.createDiv({ cls: ["lf-node", "lf-card"] });
    this.update(node);
  }

  update(node: CardNode): void {
    const style = this.el.style;
    style.left = `${node.x}px`;
    style.top = `${node.y}px`;
    style.width = `${node.width}px`;
    style.height = `${node.height}px`;
    style.zIndex = String(node.z);
    style.opacity = node.opacity === 1 ? "" : String(node.opacity);
    this.el.textContent = node.file !== undefined ? `${node.file}${node.subpath ?? ""}` : (node.text ?? "");
  }

  unmount(): void {
    this.el.remove();
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

  mount(node: CardNode, host: HTMLElement): NodeRenderer {
    return new CardNodeRenderer(node, host);
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
