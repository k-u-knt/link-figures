import { mmToPx, type PlacePoint } from "../model/geometry";
import type { CardNode, ConnectorNode, End, NodeId, PageId } from "../model/types";
import { connectorNodeDefaults } from "../model/defaults";
import { isAssociation } from "../model/attach";
import { CARD_SIZE_MM, cardContentError, cardNodeDefaults } from "../nodes/card-node";
import { roundPx } from "../view/pointer-math";
import { editor } from "./builtin";
import { CommandError, unreadableIn, type Command, type CommandContext, type ItemBarChoice } from "../registry/command";
import { isLocked } from "../model/groups";
import { embedText } from "../model/card-links";
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
 * Turns the note card `id` into a text card holding the embed of its link, `![[<linktext><subpath>]]` (`embedText`, the
 * link text from `ctx.linktext`: a missing note keeps its stored link verbatim), so it shows the same section and can
 * be written around. Its other fields stay. One undo step, which restores the note card exactly. Refused for anything
 * but a note card (a card with a link that its plugin could read).
 */
export function convertCard(ctx: CommandContext, args: { id: string }): { id: NodeId } {
  const command = "card.convert";
  const node = ctx.store.doc.nodes.find((n) => n.id === args.id);
  if (!node) throw new CommandError(`${command}: there is no node "${args.id}"`);
  const card = node as CardNode;
  if (node.type !== "card" || unreadableIn(ctx)?.has(node.id) || typeof card.file !== "string" || card.file === "") {
    throw new CommandError(`${command}: "${args.id}" is not a note card`);
  }
  const text = embedText(card.file, card.subpath ?? "", (file) => ctx.linktext?.(file) ?? file);
  // A label of its own: a commit merges into one of the same label just before it, and each convert is its own step.
  ctx.store.commit(`${command}:${node.id}`, (draft) => {
    const target = draft.nodes.find((n) => n.id === node.id) as CardNode | undefined;
    if (!target) return;
    delete target.file;
    delete target.subpath;
    target.text = text;
  });
  return { id: node.id };
}

/** Whether `end` is attached to node `id`. */
const endOn = (end: End, id: NodeId): boolean => end.kind === "attached" && end.node === id;

/**
 * The associations of item `id` (connectors tied to a page at one end and attached to it at the other, see
 * `isAssociation`), in document order. A connector its plugin could not read is never one: it is left as it is.
 */
export function tiesOf(ctx: Pick<CommandContext, "store" | "registries" | "unreadable">, id: NodeId): ConnectorNode[] {
  const doc = ctx.store.doc;
  const unreadable = unreadableIn(ctx);
  return doc.nodes.filter(
    (n): n is ConnectorNode =>
      n.type === "connector" && !unreadable?.has(n.id) && isAssociation(doc, n as ConnectorNode, ctx.registries, unreadable) && (n as ConnectorNode).ends.some((e) => endOn(e, id)),
  );
}

/**
 * Whether `tie` is already what `card.tie` makes for item `id` and `page`: the item's end attached at its centre (no
 * anchor) and the page end on `page` with no anchor, compared field by field.
 */
function isCentreTie(tie: ConnectorNode, id: NodeId, page: PageId): boolean {
  const at = endOn(tie.ends[0], id) ? 0 : 1;
  const item = tie.ends[at];
  const other = tie.ends[1 - at];
  return (
    item.kind === "attached" && item.node === id && item.snap === "center" && !("anchor" in item) &&
    other.kind === "page" && other.page === page && other.anchor === undefined
  );
}

/**
 * Sets the one page item `id` (a card: any item whose type may be tied to pages, `NodeType.pageTies`) is tied to.
 * `page` null removes all its associations. A page replaces them with one, from the item's centre (`snap: "center"`)
 * to the page with no anchor (its centre), both clipped at the outlines: the first association is re-aimed (its id and
 * look stay) and the rest are deleted. An item with one association already tied that way to `page` is left alone.
 * Its other connectors stay. One undo step, under a label of its own for each choice, so two choices in a row are two
 * steps. Refused for a page that is not the figure's (one deleted while the card bar's dropdown was open), and when
 * a tie it would move or delete is locked.
 */
export function tieCard(ctx: CommandContext, args: { id: string; page: string | null }): { connector: NodeId | null } {
  const command = "card.tie";
  const doc = ctx.store.doc;
  const node = doc.nodes.find((n) => n.id === args.id);
  if (!node) throw new CommandError(`${command}: there is no node "${args.id}"`);
  // The flag is the type's, even for an item its plugin could not read (see `onPageTiedItem`).
  if (ctx.registries.nodeTypes.get(node.type)?.pageTies !== true) throw new CommandError(`${command}: "${args.id}" cannot be tied to a page`);
  const page = args.page;
  if (page !== null && !doc.pages.some((p) => p.id === page)) throw new CommandError(`${command}: there is no page "${page}"`);
  const ties = tiesOf(ctx, node.id);
  const itemEnd: End = { kind: "attached", node: node.id, snap: "center" };
  const pageEnd: End | null = page === null ? null : { kind: "page", page };
  if (pageEnd === null && ties.length === 0) return { connector: null };
  if (page !== null && ties.length === 1 && isCentreTie(ties[0], node.id, page)) return { connector: ties[0].id };
  // Every tie is moved or deleted from here on: none may be locked (itself or by its group).
  if (ties.some((c) => isLocked(doc, c.id))) throw new CommandError(`${command}: a tie of "${node.id}" is locked`);
  const kept = pageEnd === null ? null : (ties[0] ?? null);
  const gone = new Set(ties.filter((c) => c !== kept).map((c) => c.id));
  let made: ConnectorNode | null = null;
  if (pageEnd !== null && kept === null) {
    const home = doc.pages.find((p) => p.id === node.page) ?? doc.pages[0];
    const route = ctx.registries.routes.get("straight");
    made = connectorNodeDefaults(home, { ends: [itemEnd, pageEnd], routeParams: route?.defaults() ?? {}, z: topOf(doc, home) }, doc.nodes.map((n) => n.id));
  }
  ctx.store.commit(`${command}:${node.id}:${page ?? ""}`, (draft) => {
    if (gone.size > 0) draft.nodes = draft.nodes.filter((n) => !gone.has(n.id));
    if (made) draft.nodes.push(structuredClone(made));
    if (kept && pageEnd) {
      const target = draft.nodes.find((n) => n.id === kept.id) as ConnectorNode | undefined;
      if (!target) return;
      // The direction stays: the item's end is where it was.
      const at = endOn(target.ends[0], node.id) ? 0 : 1;
      target.ends[at] = itemEnd;
      target.ends[1 - at] = pageEnd;
    }
  });
  return { connector: made?.id ?? kept?.id ?? null };
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

/** The node types whose item bar lists the card commands. */
const CARD_BAR = ["card"];

/** The card `id` of `ctx`'s figure, read by its type (not one its plugin could not read), or undefined. */
function readableCard(ctx: CommandContext, id: NodeId): CardNode | undefined {
  const node = ctx.store.doc.nodes.find((n) => n.id === id);
  return node?.type === "card" && !unreadableIn(ctx)?.has(id) ? (node as CardNode) : undefined;
}

/** Whether `id` is a card holding text (not a 0.4.0 note card) that may be changed. */
function editableTextCard(ctx: CommandContext, id: NodeId): boolean {
  const card = readableCard(ctx, id);
  return !!card && card.file === undefined && !isLocked(ctx.store.doc, id);
}

/** Whether `id` is a 0.4.0 note card that may be changed: what "Convert to text" is offered on. */
function editableNoteCard(ctx: CommandContext, id: NodeId): boolean {
  const card = readableCard(ctx, id);
  return !!card && typeof card.file === "string" && card.file !== "" && !isLocked(ctx.store.doc, id);
}

/**
 * The card bar's Page dropdown: this figure's pages by name, plus None; "Several pages" when it has more than one tie,
 * even two to the same page, so choosing that page makes them one.
 */
function pageChoice(ctx: CommandContext, id: NodeId): ItemBarChoice {
  const tied = tiesOf(ctx, id).flatMap((c) => c.ends.flatMap((e) => (e.kind === "page" ? [e.page] : [])));
  return {
    param: "page",
    options: [{ value: null, label: "None" }, ...ctx.store.doc.pages.map((p, i) => ({ value: p.id, label: p.name || `Page ${i + 1}` }))],
    value: tied.length === 0 ? null : tied.length === 1 ? tied[0] : undefined,
    mixed: "Several pages",
  };
}

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
    {
      id: "card.convert",
      name: "Convert to text",
      icon: "type",
      group: "edit",
      hidden: true,
      params: { id: { type: "string", required: true } },
      itemBar: CARD_BAR,
      itemBarOrder: 40,
      itemBarShows: editableNoteCard,
      applies: () => true,
      run: (ctx, args) => convertCard(ctx, args as { id: string }),
    },
    {
      id: "card.edit",
      name: "Edit",
      icon: "pencil",
      group: "edit",
      // The bar's and a script's: it starts the in-place edit of the one selected text card, as a double-click does.
      hidden: true,
      needsView: true,
      itemBar: CARD_BAR,
      itemBarOrder: 10,
      itemBarShows: editableTextCard,
      applies: (ctx) => ctx.selection.length === 1 && editableTextCard(ctx, ctx.selection[0]),
      run(ctx) {
        if (ctx.selection.length !== 1 || !editableTextCard(ctx, ctx.selection[0])) throw new CommandError("card.edit: select one text card");
        editor(ctx).activateNode(ctx.selection[0]);
      },
    },
    {
      id: "card.tie",
      name: "Page",
      icon: "file",
      group: "edit",
      hidden: true,
      params: { id: { type: "string", required: true }, page: { type: "string", nullable: true, required: true } },
      itemBar: CARD_BAR,
      itemBarOrder: 0,
      itemBarChoice: pageChoice,
      applies: () => true,
      run: (ctx, args) => tieCard(ctx, args as { id: string; page: string | null }),
    },
  ];
}
