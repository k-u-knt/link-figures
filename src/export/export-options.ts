import type { Registries } from "../registry";
import { CommandError } from "../registry/command";
import type { Exporter } from "../registry/exporter";
import type { Field } from "../registry/fields";

/**
 * The options every format has, beside its exporter's own (`Exporter.options()`): they are about what an export writes
 * besides the figure, so the export run handles them, not the exporter, which is never given them. A toggle with an
 * `onValue` is on while its value is that (`cards: "markdown"`), and off when it is null or left out.
 */
export const COMMON_EXPORT_OPTIONS: Field[] = [{ kind: "toggle", key: "cards", label: "Export cards as Markdown", onValue: "markdown", placement: "end" }];

/** The kinds of field an exporter's options may use, and so the ones the modal draws. */
const OPTION_KINDS = new Set<Field["kind"]>(["select", "toggle", "number", "text"]);

const isOption = (field: Field) => OPTION_KINDS.has(field.kind);

/** An option field's value when none is given: a select's first choice, a toggle off (null for one with an `onValue`), a number's minimum (or 0), empty text. */
function fieldDefault(field: Field): unknown {
  switch (field.kind) {
    case "select":
      return field.options?.[0]?.value ?? "";
    case "toggle":
      return field.onValue !== undefined ? null : false;
    case "number":
      return field.min ?? 0;
    default:
      return "";
  }
}

/** The value of each of the option fields when none is given (a `Field` has no default of its own). */
export function optionDefaults(fields: Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter(isOption).map((field) => [field.key, fieldDefault(field)]));
}

/** Why `value` is not one `field` takes, or null when it is. */
function badValue(field: Field, value: unknown): string | null {
  switch (field.kind) {
    case "select": {
      const choices = (field.options ?? []).map((o) => o.value);
      return choices.includes(value as string) ? null : `must be one of ${choices.join(", ")}`;
    }
    case "toggle":
      if (field.onValue !== undefined) {
        return value === null || JSON.stringify(value) === JSON.stringify(field.onValue) ? null : `must be ${JSON.stringify(field.onValue)} or null`;
      }
      return typeof value === "boolean" ? null : "must be true or false";
    case "number": {
      const [min, max] = [field.min ?? -Infinity, field.max ?? Infinity];
      const ok = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
      return ok ? null : `must be a number from ${min} to ${max}`;
    }
    default:
      return typeof value === "string" ? null : "must be text";
  }
}

/** The options the exporter is run with: its defaults, with `given` over them. An unknown option or a bad value is an Error. */
export function exportOptions(exporter: Exporter, given: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error(`${exporter.id}: options must be an object`);
  const fields = exporter.options().filter(isOption);
  for (const [key, value] of Object.entries(given)) {
    const field = fields.find((f) => f.key === key);
    if (!field) throw new Error(`${exporter.id}: unknown option "${key}"`);
    const problem = badValue(field, value);
    if (problem) throw new Error(`${exporter.id}: option "${key}" ${problem}`);
  }
  return { ...optionDefaults(fields), ...given };
}

/** The common options (`COMMON_EXPORT_OPTIONS`) of `given`, checked, and the rest, which are the exporter's. */
export function splitCommonOptions(given: unknown): { common: { cards: boolean }; rest: Record<string, unknown> } {
  if (typeof given !== "object" || given === null || Array.isArray(given)) return { common: { cards: false }, rest: given as Record<string, unknown> };
  const rest: Record<string, unknown> = {};
  const common: Record<string, unknown> = optionDefaults(COMMON_EXPORT_OPTIONS);
  for (const [key, value] of Object.entries(given)) {
    const field = COMMON_EXPORT_OPTIONS.find((f) => f.key === key);
    if (!field) {
      rest[key] = value;
      continue;
    }
    if (value === undefined) continue;
    const problem = badValue(field, value);
    if (problem) throw new CommandError(`api.export: option "${key}" ${problem}`);
    common[key] = value;
  }
  return { common: { cards: common.cards === "markdown" }, rest };
}

/** An exporter's name without what it adds in brackets: "PowerPoint (editable)" is "PowerPoint". */
const shortName = (exporter: Exporter) => exporter.name.replace(/\s*\(.*\)\s*$/, "");

/**
 * What is wrong with a request's options before anything is opened, as the API refuses it (`api.export: …`): a common
 * option's value, or an option the format does not have but another one does (`"notes" is a PowerPoint option`). Null
 * when neither; an unknown format, or an option no format has, is left to the export's own check.
 */
export function requestOptionsProblem(registries: Registries, format: string, options: unknown): string | null {
  if (typeof options !== "object" || options === null || Array.isArray(options)) return null;
  try {
    splitCommonOptions(options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const exporter = registries.exporters.get(format);
  if (!exporter) return null;
  const own = new Set(exporter.options().map((f) => f.key));
  for (const key of Object.keys(options)) {
    if (own.has(key) || COMMON_EXPORT_OPTIONS.some((f) => f.key === key)) continue;
    const others = registries.exporters.all().filter((e) => e.id !== exporter.id && e.options().some((f) => f.key === key));
    if (others.length > 0) return `api.export: "${key}" is a ${[...new Set(others.map(shortName))].join(" or ")} option`;
  }
  return null;
}
