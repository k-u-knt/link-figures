import { hasAttachedEnd, isConnector } from "../connectors/geometry";
import { alignOffsets, distributeOffsets, referenceRect, type AlignEdge, type AlignTo, type Axis, type DistributeBy } from "../model/arrange";
import type { Pt } from "../model/geometry";
import { commonParent, isLocked, unitsOf } from "../model/groups";
import type { Document, NodeId, Page } from "../model/types";
import { CommandError, type Command, type CommandContext } from "../registry/command";
import { targetIds } from "./builtin";
import { translateUnits } from "./drawing";

/**
 * Align and distribute. Both act on units: the nodes named (`ids`, else the selection) taken to their outermost units
 * within the group they share (the entered group, from the view), the effectively locked ones left out. Each unit moves
 * through `translateUnits`, as `node.move` moves, so a group moves whole and connectors follow their items; all in one
 * commit, one undo step. The toolbar buttons run the two with an edge or an axis.
 */

const EDGES: AlignEdge[] = ["left", "hcenter", "right", "top", "vcenter", "bottom"];

type AlignArgs = { ids?: unknown[]; edge: AlignEdge; to?: AlignTo };
type DistributeArgs = { ids?: unknown[]; axis: Axis; by: DistributeBy };

/**
 * The units named nodes act as, unlocked ones only (see the module comment). A connector with an attached end is left
 * out: it follows its items and cannot move as a whole; one with two free ends is a unit.
 */
function unitsFor(doc: Document, ids: readonly NodeId[]): NodeId[] {
  const follows = (id: NodeId) => {
    const node = doc.nodes.find((n) => n.id === id);
    return isConnector(node) && hasAttachedEnd(node);
  };
  return unitsOf(doc, ids, commonParent(doc, ids)).filter((id) => !isLocked(doc, id) && !follows(id));
}

/** The units of the selection, for a toolbar button's `applies`; none headless. */
function selectedUnits(ctx: CommandContext): NodeId[] {
  const doc = ctx.store.doc;
  const present = new Set(doc.nodes.map((n) => n.id));
  return unitsFor(doc, ctx.selection.filter((id) => present.has(id)));
}

/** The one page all `units` are on; refuses units on different pages. */
function pageOfUnits(doc: Document, command: string, units: readonly NodeId[]): Page {
  const pages = new Set(units.map((id) => doc.nodes.find((n) => n.id === id)?.page));
  const page = doc.pages.find((p) => pages.has(p.id));
  if (pages.size !== 1 || !page) throw new CommandError(`${command}: the items are on different pages`);
  return page;
}

/** Moves each unit by its offset, in one commit labelled `command`; nothing is committed when no unit moves. */
function applyOffsets(ctx: CommandContext, command: string, offsets: Map<NodeId, Pt>): void {
  const moves = [...offsets].filter(([, d]) => d.x !== 0 || d.y !== 0);
  if (moves.length === 0) return;
  ctx.store.commit(command, (draft) => {
    for (const [id, d] of moves) translateUnits(draft, [id], d.x, d.y, ctx.registries, ctx.view?.unreadableNodes);
  });
}

function align(ctx: CommandContext, args: AlignArgs): { ids: NodeId[] } {
  const command = "align";
  const doc = ctx.store.doc;
  const units = unitsFor(doc, targetIds(ctx, command, args));
  if (units.length === 0) return { ids: [] };
  const page = pageOfUnits(doc, command, units);
  const to = args.to ?? (units.length >= 2 ? "selection" : "margins");
  const reference = referenceRect(doc, page, units, to, ctx.registries);
  applyOffsets(ctx, command, alignOffsets(doc, units, args.edge, reference, ctx.registries));
  return { ids: units };
}

function distribute(ctx: CommandContext, args: DistributeArgs): { ids: NodeId[] } {
  const command = "distribute";
  const doc = ctx.store.doc;
  const units = unitsFor(doc, targetIds(ctx, command, args));
  if (units.length < 3) throw new CommandError(`${command}: needs at least three items`);
  pageOfUnits(doc, command, units);
  applyOffsets(ctx, command, distributeOffsets(doc, units, args.axis, args.by, ctx.registries));
  return { ids: units };
}

const BUTTONS: { edge: AlignEdge; name: string; icon: string }[] = [
  { edge: "left", name: "Align left", icon: "align-start-vertical" },
  { edge: "hcenter", name: "Align centre", icon: "align-center-vertical" },
  { edge: "right", name: "Align right", icon: "align-end-vertical" },
  { edge: "top", name: "Align top", icon: "align-start-horizontal" },
  { edge: "vcenter", name: "Align middle", icon: "align-center-horizontal" },
  { edge: "bottom", name: "Align bottom", icon: "align-end-horizontal" },
];

export function arrangeCommands(): Command[] {
  const always = () => true;
  return [
    {
      id: "align",
      name: "Align",
      icon: "align-start-vertical",
      group: "align",
      hidden: true,
      params: {
        ids: { type: "array" },
        edge: { type: "string", required: true, enum: EDGES },
        to: { type: "string", enum: ["selection", "page", "margins"] },
      },
      applies: always,
      run: (ctx, args) => align(ctx, args as AlignArgs),
    },
    {
      id: "distribute",
      name: "Distribute",
      icon: "align-horizontal-distribute-center",
      group: "distribute",
      hidden: true,
      params: {
        ids: { type: "array" },
        axis: { type: "string", required: true, enum: ["horizontal", "vertical"] },
        by: { type: "string", default: "gap", enum: ["gap", "center"] },
      },
      applies: always,
      run: (ctx, args) => distribute(ctx, args as DistributeArgs),
    },
    ...BUTTONS.map(
      ({ edge, name, icon }): Command => ({
        id: `align.${edge}`,
        name,
        icon,
        group: "align",
        menu: ["item"],
        params: { ids: { type: "array" } },
        applies: (ctx) => selectedUnits(ctx).length >= 1,
        run: (ctx, args) => align(ctx, { ...(args as { ids?: unknown[] }), edge }),
      }),
    ),
    ...(["horizontal", "vertical"] as const).map(
      (axis): Command => ({
        id: `distribute.${axis}`,
        name: axis === "horizontal" ? "Distribute horizontally" : "Distribute vertically",
        icon: axis === "horizontal" ? "align-horizontal-distribute-center" : "align-vertical-distribute-center",
        group: "distribute",
        menu: ["item"],
        params: { ids: { type: "array" } },
        applies: (ctx) => selectedUnits(ctx).length >= 3,
        run: (ctx, args) => distribute(ctx, { ...(args as { ids?: unknown[] }), axis, by: "gap" }),
      }),
    ),
  ];
}
