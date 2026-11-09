import { newId, groupNodeDefaults } from "../model/defaults";
import { childrenOf, commonParent, expandUnits, isGroup, isLocked, parentOf, unitsOf } from "../model/groups";
import type { Document, Node, NodeId } from "../model/types";
import { CommandError, type Command, type CommandContext } from "../registry/command";
import type { ParamSpec } from "../registry/params";
import { targetIds, whenCommitted } from "./builtin";

/** The units that `group.create` would join: each of `ids` taken to its outermost unit within their common parent. */
function createUnits(doc: Document, ids: readonly NodeId[]): { within: NodeId | null; units: NodeId[] } {
  const within = commonParent(doc, ids);
  return { within, units: unitsOf(doc, ids, within) };
}

/** Whether `units` are all the members of `within`: grouping them would only dissolve that group again. */
function isWholeGroup(doc: Document, within: NodeId | null, units: readonly NodeId[]): boolean {
  if (within === null) return false;
  const members = childrenOf(doc, within);
  return members.length === units.length && members.every((m) => units.includes(m));
}

const node = (doc: Document, id: NodeId): Node => doc.nodes.find((n) => n.id === id) as Node;

/**
 * The new `z` of the nodes of a page after the `moving` ones are made a contiguous block ending where the topmost of
 * them was, keeping their relative order. Groups are left out: their `z` is derived from their members. The places keep
 * the `z` values they had, pulled apart where they tied, so the order stays strict. Only changed values are returned.
 */
function gatherBelowTop(nodes: readonly Node[], moving: ReadonlySet<NodeId>): Map<NodeId, number> {
  const order = nodes.map((n, index) => ({ n, index })).sort((a, b) => a.n.z - b.n.z || a.index - b.index).map((e) => e.n);
  const zs = order.map((n) => n.z);
  let top = -1;
  order.forEach((n, i) => {
    if (moving.has(n.id)) top = i;
  });
  const block = order.filter((n) => moving.has(n.id));
  const others = order.filter((n) => !moving.has(n.id));
  const before = order.slice(0, top).filter((n) => !moving.has(n.id));
  const after = others.slice(before.length);
  const sequence = [...before, ...block, ...after];
  const changes = new Map<NodeId, number>();
  let previous = -Infinity;
  sequence.forEach((n, i) => {
    const z = zs[i] > previous ? zs[i] : previous + 1;
    previous = z;
    if (z !== n.z) changes.set(n.id, z);
  });
  return changes;
}

type CreateArgs = { ids?: unknown[]; id?: string };

function create(ctx: CommandContext, args?: CreateArgs): { id: NodeId } {
  const doc = ctx.store.doc;
  const ids = targetIds(ctx, "group.create", args);
  const { within, units } = createUnits(doc, ids);
  if (units.length < 2) throw new CommandError("group.create: it needs two nodes or more (or groups) to group");
  if (isWholeGroup(doc, within, units)) throw new CommandError(`group.create: those nodes are already a group ("${within}")`);
  const first = node(doc, units[0]);
  if (units.some((u) => node(doc, u).page !== first.page)) throw new CommandError("group.create: the nodes are on different pages");
  const locked = units.find((u) => isLocked(doc, u));
  if (locked !== undefined) throw new CommandError(`group.create: "${locked}" is locked`);
  const taken = new Set(doc.nodes.map((n) => n.id));
  if (args?.id !== undefined && taken.has(args.id)) throw new CommandError(`group.create: there is already a node "${args.id}"`);
  const id = args?.id ?? newId("g", taken);

  const members = new Set(expandUnits(doc, units));
  const pageNodes = doc.nodes.filter((n) => n.page === first.page && !isGroup(doc, n.id, ctx.registries));
  const leaves = new Set([...members].filter((m) => pageNodes.some((n) => n.id === m)));
  const zs = gatherBelowTop(pageNodes, leaves);
  const top = Math.max(...[...leaves].map((m) => zs.get(m) ?? node(doc, m).z));
  const page = { id: first.page } as Parameters<typeof groupNodeDefaults>[0];
  const group = groupNodeDefaults(page, { id, z: top, ...(within === null ? {} : { parent: within }) }, taken);

  ctx.store.commit("group.create", (draft) => {
    const unitSet = new Set(units);
    for (const n of draft.nodes) {
      const z = zs.get(n.id);
      if (z !== undefined) n.z = z;
      if (unitSet.has(n.id)) n.parent = id;
    }
    draft.nodes.push(group);
  });
  const view = ctx.view;
  if (view && args?.ids === undefined) whenCommitted(ctx, () => view.setSelection([id]));
  return { id };
}

function ungroup(ctx: CommandContext, args?: { ids?: unknown[] }): { ids: NodeId[] } {
  const doc = ctx.store.doc;
  const named = targetIds(ctx, "group.ungroup", args);
  const groups = named.filter((id) => isGroup(doc, id, ctx.registries));
  if (groups.length === 0) throw new CommandError("group.ungroup: no group among the nodes");
  const locked = groups.find((g) => isLocked(doc, g));
  if (locked !== undefined) throw new CommandError(`group.ungroup: "${locked}" is locked`);
  const gone = new Set(groups);
  // Where a freed member lands: the nearest ancestor of its group that is not itself being dissolved.
  const landing = (group: NodeId): NodeId | undefined => {
    let at = parentOf(doc, group);
    while (at !== null && gone.has(at)) at = parentOf(doc, at);
    return at ?? undefined;
  };
  const freed = doc.nodes.filter((n) => n.parent !== undefined && gone.has(n.parent) && !gone.has(n.id)).map((n) => n.id);
  const place = new Map<NodeId, NodeId | undefined>();
  for (const n of doc.nodes) {
    if (n.parent === undefined || !gone.has(n.parent)) continue;
    place.set(n.id, landing(n.parent));
  }
  ctx.store.commit("group.ungroup", (draft) => {
    for (const n of draft.nodes) {
      if (!place.has(n.id) || gone.has(n.id)) continue;
      const to = place.get(n.id);
      if (to === undefined) delete n.parent;
      else n.parent = to;
    }
    draft.nodes = draft.nodes.filter((n) => !gone.has(n.id));
  });
  const view = ctx.view;
  if (view && args?.ids === undefined) whenCommitted(ctx, () => view.setSelection(freed));
  return { ids: freed };
}

function add(ctx: CommandContext, args?: { group?: string; ids?: unknown[] }): Record<string, never> {
  const doc = ctx.store.doc;
  const groupId = args?.group as string;
  const target = doc.nodes.find((n) => n.id === groupId);
  if (!target || !isGroup(doc, groupId, ctx.registries)) throw new CommandError(`group.add: "${groupId}" is not a group`);
  if (isLocked(doc, groupId)) throw new CommandError(`group.add: "${groupId}" is locked`);
  const ids = targetIds(ctx, "group.add", { ids: args?.ids });
  for (const id of ids) {
    if (isLocked(doc, id)) throw new CommandError(`group.add: "${id}" is locked`);
    if (expandUnits(doc, [id]).includes(groupId)) throw new CommandError(`group.add: "${id}" contains "${groupId}", which would make a cycle`);
    if (node(doc, id).page !== target.page) throw new CommandError(`group.add: "${id}" is on another page than "${groupId}"`);
  }
  ctx.store.commit("group.add", (draft) => {
    const wanted = new Set(ids);
    for (const n of draft.nodes) if (wanted.has(n.id)) n.parent = groupId;
  });
  return {};
}

function remove(ctx: CommandContext, args?: { ids?: unknown[] }): Record<string, never> {
  const doc = ctx.store.doc;
  const ids = targetIds(ctx, "group.remove", args);
  const inGroup = ids.filter((id) => parentOf(doc, id) !== null);
  if (inGroup.length === 0) throw new CommandError("group.remove: none of the nodes is in a group");
  const locked = inGroup.find((id) => isLocked(doc, id));
  if (locked !== undefined) throw new CommandError(`group.remove: "${locked}" is locked`);
  const outer = new Map(inGroup.map((id) => [id, parentOf(doc, parentOf(doc, id) as NodeId)] as const));
  ctx.store.commit("group.remove", (draft) => {
    for (const n of draft.nodes) {
      if (!outer.has(n.id)) continue;
      const to = outer.get(n.id);
      if (to === null || to === undefined) delete n.parent;
      else n.parent = to;
    }
  });
  return {};
}

const IDS: ParamSpec = { ids: { type: "array" } };

/** The commands that make and break groups. `group.add` and `group.remove` are for scripts and the tools: they need arguments. */
export function groupCommands(): Command[] {
  const commands: Command<any>[] = [
    {
      id: "group.create",
      name: "Group",
      icon: "group",
      group: "arrange",
      params: { ids: { type: "array" }, id: { type: "string" } },
      applies: (ctx) => {
        const { within, units } = createUnits(ctx.store.doc, ctx.selection);
        return units.length >= 2 && !isWholeGroup(ctx.store.doc, within, units);
      },
      run: create,
    },
    {
      id: "group.ungroup",
      name: "Ungroup",
      icon: "ungroup",
      group: "arrange",
      params: IDS,
      applies: (ctx) => ctx.selection.some((id) => isGroup(ctx.store.doc, id, ctx.registries)),
      run: ungroup,
    },
    {
      id: "group.add",
      name: "Add to group",
      group: "arrange",
      hidden: true,
      params: { group: { type: "string", required: true }, ids: { type: "array", required: true } },
      applies: () => false,
      run: add,
    },
    {
      id: "group.remove",
      name: "Remove from group",
      group: "arrange",
      hidden: true,
      params: { ids: { type: "array", required: true } },
      applies: () => false,
      run: remove,
    },
  ];
  return commands;
}
