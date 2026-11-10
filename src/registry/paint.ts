import { PT_TO_PX } from "../constants";
import { escapeAttr } from "../export/svg-builder";
import type { Rect } from "../model/geometry";
import type { Paint, Stroke } from "../model/types";
import type { Field } from "./fields";
import type { ColorRamp } from "./ramp";

/** What a paint needs from the SVG build it is part of. `warnings`, where there is one, is told what could not be painted. */
export interface PaintContext {
  uid(prefix: string): string;
  warnings?: string[];
}

/**
 * A paint as SVG: `ref` is what goes in a `fill` or `stroke` attribute (a colour, `url(#id)`, or `none`), `defs` the
 * elements `ref` points to. `opacity`, when the paint has one below 1, goes in `fill-opacity` or `stroke-opacity`.
 */
export interface PaintSvg {
  ref: string;
  defs: string[];
  opacity?: number;
}

/** What a paint needs to be written to PowerPoint: a place to say what it could not keep. */
export interface PaintPptxContext {
  warn(message: string): void;
}

/**
 * One kind of paint (solid, gradient, pattern…). The same entry paints fills and strokes. `toSvg` lays a gradient or
 * pattern out in `box`, in page px: the shape's box for a fill, the path's bounds for a stroke.
 */
export interface PaintType {
  id: string;
  name: string;
  /** The paint a fill or stroke gets when the user switches to this type. */
  defaults(): Paint;
  /** The type's own inspector fields; their keys are relative to the paint (`"color"`, `"stops"`). */
  fields(paint: Paint): Field[];
  toSvg(paint: Paint, box: Rect, ctx: PaintContext): PaintSvg;
  /**
   * The paint as a DrawingML fill element (`a:solidFill`, `a:gradFill`, `a:pattFill`, `a:noFill`) for a shape or line
   * whose box is `box` (px, only its size), every colour's alpha multiplied by `alpha`. A type without it is written as
   * no fill, with a warning.
   */
  toPptx?(paint: Paint, alpha: number, box: { width: number; height: number }, ctx: PaintPptxContext): string;
  /**
   * A paint that is a ramp of colour stops (a solid colour, a gradient) reads as one here, so that the colour slider
   * edits it; the ramp is written back by `paintOfRamp` (one stop a solid, more through the ramp's geometry). A type
   * without it keeps its own fields.
   */
  ramp?: { read(paint: Paint): ColorRamp };
}

export class PaintRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly types = new Map<string, PaintType>();

  register(t: PaintType): void {
    this.types.set(t.id, t);
  }

  get(id: string): PaintType | undefined {
    return this.types.get(id);
  }

  all(): PaintType[] {
    return [...this.types.values()];
  }
}

/** `paint` as SVG through its registered type; a type that is not registered paints nothing, and says so in `ctx.warnings`. */
export function paintToSvg(registry: PaintRegistry, paint: Paint, box: Rect, ctx: PaintContext): PaintSvg {
  const type = registry.get(paint.type);
  if (!type) {
    ctx.warnings?.push(`no paint type "${paint.type}" is registered, drawn without paint`);
    return { ref: "none", defs: [] };
  }
  return type.toSvg(paint, box, ctx);
}

/** Dash and gap lengths, in multiples of the stroke's width. */
const DASH_PATTERNS: Record<Stroke["dash"], number[]> = {
  solid: [],
  dash: [4, 2],
  dot: [1, 2],
  dashDot: [4, 2, 1, 2],
};

/**
 * The SVG attributes that draw `stroke` with the paint `ref` (from `paintToSvg`): its width in px, its dashes (scaled
 * to the width), and its cap and join where it sets them. `opacity` is the paint's own, written when below 1.
 */
export function strokeAttrs(stroke: Stroke, ref: string, opacity?: number): string {
  const width = stroke.width * PT_TO_PX;
  const attrs = [`stroke="${ref}"`, `stroke-width="${width}"`];
  const dashes = Object.hasOwn(DASH_PATTERNS, stroke.dash) ? DASH_PATTERNS[stroke.dash] : [];
  if (dashes.length > 0 && width > 0) attrs.push(`stroke-dasharray="${dashes.map((d) => d * width).join(" ")}"`);
  if (stroke.cap) attrs.push(`stroke-linecap="${escapeAttr(stroke.cap)}"`);
  if (stroke.join) attrs.push(`stroke-linejoin="${escapeAttr(stroke.join)}"`);
  if (opacity !== undefined && opacity < 1) attrs.push(`stroke-opacity="${opacity}"`);
  return attrs.join(" ");
}

const DASH_OPTIONS: { value: Stroke["dash"]; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dash", label: "Dashed" },
  { value: "dot", label: "Dotted" },
  { value: "dashDot", label: "Dash-dot" },
];

/** The inspector fields of the stroke at `key` (`"border"`), labelled after `name` (`"Border"`): its paint, its width in pt and its dashes. */
export function strokeFields(key: string, name: string): Field[] {
  return [
    { kind: "paint", key: `${key}.paint`, label: `${name} paint` },
    { kind: "number", key: `${key}.width`, label: `${name} width`, unit: "pt", min: 0, step: 0.25 },
    { kind: "select", key: `${key}.dash`, label: `${name} dash`, options: DASH_OPTIONS },
  ];
}
