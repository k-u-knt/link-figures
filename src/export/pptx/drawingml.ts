import type { Pt, Rect } from "../../model/geometry";
import type { PathData } from "../../model/path";
import type { Paint, Stroke } from "../../model/types";
import type { PaintPptxContext } from "../../registry/paint";
import type { PptxContext } from "../../registry/node-type";
import { escapeXml } from "./package";

/** DrawingML's units: 914 400 EMU to the inch, so 9525 to a CSS px (96 per inch), 36 000 to a mm, 12 700 to a pt. */
export const EMU_PER_PX = 9525;
export const EMU_PER_MM = 36000;
export const EMU_PER_PT = 12700;

/** What the paint and line helpers need of a slide's context. */
export type DrawingContext = Pick<PptxContext, "registries" | "scale" | "warn">;

/** The warning a pattern fill gives: PowerPoint's preset patterns have fixed sizes and no angle. */
export const PATTERN_WARNING = "pattern fills are written as PowerPoint's nearest preset pattern; their scale and angle are not kept";

/** `deg` degrees as DrawingML's 60 000ths of a degree, within one turn. */
export function angle60k(deg: number): number {
  const turn = ((deg % 360) + 360) % 360;
  return Math.round(turn * 60000) % 21600000;
}

/** `#rrggbb` or `#rgb` as DrawingML's `RRGGBB`; null for anything else. */
export function hexColor(color: string): string | null {
  const long = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (long) return long[1].toUpperCase();
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(color);
  if (short) return (short[1] + short[1] + short[2] + short[2] + short[3] + short[3]).toUpperCase();
  return null;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** An `a:srgbClr` of `rgb` (`RRGGBB`), with `a:alpha` (1/1000 per cent) when `alpha` is below 1. */
export function colorXml(rgb: string, alpha: number): string {
  const a = clamp01(alpha);
  return a >= 1 ? `<a:srgbClr val="${rgb}"/>` : `<a:srgbClr val="${rgb}"><a:alpha val="${Math.round(a * 100000)}"/></a:srgbClr>`;
}

/** `value` as a colour for DrawingML: black, with a warning, when it is not a `#rrggbb` (or `#rgb`) colour. */
export function readColor(value: unknown, ctx: Pick<PaintPptxContext, "warn">): string {
  const rgb = typeof value === "string" ? hexColor(value) : null;
  if (rgb === null) ctx.warn(`the colour ${JSON.stringify(value)} is not one PowerPoint can take, written as black`);
  return rgb ?? "000000";
}

/** One stop of a gradient as DrawingML writes it: `pos` 0-1, `rgb` as `RRGGBB`, `alpha` 0-1. */
export interface GradStop {
  pos: number;
  rgb: string;
  alpha: number;
}

/** A gradient paint's `stops`, read and put in offset order within 0-1, as the SVG export draws them. */
export function readStops(raw: unknown, ctx: Pick<PaintPptxContext, "warn">): GradStop[] {
  const stops = (Array.isArray(raw) ? raw : []).filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null);
  return stops
    .map((s) => ({ pos: clamp01(num(s.offset, 0)), rgb: readColor(s.color, ctx), alpha: clamp01(num(s.opacity, 1)) }))
    .sort((a, b) => a.pos - b.pos);
}

/** The colour a gradient has at `pos` (0-1), between the stops around it. */
function colorAt(stops: GradStop[], pos: number): GradStop {
  if (pos <= stops[0].pos) return { ...stops[0], pos };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (pos <= b.pos) {
      const t = b.pos === a.pos ? 1 : (pos - a.pos) / (b.pos - a.pos);
      const channel = (k: number): number => {
        const ca = parseInt(a.rgb.slice(k, k + 2), 16);
        const cb = parseInt(b.rgb.slice(k, k + 2), 16);
        return Math.round(ca + (cb - ca) * t);
      };
      const rgb = [0, 2, 4].map((k) => channel(k).toString(16).toUpperCase().padStart(2, "0")).join("");
      return { pos, rgb, alpha: a.alpha + (b.alpha - a.alpha) * t };
    }
  }
  return { ...stops[stops.length - 1], pos };
}

/** An `a:gsLst` of `stops`, each colour's alpha multiplied by `alpha`. */
export const gsLstXml = (stops: GradStop[], alpha: number): string =>
  `<a:gsLst>${stops.map((s) => `<a:gs pos="${Math.round(clamp01(s.pos) * 100000)}">${colorXml(s.rgb, s.alpha * alpha)}</a:gs>`).join("")}</a:gsLst>`;

/**
 * Stops placed for DrawingML's circular path gradient, whose 0-1 runs from the centre to the box's farthest corner
 * (`far` px): ours runs from the centre over `radius` px. Past the last stop the last colour goes on, as SVG pads; a
 * gradient that reaches past the farthest corner is cut there, with the colour it has there.
 */
export function radialStops(stops: GradStop[], radius: number, far: number): GradStop[] {
  if (far <= 0) return [stops[stops.length - 1]];
  const k = radius / far;
  const placed = stops.map((s) => ({ ...s, pos: s.pos * k }));
  const inside = placed.filter((s) => s.pos <= 1);
  const last = placed[placed.length - 1];
  if (last.pos < 1) inside.push({ ...last, pos: 1 });
  else if (last.pos > 1) inside.push(colorAt(placed, 1));
  return inside;
}

/**
 * `paint` as a DrawingML fill (`a:noFill`, `a:solidFill`, `a:gradFill`, `a:pattFill`) of a shape whose box is `box`
 * (px), every colour's alpha multiplied by `alpha` (the node's opacity), written by its paint type's `toPptx`. A paint
 * type that is not registered, or has no `toPptx`, paints nothing, with a warning.
 */
export function fillXml(paint: Paint, alpha: number, box: { width: number; height: number }, ctx: DrawingContext): string {
  const type = ctx.registries.paints.get(paint.type);
  if (!type) {
    ctx.warn(`no paint type "${paint.type}" is registered, written without paint`);
    return "<a:noFill/>";
  }
  if (!type.toPptx) {
    ctx.warn(`the paint type "${paint.type}" cannot be written to PowerPoint, written without paint`);
    return "<a:noFill/>";
  }
  return type.toPptx(paint, alpha, box, ctx);
}

const DASHES: Record<Stroke["dash"], string> = { solid: "solid", dash: "dash", dot: "sysDot", dashDot: "dashDot" };
const CAPS: Record<NonNullable<Stroke["cap"]>, string> = { butt: "flat", round: "rnd", square: "sq" };
/** A miter join with SVG's default limit of 4 (DrawingML's `lim` is in 1/1000 per cent): SVG's join when none is set. */
const MITER = '<a:miter lim="400000"/>';
const JOINS: Record<NonNullable<Stroke["join"]>, string> = { miter: MITER, round: "<a:round/>", bevel: "<a:bevel/>" };

/** DrawingML's limits: a line's width (EMU), a run's size (1/100 pt) and a line spacing (1/100 pt). */
export const MAX_LINE_EMU = 20116800;
export const MIN_FONT_SZ = 100;
export const MAX_FONT_SZ = 400000;
export const MAX_SPC_PTS = 158400;

/** `value` rounded and kept within `min`-`max`; a warning names `what` when that changes it beyond rounding. */
export function clampWhole(value: number, min: number, max: number, what: string, ctx: Pick<PptxContext, "warn">): number {
  const rounded = Math.round(value);
  const kept = Math.min(max, Math.max(min, rounded));
  if (kept !== rounded) ctx.warn(`${what} ${rounded} is outside PowerPoint's range (${min}-${max}), written as ${kept}`);
  return kept;
}

/**
 * `stroke` as an `a:ln`: its width in EMU at the slide's scale, its paint (laid out in `box`, px) with `alpha`, its dash,
 * cap (flat when it sets none, as SVG and PDF; DrawingML's own default is square) and join (a miter of limit 4 when it sets none, as SVG); `extra` (head and tail ends) goes last, as the schema
 * orders it. No stroke, or one of width 0, is a line with no fill.
 */
export function lnXml(stroke: Stroke | null, alpha: number, box: { width: number; height: number }, ctx: DrawingContext, extra = ""): string {
  if (!stroke || !(stroke.width > 0)) return `<a:ln><a:noFill/>${extra}</a:ln>`;
  const w = clampWhole(stroke.width * EMU_PER_PT * ctx.scale, 0, MAX_LINE_EMU, "the line width (EMU)", ctx);
  const cap = stroke.cap && Object.hasOwn(CAPS, stroke.cap) ? CAPS[stroke.cap] : "flat";
  const dash = Object.hasOwn(DASHES, stroke.dash) ? DASHES[stroke.dash] : "solid";
  const join = stroke.join && Object.hasOwn(JOINS, stroke.join) ? JOINS[stroke.join] : MITER;
  return `<a:ln w="${w}" cap="${cap}">${fillXml(stroke.paint, alpha, box, ctx)}<a:prstDash val="${dash}"/>${join}${extra}</a:ln>`;
}

/** An `a:xfrm` of a box in EMU (whole numbers; an extent below 0 is 0), turned `rotation` degrees clockwise about its centre. */
export function xfrmXml(box: { x: number; y: number; cx: number; cy: number }, rotation: number): string {
  const rot = angle60k(rotation);
  const [x, y, cx, cy] = [Math.round(box.x), Math.round(box.y), Math.max(0, Math.round(box.cx)), Math.max(0, Math.round(box.cy))];
  return `<a:xfrm${rot === 0 ? "" : ` rot="${rot}"`}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

/** `s` without the characters XML 1.0 cannot hold (control characters other than tab and line breaks, U+FFFE, U+FFFF). */
export const xmlSafe = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");

/** A `p:cNvPr`: the shape's id, its name and, when given, its description. */
export function nvPrXml(id: number, name: string, descr?: string): string {
  const d = descr === undefined ? "" : ` descr="${escapeXml(xmlSafe(descr))}"`;
  return `<p:cNvPr id="${id}" name="${escapeXml(xmlSafe(name))}"${d}/>`;
}

/** Warnings said once per export whatever item gives them, so not prefixed with the item's label. */
const EXPORT_WIDE = new Set([PATTERN_WARNING]);

/** `ctx` with its warnings prefixed with `label` (the item's, from `nodeLabel`), except the export-wide ones. */
export function labelled<C extends Pick<PptxContext, "warn">>(ctx: C, label: string): C {
  const warn = (message: string) => ctx.warn(EXPORT_WIDE.has(message) ? message : `${label}: ${message}`);
  const out = { ...ctx, warn } as C;
  // The rasteriser's own warnings (the dpi it fell back to) are the item's too.
  if ("rasterise" in ctx) {
    const raster = (ctx as unknown as PptxContext).rasterise;
    (out as unknown as PptxContext).rasterise = (fragment, box) => raster(fragment, box, warn);
  }
  return out;
}

/**
 * An `a:xfrm` of `rect` (page px) turned `rotation` degrees about `pivot` (page px), as the node it belongs to is: the
 * rect keeps its size, its centre goes where the turn takes it, and it is turned by the same angle about that centre.
 */
export function turnedXfrmXml(rect: Rect, pivot: Pt, rotation: number, ctx: Pick<PptxContext, "px">): string {
  const rad = (rotation * Math.PI) / 180;
  const dx = rect.x + rect.width / 2 - pivot.x;
  const dy = rect.y + rect.height / 2 - pivot.y;
  const cx = pivot.x + dx * Math.cos(rad) - dy * Math.sin(rad);
  const cy = pivot.y + dx * Math.sin(rad) + dy * Math.cos(rad);
  return xfrmXml({ x: ctx.px(cx - rect.width / 2), y: ctx.px(cy - rect.height / 2), cx: ctx.px(rect.width), cy: ctx.px(rect.height) }, rotation);
}

/**
 * An `a:custGeom` of `path` (page px) in a shape whose box is `origin` (page px), with no fill of its own (a line):
 * moves, lines, cubic curves and closes, in the shape's EMU.
 */
export function custGeomXml(path: PathData, origin: Rect, ctx: Pick<PptxContext, "px">, fill = false): string {
  const x = (v: number): number => ctx.px(v - origin.x);
  const y = (v: number): number => ctx.px(v - origin.y);
  const pt = (px: number, py: number): string => `<a:pt x="${x(px)}" y="${y(py)}"/>`;
  const body = path
    .map((s) => {
      switch (s.op) {
        case "M":
          return `<a:moveTo>${pt(s.x, s.y)}</a:moveTo>`;
        case "L":
          return `<a:lnTo>${pt(s.x, s.y)}</a:lnTo>`;
        case "C":
          return `<a:cubicBezTo>${pt(s.x1, s.y1)}${pt(s.x2, s.y2)}${pt(s.x, s.y)}</a:cubicBezTo>`;
        case "Z":
          return "<a:close/>";
      }
    })
    .join("");
  const w = Math.max(1, ctx.px(origin.width));
  const h = Math.max(1, ctx.px(origin.height));
  return (
    '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>' +
    `<a:pathLst><a:path w="${w}" h="${h}"${fill ? "" : ' fill="none"'}>${body}</a:path></a:pathLst></a:custGeom>`
  );
}
