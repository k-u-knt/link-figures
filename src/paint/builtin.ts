import { angle60k, colorXml, gsLstXml, PATTERN_WARNING, radialStops, readColor, readStops, type GradStop } from "../export/pptx/drawingml";
import { escapeAttr } from "../export/svg-builder";
import type { Rect } from "../model/geometry";
import { toSvgPath, type PathData } from "../model/path";
import type { Paint, Stop } from "../model/types";
import type { Field } from "../registry/fields";
import type { PaintContext, PaintType } from "../registry/paint";

/** A finite number from a paint's params, or `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** A colour from a paint's params, escaped for an attribute; `fallback` when there is none. */
function color(value: unknown, fallback: string): string {
  return escapeAttr(typeof value === "string" ? value : fallback);
}

/** A gradient's stops as `<stop>` elements, in offset order and kept within 0-1 (SVG would clamp an out-of-order stop). */
function stopElements(raw: unknown): string {
  const stops = (Array.isArray(raw) ? raw : []).filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null);
  return stops
    .map((s) => ({ offset: clamp01(num(s.offset, 0)), color: color(s.color, "#000000"), opacity: s.opacity }))
    .sort((a, b) => a.offset - b.offset)
    .map((s) => {
      const opacity = typeof s.opacity === "number" && Number.isFinite(s.opacity) ? ` stop-opacity="${clamp01(s.opacity)}"` : "";
      return `<stop offset="${s.offset}" stop-color="${s.color}"${opacity}/>`;
    })
    .join("");
}

/** The unit vector at `deg` degrees clockwise from +x (page y points down); whole quarter turns are exact. */
function direction(deg: number): { x: number; y: number } {
  const turn = ((deg % 360) + 360) % 360;
  const exact: Record<number, { x: number; y: number }> = { 0: { x: 1, y: 0 }, 90: { x: 0, y: 1 }, 180: { x: -1, y: 0 }, 270: { x: 0, y: -1 } };
  if (exact[turn]) return exact[turn];
  const rad = (turn * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

const defaultStops = (): Stop[] => [
  { offset: 0, color: "#000000" },
  { offset: 1, color: "#ffffff" },
];

const stopsField: Field = { kind: "stops", key: "stops", label: "Stops" };

export const nonePaint: PaintType = {
  id: "none",
  name: "None",
  defaults: () => ({ type: "none" }),
  fields: () => [],
  toSvg: () => ({ ref: "none", defs: [] }),
  toPptx: () => "<a:noFill/>",
};

/** One colour; `opacity` (0-1) is left to the attribute that uses it (`fill-opacity`, `stroke-opacity`). */
export const solidPaint: PaintType = {
  id: "solid",
  name: "Solid",
  defaults: () => ({ type: "solid", color: "#000000" }),
  fields: () => [
    { kind: "color", key: "color", label: "Color" },
    { kind: "number", key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05 },
  ],
  toSvg(paint) {
    const ref = color(paint.color, "#000000");
    const opacity = clamp01(num(paint.opacity, 1));
    return opacity < 1 ? { ref, defs: [], opacity } : { ref, defs: [] };
  },
  toPptx: (paint, alpha, _box, ctx) => `<a:solidFill>${colorXml(readColor(paint.color, ctx), clamp01(num(paint.opacity, 1)) * alpha)}</a:solidFill>`,
};

/** A gradient of fewer than two stops for PowerPoint: one colour, or nothing; null for a real gradient. */
function degenerateGradient(stops: GradStop[], alpha: number): string | null {
  if (stops.length === 0) return "<a:noFill/>";
  if (stops.length === 1) return `<a:solidFill>${colorXml(stops[0].rgb, stops[0].alpha * alpha)}</a:solidFill>`;
  return null;
}

/**
 * A gradient along `angle` degrees (0 runs left to right, 90 top to bottom), through the box's centre. Its line is as
 * long as the box's extent in that direction, so offset 0 and 1 fall on the box's farthest corners.
 */
export const linearPaint: PaintType = {
  id: "linear",
  name: "Linear gradient",
  defaults: () => ({ type: "linear", angle: 0, stops: defaultStops() }),
  fields: () => [{ kind: "number", key: "angle", label: "Angle (°)", step: 1 }, stopsField],
  toSvg(paint, box: Rect, ctx: PaintContext) {
    const d = direction(num(paint.angle, 0));
    const half = (Math.abs(box.width * d.x) + Math.abs(box.height * d.y)) / 2;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const id = ctx.uid("grad");
    const line = `x1="${cx - d.x * half}" y1="${cy - d.y * half}" x2="${cx + d.x * half}" y2="${cy + d.y * half}"`;
    return { ref: `url(#${id})`, defs: [`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ${line}>${stopElements(paint.stops)}</linearGradient>`] };
  },
  /** Our angle and `a:lin ang` share a convention (clockwise from +x, y down) and an extent (the box's along the angle). */
  toPptx(paint, alpha, _box, ctx) {
    const stops = readStops(paint.stops, ctx);
    const lin = `<a:lin ang="${angle60k(num(paint.angle, 0))}" scaled="0"/>`;
    return degenerateGradient(stops, alpha) ?? `<a:gradFill rotWithShape="1">${gsLstXml(stops, alpha)}${lin}</a:gradFill>`;
  },
};

/** A circular gradient: its centre `cx`, `cy` are fractions of the box's width and height, its radius `r` a fraction of the box's longer side. */
export const radialPaint: PaintType = {
  id: "radial",
  name: "Radial gradient",
  defaults: () => ({ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: defaultStops() }),
  fields: () => [
    { kind: "number", key: "cx", label: "Centre x", min: 0, max: 1, step: 0.05 },
    { kind: "number", key: "cy", label: "Centre y", min: 0, max: 1, step: 0.05 },
    { kind: "number", key: "r", label: "Radius", min: 0, step: 0.05 },
    stopsField,
  ],
  toSvg(paint, box: Rect, ctx: PaintContext) {
    const cx = box.x + num(paint.cx, 0.5) * box.width;
    const cy = box.y + num(paint.cy, 0.5) * box.height;
    const r = Math.max(0, num(paint.r, 0.5)) * Math.max(box.width, box.height);
    const id = ctx.uid("grad");
    return { ref: `url(#${id})`, defs: [`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">${stopElements(paint.stops)}</radialGradient>`] };
  },
  /**
   * A circular path gradient centred by `fillToRect`. DrawingML's 0-1 runs to the box's farthest corner, so the stops
   * are placed at their distance (see `radialStops`).
   */
  toPptx(paint, alpha, box, ctx) {
    const stops = readStops(paint.stops, ctx);
    const degenerate = degenerateGradient(stops, alpha);
    if (degenerate !== null) return degenerate;
    const cx = num(paint.cx, 0.5);
    const cy = num(paint.cy, 0.5);
    const radius = Math.max(0, num(paint.r, 0.5)) * Math.max(box.width, box.height);
    const far = Math.hypot(Math.max(cx, 1 - cx) * box.width, Math.max(cy, 1 - cy) * box.height);
    const placed = radialStops(stops, radius, far);
    if (placed.length === 1) return `<a:solidFill>${colorXml(placed[0].rgb, placed[0].alpha * alpha)}</a:solidFill>`;
    const pct = (v: number): number => Math.round(v * 100000);
    const rect = `<a:fillToRect l="${pct(cx)}" t="${pct(cy)}" r="${pct(1 - cx)}" b="${pct(1 - cy)}"/>`;
    return `<a:gradFill rotWithShape="1">${gsLstXml(placed, alpha)}<a:path path="circle">${rect}</a:path></a:gradFill>`;
  },
};

/** A pattern tile's side at scale 1, in px; its lines are an eighth of the side wide. */
const PATTERN_TILE_PX = 8;

/** PowerPoint's preset patterns nearest our pattern tiles. */
const PATTERN_PRESETS: Record<string, string> = {
  hatch: "dkUpDiag",
  hatchReverse: "dkDnDiag",
  crosshatch: "diagCross",
  grid: "lgGrid",
  dots: "pct20",
};

/** "/" lines across a tile of side `t`, with the neighbouring tiles' ends at two corners so the lines join up. */
const forward = (t: number): PathData => [
  { op: "M", x: 0, y: t },
  { op: "L", x: t, y: 0 },
  { op: "M", x: -t / 4, y: t / 4 },
  { op: "L", x: t / 4, y: -t / 4 },
  { op: "M", x: (3 * t) / 4, y: (5 * t) / 4 },
  { op: "L", x: (5 * t) / 4, y: (3 * t) / 4 },
];

/** "\" lines, as `forward`. */
const backward = (t: number): PathData => [
  { op: "M", x: 0, y: 0 },
  { op: "L", x: t, y: t },
  { op: "M", x: -t / 4, y: (3 * t) / 4 },
  { op: "L", x: t / 4, y: (5 * t) / 4 },
  { op: "M", x: (3 * t) / 4, y: -t / 4 },
  { op: "L", x: (5 * t) / 4, y: t / 4 },
];

const lines = (path: PathData, t: number, fg: string): string => `<path d="${toSvgPath(path)}" fill="none" stroke="${fg}" stroke-width="${t / 8}"/>`;

/** What each `pattern` draws on a tile of side `t` in the colour `fg`. */
const PATTERN_TILES: Record<string, (t: number, fg: string) => string> = {
  hatch: (t, fg) => lines(forward(t), t, fg),
  hatchReverse: (t, fg) => lines(backward(t), t, fg),
  crosshatch: (t, fg) => lines([...forward(t), ...backward(t)], t, fg),
  grid: (t, fg) =>
    lines(
      [
        { op: "M", x: 0, y: t / 2 },
        { op: "L", x: t, y: t / 2 },
        { op: "M", x: t / 2, y: 0 },
        { op: "L", x: t / 2, y: t },
      ],
      t,
      fg,
    ),
  dots: (t, fg) => `<circle cx="${t / 2}" cy="${t / 2}" r="${(3 * t) / 16}" fill="${fg}"/>`,
};

/**
 * A repeating tile: `pattern` is one of `PATTERN_TILES`, drawn in `fg` over `bg` (null for none). `scale` multiplies
 * the tile's size; `angle` turns the pattern (degrees, clockwise) about the box's top-left corner, where tiles start.
 */
export const patternPaint: PaintType = {
  id: "pattern",
  name: "Pattern",
  defaults: () => ({ type: "pattern", pattern: "hatch", fg: "#000000", bg: null, scale: 1, angle: 0 }),
  fields: () => [
    {
      kind: "select",
      key: "pattern",
      label: "Pattern",
      options: [
        { value: "hatch", label: "Hatch" },
        { value: "hatchReverse", label: "Hatch, reversed" },
        { value: "crosshatch", label: "Crosshatch" },
        { value: "dots", label: "Dots" },
        { value: "grid", label: "Grid" },
      ],
    },
    { kind: "color", key: "fg", label: "Color" },
    { kind: "color", key: "bg", label: "Background", nullable: true },
    { kind: "number", key: "scale", label: "Scale", min: 0.1, step: 0.1 },
    { kind: "number", key: "angle", label: "Angle (°)", step: 1 },
  ],
  toSvg(paint, box: Rect, ctx: PaintContext) {
    const scale = num(paint.scale, 1);
    const t = PATTERN_TILE_PX * (scale > 0 ? scale : 1);
    const name = typeof paint.pattern === "string" ? paint.pattern : "";
    let tile = Object.hasOwn(PATTERN_TILES, name) ? PATTERN_TILES[name] : undefined;
    if (!tile) {
      ctx.warnings?.push(`no pattern "${name}" is known, drawn as hatch`);
      tile = PATTERN_TILES.hatch;
    }
    const angle = num(paint.angle, 0);
    const turn = angle === 0 ? "" : ` patternTransform="rotate(${angle} ${box.x} ${box.y})"`;
    const bg = typeof paint.bg === "string" ? `<rect width="${t}" height="${t}" fill="${escapeAttr(paint.bg)}"/>` : "";
    const id = ctx.uid("pattern");
    const def = `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${box.x}" y="${box.y}" width="${t}" height="${t}"${turn}>${bg}${tile(t, color(paint.fg, "#000000"))}</pattern>`;
    return { ref: `url(#${id})`, defs: [def] };
  },
  /** PowerPoint's nearest preset pattern, in `fg` over `bg` (clear for none); scale and angle are not kept (one export-wide warning). */
  toPptx(paint, alpha, _box, ctx) {
    const name = typeof paint.pattern === "string" ? paint.pattern : "";
    let prst = Object.hasOwn(PATTERN_PRESETS, name) ? PATTERN_PRESETS[name] : undefined;
    if (!prst) {
      ctx.warn(`no pattern "${name}" is known, written as hatch`);
      prst = PATTERN_PRESETS.hatch;
    }
    ctx.warn(PATTERN_WARNING);
    const fg = colorXml(readColor(paint.fg, ctx), alpha);
    const bg = typeof paint.bg === "string" ? colorXml(readColor(paint.bg, ctx), alpha) : colorXml("FFFFFF", 0);
    return `<a:pattFill prst="${prst}"><a:fgClr>${fg}</a:fgClr><a:bgClr>${bg}</a:bgClr></a:pattFill>`;
  },
};

/** The paint types the plugin registers at load, in the order the paint select lists them. */
export const builtinPaintTypes: PaintType[] = [nonePaint, solidPaint, linearPaint, radialPaint, patternPaint];
