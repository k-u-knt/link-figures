import { mmToPx, type PlacePoint } from "../model/geometry";
import type { CardNode, NodeId } from "../model/types";
import { CARD_SIZE_MM, cardContentError, cardNodeDefaults } from "../nodes/card-node";
import { roundPx } from "../view/pointer-math";
import { editor } from "./builtin";
import { CommandError, type Command, type CommandContext } from "../registry/command";
import { addNode, checkMinSize, creationPage, newNodeId, topOf } from "./drawing";

export type CardCreateArgs = {
  id?: string;
  page?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  file?: string;
  subpath?: string;
};

/**
 * A card on `page` (the page it is placed against; x and y are relative to it, as for every node) with its top-left at
 * (`x`, `y`) and 60 × 40 mm unless `width` and `height` say otherwise, above everything on its page: a text card (`text`,
 * empty when not given), or a note card (`file`, with `subpath` for a heading or a block). Both `text` and `file` are
 * refused. A card that would be on a page's paper is placed outside it by the smallest move (the store's off-paper
 * normaliser, in the same commit). One undo step; the new card is selected.
 */
export function createCard(ctx: CommandContext, args: CardCreateArgs): { id: NodeId } {
  const command = "card.create";
  // Without either, a text card with empty text.
  const text = args.file === undefined ? (args.text ?? "") : args.text;
  const error = cardContentError({ text, file: args.file, subpath: args.subpath });
  if (error !== null) throw new CommandError(`${command}: ${error}`);
  const id = newNodeId(ctx, command, args.id);
  const page = creationPage(ctx, command, args);
  checkMinSize(command, args);
  const doc = ctx.store.doc;
  const card: CardNode = cardNodeDefaults(page, args.x, args.y, doc.nodes.map((n) => n.id));
  if (id !== undefined) card.id = id;
  if (args.width !== undefined) card.width = args.width;
  if (args.height !== undefined) card.height = args.height;
  card.z = topOf(doc, page);
  if (args.file !== undefined) {
    delete card.text;
    card.file = args.file;
    if (args.subpath !== undefined) card.subpath = args.subpath;
  } else card.text = text;
  return addNode(ctx, command, card);
}

/**
 * The Card tool's press at `at` (on the canvas beside a page, or on a page's paper): `card.create` with a 60 × 40 mm
 * text card centred there, as a script would run it, which puts a card that would be on paper just outside the
 * nearest edge. The new card is selected, and starts being edited.
 */
function placeCard(ctx: CommandContext, at: PlacePoint): void {
  const view = editor(ctx);
  const x = roundPx(at.x - mmToPx(CARD_SIZE_MM.width) / 2);
  const y = roundPx(at.y - mmToPx(CARD_SIZE_MM.height) / 2);
  const before = new Set(ctx.store.doc.nodes.map((n) => n.id));
  view.runCommandById("card.create", { page: at.page.id, x, y });
  const made = ctx.store.doc.nodes.find((n) => !before.has(n.id));
  // The node host drew the card as the commit was made, so it is there to be told.
  if (made) view.activateNode(made.id);
}

/**
 * The Card tool: its button (or a context menu) arms it, and a click on the canvas, beside a page or on it, places a
 * text card there and starts editing it (see `placeCard`).
 */
const cardTool: Command = {
  id: "tool.card",
  name: "Card",
  icon: "sticky-note",
  group: "insert",
  menu: ["canvas", "page"],
  needsView: true,
  // Anywhere on the canvas: a card is placed beside a page, or just outside the paper it is pressed on.
  pressOffPaper: () => true,
  placeFromMenu: true,
  applies: (ctx) => !!ctx.page,
  run: (ctx) => editor(ctx).armTool(cardTool),
  place: placeCard,
};

/** The card commands, for the command registry. `card.create` is hidden: it needs arguments to mean anything. */
export function cardCommands(): Command[] {
  return [
    cardTool,
    {
      id: "card.create",
      name: "Create card",
      icon: "sticky-note",
      group: "insert",
      hidden: true,
      params: {
        id: { type: "string" },
        page: { type: "string" },
        x: { type: "number", required: true },
        y: { type: "number", required: true },
        width: { type: "number" },
        height: { type: "number" },
        text: { type: "string" },
        file: { type: "string" },
        subpath: { type: "string" },
      },
      applies: () => true,
      run: (ctx, args) => createCard(ctx, args as CardCreateArgs),
    },
  ];
}
