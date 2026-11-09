import type { Page } from "../model/types";
import { DEFAULT_PAGE_LIMIT_MM } from "../constants";
import { PAGE_PRESETS, getPreset } from "../model/presets";
import type { Field } from "../registry/fields";

/** The preset id of a page whose size is its own. */
export const CUSTOM_PRESET = "custom";

/** The inspector's fields for a page. Sizes and margins are millimetres, which is also how a page stores them. */
export function pageFields(): Field[] {
  const margin = (side: string): Field => ({ kind: "number", key: `margins.${side}`, label: `Margin ${side}`, unit: "mm", min: 0, step: 0.5 });
  return [
    {
      kind: "select",
      key: "preset",
      label: "Preset",
      options: [...PAGE_PRESETS.map((p) => ({ value: p.id, label: p.name })), { value: CUSTOM_PRESET, label: "Custom" }],
    },
    { kind: "number", key: "width", label: "Width", unit: "mm", min: 10, step: 0.5 },
    { kind: "number", key: "height", label: "Height", unit: "mm", min: 10, step: 0.5 },
    // Off is a transparent paper (the inspector reads and writes `"transparent"` as none).
    { kind: "color", key: "paper", label: "Paper", nullable: true },
    margin("top"),
    margin("right"),
    margin("bottom"),
    margin("left"),
  ];
}

/**
 * `page` with the preset's id and size, everything else as it was. `"custom"`, and an id that is no preset, leave
 * the size alone and mark the page custom. Does not change `page`.
 */
export function applyPreset(page: Page, presetId: string): Page {
  const preset = getPreset(presetId);
  if (!preset) return { ...page, preset: CUSTOM_PRESET };
  return { ...page, preset: preset.id, width: preset.width, height: preset.height };
}

/**
 * The inspector's fields for any node. Position and size are millimetres, though a node stores pixels: the inspector
 * converts (see `Inspector`). Rotation is in degrees, which a field's `unit` cannot say, so its label does.
 */
export function nodeBaseFields(): Field[] {
  return [
    { kind: "number", key: "x", label: "X", unit: "mm", step: 0.1 },
    { kind: "number", key: "y", label: "Y", unit: "mm", step: 0.1 },
    // Not below a millimetre: the same least size a drag keeps (`MIN_NODE_PX`).
    { kind: "number", key: "width", label: "Width", unit: "mm", min: 1, step: 0.1 },
    { kind: "number", key: "height", label: "Height", unit: "mm", min: 1, step: 0.1 },
    { kind: "number", key: "rotation", label: "Rotation (°)", step: 1 },
    { kind: "number", key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05 },
    { kind: "text", key: "name", label: "Name" },
    { kind: "toggle", key: "locked", label: "Locked" },
  ];
}

/** Path segments that would reach the prototype instead of the object. */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** The value at a dotted key (`"margins.left"`, `"font.size"`), or undefined when something on the way is not there. */
export function readValue(obj: object, key: string): unknown {
  let at: unknown = obj;
  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null || UNSAFE_SEGMENTS.has(part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** Sets the value at a dotted key, making the objects on the way when they are not there. */
export function writeValue(obj: object, key: string, value: unknown): void {
  const parts = key.split(".");
  if (parts.some((part) => UNSAFE_SEGMENTS.has(part))) return;
  let at = obj as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = at[part];
    if (typeof next !== "object" || next === null) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  at[parts[parts.length - 1]] = value;
}

/** `mm` kept within the page limit, and whether it had to be. */
export function clampPageSize(mm: number, limitMm: number): { value: number; clamped: boolean } {
  return mm > limitMm ? { value: limitMm, clamped: true } : { value: mm, clamped: false };
}

/**
 * What editing one of a page's fields does to `page` (changing it in place, so it can run on a draft). The preset
 * select also sets the size; a width or height that is then not the preset's makes the page custom, so the select
 * never names a size the page does not have. A width or height over `limitMm` is set to it instead; the result says
 * whether that happened.
 */
export function writePageField(page: Page, key: string, value: unknown, limitMm: number = DEFAULT_PAGE_LIMIT_MM): boolean {
  if (key === "preset") {
    const next = applyPreset(page, String(value));
    const width = clampPageSize(next.width, limitMm);
    const height = clampPageSize(next.height, limitMm);
    // A preset whose size was cut down is no longer that preset.
    page.preset = width.clamped || height.clamped ? CUSTOM_PRESET : next.preset;
    page.width = width.value;
    page.height = height.value;
    return width.clamped || height.clamped;
  }
  let clamped = false;
  if ((key === "width" || key === "height") && typeof value === "number") {
    const size = clampPageSize(value, limitMm);
    clamped = size.clamped;
    writeValue(page, key, size.value);
  } else {
    writeValue(page, key, value);
  }
  if (key !== "width" && key !== "height") return false;
  const preset = page.preset === undefined ? undefined : getPreset(page.preset);
  if (preset && (preset.width !== page.width || preset.height !== page.height)) page.preset = CUSTOM_PRESET;
  return clamped;
}
