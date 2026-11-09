import { resolveConnector } from "../connectors/geometry";
import { endAt, endError, SNAP_MODE_OPTION, snapMarks, snapModeOf, type SnapMode } from "../model/attach";
import { connectorNodeDefaults, defaultCaps, shapeNodeDefaults } from "../model/defaults";
import { mmToPx, pageOriginsPx, pageSizePx, rectContainsPt, type PlacePoint } from "../model/geometry";
import type { Cap, ConnectorNode, Document, End, Node, NodeId, Page, PageId, Paint, ShapeNode, Stroke } from "../model/types";
import type { Registries } from "../registry";
import { CommandError, type Command, type CommandContext, type DragTargets, type ToolPreview } from "../registry/command";
import { COLOR_PATTERN, isCap, paramError, type ParamSpec } from "../registry/params";
import { dragRect, nodeSizePx, roundPx } from "../view/pointer-math";
import { writePageField } from "../view/page-fields";
import { editor, targetIds, targetPage, whenCommitted } from "./builtin";
import { descendantsOf, expandUnits, isGroup, isLocked, scaleUnits } from "../model/groups";
import { current, isDraft } from "immer";

/**
 * The commands that draw: create shapes and connectors, change any node's or page's attributes, move a connector's end,
 * and run a shape operation. They take JSON arguments and are what the drawing tools, the inspector and scripts all run, so the
 * three make the same documents. None is a toolbar button (`hidden`): each needs arguments to mean anything. The shape
 * tools (Rectangle, Ellipse) are the toolbar's way to them: each runs `shape.create`.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys that would reach an object's prototype instead of one of its own fields. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Throws `CommandError` when `value` (a call's argument, `name`) holds a number that is not finite, or a key that would
 * reach a prototype: JSON cannot carry either, but a script calling the API from JavaScript can.
 */
function checkPlain(command: string, name: string, value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new CommandError(`${command}: "${name}" holds a number that is not finite`);
  if (Array.isArray(value)) value.forEach((v, i) => checkPlain(command, `${name}.${i}`, v));
  else if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new CommandError(`${command}: "${name}" may not have a key "${key}"`);
      checkPlain(command, `${name}.${key}`, v);
    }
  }
}

/** The page a node is created on: the one `args.page` names, else the view's; headless it must be named. */
export function creationPage(ctx: CommandContext, command: string, args: { page?: unknown }): Page {
  const page = targetPage(ctx, command, args);
  if (!page) throw new CommandError(`${command} needs "page" when the figure is not open`);
  return page;
}

/** The caller's `id` for a new node, when it gave one; an id the figure already has is an error. */
export function newNodeId(ctx: CommandContext, command: string, id: unknown): string | undefined {
  if (id === undefined) return undefined;
  if (id === "") throw new CommandError(`${command}: "id" must not be empty`);
  if (ctx.store.doc.nodes.some((n) => n.id === id)) throw new CommandError(`${command}: the figure already has a node "${String(id)}"`);
  return id as string;
}

/** The `z` that puts a new node above everything on `page`. */
export function topOf(doc: Document, page: Page): number {
  return doc.nodes.reduce((top, n) => (n.page === page.id ? Math.max(top, n.z) : top), -1) + 1;
}

/** Adds `node` in one commit labelled `command`, selects it in the view once that is in, and returns its id. */
export function addNode(ctx: CommandContext, command: string, node: Node): { id: NodeId } {
  ctx.store.commit(command, (draft) => {
    draft.nodes.push(node);
  });
  const view = ctx.view;
  if (view) whenCommitted(ctx, () => view.setSelection([node.id]));
  return { id: node.id };
}

type ShapeCreateArgs = {
  id?: string;
  page?: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  params?: Record<string, unknown>;
  fill?: Paint;
  border?: Stroke | null;
};

/**
 * A shape of `kind` (a registered shape kind) with its box, above everything on its page. Its `params` are the kind's
 * defaults with the given ones over them; without `fill` it is white and without `border` it has the default border
 * (null for none).
 */
function createShape(ctx: CommandContext, args: ShapeCreateArgs): { id: NodeId } {
  const command = "shape.create";
  const kind = ctx.registries.shapes.get(args.kind);
  if (!kind) throw new CommandError(`${command}: there is no shape kind "${args.kind}"`);
  if (args.width < 0 || args.height < 0) throw new CommandError(`${command}: "width" and "height" may not be negative`);
  for (const name of ["params", "fill", "border"] as const) checkPlain(command, name, args[name]);
  const id = newNodeId(ctx, command, args.id);
  const page = creationPage(ctx, command, args);
  const doc = ctx.store.doc;
  const partial: Partial<ShapeNode> = {
    kind: kind.id,
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
    z: topOf(doc, page),
    params: { ...kind.defaults(), ...args.params },
    ...(id !== undefined ? { id } : {}),
    ...(args.fill !== undefined ? { fill: args.fill } : {}),
    ...(args.border !== undefined ? { border: args.border } : {}),
  };
  return addNode(ctx, command, structuredClone(shapeNodeDefaults(page, partial, doc.nodes.map((n) => n.id))));
}

/**
 * Throws `CommandError` unless `end` can be an end of a connector on `page`: a free end, or one attached to a node on
 * that page whose type can be attached to. Which anchor it names is the connector normaliser's to settle.
 */
function checkEnd(ctx: CommandContext, command: string, name: string, end: End, page: string): void {
  const error = endError(ctx.store.doc, ctx.registries, end, page);
  if (error !== null) throw new CommandError(`${command}: "${name}" ${error}`);
}

type ConnectorCreateArgs = {
  id?: string;
  page?: string;
  from: End;
  to: End;
  route: string;
  routeParams?: Record<string, unknown>;
  stroke?: Stroke;
  caps?: unknown[];
};

/**
 * A connector from `from` to `to` drawn by `route` (a registered route), above everything on its page. Its
 * `routeParams` are the route's defaults with the given ones over them; without `stroke` it is a 1 pt solid black line,
 * and without `caps` it has none at the start and an arrowhead at the end. Its box is the normaliser's to set.
 */
function createConnector(ctx: CommandContext, args: ConnectorCreateArgs): { id: NodeId } {
  const command = "connector.create";
  const route = ctx.registries.routes.get(args.route);
  if (!route) throw new CommandError(`${command}: there is no route "${args.route}"`);
  if (args.caps !== undefined && !(args.caps.length === 2 && args.caps.every(isCap))) {
    throw new CommandError(`${command}: "caps" must be two caps ({kind, size}), for the start and the end`);
  }
  const caps = args.caps as [Cap, Cap] | undefined;
  for (const cap of caps ?? []) if (!ctx.registries.caps.get(cap.kind)) throw new CommandError(`${command}: there is no cap kind "${cap.kind}"`);
  for (const name of ["routeParams", "stroke"] as const) checkPlain(command, name, args[name]);
  const id = newNodeId(ctx, command, args.id);
  const page = creationPage(ctx, command, args);
  checkEnd(ctx, command, "from", args.from, page.id);
  checkEnd(ctx, command, "to", args.to, page.id);
  const doc = ctx.store.doc;
  const partial: Partial<ConnectorNode> = {
    ends: [args.from, args.to],
    route: route.id,
    routeParams: { ...route.defaults(), ...args.routeParams },
    caps: caps ?? defaultCaps(),
    z: topOf(doc, page),
    ...(id !== undefined ? { id } : {}),
    ...(args.stroke !== undefined ? { stroke: args.stroke } : {}),
  };
  return addNode(ctx, command, structuredClone(connectorNodeDefaults(page, partial, doc.nodes.map((n) => n.id))));
}

/**
 * `patch` merged into `value`: objects key by key, all the way down; anything else (a number, a string, null, an array)
 * is replaced by the patch's. An object whose `type` differs from the one it lands on (a paint of another type) replaces
 * it whole, so nothing of the old one is left behind. The result shares nothing with `patch`.
 */
function mergePatch(value: unknown, patch: unknown): unknown {
  if (!isRecord(patch) || !isRecord(value) || ("type" in patch && patch.type !== value.type)) return structuredClone(patch);
  const out: Record<string, unknown> = { ...value };
  for (const [key, v] of Object.entries(patch)) out[key] = mergePatch(value[key], v);
  return out;
}

/** Whether two JSON values are the same, all the way down. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** What `node.update` checks of the fields every node has; `page` must also be a page of the figure. */
const BASE_FIELDS: ParamSpec = {
  page: { type: "string" },
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number", minimum: 0 },
  height: { type: "number", minimum: 0 },
  z: { type: "number" },
  rotation: { type: "number" },
  opacity: { type: "number", minimum: 0, maximum: 1 },
  locked: { type: "boolean" },
  name: { type: "string" },
  color: { type: "string" },
};

/**
 * Changes node `id` by `patch`, a part of the node in its JSON form (`{ fill: { color: "#ff0000" } }`), merged into it
 * (see `mergePatch`). Its `id` and `type` cannot change, nor its `parent` (that is `group.add` and `group.remove`); an empty `name` removes the name; a width or height under a
 * millimetre is a millimetre (`nodeSizePx`), as a resize by a handle keeps it. The node's type then adds what
 * the change brings with it (`completeUpdate`), and every field that changed is checked (the base fields here, the
 * type's own by `checkField`); keys that neither knows are kept, as the file format keeps them. A locked node is changed
 * too: naming it is explicit.
 */
function updateNode(ctx: CommandContext, args: { id: string; patch: Record<string, unknown> }): { id: NodeId } {
  const command = "node.update";
  const { patch } = args;
  const node = ctx.store.doc.nodes.find((n) => n.id === args.id);
  if (!node) throw new CommandError(`${command}: there is no node "${args.id}"`);
  checkPlain(command, "patch", patch);
  for (const key of ["id", "type"] as const) {
    if (key in patch && patch[key] !== node[key]) throw new CommandError(`${command}: a node's "${key}" cannot change`);
  }
  if ("parent" in patch && patch.parent !== node.parent) {
    throw new CommandError(`${command}: a node's "parent" is changed by group.add and group.remove`);
  }
  if (isGroup(ctx.store.doc, node.id, ctx.registries)) return updateGroup(ctx, node, patch);
  const before = node as unknown as Record<string, unknown>;
  let after: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) after[key] = mergePatch(before[key], value);
  const type = ctx.registries.nodeTypes.get(node.type);
  const updateCtx = { registries: ctx.registries, doc: ctx.store.doc };
  // A size the patch gives is kept to the least a node may have, as a resize by a handle keeps it; one that is not a
  // size at all (negative, not a number) is left for the checks below to refuse. A type's derived size is its own.
  const derived = new Set(type?.derivedFields ?? []);
  for (const key of ["width", "height"]) {
    const value = after[key];
    if (key in patch && !derived.has(key) && typeof value === "number" && value >= 0) after[key] = nodeSizePx(value);
  }
  if (type?.completeUpdate) after = type.completeUpdate(node, after as unknown as Node, patch, updateCtx) as unknown as Record<string, unknown>;
  // A value the patch gives again as it is, is no change: the commit stays as small as what actually changes.
  const changed = Object.keys(after).filter((key) => !sameValue(after[key], before[key]));
  for (const key of changed) {
    const value = after[key];
    const error = Object.hasOwn(BASE_FIELDS, key) ? paramError(key, BASE_FIELDS[key], value) : (type?.checkField?.(key, value, updateCtx, after as unknown as Node) ?? null);
    if (error !== null) throw new CommandError(`${command}: ${error}`);
    if (key === "page" && !ctx.store.doc.pages.some((p) => p.id === value)) throw new CommandError(`${command}: there is no page "${String(value)}"`);
  }
  ctx.store.commit(command, (draft) => {
    const target = draft.nodes.find((n) => n.id === node.id) as unknown as Record<string, unknown> | undefined;
    if (!target) return;
    for (const key of changed) {
      if (key === "name" && after[key] === "") delete target.name;
      else target[key] = after[key];
    }
  });
  return { id: node.id };
}

/** What `node.update` may write on a group; everything else about a group is worked out from its members. */
const GROUP_FIELDS = new Set(["id", "type", "parent", "x", "y", "width", "height", "name", "locked"]);

/**
 * `node.update` on a group (a node whose type has `members`): its `name` and `locked` are written; `x` and `y` move its
 * members and `width` and `height` scale them about the group's top-left (`scaleUnits`), so its box lands where the
 * patch says. Its other fields (rotation, opacity, z, page…) are worked out from its members, so a patch that changes
 * one is refused. One commit, as for any node.
 */
function updateGroup(ctx: CommandContext, node: Node, patch: Record<string, unknown>): { id: NodeId } {
  const command = "node.update";
  const before = node as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!GROUP_FIELDS.has(key) && !sameValue(mergePatch(before[key], value), before[key])) {
      throw new CommandError(`${command}: a group's "${key}" cannot be set; it is worked out from its members (only x, y, width, height, name and locked can)`);
    }
  }
  for (const key of ["x", "y", "width", "height", "name", "locked"]) {
    if (!(key in patch)) continue;
    const error = paramError(key, BASE_FIELDS[key], patch[key]);
    if (error !== null) throw new CommandError(`${command}: ${error}`);
  }
  const num = (key: "x" | "y" | "width" | "height"): number => (key in patch ? (patch[key] as number) : node[key]);
  const width = "width" in patch ? nodeSizePx(num("width")) : node.width;
  const height = "height" in patch ? nodeSizePx(num("height")) : node.height;
  const sx = node.width > 0 ? width / node.width : 1;
  const sy = node.height > 0 ? height / node.height : 1;
  const dx = roundPx(num("x") - node.x);
  const dy = roundPx(num("y") - node.y);
  const name = "name" in patch && patch.name !== (node.name ?? "") ? (patch.name as string) : undefined;
  const locked = "locked" in patch && patch.locked !== node.locked ? (patch.locked as boolean) : undefined;
  if (sx === 1 && sy === 1 && dx === 0 && dy === 0 && name === undefined && locked === undefined) return { id: node.id };
  const members = descendantsOf(ctx.store.doc, node.id);
  ctx.store.commit(command, (draft) => {
    if (sx !== 1 || sy !== 1) scaleUnits(draft, members, sx, sy, { x: node.x, y: node.y }, ctx.registries);
    if (dx !== 0 || dy !== 0) {
      const scaled = new Map(current(draft).nodes.map((n) => [n.id, n] as const));
      const moving = new Set(members);
      for (const target of draft.nodes) {
        const origin = scaled.get(target.id);
        if (origin && moving.has(target.id)) translateInto(ctx.registries, target, origin, dx, dy);
      }
    }
    const group = draft.nodes.find((n) => n.id === node.id);
    if (!group) return;
    if (name === "") delete group.name;
    else if (name !== undefined) group.name = name;
    if (locked !== undefined) group.locked = locked;
  });
  return { id: node.id };
}

/** What `page.update` checks of a page's fields. Sizes and margins are millimetres. */
const PAGE_FIELDS: ParamSpec = {
  name: { type: "string" },
  preset: { type: "string" },
  width: { type: "number", exclusiveMinimum: 0 },
  height: { type: "number", exclusiveMinimum: 0 },
  paper: { type: "string", pattern: COLOR_PATTERN },
  margins: {
    type: "object",
    properties: {
      top: { type: "number", minimum: 0 },
      right: { type: "number", minimum: 0 },
      bottom: { type: "number", minimum: 0 },
      left: { type: "number", minimum: 0 },
    },
  },
  grid: { type: "object", properties: { spacing: { type: "number", exclusiveMinimum: 0 }, show: { type: "boolean" } } },
};

/** The fields whose writing `writePageField` settles: a preset sets the size, and a size that is not the preset's makes the page custom. */
const SIZE_KEYS = ["preset", "width", "height"];

/**
 * Changes page `id` by `patch`, merged into it as `node.update` merges (`{ margins: { left: 15 } }`). Its `id` cannot
 * change; keys it does not know are kept, as the file format keeps them. A `preset` sets the size to the preset's (and
 * is applied before a `width` or `height` the same patch gives); a width or height that is then not the preset's makes
 * the page custom. With the figure open, a width or height over the Maximum page size setting is cut down to it and the
 * view says so, as the inspector's edits are; headless it is not cut, as `add-page` does not cut.
 */
function updatePage(ctx: CommandContext, args: { id: string; patch: Record<string, unknown> }): { id: PageId } {
  const command = "page.update";
  const { patch } = args;
  const page = ctx.store.doc.pages.find((p) => p.id === args.id);
  if (!page) throw new CommandError(`${command}: there is no page "${args.id}"`);
  checkPlain(command, "patch", patch);
  if ("id" in patch && patch.id !== page.id) throw new CommandError(`${command}: a page's "id" cannot change`);
  const before = page as unknown as Record<string, unknown>;
  const after: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) after[key] = mergePatch(before[key], value);
  const changed = Object.keys(after).filter((key) => !sameValue(after[key], before[key]));
  for (const key of changed) {
    const error = Object.hasOwn(PAGE_FIELDS, key) ? paramError(key, PAGE_FIELDS[key], after[key]) : null;
    if (error !== null) throw new CommandError(`${command}: ${error}`);
  }
  const limit = ctx.view ? editor(ctx).pageLimitMm() : Infinity;
  // The preset first, so a size given with it is the one the page keeps.
  const ordered = [...SIZE_KEYS.filter((key) => changed.includes(key)), ...changed.filter((key) => !SIZE_KEYS.includes(key))];
  let clamped = false;
  ctx.store.commit(command, (draft) => {
    const target = draft.pages.find((p) => p.id === page.id);
    if (!target) return;
    for (const key of ordered) {
      if (SIZE_KEYS.includes(key)) clamped = writePageField(target, key, after[key], limit) || clamped;
      else (target as unknown as Record<string, unknown>)[key] = after[key];
    }
  });
  if (clamped) whenCommitted(ctx, () => editor(ctx).notePageLimit(limit));
  return { id: page.id };
}

/** Sets end `which` (0 the start, 1 the end) of connector `id` to `end`: attaches it, moves it to another item, or frees it. */
function setConnectorEnd(ctx: CommandContext, args: { id: string; which: 0 | 1; end: End }): { id: NodeId } {
  const command = "connector.setEnd";
  const node = ctx.store.doc.nodes.find((n) => n.id === args.id);
  if (!node) throw new CommandError(`${command}: there is no node "${args.id}"`);
  if (node.type !== "connector") throw new CommandError(`${command}: "${args.id}" is not a connector`);
  checkPlain(command, "end", args.end);
  checkEnd(ctx, command, "end", args.end, node.page);
  const end = structuredClone(args.end);
  ctx.store.commit(command, (draft) => {
    const target = draft.nodes.find((n) => n.id === node.id);
    if (target?.type === "connector") target.ends[args.which] = end;
  });
  return { id: node.id };
}

/**
 * Runs the registered shape operation `operation` on the shapes `ids` (in that order) and commits what it returns as
 * one undo step: the nodes it removes go, the nodes it adds join. Its result names both.
 */
function operateOnShapes(ctx: CommandContext, args: { operation: string; ids: unknown[] }): { added: NodeId[]; removed: NodeId[] } {
  const command = "shape.operate";
  const operation = ctx.registries.shapeOperations.get(args.operation);
  if (!operation) throw new CommandError(`${command}: there is no shape operation "${args.operation}"`);
  const ids = targetIds(ctx, command, args);
  const doc = ctx.store.doc;
  const shapes = ids.map((id) => {
    const node = doc.nodes.find((n) => n.id === id);
    if (node?.type !== "shape") throw new CommandError(`${command}: "${id}" is not a shape`);
    return node;
  });
  if (!operation.applies(shapes)) throw new CommandError(`${command}: "${operation.id}" does not apply to these shapes`);
  // The operation is given copies, so one that is not as pure as it should be cannot change the document behind the store's back.
  const { add, remove } = operation.run(structuredClone(shapes));
  const present = new Set(doc.nodes.map((n) => n.id));
  for (const id of remove) if (!present.has(id)) throw new CommandError(`${command}: "${operation.id}" removes "${id}", which is not a node of the figure`);
  const removed = new Set(remove);
  const taken = new Set([...present].filter((id) => !removed.has(id)));
  for (const node of add) {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.type !== "string") throw new CommandError(`${command}: "${operation.id}" adds something that is not a node`);
    if (taken.has(node.id)) throw new CommandError(`${command}: "${operation.id}" adds "${node.id}", an id the figure already has`);
    if (!doc.pages.some((p) => p.id === node.page)) throw new CommandError(`${command}: "${operation.id}" adds "${node.id}" on a page the figure does not have`);
    taken.add(node.id);
  }
  const added = structuredClone(add);
  ctx.store.commit(command, (draft) => {
    draft.nodes = draft.nodes.filter((n) => !removed.has(n.id));
    draft.nodes.push(...added);
  });
  return { added: added.map((n) => n.id), removed: [...removed] };
}

/**
 * Writes into `target` (a draft node) `origin` moved by (`dx`, `dy`) page px: its box, or, for a type with `translate`,
 * the fields that hook changes (a connector's free ends), and only those, so a node that does not move is not written.
 */
export function translateInto(registries: Registries, target: Node, origin: Node, dx: number, dy: number): void {
  const type = registries.nodeTypes.get(origin.type);
  if (!type?.translate) {
    target.x = roundPx(origin.x + dx);
    target.y = roundPx(origin.y + dy);
    return;
  }
  const next = type.translate(origin, dx, dy) as unknown as Record<string, unknown>;
  const before = origin as unknown as Record<string, unknown>;
  const draft = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(next)) if (next[key] !== before[key]) draft[key] = next[key];
}

/**
 * Moves the units `ids` of `draft` (each with everything in it, a locked member too) by (`dx`, `dy`) page px, in place,
 * each node as its type moves (see `translateInto`): the one translate path of `node.move`, `align` and `distribute`.
 * Which units may move (not effectively locked) is the caller's to decide; connectors attached to a moved item follow
 * it through the connector normaliser.
 */
export function translateUnits(draft: Document, ids: readonly NodeId[], dx: number, dy: number, registries: Registries): void {
  if (dx === 0 && dy === 0) return;
  const doc: Document = isDraft(draft) ? current(draft) : structuredClone(draft);
  const moving = new Set(expandUnits(doc, ids));
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  for (const node of draft.nodes) {
    const origin = byId.get(node.id);
    if (origin && moving.has(node.id)) translateInto(registries, node, origin, dx, dy);
  }
}

type MoveArgs = { ids?: unknown[]; dx: number; dy: number; pages: boolean };

/**
 * Moves the nodes `ids` (else the selection) that are not effectively locked, a group with everything in it (a locked
 * member too), by (`dx`, `dy`) page px, each as its type moves (see `translateInto`). With `pages` (the default), each
 * moved unit then goes to the page under the centre of its box, keeping its place on the canvas, unless its type places
 * it otherwise (`NodeType.pageAfterMove`: a connector follows its items); a group takes everything in it along, and a
 * unit whose centre is over no page stays on its own. One undo step; its result names the nodes moved.
 */
function moveNodes(ctx: CommandContext, args: MoveArgs): { ids: NodeId[] } {
  const command = "node.move";
  if (!Number.isFinite(args.dx) || !Number.isFinite(args.dy)) throw new CommandError(`${command}: "dx" and "dy" must be finite numbers`);
  const before = ctx.store.doc;
  const units = targetIds(ctx, command, args).filter((id) => !isLocked(before, id));
  const ids = new Set(expandUnits(before, units));
  if (ids.size === 0) return { ids: [] };
  if (args.dx !== 0 || args.dy !== 0) ctx.store.commit(command, (draft) => translateUnits(draft, units, args.dx, args.dy, ctx.registries));
  // A second commit with the same label, which the store merges into the first: the boxes it reads are the ones the
  // move gave, normalised (a connector's is the area its moved ends draw).
  if (args.pages) placeOnPages(ctx, command, ids);
  return { ids: [...ids] };
}

/**
 * Each of `ids` to the page its move ends on, as `moveNodes` says. The page is decided per outermost unit of the move (a
 * node whose group is not moving with it): the page under the centre of its box, unless its type says otherwise
 * (`NodeType.pageAfterMove`); everything in a unit goes where the unit goes. A unit inside a group that is not moving
 * (a member moved alone) stays on its group's page, at the canvas place it was dropped, so a group never spans pages. Units whose type has no such hook are
 * placed first, so a hook can read where they go (a connector follows its items).
 */
function placeOnPages(ctx: CommandContext, command: string, ids: ReadonlySet<NodeId>): void {
  const doc = ctx.store.doc;
  const origins = pageOriginsPx(doc);
  const centrePage = (node: Node): PageId => {
    const from = origins.get(node.page);
    if (!from) return node.page;
    const centre = { x: from.x + node.x + node.width / 2, y: from.y + node.y + node.height / 2 };
    const under = doc.pages.find((p) => {
      const at = origins.get(p.id);
      return !!at && rectContainsPt({ ...at, ...pageSizePx(p) }, centre);
    });
    return under?.id ?? node.page;
  };
  const moving = doc.nodes.filter((n) => ids.has(n.id));
  const units = moving.filter((n) => n.parent === undefined || !ids.has(n.parent));
  const hookOf = (node: Node) => ctx.registries.nodeTypes.get(node.type)?.pageAfterMove;
  const destination = new Map<NodeId, PageId>();
  const place = (unit: Node, page: PageId): void => {
    destination.set(unit.id, page);
    for (const id of descendantsOf(doc, unit.id)) if (ids.has(id)) destination.set(id, page);
  };
  // A unit whose group is not moving with it (a member moved alone, in an entered group) stays on its group's page, so
  // a group never spans pages: its page-relative position is already where it was dropped on the canvas.
  for (const unit of units) if (unit.parent !== undefined) place(unit, unit.page);
  for (const unit of units) if (unit.parent === undefined && !hookOf(unit)) place(unit, centrePage(unit));
  const pageOf = (id: NodeId): PageId | undefined => destination.get(id) ?? doc.nodes.find((n) => n.id === id)?.page;
  for (const unit of units) {
    const hook = hookOf(unit);
    if (hook && unit.parent === undefined) place(unit, hook(unit, { moving: ids, pageOf, centrePage: centrePage(unit) }));
  }
  const moves = new Map<NodeId, { page: PageId; dx: number; dy: number }>();
  for (const node of moving) {
    const page = destination.get(node.id);
    const from = origins.get(node.page);
    const to = page === undefined ? undefined : origins.get(page);
    if (page === undefined || page === node.page || !from || !to) continue;
    moves.set(node.id, { page, dx: from.x - to.x, dy: from.y - to.y });
  }
  if (moves.size === 0) return;
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  ctx.store.commit(command, (draft) => {
    for (const node of draft.nodes) {
      const to = moves.get(node.id);
      const origin = byId.get(node.id);
      if (!to || !origin) continue;
      node.page = to.page;
      translateInto(ctx.registries, node, origin, to.dx, to.dy);
    }
  });
}

/** The size of the shape a click of a shape tool places, in millimetres. */
const CLICK_SHAPE_MM = { width: 30, height: 20 };

/**
 * The box a shape tool's drag from `from` to `to` gives, on their page: the dragged box (a square with `square`), or for
 * a click, where `to` is `from`, a 30 × 20 mm box centred on the point.
 */
function toolBox(from: PlacePoint, to: PlacePoint, square: boolean): { x: number; y: number; width: number; height: number } {
  const box =
    from.x === to.x && from.y === to.y
      ? { x: from.x - mmToPx(CLICK_SHAPE_MM.width) / 2, y: from.y - mmToPx(CLICK_SHAPE_MM.height) / 2, width: mmToPx(CLICK_SHAPE_MM.width), height: mmToPx(CLICK_SHAPE_MM.height) }
      : dragRect(from, to, square);
  return { x: roundPx(box.x), y: roundPx(box.y), width: roundPx(box.width), height: roundPx(box.height) };
}

/**
 * The toolbar tool that draws a shape of `kind` (a registered shape kind): its button arms it, and a drag on a page then
 * runs `shape.create` with the dragged box, as a script would run it, so the tool and the API make the same shape.
 * `shape.create` selects it. A new kind gets a tool by one more call of this.
 */
export function shapeTool(id: string, name: string, icon: string, kind: string): Command {
  const tool: Command = {
    id,
    name,
    icon,
    group: "insert",
    menu: ["page"],
    needsView: true,
    applies: (ctx) => !!ctx.page,
    run: (ctx) => ctx.view?.armTool(tool),
    placeDrag(ctx, from, to, mods) {
      if (!ctx.view) throw new CommandError(`${id} needs the figure to be open`);
      ctx.view.runCommandById("shape.create", { kind, page: from.page.id, ...toolBox(from, to, mods.shift) });
    },
  };
  return tool;
}

/** The snap mode new connector ends take in the view of `ctx` (the toolbar toggle); "anchor" headless. */
function snapModeIn(ctx: CommandContext): SnapMode {
  return snapModeOf(ctx.view?.viewOption(SNAP_MODE_OPTION));
}

/** The two ends the Connector tool's drag from `from` to `to` gives (see `endAt`), each rounded as a drag's positions are. */
function toolEnds(ctx: CommandContext, from: PlacePoint, to: PlacePoint, targets: DragTargets): [End, End] {
  const mode = snapModeIn(ctx);
  const doc = ctx.store.doc;
  const page = from.page.id;
  const at = (p: PlacePoint) => ({ x: roundPx(p.x), y: roundPx(p.y) });
  return [
    endAt(doc, ctx.registries, page, at(from), targets.from, mode, undefined, targets.reach),
    endAt(doc, ctx.registries, page, at(to), targets.to, mode, undefined, targets.reach),
  ];
}

/**
 * The Connector tool: its button arms it, and a drag on a page then runs `connector.create` from the press to the
 * release, as a script would run it. Each end dropped on an item that can be attached to attaches to it, at its nearest
 * anchor or at its centre by the view's snap mode (`connector.snap-mode`); anywhere else it is free there. A click draws
 * nothing. While it is armed, the item under the pointer shows its anchors (its centre in centre mode), and a drag shows
 * the line it would make.
 */
const connectorTool: Command = {
  id: "tool.connector",
  name: "Connector",
  icon: "spline",
  group: "insert",
  menu: ["page"],
  needsView: true,
  applies: (ctx) => !!ctx.page,
  run: (ctx) => ctx.view?.armTool(connectorTool),
  placeDrag(ctx, from, to, _mods, targets) {
    if (!ctx.view) throw new CommandError("tool.connector needs the figure to be open");
    if (from.x === to.x && from.y === to.y) return;
    const [start, end] = toolEnds(ctx, from, to, targets);
    ctx.view.runCommandById("connector.create", { page: from.page.id, from: start, to: end });
  },
  preview(ctx, from, to, targets): ToolPreview {
    const at = { x: roundPx(to.x), y: roundPx(to.y) };
    const marks = snapMarks(ctx.store.doc, ctx.registries, to.page.id, at, targets.to, snapModeIn(ctx), undefined, targets.reach);
    if (!from) return { marks };
    const doc = ctx.store.doc;
    const line = connectorNodeDefaults(from.page, { ends: toolEnds(ctx, from, to, targets), caps: defaultCaps() }, doc.nodes.map((n) => n.id));
    return { path: resolveConnector(doc, line, ctx.registries).path, marks };
  },
};

/** The toolbar toggle between the two snap modes of new connector ends, anchor and centre; its button names the current one. */
const snapModeToggle: Command = {
  id: "connector.snap-mode",
  name: "Connector snap",
  icon: "anchor",
  group: "insert",
  needsView: true,
  applies: (ctx) => !!ctx.view,
  run(ctx) {
    if (!ctx.view) throw new CommandError("connector.snap-mode needs the figure to be open");
    ctx.view.setViewOption(SNAP_MODE_OPTION, snapModeIn(ctx) === "anchor" ? "center" : "anchor");
  },
  state: (ctx) =>
    snapModeIn(ctx) === "center" ? { name: "Connector snap: centre", icon: "locate-fixed" } : { name: "Connector snap: anchor", icon: "anchor" },
};

/** The drawing commands, for the command registry (see the top of this file). */
export function drawingCommands(): Command[] {
  const always = () => true;
  return [
    shapeTool("tool.rect", "Rectangle", "square", "rect"),
    shapeTool("tool.ellipse", "Ellipse", "circle", "ellipse"),
    connectorTool,
    snapModeToggle,
    {
      id: "shape.create",
      name: "Create shape",
      icon: "square",
      group: "insert",
      hidden: true,
      params: {
        id: { type: "string" },
        page: { type: "string" },
        kind: { type: "string", default: "rect" },
        x: { type: "number", required: true },
        y: { type: "number", required: true },
        width: { type: "number", required: true },
        height: { type: "number", required: true },
        params: { type: "object" },
        fill: { type: "paint" },
        border: { type: "stroke", nullable: true },
      },
      applies: always,
      run: (ctx, args) => createShape(ctx, args as ShapeCreateArgs),
    },
    {
      id: "connector.create",
      name: "Create connector",
      icon: "move-up-right",
      group: "insert",
      hidden: true,
      params: {
        id: { type: "string" },
        page: { type: "string" },
        from: { type: "end", required: true },
        to: { type: "end", required: true },
        route: { type: "string", default: "straight" },
        routeParams: { type: "object" },
        stroke: { type: "stroke" },
        caps: { type: "array" },
      },
      applies: always,
      run: (ctx, args) => createConnector(ctx, args as ConnectorCreateArgs),
    },
    {
      id: "node.move",
      name: "Move nodes",
      icon: "move",
      group: "edit",
      hidden: true,
      params: {
        ids: { type: "array" },
        dx: { type: "number", required: true },
        dy: { type: "number", required: true },
        pages: { type: "boolean", default: true },
      },
      applies: always,
      run: (ctx, args) => moveNodes(ctx, args as MoveArgs),
    },
    {
      id: "node.update",
      name: "Update node",
      icon: "pencil",
      group: "edit",
      hidden: true,
      params: { id: { type: "string", required: true }, patch: { type: "object", required: true } },
      applies: always,
      run: (ctx, args) => updateNode(ctx, args as { id: string; patch: Record<string, unknown> }),
    },
    {
      id: "page.update",
      name: "Update page",
      icon: "file-cog",
      group: "page",
      hidden: true,
      params: { id: { type: "string", required: true }, patch: { type: "object", required: true } },
      applies: always,
      run: (ctx, args) => updatePage(ctx, args as { id: string; patch: Record<string, unknown> }),
    },
    {
      id: "connector.setEnd",
      name: "Set connector end",
      icon: "move-up-right",
      group: "edit",
      hidden: true,
      params: { id: { type: "string", required: true }, which: { type: "number", required: true, enum: [0, 1] }, end: { type: "end", required: true } },
      applies: always,
      run: (ctx, args) => setConnectorEnd(ctx, args as { id: string; which: 0 | 1; end: End }),
    },
    {
      id: "shape.operate",
      name: "Shape operation",
      icon: "combine",
      group: "edit",
      hidden: true,
      params: { operation: { type: "string", required: true }, ids: { type: "array", required: true } },
      applies: always,
      run: (ctx, args) => operateOnShapes(ctx, args as { operation: string; ids: unknown[] }),
    },
  ];
}
