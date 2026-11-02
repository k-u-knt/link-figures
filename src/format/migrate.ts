import { DEFAULT_FONT, FORMAT_VERSION } from "../constants";
import type { Document } from "../model/types";
import { FormatError } from "./errors";

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Same values as `fileNodeDefaults` / `textNodeDefaults` in model/defaults.ts (a test keeps them in step). */
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
 * (its other keys, cap and join among them, kept), a missing width or dash reads as 1 pt solid. The paint needs a
 * string `type`; one this plugin does not know is kept as it is.
 */
export function migrateStroke(nodeId: string, key: string, raw: unknown): Json {
  const bad = () => new FormatError(`Node ${nodeId}: "${key}" must be null or a stroke { paint: { type, … }, width, dash }`);
  if (!isRecord(raw)) throw bad();
  let stroke: Json = raw;
  if (stroke.paint === undefined && typeof stroke.color === "string") {
    const { color, opacity, ...rest } = stroke;
    stroke = { paint: { type: "solid", color, ...(opacity !== undefined ? { opacity } : {}) }, ...rest };
  }
  if (!isRecord(stroke.paint) || typeof stroke.paint.type !== "string") throw bad();
  return fill(stroke, { width: 1, dash: "solid" });
}

function migrateNode(raw: unknown, index: number): Json {
  if (!isRecord(raw)) throw new FormatError(`Node ${index + 1} is not an object`);
  const { id, type, page } = raw;
  if (typeof id !== "string" || id === "") throw new FormatError(`Node ${index + 1} has no id`);
  if (typeof type !== "string") throw new FormatError(`Node ${id} has no type`);
  if (typeof page !== "string") throw new FormatError(`Node ${id} has no page`);
  for (const key of ["x", "y", "width", "height"]) {
    if (!isNumber(raw[key])) throw new FormatError(`Node ${id}: "${key}" must be a number`);
  }
  if (!Object.hasOwn(NODE_DEFAULTS, type)) throw new FormatError(`Node ${id} has unsupported type "${type}"`);
  const node = fill(raw, NODE_DEFAULTS[type]());
  if (type === "file") {
    node.adjustments = migrateAdjustments(id, node.adjustments);
    if (node.frame !== null) node.frame = migrateStroke(id, "frame", node.frame);
  }
  if (type === "text") {
    if (!isRecord(node.font)) throw new FormatError(`Node ${id}: "font" must be an object`);
    node.font = { ...DEFAULT_FONT, ...node.font };
  }
  return node;
}

/**
 * Validates the parsed JSON body and fills missing optional fields with the model's defaults, by node type.
 * Unknown extra keys on the document, pages and nodes are kept. File nodes get empty `file`/`subpath`;
 * the loader fills those from the Links section.
 */
export function migrate(json: unknown): Document {
  if (!isRecord(json)) throw new FormatError("Figure JSON must be an object");
  if (json.version !== FORMAT_VERSION) throw new FormatError(`Unsupported figure format version: ${String(json.version)}`);
  if (!Array.isArray(json.pages)) throw new FormatError('Figure JSON has no "pages" array');
  if (!Array.isArray(json.nodes)) throw new FormatError('Figure JSON has no "nodes" array');
  const doc = { ...json, version: FORMAT_VERSION, pages: json.pages.map(migratePage), nodes: json.nodes.map(migrateNode), edges: [] };
  return doc as unknown as Document;
}
