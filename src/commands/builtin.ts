import { resolveConnector } from "../connectors/geometry";
import { DEFAULT_PAGE_LIMIT_MM, MIN_NODE_PX } from "../constants";
import { joinLinktext } from "../format/links-section";
import { linkOf } from "../format/node-links";
import { createPage, newId, textNodeDefaults } from "../model/defaults";
import { mmToPx, pageOriginsPx, pageSizePx, type PlacePoint, type Rect } from "../model/geometry";
import { commonParent, expandUnits, isGroup, isLocked, unitsOf } from "../model/groups";
import { PAGE_PRESETS, getPreset } from "../model/presets";
import { SNAP_OPTION, snapOn } from "../model/snap";
import type { Document, End, FileNode, Node, NodeId, Page, PageId } from "../model/types";
import type LinkFiguresPlugin from "../main";
import { CommandError, markUnreadableIn, unreadableIn, type Command, type CommandContext, type FigureViewLike } from "../registry/command";
import type { ParamSpec } from "../registry/params";
import { nodeTypeFor, type ImageState, type NodeType } from "../registry/node-type";
import type { Plane } from "../links/decoders/tiff-convert";
import { CUSTOM_PRESET, clampPageSize } from "../view/page-fields";
import { roundPx } from "../view/pointer-math";

/** How far a duplicate sits from its original, along both axes. */
const DUPLICATE_OFFSET_MM = 5;

/**
 * The figure view as the built-in commands use it: `FigureViewLike` plus what only the real view offers. The view a
 * command is given (`CommandContext.view`) is always that one, and `LinkFiguresView` implements this to keep it so.
 */
export interface EditorView extends FigureViewLike {
  /** Opens a link target (`file`, `file#subpath`) from the figure's own place in the vault, as the badge on a node does. */
  openLink(linktext: string, newLeaf?: boolean): void;
  /** The natural size of the image a node shows, once it has loaded; rejects for a node that shows no image. */
  imageSize(id: NodeId): Promise<{ width: number; height: number }>;
  /** The natural size of the image a node shows if it has loaded, else null (a command that cannot wait asks this). */
  imageSizeNow(id: NodeId): { width: number; height: number } | null;
  /** The URL the image a node shows was loaded from, if it has loaded, else null. */
  imageSourceNow(id: NodeId): string | null;
  /** Whether node `id` shows an image now (see `ImageState`): `none` for a panel that shows only its badge. */
  imageStateNow(id: NodeId): ImageState | null;
  /**
   * The decoded samples of the TIFF or raster image panel `id` shows, if they are cached, else null (and their decode
   * starts; the chrome is drawn again when it lands). Absent on a view that cannot decode.
   */
  samplesNow?(id: NodeId): Plane | null;
  /** Starts crop mode on the page for the image panel `id`; a rotated panel shows a Notice instead. */
  startCrop(id: NodeId): void;
  /** Shows `message` to the user as a Notice. */
  notify(message: string): void;
  /** Tells a node what a double-click on it tells it (a text node starts editing). */
  activateNode(id: NodeId): void;
  /** The largest width or height a page may have, in millimetres (the Maximum page size setting). */
  pageLimitMm(): number;
  /** Says that a page size had to be cut down to `limitMm` (the view shows a notice, as the inspector's edits do). */
  notePageLimit(limitMm: number): void;
}

/** The view a `needsView` command acts on; the API refuses such a command headless, so this only guards against a slip. */
export function editor(ctx: CommandContext): EditorView {
  if (!ctx.view) throw new CommandError("this command needs the figure to be open");
  return ctx.view as EditorView;
}

/**
 * The largest width or height a page a command writes may have, in mm: the Maximum page size setting, from the view,
 * else from the headless context (`CommandContext.pageLimitMm`), else its default.
 */
export function pageLimitMm(ctx: CommandContext): number {
  return ctx.view ? editor(ctx).pageLimitMm() : (ctx.pageLimitMm ?? DEFAULT_PAGE_LIMIT_MM);
}

/** Does `fn`, a side effect on the view, once the edit is in: at once, or within a batch after the batch commits. */
export function whenCommitted(ctx: CommandContext, fn: () => void): void {
  if (ctx.afterCommit) ctx.afterCommit(fn);
  else fn();
}

/** The arguments of a command that acts on nodes: `ids` names them, in place of the selection. */
type NodesArgs = { ids?: unknown[] };

/** The parameters of a command that acts on nodes. */
const NODES_PARAMS: ParamSpec = { ids: { type: "array" } };

/**
 * The nodes a command acts on: `args.ids` when the call names them, else the selection. Headless there is no selection,
 * so the ids must be given. A given id that is not a node of the figure is an error, so a script learns of its slip.
 */
export function targetIds(ctx: CommandContext, command: string, args: NodesArgs | undefined): NodeId[] {
  const ids = args?.ids;
  if (ids === undefined) {
    if (!ctx.view) throw new CommandError(`${command} needs "ids" when the figure is not open`);
    return ctx.selection;
  }
  const present = new Set(ctx.store.doc.nodes.map((n) => n.id));
  for (const id of ids) {
    if (typeof id !== "string") throw new CommandError(`parameter "ids" must hold node ids (strings)`);
    if (!present.has(id)) throw new CommandError(`${command}: there is no node "${id}"`);
  }
  return ids as NodeId[];
}

/** The page a page-level command acts on: the one `args.page` names, else the view's focus page; undefined when neither is. */
export function targetPage(ctx: CommandContext, command: string, args: { page?: unknown } | undefined): Page | undefined {
  if (args?.page === undefined) return ctx.page;
  const page = ctx.store.doc.pages.find((p) => p.id === args.page);
  if (!page) throw new CommandError(`${command}: there is no page "${String(args.page)}"`);
  return page;
}

/** The parameters of a page-level command. */
const PAGE_PARAMS: ParamSpec = { page: { type: "string" } };
/** `add-page`'s: the page it goes after, and the page preset it has (else it is like that page). */
const ADD_PAGE_PARAMS: ParamSpec = { ...PAGE_PARAMS, preset: { type: "string" } };

/**
 * The new `z` of the nodes that move one place up (`forward`) or down (`backward`) the stack of one page. The stack is
 * a tree of units: the nodes at top level, and in each container (`isContainer`: a group, whose own `z` is derived from
 * its members and is not restacked) its members, each unit placed by its topmost node. Each selected unit trades places
 * with the nearest unit past it among its siblings that is not selected, so a selected block moves as a block, a group
 * moves as one block with its members in their order, and a member moves among its group's members only. `nodes` are
 * one page's, in document order, which settles the order of nodes that share a `z`. When something moves, the page is
 * laid out again unit by unit, which also gathers a group whose members had come apart (after `group.add`) into one
 * block at its topmost member. Empty when nothing moves (the selection is already at that end of its stack).
 */
export function restack(
  nodes: readonly Pick<Node, "id" | "z" | "parent">[],
  selected: ReadonlySet<NodeId>,
  direction: "forward" | "backward",
  isContainer: (id: NodeId) => boolean = () => false,
): Map<NodeId, number> {
  const order = nodes.map((n, index) => ({ id: n.id, z: n.z, index })).sort((a, b) => a.z - b.z || a.index - b.index);
  const leaves = order.filter((n) => !isContainer(n.id));
  const zs = leaves.map((n) => n.z);
  const ids = new Set(nodes.map((n) => n.id));
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent !== undefined && n.parent !== n.id && ids.has(n.parent) ? n.parent : null] as const));
  const children = new Map<NodeId | null, NodeId[]>();
  for (const n of nodes) {
    const parent = parentOf.get(n.id) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), n.id]);
  }
  // Each unit's place: its topmost leaf's place in the stack.
  const rank = new Map(leaves.map((n, i) => [n.id, i] as const));
  const top = (id: NodeId, seen = new Set<NodeId>()): number => {
    if (seen.has(id)) return -1;
    seen.add(id);
    return Math.max(rank.get(id) ?? -1, ...(children.get(id) ?? []).map((c) => top(c, seen)));
  };
  let moved = false;
  const visited = new Set<NodeId>();
  const flatten = (parent: NodeId | null): NodeId[] => {
    const list = (children.get(parent) ?? []).filter((id) => !visited.has(id));
    for (const id of list) visited.add(id);
    const units = list.map((id) => ({ id, top: top(id) })).sort((a, b) => a.top - b.top).map((u) => u.id);
    const swap = (i: number, j: number): void => {
      [units[i], units[j]] = [units[j], units[i]];
      moved = true;
    };
    if (direction === "forward") {
      for (let i = units.length - 2; i >= 0; i--) if (selected.has(units[i]) && !selected.has(units[i + 1])) swap(i, i + 1);
    } else {
      for (let i = 1; i < units.length; i++) if (selected.has(units[i]) && !selected.has(units[i - 1])) swap(i, i - 1);
    }
    return units.flatMap((id) => [...(rank.has(id) ? [id] : []), ...flatten(id)]);
  };
  const sequence = flatten(null);
  const changes = new Map<NodeId, number>();
  if (!moved) return changes;
  const zOf = new Map(leaves.map((n) => [n.id, n.z] as const));
  // The places keep the `z` they had, so a swap trades two values; places that shared one are pulled apart, or moving past a tie would show nothing.
  let previous = -Infinity;
  sequence.forEach((id, i) => {
    const z = zs[i] > previous ? zs[i] : previous + 1;
    previous = z;
    if (z !== zOf.get(id)) changes.set(id, z);
  });
  return changes;
}

/**
 * Bring forward and send backward: the units named (`args.ids`, else the selection) that are not effectively locked
 * move one place in their stack (see `restack`), a group with all its members.
 */
function stackCommand(id: string, name: string, icon: string, direction: "forward" | "backward"): Command<NodesArgs> {
  return {
    id,
    name,
    icon,
    group: "arrange",
    menu: ["item"],
    params: NODES_PARAMS,
    applies: (ctx) => ctx.selection.length > 0,
    run(ctx, args) {
      const doc = ctx.store.doc;
      const { pages, nodes } = doc;
      const selected = new Set(targetIds(ctx, id, args).filter((n) => !isLocked(doc, n)));
      const container = (n: NodeId) => isGroup(doc, n, ctx.registries);
      const changes = new Map<NodeId, number>();
      for (const page of pages) {
        for (const [nodeId, z] of restack(nodes.filter((n) => n.page === page.id), selected, direction, container)) changes.set(nodeId, z);
      }
      if (changes.size === 0) return;
      ctx.store.commit(id, (draft) => {
        for (const node of draft.nodes) {
          const z = changes.get(node.id);
          if (z !== undefined) node.z = z;
        }
      });
    },
  };
}

/** The units of the nodes named (`args.ids`, else the selection), as the arrange commands take them; ids of no node are left out. */
function lockUnits(ctx: CommandContext, command: string, args: NodesArgs | undefined): NodeId[] {
  const doc = ctx.store.doc;
  const present = new Set(doc.nodes.map((n) => n.id));
  const ids = targetIds(ctx, command, args).filter((id) => present.has(id));
  return unitsOf(doc, ids, commonParent(doc, ids));
}

/**
 * The units Lock (`lock` true) or Unlock acts on: for Lock those that are not effectively locked (a member of a locked
 * group is locked by its group already), for Unlock those locked by their own flag (unlocking a member of a locked group
 * would not free it).
 */
function lockTargets(doc: Document, units: readonly NodeId[], lock: boolean): NodeId[] {
  return units.filter((id) => (lock ? !isLocked(doc, id) : doc.nodes.find((n) => n.id === id)?.locked === true));
}

/**
 * Lock and Unlock: each sets `locked` on the units named (`args.ids`, else the selection) through `node.update`, one
 * call per unit, whose commits make one undo step. A locked group locks everything in it. Lock applies while a unit is
 * unlocked, Unlock while one is locked; with a mixed selection both do.
 */
function lockCommand(id: string, name: string, icon: string, lock: boolean): Command<NodesArgs> {
  return {
    id,
    name,
    icon,
    group: "edit",
    menu: ["item"],
    params: NODES_PARAMS,
    applies: (ctx) => {
      const doc = ctx.store.doc;
      const present = new Set(doc.nodes.map((n) => n.id));
      const ids = ctx.selection.filter((n) => present.has(n));
      return lockTargets(doc, unitsOf(doc, ids, commonParent(doc, ids)), lock).length > 0;
    },
    run(ctx, args) {
      const targets = lockTargets(ctx.store.doc, lockUnits(ctx, id, args), lock);
      const update = ctx.registries.commands.get("node.update");
      if (!update) throw new CommandError(`${id} needs the node.update command`);
      for (const target of targets) update.run(ctx, { id: target, patch: { locked: lock } });
      return { ids: targets };
    },
  };
}

/**
 * A page like `current` (its preset, or its size when that is not a preset), to go after it; `existingIds` are the
 * document's page ids. A width or height over `limitMm` is cut down to it, which makes the page custom; `clamped` says
 * whether that happened.
 */
function pageLike(current: Page | undefined, existingIds: string[], limitMm: number): { page: Page; clamped: boolean } {
  const preset = current?.preset === undefined ? undefined : getPreset(current.preset);
  const page = createPage(preset?.id ?? PAGE_PRESETS[0].id, existingIds);
  if (current && !preset) {
    page.width = current.width;
    page.height = current.height;
    if (current.preset === undefined) delete page.preset;
    else page.preset = current.preset;
  }
  const width = clampPageSize(page.width, limitMm);
  const height = clampPageSize(page.height, limitMm);
  const clamped = width.clamped || height.clamped;
  page.width = width.value;
  page.height = height.value;
  // A preset whose size was cut down is no longer that preset.
  if (clamped && page.preset !== undefined) page.preset = CUSTOM_PRESET;
  return { page, clamped };
}

/**
 * Copies the nodes (`args.ids`, else the selection), a group with everything in it, a little down and to the right,
 * above everything on their pages; from the selection, the copies become the selection. A copy's `parent` is the copy of
 * its group when that is copied too, else its own group. A copied connector's end that is attached to a node copied in
 * the same call is attached to that node's copy; one attached to a node that is not copied becomes a free end where it
 * is drawn now, moved by the same offset as the copies.
 */
function duplicate(ctx: CommandContext, args?: NodesArgs): { ids: NodeId[] } {
  const doc = ctx.store.doc;
  const { nodes } = doc;
  // A group is copied with everything in it.
  const selected = new Set(expandUnits(doc, targetIds(ctx, "duplicate", args)));
  // In stacking order, so the copies keep their order among themselves.
  const originals = nodes.filter((n) => selected.has(n.id)).sort((a, b) => a.z - b.z);
  if (originals.length === 0) return { ids: [] };

  const taken = new Set(nodes.map((n) => n.id));
  const tops = new Map<PageId, number>();
  for (const n of nodes) tops.set(n.page, Math.max(tops.get(n.page) ?? -Infinity, n.z));
  const offset = mmToPx(DUPLICATE_OFFSET_MM);

  const copies = originals.map((original): Node => {
    const id = newId("p", taken);
    taken.add(id);
    const z = (tops.get(original.page) ?? -1) + 1;
    tops.set(original.page, z);
    return { ...structuredClone(original), id, x: roundPx(original.x + offset), y: roundPx(original.y + offset), z };
  });
  const copyOf = new Map(originals.map((original, i) => [original.id, copies[i].id]));
  copies.forEach((copy, i) => {
    const original = originals[i];
    // A copy of a member of a group that is copied too is a member of that group's copy; a member copied alone (in a
    // group that is entered) joins its own group.
    if (original.parent !== undefined) copy.parent = copyOf.get(original.parent) ?? original.parent;
    if (copy.type !== "connector" || original.type !== "connector") return;
    const resolved = resolveConnector(doc, original, ctx.registries, unreadableIn(ctx));
    copy.ends = copy.ends.map((end, which): End => {
      if (end.kind === "free") return { kind: "free", x: roundPx(end.x + offset), y: roundPx(end.y + offset) };
      // A page end stays on its page: a copied card's association ties the copy to the same page.
      if (end.kind === "page") return end;
      const target = copyOf.get(end.node);
      if (target !== undefined) return { ...end, node: target };
      const { pt } = resolved.ends[which];
      return { kind: "free", x: roundPx(pt.x + offset), y: roundPx(pt.y + offset) };
    }) as [End, End];
  });
  // A copy of a node its plugin could not read cannot be read either: it is marked before it is drawn, so the stage
  // shows it as a placeholder and an export skips it. Headless the copy is saved as the original is, and its plugin's
  // hook fails on it too when the figure is next loaded.
  const unreadable = unreadableIn(ctx);
  const unreadableCopies = unreadable ? copies.filter((_, i) => unreadable.has(originals[i].id)).map((c) => c.id) : [];
  if (unreadableCopies.length > 0) markUnreadableIn(ctx, unreadableCopies);
  ctx.store.commit("duplicate", (draft) => {
    draft.nodes.push(...copies);
  });
  const ids = copies.map((c) => c.id);
  const view = ctx.view;
  // The copies are selected as the units they make: a group's copy, not its members' copies besides.
  const copied = new Set(ids);
  const units = copies.filter((c) => c.parent === undefined || !copied.has(c.parent)).map((c) => c.id);
  if (view && args?.ids === undefined) whenCommitted(ctx, () => view.setSelection(units));
  return { ids };
}

/**
 * Removes the nodes (`args.ids`, else the selection) that are not effectively locked, a group with everything in it (a
 * locked member too); an effectively locked node stays, as with the Delete key.
 */
function deleteNodes(ctx: CommandContext, args?: NodesArgs): { ids: NodeId[] } {
  const doc = ctx.store.doc;
  const ids = expandUnits(doc, targetIds(ctx, "delete", args).filter((id) => !isLocked(doc, id)));
  if (ids.length === 0) return { ids };
  const gone = new Set(ids);
  // The node host lets go of the removed nodes' links.
  ctx.store.commit("delete", (draft) => {
    draft.nodes = draft.nodes.filter((node) => !gone.has(node.id));
  });
  return { ids };
}

/**
 * Adds a page after `args.page` (else the focus page; headless with no page named, after the last page): of the page
 * preset `args.preset` when it is given (an id that is no preset is refused), else like that page. A size over the
 * Maximum page size setting is cut down to it, and in a view the view says so.
 */
function addPage(ctx: CommandContext, args?: { page?: unknown; preset?: unknown }): { id: PageId } {
  const command = "add-page";
  const { pages } = ctx.store.doc;
  const preset = args?.preset;
  if (preset !== undefined && (typeof preset !== "string" || !getPreset(preset))) throw new CommandError(`${command}: there is no page preset "${String(preset)}"`);
  const after = targetPage(ctx, command, args) ?? pages[pages.length - 1];
  const limit = pageLimitMm(ctx);
  const ids = pages.map((p) => p.id);
  const { page, clamped } = pageLike(preset === undefined ? after : createPage(preset, ids), ids, limit);
  const at = pages.findIndex((p) => p.id === after?.id);
  ctx.store.commit("add-page", (draft) => {
    draft.pages.splice(at === -1 ? draft.pages.length : at + 1, 0, page);
  });
  if (clamped && ctx.view) whenCommitted(ctx, () => editor(ctx).notePageLimit(limit));
  return { id: page.id };
}

/**
 * Removes a page (`args.page`, else the focus page) and everything on it, and every node tied to it from another page (an
 * association, `NodeType.tiedPages`); never the last page. Headless the page must be named. An item kept off the paper
 * (`NodeType.offPaper`: a card) placed against the page is not on it, so it stays: it goes to the remaining page whose
 * paper is nearest it, keeping its place on the canvas (the store then pushes it off any paper), and a node drawn only
 * from such items, all going to one page (its associations to other pages, a connector between two cards), goes with
 * them. All in one undo step.
 */
function deletePage(ctx: CommandContext, args?: { page?: unknown }): void {
  const page = targetPage(ctx, "delete-page", args);
  if (!page && !ctx.view) throw new CommandError(`delete-page needs "page" when the figure is not open`);
  const id = page?.id;
  const doc = ctx.store.doc;
  if (id === undefined || doc.pages.length < 2) return;
  const unreadable = unreadableIn(ctx);
  const typeOf = (n: Node) => nodeTypeFor(ctx.registries, n, unreadable);
  // The nodes tied to the page (associations, see `NodeType.tiedPages`) go with it.
  const tied = new Set(doc.nodes.filter((n) => typeOf(n)?.tiedPages?.(n).includes(id) === true).map((n) => n.id));
  const rehomed = rehomeOffPage(doc, id, typeOf);
  // A node drawn only from items that stay, all going to one page (a card's association to another page, a connector
  // between two cards), goes with them, moved as its type moves (a connector's free ends) to keep its canvas place.
  const before = pageOriginsPx(doc);
  const after = pageOriginsPx({ ...doc, pages: doc.pages.filter((p) => p.id !== id) });
  const from = before.get(id) ?? { x: 0, y: 0 };
  const followers = new Map<NodeId, { page: PageId; fields: Record<string, unknown> }>();
  for (const n of doc.nodes) {
    if (n.page !== id || tied.has(n.id) || rehomed.has(n.id)) continue;
    const type = typeOf(n);
    const items = type?.dependsOn?.(n) ?? [];
    const pages = new Set(items.map((d) => rehomed.get(d)?.page));
    const [to] = pages;
    if (items.length === 0 || pages.size !== 1 || to === undefined) continue;
    const at = after.get(to) ?? { x: 0, y: 0 };
    const moved = (type?.translate?.(n, from.x - at.x, from.y - at.y) ?? n) as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(moved)) if (moved[key] !== (n as unknown as Record<string, unknown>)[key]) fields[key] = moved[key];
    followers.set(n.id, { page: to, fields });
  }
  // One commit, so one undo brings the page back with everything on it. The node host lets go of the removed nodes' links.
  ctx.store.commit("delete-page", (draft) => {
    draft.pages = draft.pages.filter((p) => p.id !== id);
    draft.nodes = draft.nodes.filter((n) => (n.page !== id || rehomed.has(n.id) || followers.has(n.id)) && !tied.has(n.id));
    for (const n of draft.nodes) {
      const to = rehomed.get(n.id);
      const follower = followers.get(n.id);
      if (to) Object.assign(n, { page: to.page, x: to.x, y: to.y });
      else if (follower) Object.assign(n, follower.fields, { page: follower.page });
    }
  });
}

/**
 * Where each item kept off the paper (`offPaper`) that is placed against page `id` goes once the page is deleted: the
 * remaining page whose paper is nearest its box, at the same place on the canvas as the pages then stand.
 */
function rehomeOffPage(doc: Document, id: PageId, typeOf: (n: Node) => NodeType | undefined): Map<NodeId, { page: PageId; x: number; y: number }> {
  const out = new Map<NodeId, { page: PageId; x: number; y: number }>();
  const before = pageOriginsPx(doc);
  const after = pageOriginsPx({ ...doc, pages: doc.pages.filter((p) => p.id !== id) });
  const from = before.get(id);
  if (!from) return out;
  const papers = doc.pages.filter((p) => p.id !== id).map((p) => ({ page: p.id, rect: { ...(after.get(p.id) ?? { x: 0, y: 0 }), ...pageSizePx(p) } }));
  const gap = (a: Rect, b: Rect): number =>
    Math.hypot(Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)), Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)));
  for (const n of doc.nodes) {
    if (n.page !== id || typeOf(n)?.offPaper !== true) continue;
    const world: Rect = { x: from.x + n.x, y: from.y + n.y, width: n.width, height: n.height };
    const nearest = papers.reduce((best, p) => (gap(world, p.rect) < gap(world, best.rect) ? p : best));
    out.set(n.id, { page: nearest.page, x: roundPx(world.x - nearest.rect.x), y: roundPx(world.y - nearest.rect.y) });
  }
  return out;
}

/** A new text node with its top-left at `at`, above everything on that page, selected and being edited. */
function placeText(ctx: CommandContext, at: PlacePoint): void {
  const view = editor(ctx);
  const { page } = at;
  const { nodes } = ctx.store.doc;
  const node = textNodeDefaults(page, {}, nodes.map((n) => n.id));
  node.x = roundPx(at.x);
  node.y = roundPx(at.y);
  node.z = nodes.reduce((top, n) => (n.page === page.id ? Math.max(top, n.z) : top), -1) + 1;
  // Not "insert": a drop's commit just before must stay an undo step of its own.
  ctx.store.commit("insert-text", (draft) => {
    draft.nodes.push(node);
  });
  view.setSelection([node.id]);
  // The node host drew the label as the commit was made, so it is there to be told; typing replaces "Text".
  view.activateNode(node.id);
}

/**
 * The link of the one item selected, if that is what is selected and it has one: a file panel's, a note card's (any
 * type that keeps a link, see `linkOf`).
 */
function selectedLink(ctx: CommandContext): { file: string; subpath: string } | undefined {
  if (ctx.selection.length !== 1) return undefined;
  const node = ctx.store.doc.nodes.find((n) => n.id === ctx.selection[0]);
  const link = node && linkOf(node);
  return link && link.file !== "" ? link : undefined;
}

/**
 * Whether `node` is a file node of `doc` that shows an image and may be changed (it is not locked, nor in a locked
 * group): the kind of panel whose box can follow its image.
 */
function isUnlockedImage(doc: Document, node: Node | undefined): node is FileNode {
  return node?.type === "file" && node.show === "image" && !isLocked(doc, node.id);
}

/**
 * Gives each selected image panel the height its image has at the panel's width: the image's own aspect ratio, or the
 * crop's when the panel shows a part of it. A panel whose image size is not known (it is missing, or could not be
 * loaded) is left as it is. One commit, so one undo step; none when no height changes.
 */
async function resetAspect(ctx: CommandContext): Promise<void> {
  const view = editor(ctx);
  const selected = new Set(ctx.selection);
  const panels = ctx.store.doc.nodes.filter((n): n is FileNode => selected.has(n.id) && isUnlockedImage(ctx.store.doc, n));
  const sizes = new Map<NodeId, { width: number; height: number }>();
  await Promise.all(
    panels.map(async (panel) => {
      try {
        sizes.set(panel.id, await view.imageSize(panel.id));
      } catch {
        // No image to take the aspect ratio from.
      }
    }),
  );
  if (sizes.size === 0) return;
  // The image can take a while to load, so the panels are looked up again: one may have been deleted, locked or reshaped meanwhile.
  const doc = ctx.store.doc;
  ctx.store.commit("reset-aspect", (draft) => {
    for (const node of draft.nodes) {
      const size = sizes.get(node.id);
      if (!size || !isUnlockedImage(doc, node)) continue;
      const aspect = ((node.crop?.w ?? 1) * size.width) / ((node.crop?.h ?? 1) * size.height);
      // A crop with no area has no aspect ratio.
      if (!Number.isFinite(aspect) || aspect <= 0) continue;
      node.height = Math.max(MIN_NODE_PX, roundPx(node.width / aspect));
    }
  });
}

/**
 * The toolbar toggle for snapping drags to items, the page and its margins (see `model/snap`): a setting of the view's
 * own (`SNAP_OPTION`), on until turned off; its button says which it is, and is shown pressed while on.
 */
export const snapToggle: Command = {
  id: "snap.toggle",
  name: "Snap",
  icon: "magnet",
  group: "view",
  needsView: true,
  applies: (ctx) => !!ctx.view,
  run(ctx) {
    if (!ctx.view) throw new CommandError("snap.toggle needs the figure to be open");
    ctx.view.setViewOption(SNAP_OPTION, !snapOn(ctx.view.viewOption(SNAP_OPTION)));
  },
  state: (ctx) => {
    const on = snapOn(ctx.view?.viewOption(SNAP_OPTION));
    return { name: on ? "Snap: on" : "Snap: off", icon: "magnet", active: on };
  },
};

/**
 * Defined in the order the toolbar shows them within a group (the registry sorts by group, then by this order). Those
 * that act on the selection, the zoom, a tool or a dialog are `needsView`; the rest can run headless through the API.
 */
function builtinCommands(): Command[] {
  // A tool: the toolbar button and the palette entry arm it, and the next press on a page places a label there.
  const text: Command = {
    id: "insert-text",
    name: "Text",
    icon: "type",
    group: "insert",
    menu: ["page"],
    cursor: "text",
    needsView: true,
    applies: (ctx) => !!ctx.page,
    run: (ctx) => editor(ctx).armTool(text),
    place: placeText,
  };
  return [
    { id: "undo", name: "Undo", icon: "undo", group: "edit", applies: (ctx) => ctx.store.canUndo(), run: (ctx) => void ctx.store.undo() },
    { id: "redo", name: "Redo", icon: "redo", group: "edit", applies: (ctx) => ctx.store.canRedo(), run: (ctx) => void ctx.store.redo() },
    {
      id: "delete",
      name: "Delete",
      icon: "trash",
      group: "edit",
      menu: ["item"],
      params: NODES_PARAMS,
      applies: (ctx) => ctx.store.doc.nodes.some((n) => ctx.selection.includes(n.id) && !isLocked(ctx.store.doc, n.id)),
      run: deleteNodes,
    },
    { id: "duplicate", name: "Duplicate", icon: "copy", group: "edit", menu: ["item"], params: NODES_PARAMS, applies: (ctx) => ctx.selection.length > 0, run: duplicate },
    text,
    stackCommand("bring-forward", "Bring forward", "arrow-up", "forward"),
    stackCommand("send-backward", "Send backward", "arrow-down", "backward"),
    {
      id: "reset-aspect",
      name: "Reset aspect ratio",
      icon: "ratio",
      group: "arrange",
      menu: ["item"],
      needsView: true,
      applies: (ctx) => ctx.store.doc.nodes.some((n) => ctx.selection.includes(n.id) && isUnlockedImage(ctx.store.doc, n)),
      run: resetAspect,
    },
    { id: "add-page", name: "Add page", icon: "file-plus", group: "page", menu: ["page", "canvas"], params: ADD_PAGE_PARAMS, applies: () => true, run: addPage },
    {
      id: "delete-page",
      name: "Delete page",
      icon: "file-minus",
      group: "page",
      menu: ["page"],
      params: PAGE_PARAMS,
      applies: (ctx) => ctx.store.doc.pages.length > 1,
      run: deletePage,
    },
    { id: "fit-page", name: "Fit page", icon: "maximize", group: "view", menu: ["page", "canvas"], needsView: true, applies: () => true, run: (ctx) => editor(ctx).fitPage() },
    snapToggle,
    { id: "zoom-100", name: "Zoom to 100%", icon: "search", group: "view", menu: ["canvas"], needsView: true, applies: () => true, run: (ctx) => editor(ctx).zoomTo(1) },
    { id: "export", name: "Export", icon: "download", group: "export", menu: ["page", "canvas"], needsView: true, applies: () => true, run: (ctx) => editor(ctx).requestExport() },
    {
      id: "open-source",
      name: "Open source",
      icon: "link",
      group: "edit",
      menu: ["item"],
      needsView: true,
      applies: (ctx) => selectedLink(ctx) !== undefined,
      run(ctx) {
        const link = selectedLink(ctx);
        if (link) editor(ctx).openLink(joinLinktext(link.file, link.subpath));
      },
    },
    lockCommand("lock", "Lock", "lock", true),
    lockCommand("unlock", "Unlock", "unlock", false),
  ];
}

/**
 * Puts the built-in commands in the registry, which the toolbar is generated from, and in Obsidian's command palette,
 * where each acts on the active figure view. None has a default hotkey: the stage's own key handler owns Cmd+Z,
 * Shift+Cmd+Z and Delete, and the same keys on a palette command would act twice.
 */
export function registerBuiltinCommands(plugin: LinkFiguresPlugin): void {
  for (const command of builtinCommands()) registerPaletteCommand(plugin, command);
}

/** Registers `command` and puts it in the palette as `lf-<id>`, offered while it applies to the active figure view. */
export function registerPaletteCommand(plugin: LinkFiguresPlugin, command: Command): void {
  plugin.registries.commands.register(command);
  plugin.addCommand({
    id: `lf-${command.id}`,
    // Obsidian puts the plugin's name in front of this in the palette ("Link Figures: Fit page"), and its id in front of the id.
    name: command.name,
    checkCallback: (checking) => {
      const view = plugin.activeFigureView();
      if (!view || view.readOnly || !command.applies(view.commandContext())) return false;
      if (!checking) view.runCommand(command);
      return true;
    },
  });
}
