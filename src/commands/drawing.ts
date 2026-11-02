import { attachTarget } from "../model/attach";
import { connectorNodeDefaults, defaultCaps, shapeNodeDefaults } from "../model/defaults";
import { mmToPx, type PlacePoint } from "../model/geometry";
import type { Cap, ConnectorNode, Document, End, Node, NodeId, Page, Paint, ShapeNode, Stroke } from "../model/types";
import { CommandError, type Command, type CommandContext } from "../registry/command";
import { isCap, paramError, type ParamSpec } from "../registry/params";
import { dragRect, roundPx } from "../view/pointer-math";
import { targetIds, targetPage, whenCommitted } from "./builtin";

/**
 * The commands that draw: create shapes and connectors, change any node's attributes, move a connector's end, and run a
 * shape operation. They take JSON arguments and are what the drawing tools, the inspector and scripts all run, so the
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
function creationPage(ctx: CommandContext, command: string, args: { page?: unknown }): Page {
  const page = targetPage(ctx, command, args);
  if (!page) throw new CommandError(`${command} needs "page" when the figure is not open`);
  return page;
}

/** The caller's `id` for a new node, when it gave one; an id the figure already has is an error. */
function newNodeId(ctx: CommandContext, command: string, id: unknown): string | undefined {
  if (id === undefined) return undefined;
  if (id === "" || ctx.store.doc.nodes.some((n) => n.id === id)) throw new CommandError(`${command}: the figure already has a node "${String(id)}"`);
  return id as string;
}

/** The `z` that puts a new node above everything on `page`. */
function topOf(doc: Document, page: Page): number {
  return doc.nodes.reduce((top, n) => (n.page === page.id ? Math.max(top, n.z) : top), -1) + 1;
}

/** Adds `node` in one commit labelled `command`, selects it in the view once that is in, and returns its id. */
function addNode(ctx: CommandContext, command: string, node: Node): { id: NodeId } {
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
  if (end.kind === "free") return;
  const target = ctx.store.doc.nodes.find((n) => n.id === end.node);
  if (!target) throw new CommandError(`${command}: "${name}" is attached to "${end.node}", which is not a node of the figure`);
  if (!attachTarget(ctx.store.doc, ctx.registries, end.node)) throw new CommandError(`${command}: "${name}" cannot attach to "${end.node}" (a ${target.type})`);
  if (target.page !== page) throw new CommandError(`${command}: "${name}" is attached to "${end.node}", which is on another page`);
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
  width: { type: "number" },
  height: { type: "number" },
  z: { type: "number" },
  rotation: { type: "number" },
  opacity: { type: "number" },
  locked: { type: "boolean" },
  name: { type: "string" },
  color: { type: "string" },
};

/**
 * Changes node `id` by `patch`, a part of the node in its JSON form (`{ fill: { color: "#ff0000" } }`), merged into it
 * (see `mergePatch`). Its `id` and `type` cannot change; an empty `name` removes the name. The node's type then adds what
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
  const before = node as unknown as Record<string, unknown>;
  let after: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) after[key] = mergePatch(before[key], value);
  const type = ctx.registries.nodeTypes.get(node.type);
  const updateCtx = { registries: ctx.registries };
  if (type?.completeUpdate) after = type.completeUpdate(node, after as unknown as Node, patch, updateCtx) as unknown as Record<string, unknown>;
  // A value the patch gives again as it is, is no change: the commit stays as small as what actually changes.
  const changed = Object.keys(after).filter((key) => !sameValue(after[key], before[key]));
  for (const key of changed) {
    const value = after[key];
    const error = Object.hasOwn(BASE_FIELDS, key) ? paramError(key, BASE_FIELDS[key], value) : (type?.checkField?.(key, value, updateCtx) ?? null);
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

/** The drawing commands, for the command registry (see the top of this file). */
export function drawingCommands(): Command[] {
  const always = () => true;
  return [
    shapeTool("tool.rect", "Rectangle", "square", "rect"),
    shapeTool("tool.ellipse", "Ellipse", "circle", "ellipse"),
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
