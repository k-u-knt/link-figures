import type { CardNode, NodeId } from "../model/types";
import { cardContentError, cardNodeDefaults } from "../nodes/card-node";
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

/** The card commands, for the command registry. `card.create` is hidden: it needs arguments to mean anything. */
export function cardCommands(): Command[] {
  return [
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
