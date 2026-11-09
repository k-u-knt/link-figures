import type { Paint, Stroke } from "../../model/types";
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
function readColor(value: unknown, ctx: DrawingContext): string {
  const rgb = typeof value === "string" ? hexColor(value) : null;
  if (rgb === null) ctx.warn(`the colour ${JSON.stringify(value)} is not one PowerPoint can take, written as black`);
  return rgb ?? "000000";
}

interface GradStop {
  pos: number;
  rgb: string;
  alpha: number;
}

/** A gradient's stops, read and put in offset order within 0-1, as the SVG export draws them. */
function readStops(raw: unknown, ctx: DrawingContext): GradStop[] {
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

const gsLst = (stops: GradStop[], alpha: number): string =>
  `<a:gsLst>${stops.map((s) => `<a:gs pos="${Math.round(clamp01(s.pos) * 100000)}">${colorXml(s.rgb, s.alpha * alpha)}</a:gs>`).join("")}</a:gsLst>`;

/**
 * Stops placed for DrawingML's circular path gradient, whose 0-1 runs from the centre to the box's farthest corner:
 * ours runs from the centre over `radius` px. Past the last stop the last colour goes on, as SVG pads; a gradient that
 * reaches past the farthest corner is cut there, with the colour it has there.
 */
function radialStops(stops: GradStop[], radius: number, far: number): GradStop[] {
  if (far <= 0) return [stops[stops.length - 1]];
  const k = radius / far;
  const placed = stops.map((s) => ({ ...s, pos: s.pos * k }));
  const inside = placed.filter((s) => s.pos <= 1);
  const last = placed[placed.length - 1];
  if (last.pos < 1) inside.push({ ...last, pos: 1 });
  else if (last.pos > 1) inside.push(colorAt(placed, 1));
  return inside;
}

/** PowerPoint's preset patterns nearest our pattern tiles. */
const PATTERN_PRESETS: Record<string, string> = {
  hatch: "dkUpDiag",
  hatchReverse: "dkDnDiag",
  crosshatch: "diagCross",
  grid: "lgGrid",
  dots: "pct20",
};

/**
 * `paint` as a DrawingML fill (`a:noFill`, `a:solidFill`, `a:gradFill`, `a:pattFill`) of a shape whose box is `box`
 * (px), every colour's alpha multiplied by `alpha` (the node's opacity). A gradient of one stop is that colour; of none,
 * no fill. A paint type the writer does not know paints nothing, with a warning; so does one that is not registered.
 */
export function fillXml(paint: Paint, alpha: number, box: { width: number; height: number }, ctx: DrawingContext): string {
  if (!ctx.registries.paints.get(paint.type)) {
    ctx.warn(`no paint type "${paint.type}" is registered, written without paint`);
    return "<a:noFill/>";
  }
  switch (paint.type) {
    case "none":
      return "<a:noFill/>";
    case "solid":
      return `<a:solidFill>${colorXml(readColor(paint.color, ctx), clamp01(num(paint.opacity, 1)) * alpha)}</a:solidFill>`;
    case "linear":
    case "radial": {
      const stops = readStops(paint.stops, ctx);
      if (stops.length === 0) return "<a:noFill/>";
      if (stops.length === 1) return `<a:solidFill>${colorXml(stops[0].rgb, stops[0].alpha * alpha)}</a:solidFill>`;
      if (paint.type === "linear") {
        // Both run clockwise from +x with y down, over the box's extent along the angle.
        return `<a:gradFill rotWithShape="1">${gsLst(stops, alpha)}<a:lin ang="${angle60k(num(paint.angle, 0))}" scaled="0"/></a:gradFill>`;
      }
      const cx = num(paint.cx, 0.5);
      const cy = num(paint.cy, 0.5);
      const radius = Math.max(0, num(paint.r, 0.5)) * Math.max(box.width, box.height);
      const far = Math.hypot(Math.max(cx, 1 - cx) * box.width, Math.max(cy, 1 - cy) * box.height);
      const placed = radialStops(stops, radius, far);
      const pct = (v: number): number => Math.round(v * 100000);
      const rect = `<a:fillToRect l="${pct(cx)}" t="${pct(cy)}" r="${pct(1 - cx)}" b="${pct(1 - cy)}"/>`;
      const body = placed.length === 1 ? `<a:solidFill>${colorXml(placed[0].rgb, placed[0].alpha * alpha)}</a:solidFill>` : null;
      return body ?? `<a:gradFill rotWithShape="1">${gsLst(placed, alpha)}<a:path path="circle">${rect}</a:path></a:gradFill>`;
    }
    case "pattern": {
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
    }
    default:
      ctx.warn(`the paint type "${paint.type}" cannot be written to PowerPoint, written without paint`);
      return "<a:noFill/>";
  }
}

const DASHES: Record<Stroke["dash"], string> = { solid: "solid", dash: "dash", dot: "sysDot", dashDot: "dashDot" };
const CAPS: Record<NonNullable<Stroke["cap"]>, string> = { butt: "flat", round: "rnd", square: "sq" };
const JOINS: Record<NonNullable<Stroke["join"]>, string> = { miter: '<a:miter lim="800000"/>', round: "<a:round/>", bevel: "<a:bevel/>" };

/**
 * `stroke` as an `a:ln`: its width in EMU at the slide's scale, its paint (laid out in `box`, px) with `alpha`, its dash,
 * cap and join; `extra` (head and tail ends) goes last, as the schema orders it. No stroke is a line with no fill.
 */
export function lnXml(stroke: Stroke | null, alpha: number, box: { width: number; height: number }, ctx: DrawingContext, extra = ""): string {
  if (!stroke) return `<a:ln><a:noFill/>${extra}</a:ln>`;
  const w = Math.max(0, Math.round(stroke.width * EMU_PER_PT * ctx.scale));
  const cap = stroke.cap && Object.hasOwn(CAPS, stroke.cap) ? ` cap="${CAPS[stroke.cap]}"` : "";
  const dash = Object.hasOwn(DASHES, stroke.dash) ? DASHES[stroke.dash] : "solid";
  const join = stroke.join && Object.hasOwn(JOINS, stroke.join) ? JOINS[stroke.join] : "";
  return `<a:ln w="${w}"${cap}>${fillXml(stroke.paint, alpha, box, ctx)}<a:prstDash val="${dash}"/>${join}${extra}</a:ln>`;
}

/** An `a:xfrm` of a box in EMU, turned `rotation` degrees clockwise about its centre. */
export function xfrmXml(box: { x: number; y: number; cx: number; cy: number }, rotation: number): string {
  const rot = angle60k(rotation);
  return `<a:xfrm${rot === 0 ? "" : ` rot="${rot}"`}><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>`;
}

/** A `p:cNvPr`: the shape's id, its name and, when given, its description. */
export function nvPrXml(id: number, name: string, descr?: string): string {
  const d = descr === undefined ? "" : ` descr="${escapeXml(descr)}"`;
  return `<p:cNvPr id="${id}" name="${escapeXml(name)}"${d}/>`;
}

/** Warnings said once per export whatever item gives them, so not prefixed with the item's label. */
const EXPORT_WIDE = new Set([PATTERN_WARNING]);

/** `ctx` with its warnings prefixed with `label` (the item's, from `nodeLabel`), except the export-wide ones. */
export function labelled<C extends Pick<PptxContext, "warn">>(ctx: C, label: string): C {
  return { ...ctx, warn: (message: string) => ctx.warn(EXPORT_WIDE.has(message) ? message : `${label}: ${message}`) };
}
