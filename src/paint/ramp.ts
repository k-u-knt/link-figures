import type { Paint, Stop } from "../model/types";
import type { Field } from "../registry/fields";
import type { PaintRegistry } from "../registry/paint";
import type { ColorRamp, RampGeometry, RampGeometryRegistry, RampGeometryType, RampPreset } from "../registry/ramp";

export type { ColorRamp, RampGeometry } from "../registry/ramp";

/**
 * Colour as one thing to edit: a ramp of colour stops. `rampOf` reads any paint whose type has a `ramp` hook (the
 * built-in solid, linear and radial), `paintOfRamp` writes one back (one stop a solid, two or more the paint of the
 * ramp's geometry). The file format is unchanged: a ramp is never stored, only the paint it writes.
 */

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
/** Offsets are kept to a millionth, so that a reversed ramp reversed again is the ramp it was. */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A paint's `stops` as stops: an offset (0 when missing), a colour (black when missing) and an opacity where it has one. Other keys are kept. */
export function rampStops(raw: unknown): Stop[] {
  return (Array.isArray(raw) ? raw : []).filter(isRecord).map((s) => {
    const stop = { ...s, offset: num(s.offset, 0), color: typeof s.color === "string" ? s.color : "#000000" } as Stop & Record<string, unknown>;
    if (s.opacity !== undefined && typeof s.opacity !== "number") delete stop.opacity;
    return stop;
  });
}

/** `stops` sorted by offset (stably: equal offsets keep their order), each offset kept within 0 to 1. */
export function sortStops(stops: readonly Stop[]): Stop[] {
  return stops
    .map((s, i) => ({ s: s.offset >= 0 && s.offset <= 1 ? s : { ...s, offset: clamp01(num(s.offset, 0)) }, i }))
    .sort((a, b) => a.s.offset - b.s.offset || a.i - b.i)
    .map((e) => e.s);
}

type PaintLookup = { paints: Pick<PaintRegistry, "get"> };
type GeometryLookup = Pick<RampGeometryRegistry, "get" | "all">;

/** `paint` as a ramp (stops sorted), when its type has a `ramp` hook; undefined for one that has none or is not registered. */
export function rampOf(paint: Paint, registries: PaintLookup): ColorRamp | undefined {
  const hook = registries.paints.get(paint.type)?.ramp;
  if (!hook) return undefined;
  const ramp = hook.read(paint);
  return { stops: sortStops(ramp.stops), geometry: ramp.geometry };
}

/** The name of what `paint` is ("Solid", "Linear gradient"): its type's. */
export function rampKindName(paint: Paint, registries: PaintLookup): string {
  return registries.paints.get(paint.type)?.name ?? paint.type;
}

/**
 * The paint `ramp` writes. One stop is a `solid`: its colour, and its opacity when under 1. Two or more are the paint
 * of the ramp's geometry, written by its registered kind (the first registered when it has none). `previous`, when it
 * is of the type written, keeps its other keys and their order.
 */
export function paintOfRamp(ramp: ColorRamp, previous: Paint | undefined, geometries: GeometryLookup): Paint {
  const stops = sortStops(ramp.stops);
  if (stops.length <= 1) {
    const stop = stops[0] ?? { offset: 0, color: "#000000" };
    const paint: Paint = previous?.type === "solid" ? { ...previous, type: "solid", color: stop.color } : { type: "solid", color: stop.color };
    const opacity = num(stop.opacity, 1);
    if (opacity < 1) paint.opacity = clamp01(opacity);
    else delete paint.opacity;
    return paint;
  }
  const kind = geometries.get(ramp.geometry.kind) ?? geometries.all()[0];
  if (!kind) throw new Error(`no ramp geometry "${ramp.geometry.kind}" is registered`);
  const geometry = kind.kind === ramp.geometry.kind ? ramp.geometry : kind.defaults();
  return kind.toPaint(stops, geometry, previous);
}

/** A colour as straight sRGB bytes, when it is `#rgb` or `#rrggbb`. */
function rgbOf(color: string): [number, number, number] | null {
  const text = color.trim();
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  return null;
}

const hex = (rgb: number[]): string => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/**
 * The ramp's colour at `offset`, as SVG draws a gradient: linear in sRGB with straight alpha, the end colours held
 * beyond the end stops. A colour that cannot be read (a name) is not mixed: the nearer stop's is taken.
 */
export function colorAt(stops: readonly Stop[], offset: number): { color: string; opacity: number } {
  const sorted = sortStops(stops);
  if (sorted.length === 0) return { color: "#000000", opacity: 1 };
  const t = clamp01(offset);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (t <= first.offset) return { color: first.color, opacity: num(first.opacity, 1) };
  if (t >= last.offset) return { color: last.color, opacity: num(last.opacity, 1) };
  let i = 0;
  while (i < sorted.length - 2 && t > sorted[i + 1].offset) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  const span = b.offset - a.offset;
  // To a billionth: 0.5 between stops at 0.2 and 0.8 is half way, not a hair short of it.
  const f = span > 0 ? Math.round(((t - a.offset) / span) * 1e9) / 1e9 : 1;
  const opacity = Math.round((num(a.opacity, 1) + (num(b.opacity, 1) - num(a.opacity, 1)) * f) * 1e4) / 1e4;
  const ca = rgbOf(a.color);
  const cb = rgbOf(b.color);
  if (!ca || !cb) return { color: f < 0.5 ? a.color : b.color, opacity };
  return { color: hex(ca.map((v, k) => v + (cb[k] - v) * f)), opacity };
}

/** `ramp` with a stop at `offset` in the ramp's colour there (opacity included), and the stop's index. A solid gains a second stop: a linear gradient. */
export function addStop(ramp: ColorRamp, offset: number): { ramp: ColorRamp; index: number } {
  const at = tidy(clamp01(offset));
  const { color, opacity } = colorAt(ramp.stops, at);
  const stop: Stop = opacity < 1 ? { offset: at, color, opacity } : { offset: at, color };
  const stops = sortStops([...ramp.stops, stop]);
  return { ramp: { ...ramp, stops }, index: stops.indexOf(stop) };
}

/** `ramp` without the stop at `index`; the last stop stays. */
export function removeStop(ramp: ColorRamp, index: number): ColorRamp {
  if (ramp.stops.length <= 1 || index < 0 || index >= ramp.stops.length) return ramp;
  return { ...ramp, stops: ramp.stops.filter((_, i) => i !== index) };
}

/**
 * `ramp` with the stop at `index` moved to `offset` (kept within 0 to 1), the stops in order again, and where that stop
 * now is. A stop moved onto another's offset goes past it, on the side it was moving to.
 */
export function moveStop(ramp: ColorRamp, index: number, offset: number): { ramp: ColorRamp; index: number } {
  const old = ramp.stops[index];
  if (!old) return { ramp, index };
  const stop = { ...old, offset: tidy(clamp01(offset)) };
  const others = sortStops(ramp.stops.filter((_, i) => i !== index));
  const right = stop.offset >= old.offset;
  let at = others.findIndex((s) => (right ? s.offset > stop.offset : s.offset >= stop.offset));
  if (at === -1) at = others.length;
  const stops = [...others.slice(0, at), stop, ...others.slice(at)];
  return { ramp: { ...ramp, stops }, index: at };
}

/** `ramp` flipped: each offset becomes 1 − offset, and the order follows. */
export function reverseRamp(ramp: ColorRamp): ColorRamp {
  return { ...ramp, stops: sortStops(ramp.stops.map((s) => ({ ...s, offset: tidy(1 - s.offset) })).reverse()) };
}

export const linearGeometryFields = (): Field[] => [{ kind: "number", key: "angle", label: "Angle (°)", step: 1 }];

export const radialGeometryFields = (): Field[] => [
  { kind: "number", key: "cx", label: "Centre x", min: 0, max: 1, step: 0.05 },
  { kind: "number", key: "cy", label: "Centre y", min: 0, max: 1, step: 0.05 },
  { kind: "number", key: "r", label: "Radius", min: 0, step: 0.05 },
];

/** A gradient paint of `type` from `values` and the stops, over `previous`'s other keys when it is of that type. */
function gradientPaint(type: string, values: Record<string, unknown>, stops: Stop[], previous?: Paint): Paint {
  const base: Record<string, unknown> = previous?.type === type ? { ...previous } : {};
  return Object.assign(base, { type, ...values, stops }) as Paint;
}

export const linearGeometry: RampGeometryType = {
  kind: "linear",
  name: "Linear",
  defaults: () => ({ kind: "linear", angle: 0 }),
  fields: linearGeometryFields,
  toPaint: (stops, g, previous) => gradientPaint("linear", { angle: num(g.angle, 0) }, stops, previous),
};

export const radialGeometry: RampGeometryType = {
  kind: "radial",
  name: "Radial",
  defaults: () => ({ kind: "radial", cx: 0.5, cy: 0.5, r: 0.5 }),
  fields: radialGeometryFields,
  toPaint: (stops, g, previous) => gradientPaint("radial", { cx: num(g.cx, 0.5), cy: num(g.cy, 0.5), r: num(g.r, 0.5) }, stops, previous),
};

/** The ramp geometries the plugin registers at load, in the order the slider's toggle lists them. */
export const builtinRampGeometries: RampGeometryType[] = [linearGeometry, radialGeometry];

const blackToWhite = (): Stop[] => [
  { offset: 0, color: "#000000" },
  { offset: 1, color: "#ffffff" },
];

/** `geometry` when it is of `kind`, else that kind's defaults. */
const keepOr = (geometry: RampGeometry, kind: RampGeometryType): RampGeometry => (geometry.kind === kind.kind ? geometry : kind.defaults());

/** The colour slider's presets the plugin registers at load, in menu order. */
export const builtinRampPresets: RampPreset[] = [
  {
    id: "solid",
    name: "Solid",
    apply: (ramp, selected) => {
      const stop = ramp.stops[selected] ?? ramp.stops[0] ?? { offset: 0, color: "#000000" };
      return { ...ramp, stops: [{ ...stop, offset: 0 }] };
    },
  },
  {
    id: "linear2",
    name: "Two-colour linear",
    apply: (ramp) => {
      const { stops } = ramp;
      const two = stops.length >= 2 ? [{ ...stops[0], offset: 0 }, { ...stops[stops.length - 1], offset: 1 }] : blackToWhite();
      return { stops: two, geometry: keepOr(ramp.geometry, linearGeometry) };
    },
  },
  {
    id: "radial",
    name: "Radial",
    apply: (ramp) => ({ stops: ramp.stops.length >= 2 ? ramp.stops : blackToWhite(), geometry: keepOr(ramp.geometry, radialGeometry) }),
  },
  { id: "reverse", name: "Reverse", apply: (ramp) => reverseRamp(ramp) },
];
