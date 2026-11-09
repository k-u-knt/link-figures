import type { Cap, End, Paint, Stroke } from "../model/types";

/**
 * The JSON types a parameter may have; an `integer` is a whole number, and `end`, `paint` and `stroke` are the model's
 * own shapes (see `model/types`).
 */
export type ParamType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "end" | "paint" | "stroke";

/**
 * One parameter: its type, whether a call must give it, the value it takes when not given, the values it may take, and
 * whether null is a value it may take besides its type (a shape's `border`: null for none). A number may have bounds
 * (`minimum` and `maximum` inclusive, `exclusiveMinimum` not), a string a `pattern` (a regular expression it must match
 * whole), an object `properties` (its keys' own params; a key not listed is fine) and an array `items` (the param each
 * entry must meet), as in JSON schema.
 */
export interface Param {
  type: ParamType;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  pattern?: string;
  properties?: ParamSpec;
  items?: Param;
}

/** A command's parameters by name: a small JSON-schema-like description that callers can read and that calls are checked against. */
export type ParamSpec = Record<string, Param>;

export type ValidatedArgs = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Whether `value` is a connector end: a free point, or attached to a node at an anchor or at its centre. */
export function isEnd(value: unknown): value is End {
  if (!isRecord(value)) return false;
  if (value.kind === "free") return isFiniteNumber(value.x) && isFiniteNumber(value.y);
  if (value.kind !== "attached" || typeof value.node !== "string") return false;
  if (value.snap === "center") return true;
  return value.snap === "anchor" && typeof value.anchor === "string";
}

/** Whether `value` is a paint: an object naming its type. Its own params are the paint type's to check. */
export function isPaint(value: unknown): value is Paint {
  return isRecord(value) && typeof value.type === "string";
}

/** Whether `value` is a connector cap: a cap kind's id and a size (a multiple of the stroke's width) that is not negative. */
export function isCap(value: unknown): value is Cap {
  return isRecord(value) && typeof value.kind === "string" && isFiniteNumber(value.size) && value.size >= 0;
}

const DASHES: readonly unknown[] = ["solid", "dash", "dot", "dashDot"];
const CAPS: readonly unknown[] = ["butt", "round", "square"];
const JOINS: readonly unknown[] = ["miter", "round", "bevel"];

/** Whether `value` is a stroke: a paint, a width in pt that is not negative, a dash style, and a cap and join when it has them. */
export function isStroke(value: unknown): value is Stroke {
  return (
    isRecord(value) &&
    isPaint(value.paint) &&
    isFiniteNumber(value.width) &&
    value.width >= 0 &&
    DASHES.includes(value.dash) &&
    (value.cap === undefined || CAPS.includes(value.cap)) &&
    (value.join === undefined || JOINS.includes(value.join))
  );
}

/** The keys a stroke has (see `Stroke`); any other key in a stroke given to a command is refused (`paramError`). */
export const STROKE_KEYS: readonly string[] = ["paint", "width", "dash", "cap", "join"];

/** `a, b and c`. */
const listed = (items: readonly string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const CHECKS: Record<ParamType, { test: (value: unknown) => boolean; what: string }> = {
  string: { test: (v) => typeof v === "string", what: "a string" },
  number: { test: isFiniteNumber, what: "a finite number" },
  integer: { test: Number.isInteger, what: "a whole number" },
  boolean: { test: (v) => typeof v === "boolean", what: "true or false" },
  object: { test: isRecord, what: "an object" },
  array: { test: Array.isArray, what: "an array" },
  end: { test: isEnd, what: 'an end ({kind: "free", x, y} or {kind: "attached", node, snap, anchor?})' },
  paint: { test: isPaint, what: "a paint ({type, …})" },
  stroke: { test: isStroke, what: "a stroke ({paint, width, dash, cap?, join?})" },
};

/**
 * Checks `args` (a call's JSON arguments; none is an empty object) against `spec`. The value holds every given
 * parameter and the default of each one that was not given. A parameter the spec does not name, a missing required one,
 * one of the wrong type or one outside its `enum` is an error, and the error names the parameter.
 */
export function validateArgs(spec: ParamSpec, args: unknown): ValidatedArgs {
  if (args === undefined || args === null) args = {};
  if (!isRecord(args)) return { ok: false, error: "the arguments must be an object of named parameters" };
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(spec, name)) return { ok: false, error: `unknown parameter "${name}"` };
  }
  const value: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(spec)) {
    const given = args[name];
    if (given === undefined) {
      if (param.required) return { ok: false, error: `parameter "${name}" is required` };
      // A copy, so a command that changes what it was given cannot change the default for the next call.
      if (param.default !== undefined) value[name] = structuredClone(param.default);
      continue;
    }
    const error = paramError(name, param, given);
    if (error !== null) return { ok: false, error: `parameter ${error}` };
    value[name] = given;
  }
  return { ok: true, value };
}

/**
 * What is wrong with `value` as the parameter (or field) `name` that `param` describes: `"name" must be …`, or null
 * when it is fine. Whether it is required, and its default, are the caller's. A stroke with a key not in `STROKE_KEYS`
 * is refused, naming the key (with `given`, only a key that it gives: what a patch merged into the field gives): every command that takes a stroke (a connector's `stroke`, a shape's `border`, a panel's
 * `frame`) checks it here. A file is not: its strokes are read by `migrateStroke`, which keeps what it does not know.
 */
export function paramError(name: string, param: Param, value: unknown, given?: { value: unknown }): string | null {
  // Within `node.update` (`judgingPatch`), a top-level field is judged by what its patch gives, though the caller (a
  // plugin's checkField) passed nothing.
  if (given === undefined && updatePatch !== null && !name.includes(".")) given = { value: updatePatch[name] };
  if (value === null && param.nullable) return null;
  const check = CHECKS[param.type];
  if (!check.test(value)) return `"${name}" must be ${check.what}${param.nullable ? " or null" : ""}`;
  // A stroke is drawn from its own keys only: another (a `color` beside `paint`) would be kept and never drawn.
  // Only the keys the caller gave are judged (`given`, a patch's part of the field): a key the stroke already had in
  // the file, from before strokes were checked, is kept and blocks no edit.
  const judged = given ? given.value : value;
  if (param.type === "stroke" && isRecord(value) && isRecord(judged)) {
    const unknown = Object.keys(judged).find((key) => !STROKE_KEYS.includes(key));
    if (unknown !== undefined) return `"${name}.${unknown}" is not a stroke key: a stroke has ${listed(STROKE_KEYS)}`;
  }
  if (param.enum && !param.enum.includes(value)) return `"${name}" must be one of ${param.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if (typeof value === "number") {
    if (param.minimum !== undefined && value < param.minimum) return `"${name}" must be at least ${param.minimum}`;
    if (param.maximum !== undefined && value > param.maximum) return `"${name}" must be at most ${param.maximum}`;
    if (param.exclusiveMinimum !== undefined && value <= param.exclusiveMinimum) return `"${name}" must be more than ${param.exclusiveMinimum}`;
  }
  if (typeof value === "string" && param.pattern !== undefined && !new RegExp(`^(?:${param.pattern})$`).test(value)) {
    return `"${name}" must match ${param.pattern}`;
  }
  if (isRecord(value) && param.properties) {
    for (const [key, inner] of Object.entries(param.properties)) {
      const given = Object.hasOwn(value, key) ? value[key] : undefined;
      if (given === undefined) {
        if (inner.required) return `"${name}.${key}" is required`;
        continue;
      }
      const error = paramError(`${name}.${key}`, inner, given);
      if (error !== null) return error;
    }
  }
  if (Array.isArray(value) && param.items) {
    for (let i = 0; i < value.length; i++) {
      const error = paramError(`${name}.${i}`, param.items, value[i]);
      if (error !== null) return error;
    }
  }
  return null;
}

/** The patch `node.update` is checking fields against (see `judgingPatch`), or null outside it. */
let updatePatch: Record<string, unknown> | null = null;

/**
 * Runs `check` (a node update's field checks) with `patch` as the patch every `paramError` and `fieldError` in it
 * judges a top-level field's stroke keys by, unless told otherwise: so a node type's `checkField` gets patch-only
 * judging whether or not it passes its context on. `node.update` runs its checks in it.
 */
export function judgingPatch<T>(patch: Record<string, unknown>, check: () => T): T {
  const outer = updatePatch;
  updatePatch = patch;
  try {
    return check();
  } finally {
    updatePatch = outer;
  }
}

/** A colour as the model keeps it: `#rrggbb`. For a param's `pattern`. */
export const COLOR_PATTERN = "#[0-9a-fA-F]{6}";

/**
 * For a node type's `checkField`: what is wrong with `value` as the field `key` when `fields` describes it, else null.
 * Pass `checkField`'s context, so that a stroke is judged by the keys its patch gives (see `paramError`).
 */
export function fieldError(fields: ParamSpec, key: string, value: unknown, ctx?: { patch?: Record<string, unknown> }): string | null {
  if (!Object.hasOwn(fields, key)) return null;
  return paramError(key, fields[key], value, ctx?.patch ? { value: ctx.patch[key] } : undefined);
}
