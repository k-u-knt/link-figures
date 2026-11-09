import { DEFAULT_FONT, FORMAT_VERSION } from "../constants";
import { defaultBorder, defaultCaps } from "../model/defaults";
import { isEnd } from "../registry/params";
import type { Document, Node } from "../model/types";
import { FormatError } from "./errors";

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Same values as `fileNodeDefaults` / `textNodeDefaults` / `shapeNodeDefaults` / `connectorNodeDefaults` / `groupNodeDefaults` in
 * model/defaults.ts (tests keep them in step), except that a shape with no `params` gets none (they belong to its kind,
 * which may not be the default one), nor does a connector with no `routeParams`, and a connector's `ends` have no
 * default: a connector without them is malformed.
 */
const COMMON_DEFAULTS = (): Json => ({ z: 0, rotation: 0, opacity: 1, locked: false });
const NODE_DEFAULTS: Record<string, () => Json> = {
  file: () => ({
    ...COMMON_DEFAULTS(),
    file: "",
    subpath: "",
    show: "image",
    imageIndex: 0,
    crop: null,
    fit: "cover",
    pageIndex: 0,
    range: "auto",
    scale: 1,
    frame: null,
    adjustments: [],
  }),
  text: () => ({ ...COMMON_DEFAULTS(), text: "", font: { ...DEFAULT_FONT } }),
  shape: () => ({ ...COMMON_DEFAULTS(), kind: "rect", params: {}, fill: { type: "solid", color: "#ffffff" }, border: defaultBorder() }),
  connector: () => ({ ...COMMON_DEFAULTS(), route: "straight", routeParams: {}, stroke: defaultBorder(), caps: defaultCaps() }),
  group: () => COMMON_DEFAULTS(),
};

/** Keeps every key already in `source` (so unknown keys survive) and adds the missing ones from `defaults`. */
function fill(source: Json, defaults: Json): Json {
  const out: Json = { ...source };
  for (const key of Object.keys(defaults)) if (out[key] === undefined) out[key] = defaults[key];
  return out;
}

function migratePage(raw: unknown, index: number): Json {
  if (!isRecord(raw)) throw new FormatError(`Page ${index + 1} is not an object`);
  if (typeof raw.id !== "string" || raw.id === "") throw new FormatError(`Page ${index + 1} has no id`);
  if (!isNumber(raw.width) || !isNumber(raw.height)) throw new FormatError(`Page ${raw.id} needs a numeric width and height`);
  const page = fill(raw, {
    name: `Page ${index + 1}`,
    paper: "#ffffff",
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    grid: { spacing: 5, show: false },
  });
  if (!isRecord(page.margins) || !isRecord(page.grid)) throw new FormatError(`Page ${raw.id} has malformed margins or grid`);
  page.margins = { top: 0, right: 0, bottom: 0, left: 0, ...page.margins };
  page.grid = { spacing: 5, show: false, ...page.grid };
  return page;
}

/** Each entry needs a string `type`; a missing `enabled` reads as true and a missing `params` as `{}`. Unknown types and extra keys are kept. */
function migrateAdjustments(nodeId: string, raw: unknown): Json[] {
  const bad = () => new FormatError(`Node ${nodeId}: "adjustments" must be a list of { type, enabled, params }`);
  if (!Array.isArray(raw)) throw bad();
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.type !== "string") throw bad();
    const out = fill(entry, { enabled: true, params: {} });
    if (typeof out.enabled !== "boolean" || !isRecord(out.params)) throw bad();
    return out;
  });
}

/**
 * A stroke in the current form: an old `{ color, opacity?, … }` becomes `{ paint: { type: "solid", color, opacity? }, … }`
 * (its other keys, cap and join among them, kept), one with neither a paint nor a colour is solid black, and a missing
 * width or dash reads as 1 pt solid. The paint needs a string `type`; one this plugin does not know is kept as it is.
 */
export function migrateStroke(nodeId: string, key: string, raw: unknown): Json {
  const bad = () => new FormatError(`Node ${nodeId}: "${key}" must be null or a stroke { paint: { type, … }, width, dash }`);
  if (!isRecord(raw)) throw bad();
  let stroke: Json = raw;
  if (stroke.paint === undefined && typeof stroke.color === "string") {
    const { color, opacity, ...rest } = stroke;
    stroke = { paint: { type: "solid", color, ...(opacity !== undefined ? { opacity } : {}) }, ...rest };
  } else if (stroke.paint === undefined && stroke.color === undefined) {
    stroke = { paint: { type: "solid", color: "#000000" }, ...stroke };
  }
  if (!isRecord(stroke.paint) || typeof stroke.paint.type !== "string") throw bad();
  return fill(stroke, { width: 1, dash: "solid" });
}

/** Checks a connector's own fields in place: two ends, a route and its params, a stroke (migrated like any) and two caps. */
function migrateConnector(id: string, node: Json): void {
  const { ends, caps } = node;
  if (!Array.isArray(ends) || ends.length !== 2 || !ends.every(isEnd)) throw new FormatError(`Node ${id}: "ends" must be two ends`);
  if (typeof node.route !== "string") throw new FormatError(`Node ${id}: "route" must be a string`);
  if (!isRecord(node.routeParams)) throw new FormatError(`Node ${id}: "routeParams" must be an object`);
  node.stroke = migrateStroke(id, "stroke", node.stroke);
  const isCap = (cap: unknown) => isRecord(cap) && typeof cap.kind === "string" && isNumber(cap.size);
  if (!Array.isArray(caps) || caps.length !== 2 || !caps.every(isCap)) throw new FormatError(`Node ${id}: "caps" must be two caps { kind, size }`);
}

/**
 * How `migrate` finds the NodeType a plugin registered for a type this plugin does not build in: its `migrate` hook, when
 * it has one, validates and completes the type's nodes. Undefined for a type no plugin registers.
 */
export type NodeMigrations = (type: string) => { migrate?(raw: Record<string, unknown>): Node } | undefined;

/**
 * A node of a type this plugin does not build in: with the common defaults filled in, it goes through the `migrate` hook
 * of the NodeType a plugin registered for it, when there is one; otherwise (no plugin registers the type, or its NodeType
 * has no hook, or the hook fails: see `HookFailure`) it is kept as it is, every key of its own included, so saving it
 * loses nothing.
 */
function migrateForeign(id: string, type: string, raw: Json, nodeTypes: NodeMigrations | undefined, failures: HookFailure[] | undefined): Json {
  const node = fill(raw, COMMON_DEFAULTS());
  const hook = nodeTypes?.(type)?.migrate;
  if (!hook) return node;
  let out: unknown;
  try {
    // A copy, so a hook that changes what it is given and then throws leaves the node as the file has it.
    out = hook(structuredClone(node));
  } catch (error) {
    failures?.push({ id, type, message: error instanceof Error ? error.message : String(error) });
    return node;
  }
  const wrong = baseFieldsError(out, id, type);
  if (wrong !== null) {
    failures?.push({ id, type, message: `its migrate hook gave back a node whose ${wrong}` });
    return node;
  }
  return out as Json;
}

/** What is wrong with the base fields of `out`, a node a migrate hook gave back for node `id` of `type`; null when nothing. */
function baseFieldsError(out: unknown, id: string, type: string): string | null {
  if (!isRecord(out)) return "is not an object";
  if (out.id !== id) return `"id" is not "${id}"`;
  if (out.type !== type) return `"type" is not "${type}"`;
  if (typeof out.page !== "string") return `"page" is not a string`;
  for (const key of ["x", "y", "width", "height"]) if (!isNumber(out[key])) return `"${key}" is not a finite number`;
  return null;
}

/**
 * A node a plugin's `migrate` hook could not read (it threw, or gave back a node whose base fields are not right): the
 * node is kept as the file has it, drawn as a placeholder, and the view reports the failure once per type.
 */
export interface HookFailure {
  id: string;
  type: string;
  message: string;
}

function migrateNode(raw: unknown, index: number, nodeTypes?: NodeMigrations, failures?: HookFailure[]): Json {
  if (!isRecord(raw)) throw new FormatError(`Node ${index + 1} is not an object`);
  const { id, type, page } = raw;
  if (typeof id !== "string" || id === "") throw new FormatError(`Node ${index + 1} has no id`);
  if (typeof type !== "string") throw new FormatError(`Node ${id} has no type`);
  if (typeof page !== "string") throw new FormatError(`Node ${id} has no page`);
  for (const key of ["x", "y", "width", "height"]) {
    if (!isNumber(raw[key])) throw new FormatError(`Node ${id}: "${key}" must be a number`);
  }
  // Whether the group it names exists is the store's group normaliser's to check, as the document is loaded.
  if (raw.parent !== undefined && typeof raw.parent !== "string") throw new FormatError(`Node ${id}: "parent" must be a string`);
  if (!Object.hasOwn(NODE_DEFAULTS, type)) return migrateForeign(id, type, raw, nodeTypes, failures);
  const node = fill(raw, NODE_DEFAULTS[type]());
  if (type === "file") {
    node.adjustments = migrateAdjustments(id, node.adjustments);
    if (node.frame !== null) node.frame = migrateStroke(id, "frame", node.frame);
  }
  if (type === "text") {
    if (!isRecord(node.font)) throw new FormatError(`Node ${id}: "font" must be an object`);
    node.font = { ...DEFAULT_FONT, ...node.font };
  }
  if (type === "shape") {
    if (typeof node.kind !== "string") throw new FormatError(`Node ${id}: "kind" must be a string`);
    if (!isRecord(node.params)) throw new FormatError(`Node ${id}: "params" must be an object`);
    if (!isRecord(node.fill) || typeof node.fill.type !== "string") throw new FormatError(`Node ${id}: "fill" must be a paint { type, … }`);
    if (node.border !== null) node.border = migrateStroke(id, "border", node.border);
  }
  if (type === "connector") migrateConnector(id, node);
  return node;
}

/**
 * Validates the parsed JSON body and fills missing optional fields with the model's defaults, by node type.
 * Unknown extra keys on the document, pages and nodes are kept. File nodes get empty `file`/`subpath`;
 * the loader fills those from the Links section. A node of a type that is not built in is kept (see `migrateForeign`);
 * `nodeTypes` finds the hooks of the types plugins register; a hook that fails does not refuse the file but is added to
 * `failures` (see `HookFailure`).
 */
export function migrate(json: unknown, nodeTypes?: NodeMigrations, failures?: HookFailure[]): Document {
  if (!isRecord(json)) throw new FormatError("Figure JSON must be an object");
  if (json.version !== FORMAT_VERSION) throw new FormatError(`Unsupported figure format version: ${String(json.version)}`);
  if (!Array.isArray(json.pages)) throw new FormatError('Figure JSON has no "pages" array');
  if (!Array.isArray(json.nodes)) throw new FormatError('Figure JSON has no "nodes" array');
  const doc = { ...json, version: FORMAT_VERSION, pages: json.pages.map(migratePage), nodes: json.nodes.map((n, i) => migrateNode(n, i, nodeTypes, failures)), edges: [] };
  return doc as unknown as Document;
}
