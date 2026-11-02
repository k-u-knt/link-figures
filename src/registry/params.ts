import type { End, Paint, Stroke } from "../model/types";

/** The JSON types a parameter may have; `end`, `paint` and `stroke` are the model's own shapes (see `model/types`). */
export type ParamType = "string" | "number" | "boolean" | "object" | "array" | "end" | "paint" | "stroke";

/** One parameter: its type, whether a call must give it, the value it takes when not given, and the values it may take. */
export interface Param {
  type: ParamType;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
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

const CHECKS: Record<ParamType, { test: (value: unknown) => boolean; what: string }> = {
  string: { test: (v) => typeof v === "string", what: "a string" },
  number: { test: isFiniteNumber, what: "a finite number" },
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
    const check = CHECKS[param.type];
    if (!check.test(given)) return { ok: false, error: `parameter "${name}" must be ${check.what}` };
    if (param.enum && !param.enum.includes(given)) {
      return { ok: false, error: `parameter "${name}" must be one of ${param.enum.map((v) => JSON.stringify(v)).join(", ")}` };
    }
    value[name] = given;
  }
  return { ok: true, value };
}
