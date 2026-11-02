import { defaultBorder } from "../model/defaults";
import type { Rect } from "../model/geometry";
import { nodeLabel } from "../model/labels";
import { pathBounds, rectPath, toSvgPath } from "../model/path";
import type { ShapeNode } from "../model/types";
import type { Field } from "../registry/fields";
import type { NodeRenderer, NodeType, SvgContext } from "../registry/node-type";
import { paintToSvg, strokeAttrs, strokeFields, type PaintRegistry } from "../registry/paint";
import type { ShapeKindRegistry } from "../registry/shape-kind";

/** The registries a shape draws from: its kind's outline, and the paints of its fill and border. */
export interface ShapeNodeDeps {
  shapes: ShapeKindRegistry;
  paints: PaintRegistry;
}

/** What drawing a shape needs from the SVG it goes into. Warnings are said without the node's label; the caller adds it. */
export type ShapeSvgContext = Pick<SvgContext, "defs" | "warnings" | "uid">;

const SVG_NS = "http://www.w3.org/2000/svg";

/** How a shape whose kind is not registered is drawn: its box, dashed in grey, with no fill. */
const PLACEHOLDER_ATTRS = 'fill="none" stroke="#888888" stroke-width="1" stroke-dasharray="4 2"';

const boxOf = (node: ShapeNode): Rect => ({ x: node.x, y: node.y, width: node.width, height: node.height });

/**
 * A shape as an SVG fragment, in page px and unrotated: one `<path>` of its kind's outline, filled with its fill (laid
 * out in the box) and stroked with its border (laid out in the outline's bounds), when it has one. The paints' gradients
 * and patterns go into `ctx.defs`. A kind that is not registered draws a placeholder of the box and says so in
 * `ctx.warnings`; the node keeps its kind and params as they are.
 */
export function shapeNodeSvg(node: ShapeNode, deps: ShapeNodeDeps, ctx: ShapeSvgContext): string {
  const box = boxOf(node);
  const kind = deps.shapes.get(node.kind);
  if (!kind) {
    ctx.warnings.push(`no shape kind "${node.kind}" is registered, drawn as a placeholder`);
    return `<path d="${toSvgPath(rectPath(box, 0))}" ${PLACEHOLDER_ATTRS}/>`;
  }
  const outline = kind.outline(box, node.params);
  const attrs = [`d="${toSvgPath(outline)}"`];
  const fill = paintToSvg(deps.paints, node.fill, box, ctx);
  ctx.defs.push(...fill.defs);
  attrs.push(`fill="${fill.ref}"`);
  if (fill.opacity !== undefined) attrs.push(`fill-opacity="${fill.opacity}"`);
  if (node.border) {
    const stroke = paintToSvg(deps.paints, node.border.paint, pathBounds(outline), ctx);
    ctx.defs.push(...stroke.defs);
    attrs.push(strokeAttrs(node.border, stroke.ref, stroke.opacity));
  }
  return `<path ${attrs.join(" ")}/>`;
}

/** Stage renderers made so far: each one's ids start with its own number, so two shapes' gradients never share an id. */
let renderers = 0;

/**
 * One shape node's DOM: `.lf-node.lf-shape` holding an inline `<svg>` whose viewBox is the node's box in page px, so
 * the fragment the export writes (`shapeNodeSvg`) is drawn as it is, with its own `<defs>`. A border wider than the box
 * shows outside it. What the drawing warns about is logged once, and again only when it changes.
 */
class ShapeNodeRenderer implements NodeRenderer {
  private readonly el: HTMLElement;
  private readonly idPrefix = `lf-shape-${++renderers}`;
  private warned = "";

  constructor(node: ShapeNode, host: HTMLElement, private readonly deps: ShapeNodeDeps) {
    this.el = host.createDiv({ cls: ["lf-node", "lf-shape"] });
    this.update(node);
  }

  update(node: ShapeNode): void {
    const style = this.el.style;
    style.left = `${node.x}px`;
    style.top = `${node.y}px`;
    style.width = `${node.width}px`;
    style.height = `${node.height}px`;
    style.zIndex = String(node.z);
    style.transform = node.rotation === 0 ? "" : `rotate(${node.rotation}deg)`;
    style.opacity = node.opacity === 1 ? "" : String(node.opacity);
    this.draw(node);
  }

  unmount(): void {
    this.el.remove();
  }

  private draw(node: ShapeNode): void {
    const defs: string[] = [];
    const warnings: string[] = [];
    const counters = new Map<string, number>();
    const uid = (prefix: string): string => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${this.idPrefix}-${prefix}-${n}`;
    };
    const fragment = shapeNodeSvg(node, this.deps, { defs, warnings, uid });
    const said = warnings.join("\n");
    if (said !== "" && said !== this.warned) console.warn(`Link Figures: shape ${node.id}: ${warnings.join("; ")}`);
    this.warned = said;

    const markup =
      `<svg xmlns="${SVG_NS}" viewBox="${node.x} ${node.y} ${node.width} ${node.height}" preserveAspectRatio="none">` +
      `${defs.length > 0 ? `<defs>${defs.join("")}</defs>` : ""}${fragment}</svg>`;
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    if (parsed.getElementsByTagName("parsererror").length > 0) {
      console.error(`Link Figures: could not draw shape ${node.id}`);
      this.el.replaceChildren();
      return;
    }
    this.el.replaceChildren(this.el.ownerDocument.importNode(parsed.documentElement, true));
  }
}

/**
 * The shape node type, drawing from `deps` (the plugin's registries, so kinds and paints registered later are used).
 * Its inspector is the kind's own fields (under `params.`), the fill, a Border toggle (off is `border: null`, on is the
 * default border) and, while there is a border, the border's paint, width and dashes.
 */
export function createShapeNodeType(deps: ShapeNodeDeps): NodeType<ShapeNode> {
  return {
    type: "shape",
    name: "Shape",
    icon: "shapes",

    mount(node: ShapeNode, host: HTMLElement): NodeRenderer {
      return new ShapeNodeRenderer(node, host, deps);
    },

    bounds: boxOf,

    inspector(node: ShapeNode): Field[] {
      const kind = deps.shapes.get(node.kind);
      const kindFields = kind ? kind.fields(node.params).map((f) => ({ ...f, key: `params.${f.key}` })) : [];
      return [
        ...kindFields,
        { kind: "paint", key: "fill", label: "Fill" },
        { kind: "toggle", key: "border", label: "Border", onValue: defaultBorder() },
        ...(node.border ? strokeFields("border", "Border") : []),
      ];
    },

    toSvg(node: ShapeNode, ctx: SvgContext): string {
      const warnings: string[] = [];
      const fragment = shapeNodeSvg(node, deps, { defs: ctx.defs, warnings, uid: (prefix) => ctx.uid(prefix) });
      for (const warning of warnings) ctx.warnings.push(`${nodeLabel(ctx.doc, node)}: ${warning}`);
      return fragment;
    },
  };
}
